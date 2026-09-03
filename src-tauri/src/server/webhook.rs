use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use axum::{
    body::Bytes,
    extract::OriginalUri,
    http::{HeaderMap, Method, StatusCode},
    response::sse::{Event, Sse},
    response::{IntoResponse, Response},
    routing::{any, get, post},
    Json, Router,
};
use futures_util::stream::Stream;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

const CAP_MAX: usize = 200;

#[derive(Clone, Serialize)]
struct Captured {
    id: u64,
    at: String,
    method: String,
    path: String,
    query: HashMap<String, String>,
    headers: HashMap<String, String>,
    body: String,
}

#[derive(Clone, Serialize)]
struct RespConfig {
    status: u16,
    #[serde(rename = "contentType")]
    content_type: String,
    body: String,
}

static CAPTURED: Lazy<Mutex<Vec<Captured>>> = Lazy::new(|| Mutex::new(Vec::new()));
static SEQ: AtomicU64 = AtomicU64::new(0);
static CONFIG: Lazy<Mutex<RespConfig>> = Lazy::new(|| {
    Mutex::new(RespConfig {
        status: 200,
        content_type: "application/json".into(),
        body: "{\"ok\":true}".into(),
    })
});
static TX: Lazy<broadcast::Sender<Captured>> = Lazy::new(|| broadcast::channel(256).0);

pub fn routes() -> Router {
    Router::new()
        .route("/in", any(capture))
        .route("/in/*rest", any(capture))
        .route("/list", get(list))
        .route("/clear", post(clear))
        .route("/config", get(get_config).post(set_config))
        .route("/stream", get(stream))
}

async fn capture(
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let full = uri.path();
    let path = match full.strip_prefix("/api/webhook/in") {
        Some(rest) if !rest.is_empty() => rest.to_string(),
        _ => "/".to_string(),
    };

    let query: HashMap<String, String> = uri
        .query()
        .map(|q| {
            q.split('&')
                .filter_map(|pair| {
                    let mut it = pair.splitn(2, '=');
                    Some((it.next()?.to_string(), it.next().unwrap_or("").to_string()))
                })
                .collect()
        })
        .unwrap_or_default();

    let hmap: HashMap<String, String> = headers
        .iter()
        .map(|(k, v)| (k.as_str().to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();

    let rec = Captured {
        id: SEQ.fetch_add(1, Ordering::SeqCst),
        at: chrono::Utc::now().to_rfc3339(),
        method: method.as_str().to_string(),
        path,
        query,
        headers: hmap,
        body: String::from_utf8_lossy(&body).to_string(),
    };

    {
        let mut buf = CAPTURED.lock().unwrap();
        buf.insert(0, rec.clone());
        if buf.len() > CAP_MAX {
            buf.truncate(CAP_MAX);
        }
    }
    let _ = TX.send(rec);

    let cfg = CONFIG.lock().unwrap().clone();
    let status = StatusCode::from_u16(cfg.status).unwrap_or(StatusCode::OK);
    (status, [("content-type", cfg.content_type)], cfg.body).into_response()
}

async fn list() -> Json<Value> {
    let buf = CAPTURED.lock().unwrap().clone();
    Json(json!({ "ok": true, "captured": buf }))
}

async fn clear() -> Json<Value> {
    CAPTURED.lock().unwrap().clear();
    Json(json!({ "ok": true }))
}

async fn get_config() -> Json<Value> {
    let cfg = CONFIG.lock().unwrap().clone();
    Json(json!({ "ok": true, "status": cfg.status, "contentType": cfg.content_type, "body": cfg.body }))
}

#[derive(Deserialize)]
struct ConfigReq {
    status: Option<Value>,
    #[serde(rename = "contentType")]
    content_type: Option<String>,
    body: Option<String>,
}

async fn set_config(Json(b): Json<ConfigReq>) -> Json<Value> {
    let status = b
        .status
        .and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
        .filter(|&n| n > 0)
        .unwrap_or(200) as u16;
    let cfg = RespConfig {
        status,
        content_type: b.content_type.filter(|s| !s.is_empty()).unwrap_or_else(|| "application/json".into()),
        body: b.body.unwrap_or_default(),
    };
    *CONFIG.lock().unwrap() = cfg.clone();
    Json(json!({ "ok": true, "status": cfg.status, "contentType": cfg.content_type, "body": cfg.body }))
}

async fn stream() -> Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>> {
    let rx = TX.subscribe();
    let ready = tokio_stream::once(Ok(Event::default().event("ready").data("listening")));
    let hits = BroadcastStream::new(rx).filter_map(|res| {
        res.ok().map(|rec| {
            Ok(Event::default()
                .event("hit")
                .data(serde_json::to_string(&rec).unwrap_or_default()))
        })
    });
    Sse::new(ready.chain(hits))
}
