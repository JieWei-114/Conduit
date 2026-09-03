use std::collections::HashMap;
use std::time::{Duration, Instant};

use axum::{routing::post, Json, Router};
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};

const BODY_MAX: usize = 2_000_000;

pub fn routes() -> Router {
    Router::new().route("/send", post(send))
}

#[derive(Deserialize)]
struct FormField {
    key: String,
    value: String,
}

#[derive(Deserialize)]
struct FilePart {
    field: String,
    name: String,
    #[serde(rename = "contentB64")]
    content_b64: String,
}

#[derive(Deserialize)]
struct SendReq {
    url: Option<String>,
    method: Option<String>,
    headers: Option<HashMap<String, String>>,
    #[serde(rename = "bodyKind")]
    body_kind: Option<String>,
    body: Option<String>,
    form: Option<Vec<FormField>>,
    files: Option<Vec<FilePart>>,
    #[serde(rename = "timeoutMs")]
    timeout_ms: Option<u64>,
}

async fn send(Json(req): Json<SendReq>) -> Json<Value> {
    let url = req.url.unwrap_or_default();
    if url.trim().is_empty() {
        return Json(json!({ "ok": false, "error": "missing url" }));
    }
    let method = req.method.unwrap_or_else(|| "GET".into()).to_uppercase();
    let body_kind = req.body_kind.unwrap_or_else(|| "raw".into());
    let timeout_ms = req.timeout_ms.filter(|&t| t > 0).unwrap_or(15000);

    // caller headers, lowercased; a caller content-type wins over auto ones
    let mut h: HashMap<String, String> = HashMap::new();
    for (k, v) in req.headers.unwrap_or_default() {
        if !v.is_empty() {
            h.insert(k.to_lowercase(), v);
        }
    }

    let client = match reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        .build()
    {
        Ok(c) => c,
        Err(e) => return Json(json!({ "ok": false, "error": e.to_string() })),
    };

    let method_parsed = match reqwest::Method::from_bytes(method.as_bytes()) {
        Ok(m) => m,
        Err(e) => return Json(json!({ "ok": false, "error": e.to_string() })),
    };
    let mut rb = client.request(method_parsed, &url);

    let no_body = method == "GET" || method == "HEAD";
    if !no_body && body_kind != "none" {
        match body_kind.as_str() {
            "form" => {
                let pairs: Vec<(String, String)> = req
                    .form
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|f| !f.key.is_empty())
                    .map(|f| (f.key, f.value))
                    .collect();
                rb = rb.form(&pairs);
                h.remove("content-type"); // reqwest sets it
            }
            "multipart" => {
                let mut mp = reqwest::multipart::Form::new();
                for f in req.form.unwrap_or_default() {
                    if !f.key.is_empty() {
                        mp = mp.text(f.key, f.value);
                    }
                }
                for f in req.files.unwrap_or_default() {
                    if f.field.is_empty() || f.name.is_empty() {
                        continue;
                    }
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(f.content_b64.as_bytes())
                        .unwrap_or_default();
                    let part = reqwest::multipart::Part::bytes(bytes).file_name(f.name);
                    mp = mp.part(f.field, part);
                }
                rb = rb.multipart(mp);
                h.remove("content-type"); // reqwest sets boundary
            }
            _ => {
                rb = rb.body(req.body.unwrap_or_default()); // raw
            }
        }
    }

    for (k, v) in &h {
        rb = rb.header(k, v);
    }

    let t0 = Instant::now();
    let resp = match rb.send().await {
        Ok(r) => r,
        Err(e) => {
            let dur = t0.elapsed().as_millis();
            let msg = if e.is_timeout() {
                format!("request aborted after {timeout_ms}ms")
            } else {
                e.to_string()
            };
            return Json(json!({ "ok": false, "error": msg, "durationMs": dur }));
        }
    };

    let status = resp.status();
    let status_text = status.canonical_reason().unwrap_or("").to_string();
    let mut resp_headers: HashMap<String, String> = HashMap::new();
    for (k, v) in resp.headers() {
        resp_headers.insert(k.as_str().to_string(), v.to_str().unwrap_or("").to_string());
    }
    let ct = resp_headers
        .get("content-type")
        .cloned()
        .unwrap_or_default()
        .to_lowercase();

    let buf = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => return Json(json!({ "ok": false, "error": e.to_string() })),
    };
    let duration_ms = t0.elapsed().as_millis();

    let textual = ct.is_empty() || is_textual(&ct);
    if !textual {
        let slice = &buf[..buf.len().min(BODY_MAX)];
        return Json(json!({
            "ok": true,
            "status": status.as_u16(),
            "statusText": status_text,
            "headers": resp_headers,
            "binary": true,
            "contentType": ct,
            "bodyBase64": base64::engine::general_purpose::STANDARD.encode(slice),
            "bodyText": "",
            "truncated": buf.len() > BODY_MAX,
            "durationMs": duration_ms,
            "size": buf.len(),
        }));
    }

    let text = String::from_utf8_lossy(&buf);
    let truncated = text.len() > BODY_MAX;
    let shown: String = text.chars().scan(0usize, |n, ch| {
        *n += ch.len_utf8();
        if *n > BODY_MAX { None } else { Some(ch) }
    }).collect();
    Json(json!({
        "ok": true,
        "status": status.as_u16(),
        "statusText": status_text,
        "headers": resp_headers,
        "bodyText": shown,
        "truncated": truncated,
        "durationMs": duration_ms,
        "size": buf.len(),
    }))
}

fn is_textual(ct: &str) -> bool {
    if ct.starts_with("text/") {
        return true;
    }
    let head = ct.split(';').next().unwrap_or(ct);
    if head.ends_with("+json") || head.ends_with("+xml") {
        return true;
    }
    matches!(
        head,
        "application/json"
            | "application/xml"
            | "application/javascript"
            | "application/x-www-form-urlencoded"
            | "application/graphql"
    )
}
