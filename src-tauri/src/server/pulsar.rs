// Cargo deps: pulsar = { version = "6", default-features = false, features = ["tokio-runtime"] }  (tokio-runtime pulls in native-tls + tokio-native-tls, so pulsar+ssl:// works with system certs)
use std::collections::HashMap;
use std::convert::Infallible;
use std::time::Duration;

use axum::{
    extract::Query,
    response::sse::{Event, Sse},
    routing::{get, post},
    Json, Router,
};
use base64::Engine;
use futures_util::stream::{Stream, StreamExt};
use pulsar::{
    consumer::InitialPosition, producer, Authentication, Pulsar, SubType, TokioExecutor,
};
use serde::Deserialize;
use serde_json::{json, Value};

const TIMEOUT: Duration = Duration::from_secs(10);

pub fn routes() -> Router {
    Router::new()
        .route("/tenants", post(tenants))
        .route("/namespaces", post(namespaces))
        .route("/topics", post(topics))
        .route("/subs", post(subs))
        .route("/sub-skip", post(sub_skip))
        .route("/sub-delete", post(sub_delete))
        .route("/peek", post(peek))
        .route("/stats", post(stats))
        .route("/produce", post(produce))
        .route("/consume", get(consume))
}

fn base_of(admin_url: &str) -> String {
    admin_url.trim().trim_end_matches('/').to_string()
}

fn topic_path(topic: &str) -> String {
    let t = topic.trim();
    if let Some(rest) = t.strip_prefix("persistent://") {
        format!("persistent/{rest}")
    } else if let Some(rest) = t.strip_prefix("non-persistent://") {
        format!("non-persistent/{rest}")
    } else {
        format!("persistent/public/default/{t}")
    }
}

async fn admin_get(admin_url: &str, path: &str, token: &Option<String>) -> Result<Value, String> {
    let url = format!("{}{}", base_of(admin_url), path);
    let mut req = reqwest::Client::new().get(&url).timeout(TIMEOUT);
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let snip: String = body.chars().take(300).collect();
        return Err(format!("HTTP {}: {}", status.as_u16(), snip));
    }
    serde_json::from_str(&body).map_err(|e| e.to_string())
}

async fn admin_mutate(
    admin_url: &str,
    path: &str,
    method: reqwest::Method,
    token: &Option<String>,
) -> Result<(), String> {
    let url = format!("{}{}", base_of(admin_url), path);
    let mut req = reqwest::Client::new().request(method, &url).timeout(TIMEOUT);
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        let snip: String = body.chars().take(300).collect();
        return Err(format!("HTTP {}: {}", status.as_u16(), snip));
    }
    Ok(())
}

#[derive(Deserialize)]
struct TenantsReq {
    #[serde(rename = "adminUrl")]
    admin_url: String,
    token: Option<String>,
}

async fn tenants(Json(b): Json<TenantsReq>) -> Json<Value> {
    match admin_get(&b.admin_url, "/admin/v2/tenants", &b.token).await {
        Ok(v) => {
            let mut list: Vec<String> = v
                .as_array()
                .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                .unwrap_or_default();
            list.sort();
            Json(json!({ "ok": true, "tenants": list }))
        }
        Err(e) => Json(json!({ "ok": false, "error": e })),
    }
}

#[derive(Deserialize)]
struct NamespacesReq {
    #[serde(rename = "adminUrl")]
    admin_url: String,
    token: Option<String>,
    tenant: Option<String>,
}

async fn namespaces(Json(b): Json<NamespacesReq>) -> Json<Value> {
    let tenant = b.tenant.unwrap_or_else(|| "public".into());
    match admin_get(&b.admin_url, &format!("/admin/v2/namespaces/{tenant}"), &b.token).await {
        Ok(v) => {
            let mut list: Vec<String> = v
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str())
                        .map(|s| s.rsplit('/').next().unwrap_or(s).to_string())
                        .collect()
                })
                .unwrap_or_default();
            list.sort();
            Json(json!({ "ok": true, "namespaces": list }))
        }
        Err(e) => Json(json!({ "ok": false, "error": e })),
    }
}

#[derive(Deserialize)]
struct TopicsReq {
    #[serde(rename = "adminUrl")]
    admin_url: Option<String>,
    token: Option<String>,
    tenant: Option<String>,
    namespace: Option<String>,
}

async fn topics(Json(b): Json<TopicsReq>) -> Json<Value> {
    let admin_url = b.admin_url.unwrap_or_default();
    if admin_url.trim().is_empty() {
        return Json(json!({ "ok": false, "error": "missing admin URL (usually http://host:8080)" }));
    }
    let tenant = b.tenant.unwrap_or_else(|| "public".into());
    let namespace = b.namespace.unwrap_or_else(|| "default".into());
    match admin_get(&admin_url, &format!("/admin/v2/persistent/{tenant}/{namespace}"), &b.token).await {
        Ok(v) => {
            let mut list: Vec<String> = v
                .as_array()
                .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                .unwrap_or_default();
            list.sort();
            Json(json!({ "ok": true, "topics": list }))
        }
        Err(e) => Json(json!({ "ok": false, "error": e })),
    }
}

#[derive(Deserialize)]
struct SubsReq {
    #[serde(rename = "adminUrl")]
    admin_url: String,
    token: Option<String>,
    topic: String,
}

async fn subs(Json(b): Json<SubsReq>) -> Json<Value> {
    let path = format!("/admin/v2/{}/stats", topic_path(&b.topic));
    match admin_get(&b.admin_url, &path, &b.token).await {
        Ok(stats) => {
            let mut out: Vec<Value> = Vec::new();
            if let Some(map) = stats.get("subscriptions").and_then(|s| s.as_object()) {
                for (name, s) in map {
                    let backlog = s.get("msgBacklog").and_then(|x| x.as_i64()).unwrap_or(0);
                    let consumers = s.get("consumers").and_then(|x| x.as_array()).map(|a| a.len()).unwrap_or(0);
                    let rate = s.get("msgRateOut").and_then(|x| x.as_f64()).unwrap_or(0.0);
                    let rate = (rate * 10.0).round() / 10.0;
                    out.push(json!({
                        "name": name,
                        "type": s.get("type").and_then(|x| x.as_str()).unwrap_or(""),
                        "backlog": backlog,
                        "consumers": consumers,
                        "msgRateOut": rate,
                        "lastConsumedTimestamp": s.get("lastConsumedTimestamp").and_then(|x| x.as_i64()).unwrap_or(0),
                    }));
                }
            }
            Json(json!({ "ok": true, "subs": out }))
        }
        Err(e) => Json(json!({ "ok": false, "error": e })),
    }
}

#[derive(Deserialize)]
struct SubActionReq {
    #[serde(rename = "adminUrl")]
    admin_url: String,
    token: Option<String>,
    topic: String,
    sub: String,
}

async fn sub_skip(Json(b): Json<SubActionReq>) -> Json<Value> {
    let path = format!(
        "/admin/v2/{}/subscription/{}/skip_all",
        topic_path(&b.topic),
        urlencode(&b.sub)
    );
    match admin_mutate(&b.admin_url, &path, reqwest::Method::POST, &b.token).await {
        Ok(()) => Json(json!({ "ok": true })),
        Err(e) => Json(json!({ "ok": false, "error": e })),
    }
}

async fn sub_delete(Json(b): Json<SubActionReq>) -> Json<Value> {
    let path = format!(
        "/admin/v2/{}/subscription/{}",
        topic_path(&b.topic),
        urlencode(&b.sub)
    );
    match admin_mutate(&b.admin_url, &path, reqwest::Method::DELETE, &b.token).await {
        Ok(()) => Json(json!({ "ok": true })),
        Err(e) => Json(json!({ "ok": false, "error": e })),
    }
}

fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for byte in s.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[derive(Deserialize)]
struct PeekReq {
    #[serde(rename = "adminUrl")]
    admin_url: String,
    token: Option<String>,
    topic: String,
    position: Option<String>,
    count: Option<Value>,
}

async fn peek(Json(b): Json<PeekReq>) -> Json<Value> {
    let position = b.position.unwrap_or_else(|| "latest".into());
    let count = b
        .count
        .as_ref()
        .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
        .unwrap_or(5);
    let n = count.clamp(1, 20);
    let base = base_of(&b.admin_url);
    let mut messages: Vec<Value> = Vec::new();
    let client = reqwest::Client::new();
    for i in 1..=n {
        let url = format!(
            "{}/admin/v2/{}/examinemessage?initialPosition={}&messagePosition={}",
            base,
            topic_path(&b.topic),
            position,
            i
        );
        let mut req = client.get(&url).timeout(TIMEOUT);
        if let Some(t) = &b.token {
            req = req.bearer_auth(t);
        }
        let resp = match req.send().await {
            Ok(r) => r,
            Err(e) => {
                if !messages.is_empty() {
                    break;
                }
                return Json(json!({ "ok": false, "error": e.to_string() }));
            }
        };
        if !resp.status().is_success() {
            if !messages.is_empty() {
                break;
            }
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            let snip: String = body.chars().take(300).collect();
            return Json(json!({ "ok": false, "error": format!("HTTP {}: {}", status, snip) }));
        }
        let publish_time = resp
            .headers()
            .get("x-pulsar-publish-time")
            .and_then(|v| v.to_str().ok())
            .map(String::from);
        let message_id = resp
            .headers()
            .get("x-pulsar-message-id")
            .and_then(|v| v.to_str().ok())
            .map(String::from);
        let bytes = match resp.bytes().await {
            Ok(b) => b,
            Err(e) => {
                if !messages.is_empty() {
                    break;
                }
                return Json(json!({ "ok": false, "error": e.to_string() }));
            }
        };
        messages.push(json!({
            "pos": i,
            "payload": String::from_utf8_lossy(&bytes).to_string(),
            "publishTime": publish_time,
            "messageId": message_id,
        }));
    }
    Json(json!({ "ok": true, "messages": messages }))
}

#[derive(Deserialize)]
struct StatsReq {
    #[serde(rename = "adminUrl")]
    admin_url: Option<String>,
    token: Option<String>,
    topic: Option<String>,
}

async fn stats(Json(b): Json<StatsReq>) -> Json<Value> {
    let admin_url = b.admin_url.unwrap_or_default();
    let topic = b.topic.unwrap_or_default();
    if admin_url.trim().is_empty() || topic.trim().is_empty() {
        return Json(json!({ "ok": false, "error": "missing admin URL or topic" }));
    }
    let path = format!("/admin/v2/{}/stats", topic_path(&topic));
    match admin_get(&admin_url, &path, &b.token).await {
        Ok(stats) => Json(json!({ "ok": true, "stats": stats })),
        Err(e) => Json(json!({ "ok": false, "error": e })),
    }
}

#[derive(Deserialize, Clone)]
struct OAuthCfg {
    #[serde(rename = "issuerUrl")]
    issuer_url: String,
    #[serde(rename = "clientId")]
    client_id: String,
    #[serde(rename = "clientSecret")]
    client_secret: String,
    audience: String,
}

#[derive(Deserialize, Clone)]
struct ConnConfig {
    #[serde(rename = "serviceUrl")]
    service_url: String,
    #[serde(rename = "authType")]
    auth_type: String,
    token: Option<String>,
    oauth: Option<OAuthCfg>,
}

async fn build_client(conn: &ConnConfig) -> Result<Pulsar<TokioExecutor>, String> {
    let mut builder = Pulsar::builder(conn.service_url.clone(), TokioExecutor);
    match conn.auth_type.as_str() {
        "token" => {
            if let Some(t) = conn.token.clone().filter(|s| !s.is_empty()) {
                builder = builder.with_auth(Authentication {
                    name: "token".to_string(),
                    data: t.into_bytes(),
                });
            }
        }
        "oauth2" => {
            if let Some(o) = conn.oauth.clone() {
                use pulsar::authentication::oauth2::{OAuth2Authentication, OAuth2Params};
                let creds = serde_json::json!({
                    "type": "client_credentials",
                    "issuer_url": o.issuer_url,
                    "client_id": o.client_id,
                    "client_secret": o.client_secret,
                });
                let path = std::env::temp_dir().join(format!(
                    "conduit-pulsar-oauth-{}-{}.json",
                    std::process::id(),
                    OAUTH_SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                ));
                std::fs::write(&path, creds.to_string()).map_err(|e| e.to_string())?;
                builder = builder.with_auth_provider(OAuth2Authentication::client_credentials(
                    OAuth2Params {
                        issuer_url: o.issuer_url,
                        credentials_url: format!("file://{}", path.display()),
                        audience: Some(o.audience),
                        scope: None,
                    },
                ));
            }
        }
        _ => {}
    }
    builder.build().await.map_err(|e| e.to_string())
}

static OAUTH_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[derive(Deserialize)]
struct ProduceReq {
    conn: ConnConfig,
    topic: String,
    payload: String,
    properties: Option<HashMap<String, String>>,
    key: Option<String>,
    #[serde(rename = "deliverAfterMs")]
    deliver_after_ms: Option<i64>,
}

async fn produce(Json(b): Json<ProduceReq>) -> Json<Value> {
    let client = match build_client(&b.conn).await {
        Ok(c) => c,
        Err(e) => return Json(json!({ "ok": false, "error": e })),
    };
    let mut producer = match client.producer().with_topic(&b.topic).build().await {
        Ok(p) => p,
        Err(e) => return Json(json!({ "ok": false, "error": e.to_string() })),
    };
    let deliver_at_time = match b.deliver_after_ms {
        Some(ms) if ms > 0 => {
            let now = chrono::Utc::now().timestamp_millis();
            Some(now + ms)
        }
        _ => None,
    };
    let msg = producer::Message {
        payload: b.payload.into_bytes(),
        properties: b.properties.unwrap_or_default(),
        partition_key: b.key.filter(|s| !s.trim().is_empty()).map(|s| s.trim().to_string()),
        deliver_at_time,
        ..Default::default()
    };
    let result = async {
        let fut = producer.send_non_blocking(msg).await.map_err(|e| e.to_string())?;
        fut.await.map_err(|e| e.to_string())
    }
    .await;
    let _ = producer.close().await;
    match result {
        Ok(receipt) => Json(json!({
            "ok": true,
            "messageId": receipt.message_id.map(|m| format!("{}:{}", m.ledger_id, m.entry_id)).unwrap_or_default(),
        })),
        Err(e) => Json(json!({ "ok": false, "error": e })),
    }
}

#[derive(Deserialize)]
struct ConsumeQuery {
    conn: Option<String>,
    topic: Option<String>,
    subscription: Option<String>,
    #[serde(rename = "type")]
    sub_type: Option<String>,
    position: Option<String>,
    filter: Option<String>,
}

fn map_sub_type(s: &str) -> SubType {
    match s {
        "Exclusive" => SubType::Exclusive,
        "Failover" => SubType::Failover,
        "KeyShared" | "Key_Shared" => SubType::KeyShared,
        _ => SubType::Shared,
    }
}

async fn consume(
    Query(q): Query<ConsumeQuery>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let stream = async_stream::stream! {
        let raw = q.conn.unwrap_or_default();
        let decoded = match base64::engine::general_purpose::STANDARD.decode(raw.as_bytes()) {
            Ok(d) => d,
            Err(_) => {
                yield Ok(Event::default().event("error").data("bad conn payload"));
                return;
            }
        };
        let conn: ConnConfig = match serde_json::from_slice(&decoded) {
            Ok(c) => c,
            Err(_) => {
                yield Ok(Event::default().event("error").data("bad conn payload"));
                return;
            }
        };
        let topic = q.topic.unwrap_or_default();
        let subscription = q
            .subscription
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("conduit-{}", chrono::Utc::now().timestamp_millis()));
        let sub_type = map_sub_type(&q.sub_type.unwrap_or_else(|| "Exclusive".into()));
        let position = if q.position.as_deref() == Some("earliest") {
            InitialPosition::Earliest
        } else {
            InitialPosition::Latest
        };
        let filter = q.filter.unwrap_or_default();

        let client = match build_client(&conn).await {
            Ok(c) => c,
            Err(e) => {
                yield Ok(Event::default().event("error").data(e));
                return;
            }
        };

        let mut consumer: pulsar::Consumer<Vec<u8>, _> = match client
            .consumer()
            .with_topic(&topic)
            .with_subscription(&subscription)
            .with_subscription_type(sub_type)
            .with_options(pulsar::ConsumerOptions::default().with_initial_position(position))
            .build()
            .await
        {
            Ok(c) => c,
            Err(e) => {
                yield Ok(Event::default().event("error").data(e.to_string()));
                return;
            }
        };

        yield Ok(Event::default().event("ready").data(format!("{topic} · {subscription}")));

        loop {
            match consumer.next().await {
                Some(Ok(msg)) => {
                    let payload = String::from_utf8_lossy(&msg.payload.data).to_string();
                    let mut props: HashMap<String, String> = HashMap::new();
                    for kv in &msg.payload.metadata.properties {
                        props.insert(kv.key.clone(), kv.value.clone());
                    }
                    let publish_time = msg.payload.metadata.publish_time;
                    let message_id = format!(
                        "{}:{}",
                        msg.message_id().ledger_id,
                        msg.message_id().entry_id
                    );
                    let props_str = serde_json::to_string(&props).unwrap_or_default();
                    if filter.is_empty() || payload.contains(&filter) || props_str.contains(&filter) {
                        let data = json!({
                            "at": chrono::Utc::now().to_rfc3339(),
                            "messageId": message_id,
                            "publishTime": publish_time,
                            "properties": props,
                            "payload": payload,
                        });
                        yield Ok(Event::default().event("message").data(data.to_string()));
                    }
                    let _ = consumer.ack(&msg).await;
                }
                Some(Err(e)) => {
                    yield Ok(Event::default().event("error").data(e.to_string()));
                    break;
                }
                None => break,
            }
        }
    };
    Sse::new(stream)
}
