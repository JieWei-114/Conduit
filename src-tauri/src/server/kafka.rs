use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::{
    extract::Query,
    response::sse::{Event, Sse},
    routing::{get, post},
    Json, Router,
};
use base64::Engine;
use futures_util::stream::Stream;
use serde::Deserialize;
use serde_json::{json, Value};

use rdkafka::client::ClientContext;
use rdkafka::config::ClientConfig;
use rdkafka::consumer::{BaseConsumer, Consumer, ConsumerContext, StreamConsumer};
use rdkafka::message::{Headers, Message, Timestamp};
use rdkafka::producer::{FutureProducer, FutureRecord};

use super::attempt::{chain, describe, Attempt, Reply};

static SEQ: AtomicU64 = AtomicU64::new(0);

/// How long a metadata fetch (list topics, the consumer's reachability check) may take.
const METADATA_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a produced record may wait for the broker's acknowledgement.
const PRODUCE_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Deserialize, Clone, Default)]
struct Cfg {
    brokers: String,
    ssl: Option<bool>,
    #[serde(rename = "saslUser")]
    sasl_user: Option<String>,
    #[serde(rename = "saslPass")]
    sasl_pass: Option<String>,
    #[serde(rename = "saslMechanism")]
    sasl_mechanism: Option<String>,
    /// A PEM file of CAs to trust instead of the system bundle.
    #[serde(rename = "sslCaLocation")]
    ssl_ca_location: Option<String>,
    /// A client certificate (PEM) for brokers that ask for one, with its key.
    #[serde(rename = "sslCertLocation")]
    ssl_certificate_location: Option<String>,
    #[serde(rename = "sslKeyLocation")]
    ssl_key_location: Option<String>,
    #[serde(rename = "sslKeyPassword")]
    ssl_key_password: Option<String>,
    /// Opt-in only: accept any broker certificate.
    #[serde(rename = "sslSkipVerify")]
    ssl_skip_verify: Option<bool>,
}

fn given(v: &Option<String>) -> Option<&str> {
    v.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

impl Cfg {
    fn has_sasl(&self) -> bool {
        self.sasl_user.as_deref().is_some_and(|s| !s.is_empty())
            && self.sasl_pass.as_deref().is_some_and(|s| !s.is_empty())
    }

    /// The first broker, `host:port`: where a failure is probed and what a record names.
    fn first_broker(&self) -> String {
        self.brokers
            .split(',')
            .map(str::trim)
            .find(|b| !b.is_empty())
            .unwrap_or_default()
            .to_string()
    }

    /// The connection as a record shows it: never the password.
    fn logged(&self) -> Value {
        json!({
            "brokers": self.brokers,
            "ssl": self.ssl.unwrap_or(false),
            "saslUser": self.sasl_user.as_deref().filter(|s| !s.is_empty()),
            "saslMechanism": if self.has_sasl() { sasl_mechanism(self.sasl_mechanism.as_deref()).ok() } else { None },
            "sslCaLocation": given(&self.ssl_ca_location),
            "sslCertLocation": given(&self.ssl_certificate_location),
            "sslKeyLocation": given(&self.ssl_key_location),
            "sslSkipVerify": self.ssl_skip_verify.unwrap_or(false),
        })
    }
}

/// The SASL mechanism to use: PLAIN when none is chosen.
fn sasl_mechanism(chosen: Option<&str>) -> Result<&'static str, String> {
    match chosen.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok("PLAIN"),
        Some(s) => match s.to_ascii_uppercase().as_str() {
            "PLAIN" => Ok("PLAIN"),
            "SCRAM-SHA-256" => Ok("SCRAM-SHA-256"),
            "SCRAM-SHA-512" => Ok("SCRAM-SHA-512"),
            _ => Err(format!(
                "unsupported SASL mechanism \"{s}\": use PLAIN, SCRAM-SHA-256 or SCRAM-SHA-512"
            )),
        },
    }
}

fn base_config(cfg: &Cfg) -> Result<ClientConfig, String> {
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

    let has_sasl = cfg.has_sasl();
    let ssl = cfg.ssl.unwrap_or(false);

    let protocol = match (ssl, has_sasl) {
        (true, true) => "sasl_ssl",
        (true, false) => "ssl",
        (false, true) => "sasl_plaintext",
        (false, false) => "plaintext",
    };
    c.set("security.protocol", protocol);

    if has_sasl {
        c.set("sasl.mechanism", sasl_mechanism(cfg.sasl_mechanism.as_deref())?);
        c.set("sasl.username", cfg.sasl_user.clone().unwrap_or_default());
        c.set("sasl.password", cfg.sasl_pass.clone().unwrap_or_default());
    }
    if ssl {
        let file = |what: &str, v: &Option<String>| -> Result<Option<String>, String> {
            match given(v) {
                Some(path) if !std::path::Path::new(path).is_file() => Err(format!("{what} {path:?} is not a readable file")),
                other => Ok(other.map(str::to_string)),
            }
        };
        match file("the CA file (sslCaLocation)", &cfg.ssl_ca_location)? {
            Some(path) => {
                c.set("ssl.ca.location", path);
            }
            // the OpenSSL built into conduit has no CA directory of its own: use the system's
            // bundle (Windows reads its certificate store by default)
            None if !cfg!(windows) => {
                c.set("ssl.ca.location", "probe");
            }
            None => {}
        }
        match (
            file("the client certificate (sslCertLocation)", &cfg.ssl_certificate_location)?,
            file("the client key (sslKeyLocation)", &cfg.ssl_key_location)?,
        ) {
            (Some(cert), Some(key)) => {
                c.set("ssl.certificate.location", cert);
                c.set("ssl.key.location", key);
                if let Some(pw) = given(&cfg.ssl_key_password) {
                    c.set("ssl.key.password", pw);
                }
            }
            (None, None) => {}
            _ => return Err("a client certificate needs both sslCertLocation and sslKeyLocation".into()),
        }
        if cfg.ssl_skip_verify == Some(true) {
            c.set("enable.ssl.certificate.verification", "false");
            c.set("ssl.endpoint.identification.algorithm", "none");
        }
    }

    Ok(c)
}

/// What librdkafka reported on its own while a call ran. A broker that fails the TLS handshake
/// or refuses the credentials says why only here; the call itself fails with "transport failure".
/// Clones share one list: the future producer wraps its context, so the caller keeps a clone.
#[derive(Clone, Default)]
struct Heard(Arc<std::sync::Mutex<Vec<String>>>);

/// Reasons kept per client: enough to explain a failure, bounded while it retries.
const HEARD_MAX: usize = 8;

impl Heard {
    /// `chain` with what was heard appended, skipping repeats.
    fn explain(&self, mut chain: Vec<String>) -> Vec<String> {
        let heard = self.0.lock().map(|h| h.clone()).unwrap_or_default();
        for r in heard {
            if !chain.contains(&r) {
                chain.push(r);
            }
        }
        chain
    }
}

impl Heard {
    fn note(&self, reason: &str) {
        // `… (after 3ms in state CONNECT)` and `, 2 identical error(s) suppressed` vary per retry
        let reason = reason.split(" (after ").next().unwrap_or(reason).trim().to_string();
        if let Ok(mut h) = self.0.lock() {
            if !reason.is_empty() && !h.contains(&reason) && h.len() < HEARD_MAX {
                h.push(reason);
            }
        }
    }
}

impl ClientContext for Heard {
    fn error(&self, error: rdkafka::error::KafkaError, reason: &str) {
        self.note(&if reason.is_empty() { error.to_string() } else { reason.to_string() });
    }
}

impl ConsumerContext for Heard {}

/// Hints for a client the configuration refused to create.
fn config_hints(message: &str) -> Vec<String> {
    let m = message.to_ascii_lowercase();
    if m.contains("sslcalocation") || m.contains("sslcertlocation") || m.contains("sslkeylocation") {
        vec![]
    } else if m.contains("ssl.ca.location") || m.contains("ca cert") {
        vec!["No CA bundle was found on this machine to check the brokers' certificates: install the system CA certificates (ca-certificates).".into()]
    } else {
        vec![]
    }
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

/// Whether a librdkafka cause chain describes a timeout.
fn is_timeout(chain: &[String]) -> bool {
    chain.iter().any(|c| {
        let c = c.to_ascii_lowercase();
        c.contains("timed out") || c.contains("timedout")
    })
}

/// Where a Kafka call stopped: before anything was sent (`config`), or on the way.
enum Stop {
    Config(String),
    Failed(&'static str, Vec<String>),
}

impl Stop {
    async fn into_failure(self, attempt: &Attempt, timeout_ms: u64) -> Value {
        match self {
            Stop::Config(message) => {
                let (mut error, log) = attempt.not_sent("config", &message);
                error["hints"] = json!(config_hints(&message));
                failure(error, log, attempt.elapsed_ms())
            }
            Stop::Failed(stage, chain) => {
                let timed_out = is_timeout(&chain);
                let stage = if timed_out { "timeout" } else { stage };
                let verify = chain.iter().any(|c| c.to_ascii_lowercase().contains("certificate verify failed"));
                let (mut error, mut log) = attempt.failed_with(stage, chain, timed_out, timeout_ms).await;
                if verify {
                    if let Some(h) = error["hints"].as_array_mut() {
                        h.retain(|x| x.as_str() != Some(super::attempt::CERT_HINT));
                        h.push(json!("The broker's certificate is not signed by a CA this machine trusts: give its CA file (sslCaLocation), or, for a test broker only, turn off certificate verification (sslSkipVerify)."));
                    }
                    log["error"] = error.clone();
                }
                failure(error, log, attempt.elapsed_ms())
            }
        }
    }
}

/// The record of a Kafka call that worked: there is no HTTP status, so it is 0, and the bytes
/// are those of the answer as the record holds it.
fn kafka_reply(attempt: &Attempt, body: Value) -> Value {
    let bytes = body.to_string().len();
    attempt.succeeded(Reply {
        status: 0,
        headers: &HashMap::new(),
        trailers: None,
        body,
        bytes,
    })
}

pub fn routes() -> Router {
    Router::new()
        .route("/topics", post(topics))
        .route("/produce", post(produce))
        .route("/consume", get(consume))
}

async fn topics(Json(cfg): Json<Cfg>) -> Json<Value> {
    let attempt = Attempt::start("METADATA (Kafka)", &cfg.first_broker(), HashMap::new(), cfg.logged(), 0);
    let c = cfg.clone();
    let result = tokio::task::spawn_blocking(move || list_topics(&c, METADATA_TIMEOUT))
        .await
        .unwrap_or_else(|e| Err(Stop::Failed("metadata", vec![e.to_string()])));
    match result {
        Ok(list) => {
            let log = kafka_reply(&attempt, json!({ "topics": list }));
            Json(json!({ "ok": true, "topics": list, "durationMs": attempt.elapsed_ms(), "log": log }))
        }
        Err(stop) => Json(stop.into_failure(&attempt, METADATA_TIMEOUT.as_millis() as u64).await),
    }
}

/// Blocking: librdkafka's metadata call waits on its own thread. A plain consumer, not an admin
/// client, because only a client that is polled hears why a broker connection failed.
fn list_topics(cfg: &Cfg, limit: Duration) -> Result<Vec<String>, Stop> {
    let client: BaseConsumer<Heard> = base_config(cfg)
        .map_err(Stop::Config)?
        .create_with_context(Heard::default())
        .map_err(|e| Stop::Config(describe(&e)))?;
    let meta = client.fetch_metadata(None, limit).map_err(|e| {
        for _ in 0..5 {
            let _ = client.poll(Duration::from_millis(100));
        }
        Stop::Failed("metadata", client.context().explain(chain(&e)))
    })?;
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
    headers: Option<HashMap<String, String>>,
}

async fn produce(Json(req): Json<ProduceReq>) -> Json<Value> {
    let mut sent = req.cfg.logged();
    sent["topic"] = json!(req.topic);
    sent["key"] = json!(req.key.as_deref().filter(|k| !k.is_empty()));
    sent["headers"] = json!(req.headers);
    sent["value"] = json!(req.value);
    let attempt = Attempt::start("PRODUCE (Kafka)", &req.cfg.first_broker(), HashMap::new(), sent, req.value.len());
    match do_produce(req).await {
        Ok(v) => {
            let log = kafka_reply(&attempt, v.clone());
            Json(json!({ "ok": true, "result": v, "durationMs": attempt.elapsed_ms(), "log": log }))
        }
        Err(stop) => Json(stop.into_failure(&attempt, PRODUCE_TIMEOUT.as_millis() as u64).await),
    }
}

async fn do_produce(req: ProduceReq) -> Result<Value, Stop> {
    let mut conf = base_config(&req.cfg).map_err(Stop::Config)?;
    conf.set("message.timeout.ms", PRODUCE_TIMEOUT.as_millis().to_string());
    let heard = Heard::default();
    let producer: FutureProducer<Heard> = conf
        .create_with_context(heard.clone())
        .map_err(|e| Stop::Config(describe(&e)))?;

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

    match producer.send(record, PRODUCE_TIMEOUT).await {
        Ok((partition, offset)) => Ok(json!({ "partition": partition, "offset": offset })),
        Err((e, _)) => Err(Stop::Failed("send", heard.explain(chain(&e)))),
    }
}

#[derive(Deserialize)]
struct ConsumeQuery {
    cfg: Option<String>,
    topic: Option<String>,
    group: Option<String>,
    #[serde(rename = "fromBeginning")]
    from_beginning: Option<String>,
    /// "1": commit offsets for a group the person named
    commit: Option<String>,
}

/// Whether the consumer commits its offsets. A throwaway group (no name typed) always does:
/// nobody else reads it. A named group commits only when asked, so looking at a real group never
/// moves where its own consumers resume.
fn commits_offsets(group_typed: bool, asked: bool) -> bool {
    !group_typed || asked
}

fn rand_group() -> String {
    let n = SEQ.fetch_add(1, Ordering::SeqCst);
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("conduit-{:x}{:x}", t & 0xffffffff, n)
}

/// Bytes as a record shows them: `null` when absent, the text when it is UTF-8, otherwise
/// base64 with a hex preview and a note saying so (lossy text would hide what was sent).
pub(super) fn bytes_view(bytes: Option<&[u8]>) -> Value {
    const HEX_PREVIEW: usize = 64;
    match bytes {
        None => json!({ "text": Value::Null, "encoding": Value::Null }),
        Some(b) => match std::str::from_utf8(b) {
            Ok(s) => json!({ "text": s, "encoding": "utf8" }),
            Err(_) => {
                let hex: String = b
                    .iter()
                    .take(HEX_PREVIEW)
                    .map(|x| format!("{x:02x}"))
                    .collect::<Vec<_>>()
                    .join(" ");
                let more = if b.len() > HEX_PREVIEW { " …" } else { "" };
                json!({
                    "text": base64::engine::general_purpose::STANDARD.encode(b),
                    "encoding": "base64",
                    "note": format!("binary, {} bytes, not UTF-8: shown as base64. Hex: {hex}{more}", b.len()),
                })
            }
        },
    }
}

/// A record's timestamp and what kind it is.
fn timestamp_json(ts: Timestamp) -> (Value, Value) {
    match ts {
        Timestamp::NotAvailable => (Value::Null, Value::Null),
        Timestamp::CreateTime(ms) => (json!(ms), json!("create")),
        Timestamp::LogAppendTime(ms) => (json!(ms), json!("logAppend")),
    }
}

fn record_json<M: Message>(m: &M) -> Value {
    let key = bytes_view(m.key());
    let payload = bytes_view(m.payload());
    let mut headers = serde_json::Map::new();
    if let Some(hs) = m.headers() {
        for h in hs.iter() {
            let v = bytes_view(h.value);
            let shown = match v["encoding"].as_str() {
                Some("base64") => format!("base64:{}", v["text"].as_str().unwrap_or("")),
                _ => v["text"].as_str().unwrap_or("").to_string(),
            };
            headers.insert(h.key.to_string(), Value::String(shown));
        }
    }
    let (timestamp, timestamp_type) = timestamp_json(m.timestamp());
    json!({
        "at": chrono::Utc::now().to_rfc3339(),
        "partition": m.partition(),
        "offset": m.offset(),
        "timestamp": timestamp,
        "timestampType": timestamp_type,
        "key": key["text"],
        "keyEncoding": key["encoding"],
        "keyNote": key.get("note"),
        "headers": headers,
        "payload": payload["text"],
        "payloadEncoding": payload["encoding"],
        "payloadNote": payload.get("note"),
    })
}

/// Holds `T` and drops it on the blocking pool: closing a `StreamConsumer` waits for the broker
/// (leaving the group, committing), which must not stall a runtime worker.
struct DropOffRuntime<T: Send + 'static>(Option<T>);

impl<T: Send + 'static> std::ops::Deref for DropOffRuntime<T> {
    type Target = T;
    fn deref(&self) -> &T {
        self.0.as_ref().expect("held until dropped")
    }
}

impl<T: Send + 'static> Drop for DropOffRuntime<T> {
    fn drop(&mut self) {
        if let Some(v) = self.0.take() {
            match tokio::runtime::Handle::try_current() {
                Ok(rt) => {
                    rt.spawn_blocking(move || drop(v));
                }
                Err(_) => drop(v),
            }
        }
    }
}

/// How often a consumer looks for a topic it subscribed to before the topic existed.
const TOPIC_REFRESH_MS: &str = "1000";

/// Where a consumer without committed offsets starts. A topic that does not exist yet when it
/// connects holds only records published after that, so it reads them all.
fn offset_reset(from_beginning: bool, topic_missing: bool) -> &'static str {
    if from_beginning || topic_missing { "earliest" } else { "latest" }
}

/// Before saying "listening": fetch the topic's metadata so an unreachable broker, refused
/// credentials or a timeout show as an error instead of a stream that never delivers. Ok carries
/// a note about the topic for the ready line, and whether the topic does not exist yet.
async fn check_reachable(consumer: Arc<StreamConsumer<Heard>>, cfg: &Cfg, topic: &str) -> Result<(String, bool), Value> {
    let mut sent = cfg.logged();
    sent["topic"] = json!(topic);
    let attempt = Attempt::start("METADATA (Kafka)", &cfg.first_broker(), HashMap::new(), sent, 0);
    let t = topic.to_string();
    let result = tokio::task::spawn_blocking(move || {
        consumer
            .fetch_metadata(Some(&t), METADATA_TIMEOUT)
            .map(|meta| {
                meta.topics()
                    .first()
                    .map(|mt| {
                        let err = mt.error().map(|e| describe(&rdkafka::error::RDKafkaErrorCode::from(e)));
                        (mt.partitions().len(), err)
                    })
            })
            .map_err(|e| consumer.context().explain(chain(&e)))
    })
    .await
    .unwrap_or_else(|e| Err(vec![e.to_string()]));
    // the stream consumer is not polled here, so it heard nothing: ask a polled client why
    let result = match result {
        Err(c) => {
            let c2 = cfg.clone();
            let heard = tokio::task::spawn_blocking(move || match list_topics(&c2, Duration::from_secs(3)) {
                Err(Stop::Failed(_, why)) => why,
                _ => vec![],
            })
            .await
            .unwrap_or_default();
            let mut c = c;
            for h in heard {
                if !c.contains(&h) {
                    c.push(h);
                }
            }
            Err(c)
        }
        ok => ok,
    };
    match result {
        Ok(Some((_, Some(err)))) => Ok((format!(" · topic not available yet: {err}; its records show once it is created"), true)),
        Ok(Some((n, None))) => Ok((format!(" · {n} partition{}", if n == 1 { "" } else { "s" }), false)),
        Ok(None) => Ok((String::new(), false)),
        Err(c) => Err(Stop::Failed("metadata", c)
            .into_failure(&attempt, METADATA_TIMEOUT.as_millis() as u64)
            .await),
    }
}

async fn consume(
    Query(q): Query<ConsumeQuery>,
) -> Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>> {
    let stream = async_stream::stream! {
        // every failure before the stream starts is the `{error, detail, log}` shape
        let event = |f: Value| {
            Event::default()
                .event("error")
                .data(json!({ "error": f["error"], "detail": f["detail"], "log": f["log"] }).to_string())
        };
        let topic = q.topic.unwrap_or_default();
        let typed_group = q.group.map(|g| g.trim().to_string()).filter(|g| !g.is_empty());
        let commits = commits_offsets(typed_group.is_some(), q.commit.as_deref() == Some("1"));
        let group = typed_group.unwrap_or_else(rand_group);
        let from_beginning = q.from_beginning.as_deref() == Some("1");

        let raw = q.cfg.unwrap_or_default();
        let cfg: Option<Cfg> = base64::engine::general_purpose::STANDARD
            .decode(raw.as_bytes())
            .ok()
            .and_then(|b| serde_json::from_slice::<Cfg>(&b).ok());
        let Some(cfg) = cfg else {
            let attempt = Attempt::start("SUBSCRIBE (Kafka)", "", HashMap::new(), Value::Null, 0);
            let (error, log) = attempt.not_sent("request", "The connection settings did not arrive intact (bad cfg payload).");
            yield Ok(event(failure(error, log, 0)));
            return;
        };
        let mut sent = cfg.logged();
        sent["topic"] = json!(topic);
        sent["group"] = json!(group);
        sent["commitOffsets"] = json!(commits);
        let attempt = Attempt::start("SUBSCRIBE (Kafka)", &cfg.first_broker(), HashMap::new(), sent, 0);
        let limit = METADATA_TIMEOUT.as_millis() as u64;
        if topic.trim().is_empty() {
            let (error, log) = attempt.not_sent("request", "Enter a topic first.");
            yield Ok(event(failure(error, log, 0)));
            return;
        }

        let mut conf = match base_config(&cfg) {
            Ok(c) => c,
            Err(e) => {
                yield Ok(event(Stop::Config(e).into_failure(&attempt, limit).await));
                return;
            }
        };
        conf.set("group.id", &group);
        conf.set("enable.auto.commit", if commits { "true" } else { "false" });
        conf.set("topic.metadata.refresh.interval.ms", TOPIC_REFRESH_MS);
        let make = |reset: &str| {
            let mut conf = conf.clone();
            conf.set("auto.offset.reset", reset);
            conf.create_with_context::<Heard, StreamConsumer<Heard>>(Heard::default())
                .map(|c| DropOffRuntime(Some(Arc::new(c))))
                .map_err(|e| describe(&e))
        };

        let mut consumer = match make(offset_reset(from_beginning, false)) {
            Ok(c) => c,
            Err(e) => {
                yield Ok(event(Stop::Config(e).into_failure(&attempt, limit).await));
                return;
            }
        };
        let checked = check_reachable(Arc::clone(&consumer), &cfg, &topic).await;
        if let Ok((_, true)) = checked {
            if !from_beginning {
                consumer = match make(offset_reset(from_beginning, true)) {
                    Ok(c) => c,
                    Err(e) => {
                        yield Ok(event(Stop::Config(e).into_failure(&attempt, limit).await));
                        return;
                    }
                };
            }
        }
        if checked.is_ok() {
            if let Err(e) = consumer.subscribe(&[&topic]) {
                yield Ok(event(Stop::Failed("subscribe", chain(&e)).into_failure(&attempt, limit).await));
                return;
            }
        }

        match checked {
            Ok((note, _)) => {
                let offsets = if commits { "" } else { " \u{b7} offsets not committed" };
                yield Ok(Event::default().event("ready").data(format!("{topic} \u{b7} group {group}{offsets}{note}")));
            }
            Err(f) => {
                // a JSON failure: the panel shows its detail and log
                yield Ok(Event::default().event("error").data(f.to_string()));
                return;
            }
        }

        loop {
            match consumer.recv().await {
                Ok(m) => {
                    yield Ok(Event::default().event("message").data(record_json(&m).to_string()));
                }
                Err(e) => {
                    // librdkafka reconnects by itself: say what happened and keep listening
                    let warning = json!({ "at": chrono::Utc::now().to_rfc3339(), "warning": describe(&e) });
                    yield Ok(Event::default().event("warning").data(warning.to_string()));
                    tokio::time::sleep(Duration::from_secs(1)).await;
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
    fn sasl_mechanisms_default_to_plain_and_refuse_the_unknown() {
        assert_eq!(sasl_mechanism(None), Ok("PLAIN"));
        assert_eq!(sasl_mechanism(Some("")), Ok("PLAIN"));
        assert_eq!(sasl_mechanism(Some("scram-sha-512")), Ok("SCRAM-SHA-512"));
        assert_eq!(sasl_mechanism(Some("SCRAM-SHA-256")), Ok("SCRAM-SHA-256"));
        assert!(sasl_mechanism(Some("GSSAPI")).is_err());
    }

    #[test]
    fn a_missing_key_and_an_empty_key_differ() {
        assert_eq!(bytes_view(None)["text"], Value::Null);
        assert_eq!(bytes_view(Some(b""))["text"], "");
        assert_eq!(bytes_view(Some(b""))["encoding"], "utf8");
    }

    #[test]
    fn binary_payloads_are_base64_with_a_note() {
        let v = bytes_view(Some(&[0xff, 0x00, 0x10]));
        assert_eq!(v["encoding"], "base64");
        assert_eq!(v["text"], "/wAQ");
        let note = v["note"].as_str().unwrap();
        assert!(note.contains("3 bytes") && note.contains("ff 00 10"), "{note}");
        assert_eq!(bytes_view(Some("héllo".as_bytes()))["text"], "héllo");
    }

    #[test]
    fn timestamps_keep_their_kind() {
        assert_eq!(timestamp_json(Timestamp::CreateTime(5)), (json!(5), json!("create")));
        assert_eq!(timestamp_json(Timestamp::LogAppendTime(6)), (json!(6), json!("logAppend")));
        assert_eq!(timestamp_json(Timestamp::NotAvailable), (Value::Null, Value::Null));
    }

    #[test]
    fn the_logged_connection_never_has_the_password() {
        let cfg = Cfg {
            brokers: " b1:9092 , b2:9092".into(),
            ssl: None,
            sasl_user: Some("u".into()),
            sasl_pass: Some("s3cret".into()),
            sasl_mechanism: Some("SCRAM-SHA-256".into()),
            ssl_key_password: Some("keypw".into()),
            ..Default::default()
        };
        let logged = cfg.logged().to_string();
        assert!(!logged.contains("s3cret") && !logged.contains("keypw"), "{logged}");
        assert!(logged.contains("SCRAM-SHA-256"), "{logged}");
        assert_eq!(cfg.first_broker(), "b1:9092");
    }

    #[test]
    fn a_named_group_commits_only_when_asked() {
        assert!(commits_offsets(false, false), "a throwaway group commits as before");
        assert!(!commits_offsets(true, false), "a typed group is left alone by default");
        assert!(commits_offsets(true, true));
    }

    #[test]
    fn librdkafka_timeouts_are_recognised() {
        assert!(is_timeout(&["Meta data fetch error: OperationTimedOut (Local: Timed out)".into()]));
        assert!(!is_timeout(&["Broker: Unknown topic or partition".into()]));
    }

    #[test]
    fn a_missing_ca_bundle_is_named() {
        let h = config_hints("Client creation error: ssl.ca.location failed: No CA certificates found");
        assert!(h[0].contains("CA bundle"), "{h:?}");
        assert!(config_hints("Configuration property \"x\" not supported").is_empty());
    }

    #[test]
    fn scram_and_ssl_clients_can_be_created() {
        // Arrange: this build carries OpenSSL, so librdkafka accepts these settings
        let cfg: Cfg = serde_json::from_value(json!({
            "brokers": "127.0.0.1:1", "ssl": true,
            "saslUser": "u", "saslPass": "p", "saslMechanism": "SCRAM-SHA-512",
        }))
        .unwrap();
        // Act
        let made: Result<FutureProducer<Heard>, _> = base_config(&cfg).unwrap().create_with_context(Heard::default());
        // Assert
        assert!(made.is_ok(), "{:?}", made.err());
    }

    #[test]
    fn ssl_files_and_skip_verify_reach_librdkafka() {
        let dir = std::env::temp_dir().join(format!("conduit-kafka-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let ca = dir.join("ca.pem");
        std::fs::write(&ca, "x").unwrap();
        let cfg: Cfg = serde_json::from_value(json!({
            "brokers": "b:9093", "ssl": true, "sslCaLocation": ca.to_string_lossy(), "sslSkipVerify": true,
        }))
        .unwrap();
        let c = base_config(&cfg).unwrap();
        assert_eq!(c.get("ssl.ca.location"), Some(ca.to_string_lossy().as_ref()));
        assert_eq!(c.get("enable.ssl.certificate.verification"), Some("false"));
        let off: Cfg = serde_json::from_value(json!({ "brokers": "b:9093", "ssl": true })).unwrap();
        assert_eq!(base_config(&off).unwrap().get("enable.ssl.certificate.verification"), None, "verification stays on by default");
        let missing: Cfg = serde_json::from_value(json!({ "brokers": "b", "ssl": true, "sslCaLocation": "/nonexistent/ca.pem" })).unwrap();
        assert!(base_config(&missing).unwrap_err().contains("/nonexistent/ca.pem"));
        let half: Cfg = serde_json::from_value(json!({ "brokers": "b", "ssl": true, "sslCertLocation": ca.to_string_lossy() })).unwrap();
        assert!(base_config(&half).unwrap_err().contains("sslKeyLocation"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_slow_close_runs_off_the_async_workers() {
        struct Slow(std::sync::mpsc::Sender<String>);
        impl Drop for Slow {
            fn drop(&mut self) {
                std::thread::sleep(Duration::from_millis(300));
                let _ = self.0.send(std::thread::current().name().unwrap_or("").to_string());
            }
        }
        let (tx, rx) = std::sync::mpsc::channel();
        let held = DropOffRuntime(Some(Slow(tx)));
        let t0 = std::time::Instant::now();
        drop(held);
        assert!(t0.elapsed() < Duration::from_millis(100), "{:?}", t0.elapsed());
        let thread = tokio::task::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(2)).unwrap()).await.unwrap();
        assert_ne!(thread, std::thread::current().name().unwrap_or("").to_string());
    }

    #[test]
    fn a_topic_created_after_connecting_is_read_from_its_first_record() {
        assert_eq!(offset_reset(false, false), "latest");
        assert_eq!(offset_reset(false, true), "earliest");
        assert_eq!(offset_reset(true, false), "earliest");
    }

    #[test]
    fn what_librdkafka_reported_explains_the_failure() {
        let heard = Heard::default();
        heard.error(rdkafka::error::KafkaError::Global(rdkafka::types::RDKafkaErrorCode::BrokerTransportFailure), "ssl://b:9093/bootstrap: SSL handshake failed: certificate verify failed");
        heard.error(rdkafka::error::KafkaError::Global(rdkafka::types::RDKafkaErrorCode::BrokerTransportFailure), "ssl://b:9093/bootstrap: SSL handshake failed: certificate verify failed");
        let chain = heard.explain(vec!["Meta data fetch error: BrokerTransportFailure".into()]);
        assert_eq!(chain.len(), 2, "{chain:?}");
        assert!(chain[1].contains("certificate verify failed"));
    }
}
