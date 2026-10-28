//! Server-Sent Events through conduit, handed to the browser as NDJSON: `open`, one `event` per
//! dispatched event, then `close` or `error`.

use std::collections::HashMap;
use std::time::Duration;

use axum::{
    body::Body,
    extract::Query,
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};

use super::attempt::{self, Attempt};

/// How long the upstream may take to answer with headers.
const CONNECT_TIMEOUT_MS: u64 = 20_000;
/// How much of an error response body is read and passed on.
const BODY_EXCERPT: usize = 64 * 1024;
/// How long reading that body may take.
const BODY_TIMEOUT: Duration = Duration::from_secs(5);
/// The longest line the parser buffers; past it the line is dropped, not grown without end.
const LINE_MAX: usize = 1024 * 1024;

pub fn routes() -> Router {
    Router::new().route("/proxy", get(proxy))
}

#[derive(Deserialize)]
struct ProxyQuery {
    target: Option<String>,
    headers: Option<String>,
}

fn fail(status: StatusCode, body: Value) -> Response {
    let mut body = body;
    body["ok"] = json!(false);
    (status, Json(body)).into_response()
}

/// A request refused before it was sent, with the `detail` and `log` that say why.
fn refuse(status: StatusCode, att: &Attempt, message: &str) -> Response {
    let (detail, log) = att.not_sent("request", message);
    fail(status, json!({ "stage": "request", "error": message, "detail": detail, "log": log }))
}

async fn proxy(Query(q): Query<ProxyQuery>) -> Response {
    let target = q.target.unwrap_or_default();
    // the record of a request refused before it went out: no headers yet
    let unsent = Attempt::start("GET", &target, HashMap::new(), Value::Null, 0);
    let low = target.to_lowercase();
    if !(low.starts_with("http://") || low.starts_with("https://")) {
        return refuse(StatusCode::BAD_REQUEST, &unsent, "Not connected. The URL must start with http:// or https://.");
    }
    let headers = match super::ws::decode_headers(q.headers.as_deref()) {
        Ok(h) => h,
        Err(e) => return refuse(StatusCode::BAD_REQUEST, &unsent, &e),
    };

    let client = match reqwest::Client::builder()
        .connect_timeout(Duration::from_millis(CONNECT_TIMEOUT_MS))
        .build()
    {
        Ok(c) => c,
        Err(e) => return refuse(StatusCode::INTERNAL_SERVER_ERROR, &unsent, &format!("Not connected. {}", attempt::describe(&e))),
    };
    let mut rb = client.get(&target).header("accept", "text/event-stream");
    let mut sent: HashMap<String, String> = HashMap::new();
    sent.insert("accept".into(), "text/event-stream".into());
    for (k, v) in headers {
        sent.insert(k.to_string(), String::from_utf8_lossy(v.as_bytes()).to_string());
        rb = rb.header(k.as_str(), v.as_bytes());
    }
    if !sent.contains_key("user-agent") {
        let ua = super::http::user_agent();
        rb = rb.header("user-agent", ua.as_str());
        sent.insert("user-agent".into(), ua);
    }
    let att = Attempt::start("GET", &attempt::redact_url(&target), sent.clone(), Value::Null, 0);

    let upstream = match tokio::time::timeout(Duration::from_millis(CONNECT_TIMEOUT_MS), rb.send()).await {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => {
            let timed_out = e.is_timeout();
            let (detail, log) = att.failed("network", &e.without_url(), timed_out, CONNECT_TIMEOUT_MS).await;
            return fail(
                StatusCode::BAD_GATEWAY,
                json!({ "stage": "network", "error": detail["message"].clone(), "detail": detail, "log": log, "ms": att.elapsed_ms() }),
            );
        }
        Err(_) => {
            let (detail, log) = att
                .failed_with(
                    "timeout",
                    vec![format!("no answer within {CONNECT_TIMEOUT_MS} ms")],
                    true,
                    CONNECT_TIMEOUT_MS,
                )
                .await;
            return fail(
                StatusCode::GATEWAY_TIMEOUT,
                json!({ "stage": "timeout", "error": detail["message"].clone(), "detail": detail, "log": log, "ms": att.elapsed_ms() }),
            );
        }
    };

    let status = upstream.status();
    let up_headers = super::ws::headers_json(upstream.headers());
    let content_type = upstream
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    if !status.is_success() {
        let message = format!(
            "the server answered {} {}",
            status.as_u16(),
            status.canonical_reason().unwrap_or("")
        );
        // the refusal is the answer; a failure reading its body is noted, not hidden
        let (bytes, total, body_error) = read_excerpt(upstream).await;
        let body = String::from_utf8_lossy(&bytes).to_string();
        let chain: Vec<String> = std::iter::once(message.clone()).chain(body_error.clone()).collect();
        let (mut detail, _) = att.server_refused("response", chain, "http");
        detail["message"] = json!(message);
        detail["hints"] = json!(status_hints(status.as_u16(), &sent));
        let log = super::ws::refused_log(&att, status.as_u16(), &up_headers, &body, total, &detail);
        return fail(
            StatusCode::BAD_GATEWAY,
            json!({
                "stage": "response",
                "error": message,
                "status": status.as_u16(),
                "headers": up_headers,
                "body": body,
                "bodyBytes": total,
                "bodyError": body_error,
                "detail": detail,
                "log": log,
                "ms": att.elapsed_ms(),
            }),
        );
    }

    let warning = if content_type.to_ascii_lowercase().starts_with("text/event-stream") {
        Value::Null
    } else {
        json!(format!(
            "the server answered with content-type {:?}, not text/event-stream: events below are parsed anyway",
            content_type
        ))
    };
    let open = json!({
        "kind": "open",
        "status": status.as_u16(),
        "headers": up_headers,
        "contentType": content_type,
        "warning": warning,
        "ms": att.elapsed_ms(),
        "log": super::ws::opened_log(&att, status.as_u16(), &up_headers),
    });

    let body = async_stream::stream! {
        yield Ok::<_, std::convert::Infallible>(line(&open));
        let mut parser = SseParser::default();
        let mut bytes = upstream.bytes_stream();
        loop {
            match bytes.next().await {
                Some(Ok(chunk)) => {
                    for ev in parser.push(&chunk) {
                        yield Ok(line(&ev.to_json()));
                    }
                }
                Some(Err(e)) => {
                    let detail = super::ws::stream_failure(attempt::chain(&e));
                    yield Ok(line(&json!({ "kind": "error", "stage": "stream", "error": attempt::describe(&e), "detail": detail })));
                    return;
                }
                None => {
                    yield Ok(line(&json!({ "kind": "close", "reason": "the server ended the stream" })));
                    return;
                }
            }
        }
    };

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/x-ndjson")
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from_stream(body))
        .unwrap()
}

/// At most [`BODY_EXCERPT`] bytes of `resp`'s body within [`BODY_TIMEOUT`], the bytes seen, and
/// why reading stopped early if it did.
async fn read_excerpt(resp: reqwest::Response) -> (Vec<u8>, usize, Option<String>) {
    let mut kept = Vec::new();
    let mut total = 0usize;
    let mut stream = resp.bytes_stream();
    let read = async {
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("its body could not be read: {}", attempt::describe(&e.without_url())))?;
            total += chunk.len();
            let room = BODY_EXCERPT.saturating_sub(kept.len());
            kept.extend_from_slice(&chunk[..chunk.len().min(room)]);
            if kept.len() >= BODY_EXCERPT {
                break;
            }
        }
        Ok::<(), String>(())
    };
    let error = match tokio::time::timeout(BODY_TIMEOUT, read).await {
        Ok(Ok(())) => None,
        Ok(Err(e)) => Some(e),
        Err(_) => Some(format!("its body was still arriving after {} s; the start is shown", BODY_TIMEOUT.as_secs())),
    };
    (kept, total, error)
}

fn line(v: &Value) -> String {
    format!("{v}\n")
}

/// What a non-2xx answer to an event-stream request most likely means.
fn status_hints(status: u16, sent: &HashMap<String, String>) -> Vec<String> {
    match status {
        401 | 403 => attempt::refusal_hints(status, sent),
        404 => vec!["Nothing at this path: check the URL of the event stream.".into()],
        405 => vec!["The endpoint does not accept GET: some event streams are opened with POST, which this proxy does not send.".into()],
        406 => vec!["The server does not offer text/event-stream at this URL (406 Not Acceptable).".into()],
        429 => vec!["Rate limited: wait and retry, and check the Retry-After header.".into()],
        300..=399 => vec!["The server redirected: connect to the URL in its Location header.".into()],
        500..=599 => vec!["The server (or a gateway in front of it) failed: its body may say why.".into()],
        _ => vec![],
    }
}

/// One dispatched event.
#[derive(Debug, PartialEq)]
struct SseEvent {
    event: String,
    data: String,
    id: Option<String>,
    retry: Option<u64>,
}

impl SseEvent {
    fn to_json(&self) -> Value {
        json!({
            "kind": "event",
            "at": chrono::Utc::now().to_rfc3339(),
            "event": self.event,
            "id": self.id,
            "retry": self.retry,
            "data": self.data,
        })
    }
}

/// The event-stream format (WHATWG HTML, "Server-sent events"), parsed as bytes arrive.
#[derive(Default)]
struct SseParser {
    buf: Vec<u8>,
    /// the previous chunk ended in CR: a LF starting the next one belongs to it
    after_cr: bool,
    /// the line being read passed [`LINE_MAX`]: the rest of it is skipped
    skipping: bool,
    started: bool,
    data: Option<String>,
    event: String,
    /// the last event ID: it stays with every later event until changed
    id: Option<String>,
    retry: Option<u64>,
}

impl SseParser {
    fn push(&mut self, chunk: &[u8]) -> Vec<SseEvent> {
        let mut out = Vec::new();
        let mut chunk = chunk;
        if self.after_cr && chunk.first() == Some(&b'\n') {
            chunk = &chunk[1..];
        }
        self.after_cr = false;
        self.buf.extend_from_slice(chunk);

        let mut start = 0;
        let mut i = 0;
        while i < self.buf.len() {
            let b = self.buf[i];
            if b == b'\n' || b == b'\r' {
                let line = String::from_utf8_lossy(&self.buf[start..i]).to_string();
                let mut next = i + 1;
                if b == b'\r' {
                    if next < self.buf.len() {
                        if self.buf[next] == b'\n' {
                            next += 1;
                        }
                    } else {
                        self.after_cr = true;
                    }
                }
                if std::mem::take(&mut self.skipping) {
                    out.push(SseEvent { event: "conduit-warning".into(), data: format!("a line longer than {LINE_MAX} bytes was dropped"), id: None, retry: None });
                } else if let Some(ev) = self.line(&line) {
                    out.push(ev);
                }
                start = next;
                i = next;
            } else {
                i += 1;
            }
        }
        self.buf.drain(..start);
        if self.buf.len() > LINE_MAX {
            self.buf.clear();
            self.skipping = true;
        }
        out
    }

    fn line(&mut self, line: &str) -> Option<SseEvent> {
        let line = if self.started {
            line
        } else {
            self.started = true;
            line.strip_prefix('\u{feff}').unwrap_or(line)
        };
        if line.is_empty() {
            let event = std::mem::take(&mut self.event);
            let retry = self.retry.take();
            let data = self.data.take()?;
            return Some(SseEvent {
                event: if event.is_empty() { "message".into() } else { event },
                data,
                id: self.id.clone(),
                retry,
            });
        }
        if line.starts_with(':') {
            return None;
        }
        let (field, value) = match line.find(':') {
            Some(i) => {
                let v = &line[i + 1..];
                (&line[..i], v.strip_prefix(' ').unwrap_or(v))
            }
            None => (line, ""),
        };
        match field {
            "data" => match &mut self.data {
                Some(d) => {
                    d.push('\n');
                    d.push_str(value);
                }
                None => self.data = Some(value.to_string()),
            },
            "event" => self.event = value.to_string(),
            "id" if !value.contains('\0') => self.id = Some(value.to_string()),
            "retry" if !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()) => {
                self.retry = value.parse().ok()
            }
            _ => {}
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all(chunks: &[&[u8]]) -> Vec<SseEvent> {
        let mut p = SseParser::default();
        chunks.iter().flat_map(|c| p.push(c)).collect()
    }

    #[test]
    fn named_events_ids_and_retry_are_kept() {
        let evs = all(&[b"retry: 3000\nid: 7\nevent: price\ndata: {\"a\":1}\n\ndata: plain\n\n"]);
        assert_eq!(
            evs,
            vec![
                SseEvent { event: "price".into(), data: "{\"a\":1}".into(), id: Some("7".into()), retry: Some(3000) },
                SseEvent { event: "message".into(), data: "plain".into(), id: Some("7".into()), retry: None },
            ]
        );
    }

    #[test]
    fn data_lines_join_and_comments_are_skipped() {
        let evs = all(&[b": keep-alive\n\ndata: a\ndata\ndata: b\n\n"]);
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].data, "a\n\nb");
    }

    #[test]
    fn line_endings_and_chunk_splits_do_not_matter() {
        let evs = all(&[b"data: x\r", b"\n\r", b"\ndata: y\r\r", b"data: \xc3", b"\xa9\n\n"]);
        let data: Vec<&str> = evs.iter().map(|e| e.data.as_str()).collect();
        assert_eq!(data, vec!["x", "y", "é"]);
    }

    #[test]
    fn a_bom_and_a_bad_retry_are_ignored() {
        let evs = all(&["\u{feff}data: a\nretry: soon\n\n".as_bytes()]);
        assert_eq!(evs[0].data, "a");
        assert_eq!(evs[0].retry, None);
    }

    #[test]
    fn an_event_without_data_is_not_dispatched() {
        assert!(all(&[b"event: ping\n\n"]).is_empty());
    }

    #[test]
    fn a_refusal_names_the_credentials_only_when_some_were_sent() {
        let mut sent = HashMap::new();
        assert!(status_hints(403, &sent)[0].contains("no credentials were sent"));
        sent.insert("authorization".to_string(), "Bearer x".to_string());
        assert!(status_hints(401, &sent)[0].contains("refused the credentials"));
        assert!(status_hints(418, &sent).is_empty());
    }

    #[test]
    fn an_endless_line_is_dropped_not_buffered() {
        let mut p = SseParser::default();
        let chunk = vec![b'x'; 64 * 1024];
        for _ in 0..(LINE_MAX / chunk.len() + 2) {
            assert!(p.push(&chunk).is_empty());
        }
        assert!(p.buf.len() <= LINE_MAX);
        let evs = p.push(b"\ndata: ok\n\n");
        assert_eq!(evs[0].event, "conduit-warning");
        assert_eq!(evs[1].data, "ok");
    }

    #[tokio::test]
    async fn a_refusal_body_is_read_only_up_to_the_excerpt() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new().route(
            "/",
            get(|| async {
                let chunks = futures_util::stream::iter((0..10_000).map(|_| Ok::<_, std::io::Error>(vec![b'e'; 1024])));
                (StatusCode::FORBIDDEN, Body::from_stream(chunks))
            }),
        );
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let resp = reqwest::get(format!("http://{addr}/")).await.unwrap();
        let (kept, total, err) = read_excerpt(resp).await;
        assert_eq!(kept.len(), BODY_EXCERPT);
        assert!(total < 10_000 * 1024, "stopped reading early");
        assert!(err.is_none(), "{err:?}");
    }
}
