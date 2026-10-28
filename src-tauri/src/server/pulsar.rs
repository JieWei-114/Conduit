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
use pulsar::{consumer::InitialPosition, producer, Authentication, Pulsar, SubType, TokioExecutor};
use serde::Deserialize;
use serde_json::{json, Value};

use super::attempt::{chain, describe, redact_url, Attempt, Reply};
use super::kafka::bytes_view;

const TIMEOUT: Duration = Duration::from_secs(10);
/// How long a produce may take end to end (connect, create the producer, send, receipt).
const PRODUCE_TIMEOUT: Duration = Duration::from_secs(20);
/// How long connecting to the broker, and creating a consumer, may each take: past it the panel
/// says why instead of sitting on "Connecting…".
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

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

/// A topic as the admin API's path names it (`persistent/tenant/ns/name`), each segment
/// URL-encoded. A bare name lives in `public/default`.
fn topic_path(topic: &str) -> String {
    let t = topic.trim();
    let (domain, rest) = if let Some(rest) = t.strip_prefix("persistent://") {
        ("persistent", rest.to_string())
    } else if let Some(rest) = t.strip_prefix("non-persistent://") {
        ("non-persistent", rest.to_string())
    } else {
        ("persistent", format!("public/default/{t}"))
    };
    let segments: Vec<String> = rest.split('/').map(urlencode).collect();
    format!("{domain}/{}", segments.join("/"))
}

/// A request refused before anything was sent (a missing field), in the failure shape.
fn not_sent(message: &str) -> Value {
    failure(
        plain_error("request", "request", message, vec![]),
        Value::Null,
        0,
    )
}

/// The refusal for a call that needs a topic and got none.
fn need_topic(topic: &str) -> Option<Value> {
    topic
        .trim()
        .is_empty()
        .then(|| not_sent("Enter a topic first."))
}

/// The failure shape every panel reads: `{ ok:false, stage, error, detail, durationMs, log }`.
fn failure(error: Value, log: Value, duration_ms: u128) -> Value {
    json!({
        "ok": false,
        "stage": error["stage"],
        "error": error["message"],
        "detail": error,
        "durationMs": duration_ms,
        "log": log,
    })
}

/// A failure that is not a transport error (an HTTP status, a body that is not JSON): no probe.
fn plain_error(stage: &str, kind: &str, message: &str, hints: Vec<String>) -> Value {
    json!({
        "stage": stage,
        "kind": kind,
        "message": message,
        "chain": [message],
        "hints": hints,
        "probe": Value::Null,
    })
}

/// What an admin API status code usually means.
fn http_hints(status: u16) -> Vec<String> {
    match status {
        401 => vec!["The admin API did not accept the credentials: the Token field is sent as a bearer token. Check it is set and not expired.".into()],
        403 => vec!["The credentials were accepted but this role may not do that here: it lacks admin permission on the tenant, namespace or topic.".into()],
        404 => vec!["Not found: check the tenant, namespace or topic name, and that the Admin URL points at the admin (HTTP) port, usually 8080.".into()],
        _ => vec![],
    }
}

fn snip(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// The request headers as the log shows them: the bearer token is never written down.
fn logged_headers(token: &Option<String>) -> HashMap<String, String> {
    let mut h = HashMap::new();
    if token.as_deref().is_some_and(|t| !t.is_empty()) {
        h.insert("authorization".to_string(), "Bearer •••".to_string());
    }
    h
}

/// A 2xx answer from the admin API: its body, its headers and the record of the call.
struct AdminReply {
    body: Vec<u8>,
    headers: HashMap<String, String>,
    log: Value,
}

/// One admin API call. A transport error, a non-2xx status or a cut-off body comes back as the
/// failure shape, with the record of the call.
async fn admin_call(
    client: &reqwest::Client,
    admin_url: &str,
    path: &str,
    method: reqwest::Method,
    token: &Option<String>,
) -> Result<AdminReply, Value> {
    // every admin route comes through here, so this one check covers them all
    if admin_url.trim().is_empty() {
        return Err(not_sent(
            "Set the Admin URL first (usually http://host:8080).",
        ));
    }
    let url = format!("{}{}", base_of(admin_url), path);
    let attempt = Attempt::start(
        method.as_str(),
        &redact_url(&url),
        logged_headers(token),
        Value::Null,
        0,
    );
    let timeout_ms = TIMEOUT.as_millis() as u64;
    let mut req = client.request(method, &url).timeout(TIMEOUT);
    if let Some(t) = token.as_deref().filter(|t| !t.is_empty()) {
        req = req.bearer_auth(t);
    }
    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            let timed_out = e.is_timeout();
            let stage = if timed_out { "timeout" } else { "network" };
            let (error, log) = attempt
                .failed(stage, &e.without_url(), timed_out, timeout_ms)
                .await;
            return Err(failure(error, log, attempt.elapsed_ms()));
        }
    };
    let status = resp.status().as_u16();
    let headers: HashMap<String, String> = resp
        .headers()
        .iter()
        .filter_map(|(k, v)| Some((k.as_str().to_string(), v.to_str().ok()?.to_string())))
        .collect();
    let body = match resp.bytes().await {
        Ok(b) => b.to_vec(),
        Err(e) => {
            let timed_out = e.is_timeout();
            let (error, log) = attempt
                .failed("body", &e.without_url(), timed_out, timeout_ms)
                .await;
            return Err(failure(error, log, attempt.elapsed_ms()));
        }
    };
    let text = String::from_utf8_lossy(&body);
    let shown =
        serde_json::from_slice::<Value>(&body).unwrap_or_else(|_| Value::String(snip(&text, 4000)));
    let log = attempt.succeeded(Reply {
        status,
        headers: &headers,
        trailers: None,
        body: shown,
        bytes: body.len(),
    });
    if !(200..300).contains(&status) {
        let message = format!("HTTP {status}: {}", snip(&text, 300));
        let error = plain_error("http", "http", &message, http_hints(status));
        return Err(failure(error, log, attempt.elapsed_ms()));
    }
    Ok(AdminReply { body, headers, log })
}

/// A GET whose answer is JSON: `(json, log)`.
async fn admin_get(
    admin_url: &str,
    path: &str,
    token: &Option<String>,
) -> Result<(Value, Value), Value> {
    let client = reqwest::Client::new();
    let r = admin_call(&client, admin_url, path, reqwest::Method::GET, token).await?;
    match serde_json::from_slice::<Value>(&r.body) {
        Ok(v) => Ok((v, r.log)),
        Err(e) => {
            let message = format!(
                "the admin API answered, but not with JSON: {}",
                describe(&e)
            );
            let dur = r.log["durationMs"].as_u64().unwrap_or(0) as u128;
            Err(failure(
                plain_error("decode", "body", &message, vec!["Check that the Admin URL points at the Pulsar admin API (usually http://host:8080), not at a web page.".into()]),
                r.log,
                dur,
            ))
        }
    }
}

/// A sorted list of the strings in `v`, each passed through `f`.
fn string_list(v: &Value, f: impl Fn(&str) -> String) -> Vec<String> {
    let mut list: Vec<String> = v
        .as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str()).map(&f).collect())
        .unwrap_or_default();
    list.sort();
    list
}

#[derive(Deserialize)]
struct TenantsReq {
    #[serde(rename = "adminUrl", default)]
    admin_url: String,
    token: Option<String>,
}

async fn tenants(Json(b): Json<TenantsReq>) -> Json<Value> {
    match admin_get(&b.admin_url, "/admin/v2/tenants", &b.token).await {
        Ok((v, log)) => {
            Json(json!({ "ok": true, "tenants": string_list(&v, |s| s.to_string()), "log": log }))
        }
        Err(f) => Json(f),
    }
}

#[derive(Deserialize)]
struct NamespacesReq {
    #[serde(rename = "adminUrl", default)]
    admin_url: String,
    token: Option<String>,
    tenant: Option<String>,
}

async fn namespaces(Json(b): Json<NamespacesReq>) -> Json<Value> {
    let tenant = b.tenant.unwrap_or_else(|| "public".into());
    match admin_get(
        &b.admin_url,
        &format!("/admin/v2/namespaces/{}", urlencode(&tenant)),
        &b.token,
    )
    .await
    {
        Ok((v, log)) => {
            let list = string_list(&v, |s| s.rsplit('/').next().unwrap_or(s).to_string());
            Json(json!({ "ok": true, "namespaces": list, "log": log }))
        }
        Err(f) => Json(f),
    }
}

#[derive(Deserialize)]
struct TopicsReq {
    #[serde(rename = "adminUrl", default)]
    admin_url: String,
    token: Option<String>,
    tenant: Option<String>,
    namespace: Option<String>,
}

async fn topics(Json(b): Json<TopicsReq>) -> Json<Value> {
    let tenant = b.tenant.unwrap_or_else(|| "public".into());
    let namespace = b.namespace.unwrap_or_else(|| "default".into());
    let path = format!(
        "/admin/v2/persistent/{}/{}",
        urlencode(&tenant),
        urlencode(&namespace)
    );
    match admin_get(&b.admin_url, &path, &b.token).await {
        Ok((v, log)) => {
            Json(json!({ "ok": true, "topics": string_list(&v, |s| s.to_string()), "log": log }))
        }
        Err(f) => Json(f),
    }
}

#[derive(Deserialize)]
struct SubsReq {
    #[serde(rename = "adminUrl", default)]
    admin_url: String,
    token: Option<String>,
    #[serde(default)]
    topic: String,
}

async fn subs(Json(b): Json<SubsReq>) -> Json<Value> {
    if let Some(f) = need_topic(&b.topic) {
        return Json(f);
    }
    let path = format!("/admin/v2/{}/stats", topic_path(&b.topic));
    let (stats, log) = match admin_get(&b.admin_url, &path, &b.token).await {
        Ok(x) => x,
        Err(f) => return Json(f),
    };
    let mut out: Vec<Value> = Vec::new();
    if let Some(map) = stats.get("subscriptions").and_then(|s| s.as_object()) {
        for (name, s) in map {
            let backlog = s.get("msgBacklog").and_then(|x| x.as_i64()).unwrap_or(0);
            let consumers = s
                .get("consumers")
                .and_then(|x| x.as_array())
                .map(|a| a.len())
                .unwrap_or(0);
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
    Json(json!({ "ok": true, "subs": out, "log": log }))
}

#[derive(Deserialize)]
struct SubActionReq {
    #[serde(rename = "adminUrl", default)]
    admin_url: String,
    token: Option<String>,
    #[serde(default)]
    topic: String,
    #[serde(default)]
    sub: String,
}

async fn sub_mutate(b: SubActionReq, path: String, method: reqwest::Method) -> Json<Value> {
    if let Some(f) = need_topic(&b.topic) {
        return Json(f);
    }
    if b.sub.trim().is_empty() {
        return Json(not_sent("Name the subscription first."));
    }
    let client = reqwest::Client::new();
    match admin_call(&client, &b.admin_url, &path, method, &b.token).await {
        Ok(r) => Json(json!({ "ok": true, "log": r.log })),
        Err(f) => Json(f),
    }
}

async fn sub_skip(Json(b): Json<SubActionReq>) -> Json<Value> {
    let path = format!(
        "/admin/v2/{}/subscription/{}/skip_all",
        topic_path(&b.topic),
        urlencode(&b.sub)
    );
    sub_mutate(b, path, reqwest::Method::POST).await
}

async fn sub_delete(Json(b): Json<SubActionReq>) -> Json<Value> {
    let path = format!(
        "/admin/v2/{}/subscription/{}",
        topic_path(&b.topic),
        urlencode(&b.sub)
    );
    sub_mutate(b, path, reqwest::Method::DELETE).await
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
    #[serde(rename = "adminUrl", default)]
    admin_url: String,
    token: Option<String>,
    #[serde(default)]
    topic: String,
    position: Option<String>,
    count: Option<Value>,
}

/// One message as the admin API's examinemessage hands it back: the payload in the body, the
/// rest in `X-Pulsar-*` headers (names arrive lower-cased).
fn peek_message(pos: i64, headers: &HashMap<String, String>, body: &[u8]) -> Value {
    let h = |k: &str| headers.get(k).cloned();
    let mut props = serde_json::Map::new();
    if let Some(Value::Object(m)) =
        h("x-pulsar-properties").and_then(|s| serde_json::from_str(&s).ok())
    {
        props = m;
    }
    for (k, v) in headers {
        if let Some(name) = k.strip_prefix("x-pulsar-property-") {
            props.insert(name.to_string(), Value::String(v.clone()));
        }
    }
    let payload = bytes_view(Some(body));
    json!({
        "pos": pos,
        "payload": payload["text"],
        "payloadEncoding": payload["encoding"],
        "payloadNote": payload.get("note"),
        "messageId": h("x-pulsar-message-id"),
        "publishTime": h("x-pulsar-publish-time"),
        "eventTime": h("x-pulsar-event-time"),
        "key": h("x-pulsar-partition-key"),
        "batchSize": h("x-pulsar-num-batch-message").or_else(|| h("x-pulsar-batch-size")),
        "properties": props,
    })
}

/// Whether `m` was already read: past the last message examinemessage keeps answering with the
/// last one, so a repeated id is the end of the topic.
fn repeats(read: &[Value], m: &Value) -> bool {
    m["messageId"]
        .as_str()
        .is_some_and(|id| read.iter().any(|r| r["messageId"].as_str() == Some(id)))
}

/// Why a peek ended before `wanted` messages, once `got` were read.
fn stopped_early(got: usize, wanted: i64, failed_pos: i64, error: &str) -> String {
    format!("Stopped after {got} of {wanted}: message #{failed_pos} could not be read ({error}). Past the end of the retained messages this is expected.")
}

async fn peek(Json(b): Json<PeekReq>) -> Json<Value> {
    if let Some(f) = need_topic(&b.topic) {
        return Json(f);
    }
    let position = b.position.unwrap_or_else(|| "latest".into());
    let count = b
        .count
        .as_ref()
        .and_then(|v| {
            v.as_i64()
                .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        })
        .unwrap_or(5);
    let n = count.clamp(1, 20);
    let client = reqwest::Client::new();
    let mut messages: Vec<Value> = Vec::new();
    let mut warning: Option<String> = None;
    let mut log = Value::Null;
    for i in 1..=n {
        let path = format!(
            "/admin/v2/{}/examinemessage?initialPosition={}&messagePosition={}",
            topic_path(&b.topic),
            urlencode(&position),
            i
        );
        match admin_call(&client, &b.admin_url, &path, reqwest::Method::GET, &b.token).await {
            Ok(r) => {
                let m = peek_message(i, &r.headers, &r.body);
                if repeats(&messages, &m) {
                    break;
                }
                messages.push(m);
                log = r.log;
            }
            Err(f) => {
                if messages.is_empty() {
                    return Json(f);
                }
                warning = Some(stopped_early(
                    messages.len(),
                    n,
                    i,
                    f["error"].as_str().unwrap_or(""),
                ));
                log = f["log"].clone();
                break;
            }
        }
    }
    Json(json!({ "ok": true, "messages": messages, "warning": warning, "log": log }))
}

#[derive(Deserialize)]
struct StatsReq {
    #[serde(rename = "adminUrl", default)]
    admin_url: String,
    token: Option<String>,
    #[serde(default)]
    topic: String,
}

async fn stats(Json(b): Json<StatsReq>) -> Json<Value> {
    if let Some(f) = need_topic(&b.topic) {
        return Json(f);
    }
    let path = format!("/admin/v2/{}/stats", topic_path(&b.topic));
    match admin_get(&b.admin_url, &path, &b.token).await {
        Ok((stats, log)) => Json(json!({ "ok": true, "stats": stats, "log": log })),
        Err(f) => Json(f),
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

/// The OAuth2 client-credentials document as a `data:` URL, so the secret never touches the disk.
fn oauth_credentials_url(client_id: &str, client_secret: &str, issuer_url: &str) -> String {
    let creds = json!({
        "type": "client_credentials",
        "issuer_url": issuer_url,
        "client_id": client_id,
        "client_secret": client_secret,
    });
    format!(
        "data:application/json;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(creds.to_string())
    )
}

/// A connected client, or where it stopped (`connect` or `timeout`) and the cause chain of why.
async fn build_client(
    conn: &ConnConfig,
) -> Result<Pulsar<TokioExecutor>, (&'static str, Vec<String>)> {
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
                let credentials_url =
                    oauth_credentials_url(&o.client_id, &o.client_secret, &o.issuer_url);
                builder = builder.with_auth_provider(OAuth2Authentication::client_credentials(
                    OAuth2Params {
                        issuer_url: o.issuer_url,
                        credentials_url,
                        audience: Some(o.audience),
                        scope: None,
                    },
                ));
            }
        }
        _ => {}
    }
    match tokio::time::timeout(CONNECT_TIMEOUT, builder.build()).await {
        Ok(Ok(client)) => Ok(client),
        Ok(Err(e)) => Err(("connect", chain(&e))),
        Err(_) => Err(("timeout", vec![connect_timed_out("the broker")])),
    }
}

/// Why a connect step gave up: nothing answered within [`CONNECT_TIMEOUT`].
fn connect_timed_out(what: &str) -> String {
    format!(
        "no answer from {what} within {} s",
        CONNECT_TIMEOUT.as_secs()
    )
}

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

/// A message id in every form a person may need: the parts, and the `ledger:entry:partition`
/// (`:batchIndex` for a message inside a batch) string other Pulsar tools print and accept.
fn message_id_json(ledger: u64, entry: u64, partition: Option<i32>, batch: Option<i32>) -> Value {
    let p = partition.unwrap_or(-1);
    let batch = batch.filter(|b| *b >= 0);
    let id = match batch {
        Some(b) => format!("{ledger}:{entry}:{p}:{b}"),
        None => format!("{ledger}:{entry}:{p}"),
    };
    json!({ "id": id, "ledgerId": ledger, "entryId": entry, "partition": p, "batchIndex": batch })
}

/// Connect, create a producer, send `msg` and wait for the receipt: the message id, or where it
/// stopped and why.
async fn send_one(
    conn: &ConnConfig,
    topic: &str,
    msg: producer::Message,
) -> Result<Value, (&'static str, Vec<String>)> {
    let client = build_client(conn).await?;
    let mut producer = client
        .producer()
        .with_topic(topic)
        .build()
        .await
        .map_err(|e| ("producer", chain(&e)))?;
    let result = async {
        let fut = producer
            .send_non_blocking(msg)
            .await
            .map_err(|e| chain(&e))?;
        fut.await.map_err(|e| chain(&e))
    }
    .await;
    let _ = producer.close().await;
    let receipt = result.map_err(|c| ("send", c))?;
    Ok(match receipt.message_id {
        Some(m) => message_id_json(m.ledger_id, m.entry_id, m.partition, m.batch_index),
        None => Value::Null,
    })
}

async fn produce(Json(b): Json<ProduceReq>) -> Json<Value> {
    // the key goes out exactly as typed; only an empty one means "no key"
    let key = b.key.filter(|s| !s.is_empty());
    let properties = b.properties.unwrap_or_default();
    let deliver_at_time = match b.deliver_after_ms {
        Some(ms) if ms > 0 => Some(chrono::Utc::now().timestamp_millis() + ms),
        _ => None,
    };
    let attempt = Attempt::start(
        "PRODUCE (Pulsar)",
        &redact_url(&b.conn.service_url),
        HashMap::new(),
        json!({
            "topic": b.topic,
            "auth": b.conn.auth_type,
            "key": key,
            "properties": properties,
            "deliverAtTime": deliver_at_time,
            "payload": b.payload,
        }),
        b.payload.len(),
    );
    let msg = producer::Message {
        payload: b.payload.into_bytes(),
        properties,
        partition_key: key,
        deliver_at_time,
        ..Default::default()
    };
    let timeout_ms = PRODUCE_TIMEOUT.as_millis() as u64;
    match tokio::time::timeout(PRODUCE_TIMEOUT, send_one(&b.conn, &b.topic, msg)).await {
        Ok(Ok(id)) => {
            let body = json!({ "messageId": id });
            let bytes = body.to_string().len();
            let log = attempt.succeeded(Reply {
                status: 0,
                headers: &HashMap::new(),
                trailers: None,
                body,
                bytes,
            });
            Json(json!({
                "ok": true,
                "messageId": id["id"],
                "id": id,
                "durationMs": attempt.elapsed_ms(),
                "log": log,
            }))
        }
        Ok(Err((stage, chain))) => {
            // the connect step has its own, shorter limit
            let timed_out = stage == "timeout";
            let limit = if timed_out {
                CONNECT_TIMEOUT.as_millis() as u64
            } else {
                timeout_ms
            };
            let (error, log) = attempt.failed_with(stage, chain, timed_out, limit).await;
            Json(failure(error, log, attempt.elapsed_ms()))
        }
        Err(_) => {
            let chain = vec![format!("no receipt within {timeout_ms} ms")];
            let (error, log) = attempt
                .failed_with("timeout", chain, true, timeout_ms)
                .await;
            Json(failure(error, log, attempt.elapsed_ms()))
        }
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
    /// "1" once the person agreed to join the existing subscription they named
    #[serde(rename = "confirmJoin")]
    confirm_join: Option<String>,
}

/// The subscription a consumer uses. A blank name gets a fresh `conduit-<ms>` that nobody else
/// reads. A typed name joins that subscription as it is on the broker and acks what it receives,
/// which takes those messages from its live consumers, so it is refused unless `confirmed`.
fn pick_subscription(typed: Option<&str>, confirmed: bool, now_ms: i64) -> Result<String, String> {
    match typed.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(format!("conduit-{now_ms}")),
        Some(name) if confirmed => Ok(name.to_string()),
        Some(name) => Err(format!(
            "Not connected: \"{name}\" is an existing subscription name. Joining it acks the messages it receives, so they are taken from its live consumers. Tick the confirmation, or leave the name blank for a new subscription."
        )),
    }
}

/// A generated subscription is non-durable: the broker drops it when the consumer leaves, so
/// browsing a topic leaves no `conduit-<ms>` subscription (and backlog) behind.
fn consumer_options(position: InitialPosition, generated: bool) -> pulsar::ConsumerOptions {
    let opts = pulsar::ConsumerOptions::default().with_initial_position(position);
    if generated {
        opts.durable(false)
    } else {
        opts
    }
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
        // a refusal before anything is sent: the same `{error, detail}` shape as every failure
        let refused = |message: &str| {
            let f = not_sent(message);
            json!({ "error": f["error"], "detail": f["detail"] }).to_string()
        };
        let raw = q.conn.unwrap_or_default();
        let conn: Option<ConnConfig> = base64::engine::general_purpose::STANDARD
            .decode(raw.as_bytes())
            .ok()
            .and_then(|d| serde_json::from_slice(&d).ok());
        let Some(conn) = conn else {
            yield Ok(Event::default().event("error").data(refused("The connection settings did not arrive intact (bad conn payload).")));
            return;
        };
        let topic = q.topic.unwrap_or_default();
        if topic.trim().is_empty() {
            yield Ok(Event::default().event("error").data(refused("Enter a topic first.")));
            return;
        }
        let confirmed = q.confirm_join.as_deref() == Some("1");
        let generated = q.subscription.as_deref().map(str::trim).unwrap_or("").is_empty();
        let subscription = match pick_subscription(q.subscription.as_deref(), confirmed, chrono::Utc::now().timestamp_millis()) {
            Ok(s) => s,
            Err(message) => {
                yield Ok(Event::default().event("error").data(refused(&message)));
                return;
            }
        };
        let sub_type = map_sub_type(&q.sub_type.unwrap_or_else(|| "Exclusive".into()));
        let position = if q.position.as_deref() == Some("earliest") {
            InitialPosition::Earliest
        } else {
            InitialPosition::Latest
        };
        // a failed subscription says why, as every other call does: an `error` event carrying
        // the message, the full explanation and the record
        let attempt = Attempt::start(
            "SUBSCRIBE (pulsar)",
            &redact_url(&conn.service_url),
            HashMap::new(),
            json!({ "topic": topic, "subscription": subscription }),
            0,
        );
        let failure = |(error, log): (Value, Value)| {
            json!({ "error": error["message"], "detail": error, "log": log }).to_string()
        };
        let connect_ms = CONNECT_TIMEOUT.as_millis() as u64;
        let client = match build_client(&conn).await {
            Ok(c) => c,
            Err((stage, chain)) => {
                let timed_out = stage == "timeout";
                yield Ok(Event::default().event("error").data(failure(attempt.failed_with(stage, chain, timed_out, connect_ms).await)));
                return;
            }
        };

        let built = tokio::time::timeout(
            CONNECT_TIMEOUT,
            client
                .consumer()
                .with_topic(&topic)
                .with_subscription(&subscription)
                .with_subscription_type(sub_type)
                .with_options(consumer_options(position, generated))
                .build(),
        )
        .await;
        let mut consumer: pulsar::Consumer<Vec<u8>, _> = match built {
            Ok(Ok(c)) => c,
            Ok(Err(e)) => {
                yield Ok(Event::default().event("error").data(failure(attempt.failed("subscribe", &e, false, 0).await)));
                return;
            }
            Err(_) => {
                let chain = vec![connect_timed_out("the broker to the subscribe request")];
                yield Ok(Event::default().event("error").data(failure(attempt.failed_with("timeout", chain, true, connect_ms).await)));
                return;
            }
        };

        yield Ok(Event::default().event("ready").data(format!("{topic} · {subscription}")));

        loop {
            match consumer.next().await {
                Some(Ok(msg)) => {
                    // every message is streamed and acked alike: the panel's live filter only
                    // decides what is shown, never what is acked
                    let meta = &msg.payload.metadata;
                    let mut props: HashMap<String, String> = HashMap::new();
                    for kv in &meta.properties {
                        props.insert(kv.key.clone(), kv.value.clone());
                    }
                    let mid = msg.message_id();
                    let id = message_id_json(mid.ledger_id, mid.entry_id, mid.partition, mid.batch_index);
                    let payload = bytes_view(Some(&msg.payload.data));
                    let data = json!({
                        "at": chrono::Utc::now().to_rfc3339(),
                        "topic": msg.topic,
                        "messageId": id["id"],
                        "id": id,
                        "publishTime": meta.publish_time,
                        "eventTime": meta.event_time.filter(|t| *t > 0),
                        "key": msg.key(),
                        "properties": props,
                        "payload": payload["text"],
                        "payloadEncoding": payload["encoding"],
                        "payloadNote": payload.get("note"),
                    });
                    yield Ok(Event::default().event("message").data(data.to_string()));
                    if let Err(e) = consumer.ack(&msg).await {
                        let warning = json!({
                            "at": chrono::Utc::now().to_rfc3339(),
                            "warning": format!("ack failed for {}: {} (the broker will redeliver it)", id["id"].as_str().unwrap_or(""), describe(&e)),
                        });
                        yield Ok(Event::default().event("warning").data(warning.to_string()));
                    }
                }
                Some(Err(e)) => {
                    yield Ok(Event::default().event("error").data(failure(attempt.failed("stream", &e, false, 0).await)));
                    break;
                }
                None => {
                    // the broker closed the consumer (topic deleted, subscription removed, unload)
                    yield Ok(Event::default().event("close").data("Disconnected by the broker"));
                    break;
                }
            }
        }
    };
    Sse::new(stream)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_message_id_carries_partition_and_batch_index() {
        let plain = message_id_json(12, 34, None, None);
        assert_eq!(plain["id"], "12:34:-1");
        assert_eq!(plain["batchIndex"], Value::Null);
        let batched = message_id_json(12, 34, Some(2), Some(5));
        assert_eq!(batched["id"], "12:34:2:5");
        // a batch index of -1 means "not in a batch"
        assert_eq!(message_id_json(1, 2, Some(0), Some(-1))["id"], "1:2:0");
    }

    #[test]
    fn two_messages_of_one_batch_get_different_ids() {
        let a = message_id_json(7, 8, Some(-1), Some(0));
        let b = message_id_json(7, 8, Some(-1), Some(1));
        assert_ne!(a["id"], b["id"]);
    }

    #[test]
    fn a_peeked_message_reads_its_metadata_from_the_headers() {
        let headers: HashMap<String, String> = [
            ("x-pulsar-message-id", "5:6"),
            ("x-pulsar-publish-time", "2026-10-28T01:02:03.000Z"),
            ("x-pulsar-partition-key", "order-1"),
            ("x-pulsar-property-source", "conduit"),
            ("content-type", "application/octet-stream"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        let m = peek_message(3, &headers, b"{\"a\":1}");
        assert_eq!(m["pos"], 3);
        assert_eq!(m["messageId"], "5:6");
        assert_eq!(m["key"], "order-1");
        assert_eq!(m["properties"]["source"], "conduit");
        assert_eq!(m["payload"], "{\"a\":1}");
        assert_eq!(m["eventTime"], Value::Null);
    }

    #[test]
    fn a_peek_stops_at_the_first_repeated_message() {
        let read = vec![
            json!({ "messageId": "5:6:-1" }),
            json!({ "messageId": "5:7:-1" }),
        ];
        assert!(repeats(&read, &json!({ "messageId": "5:7:-1" })));
        assert!(!repeats(&read, &json!({ "messageId": "5:8:-1" })));
        assert!(!repeats(&read, &json!({ "messageId": null })));
    }

    #[test]
    fn only_a_generated_subscription_is_non_durable() {
        assert_eq!(
            consumer_options(InitialPosition::Latest, true).durable,
            Some(false)
        );
        assert_eq!(
            consumer_options(InitialPosition::Latest, false).durable,
            None
        );
    }

    #[test]
    fn a_peek_that_stops_early_says_how_far_it_got_and_why() {
        let w = stopped_early(2, 5, 3, "HTTP 404: not found");
        assert!(
            w.contains("2 of 5") && w.contains("#3") && w.contains("HTTP 404"),
            "{w}"
        );
    }

    #[test]
    fn oauth_credentials_never_touch_the_disk() {
        let url = oauth_credentials_url("id", "s3cret", "https://issuer.test");
        let b64 = url
            .strip_prefix("data:application/json;base64,")
            .expect(&url);
        let doc: Value = serde_json::from_slice(
            &base64::engine::general_purpose::STANDARD
                .decode(b64)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(doc["client_secret"], "s3cret");
        assert_eq!(doc["type"], "client_credentials");
    }

    #[test]
    fn the_token_is_never_logged() {
        let h = logged_headers(&Some("eyJsecret".into()));
        assert_eq!(h["authorization"], "Bearer •••");
        assert!(logged_headers(&Some(String::new())).is_empty());
        assert!(logged_headers(&None).is_empty());
    }

    #[test]
    fn topic_paths_encode_each_segment() {
        assert_eq!(
            topic_path("persistent://t/ns/orders"),
            "persistent/t/ns/orders"
        );
        assert_eq!(
            topic_path("non-persistent://t/ns/a b"),
            "non-persistent/t/ns/a%20b"
        );
        assert_eq!(topic_path("orders"), "persistent/public/default/orders");
        assert_eq!(
            topic_path("persistent://t/ns/q?x#y"),
            "persistent/t/ns/q%3Fx%23y"
        );
    }

    #[test]
    fn a_typed_subscription_needs_confirmation() {
        assert_eq!(pick_subscription(None, false, 7), Ok("conduit-7".into()));
        assert_eq!(
            pick_subscription(Some("  "), false, 7),
            Ok("conduit-7".into())
        );
        assert!(pick_subscription(Some("billing"), false, 7)
            .unwrap_err()
            .contains("billing"));
        assert_eq!(
            pick_subscription(Some("billing"), true, 7),
            Ok("billing".into())
        );
    }

    #[tokio::test]
    async fn an_empty_admin_url_is_refused_before_sending() {
        let client = reqwest::Client::new();
        let f = admin_call(
            &client,
            "  ",
            "/admin/v2/tenants",
            reqwest::Method::GET,
            &None,
        )
        .await
        .err()
        .expect("refused");
        assert_eq!(f["ok"], false);
        assert_eq!(f["detail"]["kind"], "request");
        assert!(f["error"].as_str().unwrap().contains("Admin URL"));
    }

    #[test]
    fn a_missing_topic_is_refused() {
        assert!(need_topic(" ").is_some());
        assert!(need_topic("orders").is_none());
    }

    #[test]
    fn a_binary_peeked_payload_is_base64() {
        let m = peek_message(1, &HashMap::new(), &[0xff, 0x00]);
        assert_eq!(m["payloadEncoding"], "base64");
        assert!(m["payloadNote"].as_str().unwrap().contains("2 bytes"));
    }

    #[test]
    fn admin_status_codes_get_a_plain_hint() {
        assert!(http_hints(401)[0].contains("Token"));
        assert!(http_hints(404)[0].contains("8080"));
        assert!(http_hints(500).is_empty());
    }
}
