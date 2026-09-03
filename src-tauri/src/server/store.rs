use std::path::PathBuf;

use axum::{
    routing::get,
    Json, Router,
};
use serde_json::{json, Value};

fn file() -> PathBuf {
    match std::env::var("CONDUIT_DATA") {
        Ok(p) if !p.is_empty() => PathBuf::from(p),
        _ => std::env::current_dir()
            .unwrap_or_default()
            .join("conduit-data.json"),
    }
}

pub fn routes() -> Router {
    Router::new().route("/", get(read).put(write).delete(wipe))
}

async fn read() -> Json<Value> {
    match std::fs::read_to_string(file()).ok().and_then(|s| serde_json::from_str(&s).ok()) {
        Some(v) => Json(v),
        None => Json(json!({})),
    }
}

async fn write(Json(body): Json<Value>) -> Json<Value> {
    let f = file();
    match serde_json::to_string_pretty(&body).map_err(|e| e.to_string()).and_then(|s| {
        std::fs::write(&f, s).map_err(|e| e.to_string())
    }) {
        Ok(_) => Json(json!({ "ok": true, "file": f.to_string_lossy() })),
        Err(e) => Json(json!({ "ok": false, "error": e })),
    }
}

async fn wipe() -> Json<Value> {
    let _ = std::fs::remove_file(file());
    Json(json!({ "ok": true }))
}
