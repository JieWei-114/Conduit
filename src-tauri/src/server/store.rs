use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use axum::{
    extract::{DefaultBodyLimit, Query},
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};

const BODY_LIMIT: usize = 16 * 1024 * 1024;

static LAST_FLUSH: AtomicU64 = AtomicU64::new(0);

pub fn last_flush() -> u64 {
    LAST_FLUSH.load(Ordering::SeqCst)
}

fn file() -> PathBuf {
    match std::env::var("CONDUIT_DATA") {
        Ok(p) if !p.is_empty() => PathBuf::from(p),
        _ => std::env::current_dir()
            .unwrap_or_default()
            .join("conduit-data.json"),
    }
}

pub fn routes() -> Router {
    Router::new()
        .route("/", get(read).put(write).post(beacon).delete(wipe))
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
}

async fn read() -> Json<Value> {
    match std::fs::read_to_string(file())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
    {
        Some(v) => Json(v),
        None => Json(json!({})),
    }
}

#[derive(Deserialize)]
struct WriteParams {
    flush: Option<u64>,
}

async fn write(Query(params): Query<WriteParams>, Json(body): Json<Value>) -> Json<Value> {
    save(params, body)
}

/// The same save as PUT, for `navigator.sendBeacon` on pagehide: a POST whose JSON body may be
/// labelled `text/plain` (a beacon cannot set `application/json` without a CORS preflight).
async fn beacon(Query(params): Query<WriteParams>, body: axum::body::Bytes) -> Json<Value> {
    match serde_json::from_slice::<Value>(&body) {
        Ok(v) if v.is_object() => save(params, v),
        Ok(_) => Json(json!({ "ok": false, "error": "the body is JSON but not an object" })),
        Err(e) => Json(json!({ "ok": false, "error": format!("the body is not JSON: {e}") })),
    }
}

fn save(params: WriteParams, body: Value) -> Json<Value> {
    let f = file();
    let res = serde_json::to_string_pretty(&body)
        .map_err(|e| e.to_string())
        .and_then(|s| std::fs::write(&f, s).map_err(|e| e.to_string()));
    if let Some(id) = params.flush {
        LAST_FLUSH.fetch_max(id, Ordering::SeqCst);
    }
    match res {
        Ok(_) => Json(json!({ "ok": true, "file": f.to_string_lossy() })),
        Err(e) => Json(json!({ "ok": false, "error": format!("{}: {e}", f.display()) })),
    }
}

async fn wipe() -> Json<Value> {
    let _ = std::fs::remove_file(file());
    Json(json!({ "ok": true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn accepts_bodies_above_the_default_limit_and_records_the_flush() {
        let dir = std::env::temp_dir().join(format!("conduit-store-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("CONDUIT_DATA", dir.join("data.json"));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, routes()).await.unwrap() });

        let big = "x".repeat(4 * 1024 * 1024);
        let res = reqwest::Client::new()
            .put(format!("http://{addr}/?flush=7"))
            .header("content-type", "application/json")
            .body(serde_json::to_vec(&json!({ "k": big })).unwrap())
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        let body: Value = serde_json::from_slice(&res.bytes().await.unwrap()).unwrap();
        assert_eq!(body["ok"], true);
        assert!(last_flush() >= 7);

        let beacon = reqwest::Client::new()
            .post(format!("http://{addr}/?flush=9"))
            .header("content-type", "text/plain;charset=UTF-8")
            .body(r#"{"k":"from a beacon"}"#)
            .send()
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&beacon.bytes().await.unwrap()).unwrap();
        assert_eq!(body["ok"], true, "{body}");
        assert!(last_flush() >= 9);
        let saved: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("data.json")).unwrap()).unwrap();
        assert_eq!(saved["k"], "from a beacon");
        let bad = reqwest::Client::new()
            .post(format!("http://{addr}/"))
            .body("not json")
            .send()
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&bad.bytes().await.unwrap()).unwrap();
        assert_eq!(body["ok"], false);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
