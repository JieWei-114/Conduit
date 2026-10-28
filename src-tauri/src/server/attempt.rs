//! The record of one outgoing request, success or failure: what was sent, what came back, and
//! when it failed, the cause chain, a kind, hints and a probe of the name and the TCP port.

use std::collections::HashMap;
use std::error::Error as StdError;
use std::net::{IpAddr, SocketAddr};
use std::time::{Duration, Instant};

use chrono::{SecondsFormat, Utc};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio::time::timeout;

const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

pub struct Attempt {
    method: String,
    url: String,
    request_time: String,
    started: Instant,
    request_headers: HashMap<String, String>,
    request_body: Value,
    request_bytes: usize,
    /// Set once, so a probe run afterwards is not counted in the request's duration.
    ended: std::sync::Mutex<Option<(Instant, String)>>,
}

pub struct Reply<'a> {
    pub status: u16,
    pub headers: &'a HashMap<String, String>,
    pub trailers: Option<&'a HashMap<String, String>>,
    pub body: Value,
    pub bytes: usize,
}

impl Attempt {
    pub fn start(
        method: &str,
        url: &str,
        request_headers: HashMap<String, String>,
        request_body: Value,
        request_bytes: usize,
    ) -> Self {
        Self {
            method: method.to_string(),
            url: redact_url(url),
            request_time: now(),
            started: Instant::now(),
            request_headers,
            request_body,
            request_bytes,
            ended: std::sync::Mutex::new(None),
        }
    }

    pub fn elapsed_ms(&self) -> u128 {
        self.end().0.duration_since(self.started).as_millis()
    }

    fn end(&self) -> (Instant, String) {
        let mut ended = self.ended.lock().unwrap_or_else(|e| e.into_inner());
        ended.get_or_insert_with(|| (Instant::now(), now())).clone()
    }

    pub fn succeeded(&self, reply: Reply<'_>) -> Value {
        let mut log = self.base();
        log["response"] = json!({
            "status": reply.status,
            "headers": reply.headers,
            "trailers": reply.trailers,
            "body": reply.body,
            "bytes": reply.bytes,
        });
        log["error"] = Value::Null;
        log["networkStats"] = self.stats(reply.bytes);
        log
    }

    /// `(error, log)`. `stage` is where it stopped (`network`, `timeout`, `body`).
    pub async fn failed(
        &self,
        stage: &str,
        err: &(dyn StdError + Send + Sync + 'static),
        timed_out: bool,
        timeout_ms: u64,
    ) -> (Value, Value) {
        self.failed_with(stage, chain(err), timed_out, timeout_ms)
            .await
    }

    pub async fn failed_with(
        &self,
        stage: &str,
        chain: Vec<String>,
        timed_out: bool,
        timeout_ms: u64,
    ) -> (Value, Value) {
        self.end();
        let chain = tidy(chain);
        let kind = kind(&chain, timed_out);
        let probe = probe(&self.url).await;
        let target = Target {
            method: &self.method,
            url: &self.url,
            headers: &self.request_headers,
        };
        let hints = hints(&target, kind, &chain, &probe, timeout_ms);
        let message = if timed_out {
            format!("no complete answer within {timeout_ms} ms")
        } else {
            summary(kind, &chain, &probe)
        };
        let error = json!({
            "stage": stage,
            "kind": kind,
            "message": message,
            "chain": chain,
            "hints": hints,
            "probe": probe,
        });
        let mut log = self.base();
        log["response"] = Value::Null;
        log["error"] = error.clone();
        log["networkStats"] = self.stats(0);
        (error, log)
    }

    /// The server answered with a refusal of its own (a SQL error, a Redis error reply): the
    /// network worked, so nothing is probed. `kind` names who refused (`database`, `reply`, `http`).
    pub fn server_refused(&self, stage: &str, chain: Vec<String>, kind: &str) -> (Value, Value) {
        self.end();
        let chain = tidy(chain);
        let error = json!({
            "stage": stage,
            "kind": kind,
            "message": chain.last().cloned().unwrap_or_default(),
            "chain": chain,
            "hints": [],
            "probe": Value::Null,
        });
        let mut log = self.base();
        log["response"] = Value::Null;
        log["error"] = error.clone();
        log["networkStats"] = self.stats(0);
        (error, log)
    }

    pub fn not_sent(&self, stage: &str, message: &str) -> (Value, Value) {
        let error = json!({
            "stage": stage,
            "kind": "request",
            "message": message,
            "chain": [message],
            "hints": [],
            "probe": Value::Null,
        });
        let mut log = self.base();
        log["response"] = Value::Null;
        log["error"] = error.clone();
        log["networkStats"] = self.stats(0);
        (error, log)
    }

    fn base(&self) -> Value {
        json!({
            "method": self.method,
            "url": self.url,
            "requestTime": self.request_time,
            "respondTime": self.end().1,
            "durationMs": self.elapsed_ms(),
            "request": {
                "headers": self.request_headers,
                "body": self.request_body,
                "bytes": self.request_bytes,
            },
        })
    }

    fn stats(&self, received: usize) -> Value {
        let secs = self
            .end()
            .0
            .duration_since(self.started)
            .as_secs_f64()
            .max(0.001);
        let kbps = |bytes: usize| ((bytes as f64 / 1024.0 / secs) * 100.0).round() / 100.0;
        json!({
            "sentBytes": self.request_bytes,
            "receivedBytes": received,
            "sentKBps": kbps(self.request_bytes),
            "receivedKBps": kbps(received),
            "elapsedSec": (secs * 1000.0).round() / 1000.0,
            "source": "conduit on this machine",
        })
    }
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Every message in `err`'s cause chain, outermost first, tidied by [`tidy`].
pub fn chain(err: &(dyn StdError + 'static)) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut cur: Option<&(dyn StdError + 'static)> = Some(err);
    while let Some(e) = cur {
        out.push(e.to_string());
        cur = e.source();
    }
    tidy(out)
}

/// `outer: cause: root` on one line.
pub fn describe(err: &(dyn StdError + 'static)) -> String {
    chain(err).join(": ")
}

/// A chain without empty or repeated layers. An outer layer that ends with the next one
/// (`connect error: refused`, then `refused`) keeps only its own part, and certificate
/// times are written as dates.
pub fn tidy(chain: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for msg in chain {
        let msg = readable_cert_times(msg.trim());
        if msg.is_empty() || out.iter().any(|m| m.eq_ignore_ascii_case(&msg)) {
            continue;
        }
        out.push(msg);
    }
    for i in 0..out.len().saturating_sub(1) {
        let inner = format!(": {}", out[i + 1]);
        if out[i].len() > inner.len() && out[i].ends_with(&inner) {
            let keep = out[i].len() - inner.len();
            out[i].truncate(keep);
        }
    }
    let mut seen: Vec<String> = Vec::new();
    out.retain(|m| {
        let fresh = !seen.iter().any(|s| s.eq_ignore_ascii_case(m));
        seen.push(m.clone());
        fresh
    });
    out
}

/// rustls writes certificate validity as UNIX seconds; this writes it as a date and an age.
fn readable_cert_times(msg: &str) -> String {
    let number_after = |s: &str, prefix: &str| -> Option<(i64, usize)> {
        let at = s.find(prefix)? + prefix.len();
        let digits: String = s[at..].chars().take_while(|c| c.is_ascii_digit()).collect();
        Some((digits.parse().ok()?, at + digits.len()))
    };
    let rewrite = |msg: &str, head: &str, bound: &str, tail: &str, past: bool| -> Option<String> {
        let start = msg.find(head)?;
        let (when, after) = number_after(msg, bound)?;
        let end = msg[after..].find(tail)? + after + tail.len();
        let date = chrono::DateTime::from_timestamp(when, 0)?.format("%Y-%m-%d %H:%M UTC");
        let age = relative(Utc::now().timestamp() - when);
        let text = if past {
            format!("certificate expired: it was valid until {date} ({age})")
        } else {
            format!("certificate not valid yet: it is valid from {date} ({age})")
        };
        Some(format!("{}{text}{}", &msg[..start], &msg[end..]))
    };
    rewrite(
        msg,
        "certificate expired: verification time",
        "not valid after ",
        "seconds ago)",
        true,
    )
    .or_else(|| {
        rewrite(
            msg,
            "certificate not valid yet: verification time",
            "not valid before ",
            "seconds in future)",
            false,
        )
    })
    .unwrap_or_else(|| msg.to_string())
}

/// `secs` before now (negative: after now) as "3 days ago" / "in 5 hours".
pub fn relative(secs: i64) -> String {
    let n = secs.unsigned_abs();
    let (v, unit) = match n {
        0..=119 => (n, "second"),
        120..=7199 => (n / 60, "minute"),
        7200..=172_799 => (n / 3600, "hour"),
        172_800..=5_183_999 => (n / 86_400, "day"),
        5_184_000..=63_071_999 => (n / 2_592_000, "month"),
        _ => (n / 31_536_000, "year"),
    };
    let s = if v == 1 { "" } else { "s" };
    if secs >= 0 {
        format!("{v} {unit}{s} ago")
    } else {
        format!("in {v} {unit}{s}")
    }
}

/// The chain as one lowercase text for keyword matching, without any URL in it: a host named
/// `tls.example.test` must not make a refused connection look like a TLS failure.
fn chain_text(chain: &[String]) -> String {
    chain
        .iter()
        .map(|c| {
            c.split_whitespace()
                .filter(|w| !w.contains("://"))
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect::<Vec<_>>()
        .join(" | ")
        .to_lowercase()
}

/// `timeout`, `dns`, `connect`, `tls`, `protocol`, `body` or `network`.
pub fn kind(chain: &[String], timed_out: bool) -> &'static str {
    if timed_out {
        return "timeout";
    }
    let all = chain_text(chain);
    let has = |words: &[&str]| words.iter().any(|w| all.contains(w));
    if has(&["timed out", "deadline has elapsed", "operation timed out"]) {
        return "timeout";
    }
    if has(&["closing handshake"]) {
        return "protocol";
    }
    // a client that tries several addresses reports every one: a handshake that got as far as
    // TLS says more than a refusal on another address
    if has(&[
        "ssl handshake failed",
        "plaintext broker listener",
        "connecting to a ssl listener",
    ]) {
        return "tls";
    }
    if has(&[
        "dns error",
        "failed to lookup address",
        "nodename nor servname",
        "name or service not known",
        "no such host",
    ]) {
        "dns"
    } else if has(&[
        "connection refused",
        "network is unreachable",
        "no route to host",
        "host is unreachable",
        "tcp connect error",
    ]) {
        "connect"
    } else if has(&[
        "tls",
        "ssl",
        "certificate",
        "handshake",
        "invalidcontenttype",
        "wrong version number",
        "corrupt message",
        "unknownissuer",
    ]) {
        "tls"
    } else if has(&["brokertransportfailure", "all brokers down"]) {
        "connect"
    } else if has(&[
        "connection closed before message completed",
        "incomplete message",
        "connection reset",
        "broken pipe",
        "invalid http version",
        "http2",
        "h2 protocol",
        "unexpected eof",
    ]) {
        "protocol"
    } else if has(&["error decoding response body", "error reading a body"]) {
        "body"
    } else {
        "network"
    }
}

/// Where a URL, a bare `host:port` or a libpq keyword string (`host=h port=5432`) points.
fn probe_target(raw: &str) -> Result<(String, String, Option<u16>), &'static str> {
    if !raw.contains("://") && raw.contains('=') {
        let mut host = None;
        let mut port = None;
        for pair in raw.split_whitespace() {
            match pair.split_once('=') {
                Some(("host" | "hostaddr", v)) if host.is_none() => {
                    host = Some(v.trim_matches('\'').to_string())
                }
                Some(("port", v)) => port = v.trim_matches('\'').parse().ok(),
                _ => {}
            }
        }
        let host = host
            .and_then(|h| h.split(',').next().map(str::to_string))
            .unwrap_or_else(|| "localhost".into());
        if host.starts_with('/') {
            return Err("a Unix socket, not a network address");
        }
        return Ok(("postgres".into(), host, port.or(Some(5432))));
    }
    let raw = if raw.contains("://") {
        raw.to_string()
    } else {
        format!("tcp://{raw}")
    };
    let url = url::Url::parse(&raw).map_err(|_| "not a URL")?;
    let scheme = url.scheme().to_string();
    let host = url
        .host_str()
        .map(|h| h.trim_matches(['[', ']']).to_string())
        .ok_or("no host")?;
    let port = url.port().or_else(|| default_port(&scheme));
    Ok((scheme, host, port))
}

/// A connection error in a few words, for a probe row.
fn short_io(e: &std::io::Error) -> String {
    use std::io::ErrorKind::*;
    match e.kind() {
        ConnectionRefused => "connection refused".into(),
        TimedOut => "timed out".into(),
        ConnectionReset => "connection reset".into(),
        _ => {
            let s = e.to_string();
            match s.find(" (os error") {
                Some(i) => s[..i].to_string(),
                None => s,
            }
        }
    }
}

/// Resolve the host and try its TCP port on every address it resolves to, each within
/// [`PROBE_TIMEOUT`]. `tcp` is the verdict (ok when any address accepts) and `tcpAll` has one
/// row per address.
pub async fn probe(raw_url: &str) -> Value {
    let (scheme, host, port) = match probe_target(raw_url) {
        Ok(t) => t,
        Err(e) => return json!({ "error": e }),
    };
    let Some(port) = port else {
        return json!({ "scheme": scheme, "host": host, "error": "no port" });
    };

    let t0 = Instant::now();
    let resolved: Result<Vec<SocketAddr>, String> = match timeout(
        PROBE_TIMEOUT,
        tokio::net::lookup_host((host.as_str(), port)),
    )
    .await
    {
        Ok(Ok(addrs)) => {
            let mut v: Vec<SocketAddr> = Vec::new();
            for a in addrs {
                if !v.contains(&a) {
                    v.push(a);
                }
            }
            Ok(v)
        }
        Ok(Err(_)) => Err("did not resolve".into()),
        Err(_) => Err(format!("no answer within {} s", PROBE_TIMEOUT.as_secs())),
    };
    let dns_ms = t0.elapsed().as_millis();
    let (dns, addrs) = match resolved {
        Ok(addrs) => {
            let ips: Vec<String> = addrs.iter().map(|a| a.ip().to_string()).collect();
            (json!({ "ok": true, "ms": dns_ms, "addresses": ips }), addrs)
        }
        Err(e) => (json!({ "ok": false, "ms": dns_ms, "error": e }), Vec::new()),
    };

    let tries = futures_util::future::join_all(addrs.iter().map(|addr| async move {
        let t1 = Instant::now();
        let result = timeout(PROBE_TIMEOUT, TcpStream::connect(addr)).await;
        let ms = t1.elapsed().as_millis();
        match result {
            Ok(Ok(_)) => json!({ "address": addr.to_string(), "ok": true, "ms": ms }),
            Ok(Err(e)) => json!({ "address": addr.to_string(), "ok": false, "ms": ms, "error": short_io(&e) }),
            Err(_) => json!({ "address": addr.to_string(), "ok": false, "ms": ms, "error": format!("no answer within {} s", PROBE_TIMEOUT.as_secs()) }),
        }
    }))
    .await;
    let tcp = if tries.is_empty() {
        Value::Null
    } else {
        tries
            .iter()
            .find(|t| t["ok"] == true)
            .unwrap_or(&tries[0])
            .clone()
    };
    json!({ "scheme": scheme, "host": host, "port": port, "dns": dns, "tcp": tcp, "tcpAll": tries })
}

fn default_port(scheme: &str) -> Option<u16> {
    Some(match scheme {
        "http" | "ws" => 80,
        "https" | "wss" => 443,
        "postgres" | "postgresql" => 5432,
        "mysql" => 3306,
        "mongodb" => 27017,
        "redis" => 6379,
        "rediss" => 6380,
        "pulsar" => 6650,
        "pulsar+ssl" => 6651,
        "clickhouse" => 8123,
        _ => return None,
    })
}

/// The hint for a refused certificate. A panel with a better one for its protocol replaces it.
pub const CERT_HINT: &str = "The server's certificate was not accepted (expired, self-signed, or for another name). The Diag panel's TLS check shows the certificate.";

const SECRET_WORDS: [&str; 10] = [
    "auth",
    "token",
    "key",
    "secret",
    "cookie",
    "session",
    "signature",
    "passw",
    "pwd",
    "credential",
];

/// Whether a header, query or parameter name carries a credential. The same rule as
/// `isSensitiveHeader` in the UI, plus `sig` as a whole name part (`x-sig`, `sig=`).
pub fn is_secret_name(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    SECRET_WORDS.iter().any(|w| n.contains(w)) || n.split(['-', '_', '.']).any(|part| part == "sig")
}

/// A libpq keyword string (`host=h password='p w'`) with credential values masked.
fn redact_keywords(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(eq) = rest.find('=') {
        let (before, after) = rest.split_at(eq);
        let key = before.rsplit(char::is_whitespace).next().unwrap_or("");
        out.push_str(before);
        out.push('=');
        let after = &after[1..];
        let value_at = after.len() - after.trim_start().len();
        out.push_str(&after[..value_at]);
        let after = &after[value_at..];
        let end = if after.starts_with('\'') {
            let b = after.as_bytes();
            let mut i = 1;
            while i < b.len() && b[i] != b'\'' {
                i += if b[i] == b'\\' { 2 } else { 1 };
            }
            (i + 1).min(after.len())
        } else {
            after.find(char::is_whitespace).unwrap_or(after.len())
        };
        let key = if key.is_empty() {
            before
                .trim_end()
                .rsplit(char::is_whitespace)
                .next()
                .unwrap_or("")
        } else {
            key
        };
        out.push_str(if is_secret_name(key) {
            "•••"
        } else {
            &after[..end]
        });
        rest = &after[end..];
    }
    out.push_str(rest);
    out
}

/// `raw` with the password in its user info and credential-looking query values masked, for a
/// connection string shown in a record or a log. A libpq keyword string is masked by key.
pub fn redact_url(raw: &str) -> String {
    let Ok(mut url) = url::Url::parse(raw) else {
        return redact_keywords(raw);
    };
    if url.password().is_some() {
        let _ = url.set_password(Some("•••"));
    }
    if url.query().is_some() {
        let pairs: Vec<(String, String)> = url
            .query_pairs()
            .map(|(k, v)| {
                let v = if is_secret_name(&k) {
                    "•••".to_string()
                } else {
                    v.into_owned()
                };
                (k.into_owned(), v)
            })
            .collect();
        url.query_pairs_mut().clear().extend_pairs(pairs);
    }
    url.to_string()
}

/// 198.18.0.0/15: the range proxies and VPNs hand out as stand-in addresses.
fn is_stand_in(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            o[0] == 198 && (o[1] == 18 || o[1] == 19)
        }
        IpAddr::V6(_) => false,
    }
}

/// What hint for a 401 or 403 answer, by whether any credential was sent.
pub fn refusal_hints(status: u16, sent: &HashMap<String, String>) -> Vec<String> {
    let has_credentials = sent.keys().any(|k| is_secret_name(k));
    match (status, has_credentials) {
        (401 | 403, true) => vec!["The server refused the credentials: check the Authorization (or cookie / token) header.".into()],
        (401, false) => vec!["The server wants credentials and none were sent: add an Authorization (or cookie / token) header.".into()],
        (403, false) => vec!["The server refused the request and no credentials were sent: it may need them, or it blocks this client by its access policy (some servers refuse requests without a browser-like User-Agent).".into()],
        _ => vec![],
    }
}

/// What a failed request was, for hints that depend on the protocol.
pub struct Target<'a> {
    pub method: &'a str,
    pub url: &'a str,
    pub headers: &'a HashMap<String, String>,
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Family {
    Http,
    Ws,
    GrpcWeb,
    Connect,
    Grpc,
    Kafka,
    Mongo,
    Postgres,
    Mysql,
    Redis,
    Pulsar,
    TlsCheck,
    Other,
}

fn family(t: &Target, scheme: &str) -> Family {
    let m = t.method.to_ascii_lowercase();
    let tagged = |w: &str| m.contains(&format!("({w}"));
    if tagged("kafka") {
        Family::Kafka
    } else if tagged("grpc-web") {
        Family::GrpcWeb
    } else if tagged("grpc") {
        Family::Grpc
    } else if tagged("mongodb") || scheme.starts_with("mongodb") {
        Family::Mongo
    } else if tagged("postgres") || scheme.starts_with("postgres") {
        Family::Postgres
    } else if tagged("mysql") || scheme == "mysql" {
        Family::Mysql
    } else if tagged("pulsar") || scheme.starts_with("pulsar") {
        Family::Pulsar
    } else if m == "tls" {
        Family::TlsCheck
    } else {
        match scheme {
            "redis" | "rediss" => Family::Redis,
            "ws" | "wss" => Family::Ws,
            "http" | "https"
                if t.headers
                    .keys()
                    .any(|k| k.eq_ignore_ascii_case("connect-protocol-version")) =>
            {
                Family::Connect
            }
            "http" | "https" => Family::Http,
            _ => Family::Other,
        }
    }
}

/// The fix when the server does not speak TLS where the client asked for it.
fn not_tls_fix(f: Family) -> &'static str {
    match f {
        Family::Http | Family::GrpcWeb | Family::Connect => {
            "it probably speaks plain HTTP on this port. Try http://"
        }
        Family::Ws => "it probably speaks plain WebSocket on this port. Try ws://",
        Family::Grpc => "it serves plaintext gRPC on this port. Tick Plaintext",
        Family::Kafka => {
            "this broker listener is plaintext. Untick SSL, or use the broker's SSL listener port"
        }
        Family::Mongo => {
            "remove tls=true or ssl=true from the URL, or use the port where MongoDB serves TLS"
        }
        Family::Postgres => "use sslmode=prefer (TLS when offered) or sslmode=disable",
        Family::Mysql => "use ssl-mode=PREFERRED (TLS when offered) or ssl-mode=DISABLED",
        Family::Redis => "use redis:// instead of rediss://",
        Family::Pulsar => "use pulsar:// (usually port 6650) instead of pulsar+ssl://",
        Family::TlsCheck => "this port speaks another protocol (plain HTTP, or the service's own)",
        Family::Other => "this port speaks another protocol",
    }
}

/// Plain-language hints for a failure of `kind`, from the chain and the probe.
pub fn hints(
    t: &Target,
    kind: &str,
    chain: &[String],
    probe: &Value,
    timeout_ms: u64,
) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let all = chain_text(chain);
    let url = url::Url::parse(t.url).ok();
    let scheme = url
        .as_ref()
        .map(|u| u.scheme().to_string())
        .unwrap_or_default();
    let explicit_port = url.as_ref().and_then(|u| u.port());
    let port = url.as_ref().and_then(|u| u.port_or_known_default());
    let fam = family(t, &scheme);
    let web = matches!(
        fam,
        Family::Http | Family::Ws | Family::GrpcWeb | Family::Connect
    );
    let mut specific = false;

    if fam == Family::TlsCheck && port == Some(80) {
        out.push(
            "Port 80 usually serves plain HTTP, not TLS: check port 443, or use the HTTP check."
                .into(),
        );
        specific = true;
    } else if web && (scheme == "https" || scheme == "wss") && explicit_port == Some(80) {
        let plain = if scheme == "wss" { "ws://" } else { "http://" };
        out.push(format!(
            "{scheme}:// to port 80: that port usually speaks plain HTTP. Try {plain}."
        ));
        specific = true;
    }
    if web && (scheme == "http" || scheme == "ws") && port == Some(443) {
        let tls = if scheme == "ws" { "wss://" } else { "https://" };
        out.push(format!(
            "{scheme}:// to port 443: that port usually speaks TLS. Try {tls}."
        ));
        specific = true;
    }

    let not_tls = kind == "tls"
        && [
            "invalidcontenttype",
            "wrong version number",
            "corrupt message",
            "plaintext broker",
            "packet length too long",
        ]
        .iter()
        .any(|w| all.contains(w));
    if not_tls && !specific {
        out.push(format!(
            "The server did not answer with TLS: {}.",
            not_tls_fix(fam)
        ));
        specific = true;
    } else if kind == "tls" && all.contains("handshake eof") && !specific {
        out.push(format!("The connection opened, then closed in the middle of the TLS handshake: the port does not speak TLS ({}), or something in between (a VPN, proxy or load balancer) dropped it.", not_tls_fix(fam)));
        specific = true;
    } else if kind == "tls"
        && ["certificate", "unknownissuer", "notvalidforname"]
            .iter()
            .any(|w| all.contains(w))
    {
        out.push(CERT_HINT.into());
        specific = true;
    }

    if all.contains("invalid http version") || all.contains("http/2") && all.contains("only") {
        let msg = match fam {
            Family::Connect => "This server speaks only HTTP/2 (a native gRPC server), not Connect: switch the call to gRPC.",
            Family::GrpcWeb => "This server speaks only HTTP/2 (a native gRPC server), not gRPC-Web: call it Direct to host:port instead of through a gateway.",
            _ => "The server answered in HTTP/2 framing to an HTTP/1.1 request: it speaks only HTTP/2 here, which is usually a gRPC server.",
        };
        out.push(msg.into());
        specific = true;
    }
    if fam == Family::Grpc
        && scheme == "http"
        && matches!(kind, "protocol" | "network")
        && !specific
    {
        out.push("The connection broke right after it opened. If this port serves TLS (443 usually does), untick Plaintext.".into());
        specific = true;
    }
    if fam == Family::Kafka
        && (all.contains("connecting to a ssl listener")
            || all.contains("incorrect security.protocol"))
    {
        out.push(
            "The broker expects TLS on this port: tick SSL, or use its plaintext listener port."
                .into(),
        );
        specific = true;
    }

    let tries: Vec<&Value> = probe["tcpAll"]
        .as_array()
        .map(|a| a.iter().collect())
        .unwrap_or_default();
    let tcp_ok = probe["tcp"]["ok"].as_bool();
    let refused = all.contains("refused")
        || probe["tcp"]["error"]
            .as_str()
            .is_some_and(|e| e.to_lowercase().contains("refused"));
    let ok_addrs: Vec<&str> = tries
        .iter()
        .filter(|r| r["ok"] == true)
        .filter_map(|r| r["address"].as_str())
        .collect();
    let bad_addrs: Vec<&str> = tries
        .iter()
        .filter(|r| r["ok"] == false)
        .filter_map(|r| r["address"].as_str())
        .collect();
    // only when the failure is about this port: a refusal elsewhere (a replica set member, say)
    // is not explained by this name's addresses
    let other_port = probe["port"]
        .as_u64()
        .is_some_and(|p| mentioned_ports(&all).iter().any(|&q| q != p));
    let mixed = !ok_addrs.is_empty() && !bad_addrs.is_empty() && kind == "connect" && !other_port;
    let stand_in = probe["dns"]["addresses"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str()?.parse::<IpAddr>().ok())
                .any(|ip| is_stand_in(&ip))
        })
        .unwrap_or(false);
    let instant_local = tcp_ok == Some(true)
        && probe["tcp"]["ms"].as_u64().is_some_and(|ms| ms <= 1)
        && probe["tcp"]["address"]
            .as_str()
            .and_then(|a| a.parse::<SocketAddr>().ok())
            .is_some_and(|a| !a.ip().is_loopback());
    if instant_local {
        out.push("The TCP connection opened in under 1 ms, too fast for a remote server: something on this machine (a VPN or proxy) accepted it on the server's behalf. Whether the request gets further depends on what that VPN or proxy routes.".into());
    }
    if stand_in {
        out.push("The name resolves to 198.18.x.x / 198.19.x.x, the range proxies and VPNs use as stand-in addresses: this request goes through that proxy or VPN, and only reaches what it routes.".into());
    }
    if mixed {
        let host = probe["host"].as_str().unwrap_or("the name");
        let ok_ip = ok_addrs[0]
            .rsplit_once(':')
            .map(|(h, _)| h.trim_matches(['[', ']']))
            .unwrap_or(ok_addrs[0]);
        out.push(format!(
            "{host} resolves to several addresses and only some accept connections ({} yes; {} no). The client may have used one that does not: connect to {ok_ip} instead of {host}.",
            ok_addrs.join(", "),
            bad_addrs.join(", ")
        ));
        specific = specific || kind == "connect";
    }

    if !specific {
        match kind {
            "dns" => out.push("The name did not resolve: check the spelling, the VPN, or the DNS server.".into()),
            "connect" if tcp_ok == Some(true) => out.push("The probe opened a TCP connection to that address, so the port is up now: the failure was in what came after, or brief. The cause below says which.".into()),
            "connect" if refused => out.push("Nothing accepts connections on that port (refused): a wrong port, or the service is down.".into()),
            "connect" => out.push("No route to the host: it is on a network this machine cannot reach (VPN, firewall, security group).".into()),
            "tls" if tcp_ok == Some(true) => out.push("The port accepts TCP connections, so the service is up: the failure is in the TLS layer above it. The cause below says why.".into()),
            "protocol" if tcp_ok == Some(true) => out.push("A TCP connection opened, then closed with no reply. Something in between (a proxy, VPN, firewall or load balancer) dropped it, or the server does not speak this protocol here. If the name goes through a VPN, the VPN may not route this network.".into()),
            "protocol" => out.push("The connection closed before a full reply arrived.".into()),
            "timeout" if tcp_ok == Some(false) => out.push(format!("No answer within {timeout_ms} ms, and the probe could not open a TCP connection either: the host is unreachable from here.")),
            "timeout" => out.push(format!("No complete answer within {timeout_ms} ms although the port accepts connections: the server is slow, or something in between holds the request. Raise the timeout to tell them apart.")),
            _ => {}
        }
    }
    if tcp_ok == Some(false) && !matches!(kind, "connect" | "timeout" | "dns") {
        out.push("The probe could not open a TCP connection to that address either.".into());
    }
    let mut seen: Vec<String> = Vec::new();
    out.retain(|h| {
        let fresh = !seen.contains(h);
        seen.push(h.clone());
        fresh
    });
    out
}

/// The ports `host:port` mentions in `text` name.
fn mentioned_ports(text: &str) -> Vec<u64> {
    let b = text.as_bytes();
    let mut out = Vec::new();
    for (i, _) in text.match_indices(':') {
        let before_ok = i > 0 && (b[i - 1].is_ascii_alphanumeric() || b[i - 1] == b']');
        let digits: String = text[i + 1..]
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        let after_ok = text[i + 1 + digits.len()..]
            .chars()
            .next()
            .map_or(true, |c| !c.is_ascii_alphanumeric());
        if before_ok && after_ok && (2..=5).contains(&digits.len()) {
            if let Ok(p) = digits.parse() {
                out.push(p);
            }
        }
    }
    out
}

/// A short headline for the failure; the chain keeps the details.
fn summary(kind: &str, chain: &[String], probe: &Value) -> String {
    let all = chain_text(chain);
    let host = probe["host"].as_str();
    let target = match (host, probe["port"].as_u64()) {
        (Some(h), Some(p)) if h.contains(':') => format!("[{h}]:{p}"),
        (Some(h), Some(p)) => format!("{h}:{p}"),
        (Some(h), None) => h.to_string(),
        _ => "the server".to_string(),
    };
    let tcp_ok = probe["tcp"]["ok"].as_bool() == Some(true);
    match kind {
        "dns" => format!("{} did not resolve", host.unwrap_or("the name")),
        "connect" if tcp_ok => format!("the connection to {target} failed after it opened"),
        "connect" if all.contains("refused") => format!("{target} refused the connection"),
        "connect" => format!("could not connect to {target}"),
        "tls"
            if [
                "invalidcontenttype",
                "wrong version number",
                "corrupt message",
            ]
            .iter()
            .any(|w| all.contains(w)) =>
        {
            format!("{target} did not answer with TLS")
        }
        "tls"
            if ["certificate", "unknownissuer", "notvalidforname"]
                .iter()
                .any(|w| all.contains(w)) =>
        {
            format!("the certificate of {target} was not accepted")
        }
        "tls" => format!("the TLS handshake with {target} failed"),
        "protocol" => format!("the connection to {target} broke before a full reply"),
        "body" => "the response body could not be read completely".into(),
        _ => chain.last().cloned().unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(s: &[&str]) -> Vec<String> {
        s.iter().map(|x| x.to_string()).collect()
    }

    fn http(url: &str) -> Target<'static> {
        static NONE: once_cell::sync::Lazy<HashMap<String, String>> =
            once_cell::sync::Lazy::new(HashMap::new);
        Target {
            method: "GET",
            url: Box::leak(url.to_string().into_boxed_str()),
            headers: &NONE,
        }
    }

    #[test]
    fn a_chain_keeps_every_cause_once_outermost_first() {
        let inner = std::io::Error::new(
            std::io::ErrorKind::ConnectionReset,
            "connection reset by peer",
        );
        let outer = std::io::Error::other(inner);
        let c = chain(&outer);
        assert_eq!(c, vec!["connection reset by peer".to_string()]);
    }

    #[test]
    fn an_outer_layer_that_repeats_its_cause_keeps_only_its_own_words() {
        let c = tidy(strings(&[
            "error trying to connect: tcp connect error: Connection refused",
            "tcp connect error: Connection refused",
            "Connection refused",
            "connection refused",
            "",
        ]));
        assert_eq!(
            c,
            strings(&[
                "error trying to connect",
                "tcp connect error",
                "Connection refused"
            ])
        );
    }

    #[test]
    fn certificate_times_are_dates_not_unix_seconds() {
        let now = Utc::now().timestamp();
        let after = now - 3 * 86_400;
        let raw = format!("invalid peer certificate: certificate expired: verification time {now} (UNIX), but certificate is not valid after {after} ({} seconds ago)", now - after);
        let c = tidy(vec![raw]);
        assert!(
            c[0].starts_with("invalid peer certificate: certificate expired: it was valid until "),
            "{c:?}"
        );
        assert!(
            c[0].ends_with("(3 days ago)") && !c[0].contains("UNIX"),
            "{c:?}"
        );
        assert_eq!(relative(-2 * 3600), "in 2 hours");
        assert_eq!(relative(1), "1 second ago");
    }

    #[test]
    fn kinds_come_from_the_whole_chain() {
        let k = |s: &[&str]| kind(&strings(s), false);
        assert_eq!(
            k(&[
                "error sending request",
                "dns error",
                "failed to lookup address information"
            ]),
            "dns"
        );
        assert_eq!(
            k(&[
                "error sending request",
                "invalid peer certificate: UnknownIssuer"
            ]),
            "tls"
        );
        assert_eq!(
            k(&[
                "error sending request",
                "tcp connect error",
                "Connection refused (os error 61)"
            ]),
            "connect"
        );
        assert_eq!(
            k(&[
                "error sending request",
                "connection closed before message completed"
            ]),
            "protocol"
        );
        assert_eq!(
            k(&["connection timed out: no answer within 10 s"]),
            "timeout"
        );
        assert_eq!(k(&["Meta data fetch error: BrokerTransportFailure (Local: Broker transport failure)"]), "connect");
        assert_eq!(
            k(&[
                "BrokerTransportFailure",
                "ssl://b:9093/bootstrap: SSL handshake failed: certificate verify failed"
            ]),
            "tls"
        );
        assert_eq!(
            k(&[
                "BrokerTransportFailure",
                "Connect to ipv6#[::1]:9092 failed: Connection refused",
                "SSL handshake failed: Disconnected: connecting to a PLAINTEXT broker listener?"
            ]),
            "tls"
        );
        assert_eq!(kind(&[], true), "timeout");
    }

    #[test]
    fn a_url_in_the_chain_does_not_decide_the_kind() {
        let c = strings(&[
            "error sending request for url (https://tls.handshake.test/certificate)",
            "tcp connect error",
            "Connection refused",
        ]);
        assert_eq!(kind(&c, false), "connect");
        let c = strings(&[
            "error sending request for url (https://tls.test/)",
            "connection closed before message completed",
        ]);
        assert_eq!(kind(&c, false), "protocol");
    }

    #[test]
    fn a_reqwest_error_without_its_url_keeps_no_secret() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let e = rt
            .block_on(
                reqwest::Client::new()
                    .get("http://u:pw@127.0.0.1:9/x?token=s3cret")
                    .send(),
            )
            .unwrap_err();
        assert!(
            describe(&e).contains("s3cret"),
            "the leak this guards against"
        );
        let c = chain(&e.without_url());
        assert!(!c.join(" ").contains("s3cret"), "{c:?}");
        assert_eq!(kind(&c, false), "connect");
    }

    #[test]
    fn a_connection_string_keeps_its_host_and_loses_its_password() {
        let r = redact_url("postgres://app:s3cret@db.test:5432/main?sslmode=require&password=x");
        assert!(!r.contains("s3cret") && !r.contains("password=x"), "{r}");
        assert!(
            r.contains("db.test:5432/main") && r.contains("sslmode=require"),
            "{r}"
        );
        assert_eq!(
            redact_url("redis://cache.test:6379"),
            "redis://cache.test:6379"
        );
        assert_eq!(redact_url("not a url"), "not a url");
        let at = redact_url("postgres://app:p@ss@db.test/main");
        assert!(!at.contains("ss@") && at.contains("@db.test/main"), "{at}");
    }

    #[test]
    fn one_word_list_covers_every_credential_name() {
        for n in [
            "Authorization",
            "x-api-key",
            "apikey",
            "api_key",
            "access_token",
            "client_secret",
            "Cookie",
            "session_id",
            "x-hub-signature-256",
            "x-sig",
            "sig",
            "password",
            "passwd",
            "pwd",
        ] {
            assert!(is_secret_name(n), "{n}");
        }
        for n in ["content-type", "design", "signal", "user"] {
            assert!(!is_secret_name(n), "{n}");
        }
        let r = redact_url("https://h.test/x?sig=abc&session=def&api_key=k&page=2");
        assert!(
            !r.contains("abc") && !r.contains("def") && !r.contains("=k"),
            "{r}"
        );
        assert!(r.contains("page=2"), "{r}");
    }

    #[test]
    fn schemes_without_a_port_use_their_own_default() {
        assert_eq!(default_port("postgres"), Some(5432));
        assert_eq!(default_port("pulsar+ssl"), Some(6651));
        assert_eq!(default_port("tcp"), None);
    }

    #[test]
    fn a_keyword_connection_string_is_probed_at_its_host_and_port() {
        assert_eq!(
            probe_target("host=db.test port=6543 user=u password=p").unwrap(),
            ("postgres".into(), "db.test".into(), Some(6543))
        );
        assert_eq!(probe_target("dbname=x host = h").unwrap().2, Some(5432));
        assert_eq!(probe_target("user=u").unwrap().1, "localhost");
        assert!(probe_target("host=/var/run/postgresql").is_err());
        assert_eq!(
            probe_target("b1:9092").unwrap(),
            ("tcp".into(), "b1".into(), Some(9092))
        );
    }

    #[tokio::test]
    async fn every_resolved_address_is_tried_and_any_success_counts() {
        let v4 = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = v4.local_addr().unwrap().port();
        let p = probe(&format!("http://localhost:{port}/")).await;
        let tries = p["tcpAll"].as_array().unwrap();
        assert!(
            tries
                .iter()
                .any(|t| t["address"] == format!("127.0.0.1:{port}") && t["ok"] == true),
            "{p}"
        );
        assert_eq!(p["tcp"]["ok"], true, "{p}");
        assert_eq!(p["tcp"]["address"], format!("127.0.0.1:{port}"));
    }

    #[test]
    fn a_name_where_only_some_addresses_answer_says_which_to_use() {
        let probe = json!({
            "host": "localhost", "port": 9092,
            "tcp": { "ok": true, "address": "127.0.0.1:9092", "ms": 0 },
            "tcpAll": [
                { "address": "[::1]:9092", "ok": false, "error": "connection refused" },
                { "address": "127.0.0.1:9092", "ok": true },
            ],
        });
        let t = Target {
            method: "METADATA (Kafka)",
            url: "localhost:9092",
            headers: &HashMap::new(),
        };
        let h = hints(
            &t,
            "connect",
            &strings(&["Connect to ipv6#[::1]:9092 failed: Connection refused"]),
            &probe,
            1000,
        );
        assert!(
            h.iter()
                .any(|s| s.contains("connect to 127.0.0.1 instead of localhost")),
            "{h:?}"
        );
        assert!(!h.iter().any(|s| s.contains("Nothing accepts")), "{h:?}");
    }

    #[test]
    fn a_refusal_on_another_port_is_not_blamed_on_this_names_addresses() {
        let probe = json!({
            "host": "localhost", "port": 27018,
            "tcp": { "ok": true },
            "tcpAll": [
                { "address": "[::1]:27018", "ok": false, "error": "connection refused" },
                { "address": "127.0.0.1:27018", "ok": true },
            ],
        });
        let t = Target {
            method: "SCHEMA (mongodb)",
            url: "mongodb://localhost:27018/",
            headers: &HashMap::new(),
        };
        let h = hints(
            &t,
            "connect",
            &strings(&["localhost:27017: I/O error: Connection refused (os error 61)"]),
            &probe,
            1000,
        );
        assert!(!h.iter().any(|s| s.contains("several addresses")), "{h:?}");
        assert_eq!(
            mentioned_ports("connect to [::1]:9092 and b:1234 (os error 61)"),
            vec![9092, 1234]
        );
    }

    #[tokio::test]
    async fn a_failures_duration_stops_before_the_probe() {
        let attempt = Attempt::start(
            "GET",
            "http://10.255.255.1:9/",
            HashMap::new(),
            Value::Null,
            0,
        );
        let (_, log) = attempt
            .failed_with("network", vec!["refused".into()], false, 1000)
            .await;
        assert!(
            log["durationMs"].as_u64().unwrap() < 500,
            "{}",
            log["durationMs"]
        );
        assert_eq!(
            attempt.elapsed_ms() as u64,
            log["durationMs"].as_u64().unwrap()
        );
    }

    #[tokio::test]
    async fn the_headline_is_a_summary_not_the_last_cause() {
        let attempt = Attempt::start("GET", "http://127.0.0.1:9/", HashMap::new(), Value::Null, 0);
        let c = strings(&[
            "error sending request",
            "tcp connect error",
            "Connection refused (os error 61)",
        ]);
        let (error, _) = attempt.failed_with("network", c.clone(), false, 1000).await;
        assert_eq!(error["message"], "127.0.0.1:9 refused the connection");
        assert_eq!(error["chain"], json!(c));
    }

    #[test]
    fn a_record_never_holds_a_password_from_its_url() {
        let a = Attempt::start(
            "GET",
            "https://u:s3cret@h.test/x?token=t",
            HashMap::new(),
            Value::Null,
            0,
        );
        let log = a.not_sent("request", "x").1;
        let url = log["url"].as_str().unwrap();
        assert!(!url.contains("s3cret") && !url.contains("token=t"), "{url}");
    }

    #[test]
    fn a_server_refusal_is_not_probed() {
        let a = Attempt::start(
            "QUERY",
            "postgres://h.test/db",
            HashMap::new(),
            Value::Null,
            0,
        );
        let (error, _) = a.server_refused(
            "query",
            vec!["syntax error at or near \"SELEC\"".into()],
            "database",
        );
        assert_eq!(error["kind"], "database");
        assert!(error["probe"].is_null());
    }

    #[test]
    fn https_to_a_plain_port_is_named_once() {
        let h = hints(
            &http("https://example.test:80/x"),
            "tls",
            &strings(&["received corrupt message of type InvalidContentType"]),
            &json!({}),
            1000,
        );
        assert_eq!(
            h.iter().filter(|s| s.contains("Try http://")).count(),
            1,
            "{h:?}"
        );
    }

    #[test]
    fn tls_to_a_plain_port_is_hinted_in_the_protocols_own_terms() {
        let corrupt = strings(&["received corrupt message of type InvalidContentType"]);
        let none = HashMap::new();
        let mongo = Target {
            method: "QUERY (mongodb)",
            url: "mongodb://h.test:27017/?tls=true",
            headers: &none,
        };
        let h = hints(&mongo, "tls", &corrupt, &json!({}), 1000);
        assert!(
            h.iter().any(|s| s.contains("tls=true")) && !h.iter().any(|s| s.contains("http://")),
            "{h:?}"
        );
        let kafka = Target {
            method: "METADATA (Kafka)",
            url: "b.test:9092",
            headers: &none,
        };
        let h = hints(
            &kafka,
            "tls",
            &strings(&["SSL handshake failed: wrong version number"]),
            &json!({}),
            1000,
        );
        assert!(h.iter().any(|s| s.contains("Untick SSL")), "{h:?}");
        let diag = Target {
            method: "TLS",
            url: "https://h.test:80",
            headers: &none,
        };
        let h = hints(&diag, "tls", &corrupt, &json!({}), 1000);
        assert_eq!(h, vec!["Port 80 usually serves plain HTTP, not TLS: check port 443, or use the HTTP check.".to_string()]);
    }

    #[test]
    fn grpc_hints_name_the_switch_to_flip() {
        let none = HashMap::new();
        let mut connect = HashMap::new();
        connect.insert("connect-protocol-version".to_string(), "1".to_string());
        let c = strings(&["error sending request", "invalid HTTP version parsed"]);
        let t = Target {
            method: "POST",
            url: "http://h.test:50051/a.B/C",
            headers: &connect,
        };
        let h = hints(&t, "protocol", &c, &json!({ "tcp": { "ok": true } }), 1000);
        assert!(
            h[0].contains("not Connect: switch the call to gRPC"),
            "{h:?}"
        );
        assert!(!h.iter().any(|s| s.contains("VPN")), "{h:?}");
        let direct = Target {
            method: "POST (gRPC)",
            url: "http://h.test:443/a.B/C",
            headers: &none,
        };
        let h = hints(
            &direct,
            "protocol",
            &strings(&["transport error", "connection reset"]),
            &json!({ "tcp": { "ok": true } }),
            1000,
        );
        assert!(h.iter().any(|s| s.contains("untick Plaintext")), "{h:?}");
        let tls = Target {
            method: "POST (gRPC)",
            url: "https://h.test:50051/a.B/C",
            headers: &none,
        };
        let h = hints(
            &tls,
            "tls",
            &strings(&["received corrupt message of type InvalidContentType"]),
            &json!({}),
            1000,
        );
        assert!(h.iter().any(|s| s.contains("Tick Plaintext")), "{h:?}");
    }

    #[test]
    fn a_refusal_without_credentials_does_not_blame_them() {
        let mut sent = HashMap::new();
        sent.insert("accept".to_string(), "text/event-stream".to_string());
        assert!(refusal_hints(403, &sent)[0].contains("no credentials were sent"));
        sent.insert("authorization".to_string(), "Bearer x".to_string());
        assert!(refusal_hints(403, &sent)[0].contains("refused the credentials"));
        assert!(refusal_hints(500, &sent).is_empty());
    }

    #[test]
    fn an_instant_connection_points_at_a_local_vpn_or_proxy() {
        let h = hints(
            &http("https://example.test/x"),
            "tls",
            &strings(&["tls handshake eof"]),
            &json!({ "tcp": { "ok": true, "ms": 0, "address": "197.19.0.57:443" } }),
            1000,
        );
        assert!(h.iter().any(|s| s.contains("TLS handshake")), "{h:?}");
        assert!(h.iter().any(|s| s.contains("under 1 ms")), "{h:?}");
        let local = hints(
            &http("http://localhost/x"),
            "protocol",
            &[],
            &json!({ "tcp": { "ok": true, "ms": 0, "address": "127.0.0.1:80" } }),
            1000,
        );
        assert!(
            !local.iter().any(|s| s.contains("under 1 ms")),
            "loopback is meant to be instant"
        );
    }

    #[test]
    fn a_connection_closed_after_tcp_opened_points_at_what_is_in_between() {
        let h = hints(
            &http("http://example.test/x"),
            "protocol",
            &strings(&["connection closed before message completed"]),
            &json!({ "tcp": { "ok": true }, "dns": { "addresses": ["198.18.0.7"] } }),
            1000,
        );
        assert!(h.iter().any(|s| s.contains("stand-in")), "{h:?}");
        assert!(h.iter().any(|s| s.contains("in between")), "{h:?}");
    }

    #[test]
    fn a_refused_probe_names_the_refusal_when_the_client_does_not() {
        let chain = strings(&["BrokerTransportFailure (Local: Broker transport failure)"]);
        let refused = json!({ "tcp": { "ok": false, "error": "connection refused" } });
        let t = Target {
            method: "METADATA (Kafka)",
            url: "127.0.0.1:1",
            headers: &HashMap::new(),
        };
        let h = hints(&t, "connect", &chain, &refused, 1000);
        assert!(h.iter().any(|s| s.contains("refused")), "{h:?}");
        assert!(!h.iter().any(|s| s.contains("No route")), "{h:?}");
    }

    #[test]
    fn a_websocket_close_is_not_tls() {
        let chain =
            strings(&["WebSocket protocol error: Connection reset without closing handshake"]);
        assert_eq!(kind(&chain, false), "protocol");
        assert_eq!(kind(&strings(&["tls handshake eof"]), false), "tls");
    }

    #[test]
    fn keyword_connection_strings_are_redacted() {
        assert_eq!(
            redact_url("host=h user=u password=s3cret dbname=d"),
            "host=h user=u password=••• dbname=d"
        );
        assert_eq!(
            redact_url(r"host=h password = 'a \' b' port=1"),
            "host=h password = ••• port=1"
        );
        assert_eq!(redact_url("127.0.0.1:6379"), "127.0.0.1:6379");
    }
}
