use std::collections::HashMap;
use std::time::Duration;

use axum::{routing::post, Json, Router};
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};

use super::attempt::{Attempt, Reply};

const BODY_MAX: usize = 2_000_000;
/// How much of a text request body the attempt's record keeps.
const LOGGED_BODY_MAX: usize = 20_000;

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
    h.entry("user-agent".into()).or_insert_with(user_agent);

    // refused before sending: the same failure shape (and record) as a failed send
    let not_sent = |message: &str| {
        let attempt = Attempt::start(&method, &url, h.clone(), Value::Null, 0);
        let (error, log) = attempt.not_sent("request", message);
        Json(
            json!({ "ok": false, "stage": "request", "error": message, "detail": error, "durationMs": 0, "log": log }),
        )
    };
    if url.trim().is_empty() {
        return not_sent("missing url");
    }

    let client = match reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        .build()
    {
        Ok(c) => c,
        Err(e) => return not_sent(&super::attempt::describe(&e)),
    };

    let method_parsed = match reqwest::Method::from_bytes(method.as_bytes()) {
        Ok(m) => m,
        Err(e) => return not_sent(&format!("bad method {method:?}: {e}")),
    };
    let mut rb = client.request(method_parsed, &url);

    // What the record shows of the body, and its size on the wire (multipart: its parts).
    let mut logged_body = Value::Null;
    let mut body_bytes = 0usize;
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
                body_bytes = pairs.iter().map(|(k, v)| k.len() + v.len() + 2).sum();
                logged_body = json!(pairs.iter().cloned().collect::<HashMap<_, _>>());
                rb = rb.form(&pairs);
                h.remove("content-type"); // reqwest sets it
            }
            "multipart" => {
                let mut mp = reqwest::multipart::Form::new();
                let mut fields = HashMap::new();
                let mut files = Vec::new();
                for f in req.form.unwrap_or_default() {
                    if !f.key.is_empty() {
                        body_bytes += f.value.len();
                        fields.insert(f.key.clone(), f.value.clone());
                        mp = mp.text(f.key, f.value);
                    }
                }
                for f in req.files.unwrap_or_default() {
                    if f.field.is_empty() || f.name.is_empty() {
                        continue;
                    }
                    // a file that cannot be decoded is refused, never uploaded as an empty one
                    let bytes = match base64::engine::general_purpose::STANDARD
                        .decode(f.content_b64.as_bytes())
                    {
                        Ok(b) => b,
                        Err(e) => {
                            return not_sent(&format!(
                                "file {:?} (field {:?}) could not be read: bad base64: {e}",
                                f.name, f.field
                            ))
                        }
                    };
                    body_bytes += bytes.len();
                    files.push(json!({ "field": f.field, "name": f.name, "bytes": bytes.len() }));
                    let part = reqwest::multipart::Part::bytes(bytes).file_name(f.name);
                    mp = mp.part(f.field, part);
                }
                logged_body = json!({ "fields": fields, "files": files });
                rb = rb.multipart(mp);
                h.remove("content-type"); // reqwest sets boundary
            }
            _ => {
                let raw = req.body.unwrap_or_default();
                body_bytes = raw.len();
                logged_body = Value::String(logged_text(&raw));
                rb = rb.body(raw); // raw
            }
        }
    }

    for (k, v) in &h {
        rb = rb.header(k, v);
    }

    let attempt = Attempt::start(&method, &url, h.clone(), logged_body, body_bytes);
    let resp = match rb.send().await {
        Ok(r) => r,
        Err(e) => {
            let dur = attempt.elapsed_ms();
            let timed_out = e.is_timeout();
            let stage = if timed_out { "timeout" } else { "network" };
            let (error, log) = attempt
                .failed(stage, &e.without_url(), timed_out, timeout_ms)
                .await;
            return Json(
                json!({ "ok": false, "stage": error["stage"], "error": error["message"], "detail": error, "durationMs": dur, "log": log }),
            );
        }
    };

    let status = resp.status();
    let status_text = status.canonical_reason().unwrap_or("").to_string();
    let mut resp_headers: HashMap<String, String> = HashMap::new();
    for (k, v) in resp.headers() {
        resp_headers.insert(k.as_str().to_string(), header_text(v.as_bytes()));
    }
    let ct = resp_headers
        .get("content-type")
        .cloned()
        .unwrap_or_default()
        .to_lowercase();

    let buf = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => {
            let dur = attempt.elapsed_ms();
            let timed_out = e.is_timeout();
            let (error, log) = attempt
                .failed("body", &e.without_url(), timed_out, timeout_ms)
                .await;
            return Json(
                json!({ "ok": false, "stage": error["stage"], "error": error["message"], "detail": error, "durationMs": dur, "log": log }),
            );
        }
    };
    let duration_ms = attempt.elapsed_ms();

    let textual = ct.is_empty() || is_textual(&ct);
    if !textual {
        let slice = &buf[..buf.len().min(BODY_MAX)];
        let log = attempt.succeeded(Reply {
            status: status.as_u16(),
            headers: &resp_headers,
            trailers: None,
            body: json!(format!("<{} bytes of {ct}>", buf.len())),
            bytes: buf.len(),
        });
        return Json(json!({
            "log": log,
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
    let shown: String = text
        .chars()
        .scan(0usize, |n, ch| {
            *n += ch.len_utf8();
            if *n > BODY_MAX {
                None
            } else {
                Some(ch)
            }
        })
        .collect();
    let log = attempt.succeeded(Reply {
        status: status.as_u16(),
        headers: &resp_headers,
        trailers: None,
        body: logged_response(&shown),
        bytes: buf.len(),
    });
    Json(json!({
        "log": log,
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

/// The User-Agent sent when the caller sets none: some servers refuse requests without one.
pub(crate) fn user_agent() -> String {
    format!("conduit/{}", env!("CARGO_PKG_VERSION"))
}

/// A header value as text: bytes that are not UTF-8 become U+FFFD instead of blanking the value.
pub(crate) fn header_text(raw: &[u8]) -> String {
    String::from_utf8_lossy(raw).into_owned()
}

/// `text` cut to [`LOGGED_BODY_MAX`] bytes at a character boundary.
fn logged_text(text: &str) -> String {
    if text.len() <= LOGGED_BODY_MAX {
        return text.to_string();
    }
    let mut end = LOGGED_BODY_MAX;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}… ({} bytes in all)", &text[..end], text.len())
}

/// A response body for the record: parsed when it is JSON and within [`LOGGED_BODY_MAX`], so it
/// reads as a tree, else its text cut like any other.
fn logged_response(text: &str) -> Value {
    if text.len() <= LOGGED_BODY_MAX {
        if let Ok(v) = serde_json::from_str(text) {
            return v;
        }
    }
    Value::String(logged_text(text))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_file_with_bad_base64_is_refused_not_sent_empty() {
        // Arrange
        let req: SendReq = serde_json::from_value(json!({
            "url": "http://127.0.0.1:9/upload",
            "method": "POST",
            "bodyKind": "multipart",
            "files": [{ "field": "doc", "name": "a.pdf", "contentB64": "not base64!!" }],
        }))
        .unwrap();
        // Act
        let Json(out) = send(Json(req)).await;
        // Assert
        assert_eq!(out["ok"], false);
        assert_eq!(out["detail"]["kind"], "request");
        assert!(out["error"].as_str().unwrap().contains("a.pdf"), "{out}");
    }

    #[test]
    fn a_large_json_reply_is_cut_in_the_record_like_any_text() {
        let big = format!("[{}]", vec!["1"; 30_000].join(","));
        let logged = logged_response(&big);
        let s = logged.as_str().expect("cut to text");
        assert!(
            s.len() < LOGGED_BODY_MAX + 100
                && s.ends_with(&format!("({} bytes in all)", big.len())),
            "{}",
            &s[s.len() - 40..]
        );
        assert_eq!(logged_response("{\"a\":1}"), json!({ "a": 1 }));
    }

    #[tokio::test]
    async fn a_user_agent_is_sent_unless_the_caller_sets_one() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new().route(
            "/",
            axum::routing::get(|h: axum::http::HeaderMap| async move {
                h.get("user-agent")
                    .map(|v| v.to_str().unwrap_or("").to_string())
                    .unwrap_or_default()
            }),
        );
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let ask = |headers: Value| {
            let req: SendReq = serde_json::from_value(
                json!({ "url": format!("http://{addr}/"), "headers": headers }),
            )
            .unwrap();
            send(Json(req))
        };
        let Json(out) = ask(json!({})).await;
        assert_eq!(out["bodyText"], user_agent());
        assert!(user_agent().starts_with("conduit/"));
        let Json(out) = ask(json!({ "User-Agent": "mine/1" })).await;
        assert_eq!(out["bodyText"], "mine/1");
    }

    #[tokio::test]
    async fn a_failed_send_never_records_the_url_query_in_its_chain() {
        let req: SendReq =
            serde_json::from_value(json!({ "url": "http://127.0.0.1:9/x?token=s3cret" })).unwrap();
        let Json(out) = send(Json(req)).await;
        assert_eq!(out["ok"], false);
        assert!(
            !out["detail"]["chain"].to_string().contains("s3cret"),
            "{}",
            out["detail"]["chain"]
        );
        assert!(
            !out["error"].to_string().contains("s3cret"),
            "{}",
            out["error"]
        );
    }

    #[test]
    fn a_non_ascii_header_value_is_kept() {
        assert_eq!(header_text("café".as_bytes()), "café");
        assert_eq!(header_text(&[b'a', 0xff]), "a\u{fffd}");
    }
}
