// rdkafka = { version = "0.36", features = ["cmake-build"] }
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::{
    extract::Query,
    response::sse::{Event, Sse},
    routing::{get, post},
    Json, Router,
};
use base64::Engine;
use futures_util::stream::{self, Stream, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};

use rdkafka::admin::AdminClient;
use rdkafka::client::DefaultClientContext;
use rdkafka::config::ClientConfig;
use rdkafka::consumer::{Consumer, StreamConsumer};
use rdkafka::message::{Headers, Message};
use rdkafka::producer::{FutureProducer, FutureRecord};

static SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Deserialize, Clone, Default)]
struct Cfg {
    brokers: String,
    ssl: Option<bool>,
    #[serde(rename = "saslUser")]
    sasl_user: Option<String>,
    #[serde(rename = "saslPass")]
    sasl_pass: Option<String>,
}

fn base_config(cfg: &Cfg) -> ClientConfig {
    let brokers: Vec<String> = cfg
        .brokers
        .split(',')
        .map(|b| b.trim().to_string())
        .filter(|b| !b.is_empty())
        .collect();

    let mut c = ClientConfig::new();
    c.set("client.id", "conduit");
    c.set("bootstrap.servers", brokers.join(","));
    c.set("socket.timeout.ms", "15000");
    c.set("metadata.request.timeout.ms", "15000");

    let has_sasl = cfg.sasl_user.as_deref().map(|s| !s.is_empty()).unwrap_or(false)
        && cfg.sasl_pass.as_deref().map(|s| !s.is_empty()).unwrap_or(false);
    let ssl = cfg.ssl.unwrap_or(false);

    let protocol = match (ssl, has_sasl) {
        (true, true) => "sasl_ssl",
        (true, false) => "ssl",
        (false, true) => "sasl_plaintext",
        (false, false) => "plaintext",
    };
    c.set("security.protocol", protocol);

    if has_sasl {
        c.set("sasl.mechanism", "PLAIN");
        c.set("sasl.username", cfg.sasl_user.clone().unwrap_or_default());
        c.set("sasl.password", cfg.sasl_pass.clone().unwrap_or_default());
    }

    c
}

pub fn routes() -> Router {
    Router::new()
        .route("/topics", post(topics))
        .route("/produce", post(produce))
        .route("/consume", get(consume))
}

async fn topics(Json(cfg): Json<Cfg>) -> Json<Value> {
    match list_topics(&cfg).await {
        Ok(list) => Json(json!({ "ok": true, "topics": list })),
        Err(e) => Json(json!({ "ok": false, "error": e })),
    }
}

async fn list_topics(cfg: &Cfg) -> Result<Vec<String>, String> {
    let admin: AdminClient<DefaultClientContext> =
        base_config(cfg).create().map_err(|e| e.to_string())?;
    let meta = admin
        .inner()
        .fetch_metadata(None, Duration::from_secs(15))
        .map_err(|e| e.to_string())?;
    let mut names: Vec<String> = meta
        .topics()
        .iter()
        .map(|t| t.name().to_string())
        .collect();
    names.sort();
    Ok(names)
}

#[derive(Deserialize)]
struct ProduceReq {
    #[serde(flatten)]
    cfg: Cfg,
    topic: String,
    key: Option<String>,
    value: String,
    headers: Option<std::collections::HashMap<String, String>>,
}

async fn produce(Json(req): Json<ProduceReq>) -> Json<Value> {
    match do_produce(req).await {
        Ok(v) => Json(json!({ "ok": true, "result": v })),
        Err(e) => Json(json!({ "ok": false, "error": e })),
    }
}

async fn do_produce(req: ProduceReq) -> Result<Value, String> {
    let mut conf = base_config(&req.cfg);
    conf.set("message.timeout.ms", "15000");
    let producer: FutureProducer = conf.create().map_err(|e| e.to_string())?;

    let key = req.key.filter(|k| !k.is_empty());
    let mut record = FutureRecord::to(&req.topic).payload(&req.value);
    if let Some(ref k) = key {
        record = record.key(k);
    }

    let mut owned_headers = rdkafka::message::OwnedHeaders::new();
    if let Some(hs) = req.headers.as_ref() {
        for (k, v) in hs {
            owned_headers = owned_headers.insert(rdkafka::message::Header {
                key: k,
                value: Some(v),
            });
        }
        record = record.headers(owned_headers);
    }

    match producer.send(record, Duration::from_secs(15)).await {
        Ok((partition, offset)) => Ok(json!({ "partition": partition, "offset": offset })),
        Err((e, _)) => Err(e.to_string()),
    }
}

#[derive(Deserialize)]
struct ConsumeQuery {
    cfg: Option<String>,
    topic: Option<String>,
    group: Option<String>,
    #[serde(rename = "fromBeginning")]
    from_beginning: Option<String>,
}

fn rand_group() -> String {
    let n = SEQ.fetch_add(1, Ordering::SeqCst);
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("conduit-{:x}{:x}", t & 0xffffffff, n)
}

async fn consume(
    Query(q): Query<ConsumeQuery>,
) -> Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>> {
    let topic = q.topic.unwrap_or_default();
    let group = q
        .group
        .filter(|g| !g.is_empty())
        .unwrap_or_else(rand_group);
    let from_beginning = q.from_beginning.as_deref() == Some("1");

    let raw = q.cfg.unwrap_or_default();
    let cfg: Option<Cfg> = base64::engine::general_purpose::STANDARD
        .decode(raw.as_bytes())
        .ok()
        .and_then(|b| serde_json::from_slice::<Cfg>(&b).ok());

    let cfg = match cfg {
        Some(c) => c,
        None => {
            let s = stream::once(async {
                Ok(Event::default().event("error").data("bad cfg payload"))
            });
            return Sse::new(s.boxed());
        }
    };

    let mut conf = base_config(&cfg);
    conf.set("group.id", &group);
    conf.set("enable.auto.commit", "true");
    conf.set(
        "auto.offset.reset",
        if from_beginning { "earliest" } else { "latest" },
    );

    let consumer: StreamConsumer = match conf.create() {
        Ok(c) => c,
        Err(e) => {
            let msg = e.to_string();
            let s = stream::once(async move {
                Ok(Event::default().event("error").data(msg))
            });
            return Sse::new(s.boxed());
        }
    };

    if let Err(e) = consumer.subscribe(&[&topic]) {
        let msg = e.to_string();
        let s = stream::once(async move { Ok(Event::default().event("error").data(msg)) });
        return Sse::new(s.boxed());
    }

    let ready_data = format!("{} \u{b7} group {}", topic, group);
    let ready = stream::once(async move {
        Ok(Event::default().event("ready").data(ready_data))
    });

    let messages = stream::unfold(consumer, |consumer| async move {
        match consumer.recv().await {
            Ok(m) => {
                let key = m
                    .key()
                    .map(|k| String::from_utf8_lossy(k).to_string())
                    .unwrap_or_default();
                let payload = m
                    .payload()
                    .map(|p| String::from_utf8_lossy(p).to_string())
                    .unwrap_or_default();
                let mut headers = serde_json::Map::new();
                if let Some(hs) = m.headers() {
                    for h in hs.iter() {
                        let v = h
                            .value
                            .map(|b| String::from_utf8_lossy(b).to_string())
                            .unwrap_or_default();
                        headers.insert(h.key.to_string(), Value::String(v));
                    }
                }
                let data = json!({
                    "at": chrono::Utc::now().to_rfc3339(),
                    "partition": m.partition(),
                    "offset": m.offset(),
                    "key": key,
                    "headers": headers,
                    "payload": payload,
                });
                let ev = Event::default()
                    .event("message")
                    .data(serde_json::to_string(&data).unwrap_or_default());
                Some((Ok(ev), consumer))
            }
            Err(e) => {
                let ev = Event::default().event("error").data(e.to_string());
                Some((Ok(ev), consumer))
            }
        }
    });

    Sse::new(ready.chain(messages).boxed())
}
