// NEW Cargo deps: tokio-tungstenite = "0.24". axum needs feature "ws" enabled (axum 0.7 `ws` feature).

use std::collections::HashMap;

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
use serde_json::json;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::{HeaderName, HeaderValue};
use tokio_tungstenite::tungstenite::protocol::Message as TMessage;

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

async fn handle(mut client: WebSocket, q: ProxyQuery) {
    let target = q.target.unwrap_or_default();
    let low = target.to_lowercase();
    if !(low.starts_with("ws://") || low.starts_with("wss://")) {
        let _ = client
            .send(Message::Text(
                json!({ "kind": "error", "error": "target must start with ws:// or wss://" })
                    .to_string(),
            ))
            .await;
        let _ = client.close().await;
        return;
    }

    let mut headers: HashMap<String, String> = HashMap::new();
    if let Some(hb) = &q.headers {
        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(hb.as_bytes()) {
            if let Ok(map) = serde_json::from_slice::<HashMap<String, String>>(&bytes) {
                headers = map;
            }
        }
    }

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
            send_error(&mut client, &e.to_string()).await;
            return;
        }
    };
    {
        let hmap = request.headers_mut();
        for (k, v) in &headers {
            if let (Ok(name), Ok(val)) = (
                HeaderName::from_bytes(k.as_bytes()),
                HeaderValue::from_str(v),
            ) {
                hmap.insert(name, val);
            }
        }
        if !protocols.is_empty() {
            if let Ok(val) = HeaderValue::from_str(&protocols.join(", ")) {
                hmap.insert("sec-websocket-protocol", val);
            }
        }
    }

    let (upstream, _resp) = match tokio_tungstenite::connect_async(request).await {
        Ok(pair) => pair,
        Err(e) => {
            send_error(&mut client, &e.to_string()).await;
            return;
        }
    };

    let (mut up_tx, mut up_rx) = upstream.split();
    let (mut cl_tx, mut cl_rx) = client.split();

    let _ = cl_tx
        .send(Message::Text(json!({ "kind": "open" }).to_string()))
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
                    let env = json!({
                        "kind": "message",
                        "at": chrono::Utc::now().to_rfc3339(),
                        "data": format!("[binary {} bytes]", b.len()),
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
                            json!({ "kind": "close", "code": code, "reason": reason }).to_string(),
                        ))
                        .await;
                    let _ = cl_tx.close().await;
                    return;
                }
                Ok(_) => {}
                Err(e) => {
                    let _ = cl_tx
                        .send(Message::Text(
                            json!({ "kind": "error", "error": e.to_string() }).to_string(),
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
                json!({ "kind": "close", "code": 1005, "reason": "" }).to_string(),
            ))
            .await;
        let _ = cl_tx.close().await;
    };

    // browser -> upstream (verbatim as text)
    let browser_to_up = async {
        while let Some(msg) = cl_rx.next().await {
            match msg {
                Ok(Message::Text(t)) => {
                    if up_tx.send(TMessage::Text(t.into())).await.is_err() {
                        break;
                    }
                }
                Ok(Message::Binary(b)) => {
                    let s = String::from_utf8_lossy(&b).to_string();
                    if up_tx.send(TMessage::Text(s.into())).await.is_err() {
                        break;
                    }
                }
                Ok(Message::Close(_)) => break,
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

async fn send_error(client: &mut WebSocket, msg: &str) {
    let _ = client
        .send(Message::Text(
            json!({ "kind": "error", "error": msg }).to_string(),
        ))
        .await;
    let _ = client.close().await;
}
