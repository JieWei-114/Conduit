use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::{routing::post, Json, Router};
use hickory_resolver::config::{ResolverConfig, ResolverOpts};
use hickory_resolver::error::{ResolveError, ResolveErrorKind};
use hickory_resolver::proto::op::ResponseCode;
use hickory_resolver::TokioAsyncResolver;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio::time::timeout;

use super::attempt::{self, Attempt, Reply};

const TCP_TIMEOUT_MS: u64 = 5000;
const TLS_TIMEOUT_MS: u64 = 8000;
const PING_TIMEOUT_MS: u64 = 8000;

pub fn routes() -> Router {
    Router::new()
        .route("/tcp", post(tcp))
        .route("/tls", post(tls))
        .route("/dns", post(dns))
        .route("/ping", post(ping))
}

#[derive(Deserialize)]
struct TcpReq {
    host: Option<String>,
    port: Option<u16>,
}

async fn tcp(Json(req): Json<TcpReq>) -> Json<Value> {
    let host = req.host.unwrap_or_default();
    let host = host.trim();
    let port = req.port.unwrap_or(0);
    if host.is_empty() || port == 0 {
        return Json(json!({ "ok": false, "error": "host and port required" }));
    }
    let addr = host_port(host, port);
    let t0 = Instant::now();
    let att = Attempt::start("TCP", &format!("tcp://{addr}"), HashMap::new(), Value::Null, 0);
    match timeout(Duration::from_millis(TCP_TIMEOUT_MS), TcpStream::connect(&addr)).await {
        Ok(Ok(_)) => Json(json!({ "ok": true, "open": true, "ms": t0.elapsed().as_millis() })),
        Ok(Err(e)) => {
            let (detail, log) = att.failed("connect", &e, false, TCP_TIMEOUT_MS).await;
            Json(json!({ "ok": true, "open": false, "ms": att.elapsed_ms(), "error": attempt::describe(&e), "detail": detail, "log": log }))
        }
        Err(_) => {
            let ms = t0.elapsed().as_millis();
            let (detail, log) = att
                .failed_with("timeout", vec![format!("no TCP connection within {TCP_TIMEOUT_MS} ms")], true, TCP_TIMEOUT_MS)
                .await;
            Json(json!({ "ok": true, "open": false, "ms": ms, "error": "timeout", "detail": detail, "log": log }))
        }
    }
}

/// `host:port`, with an IPv6 literal in brackets.
fn host_port(host: &str, port: u16) -> String {
    let h = host.trim_matches(['[', ']']);
    if h.contains(':') {
        format!("[{h}]:{port}")
    } else {
        format!("{h}:{port}")
    }
}

#[derive(Deserialize)]
struct TlsReq {
    host: Option<String>,
    port: Option<u16>,
}

async fn tls(Json(req): Json<TlsReq>) -> Json<Value> {
    let host = req.host.unwrap_or_default();
    let host = host.trim().to_string();
    if host.is_empty() {
        return Json(json!({ "ok": false, "error": "host required" }));
    }
    let port = req.port.unwrap_or(443);
    let t0 = Instant::now();
    let target = format!("https://{}", host_port(&host, port));
    let att = Attempt::start("TLS", &target, HashMap::new(), Value::Null, 0);
    match timeout(Duration::from_millis(TLS_TIMEOUT_MS), tls_probe(host.clone(), port)).await {
        Ok(Ok(mut v)) => {
            v["ms"] = json!(t0.elapsed().as_millis());
            Json(v)
        }
        Ok(Err((stage, chain))) => {
            let message = chain.join(": ");
            let (detail, log) = att.failed_with(stage, chain, false, TLS_TIMEOUT_MS).await;
            Json(json!({ "ok": false, "stage": stage, "error": message, "detail": detail, "log": log, "ms": att.elapsed_ms() }))
        }
        Err(_) => {
            let (detail, log) = att
                .failed_with("timeout", vec![format!("no TLS handshake within {TLS_TIMEOUT_MS} ms")], true, TLS_TIMEOUT_MS)
                .await;
            Json(json!({ "ok": false, "stage": "timeout", "error": "timeout", "detail": detail, "log": log, "ms": att.elapsed_ms() }))
        }
    }
}

/// Where a TLS check stopped, and the cause chain.
type TlsFailure = (&'static str, Vec<String>);

async fn tls_probe(host: String, port: u16) -> Result<Value, TlsFailure> {
    use tokio_rustls::rustls::pki_types::ServerName;
    use tokio_rustls::rustls::{ClientConfig, RootCertStore};
    use tokio_rustls::TlsConnector;

    let t0 = Instant::now();
    let stream = TcpStream::connect(host_port(&host, port))
        .await
        .map_err(|e| ("connect", attempt::chain(&e)))?;
    let tcp_ms = t0.elapsed().as_millis();

    // Accept any cert so it can always be inspected; trust is judged separately below.
    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let config = ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(AcceptAll))
        .with_no_client_auth();

    let bare = host.trim_matches(['[', ']']).to_string();
    let server_name =
        ServerName::try_from(bare.clone()).map_err(|e| ("request", attempt::chain(&e)))?;
    let connector = TlsConnector::from(Arc::new(config));
    let t1 = Instant::now();
    let conn = connector
        .connect(server_name, stream)
        .await
        .map_err(|e| ("handshake", attempt::chain(&e)))?;
    let handshake_ms = t1.elapsed().as_millis();

    let (_, tls_state) = conn.get_ref();
    let protocol = tls_state
        .protocol_version()
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let certs = tls_state
        .peer_certificates()
        .ok_or_else(|| ("handshake", vec!["no peer certificate".to_string()]))?;
    let leaf = certs
        .first()
        .ok_or_else(|| ("handshake", vec!["empty certificate chain".to_string()]))?;

    // Verified against the Mozilla root list bundled in conduit (webpki-roots), not the OS store.
    let (authorized, auth_error) = verify_chain(&roots, certs, &bare);

    let mut v = parse_cert(leaf.as_ref(), authorized, auth_error)
        .map_err(|e| ("certificate", vec![e]))?;
    v["tcpMs"] = json!(tcp_ms);
    v["handshakeMs"] = json!(handshake_ms);
    v["protocol"] = json!(protocol);
    v["chainLength"] = json!(certs.len());
    v["trustStore"] = json!("Mozilla root list (webpki-roots)");
    Ok(v)
}

fn verify_chain(
    roots: &tokio_rustls::rustls::RootCertStore,
    certs: &[tokio_rustls::rustls::pki_types::CertificateDer<'_>],
    host: &str,
) -> (bool, String) {
    use tokio_rustls::rustls::client::verify_server_cert_signed_by_trust_anchor;
    use tokio_rustls::rustls::client::verify_server_name;
    use tokio_rustls::rustls::server::ParsedCertificate;
    use tokio_rustls::rustls::pki_types::{ServerName, UnixTime};

    let leaf = match ParsedCertificate::try_from(&certs[0]) {
        Ok(p) => p,
        Err(e) => return (false, super::attempt::describe(&e)),
    };
    let now = UnixTime::now();
    let algs = rustls::crypto::ring::default_provider()
        .signature_verification_algorithms
        .all;
    if let Err(e) =
        verify_server_cert_signed_by_trust_anchor(&leaf, roots, &certs[1..], now, algs)
    {
        return (false, super::attempt::describe(&e));
    }
    if let Ok(sn) = ServerName::try_from(host.to_string()) {
        if let Err(e) = verify_server_name(&leaf, &sn) {
            return (false, super::attempt::describe(&e));
        }
    }
    (true, String::new())
}

fn parse_cert(der: &[u8], authorized: bool, auth_error: String) -> Result<Value, String> {
    use x509_parser::prelude::*;

    let (_, cert) = X509Certificate::from_der(der).map_err(|e| super::attempt::describe(&e))?;
    let subject = cert
        .subject()
        .iter_common_name()
        .next()
        .and_then(|a| a.as_str().ok())
        .map(str::to_string)
        .unwrap_or_else(|| cert.subject().to_string());
    let issuer = cert
        .issuer()
        .iter_common_name()
        .next()
        .and_then(|a| a.as_str().ok())
        .unwrap_or("")
        .to_string();

    let not_before = cert.validity().not_before;
    let not_after = cert.validity().not_after;
    let valid_from = not_before.to_rfc2822().unwrap_or_default();
    let valid_to = not_after.to_rfc2822().unwrap_or_default();

    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days_left = (not_after.timestamp() - now_secs) / 86400;

    let mut alt_names = Vec::new();
    if let Ok(Some(san)) = cert.subject_alternative_name() {
        for name in &san.value.general_names {
            if let GeneralName::DNSName(d) = name {
                alt_names.push(format!("DNS:{d}"));
            }
        }
    }

    Ok(json!({
        "ok": true,
        "subject": subject,
        "issuer": issuer,
        "validFrom": valid_from,
        "validTo": valid_to,
        "validFromIso": iso(not_before.timestamp()),
        "validToIso": iso(not_after.timestamp()),
        "validToRelative": attempt::relative(now_secs - not_after.timestamp()),
        "daysLeft": days_left,
        "altNames": alt_names.join(", "),
        "authorized": authorized,
        "authError": auth_error,
    }))
}

fn iso(secs: i64) -> Option<String> {
    chrono::DateTime::from_timestamp(secs, 0).map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
}

#[derive(Debug)]
struct AcceptAll;

impl tokio_rustls::rustls::client::danger::ServerCertVerifier for AcceptAll {
    fn verify_server_cert(
        &self,
        _end_entity: &tokio_rustls::rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[tokio_rustls::rustls::pki_types::CertificateDer<'_>],
        _server_name: &tokio_rustls::rustls::pki_types::ServerName<'_>,
        _ocsp: &[u8],
        _now: tokio_rustls::rustls::pki_types::UnixTime,
    ) -> Result<tokio_rustls::rustls::client::danger::ServerCertVerified, tokio_rustls::rustls::Error>
    {
        Ok(tokio_rustls::rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &tokio_rustls::rustls::pki_types::CertificateDer<'_>,
        _dss: &tokio_rustls::rustls::DigitallySignedStruct,
    ) -> Result<tokio_rustls::rustls::client::danger::HandshakeSignatureValid, tokio_rustls::rustls::Error>
    {
        Ok(tokio_rustls::rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &tokio_rustls::rustls::pki_types::CertificateDer<'_>,
        _dss: &tokio_rustls::rustls::DigitallySignedStruct,
    ) -> Result<tokio_rustls::rustls::client::danger::HandshakeSignatureValid, tokio_rustls::rustls::Error>
    {
        Ok(tokio_rustls::rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<tokio_rustls::rustls::SignatureScheme> {
        use tokio_rustls::rustls::SignatureScheme::*;
        vec![
            RSA_PKCS1_SHA256,
            RSA_PKCS1_SHA384,
            RSA_PKCS1_SHA512,
            ECDSA_NISTP256_SHA256,
            ECDSA_NISTP384_SHA384,
            RSA_PSS_SHA256,
            RSA_PSS_SHA384,
            RSA_PSS_SHA512,
            ED25519,
        ]
    }
}

#[derive(Deserialize)]
struct DnsReq {
    host: Option<String>,
}

async fn dns(Json(req): Json<DnsReq>) -> Json<Value> {
    let host = req.host.unwrap_or_default();
    let host = host.trim().to_string();
    if host.is_empty() {
        return Json(json!({ "ok": false, "error": "host required" }));
    }
    // The machine's own resolver settings, so internal names resolve as they do for other
    // programs; public DNS only when those settings cannot be read.
    let (resolver, resolver_name) = match TokioAsyncResolver::tokio_from_system_conf() {
        Ok(r) => (r, "system DNS servers"),
        Err(_) => (
            TokioAsyncResolver::tokio(ResolverConfig::default(), ResolverOpts::default()),
            "Google public DNS (system settings unreadable)",
        ),
    };

    let att = Attempt::start("DNS", &format!("dns://{host}"), HashMap::new(), Value::Null, 0);
    let fqdn = absolute(&host);
    // every record type and this machine's own lookup at once: a slow or failing server costs
    // one timeout, not one per type
    let (a, aaaa, cname, mx, os) = tokio::join!(
        resolver.ipv4_lookup(fqdn.as_str()),
        resolver.ipv6_lookup(fqdn.as_str()),
        resolver.lookup(fqdn.as_str(), hickory_resolver::proto::rr::RecordType::CNAME),
        resolver.mx_lookup(fqdn.as_str()),
        // what programs on this machine get (hosts file, VPN split DNS, mDNS included)
        timeout(Duration::from_secs(5), tokio::net::lookup_host((host.as_str(), 0))),
    );

    let mut errors: HashMap<&str, Value> = HashMap::new();
    let mut take = |ty: &'static str, r: Result<Vec<Value>, ResolveError>| match r {
        Ok(v) => v,
        Err(e) => {
            let err = lookup_error(&e);
            // most names have no CNAME: that is an answer, not a failure
            if !(ty == "CNAME" && matches!(err["code"].as_str(), Some("NODATA" | "NXDOMAIN"))) {
                errors.insert(ty, err);
            }
            vec![]
        }
    };
    let a = take("A", a.map(|r| r.iter().map(|ip| json!(ip.to_string())).collect()));
    let aaaa = take("AAAA", aaaa.map(|r| r.iter().map(|ip| json!(ip.to_string())).collect()));
    let cname = take(
        "CNAME",
        cname.map(|r| r.iter().filter_map(|d| d.as_cname().map(|c| json!(c.to_utf8()))).collect()),
    );
    let mx = take(
        "MX",
        mx.map(|r| {
            r.iter()
                .map(|m| json!({ "exchange": m.exchange().to_utf8(), "priority": m.preference() }))
                .collect()
        }),
    );
    let os = match os {
        Ok(Ok(addrs)) => json!({ "ok": true, "addresses": unique_ips(addrs.map(|a| a.ip().to_string())) }),
        Ok(Err(e)) => json!({ "ok": false, "error": attempt::describe(&e) }),
        Err(_) => json!({ "ok": false, "error": "no answer within 5 s" }),
    };

    let (ok, error) = dns_verdict(
        !a.is_empty() || !aaaa.is_empty() || !cname.is_empty(),
        os["ok"].as_bool() == Some(true),
        &errors,
    );
    let (detail, log) = if ok {
        (Value::Null, Value::Null)
    } else {
        let (mut detail, mut log) = att.server_refused("dns", dns_chain(&errors, &os), "dns");
        detail["message"] = error.clone();
        detail["hints"] = json!([dns_advice(&errors)]);
        log["error"] = detail.clone();
        (detail, log)
    };
    Json(json!({
        "ok": ok,
        "error": error,
        "detail": detail,
        "log": log,
        "ms": att.elapsed_ms(),
        "resolver": resolver_name,
        "A": a, "AAAA": aaaa, "CNAME": cname, "MX": mx,
        "errors": errors,
        "os": os,
    }))
}

/// `host` as an absolute name (`example.com.`), so the resolver never appends a search domain.
/// An IP literal is left as it is.
fn absolute(host: &str) -> String {
    if host.ends_with('.') || host.parse::<std::net::IpAddr>().is_ok() {
        host.to_string()
    } else {
        format!("{host}.")
    }
}

/// Addresses in order without repeats (`dedup` alone only drops neighbours).
fn unique_ips(ips: impl Iterator<Item = String>) -> Vec<String> {
    let mut v: Vec<String> = ips.collect();
    v.sort();
    v.dedup();
    v
}

/// What each lookup said, record types with the same answer on one line (`A, AAAA: NXDOMAIN`),
/// and one line for this machine's resolver.
fn dns_chain(errors: &HashMap<&str, Value>, os: &Value) -> Vec<String> {
    let mut lines: Vec<(Vec<&str>, String)> = Vec::new();
    for t in ["A", "AAAA", "CNAME"] {
        let Some(e) = errors.get(t) else { continue };
        let said = format!("{} {}", e["code"].as_str().unwrap_or(""), e["message"].as_str().unwrap_or("")).trim().to_string();
        match lines.iter_mut().find(|(_, s)| *s == said) {
            Some((types, _)) => types.push(t),
            None => lines.push((vec![t], said)),
        }
    }
    let mut out: Vec<String> = lines.into_iter().map(|(types, said)| format!("{}: {said}", types.join(", "))).collect();
    if let Some(e) = os["error"].as_str() {
        out.push(format!("this machine's resolver: {e}"));
    }
    out
}

/// The next thing worth trying when a name did not resolve, from the A (else AAAA) code.
fn dns_advice(errors: &HashMap<&str, Value>) -> String {
    let code = ["A", "AAAA"]
        .iter()
        .find_map(|t| errors.get(t).and_then(|e| e["code"].as_str()))
        .unwrap_or("");
    match code {
        "NXDOMAIN" => "No such name in DNS. Check the spelling, and whether the name is internal-only and needs a VPN or a private resolver.",
        "NODATA" => "The name exists but has no address records. It may only carry records this lookup does not request.",
        "SERVFAIL" | "REFUSED" | "TIMEOUT" => "The DNS server itself failed to answer. Retry, then check the DNS servers this machine uses (and the VPN, if the name is internal).",
        _ => "Enter a bare hostname without a scheme or path, for example api.example.com.",
    }
    .to_string()
}

/// One failed lookup: the code (`NXDOMAIN`: the name does not exist; `NODATA`: it exists
/// without records of this type; `SERVFAIL`, `REFUSED`, `TIMEOUT`, `ERROR`) and the message.
fn lookup_error(e: &ResolveError) -> Value {
    let code = match e.kind() {
        ResolveErrorKind::NoRecordsFound { response_code, .. } => match response_code {
            ResponseCode::NoError => "NODATA".to_string(),
            ResponseCode::NXDomain => "NXDOMAIN".to_string(),
            ResponseCode::ServFail => "SERVFAIL".to_string(),
            ResponseCode::Refused => "REFUSED".to_string(),
            other => other.to_string().to_uppercase(),
        },
        ResolveErrorKind::Timeout => "TIMEOUT".to_string(),
        _ => "ERROR".to_string(),
    };
    let message = match e.kind() {
        ResolveErrorKind::NoRecordsFound { query, .. } => {
            format!("no {} record for {}", query.query_type(), query.name().to_utf8().trim_end_matches('.'))
        }
        _ => attempt::describe(e),
    };
    json!({ "code": code, "message": message })
}

/// Whether the name resolved, and if not, the error to show: an address record or this machine's
/// own resolver answering counts. A name with no address records (NODATA on A and AAAA) is
/// reported as such rather than as missing.
fn dns_verdict(any_record: bool, os_ok: bool, errors: &HashMap<&str, Value>) -> (bool, Value) {
    if any_record || os_ok {
        return (true, Value::Null);
    }
    let code = |t: &str| errors.get(t).and_then(|e| e["code"].as_str()).unwrap_or("");
    let msg = match (code("A"), code("AAAA")) {
        ("NXDOMAIN", _) | (_, "NXDOMAIN") => "NXDOMAIN: no such name".to_string(),
        ("NODATA", "NODATA") => "NODATA: the name exists but has no A, AAAA or CNAME record".to_string(),
        _ => errors
            .get("A")
            .or_else(|| errors.get("AAAA"))
            .and_then(|e| e["message"].as_str())
            .unwrap_or("not resolved")
            .to_string(),
    };
    (false, json!(msg))
}

#[derive(Deserialize)]
struct PingReq {
    url: Option<String>,
}

async fn ping(Json(req): Json<PingReq>) -> Json<Value> {
    let url = req.url.unwrap_or_default();
    let lower = url.to_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Json(json!({ "ok": false, "error": "url must be http(s)://" }));
    }
    let client = match reqwest::Client::builder()
        .user_agent(super::http::user_agent())
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_millis(PING_TIMEOUT_MS))
        .build()
    {
        Ok(c) => c,
        Err(e) => return Json(json!({ "ok": false, "error": attempt::describe(&e) })),
    };
    let att = Attempt::start("GET", &url, HashMap::new(), Value::Null, 0);
    match client.get(&url).send().await {
        Ok(r) => {
            let status = r.status().as_u16();
            let ms = att.elapsed_ms();
            let location = r
                .headers()
                .get(reqwest::header::LOCATION)
                .map(|v| String::from_utf8_lossy(v.as_bytes()).to_string());
            let headers: HashMap<String, String> = r
                .headers()
                .iter()
                .map(|(k, v)| (k.to_string(), String::from_utf8_lossy(v.as_bytes()).to_string()))
                .collect();
            // the body is not read: the status is the health result
            let log = att.succeeded(Reply { status, headers: &headers, trailers: None, body: Value::Null, bytes: 0 });
            Json(json!({
                "ok": true,
                "status": status,
                "verdict": health_verdict(status),
                "location": location,
                "ms": ms,
                "log": log,
            }))
        }
        Err(e) => {
            let timed_out = e.is_timeout();
            let e = e.without_url();
            let (detail, log) = att.failed("network", &e, timed_out, PING_TIMEOUT_MS).await;
            let msg = if timed_out {
                "timeout".to_string()
            } else {
                attempt::describe(&e)
            };
            Json(json!({ "ok": false, "error": msg, "ms": att.elapsed_ms(), "detail": detail, "log": log }))
        }
    }
}

/// How the health board reads a status: `healthy` (1xx/2xx), `redirect` (3xx: the endpoint
/// moved, which is not the same as healthy), or `unhealthy` (4xx/5xx).
fn health_verdict(status: u16) -> &'static str {
    match status {
        300..=399 => "redirect",
        100..=299 => "healthy",
        _ => "unhealthy",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_redirect_is_not_healthy() {
        assert_eq!(health_verdict(200), "healthy");
        assert_eq!(health_verdict(204), "healthy");
        assert_eq!(health_verdict(301), "redirect");
        assert_eq!(health_verdict(308), "redirect");
        assert_eq!(health_verdict(404), "unhealthy");
        assert_eq!(health_verdict(503), "unhealthy");
    }

    #[test]
    fn an_ipv6_literal_gets_brackets() {
        assert_eq!(host_port("example.test", 443), "example.test:443");
        assert_eq!(host_port("::1", 80), "[::1]:80");
        assert_eq!(host_port("[::1]", 80), "[::1]:80");
    }

    #[test]
    fn a_missing_name_fails_with_its_code() {
        let mut errors = HashMap::new();
        errors.insert("A", json!({ "code": "NXDOMAIN", "message": "no record" }));
        errors.insert("AAAA", json!({ "code": "NXDOMAIN", "message": "no record" }));
        let (ok, err) = dns_verdict(false, false, &errors);
        assert!(!ok);
        assert!(err.as_str().unwrap().starts_with("NXDOMAIN"), "{err}");

        let mut nodata = HashMap::new();
        nodata.insert("A", json!({ "code": "NODATA", "message": "" }));
        nodata.insert("AAAA", json!({ "code": "NODATA", "message": "" }));
        assert!(dns_verdict(false, false, &nodata).1.as_str().unwrap().starts_with("NODATA"));

        let mut other = HashMap::new();
        other.insert("A", json!({ "code": "TIMEOUT", "message": "request timed out" }));
        assert_eq!(dns_verdict(false, false, &other).1, json!("request timed out"));
    }

    #[test]
    fn repeated_addresses_are_dropped_even_when_apart() {
        let ips = ["10.0.0.2", "::1", "10.0.0.2", "::1"].iter().map(|s| s.to_string());
        assert_eq!(unique_ips(ips), vec!["10.0.0.2".to_string(), "::1".to_string()]);
    }

    #[test]
    fn a_dns_failure_names_each_lookup_and_what_to_try() {
        let mut errors = HashMap::new();
        errors.insert("A", json!({ "code": "NXDOMAIN", "message": "no record found" }));
        errors.insert("MX", json!({ "code": "NXDOMAIN", "message": "no record found" }));
        errors.insert("AAAA", json!({ "code": "NXDOMAIN", "message": "no record found" }));
        let chain = dns_chain(&errors, &json!({ "ok": false, "error": "nodename nor servname provided" }));
        assert_eq!(chain, vec!["A, AAAA: NXDOMAIN no record found".to_string(), "this machine's resolver: nodename nor servname provided".to_string()]);
        assert!(dns_advice(&errors).starts_with("No such name"));
        assert!(dns_advice(&HashMap::new()).contains("bare hostname"));
    }

    #[test]
    fn certificate_dates_are_iso() {
        assert_eq!(iso(1_428_883_199).as_deref(), Some("2015-04-12T23:59:59Z"));
    }

    #[test]
    fn dns_queries_are_absolute_so_no_search_domain_is_added() {
        assert_eq!(absolute("example.com"), "example.com.");
        assert_eq!(absolute("example.com."), "example.com.");
        assert_eq!(absolute("10.0.0.1"), "10.0.0.1");
        assert_eq!(absolute("::1"), "::1");
    }

    #[tokio::test]
    async fn a_failed_ping_keeps_no_query_secret_in_its_record() {
        let Json(out) = ping(Json(PingReq { url: Some("http://127.0.0.1:9/h?token=s3cret".into()) })).await;
        assert_eq!(out["ok"], false);
        assert!(!out["error"].to_string().contains("s3cret") && !out["detail"]["chain"].to_string().contains("s3cret"), "{out}");
    }

    #[test]
    fn a_name_resolves_if_any_record_or_the_os_answers() {
        let errors = HashMap::new();
        assert!(dns_verdict(true, false, &errors).0);
        assert!(dns_verdict(false, true, &errors).0);
    }
}
