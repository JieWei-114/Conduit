use std::collections::HashMap;

use axum::{
    body::Body,
    extract::Query,
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use base64::Engine;
use serde::Deserialize;

pub fn routes() -> Router {
    Router::new().route("/proxy", get(proxy))
}

#[derive(Deserialize)]
struct ProxyQuery {
    target: Option<String>,
    headers: Option<String>,
}

async fn proxy(Query(q): Query<ProxyQuery>) -> Response {
    let target = q.target.unwrap_or_default();
    let low = target.to_lowercase();
    if !(low.starts_with("http://") || low.starts_with("https://")) {
        return (StatusCode::BAD_REQUEST, "target must be http(s)://").into_response();
    }

    let mut headers: HashMap<String, String> = HashMap::new();
    if let Some(hb) = q.headers {
        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(hb.as_bytes()) {
            if let Ok(map) = serde_json::from_slice::<HashMap<String, String>>(&bytes) {
                headers = map;
            }
        }
    }

    let client = reqwest::Client::new();
    let mut rb = client.get(&target).header("accept", "text/event-stream");
    for (k, v) in headers {
        rb = rb.header(k, v);
    }

    let upstream = match rb.send().await {
        Ok(r) => r,
        Err(e) => {
            return (StatusCode::BAD_GATEWAY, format!("upstream connect failed: {e}"))
                .into_response()
        }
    };

    let status = upstream.status();
    let body = Body::from_stream(upstream.bytes_stream());
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::CONNECTION, "keep-alive")
        .body(body)
        .unwrap()
}
