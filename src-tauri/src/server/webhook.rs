use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use axum::{
    extract::{ConnectInfo, OriginalUri, Request},
    http::{HeaderMap, StatusCode},
    response::sse::{Event, Sse},
    response::{IntoResponse, Response},
    routing::{any, get, post},
    Json, Router,
};
use futures_util::stream::Stream;
use base64::Engine;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::broadcast;
use tokio_stream::wrappers::errors::BroadcastStreamRecvError;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

const CAP_MAX: usize = 200;
/// Bytes of a captured body kept; the rest is counted, not stored.
const BODY_KEEP: usize = 1024 * 1024;
/// Body bytes a hit's inline cURL commands carry; past it they are cut and `curlTruncated` is
/// set, and `GET /curl?id=` builds the whole command.
const CURL_BODY_MAX: usize = 64 * 1024;
/// Bytes all kept hits may hold together; the oldest are dropped past it.
const STORE_MAX: usize = 64 * 1024 * 1024;
/// How much of a binary body is shown as lossy text next to its base64.
const LOSSY_PREVIEW: usize = 4 * 1024;
/// Marker after a header value that was not valid UTF-8 and is shown lossily.
const LOSSY_MARK: &str = " [not UTF-8, shown lossily]";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Captured {
    id: u64,
    at: String,
    method: String,
    path: String,
    /// The query string as received, still percent-encoded.
    raw_query: String,
    /// Decoded query; a key sent more than once keeps every value, in order.
    query: Vec<(String, String)>,
    /// Headers in arrival order; a repeated header appears once per value.
    headers: Vec<(String, String)>,
    /// Names of headers whose value was not UTF-8 (shown lossily, with a marker).
    lossy_headers: Vec<String>,
    /// The kept body as text; for a body that is not UTF-8 only a lossy preview (see `body_base64`).
    body: String,
    /// The body's full size on the wire, kept or not.
    body_bytes: usize,
    /// How many bytes of it were kept (at most [`BODY_KEEP`]).
    body_kept_bytes: usize,
    /// Only the first [`BODY_KEEP`] bytes were kept.
    body_truncated: bool,
    /// The body was not valid UTF-8 and is shown lossily.
    body_lossy: bool,
    /// The kept bytes as base64, for a body that is not UTF-8.
    #[serde(skip_serializing_if = "Option::is_none")]
    body_base64: Option<String>,
    /// Reading the body failed part way: what is kept is only what arrived before that.
    body_error: Option<String>,
    /// The peer address, when the server records it, or what a proxy header claims.
    source: Option<String>,
    response: SentResponse,
    /// A cURL command that sends this request again to the address it came in on.
    curl: String,
    /// [`Self::curl`] with credential headers and query values blanked: the one to share.
    curl_masked: String,
    /// The cURL commands carry only the first [`CURL_BODY_MAX`] bytes of the body.
    curl_truncated: bool,
    #[serde(skip)]
    raw: Replay,
}

/// What a full cURL command is built from on request.
#[derive(Clone, Default)]
struct Replay {
    url: String,
    masked_url: String,
    body: Vec<u8>,
}

impl Captured {
    /// Bytes this hit holds, roughly.
    fn weight(&self) -> usize {
        self.body.len()
            + self.body_base64.as_ref().map_or(0, String::len)
            + self.curl.len()
            + self.curl_masked.len()
            + self.raw.body.len()
            + self.headers.iter().map(|(k, v)| k.len() + v.len()).sum::<usize>()
    }

    /// The cURL command with the whole kept body, masked or not.
    fn full_curl(&self, masked: bool) -> String {
        let url = if masked { &self.raw.masked_url } else { &self.raw.url };
        let headers = if masked { mask_headers(&self.headers) } else { self.headers.clone() };
        curl_command(&self.method, url, &headers, &self.raw.body)
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SentResponse {
    status: u16,
    content_type: String,
    body: String,
}

#[derive(Clone, Serialize)]
struct RespConfig {
    status: u16,
    #[serde(rename = "contentType")]
    content_type: String,
    body: String,
}

static CAPTURED: Lazy<Mutex<Vec<Arc<Captured>>>> = Lazy::new(|| Mutex::new(Vec::new()));
static SEQ: AtomicU64 = AtomicU64::new(0);
static CONFIG: Lazy<Mutex<RespConfig>> = Lazy::new(|| {
    Mutex::new(RespConfig {
        status: 200,
        content_type: "application/json".into(),
        body: "{\"ok\":true}".into(),
    })
});
static TX: Lazy<broadcast::Sender<Arc<Captured>>> = Lazy::new(|| broadcast::channel(64).0);

/// `m` locked, even when a thread panicked while holding it: the data is a list and a config,
/// still usable, and a capture endpoint that panics on every later call helps no one.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// What a blanked secret is shown as.
const MASK: &str = "•••";

fn is_sensitive(name: &str) -> bool {
    super::attempt::is_secret_name(name)
}

fn mask_headers(headers: &[(String, String)]) -> Vec<(String, String)> {
    headers
        .iter()
        .map(|(k, v)| (k.clone(), if is_sensitive(k) { MASK.to_string() } else { v.clone() }))
        .collect()
}

/// `raw` (a query string, still encoded) with the values of credential-looking keys blanked.
fn mask_query(raw: &str) -> String {
    // the key is judged decoded (`api%5Fkey` is `api_key`) and written back as it came
    let decoded = |k: &str| -> String {
        url::form_urlencoded::parse(k.as_bytes()).map(|(k, _)| k.into_owned()).collect()
    };
    raw.split('&')
        .map(|pair| match pair.split_once('=') {
            Some((k, _)) if is_sensitive(&decoded(k)) => format!("{k}={MASK}"),
            _ => pair.to_string(),
        })
        .collect::<Vec<_>>()
        .join("&")
}

pub fn routes() -> Router {
    Router::new()
        .route("/in", any(capture))
        .route("/in/*rest", any(capture))
        .route("/list", get(list))
        .route("/curl", get(curl))
        .route("/clear", post(clear))
        .route("/config", get(get_config).post(set_config))
        .route("/stream", get(stream))
}

async fn capture(req: Request) -> Response {
    let (parts, body) = req.into_parts();
    let uri = parts
        .extensions
        .get::<OriginalUri>()
        .map(|o| o.0.clone())
        .unwrap_or_else(|| parts.uri.clone());
    let path = match uri.path().strip_prefix("/api/webhook/in") {
        Some(rest) if !rest.is_empty() => rest.to_string(),
        _ => "/".to_string(),
    };
    let raw_query = uri.query().unwrap_or("").to_string();
    let (headers, lossy_headers) = header_list(&parts.headers);
    let peer = parts
        .extensions
        .get::<ConnectInfo<SocketAddr>>()
        .map(|c| c.0.ip().to_string());
    let source = source_of(peer, &parts.headers);

    let (kept, body_bytes, body_error) = read_capped(body, BODY_KEEP).await;
    let body_lossy = std::str::from_utf8(&kept).is_err() && !(body_bytes > BODY_KEEP && utf8_prefix_ok(&kept));
    let (body, body_base64) = if body_lossy {
        let preview = String::from_utf8_lossy(&kept[..kept.len().min(LOSSY_PREVIEW)]).into_owned();
        (preview, Some(base64::engine::general_purpose::STANDARD.encode(&kept)))
    } else {
        (String::from_utf8_lossy(&kept).into_owned(), None)
    };

    let cfg = lock(&CONFIG).clone();
    let host = parts
        .headers
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("localhost")
        .to_string();
    let replay_url = |q: &str| {
        format!("http://{host}{}{}", uri.path(), if q.is_empty() { String::new() } else { format!("?{q}") })
    };
    let method = parts.method.as_str().to_string();
    let url = replay_url(&raw_query);
    let masked_url = replay_url(&mask_query(&raw_query));
    let curl_truncated = kept.len() > CURL_BODY_MAX;
    let inline = &kept[..kept.len().min(CURL_BODY_MAX)];
    let curl = curl_command(&method, &url, &headers, inline);
    let curl_masked = curl_command(&method, &masked_url, &mask_headers(&headers), inline);

    let rec = Arc::new(Captured {
        id: SEQ.fetch_add(1, Ordering::SeqCst),
        at: chrono::Utc::now().to_rfc3339(),
        method,
        path,
        query: parse_query(&raw_query),
        raw_query,
        headers,
        lossy_headers,
        body,
        body_bytes,
        body_kept_bytes: kept.len(),
        body_truncated: body_bytes > BODY_KEEP,
        body_lossy,
        body_base64,
        body_error,
        source,
        response: SentResponse {
            status: cfg.status,
            content_type: cfg.content_type.clone(),
            body: cfg.body.clone(),
        },
        curl,
        curl_masked,
        curl_truncated,
        raw: Replay { url, masked_url, body: if curl_truncated { kept } else { Vec::new() } },
    });

    keep(&mut lock(&CAPTURED), rec.clone());
    let _ = TX.send(rec);

    // the configured status was validated when it was saved
    let status = StatusCode::from_u16(cfg.status).unwrap_or(StatusCode::OK);
    (status, [("content-type", cfg.content_type)], cfg.body).into_response()
}

/// `rec` first in `list`, then the oldest dropped past [`CAP_MAX`] hits or [`STORE_MAX`] bytes.
fn keep(list: &mut Vec<Arc<Captured>>, rec: Arc<Captured>) {
    list.insert(0, rec);
    let mut total = 0usize;
    let mut n = 0usize;
    for (i, r) in list.iter().enumerate() {
        total += r.weight();
        if i > 0 && (i >= CAP_MAX || total > STORE_MAX) {
            break;
        }
        n = i + 1;
    }
    list.truncate(n);
}

/// The first `keep` bytes of `body`, its whole size, and why reading stopped early if it did:
/// the rest is read and counted so an oversize request still shows up (as truncated) instead of
/// being refused, and a body cut off mid-way is marked rather than stored as complete.
async fn read_capped(body: axum::body::Body, keep: usize) -> (Vec<u8>, usize, Option<String>) {
    let mut kept = Vec::new();
    let mut total = 0usize;
    let mut stream = body.into_data_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                let why = format!("the body stopped after {total} bytes: {}", super::attempt::describe(&e));
                return (kept, total, Some(why));
            }
        };
        total += chunk.len();
        if kept.len() < keep {
            let room = keep - kept.len();
            kept.extend_from_slice(&chunk[..chunk.len().min(room)]);
        }
    }
    (kept, total, None)
}

/// Whether `bytes` is valid UTF-8 apart from a character cut off at the very end (a body
/// truncated mid-character is still text).
fn utf8_prefix_ok(bytes: &[u8]) -> bool {
    match std::str::from_utf8(bytes) {
        Ok(_) => true,
        Err(e) => e.error_len().is_none(),
    }
}

/// A query string decoded (`+` as space, `%XX` escapes), every pair kept in order.
fn parse_query(raw: &str) -> Vec<(String, String)> {
    url::form_urlencoded::parse(raw.as_bytes())
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect()
}

/// Headers in order, repeated ones kept; a value that is not UTF-8 is shown lossily with a
/// marker, and its name listed.
fn header_list(headers: &HeaderMap) -> (Vec<(String, String)>, Vec<String>) {
    let mut out = Vec::new();
    let mut lossy = Vec::new();
    for (k, v) in headers {
        let name = k.as_str().to_string();
        match v.to_str() {
            Ok(s) => out.push((name, s.to_string())),
            Err(_) => {
                out.push((
                    name.clone(),
                    format!("{}{LOSSY_MARK}", String::from_utf8_lossy(v.as_bytes())),
                ));
                if !lossy.contains(&name) {
                    lossy.push(name);
                }
            }
        }
    }
    (out, lossy)
}

/// Where the request came from: the peer address when known, followed by what a proxy header
/// (`x-forwarded-for`, `x-real-ip`) claims, labelled as such.
fn source_of(peer: Option<String>, headers: &HeaderMap) -> Option<String> {
    let claimed = ["x-forwarded-for", "x-real-ip"].iter().find_map(|h| {
        headers
            .get(*h)
            .and_then(|v| v.to_str().ok())
            .map(|v| format!("{v} (per {h})"))
    });
    match (peer, claimed) {
        (Some(p), Some(c)) => Some(format!("{p}, {c}")),
        (Some(p), None) => Some(p),
        (None, c) => c,
    }
}

/// `s` quoted for a POSIX shell: single quotes when it has no control characters, otherwise
/// `$'…'` with escapes, so a newline in a value never becomes a line break in the command.
fn shell_quote(s: &str) -> String {
    if !s.chars().any(|c| c.is_control()) {
        return format!("'{}'", s.replace('\'', "'\\''"));
    }
    let mut out = String::from("$'");
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\'' => out.push_str("\\'"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => {
                let mut buf = [0u8; 4];
                for b in c.encode_utf8(&mut buf).bytes() {
                    out.push_str(&format!("\\x{b:02x}"));
                }
            }
            c => out.push(c),
        }
    }
    out.push('\'');
    out
}

/// A cURL command sending `method` `url` with `headers` and `body`, one option per line joined
/// by `\` continuations. Headers cURL sets itself from the request (host, length, transfer
/// encoding, connection) are left out.
fn curl_command(method: &str, url: &str, headers: &[(String, String)], body: &[u8]) -> String {
    const SKIP: [&str; 4] = ["host", "content-length", "transfer-encoding", "connection"];
    // the method came from the caller: quoted like everything else, so it cannot run commands
    let mut parts = vec![format!("curl -X {} {}", shell_quote(method), shell_quote(url))];
    for (k, v) in headers {
        if SKIP.contains(&k.to_ascii_lowercase().as_str()) {
            continue;
        }
        let v = v.strip_suffix(LOSSY_MARK).unwrap_or(v);
        parts.push(format!("-H {}", shell_quote(&format!("{k}: {v}"))));
    }
    let mut prefix = String::new();
    match std::str::from_utf8(body) {
        Ok("") => {}
        Ok(text) => parts.push(format!("--data-binary {}", shell_quote(text))),
        // a cut-off character at the end is still text
        Err(e) if e.error_len().is_none() => {
            parts.push(format!("--data-binary {}", shell_quote(&String::from_utf8_lossy(&body[..e.valid_up_to()]))))
        }
        Err(_) => {
            let b64 = base64::engine::general_purpose::STANDARD.encode(body);
            prefix = format!("printf %s {} | base64 --decode | ", shell_quote(&b64));
            parts.push("--data-binary @-".into());
        }
    }
    format!("{prefix}{}", parts.join(" \\\n  "))
}

async fn list() -> Json<Value> {
    let buf: Vec<Arc<Captured>> = lock(&CAPTURED).clone();
    let hits: Vec<&Captured> = buf.iter().map(|r| r.as_ref()).collect();
    Json(json!({ "ok": true, "captured": hits, "bodyKeepBytes": BODY_KEEP }))
}

#[derive(Deserialize)]
struct CurlQuery {
    id: u64,
    masked: Option<String>,
}

/// The whole cURL command for a kept hit, masked unless `masked=0`.
async fn curl(axum::extract::Query(q): axum::extract::Query<CurlQuery>) -> Response {
    let hit = lock(&CAPTURED).iter().find(|r| r.id == q.id).cloned();
    match hit {
        Some(h) => {
            let masked = q.masked.as_deref() != Some("0");
            let curl = if h.curl_truncated { h.full_curl(masked) } else if masked { h.curl_masked.clone() } else { h.curl.clone() };
            Json(json!({ "ok": true, "id": h.id, "masked": masked, "curl": curl })).into_response()
        }
        None => (StatusCode::NOT_FOUND, Json(json!({ "ok": false, "error": "no such hit: it was cleared or dropped" }))).into_response(),
    }
}

async fn clear() -> Json<Value> {
    lock(&CAPTURED).clear();
    Json(json!({ "ok": true }))
}

async fn get_config() -> Json<Value> {
    let cfg = lock(&CONFIG).clone();
    Json(json!({ "ok": true, "status": cfg.status, "contentType": cfg.content_type, "body": cfg.body }))
}

#[derive(Deserialize)]
struct ConfigReq {
    status: Option<Value>,
    #[serde(rename = "contentType")]
    content_type: Option<String>,
    body: Option<String>,
}

/// The status a saved response uses: absent or blank means 200; anything else must be an HTTP
/// status code (100–599).
fn parse_status(v: Option<&Value>) -> Result<u16, String> {
    let n = match v {
        None | Some(Value::Null) => return Ok(200),
        Some(Value::String(s)) if s.trim().is_empty() => return Ok(200),
        Some(Value::String(s)) => s.trim().parse::<u64>().ok(),
        Some(Value::Number(n)) => n.as_u64(),
        _ => None,
    };
    match n {
        Some(n) if (100..=599).contains(&n) => Ok(n as u16),
        _ => Err(format!(
            "status must be a number from 100 to 599, got {}",
            v.map(|v| v.to_string()).unwrap_or_default()
        )),
    }
}

async fn set_config(Json(b): Json<ConfigReq>) -> Response {
    let status = match parse_status(b.status.as_ref()) {
        Ok(s) => s,
        Err(e) => {
            return (StatusCode::BAD_REQUEST, Json(json!({ "ok": false, "error": e }))).into_response()
        }
    };
    let cfg = RespConfig {
        status,
        content_type: b.content_type.filter(|s| !s.is_empty()).unwrap_or_else(|| "application/json".into()),
        body: b.body.unwrap_or_default(),
    };
    *lock(&CONFIG) = cfg.clone();
    Json(json!({ "ok": true, "status": cfg.status, "contentType": cfg.content_type, "body": cfg.body }))
        .into_response()
}

async fn stream() -> Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>> {
    let rx = TX.subscribe();
    let ready = tokio_stream::once(Ok(Event::default().event("ready").data("listening")));
    let hits = BroadcastStream::new(rx).map(|res| {
        Ok(match res {
            Ok(rec) => Event::default()
                .event("hit")
                .data(serde_json::to_string(rec.as_ref()).unwrap_or_default()),
            // this listener fell behind; the hits are still in the list
            Err(BroadcastStreamRecvError::Lagged(n)) => Event::default()
                .event("lagged")
                .data(json!({ "dropped": n }).to_string()),
        })
    });
    Sse::new(ready.chain(hits))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_query_is_decoded_and_keeps_repeated_keys() {
        let q = parse_query("a=1&a=2&name=J%C3%BCrgen+M&empty&x=%2B");
        assert_eq!(
            q,
            vec![
                ("a".into(), "1".into()),
                ("a".into(), "2".into()),
                ("name".into(), "Jürgen M".into()),
                ("empty".into(), "".into()),
                ("x".into(), "+".into()),
            ]
        );
    }

    #[test]
    fn repeated_and_non_utf8_headers_are_kept() {
        let mut h = HeaderMap::new();
        h.append("x-tag", "a".parse().unwrap());
        h.append("x-tag", "b".parse().unwrap());
        h.append("x-raw", axum::http::HeaderValue::from_bytes(b"caf\xe9").unwrap());
        let (list, lossy) = header_list(&h);
        assert_eq!(list.iter().filter(|(k, _)| k == "x-tag").count(), 2);
        let raw = &list.iter().find(|(k, _)| k == "x-raw").unwrap().1;
        assert!(raw.ends_with(LOSSY_MARK), "{raw}");
        assert_eq!(lossy, vec!["x-raw".to_string()]);
    }

    #[test]
    fn a_status_is_checked_not_replaced() {
        assert_eq!(parse_status(None), Ok(200));
        assert_eq!(parse_status(Some(&json!(""))), Ok(200));
        assert_eq!(parse_status(Some(&json!(404))), Ok(404));
        assert_eq!(parse_status(Some(&json!("201"))), Ok(201));
        assert!(parse_status(Some(&json!(0))).is_err());
        assert_eq!(parse_status(Some(&json!(599))), Ok(599));
        assert!(parse_status(Some(&json!(600))).is_err());
        assert!(parse_status(Some(&json!(1000))).is_err());
        assert!(parse_status(Some(&json!("abc"))).is_err());
    }

    #[test]
    fn a_hostile_method_is_quoted_not_run() {
        let c = curl_command("GET`touch /tmp/x`|$(id)", "http://h/", &[], b"");
        assert!(c.starts_with("curl -X 'GET`touch /tmp/x`|$(id)' "), "{c}");
    }

    #[test]
    fn curl_quotes_everything_and_has_no_blank_lines() {
        let c = curl_command(
            "POST",
            "http://localhost:1420/api/webhook/in/x?a=1&b=it's",
            &[
                ("host".into(), "localhost".into()),
                ("content-type".into(), "application/json".into()),
                ("x-quote".into(), "it's".into()),
            ],
            b"{\"a\":1}\n\n{\"b\":2}",
        );
        assert!(!c.contains("\n\n"), "{c}");
        assert!(c.lines().all(|l| !l.trim().is_empty()), "{c}");
        assert!(c.contains("'x-quote: it'\\''s'"), "{c}");
        assert!(c.contains("--data-binary $'{\"a\":1}\\n\\n{\"b\":2}'"), "{c}");
        assert!(!c.to_lowercase().contains("-h 'host:"), "{c}");
        let lines: Vec<&str> = c.lines().collect();
        for l in &lines[..lines.len() - 1] {
            assert!(l.ends_with(" \\"), "continuation missing: {l}");
        }
    }

    #[test]
    fn a_proxy_claim_is_labelled() {
        let mut h = HeaderMap::new();
        assert_eq!(source_of(Some("10.0.0.2".into()), &h), Some("10.0.0.2".into()));
        h.insert("x-forwarded-for", "1.2.3.4".parse().unwrap());
        assert_eq!(
            source_of(None, &h),
            Some("1.2.3.4 (per x-forwarded-for)".into())
        );
    }

    #[test]
    fn a_body_cut_mid_character_is_still_text() {
        let s = "añb".as_bytes();
        assert!(utf8_prefix_ok(&s[..2]));
        assert!(!utf8_prefix_ok(b"a\xffb"));
    }

    #[tokio::test]
    async fn an_oversize_body_is_kept_in_part_and_counted() {
        let body = axum::body::Body::from(vec![b'x'; 25]);
        let (kept, total, err) = read_capped(body, 10).await;
        assert_eq!(kept.len(), 10);
        assert_eq!(total, 25);
        assert!(err.is_none());
    }

    #[tokio::test]
    async fn a_body_that_breaks_off_is_marked() {
        let chunks: Vec<Result<&'static [u8], std::io::Error>> = vec![
            Ok(b"abc"),
            Err(std::io::Error::new(std::io::ErrorKind::ConnectionReset, "connection reset")),
        ];
        let body = axum::body::Body::from_stream(futures_util::stream::iter(chunks));
        let (kept, total, err) = read_capped(body, 10).await;
        assert_eq!((kept.as_slice(), total), (&b"abc"[..], 3));
        let err = err.expect("a body error");
        assert!(err.contains("after 3 bytes") && err.contains("connection reset"), "{err}");
    }

    #[test]
    fn credentials_are_masked_in_the_shared_curl() {
        assert!(is_sensitive("Authorization") && is_sensitive("x-hub-signature-256") && is_sensitive("cookie"));
        assert!(!is_sensitive("content-type"));
        assert_eq!(mask_query("a=1&access_token=s3cret&api%5Fkey=k"), "a=1&access_token=•••&api%5Fkey=•••");
        assert_eq!(mask_query(""), "");
    }

    fn hit(id: u64, body: usize) -> Arc<Captured> {
        Arc::new(Captured {
            id,
            at: String::new(),
            method: "POST".into(),
            path: "/".into(),
            raw_query: String::new(),
            query: vec![],
            headers: vec![],
            lossy_headers: vec![],
            body: "x".repeat(body),
            body_bytes: body,
            body_kept_bytes: body,
            body_truncated: false,
            body_lossy: false,
            body_base64: None,
            body_error: None,
            source: None,
            response: SentResponse { status: 200, content_type: String::new(), body: String::new() },
            curl: String::new(),
            curl_masked: String::new(),
            curl_truncated: false,
            raw: Replay::default(),
        })
    }

    #[test]
    fn kept_hits_are_bounded_by_count_and_by_bytes() {
        let mut list = Vec::new();
        for i in 0..(CAP_MAX as u64 + 5) {
            keep(&mut list, hit(i, 10));
        }
        assert_eq!(list.len(), CAP_MAX);
        assert_eq!(list[0].id, CAP_MAX as u64 + 4);
        let mut list = Vec::new();
        for i in 0..100 {
            keep(&mut list, hit(i, BODY_KEEP));
        }
        assert!(list.iter().map(|r| r.weight()).sum::<usize>() <= STORE_MAX, "{}", list.len());
        assert_eq!(list[0].id, 99);
        let mut list = Vec::new();
        keep(&mut list, hit(0, STORE_MAX * 2));
        assert_eq!(list.len(), 1, "the newest hit is always kept");
    }

    #[tokio::test]
    async fn a_large_or_binary_body_is_capped_and_its_curl_built_on_request() {
        let app = Router::new().nest("/api/webhook", routes());
        let addr = {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            addr
        };
        let client = reqwest::Client::new();
        let big = vec![b'a'; BODY_KEEP + 10];
        client.post(format!("http://{addr}/api/webhook/in/big?token=t1")).header("authorization", "Bearer s3cret").body(big).send().await.unwrap();
        let bin = vec![0xffu8, 0x00, 0x10];
        client.post(format!("http://{addr}/api/webhook/in/bin")).body(bin).send().await.unwrap();

        let list: Value = client.get(format!("http://{addr}/api/webhook/list")).send().await.unwrap().bytes().await.map(|b| serde_json::from_slice(&b).unwrap()).unwrap();
        let hits = list["captured"].as_array().unwrap();
        let big = hits.iter().find(|h| h["path"] == "/big").unwrap();
        assert_eq!((big["bodyBytes"].as_u64(), big["bodyKeptBytes"].as_u64(), big["bodyTruncated"].as_bool()), (Some(BODY_KEEP as u64 + 10), Some(BODY_KEEP as u64), Some(true)));
        assert_eq!(big["curlTruncated"], true);
        assert!(big["curl"].as_str().unwrap().len() < CURL_BODY_MAX + 1024);
        assert!(big.get("bodyBase64").is_none());
        let bin = hits.iter().find(|h| h["path"] == "/bin").unwrap();
        assert_eq!(bin["bodyLossy"], true);
        assert_eq!(bin["bodyBase64"], "/wAQ");
        assert!(bin["curl"].as_str().unwrap().starts_with("printf %s '/wAQ' | base64 --decode | curl"), "{}", bin["curl"]);

        let id = big["id"].as_u64().unwrap();
        let full: Value = client.get(format!("http://{addr}/api/webhook/curl?id={id}")).send().await.unwrap().bytes().await.map(|b| serde_json::from_slice(&b).unwrap()).unwrap();
        let c = full["curl"].as_str().unwrap();
        assert!(c.len() > BODY_KEEP && !c.contains("s3cret") && !c.contains("t1"), "masked by default");
        let raw: Value = client.get(format!("http://{addr}/api/webhook/curl?id={id}&masked=0")).send().await.unwrap().bytes().await.map(|b| serde_json::from_slice(&b).unwrap()).unwrap();
        assert!(raw["curl"].as_str().unwrap().contains("s3cret"));
        let missing = client.get(format!("http://{addr}/api/webhook/curl?id=999999999")).send().await.unwrap();
        assert_eq!(missing.status(), 404);
    }

    #[test]
    fn a_poisoned_lock_still_opens() {
        let m = std::sync::Arc::new(Mutex::new(1));
        let m2 = m.clone();
        let _ = std::thread::spawn(move || {
            let _g = m2.lock().unwrap();
            panic!("poison it");
        })
        .join();
        assert!(m.is_poisoned());
        assert_eq!(*lock(&m), 1);
    }
}
