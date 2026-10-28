use std::collections::HashMap;
use std::time::Duration;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query,
    },
    response::Response,
    routing::get,
    Router,
};
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::{HeaderName, HeaderValue};
use tokio_tungstenite::tungstenite::http::HeaderMap;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::frame::CloseFrame as TCloseFrame;
use tokio_tungstenite::tungstenite::protocol::Message as TMessage;
use tokio_tungstenite::tungstenite::Error as WsError;

use super::attempt::{self, Attempt, Reply};

/// How long the upstream handshake (DNS, TCP, TLS, HTTP upgrade) may take.
const HANDSHAKE_TIMEOUT_MS: u64 = 20_000;
/// How much of an error response body is passed on.
const BODY_EXCERPT: usize = 64 * 1024;

pub fn routes() -> Router {
    Router::new().route("/proxy", get(proxy))
}

#[derive(Deserialize)]
struct ProxyQuery {
    target: Option<String>,
    headers: Option<String>,
    protocols: Option<String>,
}

async fn proxy(ws: WebSocketUpgrade, Query(q): Query<ProxyQuery>) -> Response {
    ws.on_upgrade(move |socket| handle(socket, q))
}

/// The `headers` query parameter: base64 of a JSON object of strings. Every problem is
/// reported (bad base64, not JSON, a non-string value, an invalid name or value) so nothing is
/// silently left out of the request.
pub(super) fn decode_headers(blob: Option<&str>) -> Result<Vec<(HeaderName, HeaderValue)>, String> {
    let Some(blob) = blob.filter(|b| !b.is_empty()) else {
        return Ok(Vec::new());
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(blob.as_bytes())
        .map_err(|e| format!("the headers parameter is not valid base64: {e}"))?;
    let map: Map<String, Value> = serde_json::from_slice(&bytes)
        .map_err(|e| format!("the headers parameter is not a JSON object: {e}"))?;
    let mut out = Vec::new();
    let mut bad = Vec::new();
    for (k, v) in map {
        let Some(v) = v.as_str() else {
            bad.push(format!("{k:?}: value is not a string"));
            continue;
        };
        match (HeaderName::from_bytes(k.as_bytes()), HeaderValue::from_str(v)) {
            (Ok(n), Ok(val)) => out.push((n, val)),
            (Err(_), _) => bad.push(format!(
                "{k:?} is not a valid header name (letters, digits and !#$%&'*+-.^_`|~ only, no spaces or colons)"
            )),
            (_, Err(_)) => bad.push(format!(
                "the value of {k:?} is not a valid header value (no line breaks or control characters)"
            )),
        }
    }
    if bad.is_empty() {
        Ok(out)
    } else {
        Err(format!("Not connected. Fix these headers: {}", bad.join("; ")))
    }
}

/// Headers as a JSON object of strings, repeated ones joined with ", ", non-UTF-8 lossy.
pub(super) fn headers_json(h: &HeaderMap) -> Map<String, Value> {
    let mut out: Map<String, Value> = Map::new();
    for (k, v) in h {
        let v = String::from_utf8_lossy(v.as_bytes()).to_string();
        match out.get_mut(k.as_str()) {
            Some(Value::String(prev)) => {
                prev.push_str(", ");
                prev.push_str(&v);
            }
            _ => {
                out.insert(k.as_str().to_string(), Value::String(v));
            }
        }
    }
    out
}

/// What a non-upgrade answer to a WebSocket handshake most likely means.
fn handshake_status_hints(status: u16, location: Option<&str>, sent: &HashMap<String, String>) -> Vec<String> {
    let mut out = Vec::new();
    match status {
        200 => out.push("The server answered with an ordinary page instead of switching to WebSocket: this URL is not a WebSocket endpoint (check the path), or a proxy in between does not pass WebSocket upgrades.".into()),
        301 | 302 | 303 | 307 | 308 => out.push(format!(
            "The server redirects{}; WebSocket clients do not follow redirects. Connect to that URL instead (ws:// ↔ wss:// is a common cause).",
            location.map(|l| format!(" to {l}")).unwrap_or_default()
        )),
        400 => out.push("The server refused the upgrade request as malformed: it may need a subprotocol, a specific Origin, or query parameters it did not get.".into()),
        401 | 403 => out.extend(attempt::refusal_hints(status, sent)),
        404 => out.push("Nothing at this path: check the path the WebSocket server is mounted on.".into()),
        426 => out.push("The server asks for a different protocol version (426 Upgrade Required): see the Upgrade / Sec-WebSocket-Version headers below.".into()),
        429 => out.push("Rate limited: wait and retry, and check the Retry-After header below.".into()),
        500..=599 => out.push("The server (or a gateway in front of it) failed while handling the upgrade: its body below may say why.".into()),
        _ => {}
    }
    out
}

/// A failure on an open stream (a reset, a protocol error), as the same `detail` a failed
/// request has: its cause chain and kind. The stream had started, so nothing is probed.
pub(super) fn stream_failure(chain: Vec<String>) -> Value {
    let kind = attempt::kind(&chain, false);
    json!({
        "stage": "stream",
        "kind": kind,
        "message": chain.last().cloned().unwrap_or_default(),
        "chain": chain,
        "hints": [],
        "probe": Value::Null,
    })
}

/// The record of a request whose answer was not the stream asked for (a 401 instead of the
/// upgrade, say): the answer as the response, `detail` as the error. The request and the
/// response both happened, so both are in the log.
pub(super) fn refused_log(att: &Attempt, status: u16, headers: &Map<String, Value>, body: &str, bytes: usize, detail: &Value) -> Value {
    let headers: HashMap<String, String> = headers
        .iter()
        .map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_string()))
        .collect();
    let mut log = att.succeeded(Reply { status, headers: &headers, trailers: None, body: json!(body), bytes });
    log["error"] = detail.clone();
    log
}

/// The record of a stream that opened: the status and headers it was answered with.
pub(super) fn opened_log(att: &Attempt, status: u16, headers: &Map<String, Value>) -> Value {
    let headers: HashMap<String, String> = headers
        .iter()
        .map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_string()))
        .collect();
    att.succeeded(Reply { status, headers: &headers, trailers: None, body: Value::Null, bytes: 0 })
}

/// A request refused before it was sent, as the error envelope: `detail` and `log` say why.
async fn refuse(client: &mut WebSocket, att: &Attempt, message: &str) {
    let (detail, log) = att.not_sent("request", message);
    send_error(client, json!({ "stage": "request", "error": message, "detail": detail, "log": log })).await;
}

async fn handle(mut client: WebSocket, q: ProxyQuery) {
    let target = q.target.unwrap_or_default();
    // the record of a request refused before it went out: no headers yet
    let unsent = Attempt::start("GET", &target, HashMap::new(), Value::Null, 0);
    let low = target.to_lowercase();
    if !(low.starts_with("ws://") || low.starts_with("wss://")) {
        refuse(&mut client, &unsent, "Not connected. The URL must start with ws:// or wss://.").await;
        return;
    }

    let headers = match decode_headers(q.headers.as_deref()) {
        Ok(h) => h,
        Err(e) => {
            refuse(&mut client, &unsent, &e).await;
            return;
        }
    };

    let protocols: Vec<String> = q
        .protocols
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    let mut request = match target.as_str().into_client_request() {
        Ok(r) => r,
        Err(e) => {
            refuse(&mut client, &unsent, &format!("Not connected. {}", attempt::describe(&e))).await;
            return;
        }
    };
    {
        let hmap = request.headers_mut();
        for (name, val) in headers {
            hmap.insert(name, val);
        }
        if !hmap.contains_key("user-agent") {
            if let Ok(ua) = HeaderValue::from_str(&super::http::user_agent()) {
                hmap.insert("user-agent", ua);
            }
        }
        if !protocols.is_empty() {
            match HeaderValue::from_str(&protocols.join(", ")) {
                Ok(val) => {
                    hmap.insert("sec-websocket-protocol", val);
                }
                Err(_) => {
                    refuse(&mut client, &unsent, "Not connected. The subprotocol list has characters a header cannot carry.").await;
                    return;
                }
            }
        }
    }

    let sent: HashMap<String, String> = request
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), String::from_utf8_lossy(v.as_bytes()).to_string()))
        .collect();
    let att = Attempt::start("GET", &attempt::redact_url(&target), sent.clone(), Value::Null, 0);

    let connected = tokio::time::timeout(
        Duration::from_millis(HANDSHAKE_TIMEOUT_MS),
        tokio_tungstenite::connect_async(request),
    )
    .await;
    let (upstream, resp) = match connected {
        Ok(Ok(pair)) => pair,
        Ok(Err(WsError::Http(resp))) => {
            let status = resp.status();
            let headers = headers_json(resp.headers());
            let raw = resp.body().as_deref().unwrap_or_default();
            let body = String::from_utf8_lossy(&raw[..raw.len().min(BODY_EXCERPT)]).to_string();
            let message = format!(
                "the server answered {} {} instead of switching to WebSocket",
                status.as_u16(),
                status.canonical_reason().unwrap_or("")
            );
            let location = resp
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok());
            let (mut detail, _) = att.server_refused("handshake", vec![message.clone()], "http");
            detail["hints"] = json!(handshake_status_hints(status.as_u16(), location, &sent));
            let log = refused_log(&att, status.as_u16(), &headers, &body, raw.len(), &detail);
            send_error(
                &mut client,
                json!({
                    "stage": "handshake",
                    "error": message,
                    "status": status.as_u16(),
                    "headers": headers,
                    "body": body,
                    "detail": detail,
                    "log": log,
                    "ms": att.elapsed_ms(),
                }),
            )
            .await;
            return;
        }
        Ok(Err(e)) => {
            let (detail, log) = att.failed("handshake", &e, false, HANDSHAKE_TIMEOUT_MS).await;
            send_error(
                &mut client,
                json!({ "stage": "handshake", "error": attempt::describe(&e), "detail": detail, "log": log, "ms": att.elapsed_ms() }),
            )
            .await;
            return;
        }
        Err(_) => {
            let (detail, log) = att
                .failed_with(
                    "timeout",
                    vec![format!("no WebSocket handshake within {HANDSHAKE_TIMEOUT_MS} ms")],
                    true,
                    HANDSHAKE_TIMEOUT_MS,
                )
                .await;
            send_error(
                &mut client,
                json!({ "stage": "timeout", "error": detail["message"].clone(), "detail": detail, "log": log, "ms": att.elapsed_ms() }),
            )
            .await;
            return;
        }
    };

    let (mut up_tx, mut up_rx) = upstream.split();
    let (mut cl_tx, mut cl_rx) = client.split();

    let protocol = resp
        .headers()
        .get("sec-websocket-protocol")
        .map(|v| String::from_utf8_lossy(v.as_bytes()).to_string());
    let open_headers = headers_json(resp.headers());
    let log = opened_log(&att, resp.status().as_u16(), &open_headers);
    let _ = cl_tx
        .send(Message::Text(
            json!({
                "kind": "open",
                "status": resp.status().as_u16(),
                "headers": open_headers,
                "protocol": protocol,
                "ms": att.elapsed_ms(),
                "log": log,
            })
            .to_string(),
        ))
        .await;

    // upstream -> browser
    let up_to_browser = async {
        while let Some(msg) = up_rx.next().await {
            match msg {
                Ok(TMessage::Text(t)) => {
                    let env = json!({
                        "kind": "message",
                        "at": chrono::Utc::now().to_rfc3339(),
                        "data": t.to_string(),
                    });
                    if cl_tx.send(Message::Text(env.to_string())).await.is_err() {
                        break;
                    }
                }
                Ok(TMessage::Binary(b)) => {
                    // base64, not a placeholder: the envelope is JSON and the
                    // bytes need not be valid UTF-8, but the caller still has to
                    // be able to read them (Socket.IO binary attachments, say).
                    let env = json!({
                        "kind": "message",
                        "at": chrono::Utc::now().to_rfc3339(),
                        "encoding": "base64",
                        "bytes": b.len(),
                        "data": base64::engine::general_purpose::STANDARD.encode(&b),
                    });
                    if cl_tx.send(Message::Text(env.to_string())).await.is_err() {
                        break;
                    }
                }
                Ok(TMessage::Close(frame)) => {
                    let (code, reason) = frame
                        .map(|f| (u16::from(f.code), f.reason.to_string()))
                        .unwrap_or((1005, String::new()));
                    let _ = cl_tx
                        .send(Message::Text(
                            json!({ "kind": "close", "by": "server", "code": code, "reason": reason }).to_string(),
                        ))
                        .await;
                    let _ = cl_tx.close().await;
                    return;
                }
                Ok(_) => {}
                Err(e) => {
                    let detail = stream_failure(attempt::chain(&e));
                    let _ = cl_tx
                        .send(Message::Text(
                            json!({ "kind": "error", "stage": "stream", "error": attempt::describe(&e), "detail": detail }).to_string(),
                        ))
                        .await;
                    let _ = cl_tx.close().await;
                    return;
                }
            }
        }
        // upstream stream ended without an explicit close frame
        let _ = cl_tx
            .send(Message::Text(
                json!({ "kind": "close", "by": "server", "code": 1006, "reason": "the connection ended without a close frame" }).to_string(),
            ))
            .await;
        let _ = cl_tx.close().await;
    };

    // browser -> upstream (verbatim as text)
    let browser_to_up = async {
        while let Some(msg) = cl_rx.next().await {
            match msg {
                Ok(Message::Text(t)) => {
                    if up_tx.send(TMessage::Text(t)).await.is_err() {
                        break;
                    }
                }
                // Relayed as binary rather than lossily stringified: bytes the
                // browser sends as binary are meant to reach the server as bytes.
                Ok(Message::Binary(b)) => {
                    if up_tx.send(TMessage::Binary(b)).await.is_err() {
                        break;
                    }
                }
                // pass the browser's close code and reason on to the server
                Ok(Message::Close(frame)) => {
                    let frame = frame.map(|f| TCloseFrame {
                        code: CloseCode::from(f.code),
                        reason: f.reason.into_owned().into(),
                    });
                    let _ = up_tx.send(TMessage::Close(frame)).await;
                    break;
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
        let _ = up_tx.close().await;
    };

    tokio::select! {
        _ = up_to_browser => {}
        _ = browser_to_up => {}
    }
}

/// Send `{ kind: "error", ...fields }` to the browser and close.
async fn send_error(client: &mut WebSocket, fields: Value) {
    let mut env = json!({ "kind": "error" });
    if let (Some(env), Value::Object(f)) = (env.as_object_mut(), fields) {
        env.extend(f);
    }
    let _ = client.send(Message::Text(env.to_string())).await;
    let _ = client.close().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b64(s: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(s)
    }

    #[test]
    fn good_headers_pass_and_none_is_fine() {
        assert!(decode_headers(None).unwrap().is_empty());
        assert!(decode_headers(Some("")).unwrap().is_empty());
        let h = decode_headers(Some(&b64(r#"{"authorization":"Bearer x","x-a":"1"}"#))).unwrap();
        assert_eq!(h.len(), 2);
    }

    #[test]
    fn bad_headers_are_reported_not_skipped() {
        assert!(decode_headers(Some("%%%")).unwrap_err().contains("base64"));
        assert!(decode_headers(Some(&b64("[1]"))).unwrap_err().contains("JSON object"));
        let e = decode_headers(Some(&b64(r#"{"bad name":"v","x-ok":"a\nb","n":1}"#))).unwrap_err();
        assert!(e.contains("\"bad name\" is not a valid header name"), "{e}");
        assert!(e.contains("value of \"x-ok\""), "{e}");
        assert!(e.contains("\"n\": value is not a string"), "{e}");
    }

    #[test]
    fn a_handshake_status_gets_a_reason() {
        let none = HashMap::new();
        assert!(handshake_status_hints(401, None, &none)[0].contains("credentials"));
        assert!(handshake_status_hints(403, None, &none)[0].contains("no credentials were sent"));
        assert!(handshake_status_hints(301, Some("wss://x/"), &none)[0].contains("wss://x/"));
        assert!(handshake_status_hints(200, None, &none)[0].contains("not a WebSocket endpoint"));
        assert!(handshake_status_hints(418, None, &none).is_empty());
    }

    #[test]
    fn a_refused_handshake_records_the_answer_and_the_error() {
        let att = Attempt::start("GET", "wss://h.test/x", HashMap::new(), Value::Null, 0);
        let mut h = Map::new();
        h.insert("www-authenticate".into(), json!("Bearer"));
        let detail = json!({ "kind": "http", "message": "the server answered 401" });
        let log = refused_log(&att, 401, &h, "nope", 4, &detail);
        assert_eq!(log["response"]["status"], 401);
        assert_eq!(log["response"]["headers"]["www-authenticate"], "Bearer");
        assert_eq!(log["response"]["body"], "nope");
        assert_eq!(log["error"]["kind"], "http");
        assert_eq!(opened_log(&att, 101, &h)["error"], Value::Null);
    }

    #[test]
    fn a_stream_failure_has_a_kind_and_no_probe() {
        let d = stream_failure(vec!["WebSocket protocol error".into(), "Connection reset without closing handshake".into()]);
        assert_eq!(d["stage"], "stream");
        assert_eq!(d["kind"], "protocol");
        assert_eq!(d["message"], "Connection reset without closing handshake");
        assert!(d["probe"].is_null());
    }

    #[test]
    fn repeated_response_headers_are_joined() {
        let mut h = HeaderMap::new();
        h.append("set-cookie", "a=1".parse().unwrap());
        h.append("set-cookie", "b=2".parse().unwrap());
        assert_eq!(headers_json(&h)["set-cookie"], json!("a=1, b=2"));
    }
}
