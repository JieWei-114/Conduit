//! The Database panel: run one query or list the tables on Postgres, MySQL, MongoDB or ClickHouse.
//! Every call, success or failure, comes back with an attempt record (see `attempt.rs`): the
//! redacted connection URL, the query text, and either a summary of the rows or why it failed.

use std::collections::HashMap;
use std::error::Error as StdError;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::Arc;
use std::time::Duration;

use axum::{routing::post, Json, Router};
use futures_util::stream::{StreamExt, TryStreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_postgres::types::{FromSql, Kind, Type};
use url::Url;

use super::attempt::{self, Attempt, Reply};

/// Rows a query hands back to the panel; the rest are counted, not sent.
const ROWS_MAX: usize = 500;
/// Rows copied into the attempt record, enough to recognise the result.
const LOG_ROWS: usize = 20;
/// How long Postgres, MySQL and MongoDB get to open a connection.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// How long one call gets, connecting included, before it is stopped and reported as timed out.
const QUERY_TIMEOUT: Duration = Duration::from_secs(60);
/// How long a Postgres connection task gets to report why it ended, after a query failed.
const PG_CONN_GRACE: Duration = Duration::from_millis(500);
/// How long MongoDB looks for a usable server before it gives up.
const MONGO_SELECT_TIMEOUT: Duration = Duration::from_secs(8);

pub fn routes() -> Router {
    Router::new()
        .route("/query", post(query))
        .route("/schema", post(schema))
}

#[derive(Deserialize)]
struct SchemaReq {
    driver: Option<String>,
    url: Option<String>,
}

#[derive(Deserialize)]
struct QueryReq {
    driver: Option<String>,
    url: Option<String>,
    query: Option<String>,
}

/// What a query produced: rows (with their columns in SELECT order), or a count of affected rows.
/// `row_count` is always the number of rows sent back (at most [`ROWS_MAX`]) on every driver;
/// `truncated` says more rows existed, and `total` is how many in all when the server said so.
struct Out {
    columns: Vec<String>,
    rows: Vec<Value>,
    row_count: u64,
    truncated: bool,
    total: Option<u64>,
    affected: Option<u64>,
}

impl Out {
    fn affected(n: u64) -> Self {
        Self {
            columns: Vec::new(),
            rows: Vec::new(),
            row_count: 0,
            truncated: false,
            total: None,
            affected: Some(n),
        }
    }

    /// Rows read one at a time, at most [`ROWS_MAX`] + 1: the extra one only shows a cut.
    fn capped(columns: Vec<String>, mut rows: Vec<Value>) -> Self {
        let truncated = rows.len() > ROWS_MAX;
        rows.truncate(ROWS_MAX);
        Self {
            columns,
            row_count: rows.len() as u64,
            rows,
            truncated,
            total: None,
            affected: None,
        }
    }
}

/// `fut`, stopped and reported as a timeout once `limit` passes. Dropping a running query
/// closes its connection; Postgres also gets a cancel request (see [`PgCancel`]).
async fn within<T>(
    limit: Duration,
    driver: &str,
    fut: impl std::future::Future<Output = Result<T, DbErr>>,
) -> Result<T, DbErr> {
    match tokio::time::timeout(limit, fut).await {
        Ok(r) => r,
        Err(_) => {
            let mut e = DbErr::timeout("query", limit);
            e.hints.push(timeout_hint(driver, limit));
            Err(e)
        }
    }
}

fn timeout_hint(driver: &str, limit: Duration) -> String {
    let s = limit.as_secs();
    if driver == "postgres" {
        format!("Stopped after {s} s, and Postgres was asked to cancel the query. Narrow it (a WHERE clause, a LIMIT) or run it closer to the data.")
    } else {
        format!("Stopped after {s} s and the connection was closed; the server may still finish the statement on its own. Narrow it (a WHERE clause, a LIMIT) or run it closer to the data.")
    }
}

/// Why a call failed, before it becomes an attempt record.
struct DbErr {
    stage: &'static str,
    chain: Vec<String>,
    /// false when the call was refused before anything went to the server
    sent: bool,
    timed_out: bool,
    timeout_ms: u64,
    /// the database itself answered with an error (bad SQL, wrong password), not the network
    server: bool,
    hints: Vec<String>,
}

impl DbErr {
    fn input(message: impl Into<String>) -> Self {
        Self {
            stage: "request",
            chain: vec![message.into()],
            sent: false,
            timed_out: false,
            timeout_ms: 0,
            server: false,
            hints: Vec::new(),
        }
    }

    fn of(stage: &'static str, err: &(dyn StdError + 'static)) -> Self {
        Self {
            stage,
            chain: attempt::chain(err),
            sent: true,
            ..Self::input("")
        }
    }

    fn msg(stage: &'static str, chain: Vec<String>) -> Self {
        Self {
            stage,
            chain,
            sent: true,
            ..Self::input("")
        }
    }

    fn timeout(stage: &'static str, limit: Duration) -> Self {
        let ms = limit.as_millis() as u64;
        Self {
            stage,
            chain: vec![format!("no answer within {ms} ms")],
            sent: true,
            timed_out: true,
            timeout_ms: ms,
            ..Self::input("")
        }
    }
}

async fn schema(Json(req): Json<SchemaReq>) -> Json<Value> {
    let driver = req.driver.unwrap_or_default();
    let url = req.url.unwrap_or_default().trim().to_string();
    let what = match driver.as_str() {
        "clickhouse" => "SHOW TABLES",
        "postgres" => PG_TABLES,
        "mysql" => "SHOW TABLES",
        "mongodb" => "listCollections",
        _ => "",
    };
    let attempt = Attempt::start(
        &format!("SCHEMA ({driver})"),
        &shown_url(&url),
        HashMap::new(),
        Value::from(what),
        what.len(),
    );
    let res: Result<Vec<String>, DbErr> = if url.is_empty() {
        Err(DbErr::input("missing connection url"))
    } else {
        let run = async {
            match driver.as_str() {
                "clickhouse" => ch_query(&url, what, 100_000).await.map(|r| {
                    r.data
                        .iter()
                        .filter_map(|x| x.get("name").and_then(|v| v.as_str()).map(String::from))
                        .collect()
                }),
                "postgres" => pg_schema(&url).await,
                "mysql" => my_schema(&url).await,
                "mongodb" => mongo_schema(&url).await,
                other => Err(DbErr::input(format!("unknown driver {other}"))),
            }
        };
        within(QUERY_TIMEOUT, &driver, run).await
    };
    match res {
        Ok(tables) => {
            let bytes = serde_json::to_vec(&tables).map(|v| v.len()).unwrap_or(0);
            let log = attempt.succeeded(Reply {
                status: 0, // not HTTP: these protocols have no status line
                headers: &HashMap::new(),
                trailers: None,
                body: json!({
                    "count": tables.len(),
                    "first": tables.iter().take(LOG_ROWS).collect::<Vec<_>>(),
                }),
                bytes,
            });
            Json(
                json!({ "ok": true, "tables": tables, "durationMs": attempt.elapsed_ms(), "log": log }),
            )
        }
        Err(e) => fail(&attempt, &driver, &url, e).await,
    }
}

async fn query(Json(req): Json<QueryReq>) -> Json<Value> {
    let driver = req.driver.unwrap_or_default();
    let url = req.url.unwrap_or_default().trim().to_string();
    let query = req.query.unwrap_or_default();
    let attempt = Attempt::start(
        &format!("QUERY ({driver})"),
        &shown_url(&url),
        HashMap::new(),
        Value::from(query.clone()),
        query.len(),
    );
    let res: Result<Out, DbErr> = if url.is_empty() {
        Err(DbErr::input("missing connection url"))
    } else if query.trim().is_empty() {
        Err(DbErr::input("empty query"))
    } else {
        let run = async {
            match driver.as_str() {
                "clickhouse" => ch_run(&url, &query).await,
                "postgres" => pg_run(&url, &query).await,
                "mysql" => my_run(&url, &query).await,
                "mongodb" => mongo_run(&url, &query).await,
                other => Err(DbErr::input(format!("unknown driver {other}"))),
            }
        };
        within(QUERY_TIMEOUT, &driver, run).await
    };
    match res {
        Ok(out) => {
            let bytes = serde_json::to_vec(&out.rows).map(|v| v.len()).unwrap_or(0);
            let log = attempt.succeeded(Reply {
                status: 0, // not HTTP: these protocols have no status line
                headers: &HashMap::new(),
                trailers: None,
                body: json!({
                    "columns": out.columns,
                    "rowCount": out.row_count,
                    "totalRows": out.total,
                    "affected": out.affected,
                    "truncated": out.truncated,
                    "firstRows": out.rows.iter().take(LOG_ROWS).collect::<Vec<_>>(),
                }),
                bytes,
            });
            Json(json!({
                "ok": true,
                "columns": out.columns,
                "rows": out.rows,
                "rowCount": out.row_count,
                "totalRows": out.total,
                "affected": out.affected,
                "truncated": out.truncated,
                "durationMs": attempt.elapsed_ms(),
                "log": log,
            }))
        }
        Err(e) => fail(&attempt, &driver, &url, e).await,
    }
}

/// The failure shape every panel shares: `{ ok:false, stage, error, detail, durationMs, log }`,
/// with the database's own hints added to the attempt's.
async fn fail(attempt: &Attempt, driver: &str, raw_url: &str, e: DbErr) -> Json<Value> {
    // the database answered: no network probe or hint under a SQL or credentials error
    let (mut error, mut log) = if e.server {
        attempt.server_refused(e.stage, e.chain.clone(), "database")
    } else if e.sent {
        attempt
            .failed_with(e.stage, e.chain.clone(), e.timed_out, e.timeout_ms)
            .await
    } else {
        attempt.not_sent(e.stage, &e.chain.join(": "))
    };
    let mut extra = e.hints;
    let own = db_hints(driver, raw_url, &e.chain);
    // the database's TLS hint replaces the generic one, which points at Diag: Diag cannot read a
    // certificate behind Postgres's own TLS negotiation
    if let (false, Some(list)) = (own.is_empty(), error["hints"].as_array_mut()) {
        list.retain(|h| h.as_str() != Some(attempt::CERT_HINT));
    }
    extra.extend(own);
    if let Some(list) = error["hints"].as_array_mut() {
        for h in extra {
            let h = Value::from(h);
            if !list.contains(&h) {
                list.push(h);
            }
        }
    }
    log["error"] = error.clone();
    let message = if e.timed_out {
        error["message"].clone()
    } else {
        Value::from(e.chain.join(": "))
    };
    Json(json!({
        "ok": false,
        "stage": e.stage,
        "error": message,
        "detail": error,
        "durationMs": attempt.elapsed_ms(),
        "log": log,
    }))
}

/// Hints only a database failure can give: a certificate or TLS setting, rejected credentials.
fn db_hints(driver: &str, raw_url: &str, chain: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let all = chain.join(" | ").to_lowercase();
    // the same advice in each database's own words
    let words = match driver {
        "postgres" => Some((
            "the Mozilla list",
            "sslmode=verify-ca",
            "sslrootcert",
            "sslmode=require",
            "sslmode=prefer (TLS when offered) or sslmode=disable",
        )),
        "mysql" => Some((
            "this machine's trust store",
            "ssl-mode=VERIFY_CA",
            "ssl-ca",
            "ssl-mode=REQUIRED",
            "ssl-mode=PREFERRED (TLS when offered) or ssl-mode=DISABLED",
        )),
        _ => None,
    };
    // rustls (Postgres) and the system TLS (MySQL: macOS, OpenSSL, Windows) word these differently
    let has = |words: &[&str]| words.iter().any(|w| all.contains(w));
    if let Some((trusted, verify_ca, ca_param, require, no_tls)) = words {
        if all.contains("validity period in the certificate exceeds") {
            out.push(format!("macOS refuses server certificates valid for more than 825 days, whoever signed them (MySQL's auto-generated ones last 10 years). Use {require} to encrypt without checking, or give the server a certificate valid for 825 days or fewer."));
        } else if has(&[
            "not valid for name",
            "notvalidforname",
            "host name mismatch",
            "hostname mismatch",
            "target principal name is incorrect",
        ]) {
            out.push(format!("The certificate is valid but names another host: connect by the name it was issued for, or use {verify_ca} to check only who signed it."));
        } else if has(&[
            "invalid peer certificate",
            "certificate was not trusted",
            "certificate verify failed",
            "issued by an authority that is not trusted",
        ]) {
            out.push(format!("The server's certificate is not signed by a CA Conduit trusts ({trusted}). Cloud databases (RDS, Cloud SQL, Azure) and MySQL's own auto-generated certificates sign with their own CA: download it and add {ca_param}=/path/to/ca.pem, or use {require} to encrypt without checking the certificate."));
        } else if all.contains("server does not support tls")
            || all.contains("does not support ssl")
            || all.contains("does not have this capability")
        {
            out.push(format!("The server does not accept TLS: use {no_tls}."));
        }
    }
    if driver == "postgres" {
        let tls = pg_target(raw_url).map(|t| t.tls).unwrap_or(PgTls::Prefer);
        if all.contains("no encryption") || (all.contains("pg_hba.conf") && tls == PgTls::Disable) {
            out.push("The server accepts this client only over TLS: remove sslmode=disable, or set sslmode=require.".into());
        }
    }
    if driver == "mysql" && all.contains("secure transport") {
        out.push("The server accepts this user only over TLS (require_secure_transport): remove ssl-mode=DISABLED.".into());
    }
    if [
        "password authentication failed",
        "access denied",
        "authentication failed",
    ]
    .iter()
    .any(|w| all.contains(w))
    {
        out.push("The server rejected the credentials: check the user and password. Characters like @ : / # % in a password must be percent-encoded in the URL.".into());
    }
    out
}

/// The connection string as it may appear in a record: passwords replaced.
fn shown_url(raw: &str) -> String {
    attempt::redact_url(raw)
}

/// Names made unique in order, so `SELECT a.id, b.id` keeps both columns: `id`, `id (2)`.
fn unique_names(names: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for n in names {
        let mut cand = n.clone();
        let mut k = 2;
        while out.contains(&cand) {
            cand = format!("{n} ({k})");
            k += 1;
        }
        out.push(cand);
    }
    out
}

// ---------- ClickHouse ----------

struct ChResult {
    columns: Vec<String>,
    data: Vec<Value>,
    /// reading stopped at the row or byte cap: more rows exist
    more: bool,
    /// the body when it is not the row format asked for (`FORMAT CSV`, `TSV`, `JSON`…)
    text: Option<String>,
}

/// The format the rows are asked in: one JSON array per line, so they can be counted as they
/// arrive and the read stopped at the cap instead of holding the whole result.
const CH_FORMAT: &str = "JSONCompactEachRowWithNamesAndTypes";
/// The most bytes of a result read, whatever the row count.
const CH_BYTES_MAX: usize = 16 * 1024 * 1024;

/// The lines of a 2xx body as rows: in [`CH_FORMAT`], names, types, then one array per row; in
/// any other format the body is kept as text, so a `FORMAT CSV` answer is shown rather than lost.
fn ch_parse(format: &str, lines: &[String], more: bool) -> Result<ChResult, DbErr> {
    if format != CH_FORMAT {
        let t = lines.join("\n");
        let t = t.trim_end_matches(['\r', '\n']);
        return Ok(ChResult {
            columns: vec![],
            data: vec![],
            more,
            text: (!t.is_empty()).then(|| t.to_string()),
        });
    }
    let columns: Vec<String> = lines
        .first()
        .and_then(|l| serde_json::from_str::<Vec<String>>(l).ok())
        .unwrap_or_default();
    let mut data = Vec::new();
    for line in lines.iter().skip(2).filter(|l| !l.trim().is_empty()) {
        // an exception after the first rows arrives as a line of text
        let Ok(Value::Array(values)) = serde_json::from_str::<Value>(line) else {
            return Err(DbErr {
                server: true,
                ..DbErr::msg("query", vec![line.trim().to_string()])
            });
        };
        let row: serde_json::Map<String, Value> = columns.iter().cloned().zip(values).collect();
        data.push(Value::Object(row));
    }
    Ok(ChResult {
        columns,
        data,
        more,
        text: None,
    })
}

/// A text answer as rows of one `text` column, a line each.
fn ch_text_out(text: &str, more: bool) -> Out {
    let lines: Vec<Value> = text
        .lines()
        .take(ROWS_MAX + 1)
        .map(|l| json!({ "text": l }))
        .collect();
    let mut out = Out::capped(vec!["text".into()], lines);
    out.truncated = out.truncated || more;
    if out.truncated && !more {
        out.total = Some(text.lines().count() as u64);
    }
    out
}

/// Up to `max_lines` lines of `resp`'s body and at most [`CH_BYTES_MAX`] bytes, and whether
/// there was more. The rest is never read: dropping the response closes the connection.
async fn ch_lines(
    resp: reqwest::Response,
    max_lines: usize,
) -> Result<(Vec<String>, bool), reqwest::Error> {
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    let mut lines: Vec<String> = Vec::new();
    let mut read = 0usize;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        read += chunk.len();
        buf.extend_from_slice(&chunk);
        while let Some(i) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=i).collect();
            lines.push(String::from_utf8_lossy(&line[..line.len() - 1]).into_owned());
            if lines.len() >= max_lines {
                return Ok((lines, true));
            }
        }
        if read > CH_BYTES_MAX {
            return Ok((lines, true));
        }
    }
    if !buf.is_empty() {
        lines.push(String::from_utf8_lossy(&buf).into_owned());
    }
    Ok((lines, false))
}

/// An error body as text: in a JSON row format ClickHouse wraps the exception as `["Code: …"]`
/// after empty name and type lines.
fn ch_error_text(lines: &[String]) -> String {
    lines
        .iter()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty() && *l != "[]")
        .map(|l| {
            serde_json::from_str::<Vec<String>>(l)
                .map(|v| v.join(" "))
                .unwrap_or_else(|_| l.to_string())
        })
        .collect::<Vec<_>>()
        .join("\n")
}

async fn ch_query(raw_url: &str, sql: &str, max_rows: usize) -> Result<ChResult, DbErr> {
    let mut u = Url::parse(raw_url).map_err(|e| DbErr::input(attempt::describe(&e)))?;
    let db = {
        let p = u.path().trim_start_matches('/');
        if p.is_empty() {
            "default".to_string()
        } else {
            p.to_string()
        }
    };
    let user = {
        let s = urldec(u.username());
        if s.is_empty() {
            "default".to_string()
        } else {
            s
        }
    };
    let pass = u.password().map(urldec).unwrap_or_default();
    let _ = u.set_username("");
    let _ = u.set_password(None);
    let origin = u.origin().ascii_serialization();
    let endpoint = format!(
        "{origin}/?database={}&default_format={CH_FORMAT}",
        urlenc(&db)
    );

    let client = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(QUERY_TIMEOUT)
        .build()
        .map_err(|e| DbErr::of("request", &e))?;

    let net = |stage: &'static str, e: reqwest::Error| DbErr {
        timed_out: e.is_timeout(),
        timeout_ms: if e.is_connect() {
            CONNECT_TIMEOUT
        } else {
            QUERY_TIMEOUT
        }
        .as_millis() as u64,
        ..DbErr::of(stage, &e.without_url())
    };
    let resp = client
        .post(&endpoint)
        .header("X-ClickHouse-User", user)
        .header("X-ClickHouse-Key", pass)
        .body(sql.to_string())
        .send()
        .await
        .map_err(|e| net("connect", e))?;

    let status = resp.status();
    let format = resp
        .headers()
        .get("x-clickhouse-format")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    if !status.is_success() {
        let (lines, _) = ch_lines(resp, 200).await.map_err(|e| net("body", e))?;
        let t = ch_error_text(&lines);
        let t = t.trim();
        let mut chain = vec![format!("HTTP {}", status.as_u16())];
        if !t.is_empty() {
            chain.push(t.to_string());
        }
        return Err(DbErr {
            server: true,
            ..DbErr::msg("query", chain)
        });
    }
    // names, types, and one row past the cap so a cut shows
    let (lines, more) = ch_lines(resp, max_rows + 3)
        .await
        .map_err(|e| net("body", e))?;
    ch_parse(&format, &lines, more)
}

async fn ch_run(url: &str, query: &str) -> Result<Out, DbErr> {
    let r = ch_query(url, query, ROWS_MAX).await?;
    if let Some(text) = r.text {
        return Ok(ch_text_out(&text, r.more));
    }
    let mut out = Out::capped(r.columns, r.data);
    out.truncated = out.truncated || r.more;
    Ok(out)
}

// ---------- Postgres ----------

const PG_TABLES: &str = "select table_schema, table_name from information_schema.tables \
     where table_schema not in ('pg_catalog','information_schema') order by 1,2";

/// What a connection string asks of TLS, in libpq's terms. `prefer` (the default) and `require`
/// encrypt without checking the certificate, as psql does; `verify-ca` checks it is signed by a
/// trusted CA, `verify-full` also that it names the host.
#[derive(Clone, Copy, Debug, PartialEq)]
enum PgTls {
    Disable,
    Prefer,
    Require,
    VerifyCa,
    VerifyFull,
}

/// A connection string split into what tokio-postgres parses and the TLS settings it does not:
/// it knows only `disable` / `prefer` / `require` and refuses `sslrootcert`, so those are taken out
/// here and applied by [`pg_tls`].
#[derive(Debug, PartialEq)]
struct PgTarget {
    conn: String,
    tls: PgTls,
    /// a PEM file of CAs to trust instead of the bundled Mozilla list
    root_cert: Option<String>,
}

fn pg_target(raw: &str) -> Result<PgTarget, String> {
    let mut mode = None;
    let mut root_cert = None;
    let mut take = |key: &str, value: String| -> Result<bool, String> {
        match key {
            "sslmode" => {
                mode = Some(match value.as_str() {
                    "disable" => PgTls::Disable,
                    // `allow` tries plaintext first; tokio-postgres cannot, and prefer reaches the same servers
                    "allow" | "prefer" => PgTls::Prefer,
                    "require" => PgTls::Require,
                    "verify-ca" => PgTls::VerifyCa,
                    "verify-full" => PgTls::VerifyFull,
                    other => return Err(format!("sslmode={other} is not one of disable, allow, prefer, require, verify-ca, verify-full")),
                });
                Ok(true)
            }
            "sslrootcert" => {
                root_cert = Some(value);
                Ok(true)
            }
            _ => Ok(false),
        }
    };

    let url_form = raw.starts_with("postgres://") || raw.starts_with("postgresql://");
    let conn = if url_form {
        match raw.split_once('?') {
            None => raw.to_string(),
            Some((base, query)) => {
                let mut kept = Vec::new();
                for pair in query.split('&').filter(|p| !p.is_empty()) {
                    let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
                    let v = percent_encoding::percent_decode_str(v)
                        .decode_utf8_lossy()
                        .into_owned();
                    if !take(k, v)? {
                        kept.push(pair);
                    }
                }
                if kept.is_empty() {
                    base.to_string()
                } else {
                    format!("{base}?{}", kept.join("&"))
                }
            }
        }
    } else {
        let mut kept = Vec::new();
        for (k, v, raw_pair) in pg_kv_pairs(raw)? {
            if !take(k, v)? {
                kept.push(raw_pair);
            }
        }
        kept.join(" ")
    };
    let mut tls = mode.unwrap_or(PgTls::Prefer);
    // libpq: a root certificate with sslmode=require checks the chain, as verify-ca does
    if tls == PgTls::Require && root_cert.is_some() {
        tls = PgTls::VerifyCa;
    }
    // stated even when it is the default, since the connector offers TLS to every connection
    let mode = match tls {
        PgTls::Disable => "disable",
        PgTls::Prefer => "prefer",
        PgTls::Require | PgTls::VerifyCa | PgTls::VerifyFull => "require",
    };
    let conn = if !url_form {
        format!("{conn} sslmode={mode}").trim_start().to_string()
    } else if conn.contains('?') {
        format!("{conn}&sslmode={mode}")
    } else {
        format!("{conn}?sslmode={mode}")
    };
    Ok(PgTarget {
        conn,
        tls,
        root_cert,
    })
}

/// The `key=value` pairs of a libpq keyword string (`host=h dbname='my db'`): key, unquoted value,
/// and the pair as written.
fn pg_kv_pairs(raw: &str) -> Result<Vec<(&str, String, &str)>, String> {
    let mut out = Vec::new();
    let b = raw.as_bytes();
    let mut i = 0;
    while i < b.len() {
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        if i == b.len() {
            break;
        }
        let start = i;
        while i < b.len() && b[i] != b'=' && !b[i].is_ascii_whitespace() {
            i += 1;
        }
        let key = &raw[start..i];
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        if i == b.len() || b[i] != b'=' {
            return Err(format!("`{key}` in the connection string has no `=value`"));
        }
        i += 1;
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        let mut value = String::new();
        if i < b.len() && b[i] == b'\'' {
            i += 1;
            loop {
                match b.get(i) {
                    None => return Err(format!("the quoted value of `{key}` is not closed")),
                    Some(b'\'') => {
                        i += 1;
                        break;
                    }
                    Some(b'\\') if i + 1 < b.len() => {
                        value.push(b[i + 1] as char);
                        i += 2;
                    }
                    Some(_) => {
                        let c = raw[i..].chars().next().unwrap_or_default();
                        value.push(c);
                        i += c.len_utf8();
                    }
                }
            }
        } else {
            let v0 = i;
            while i < b.len() && !b[i].is_ascii_whitespace() {
                i += 1;
            }
            value.push_str(&raw[v0..i]);
        }
        out.push((key, value, &raw[start..i]));
    }
    Ok(out)
}

/// The TLS connector for `target`: the CAs it trusts (its root certificate file, else the bundled
/// Mozilla list) and how much of the certificate it checks.
fn pg_tls(target: &PgTarget) -> Result<tokio_postgres_rustls::MakeRustlsConnect, DbErr> {
    use rustls::pki_types::pem::PemObject;
    use rustls::pki_types::CertificateDer;

    let mut roots = rustls::RootCertStore::empty();
    match target.root_cert.as_deref() {
        // `system` (libpq 16) means the usual trusted CAs: here, the bundled list
        None | Some("system") => roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned()),
        Some(path) => {
            let read = |path: &str| -> Result<Vec<CertificateDer<'static>>, String> {
                CertificateDer::pem_file_iter(path)
                    .and_then(|certs| certs.collect::<Result<Vec<_>, _>>())
                    .map_err(|e| e.to_string())
            };
            let certs = read(path).map_err(|e| {
                DbErr::input(format!(
                    "sslrootcert={path} could not be read as PEM certificates: {e}"
                ))
            })?;
            if certs.is_empty() {
                return Err(DbErr::input(format!(
                    "sslrootcert={path} holds no PEM certificate"
                )));
            }
            for c in certs {
                roots.add(c).map_err(|e| {
                    DbErr::input(format!(
                        "a certificate in sslrootcert={path} is not usable: {e}"
                    ))
                })?;
            }
        }
    }
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let tls_err = |e: rustls::Error| DbErr::input(format!("TLS could not be set up: {e}"));
    let inner = rustls::client::WebPkiServerVerifier::builder_with_provider(
        Arc::new(roots),
        provider.clone(),
    )
    .build()
    .map_err(|e| DbErr::input(format!("TLS could not be set up: {e}")))?;
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(tls_err)?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(PgVerifier {
            tls: target.tls,
            inner,
        }))
        .with_no_client_auth();
    Ok(tokio_postgres_rustls::MakeRustlsConnect::new(config))
}

/// Checks a Postgres server's certificate as far as its sslmode asks. The handshake signatures are
/// always verified, so even an unchecked certificate is one the server holds the key for.
#[derive(Debug)]
struct PgVerifier {
    tls: PgTls,
    inner: Arc<rustls::client::WebPkiServerVerifier>,
}

impl rustls::client::danger::ServerCertVerifier for PgVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &rustls::pki_types::CertificateDer<'_>,
        intermediates: &[rustls::pki_types::CertificateDer<'_>],
        server_name: &rustls::pki_types::ServerName<'_>,
        ocsp: &[u8],
        now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        use rustls::client::danger::ServerCertVerified;
        use rustls::CertificateError::{NotValidForName, NotValidForNameContext};
        match self.tls {
            PgTls::VerifyFull => {
                self.inner
                    .verify_server_cert(end_entity, intermediates, server_name, ocsp, now)
            }
            PgTls::VerifyCa => match self.inner.verify_server_cert(
                end_entity,
                intermediates,
                server_name,
                ocsp,
                now,
            ) {
                Err(rustls::Error::InvalidCertificate(
                    NotValidForName | NotValidForNameContext { .. },
                )) => Ok(ServerCertVerified::assertion()),
                other => other,
            },
            PgTls::Disable | PgTls::Prefer | PgTls::Require => Ok(ServerCertVerified::assertion()),
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.inner.supported_verify_schemes()
    }
}

fn pg_err(stage: &'static str, e: &tokio_postgres::Error) -> DbErr {
    let mut d = DbErr::of(stage, e);
    if let Some(db) = e.as_db_error() {
        d.server = true;
        let mut h = format!("Postgres error code {}", db.code().code());
        if let Some(tokio_postgres::error::ErrorPosition::Original(p)) = db.position() {
            h.push_str(&format!(", at character {p} of the query"));
        }
        d.hints.push(h);
    }
    d
}

/// A client and the task driving its connection. The task's own error (the socket reset, the
/// server shut down) is what explains a later "connection closed", so [`Pg::err`] adds it.
/// Dropping a `Pg` ends the connection, so rows not read yet stop coming.
struct Pg {
    client: tokio_postgres::Client,
    /// kept for the cancel request, which opens its own connection the same way
    tls: tokio_postgres_rustls::MakeRustlsConnect,
    conn: Option<tokio::task::JoinHandle<Result<(), tokio_postgres::Error>>>,
}

impl Pg {
    async fn err(&mut self, stage: &'static str, e: &tokio_postgres::Error) -> DbErr {
        let mut d = pg_err(stage, e);
        if d.server {
            return d;
        }
        if let Some(mut task) = self.conn.take() {
            if let Ok(Ok(Err(ce))) = tokio::time::timeout(PG_CONN_GRACE, &mut task).await {
                add_causes(&mut d.chain, attempt::chain(&ce));
            }
        }
        d
    }
}

impl Drop for Pg {
    fn drop(&mut self) {
        if let Some(t) = &self.conn {
            t.abort();
        }
    }
}

/// `more` appended to `chain`, skipping any message already in it.
fn add_causes(chain: &mut Vec<String>, more: Vec<String>) {
    for m in more {
        if !chain.contains(&m) {
            chain.push(m);
        }
    }
}

/// Asks Postgres to cancel the running statement if dropped while armed: a query stopped by
/// [`within`] would otherwise keep running on the server after its connection is gone.
struct PgCancel(
    Option<(
        tokio_postgres::CancelToken,
        tokio_postgres_rustls::MakeRustlsConnect,
    )>,
);

impl PgCancel {
    fn disarm(mut self) {
        self.0 = None;
    }
}

impl Drop for PgCancel {
    fn drop(&mut self) {
        if let Some((token, tls)) = self.0.take() {
            if let Ok(rt) = tokio::runtime::Handle::try_current() {
                rt.spawn(async move {
                    let _ = token.cancel_query(tls).await;
                });
            }
        }
    }
}

async fn pg_connect(url: &str) -> Result<Pg, DbErr> {
    let target = pg_target(url).map_err(DbErr::input)?;
    let tls = pg_tls(&target)?;
    let connecting = tokio_postgres::connect(&target.conn, tls.clone());
    let (client, connection) = match tokio::time::timeout(CONNECT_TIMEOUT, connecting).await {
        Err(_) => return Err(DbErr::timeout("connect", CONNECT_TIMEOUT)),
        Ok(Err(e)) => return Err(pg_err("connect", &e)),
        Ok(Ok(pair)) => pair,
    };
    let conn = tokio::spawn(connection);
    Ok(Pg {
        client,
        tls,
        conn: Some(conn),
    })
}

async fn pg_schema(url: &str) -> Result<Vec<String>, DbErr> {
    let mut pg = pg_connect(url).await?;
    let rows = match pg.client.query(PG_TABLES, &[]).await {
        Ok(r) => r,
        Err(e) => return Err(pg.err("query", &e).await),
    };
    Ok(rows
        .iter()
        .map(|r| {
            let s: String = r.get(0);
            let t: String = r.get(1);
            if s == "public" {
                t
            } else {
                format!("{s}.{t}")
            }
        })
        .collect())
}

async fn pg_run(url: &str, query: &str) -> Result<Out, DbErr> {
    let mut pg = pg_connect(url).await?;
    let cancel = PgCancel(Some((pg.client.cancel_token(), pg.tls.clone())));
    let res = pg_rows(&pg.client, query).await;
    cancel.disarm();
    match res {
        Ok(out) => Ok(out),
        Err(e) => Err(pg.err("query", &e).await),
    }
}

/// Runs `query` and reads at most [`ROWS_MAX`] + 1 rows; the rest are never read (the
/// connection is closed when the caller drops it).
async fn pg_rows(
    client: &tokio_postgres::Client,
    query: &str,
) -> Result<Out, tokio_postgres::Error> {
    let stmt = client.prepare(query).await?;
    if stmt.columns().is_empty() {
        // INSERT / UPDATE / DELETE / DDL without RETURNING: report what it touched
        return Ok(Out::affected(client.execute(&stmt, &[]).await?));
    }
    let names = unique_names(stmt.columns().iter().map(|c| c.name().to_string()));
    let stream = client
        .query_raw(
            &stmt,
            std::iter::empty::<&dyn tokio_postgres::types::ToSql>(),
        )
        .await?;
    futures_util::pin_mut!(stream);
    let mut rows = Vec::new();
    while rows.len() <= ROWS_MAX {
        match stream.try_next().await? {
            Some(r) => rows.push(pg_row_to_json(&r, &names)),
            None => break,
        }
    }
    Ok(Out::capped(names, rows))
}

/// A column's value as the server sent it (binary format), whatever its type.
struct PgRaw<'a>(&'a [u8]);

impl<'a> FromSql<'a> for PgRaw<'a> {
    fn from_sql(_: &Type, raw: &'a [u8]) -> Result<Self, Box<dyn StdError + Sync + Send>> {
        Ok(PgRaw(raw))
    }
    fn accepts(_: &Type) -> bool {
        true
    }
}

fn pg_row_to_json(row: &tokio_postgres::Row, names: &[String]) -> Value {
    let mut obj = serde_json::Map::new();
    for (i, col) in row.columns().iter().enumerate() {
        let val = match row.try_get::<_, Option<PgRaw>>(i) {
            Ok(Some(raw)) => pg_value(col.type_(), raw.0),
            Ok(None) => Value::Null,
            Err(e) => Value::from(format!("<could not read {}: {e}>", col.type_().name())),
        };
        obj.insert(names[i].clone(), val);
    }
    Value::Object(obj)
}

/// One Postgres value from its binary form. Numbers stay numbers; NUMERIC, dates and times,
/// UUID, BYTEA (`\x` hex), INTERVAL and INET become text; arrays become JSON arrays. A type with
/// no decoder here shows as `<unsupported type NAME>`, never as null.
fn pg_value(ty: &Type, raw: &[u8]) -> Value {
    fn get<'a, T: FromSql<'a>>(ty: &Type, raw: &'a [u8]) -> Result<T, String> {
        T::from_sql(ty, raw).map_err(|e| e.to_string())
    }
    fn float(f: f64) -> Value {
        serde_json::Number::from_f64(f)
            .map(Value::Number)
            .unwrap_or_else(|| Value::from(f.to_string()))
    }
    let res: Result<Value, String> = match *ty {
        Type::VOID => Ok(Value::Null),
        Type::BOOL => get::<bool>(ty, raw).map(Value::from),
        Type::CHAR => get::<i8>(ty, raw).map(Value::from),
        Type::INT2 => get::<i16>(ty, raw).map(Value::from),
        Type::INT4 => get::<i32>(ty, raw).map(Value::from),
        Type::INT8 => get::<i64>(ty, raw).map(Value::from),
        Type::OID => get::<u32>(ty, raw).map(Value::from),
        Type::FLOAT4 => get::<f32>(ty, raw).map(|f| float(f as f64)),
        Type::FLOAT8 => get::<f64>(ty, raw).map(float),
        Type::NUMERIC => pg_numeric(raw).map(Value::from),
        Type::JSON | Type::JSONB => get::<Value>(ty, raw),
        Type::UUID => get::<uuid::Uuid>(ty, raw).map(|u| Value::from(u.to_string())),
        Type::DATE | Type::TIMESTAMP | Type::TIMESTAMPTZ if pg_infinity(raw).is_some() => {
            Ok(Value::from(pg_infinity(raw).unwrap_or_default()))
        }
        Type::DATE => get::<chrono::NaiveDate>(ty, raw).map(|d| Value::from(d.to_string())),
        Type::TIME => get::<chrono::NaiveTime>(ty, raw).map(|t| Value::from(t.to_string())),
        Type::TIMESTAMP => {
            get::<chrono::NaiveDateTime>(ty, raw).map(|d| Value::from(d.to_string()))
        }
        Type::TIMESTAMPTZ => {
            get::<chrono::DateTime<chrono::Utc>>(ty, raw).map(|d| Value::from(d.to_rfc3339()))
        }
        Type::INTERVAL => pg_interval(raw).map(Value::from),
        Type::BYTEA => Ok(Value::from(pg_hex(raw))),
        Type::INET | Type::CIDR => pg_inet(raw).map(Value::from),
        Type::XML => Ok(Value::from(String::from_utf8_lossy(raw).into_owned())),
        _ => match ty.kind() {
            Kind::Array(inner) => pg_array(raw, |b| pg_value(inner, b)),
            Kind::Domain(inner) => Ok(pg_value(inner, raw)),
            Kind::Enum(_) => Ok(Value::from(String::from_utf8_lossy(raw).into_owned())),
            _ if <String as FromSql>::accepts(ty) => get::<String>(ty, raw).map(Value::from),
            _ => Ok(Value::from(format!("<unsupported type {}>", ty.name()))),
        },
    };
    res.unwrap_or_else(|e| Value::from(format!("<could not decode {}: {e}>", ty.name())))
}

/// `infinity` / `-infinity` for a DATE (i32) or TIMESTAMP(TZ) (i64) at its limits.
fn pg_infinity(raw: &[u8]) -> Option<&'static str> {
    match raw.len() {
        4 => match i32::from_be_bytes(raw.try_into().ok()?) {
            i32::MAX => Some("infinity"),
            i32::MIN => Some("-infinity"),
            _ => None,
        },
        8 => match i64::from_be_bytes(raw.try_into().ok()?) {
            i64::MAX => Some("infinity"),
            i64::MIN => Some("-infinity"),
            _ => None,
        },
        _ => None,
    }
}

fn be_i16(raw: &[u8], at: usize) -> Result<i16, String> {
    raw.get(at..at + 2)
        .map(|b| i16::from_be_bytes([b[0], b[1]]))
        .ok_or_else(|| "value cut short".to_string())
}

fn be_i32(raw: &[u8], at: usize) -> Result<i32, String> {
    raw.get(at..at + 4)
        .map(|b| i32::from_be_bytes([b[0], b[1], b[2], b[3]]))
        .ok_or_else(|| "value cut short".to_string())
}

/// NUMERIC's binary form (base-10000 digits, a weight, a sign, a display scale) as exact text.
fn pg_numeric(raw: &[u8]) -> Result<String, String> {
    let ndigits = be_i16(raw, 0)?.max(0) as usize;
    let weight = be_i16(raw, 2)? as i32;
    let sign = be_i16(raw, 4)? as u16;
    let dscale = be_i16(raw, 6)?.max(0) as usize;
    match sign {
        0xC000 => return Ok("NaN".into()),
        0xD000 => return Ok("Infinity".into()),
        0xF000 => return Ok("-Infinity".into()),
        0x0000 | 0x4000 => {}
        other => return Err(format!("unknown sign {other:#x}")),
    }
    let mut digits = Vec::with_capacity(ndigits);
    for i in 0..ndigits {
        digits.push(be_i16(raw, 8 + 2 * i)?);
    }
    let digit = |i: i32| -> i16 {
        if i >= 0 && (i as usize) < digits.len() {
            digits[i as usize]
        } else {
            0
        }
    };
    let mut int = String::new();
    if weight >= 0 {
        for i in 0..=weight {
            if i == 0 {
                int.push_str(&digit(i).to_string());
            } else {
                int.push_str(&format!("{:04}", digit(i)));
            }
        }
    } else {
        int.push('0');
    }
    let mut frac = String::new();
    let mut i = weight + 1;
    while frac.len() < dscale {
        frac.push_str(&format!("{:04}", digit(i)));
        i += 1;
    }
    frac.truncate(dscale);
    let neg = if sign == 0x4000 { "-" } else { "" };
    Ok(if frac.is_empty() {
        format!("{neg}{int}")
    } else {
        format!("{neg}{int}.{frac}")
    })
}

/// INTERVAL (microseconds, days, months) the way Postgres prints it: `1 year 2 mons 3 days 04:05:06`.
fn pg_interval(raw: &[u8]) -> Result<String, String> {
    let micros = raw
        .get(0..8)
        .map(|b| i64::from_be_bytes(b.try_into().unwrap_or_default()))
        .ok_or("value cut short")?;
    let days = be_i32(raw, 8)? as i64;
    let months = be_i32(raw, 12)? as i64;
    let unit = |n: i64, s: &str| format!("{n} {s}{}", if n.abs() == 1 { "" } else { "s" });
    let mut parts = Vec::new();
    if months / 12 != 0 {
        parts.push(unit(months / 12, "year"));
    }
    if months % 12 != 0 {
        parts.push(unit(months % 12, "mon"));
    }
    if days != 0 {
        parts.push(unit(days, "day"));
    }
    if micros != 0 || parts.is_empty() {
        let us = micros.unsigned_abs();
        let (h, rem) = (us / 3_600_000_000, us % 3_600_000_000);
        let (m, rem) = (rem / 60_000_000, rem % 60_000_000);
        let (s, frac) = (rem / 1_000_000, rem % 1_000_000);
        let mut t = format!("{}{h:02}:{m:02}:{s:02}", if micros < 0 { "-" } else { "" });
        if frac != 0 {
            t.push_str(format!(".{frac:06}").trim_end_matches('0'));
        }
        parts.push(t);
    }
    Ok(parts.join(" "))
}

/// INET / CIDR: `10.0.0.1`, `10.0.0.0/8`, `::1`.
fn pg_inet(raw: &[u8]) -> Result<String, String> {
    if raw.len() < 4 {
        return Err("value cut short".into());
    }
    let (family, bits, is_cidr, nb) = (raw[0], raw[1], raw[2], raw[3] as usize);
    let addr = raw.get(4..4 + nb).ok_or("value cut short")?;
    let (ip, max): (IpAddr, u8) = match (family, nb) {
        (2, 4) => (Ipv4Addr::new(addr[0], addr[1], addr[2], addr[3]).into(), 32),
        (3, 16) => {
            let mut a = [0u8; 16];
            a.copy_from_slice(addr);
            (Ipv6Addr::from(a).into(), 128)
        }
        _ => return Err(format!("unknown address family {family}")),
    };
    Ok(if is_cidr != 0 || bits != max {
        format!("{ip}/{bits}")
    } else {
        ip.to_string()
    })
}

/// BYTEA the way Postgres prints it: `\x` and lowercase hex.
fn pg_hex(raw: &[u8]) -> String {
    let mut s = String::with_capacity(2 + raw.len() * 2);
    s.push_str("\\x");
    for b in raw {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// An array's binary form as (nested) JSON arrays, each element decoded by `elem`.
fn pg_array(raw: &[u8], elem: impl Fn(&[u8]) -> Value) -> Result<Value, String> {
    let ndim = be_i32(raw, 0)?;
    if ndim < 0 {
        return Err("negative dimension count".into());
    }
    if ndim == 0 {
        return Ok(json!([]));
    }
    // ndim, has-null flag, element type oid; then (length, lower bound) per dimension
    let mut at = 12;
    let mut dims = Vec::with_capacity(ndim as usize);
    for _ in 0..ndim {
        dims.push(be_i32(raw, at)?.max(0) as usize);
        at += 8;
    }
    let total: usize = dims.iter().product();
    let mut flat = Vec::new();
    for _ in 0..total {
        let len = be_i32(raw, at)?;
        at += 4;
        if len < 0 {
            flat.push(Value::Null);
        } else {
            let end = at + len as usize;
            flat.push(elem(raw.get(at..end).ok_or("value cut short")?));
            at = end;
        }
    }
    Ok(nest(&flat, &dims))
}

fn nest(flat: &[Value], dims: &[usize]) -> Value {
    if dims.len() <= 1 {
        return Value::Array(flat.to_vec());
    }
    let step: usize = dims[1..].iter().product();
    if step == 0 {
        return json!([]);
    }
    Value::Array(flat.chunks(step).map(|c| nest(c, &dims[1..])).collect())
}

// ---------- MySQL ----------

fn my_err(stage: &'static str, e: &mysql_async::Error) -> DbErr {
    let mut d = DbErr::of(stage, e);
    if let mysql_async::Error::Server(s) = e {
        d.server = true;
        d.hints
            .push(format!("MySQL error {} (SQLSTATE {})", s.code, s.state));
    }
    d
}

/// MySQL's `ssl-mode`, as the mysql client takes it. `PREFERRED` (the default) and `REQUIRED`
/// encrypt without checking the certificate; `VERIFY_CA` checks who signed it, `VERIFY_IDENTITY`
/// also that it names the host.
#[derive(Clone, Copy, Debug, PartialEq)]
enum MyTls {
    Disabled,
    Preferred,
    Required,
    VerifyCa,
    VerifyIdentity,
}

/// A MySQL URL split into what mysql_async parses and the client's TLS settings, which it does
/// not know (`ssl-mode`, `ssl-ca`). `tls` is `None` when the URL uses mysql_async's own
/// `require_ssl` / `verify_ca` / `verify_identity` instead: those are left to it.
#[derive(Debug, PartialEq)]
struct MyTarget {
    url: String,
    tls: Option<MyTls>,
    ca: Option<String>,
}

fn my_target(raw: &str) -> Result<MyTarget, String> {
    let Ok(mut url) = Url::parse(raw) else {
        // mysql_async names what is wrong with it
        return Ok(MyTarget {
            url: raw.to_string(),
            tls: Some(MyTls::Preferred),
            ca: None,
        });
    };
    let mut mode = None;
    let mut ca = None;
    let mut own = false;
    let mut kept = Vec::new();
    for (k, v) in url.query_pairs() {
        match k.to_ascii_lowercase().replace('_', "-").as_str() {
            "ssl-mode" | "sslmode" => {
                mode = Some(match v.to_ascii_uppercase().replace('-', "_").as_str() {
                    "DISABLED" => MyTls::Disabled,
                    "PREFERRED" => MyTls::Preferred,
                    "REQUIRED" => MyTls::Required,
                    "VERIFY_CA" => MyTls::VerifyCa,
                    "VERIFY_IDENTITY" => MyTls::VerifyIdentity,
                    other => return Err(format!("ssl-mode={other} is not one of DISABLED, PREFERRED, REQUIRED, VERIFY_CA, VERIFY_IDENTITY")),
                })
            }
            "ssl-ca" | "sslca" => ca = Some(v.into_owned()),
            "require-ssl" | "verify-ca" | "verify-identity" => {
                own = true;
                kept.push((k.into_owned(), v.into_owned()));
            }
            _ => kept.push((k.into_owned(), v.into_owned())),
        }
    }
    if own && (mode.is_some() || ca.is_some()) {
        return Err("use ssl-mode / ssl-ca, or mysql_async's require_ssl / verify_ca / verify_identity, not both".into());
    }
    if kept.is_empty() {
        url.set_query(None);
    } else {
        url.query_pairs_mut().clear().extend_pairs(kept);
    }
    let mut tls = if own {
        None
    } else {
        Some(mode.unwrap_or(MyTls::Preferred))
    };
    // the mysql client: a CA file with the default or REQUIRED mode checks the chain
    if ca.is_some() && matches!(tls, Some(MyTls::Preferred | MyTls::Required)) {
        tls = Some(MyTls::VerifyCa);
    }
    Ok(MyTarget {
        url: url.to_string(),
        tls,
        ca,
    })
}

/// How a connection asks for TLS: `None` for none at all.
fn my_ssl(tls: MyTls, ca: Option<&str>) -> Option<mysql_async::SslOpts> {
    let opts = mysql_async::SslOpts::default();
    let opts = match ca {
        Some(path) => opts.with_root_certs(vec![std::path::PathBuf::from(path).into()]),
        None => opts,
    };
    match tls {
        MyTls::Disabled => None,
        MyTls::Preferred | MyTls::Required => Some(opts.with_danger_accept_invalid_certs(true)),
        MyTls::VerifyCa => Some(opts.with_danger_skip_domain_validation(true)),
        MyTls::VerifyIdentity => Some(opts),
    }
}

async fn my_conn(url: &str) -> Result<mysql_async::Conn, DbErr> {
    let target = my_target(url).map_err(DbErr::input)?;
    let base = mysql_async::Opts::from_url(&target.url)
        .map_err(|e| DbErr::input(attempt::describe(&e)))?;
    let Some(tls) = target.tls else {
        return my_connect(base).await;
    };
    if let Some(path) = target.ca.as_deref() {
        if let Err(e) = std::fs::metadata(path) {
            return Err(DbErr::input(format!(
                "ssl-ca={path} could not be read: {e}"
            )));
        }
    }
    let with = |ssl| {
        mysql_async::Opts::from(mysql_async::OptsBuilder::from_opts(base.clone()).ssl_opts(ssl))
    };
    match my_connect(with(my_ssl(tls, target.ca.as_deref()))).await {
        // PREFERRED: a server without TLS is reached in plaintext, as the mysql client does
        Err(e)
            if tls == MyTls::Preferred
                && e.chain
                    .iter()
                    .any(|c| c.contains("does not have this capability")) =>
        {
            my_connect(with(None)).await
        }
        r => r,
    }
}

async fn my_connect(opts: mysql_async::Opts) -> Result<mysql_async::Conn, DbErr> {
    match tokio::time::timeout(CONNECT_TIMEOUT, mysql_async::Conn::new(opts)).await {
        Err(_) => Err(DbErr::timeout("connect", CONNECT_TIMEOUT)),
        Ok(Err(e)) => Err(my_err("connect", &e)),
        Ok(Ok(c)) => Ok(c),
    }
}

async fn my_schema(url: &str) -> Result<Vec<String>, DbErr> {
    use mysql_async::prelude::Queryable;
    let mut conn = my_conn(url).await?;
    let rows: Vec<mysql_async::Row> = conn
        .query("show tables")
        .await
        .map_err(|e| my_err("query", &e))?;
    let _ = conn.disconnect().await;
    let mut out = Vec::new();
    for r in rows {
        if let Some(raw) = r.as_ref(0) {
            let cols = r.columns_ref();
            let v = my_bson_value(raw, cols[0].column_type());
            if let Value::String(s) = v {
                out.push(s);
            } else {
                out.push(v.to_string());
            }
        }
    }
    Ok(out)
}

async fn my_run(url: &str, query: &str) -> Result<Out, DbErr> {
    use mysql_async::prelude::Queryable;
    let mut conn = my_conn(url).await?;
    let out = {
        let mut qr = conn
            .query_iter(query)
            .await
            .map_err(|e| my_err("query", &e))?;
        if qr.columns_ref().is_empty() {
            // INSERT / UPDATE / DELETE / DDL: report what it touched
            let n = qr.affected_rows();
            qr.drop_result().await.map_err(|e| my_err("query", &e))?;
            Out::affected(n)
        } else {
            let names = unique_names(qr.columns_ref().iter().map(|c| c.name_str().into_owned()));
            // read at most ROWS_MAX + 1 rows; the rest are never kept
            let mut rows = Vec::new();
            if let Some(stream) = qr
                .stream::<mysql_async::Row>()
                .await
                .map_err(|e| my_err("query", &e))?
            {
                futures_util::pin_mut!(stream);
                while rows.len() <= ROWS_MAX {
                    match stream.try_next().await.map_err(|e| my_err("query", &e))? {
                        Some(r) => rows.push(my_row_to_json(&r, &names)),
                        None => break,
                    }
                }
            }
            let out = Out::capped(names, rows);
            if out.truncated {
                // dropping the connection drains the unread rows in the background
                return Ok(out);
            }
            qr.drop_result().await.map_err(|e| my_err("query", &e))?;
            out
        }
    };
    let _ = conn.disconnect().await;
    Ok(out)
}

fn my_row_to_json(row: &mysql_async::Row, names: &[String]) -> Value {
    let cols = row.columns_ref();
    let mut obj = serde_json::Map::new();
    for (i, col) in cols.iter().enumerate() {
        let val = row
            .as_ref(i)
            .map(|v| my_bson_value(v, col.column_type()))
            .unwrap_or(Value::Null);
        let name = names
            .get(i)
            .cloned()
            .unwrap_or_else(|| col.name_str().to_string());
        obj.insert(name, val);
    }
    Value::Object(obj)
}

fn is_numeric_col(t: mysql_async::consts::ColumnType) -> bool {
    use mysql_async::consts::ColumnType::*;
    matches!(
        t,
        MYSQL_TYPE_TINY
            | MYSQL_TYPE_SHORT
            | MYSQL_TYPE_LONG
            | MYSQL_TYPE_LONGLONG
            | MYSQL_TYPE_INT24
            | MYSQL_TYPE_YEAR
            | MYSQL_TYPE_FLOAT
            | MYSQL_TYPE_DOUBLE
            | MYSQL_TYPE_DECIMAL
            | MYSQL_TYPE_NEWDECIMAL
    )
}

fn my_bson_value(v: &mysql_async::Value, col_type: mysql_async::consts::ColumnType) -> Value {
    use mysql_async::Value as MV;
    match v {
        MV::NULL => Value::Null,
        MV::Int(n) => Value::from(*n),
        MV::UInt(n) => Value::from(*n),
        MV::Float(f) => Value::from(*f as f64),
        MV::Double(f) => Value::from(*f),
        MV::Bytes(b) => match std::str::from_utf8(b) {
            // MySQL's text protocol returns numeric columns as ASCII bytes;
            // parse them back to JSON numbers so `select 1` yields 1, not "1".
            Ok(s) if is_numeric_col(col_type) => serde_json::from_str::<Value>(s)
                .ok()
                .filter(Value::is_number)
                .unwrap_or_else(|| Value::from(s.to_string())),
            Ok(s) => Value::from(s.to_string()),
            Err(_) => Value::from(format!("{:?}", b)),
        },
        MV::Date(y, mo, d, h, mi, s, us) => Value::from(format!(
            "{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}.{us:06}"
        )),
        MV::Time(neg, d, h, mi, s, us) => {
            let sign = if *neg { "-" } else { "" };
            Value::from(format!("{sign}{d} {h:02}:{mi:02}:{s:02}.{us:06}"))
        }
    }
}

// ---------- MongoDB ----------

/// One layer of a MongoDB error in a line: `BadValue (2): unknown operator: $bad` for a command,
/// the kind's own words otherwise (the driver's `Display` is a debug dump of every field).
fn mongo_text(e: &mongodb::error::Error) -> String {
    use mongodb::error::{ErrorKind, WriteFailure};
    match e.kind.as_ref() {
        ErrorKind::Command(c) => format!("{} ({}): {}", c.code_name, c.code, c.message),
        ErrorKind::Write(WriteFailure::WriteError(w)) => {
            format!(
                "{} ({}): {}",
                w.code_name.as_deref().unwrap_or("WriteError"),
                w.code,
                w.message
            )
        }
        ErrorKind::Write(WriteFailure::WriteConcernError(w)) => {
            format!("{} ({}): {}", w.code_name, w.code, w.message)
        }
        ErrorKind::ServerSelection { message, .. } => message
            .split(" Topology:")
            .next()
            .unwrap_or(message)
            .trim_end_matches('.')
            .to_string(),
        other => mongo_clean(&other.to_string()),
    }
}

/// Error text nested inside a topology description: `Kind: I/O error: refused, labels: {}, …`
/// reduced to `I/O error: refused`.
fn mongo_clean(text: &str) -> String {
    let t = text.trim().strip_prefix("Kind: ").unwrap_or(text.trim());
    t.split(", labels:").next().unwrap_or(t).trim().to_string()
}

/// The servers a server-selection message describes: each address with its error, or its type.
fn mongo_servers(message: &str) -> Vec<(String, String)> {
    let Some(topology) = message.split_once(" Topology:").map(|(_, t)| t) else {
        return vec![];
    };
    topology
        .split("{ Address: ")
        .skip(1)
        .map(|seg| {
            let addr = seg.split(", ").next().unwrap_or("").trim().to_string();
            let said = match seg.split_once(", Error: ") {
                Some((_, err)) => mongo_clean(err.trim_end_matches([' ', '}', ']', ','])),
                None => seg
                    .split_once("Type: ")
                    .map(|(_, t)| t.split([',', ' ']).next().unwrap_or("").to_string())
                    .unwrap_or_default(),
            };
            (addr, said)
        })
        .collect()
}

/// The `host:port` list of a mongodb:// URL (a `+srv` URL names no ports: its hosts come from DNS).
fn mongo_hosts(url: &str) -> Vec<String> {
    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let rest = rest.split(['/', '?']).next().unwrap_or("");
    let rest = rest.rsplit_once('@').map(|(_, h)| h).unwrap_or(rest);
    rest.split(',')
        .filter(|h| !h.is_empty())
        .map(|h| {
            if h.contains(':') && !h.ends_with(']') {
                h.to_lowercase()
            } else {
                format!("{}:27017", h.to_lowercase())
            }
        })
        .collect()
}

/// A URL option, by its case-insensitive name.
fn mongo_option(url: &str, name: &str) -> Option<String> {
    let query = url.split_once('?')?.1;
    query
        .split('&')
        .filter_map(|p| p.split_once('='))
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.to_string())
}

fn mongo_select_timeout(url: &str) -> Duration {
    mongo_option(url, "serverSelectionTimeoutMS")
        .and_then(|v| v.parse().ok())
        .map(Duration::from_millis)
        .unwrap_or(MONGO_SELECT_TIMEOUT)
}

fn mongo_err(stage: &'static str, e: &mongodb::error::Error, url: &str) -> DbErr {
    use mongodb::error::ErrorKind;
    let mut chain: Vec<String> = Vec::new();
    let mut cur: Option<&(dyn StdError + 'static)> = Some(e);
    while let Some(layer) = cur {
        chain.push(match layer.downcast_ref::<mongodb::error::Error>() {
            Some(m) => mongo_text(m),
            None => layer.to_string(),
        });
        cur = layer.source();
    }
    let mut d = DbErr::msg(stage, attempt::tidy(chain));
    match e.kind.as_ref() {
        ErrorKind::Command(_) | ErrorKind::Write(_) | ErrorKind::Authentication { .. } => {
            d.server = true
        }
        ErrorKind::ServerSelection { message, .. } => {
            let servers = mongo_servers(message);
            d.chain
                .extend(servers.iter().map(|(addr, said)| format!("{addr}: {said}")));
            d.timeout_ms = mongo_select_timeout(url).as_millis() as u64;
            d.hints.push(format!(
                "MongoDB found no usable server within {} ms; the cause above says why.",
                d.timeout_ms
            ));
            let given = mongo_hosts(url);
            let advertised: Vec<&str> = servers
                .iter()
                .map(|(a, _)| a.as_str())
                .filter(|a| !given.contains(&a.to_lowercase()))
                .collect();
            if !advertised.is_empty()
                && !url.starts_with("mongodb+srv")
                && mongo_option(url, "directConnection").is_none()
            {
                d.hints.push(format!(
                    "The server answered, but as a replica set whose members it names {}, which this machine cannot reach: add directConnection=true to the URL to talk only to the host you gave.",
                    advertised.join(", ")
                ));
            }
        }
        _ => {}
    }
    d
}

async fn mongo_db(url: &str) -> Result<mongodb::Database, DbErr> {
    let mut opts = mongodb::options::ClientOptions::parse(url)
        .await
        .map_err(|e| mongo_err("connect", &e, url))?;
    let db_name = opts.default_database.clone();
    opts.server_selection_timeout
        .get_or_insert(MONGO_SELECT_TIMEOUT);
    opts.connect_timeout.get_or_insert(CONNECT_TIMEOUT);
    let client = mongodb::Client::with_options(opts).map_err(|e| mongo_err("connect", &e, url))?;
    let name = db_name.unwrap_or_else(|| "test".to_string());
    Ok(client.database(&name))
}

async fn mongo_schema(url: &str) -> Result<Vec<String>, DbErr> {
    let db = mongo_db(url).await?;
    let mut names = db
        .list_collection_names()
        .await
        .map_err(|e| mongo_err("query", &e, url))?;
    names.sort();
    Ok(names)
}

fn bson_to_json(doc: mongodb::bson::Document) -> Value {
    mongodb::bson::Bson::Document(doc).into_relaxed_extjson()
}

/// `(cap, fetch)` for a requested limit: show at most `cap` documents, and fetch one more when
/// the cap is this panel's (no limit asked, or more than [`ROWS_MAX`]) so a cut can be seen.
fn mongo_window(requested: Option<u64>, default: u64) -> (u64, u64) {
    let max = ROWS_MAX as u64;
    match requested.filter(|&n| n > 0) {
        Some(n) if n <= max => (n, n),
        Some(_) => (max, max + 1),
        None => (default.min(max), default.min(max) + 1),
    }
}

/// Every key in `docs`, in the order first seen.
fn doc_columns(docs: &[Value]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for d in docs {
        if let Some(m) = d.as_object() {
            for k in m.keys() {
                if !out.contains(k) {
                    out.push(k.clone());
                }
            }
        }
    }
    out
}

async fn mongo_run(url: &str, query: &str) -> Result<Out, DbErr> {
    use mongodb::bson::Document;

    let q: Value = serde_json::from_str(query).map_err(|e| {
        DbErr::input(format!(
            "the MongoDB query is not valid JSON ({}); see the placeholder for the shape",
            attempt::describe(&e)
        ))
    })?;
    let to_doc = |v: &Value| -> Result<Document, DbErr> {
        mongodb::bson::to_document(v).map_err(|e| DbErr::input(attempt::describe(&e)))
    };
    let coll_name = q.get("collection").and_then(|c| c.as_str()).unwrap_or("");
    if q.get("command").is_none() && coll_name.is_empty() {
        return Err(DbErr::input("missing \"collection\""));
    }
    let requested = q.get("limit").and_then(|l| l.as_u64());

    let db = mongo_db(url).await?;
    let mut docs: Vec<Value> = Vec::new();
    let mut cap = u64::MAX;

    if let Some(cmd) = q.get("command") {
        let res = db
            .run_command(to_doc(cmd)?)
            .await
            .map_err(|e| mongo_err("query", &e, url))?;
        docs.push(bson_to_json(res));
    } else if let Some(pipeline) = q.get("pipeline").and_then(|p| p.as_array()) {
        let (c, fetch) = mongo_window(requested, ROWS_MAX as u64);
        cap = c;
        let mut stages: Vec<Document> = Vec::new();
        for stage in pipeline {
            stages.push(to_doc(stage)?);
        }
        stages.push(mongodb::bson::doc! { "$limit": fetch as i64 });
        let coll = db.collection::<Document>(coll_name);
        let mut cursor = coll
            .aggregate(stages)
            .await
            .map_err(|e| mongo_err("query", &e, url))?;
        while let Some(d) = cursor
            .try_next()
            .await
            .map_err(|e| mongo_err("query", &e, url))?
        {
            docs.push(bson_to_json(d));
        }
    } else {
        let (c, fetch) = mongo_window(requested, 50);
        cap = c;
        let filter: Document = match q.get("filter") {
            Some(f) => to_doc(f)?,
            None => Document::new(),
        };
        let coll = db.collection::<Document>(coll_name);
        let mut find = coll.find(filter).limit(fetch as i64);
        if let Some(sort) = q.get("sort") {
            find = find.sort(to_doc(sort)?);
        }
        let mut cursor = find.await.map_err(|e| mongo_err("query", &e, url))?;
        while let Some(d) = cursor
            .try_next()
            .await
            .map_err(|e| mongo_err("query", &e, url))?
        {
            docs.push(bson_to_json(d));
        }
    }

    let truncated = docs.len() as u64 > cap;
    if truncated {
        docs.truncate(cap as usize);
    }
    Ok(Out {
        columns: doc_columns(&docs),
        row_count: docs.len() as u64,
        rows: docs,
        truncated,
        total: None,
        affected: None,
    })
}

// ---------- helpers ----------

fn urldec(s: &str) -> String {
    percent_decode(s)
}

fn urlenc(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        // both hex digits must exist: the second one is at i + 2
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// NUMERIC's binary form: ndigits, weight, sign, dscale, then base-10000 digits.
    fn numeric(weight: i16, sign: u16, dscale: u16, digits: &[i16]) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&(digits.len() as i16).to_be_bytes());
        v.extend_from_slice(&weight.to_be_bytes());
        v.extend_from_slice(&sign.to_be_bytes());
        v.extend_from_slice(&dscale.to_be_bytes());
        for d in digits {
            v.extend_from_slice(&d.to_be_bytes());
        }
        v
    }

    #[test]
    fn percent_decoding_reaches_the_last_escape() {
        assert_eq!(percent_decode("%41"), "A");
        assert_eq!(percent_decode("p%40ss%21"), "p@ss!");
        assert_eq!(percent_decode("a%4"), "a%4");
        assert_eq!(percent_decode("a%"), "a%");
        assert_eq!(percent_decode("%zz"), "%zz");
    }

    #[test]
    fn numeric_is_exact_text() {
        assert_eq!(
            pg_numeric(&numeric(1, 0, 3, &[1, 2345, 6780])).unwrap(),
            "12345.678"
        );
        assert_eq!(pg_numeric(&numeric(-1, 0, 4, &[1])).unwrap(), "0.0001");
        assert_eq!(pg_numeric(&numeric(-2, 0, 5, &[1000])).unwrap(), "0.00001");
        assert_eq!(pg_numeric(&numeric(0, 0x4000, 0, &[42])).unwrap(), "-42");
        assert_eq!(pg_numeric(&numeric(1, 0, 2, &[1])).unwrap(), "10000.00");
        assert_eq!(pg_numeric(&numeric(0, 0, 0, &[])).unwrap(), "0");
        assert_eq!(pg_numeric(&numeric(0, 0xC000, 0, &[])).unwrap(), "NaN");
        assert!(pg_numeric(&[0, 1]).is_err());
    }

    #[test]
    fn intervals_read_like_postgres() {
        let iv = |micros: i64, days: i32, months: i32| {
            let mut v = micros.to_be_bytes().to_vec();
            v.extend_from_slice(&days.to_be_bytes());
            v.extend_from_slice(&months.to_be_bytes());
            pg_interval(&v).unwrap()
        };
        assert_eq!(iv(0, 0, 0), "00:00:00");
        assert_eq!(iv(14_706_500_000, 3, 14), "1 year 2 mons 3 days 04:05:06.5");
        assert_eq!(iv(-60_000_000, 1, 0), "1 day -00:01:00");
    }

    #[test]
    fn inet_and_bytea() {
        assert_eq!(pg_inet(&[2, 32, 0, 4, 10, 0, 0, 1]).unwrap(), "10.0.0.1");
        assert_eq!(pg_inet(&[2, 8, 1, 4, 10, 0, 0, 0]).unwrap(), "10.0.0.0/8");
        let mut v6 = vec![3, 128, 0, 16];
        v6.extend_from_slice(&Ipv6Addr::LOCALHOST.octets());
        assert_eq!(pg_inet(&v6).unwrap(), "::1");
        assert_eq!(pg_hex(&[0xde, 0xad, 0x01]), "\\xdead01");
    }

    #[test]
    fn arrays_nest_and_keep_nulls() {
        // int4[][] {{1,NULL},{3,4}}
        let mut v = Vec::new();
        for n in [2i32, 1, 23, 2, 1, 2, 1] {
            v.extend_from_slice(&n.to_be_bytes());
        }
        for e in [Some(1i32), None, Some(3), Some(4)] {
            match e {
                Some(n) => {
                    v.extend_from_slice(&4i32.to_be_bytes());
                    v.extend_from_slice(&n.to_be_bytes());
                }
                None => v.extend_from_slice(&(-1i32).to_be_bytes()),
            }
        }
        let got = pg_array(&v, |b| pg_value(&Type::INT4, b)).unwrap();
        assert_eq!(got, json!([[1, null], [3, 4]]));
        assert_eq!(
            pg_array(&0i32.to_be_bytes(), |_| Value::Null).unwrap(),
            json!([])
        );
        assert!(pg_array(&v[..v.len() - 2], |_| Value::Null).is_err());
    }

    #[test]
    fn values_without_a_decoder_say_so() {
        assert_eq!(
            pg_value(&Type::POINT, &[0; 16]),
            json!("<unsupported type point>")
        );
        assert_eq!(
            pg_value(&Type::FLOAT8, &f64::NAN.to_be_bytes()),
            json!("NaN")
        );
        assert_eq!(
            pg_value(&Type::DATE, &i32::MAX.to_be_bytes()),
            json!("infinity")
        );
        assert_eq!(pg_value(&Type::TEXT, b"hi"), json!("hi"));
    }

    #[test]
    fn a_topology_failure_is_summarised_per_server_with_a_direct_connection_hint() {
        let message = "Server selection timeout: No available servers. Topology: { Type: ReplicaSetNoPrimary, Set Name: rs0, Servers: [ { Address: mongo1:27017, Type: Unknown, Error: Kind: An error occurred during DNS resolution: no record found, labels: {}, source: None, server response: None }, { Address: localhost:27017, Type: RSSecondary, Average RTT: 1ms } ] }";
        assert_eq!(
            mongo_servers(message),
            vec![
                (
                    "mongo1:27017".to_string(),
                    "An error occurred during DNS resolution: no record found".to_string()
                ),
                ("localhost:27017".to_string(), "RSSecondary".to_string()),
            ]
        );
        assert_eq!(
            mongo_hosts("mongodb://u:p@LocalHost,h2:27018/db?x=1"),
            vec!["localhost:27017", "h2:27018"]
        );
        assert_eq!(
            mongo_select_timeout("mongodb://h/?serverSelectionTimeoutMS=3000"),
            Duration::from_millis(3000)
        );
        assert_eq!(mongo_select_timeout("mongodb://h/"), MONGO_SELECT_TIMEOUT);
        assert_eq!(
            mongo_option("mongodb://h/?directconnection=true", "directConnection").as_deref(),
            Some("true")
        );
        assert_eq!(
            mongo_clean("Kind: I/O error: Connection refused (os error 61), labels: {}"),
            "I/O error: Connection refused (os error 61)"
        );
    }

    #[tokio::test]
    async fn mongo_honours_the_urls_own_selection_timeout() {
        let t0 = std::time::Instant::now();
        let e = mongo_schema(
            "mongodb://127.0.0.1:9/?serverSelectionTimeoutMS=300&connectTimeoutMS=200",
        )
        .await
        .expect_err("nothing listens");
        assert!(t0.elapsed() < Duration::from_secs(3), "{:?}", t0.elapsed());
        assert_eq!(e.timeout_ms, 300);
        assert!(
            e.chain
                .iter()
                .all(|c| !c.contains("labels:") && !c.contains("Kind:")),
            "{:?}",
            e.chain
        );
        assert!(
            e.chain.iter().any(|c| c.starts_with("127.0.0.1:9: ")),
            "{:?}",
            e.chain
        );
    }

    #[test]
    fn duplicate_column_names_are_kept_apart() {
        let n = unique_names(["id", "name", "id", "id"].map(String::from));
        assert_eq!(n, vec!["id", "name", "id (2)", "id (3)"]);
    }

    #[test]
    fn mongo_cut_is_visible_only_when_the_cap_is_ours() {
        assert_eq!(mongo_window(Some(20), 50), (20, 20));
        assert_eq!(mongo_window(None, 50), (50, 51));
        assert_eq!(mongo_window(Some(0), 50), (50, 51));
        assert_eq!(mongo_window(Some(10_000), 50), (500, 501));
        assert_eq!(
            doc_columns(&[json!({"b": 1, "a": 2}), json!({"c": 3, "a": 4})]),
            vec!["b", "a", "c"]
        );
    }

    #[test]
    fn sslmode_and_rootcert_are_taken_out_for_tokio_postgres() {
        // Arrange
        let url = "postgres://u:p@h:5432/db?sslmode=verify-full&sslrootcert=%2Ftmp%2Fca.pem&application_name=x";
        // Act
        let t = pg_target(url).unwrap();
        // Assert
        assert_eq!(
            t.conn,
            "postgres://u:p@h:5432/db?application_name=x&sslmode=require"
        );
        assert_eq!(t.tls, PgTls::VerifyFull);
        assert_eq!(t.root_cert.as_deref(), Some("/tmp/ca.pem"));

        let t = pg_target("postgres://h/db?sslmode=disable").unwrap();
        // disable must reach tokio-postgres, or it would offer TLS anyway
        assert_eq!(
            (t.conn.as_str(), t.tls),
            ("postgres://h/db?sslmode=disable", PgTls::Disable)
        );
        assert_eq!(pg_target("postgres://h/db").unwrap().tls, PgTls::Prefer);
        assert!(pg_target("postgres://h/db?sslmode=bogus").is_err());
    }

    #[test]
    fn keyword_strings_keep_quoted_values() {
        let t = pg_target(r"host=h dbname='my \'db' sslmode = require sslrootcert='/a b/ca.pem'")
            .unwrap();
        assert_eq!(t.conn, r"host=h dbname='my \'db' sslmode=require");
        // a root certificate turns require into verify-ca, as libpq does
        assert_eq!(t.tls, PgTls::VerifyCa);
        assert_eq!(t.root_cert.as_deref(), Some("/a b/ca.pem"));
        assert!(pg_target("host=h dbname='open").is_err());
        assert!(pg_target("host").is_err());
    }

    #[test]
    fn a_missing_root_cert_is_refused_before_connecting() {
        let t = pg_target("postgres://h/db?sslrootcert=/nonexistent/ca.pem").unwrap();
        let e = pg_tls(&t).err().expect("refused");
        assert!(!e.sent);
        assert!(
            e.chain[0].contains("sslrootcert=/nonexistent/ca.pem"),
            "{:?}",
            e.chain
        );
    }

    #[test]
    fn mysql_ssl_mode_and_ca_are_taken_out_for_mysql_async() {
        // Arrange
        let url = "mysql://u:p@h:3306/db?ssl-mode=verify_identity&ssl-ca=%2Ftmp%2Fca.pem&prefer_socket=false";
        // Act
        let t = my_target(url).unwrap();
        // Assert
        assert_eq!(t.url, "mysql://u:p@h:3306/db?prefer_socket=false");
        assert_eq!(t.tls, Some(MyTls::VerifyIdentity));
        assert_eq!(t.ca.as_deref(), Some("/tmp/ca.pem"));

        assert_eq!(
            my_target("mysql://h/db").unwrap().tls,
            Some(MyTls::Preferred)
        );
        assert_eq!(
            my_target("mysql://h/db?sslMode=DISABLED").unwrap().tls,
            Some(MyTls::Disabled)
        );
        // a CA file with the default mode checks the chain, as the mysql client does
        assert_eq!(
            my_target("mysql://h/db?ssl-ca=/c.pem").unwrap().tls,
            Some(MyTls::VerifyCa)
        );
        // mysql_async's own parameters are left to it
        let own = my_target("mysql://h/db?require_ssl=true").unwrap();
        assert_eq!(
            (own.url.as_str(), own.tls),
            ("mysql://h/db?require_ssl=true", None)
        );
        assert!(my_target("mysql://h/db?require_ssl=true&ssl-mode=REQUIRED").is_err());
        assert!(my_target("mysql://h/db?ssl-mode=SOMETIMES").is_err());
    }

    #[test]
    fn mysql_modes_ask_for_the_right_checks() {
        assert!(my_ssl(MyTls::Disabled, None).is_none());
        let req = my_ssl(MyTls::Required, None).unwrap();
        assert!(req.accept_invalid_certs());
        let ca = my_ssl(MyTls::VerifyCa, Some("/c.pem")).unwrap();
        assert!(
            !ca.accept_invalid_certs() && ca.skip_domain_validation() && ca.root_certs().len() == 1
        );
        let full = my_ssl(MyTls::VerifyIdentity, None).unwrap();
        assert!(!full.accept_invalid_certs() && !full.skip_domain_validation());
    }

    #[test]
    fn tls_failures_are_hinted() {
        let h = db_hints(
            "mysql",
            "mysql://h/db",
            &["TLS error: `The certificate was not trusted.'".into()],
        );
        assert!(h[0].contains("ssl-ca="), "{h:?}");
        let h = db_hints(
            "mysql",
            "mysql://h/db",
            &["TLS error: `A host name mismatch has occurred.'".into()],
        );
        assert!(h[0].contains("ssl-mode=VERIFY_CA"), "{h:?}");
        let h = db_hints(
            "mysql",
            "mysql://h/db",
            &[
                "TLS error: `The validity period in the certificate exceeds the maximum allowed.'"
                    .into(),
            ],
        );
        assert!(h[0].contains("825 days"), "{h:?}");
        let h = db_hints(
            "postgres",
            "postgres://h/db?sslmode=verify-full",
            &["invalid peer certificate: UnknownIssuer".into()],
        );
        assert!(h[0].contains("sslrootcert"), "{h:?}");
        let h = db_hints(
            "postgres",
            "postgres://h/db?sslmode=verify-full",
            &["invalid peer certificate: certificate not valid for name \"127.0.0.1\"".into()],
        );
        assert!(h[0].contains("names another host"), "{h:?}");
        // a root certificate file that cannot be read is said by the error itself
        assert!(db_hints(
            "postgres",
            "postgres://h/db",
            &["sslrootcert=/x could not be read as PEM certificates".into()]
        )
        .is_empty());
        let h = db_hints(
            "postgres",
            "postgres://h/db?sslmode=require",
            &["error performing TLS handshake: server does not support TLS".into()],
        );
        assert!(h[0].contains("does not accept TLS"), "{h:?}");
        let h = db_hints("mysql", "mysql://h", &["Access denied for user".into()]);
        assert!(h[0].contains("credentials"), "{h:?}");
    }

    #[test]
    fn clickhouse_rows_and_text_formats_are_kept() {
        let lines = |s: &[&str]| s.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        let j = ch_parse(
            CH_FORMAT,
            &lines(&[r#"["a","b"]"#, r#"["UInt8","String"]"#, r#"[1,"x"]"#]),
            false,
        )
        .ok()
        .unwrap();
        assert_eq!(
            (j.columns.clone(), j.data.clone(), j.text),
            (
                vec!["a".to_string(), "b".to_string()],
                vec![json!({"a": 1, "b": "x"})],
                None
            )
        );
        let csv = ch_parse("CSV", &lines(&["1,\"x\"", "2,\"y\""]), false)
            .ok()
            .unwrap();
        assert_eq!(csv.text.as_deref(), Some("1,\"x\"\n2,\"y\""));
        assert_eq!(ch_parse("CSV", &[], false).ok().unwrap().text, None);
        let broken = ch_parse(
            CH_FORMAT,
            &lines(&[
                r#"["a"]"#,
                r#"["UInt8"]"#,
                "[1]",
                "Code: 241. DB::Exception: Memory limit exceeded",
            ]),
            false,
        );
        let e = broken.err().expect("an exception mid-stream is an error");
        assert!(
            e.server && e.chain[0].contains("Code: 241"),
            "{:?}",
            e.chain
        );
        assert_eq!(
            ch_error_text(&lines(&[
                "[]",
                "[]",
                r#"["Code: 62. DB::Exception: Syntax error"]"#
            ])),
            "Code: 62. DB::Exception: Syntax error"
        );
        assert_eq!(
            ch_error_text(&lines(&["Code: 516. Authentication failed"])),
            "Code: 516. Authentication failed"
        );
        let out = ch_text_out("1,x\n2,y", false);
        assert_eq!(out.columns, vec!["text"]);
        assert_eq!(
            out.rows,
            vec![json!({"text": "1,x"}), json!({"text": "2,y"})]
        );
        let many = (0..ROWS_MAX + 7)
            .map(|i| i.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        let out = ch_text_out(&many, false);
        assert_eq!(
            (out.row_count, out.truncated, out.total),
            (ROWS_MAX as u64, true, Some(ROWS_MAX as u64 + 7))
        );
        assert!(ch_text_out("1", true).truncated);
    }

    #[tokio::test]
    async fn a_clickhouse_result_is_read_only_up_to_the_cap() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = axum::Router::new().route(
            "/",
            axum::routing::post(|| async {
                let head = futures_util::stream::iter([Ok::<_, std::io::Error>(
                    b"[\"n\"]\n[\"UInt64\"]\n".to_vec(),
                )]);
                let rows = futures_util::stream::iter(
                    (0..1_000_000u64).map(|i| Ok(format!("[{i}]\n").into_bytes())),
                );
                (
                    [("x-clickhouse-format", CH_FORMAT)],
                    axum::body::Body::from_stream(head.chain(rows)),
                )
            }),
        );
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let out = ch_run(
            &format!("http://{addr}/"),
            "select number from numbers(1000000)",
        )
        .await
        .ok()
        .unwrap();
        assert_eq!(
            (out.row_count, out.truncated, out.total),
            (ROWS_MAX as u64, true, None)
        );
        assert_eq!(out.rows[0], json!({ "n": 0 }));
    }

    #[test]
    fn row_count_is_the_rows_sent() {
        let rows = |n: usize| (0..n).map(|i| json!({ "i": i })).collect::<Vec<_>>();
        let out = Out::capped(vec!["i".into()], rows(3));
        assert_eq!((out.row_count, out.truncated), (3, false));
        let out = Out::capped(vec!["i".into()], rows(ROWS_MAX + 1));
        assert_eq!(
            (out.row_count, out.truncated, out.rows.len()),
            (ROWS_MAX as u64, true, ROWS_MAX)
        );
    }

    #[test]
    fn connection_causes_are_added_once() {
        let mut c = vec!["connection closed".to_string()];
        add_causes(
            &mut c,
            vec![
                "connection closed".into(),
                "Connection reset by peer".into(),
            ],
        );
        assert_eq!(c, vec!["connection closed", "Connection reset by peer"]);
        assert!(timeout_hint("postgres", QUERY_TIMEOUT).contains("cancel"));
        assert!(timeout_hint("mysql", QUERY_TIMEOUT).contains("60 s"));
    }

    #[test]
    fn shown_urls_hide_passwords() {
        assert!(!shown_url("postgres://u:s3cret@h/db").contains("s3cret"));
        assert_eq!(
            shown_url("host=h user=u password=s3cret"),
            "host=h user=u password=•••"
        );
        assert_eq!(
            shown_url("host=h password = s3cret dbname=d"),
            "host=h password = ••• dbname=d"
        );
        assert_eq!(
            shown_url("host=h password='a b c' dbname=d"),
            "host=h password=••• dbname=d"
        );
    }
}
