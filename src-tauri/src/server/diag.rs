use std::net::ToSocketAddrs;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::{routing::post, Json, Router};
use hickory_resolver::config::{ResolverConfig, ResolverOpts};
use hickory_resolver::TokioAsyncResolver;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio::time::timeout;

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
    let addr = format!("{host}:{port}");
    let t0 = Instant::now();
    match timeout(Duration::from_secs(5), TcpStream::connect(&addr)).await {
        Ok(Ok(_)) => Json(json!({ "ok": true, "open": true, "ms": t0.elapsed().as_millis() })),
        Ok(Err(e)) => Json(
            json!({ "ok": true, "open": false, "ms": t0.elapsed().as_millis(), "error": e.to_string() }),
        ),
        Err(_) => Json(
            json!({ "ok": true, "open": false, "ms": t0.elapsed().as_millis(), "error": "timeout" }),
        ),
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
    match timeout(Duration::from_secs(8), tls_probe(host.clone(), port)).await {
        Ok(Ok(mut v)) => {
            v["ms"] = json!(t0.elapsed().as_millis());
            Json(v)
        }
        Ok(Err(e)) => Json(json!({ "ok": false, "error": e })),
        Err(_) => Json(json!({ "ok": false, "error": "timeout" })),
    }
}

async fn tls_probe(host: String, port: u16) -> Result<Value, String> {
    use tokio_rustls::rustls::{ClientConfig, RootCertStore};
    use tokio_rustls::rustls::pki_types::ServerName;
    use tokio_rustls::TlsConnector;

    let addr = format!("{host}:{port}");
    let stream = TcpStream::connect(&addr).await.map_err(|e| e.to_string())?;

    // Accept any cert so we can always inspect it (mirrors rejectUnauthorized:false).
    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let config = ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(AcceptAll))
        .with_no_client_auth();

    let server_name = ServerName::try_from(host.clone()).map_err(|e| e.to_string())?;
    let connector = TlsConnector::from(Arc::new(config));
    let conn = connector
        .connect(server_name, stream)
        .await
        .map_err(|e| e.to_string())?;

    let (_, tls_state) = conn.get_ref();
    let certs = tls_state
        .peer_certificates()
        .ok_or_else(|| "no peer certificate".to_string())?;
    let leaf = certs.first().ok_or_else(|| "empty cert chain".to_string())?;

    // Try a real verification against the webpki roots for the authorized flag.
    let (authorized, auth_error) = verify_chain(&roots, certs, &host);

    parse_cert(leaf.as_ref(), authorized, auth_error)
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
        Err(e) => return (false, e.to_string()),
    };
    let now = UnixTime::now();
    let algs = rustls::crypto::ring::default_provider()
        .signature_verification_algorithms
        .all;
    if let Err(e) =
        verify_server_cert_signed_by_trust_anchor(&leaf, roots, &certs[1..], now, algs)
    {
        return (false, e.to_string());
    }
    if let Ok(sn) = ServerName::try_from(host.to_string()) {
        if let Err(e) = verify_server_name(&leaf, &sn) {
            return (false, e.to_string());
        }
    }
    (true, String::new())
}

fn parse_cert(der: &[u8], authorized: bool, auth_error: String) -> Result<Value, String> {
    use x509_parser::prelude::*;

    let (_, cert) = X509Certificate::from_der(der).map_err(|e| e.to_string())?;
    let subject = cert
        .subject()
        .iter_common_name()
        .next()
        .and_then(|a| a.as_str().ok())
        .unwrap_or("")
        .to_string();
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
        "daysLeft": days_left,
        "altNames": alt_names.join(", "),
        "authorized": authorized,
        "authError": auth_error,
    }))
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
    let resolver =
        TokioAsyncResolver::tokio(ResolverConfig::default(), ResolverOpts::default());

    let a: Vec<String> = match resolver.ipv4_lookup(&host).await {
        Ok(r) => r.iter().map(|ip| ip.to_string()).collect(),
        Err(_) => vec![],
    };
    let aaaa: Vec<String> = match resolver.ipv6_lookup(&host).await {
        Ok(r) => r.iter().map(|ip| ip.to_string()).collect(),
        Err(_) => vec![],
    };
    let cname: Vec<String> = match resolver
        .lookup(&host, hickory_resolver::proto::rr::RecordType::CNAME)
        .await
    {
        Ok(r) => r
            .iter()
            .filter_map(|d| d.as_cname().map(|c| c.to_utf8()))
            .collect(),
        Err(_) => vec![],
    };
    let mx: Vec<Value> = match resolver.mx_lookup(&host).await {
        Ok(r) => r
            .iter()
            .map(|m| json!({ "exchange": m.exchange().to_utf8(), "priority": m.preference() }))
            .collect(),
        Err(_) => vec![],
    };

    Json(json!({ "ok": true, "A": a, "AAAA": aaaa, "CNAME": cname, "MX": mx }))
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
    // Force address resolution off the hot path so timing mirrors the Node fetch.
    let _ = url.to_socket_addrs();
    let client = match reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(8))
        .build()
    {
        Ok(c) => c,
        Err(e) => return Json(json!({ "ok": false, "error": e.to_string() })),
    };
    let t0 = Instant::now();
    match client.get(&url).send().await {
        Ok(r) => Json(
            json!({ "ok": true, "status": r.status().as_u16(), "ms": t0.elapsed().as_millis() }),
        ),
        Err(e) => {
            let msg = if e.is_timeout() {
                "timeout".to_string()
            } else {
                e.to_string()
            };
            Json(json!({ "ok": false, "error": msg, "ms": t0.elapsed().as_millis() }))
        }
    }
}
