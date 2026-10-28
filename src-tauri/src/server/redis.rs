use std::collections::HashMap;
use std::time::Instant;

use axum::{
    extract::Query,
    response::sse::{Event, Sse},
    routing::{get, post},
    Json, Router,
};
use futures_util::stream::Stream;
use redis::{AsyncCommands, Value as RedisValue};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_stream::StreamExt;

use super::attempt::{redact_url, Attempt, Reply};
use super::redis_conn::{self, normalize, Conn, Failure, ScanLimits, CONNECT_TIMEOUT};

const ELEM_MAX: isize = 500;

pub fn routes() -> Router {
    Router::new()
        .route("/ping", post(ping))
        .route("/scan", post(scan))
        .route("/get", post(get_key))
        .route("/set", post(set))
        .route("/del", post(del))
        .route("/expire", post(expire))
        .route("/cmd", post(cmd))
        .route("/children", post(children))
        .route("/info", post(info))
        .route("/export", post(export))
        .route("/cmd-batch", post(cmd_batch))
        .route("/publish", post(publish))
        .route("/subscribe", get(subscribe))
}

/// One server or a cluster, whichever `raw` points at.
async fn conn(raw: &str) -> Result<Conn, Failure> {
    redis_conn::connect(raw).await
}

/// An operation on its way, for the record: `what` with `args`, against `url`'s server with
/// the password masked.
fn begin(url: &str, what: &str, args: Value) -> Attempt {
    let bytes = args.to_string().len();
    Attempt::start(what, &redact_url(&normalize(url)), HashMap::new(), args, bytes)
}

/// A success: `body` with `ok`, the time taken and the record, whose response is `reply`.
/// Redis has no status code; the record's `status` is 0.
fn done(a: &Attempt, reply: Value, mut body: Value) -> Json<Value> {
    let bytes = reply.to_string().len();
    let log = a.succeeded(Reply {
        status: 0,
        headers: &HashMap::new(),
        trailers: None,
        body: reply,
        bytes,
    });
    body["ok"] = json!(true);
    body["durationMs"] = log["durationMs"].clone();
    body["log"] = log;
    Json(body)
}

/// A failure as `{ ok: false, stage, error, detail, durationMs, log }`.
async fn fail(a: &Attempt, f: Failure) -> Json<Value> {
    let (error, log) = record_failure(a, f).await;
    Json(json!({
        "ok": false,
        "stage": error["stage"],
        "error": error["message"],
        "detail": error,
        "durationMs": log["durationMs"],
        "log": log,
    }))
}

/// `(error, log)` for `f`: a network failure is probed, a refused input was never sent, and an
/// error reply came from a server that was reached, so it gets hints instead of a probe.
async fn record_failure(a: &Attempt, f: Failure) -> (Value, Value) {
    let connect_ms = CONNECT_TIMEOUT.as_millis() as u64;
    match f {
        Failure::Invalid(chain) => a.not_sent("request", &chain.join(": ")),
        Failure::Network(chain) => a.failed_with("network", chain, false, connect_ms).await,
        Failure::TimedOut(chain) => a.failed_with("network", chain, true, connect_ms).await,
        Failure::Reply(chain) => {
            let error = reply_error(&chain);
            let mut log = a.succeeded(Reply {
                status: 0,
                headers: &HashMap::new(),
                trailers: None,
                body: error["message"].clone(),
                bytes: 0,
            });
            log["error"] = error.clone();
            (error, log)
        }
    }
}

/// An error the server replied with, in the shape of an attempt error.
fn reply_error(chain: &[String]) -> Value {
    json!({
        "stage": "reply",
        "kind": "reply",
        "message": chain.join(": "),
        "chain": chain,
        "hints": reply_hints(chain),
        "probe": Value::Null,
    })
}

/// Plain hints for the error replies people run into most.
fn reply_hints(chain: &[String]) -> Vec<String> {
    let all = chain.join(" | ");
    let has = |w: &str| all.contains(w);
    let mut out = Vec::new();
    if has("NOAUTH") {
        out.push("The server wants a password: fill in Password (and a user, as user:password in the host, if it uses ACLs).".into());
    }
    if has("WRONGPASS") || has("invalid password") || has("invalid username-password") {
        out.push("The password (or user) was not accepted.".into());
    }
    if has("WRONGTYPE") {
        out.push("The key holds a different type of value than this command works on: TYPE shows which.".into());
    }
    if has("unknown command") {
        out.push("This server does not know the command: a newer command on an older server, or one disabled or renamed in its config.".into());
    }
    if has("MOVED") || has("ASK ") || has("CROSSSLOT") {
        out.push("The key lives on another cluster node, or the keys are on different nodes: the cluster's nodes may not be reachable from here.".into());
    }
    if has("NOPERM") {
        out.push("The user lacks the ACL permission for this command or key.".into());
    }
    if has("LOADING") {
        out.push("The server is still loading its data set: try again shortly.".into());
    }
    out
}

fn resp_to_json(v: &RedisValue) -> Value {
    match v {
        RedisValue::Nil => Value::Null,
        RedisValue::Int(i) => json!(i),
        RedisValue::BulkString(b) => Value::String(String::from_utf8_lossy(b).to_string()),
        RedisValue::SimpleString(s) => Value::String(s.clone()),
        RedisValue::Okay => Value::String("OK".into()),
        RedisValue::Double(d) => json!(d),
        RedisValue::Boolean(b) => json!(b),
        RedisValue::BigNumber(n) => Value::String(n.to_string()),
        RedisValue::Array(a) | RedisValue::Set(a) => {
            Value::Array(a.iter().map(resp_to_json).collect())
        }
        RedisValue::Map(m) => {
            let mut out = Vec::new();
            for (k, val) in m {
                out.push(resp_to_json(k));
                out.push(resp_to_json(val));
            }
            Value::Array(out)
        }
        RedisValue::VerbatimString { text, .. } => Value::String(text.clone()),
        RedisValue::Attribute { data, .. } => resp_to_json(data),
        RedisValue::Push { kind, data } => {
            let mut out = vec![Value::String(format!("{:?}", kind))];
            out.extend(data.iter().map(resp_to_json));
            Value::Array(out)
        }
        RedisValue::ServerError(e) => Value::String(format!("{:?}", e)),
    }
}

/// `XRANGE` entries as `{ id, fields: [[field, value], …] }`.
fn stream_entries(raw: &RedisValue) -> Vec<Value> {
    let RedisValue::Array(entries) = raw else {
        return Vec::new();
    };
    entries
        .iter()
        .filter_map(|e| {
            let RedisValue::Array(parts) = e else {
                return None;
            };
            let id = resp_to_json(parts.first()?);
            let flat = parts.get(1).map(resp_to_json).unwrap_or(Value::Null);
            let fields: Vec<Value> = flat
                .as_array()
                .map(|a| {
                    a.chunks(2)
                        .map(|p| json!([p[0], p.get(1).cloned().unwrap_or(Value::Null)]))
                        .collect()
                })
                .unwrap_or_default();
            Some(json!({ "id": id, "fields": fields }))
        })
        .collect()
}

/// Command arguments as strings: JSON numbers and booleans as written, null as empty.
fn arg_strings(args: &[Value]) -> Vec<String> {
    args.iter()
        .map(|v| match v {
            Value::String(s) => s.clone(),
            Value::Null => String::new(),
            other => other.to_string(),
        })
        .collect()
}

#[derive(Deserialize)]
struct PingReq {
    url: Option<String>,
}

async fn ping(Json(b): Json<PingReq>) -> Json<Value> {
    let url = b.url.unwrap_or_default();
    let a = begin(&url, "PING", json!(["PING"]));
    let mut c = match conn(&url).await {
        Ok(c) => c,
        Err(f) => return fail(&a, f).await,
    };
    match redis::cmd("PING").query_async::<String>(&mut c).await {
        Ok(pong) => done(
            &a,
            json!(pong),
            json!({
                "pong": pong,
                "cluster": !c.masters().is_empty(),
                "masters": c.masters().len(),
                "note": c.note(),
            }),
        ),
        Err(e) => fail(&a, e.into()).await,
    }
}

/// What `TYPE` says about `key`, or why it could not say: an ACL that denies the key, or a
/// cluster key on a node that cannot be reached, is not the same as a key that does not exist.
async fn key_type(c: &mut Conn, key: &str) -> Result<String, String> {
    redis::cmd("TYPE")
        .arg(key)
        .query_async::<String>(c)
        .await
        .map_err(|e| Failure::from(e).context("TYPE").message())
}

/// `entry` with `type` set, or with `type: null` and the `error` that kept it unknown.
fn put_type(entry: &mut Value, t: Result<String, String>) {
    match t {
        Ok(t) => entry["type"] = json!(t),
        Err(why) => {
            entry["type"] = Value::Null;
            entry["error"] = json!(why);
        }
    }
}

fn has_glob(p: &str) -> bool {
    p.contains('*') || p.contains('?') || p.contains('[') || p.contains(']')
}

#[derive(Deserialize)]
struct ScanReq {
    url: Option<String>,
    #[serde(default)]
    r#match: Option<String>,
    #[serde(default)]
    cursor: Option<String>,
}

async fn scan(Json(b): Json<ScanReq>) -> Json<Value> {
    let url = b.url.unwrap_or_default();
    let pat = b.r#match.filter(|s| !s.is_empty()).unwrap_or_else(|| "*".into());
    let cursor = b.cursor.unwrap_or_else(|| "0".into());
    let a = begin(&url, "SCAN", json!({ "match": pat, "cursor": cursor }));
    let mut c = match conn(&url).await {
        Ok(c) => c,
        Err(f) => return fail(&a, f).await,
    };

    if !has_glob(&pat) {
        let t: String = match redis::cmd("TYPE").arg(&pat).query_async(&mut c).await {
            Ok(t) => t,
            Err(e) => return fail(&a, e.into()).await,
        };
        let keys = if t == "none" {
            vec![]
        } else {
            vec![json!({ "key": pat, "type": t })]
        };
        return done(&a, json!({ "keys": keys.len() }), json!({ "cursor": "0", "keys": keys }));
    }

    let limits = ScanLimits { count: 300, want: 200, max_calls: 60 };
    let (cur, found) = match redis_conn::scan(&mut c, &pat, &cursor, &limits).await {
        Ok(page) => (page.cursor, page.keys),
        Err(f) => return fail(&a, f).await,
    };

    let mut keys = Vec::with_capacity(found.len());
    for k in &found {
        let mut entry = json!({ "key": k });
        put_type(&mut entry, key_type(&mut c, k).await);
        keys.push(entry);
    }

    done(
        &a,
        json!({ "keys": keys.len(), "cursor": cur }),
        json!({ "cursor": cur, "keys": keys }),
    )
}

async fn read_value(
    c: &mut Conn,
    key: &str,
    ty: &str,
    cursor: Option<&str>,
) -> Result<(Value, i64, Value), Failure> {
    match ty {
        "string" => {
            let v: Option<String> = c.get(key).await?;
            Ok((json!(v), 1, Value::Null))
        }
        "hash" => {
            let total: i64 = c.hlen(key).await?;
            let mut pairs: Vec<Value> = Vec::new();
            let mut cur = cursor.unwrap_or("0").to_string();
            loop {
                let (next, flat): (String, Vec<String>) = redis::cmd("HSCAN")
                    .arg(key)
                    .arg(&cur)
                    .arg("COUNT")
                    .arg(200)
                    .query_async(c)
                    .await?;
                let mut i = 0;
                while i + 1 < flat.len() {
                    pairs.push(json!([flat[i], flat[i + 1]]));
                    i += 2;
                }
                cur = next;
                if cur == "0" || pairs.len() >= ELEM_MAX as usize {
                    break;
                }
            }
            let nc = if cur != "0" { json!(cur) } else { Value::Null };
            Ok((Value::Array(pairs), total, nc))
        }
        "zset" => {
            let total: i64 = c.zcard(key).await?;
            let off: isize = cursor.and_then(|s| s.parse().ok()).unwrap_or(0);
            // WITHSCORES answers member, score, member, score…: rows are [member, score]
            let flat: Vec<String> = redis::cmd("ZRANGE")
                .arg(key)
                .arg(off)
                .arg(off + ELEM_MAX - 1)
                .arg("WITHSCORES")
                .query_async(c)
                .await?;
            let mut page: Vec<Value> = Vec::new();
            let mut i = 0;
            while i + 1 < flat.len() {
                page.push(json!([flat[i], flat[i + 1]]));
                i += 2;
            }
            let consumed = off + page.len() as isize;
            let nc = if (consumed as i64) < total {
                json!(consumed.to_string())
            } else {
                Value::Null
            };
            Ok((Value::Array(page), total, nc))
        }
        "list" => {
            let total: i64 = c.llen(key).await?;
            let off: isize = cursor.and_then(|s| s.parse().ok()).unwrap_or(0);
            let page: Vec<String> = c.lrange(key, off, off + ELEM_MAX - 1).await?;
            let consumed = off + page.len() as isize;
            let nc = if (consumed as i64) < total {
                json!(consumed.to_string())
            } else {
                Value::Null
            };
            Ok((json!(page), total, nc))
        }
        "set" => {
            let total: i64 = c.scard(key).await?;
            let mut members: Vec<String> = Vec::new();
            let mut cur = cursor.unwrap_or("0").to_string();
            loop {
                let (next, batch): (String, Vec<String>) = redis::cmd("SSCAN")
                    .arg(key)
                    .arg(&cur)
                    .arg("COUNT")
                    .arg(200)
                    .query_async(c)
                    .await?;
                members.extend(batch);
                cur = next;
                if cur == "0" || members.len() >= ELEM_MAX as usize {
                    break;
                }
            }
            let nc = if cur != "0" { json!(cur) } else { Value::Null };
            Ok((json!(members), total, nc))
        }
        "stream" => {
            let total: i64 = c.xlen(key).await?;
            let start = match cursor {
                Some(id) if !id.is_empty() => format!("({}", id),
                _ => "-".to_string(),
            };
            let raw: RedisValue = redis::cmd("XRANGE")
                .arg(key)
                .arg(&start)
                .arg("+")
                .arg("COUNT")
                .arg(ELEM_MAX)
                .query_async(c)
                .await?;
            let page = stream_entries(&raw);
            let nc = if page.len() == ELEM_MAX as usize {
                page.last().map(|e| e["id"].clone()).unwrap_or(Value::Null)
            } else {
                Value::Null
            };
            Ok((Value::Array(page), total, nc))
        }
        _ => Ok((Value::Null, 0, Value::Null)),
    }
}

#[derive(Deserialize)]
struct GetReq {
    url: Option<String>,
    key: Option<String>,
    #[serde(default)]
    cursor: Option<String>,
}

async fn get_key(Json(b): Json<GetReq>) -> Json<Value> {
    let url = b.url.unwrap_or_default();
    let key = b.key.unwrap_or_default();
    let a = begin(&url, "READ KEY", json!({ "key": key, "cursor": b.cursor }));
    let mut c = match conn(&url).await {
        Ok(c) => c,
        Err(f) => return fail(&a, f).await,
    };
    let ty: String = match redis::cmd("TYPE").arg(&key).query_async(&mut c).await {
        Ok(t) => t,
        Err(e) => return fail(&a, Failure::from(e).context("TYPE")).await,
    };
    if ty == "none" {
        // not an error: the caller may browse it as a prefix instead
        let mut out = done(&a, json!("none"), json!({ "missing": true, "error": "key does not exist" }));
        out.0["ok"] = json!(false);
        return out;
    }
    let ttl: i64 = match redis::cmd("TTL").arg(&key).query_async(&mut c).await {
        Ok(t) => t,
        Err(e) => return fail(&a, Failure::from(e).context("TTL")).await,
    };
    match read_value(&mut c, &key, &ty, b.cursor.as_deref()).await {
        Ok((value, total, next_cursor)) => {
            let view = json!({
                "key": key,
                "type": ty,
                "ttl": ttl,
                "value": value,
                "total": total,
                "nextCursor": next_cursor
            });
            done(&a, view.clone(), json!({ "view": view }))
        }
        Err(f) => fail(&a, f).await,
    }
}

#[derive(Deserialize)]
struct SetReq {
    url: Option<String>,
    key: Option<String>,
    r#type: Option<String>,
    value: Option<Value>,
    field: Option<String>,
    member: Option<String>,
    score: Option<Value>,
    #[serde(default)]
    left: bool,
    ttl: Option<Value>,
}

fn as_str(v: &Option<Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

async fn set(Json(b): Json<SetReq>) -> Json<Value> {
    let url = b.url.unwrap_or_default();
    let key = b.key.unwrap_or_default();
    let ty = b.r#type.clone().unwrap_or_default();
    let a = begin(&url, "SET VALUE", json!({ "key": key, "type": ty }));
    let mut c = match conn(&url).await {
        Ok(c) => c,
        Err(f) => return fail(&a, f).await,
    };

    let res: Result<(), Failure> = async {
        match ty.as_str() {
            "string" => {
                let _: () = c.set(&key, as_str(&b.value)).await?;
            }
            "hash" => {
                let _: () = c
                    .hset(&key, b.field.clone().unwrap_or_default(), as_str(&b.value))
                    .await?;
            }
            "zset" => {
                let _: () = redis::cmd("ZADD")
                    .arg(&key)
                    .arg(as_str(&b.score))
                    .arg(b.member.clone().unwrap_or_default())
                    .query_async(&mut c)
                    .await?;
            }
            "list" => {
                let cmd = if b.left { "LPUSH" } else { "RPUSH" };
                let _: () = redis::cmd(cmd)
                    .arg(&key)
                    .arg(as_str(&b.value))
                    .query_async(&mut c)
                    .await?;
            }
            "set" => {
                let _: () = c.sadd(&key, b.member.clone().unwrap_or_default()).await?;
            }
            _ => return Err(Failure::Invalid(vec![format!("unsupported type {}", ty)])),
        }
        Ok(())
    }
    .await;

    if let Err(f) = res {
        return fail(&a, f).await;
    }

    let ttl = b
        .ttl
        .as_ref()
        .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())));
    if let Some(t) = ttl {
        if t > 0 {
            if let Err(e) = c.expire::<_, i64>(&key, t).await {
                return fail(&a, Failure::from(e).context("EXPIRE")).await;
            }
        }
    }

    done(&a, json!("OK"), json!({}))
}

#[derive(Deserialize)]
struct DelReq {
    url: Option<String>,
    key: Option<String>,
    r#type: Option<String>,
    member: Option<String>,
}

async fn del(Json(b): Json<DelReq>) -> Json<Value> {
    let url = b.url.unwrap_or_default();
    let key = b.key.unwrap_or_default();
    let a = begin(
        &url,
        "DELETE",
        json!({ "key": key, "type": b.r#type, "member": b.member }),
    );
    let mut c = match conn(&url).await {
        Ok(c) => c,
        Err(f) => return fail(&a, f).await,
    };

    // how many were removed: 0 means the member (or key) was not there
    let res: Result<i64, Failure> = async {
        Ok(match (b.member.as_deref(), b.r#type.as_deref()) {
            (Some(m), Some("hash")) => c.hdel(&key, m).await?,
            (Some(m), Some("zset")) => c.zrem(&key, m).await?,
            (Some(m), Some("set")) => c.srem(&key, m).await?,
            (Some(m), Some("list")) => {
                redis::cmd("LREM")
                    .arg(&key)
                    .arg(1)
                    .arg(m)
                    .query_async(&mut c)
                    .await?
            }
            // a stream entry goes by its id
            (Some(id), Some("stream")) => {
                redis::cmd("XDEL").arg(&key).arg(id).query_async(&mut c).await?
            }
            _ => c.del(&key).await?,
        })
    }
    .await;

    match res {
        Ok(n) => done(&a, json!(n), json!({ "removed": n })),
        Err(f) => fail(&a, f).await,
    }
}

#[derive(Deserialize)]
struct ExpireReq {
    url: Option<String>,
    key: Option<String>,
    ttl: Option<Value>,
}

async fn expire(Json(b): Json<ExpireReq>) -> Json<Value> {
    let url = b.url.unwrap_or_default();
    let key = b.key.unwrap_or_default();
    let a = begin(&url, "EXPIRE", json!({ "key": key, "ttl": b.ttl }));
    // a TTL that is not a whole number must never reach EXPIRE as 0, which deletes the key
    let ttl = match parse_ttl(b.ttl.as_ref()) {
        Ok(t) => t,
        Err(why) => {
            let (error, log) = a.not_sent("request", why);
            return Json(json!({ "ok": false, "stage": "request", "error": why, "detail": error, "durationMs": 0, "log": log }));
        }
    };
    let mut c = match conn(&url).await {
        Ok(c) => c,
        Err(f) => return fail(&a, f).await,
    };
    let res = if ttl < 0 {
        redis::cmd("PERSIST").arg(&key).query_async::<i64>(&mut c).await
    } else {
        redis::cmd("EXPIRE").arg(&key).arg(ttl).query_async::<i64>(&mut c).await
    };
    match res {
        // 0: no such key, or (PERSIST) a key that had no expiry
        Ok(n) => done(&a, json!(n), json!({ "applied": n })),
        Err(e) => fail(&a, e.into()).await,
    }
}

/// A TTL in whole seconds from the panel: a positive number sets the expiry, `-1` removes it.
/// Anything else (missing, `1h`, `1.5`, `0`) is refused: `EXPIRE key 0` deletes the key, and a
/// typo must not do that.
fn parse_ttl(v: Option<&Value>) -> Result<i64, &'static str> {
    let n = v
        .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok())))
        .ok_or("TTL must be a whole number of seconds (or -1 to remove the expiry)")?;
    match n {
        0 => Err("A TTL of 0 would delete the key; use Delete to remove it"),
        n if n < -1 => Err("TTL must be a positive number of seconds, or -1 to remove the expiry"),
        n => Ok(n),
    }
}

#[derive(Deserialize)]
struct CmdReq {
    url: Option<String>,
    args: Option<Vec<Value>>,
}

async fn cmd(Json(b): Json<CmdReq>) -> Json<Value> {
    let url = b.url.unwrap_or_default();
    let strs = arg_strings(&b.args.unwrap_or_default());
    let a = begin(&url, "COMMAND", json!(logged_args(&strs)));
    if strs.is_empty() {
        return fail(&a, Failure::Invalid(vec!["empty command".into()])).await;
    }
    let mut c = match conn(&url).await {
        Ok(c) => c,
        Err(f) => return fail(&a, f).await,
    };
    let mut command = redis::cmd(&strs[0]);
    for arg in &strs[1..] {
        command.arg(arg);
    }
    match command.query_async::<RedisValue>(&mut c).await {
        Ok(v) => {
            let reply = resp_to_json(&v);
            done(&a, reply.clone(), json!({ "reply": reply }))
        }
        Err(e) => fail(&a, e.into()).await,
    }
}

#[derive(Deserialize)]
struct ChildrenReq {
    url: Option<String>,
    #[serde(default)]
    prefix: Option<String>,
    #[serde(default)]
    sep: Option<String>,
}

async fn children(Json(b): Json<ChildrenReq>) -> Json<Value> {
    let url = b.url.unwrap_or_default();
    let prefix = b.prefix.unwrap_or_default();
    let sep = b.sep.filter(|s| !s.is_empty()).unwrap_or_else(|| ":".into());
    let a = begin(&url, "SCAN (by prefix)", json!({ "prefix": prefix, "sep": sep }));
    let mut c = match conn(&url).await {
        Ok(c) => c,
        Err(f) => return fail(&a, f).await,
    };

    let pat = format!("{}*", prefix);
    let limits = ScanLimits { count: 1000, want: 5000, max_calls: 60 };
    let (keys, complete) = match redis_conn::scan(&mut c, &pat, "0", &limits).await {
        Ok(page) => (page.keys, page.cursor == "0"),
        Err(f) => return fail(&a, f).await,
    };

    struct Seg {
        seg: String,
        has_children: bool,
        is_key: bool,
        count: i64,
    }
    let mut order: Vec<String> = Vec::new();
    let mut map: HashMap<String, Seg> = HashMap::new();
    for k in &keys {
        let rest = &k[prefix.len().min(k.len())..];
        let (name, is_leaf) = match rest.find(&sep) {
            Some(i) => (rest[..i].to_string(), false),
            None => (rest.to_string(), true),
        };
        let e = map.entry(name.clone()).or_insert_with(|| {
            order.push(name.clone());
            Seg {
                seg: name.clone(),
                has_children: false,
                is_key: false,
                count: 0,
            }
        });
        if is_leaf {
            e.is_key = true;
        } else {
            e.has_children = true;
        }
        e.count += 1;
    }
    order.sort();

    let mut type_of: HashMap<String, Result<String, String>> = HashMap::new();
    for name in &order {
        let e = &map[name];
        if e.is_key {
            let full = format!("{}{}", prefix, e.seg);
            let t = key_type(&mut c, &full).await;
            type_of.insert(full, t);
        }
    }

    let children: Vec<Value> = order
        .iter()
        .map(|name| {
            let e = &map[name];
            let full = format!("{}{}", prefix, e.seg);
            let mut obj = json!({
                "seg": e.seg,
                "hasChildren": e.has_children,
                "isKey": e.is_key,
                "count": e.count,
                "full": full,
            });
            if e.is_key {
                put_type(&mut obj, type_of.remove(&full).unwrap_or_else(|| Ok("none".into())));
            }
            obj
        })
        .collect();

    done(
        &a,
        json!({ "keys": keys.len(), "children": children.len(), "truncated": !complete }),
        json!({
            "prefix": prefix,
            "truncated": !complete,
            "children": children,
        }),
    )
}

#[derive(Deserialize)]
struct InfoReq {
    url: Option<String>,
}

async fn info(Json(b): Json<InfoReq>) -> Json<Value> {
    let url = b.url.unwrap_or_default();
    let a = begin(&url, "INFO", json!(["INFO"]));
    let mut c = match conn(&url).await {
        Ok(c) => c,
        Err(f) => return fail(&a, f).await,
    };
    let raw: String = match redis::cmd("INFO").query_async(&mut c).await {
        Ok(v) => v,
        Err(e) => return fail(&a, e.into()).await,
    };
    let mut sections = serde_json::Map::new();
    let mut cur = "general".to_string();
    for line in raw.split('\n') {
        let l = line.trim();
        if l.is_empty() {
            continue;
        }
        if let Some(rest) = l.strip_prefix('#') {
            cur = rest.trim().to_lowercase();
            sections
                .entry(cur.clone())
                .or_insert_with(|| Value::Object(serde_json::Map::new()));
            continue;
        }
        if let Some(i) = l.find(':') {
            if i > 0 {
                let obj = sections
                    .entry(cur.clone())
                    .or_insert_with(|| Value::Object(serde_json::Map::new()));
                if let Value::Object(m) = obj {
                    m.insert(l[..i].to_string(), json!(l[i + 1..].to_string()));
                }
            }
        }
    }
    done(&a, json!(raw), json!({ "sections": Value::Object(sections) }))
}

#[derive(Deserialize)]
struct ExportReq {
    url: Option<String>,
    #[serde(default)]
    r#match: Option<String>,
    #[serde(default)]
    limit: Option<Value>,
}

/// One key for an export: its entry, and what went wrong reading it, if anything. A key that
/// fails keeps whatever was read, and says why in `error`.
async fn export_key(c: &mut Conn, key: &str) -> (Value, Option<String>) {
    let ty: String = match redis::cmd("TYPE").arg(key).query_async(c).await {
        Ok(t) => t,
        Err(e) => {
            let why = Failure::from(e).context("TYPE").message();
            return (json!({ "error": why }), Some(why));
        }
    };
    let mut entry = json!({ "type": ty });
    let mut errors: Vec<String> = Vec::new();
    match redis::cmd("TTL").arg(key).query_async::<i64>(c).await {
        Ok(t) => entry["ttl"] = json!(t),
        Err(e) => errors.push(Failure::from(e).context("TTL").message()),
    }
    match read_value(c, key, &ty, None).await {
        Ok((value, total, _)) => {
            entry["value"] = value;
            entry["total"] = json!(total);
        }
        Err(f) => errors.push(f.context("read value").message()),
    }
    if errors.is_empty() {
        return (entry, None);
    }
    let why = errors.join("; ");
    entry["error"] = json!(why);
    (entry, Some(why))
}

async fn export(Json(b): Json<ExportReq>) -> Json<Value> {
    let url = b.url.unwrap_or_default();
    let pat = b.r#match.filter(|s| !s.is_empty()).unwrap_or_else(|| "*".into());
    let limit = b
        .limit
        .as_ref()
        .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
        .filter(|n| *n > 0)
        .unwrap_or(1000);
    let cap = limit.min(5000) as usize;
    let a = begin(&url, "EXPORT", json!({ "match": pat, "limit": cap }));
    let mut c = match conn(&url).await {
        Ok(c) => c,
        Err(f) => return fail(&a, f).await,
    };

    let limits = ScanLimits { count: 500, want: cap, max_calls: 100 };
    let (cur, keys) = match redis_conn::scan(&mut c, &pat, "0", &limits).await {
        Ok(page) => (page.cursor, page.keys),
        Err(f) => return fail(&a, f).await,
    };

    let slice: Vec<String> = keys.iter().take(cap).cloned().collect();
    let mut data = serde_json::Map::new();
    let mut failed: Vec<Value> = Vec::new();
    for k in &slice {
        let (entry, why) = export_key(&mut c, k).await;
        if let Some(why) = why {
            failed.push(json!({ "key": k, "error": why }));
        }
        data.insert(k.clone(), entry);
    }

    let truncated = keys.len() > cap || cur != "0";
    done(
        &a,
        json!({ "count": slice.len(), "truncated": truncated, "failed": failed.len() }),
        json!({
            "count": slice.len(),
            "truncated": truncated,
            "failed": failed,
            "data": Value::Object(data),
        }),
    )
}

#[derive(Deserialize)]
struct CmdBatchReq {
    url: Option<String>,
    argvs: Option<Vec<Vec<Value>>>,
}

async fn cmd_batch(Json(b): Json<CmdBatchReq>) -> Json<Value> {
    let url = b.url.unwrap_or_default();
    let argvs = b.argvs.unwrap_or_default();
    let logged: Vec<Vec<String>> = argvs.iter().map(|argv| logged_args(&arg_strings(argv))).collect();
    let a = begin(&url, "BATCH", json!(logged));
    if argvs.is_empty() {
        return fail(&a, Failure::Invalid(vec!["no commands".into()])).await;
    }
    let mut c = match conn(&url).await {
        Ok(c) => c,
        Err(f) => return fail(&a, f).await,
    };
    let mut results: Vec<Value> = Vec::with_capacity(argvs.len());
    for (argv, shown) in argvs.iter().zip(&logged) {
        if argv.is_empty() {
            results.push(json!({ "argv": shown, "ok": false, "error": "empty command", "ms": 0 }));
            continue;
        }
        let strs = arg_strings(argv);
        let mut command = redis::cmd(&strs[0]);
        for arg in &strs[1..] {
            command.arg(arg);
        }
        let t0 = Instant::now();
        let r = command.query_async::<RedisValue>(&mut c).await;
        let ms = t0.elapsed().as_millis();
        match r {
            Ok(v) => results.push(json!({ "argv": shown, "ok": true, "reply": resp_to_json(&v), "ms": ms })),
            Err(e) => results.push(json!({ "argv": shown, "ok": false, "error": Failure::from(e).message(), "ms": ms })),
        }
    }
    let ok = results.iter().filter(|r| r["ok"] == true).count();
    done(
        &a,
        json!({ "ok": ok, "failed": results.len() - ok }),
        json!({ "results": results }),
    )
}

#[derive(Deserialize)]
struct PublishReq {
    url: Option<String>,
    channel: Option<String>,
    message: Option<String>,
}

async fn publish(Json(b): Json<PublishReq>) -> Json<Value> {
    let url = b.url.unwrap_or_default();
    let channel = b.channel.unwrap_or_default();
    let message = b.message.unwrap_or_default();
    let a = begin(&url, "PUBLISH", json!({ "channel": channel, "message": message }));
    let mut c = match conn(&url).await {
        Ok(c) => c,
        Err(f) => return fail(&a, f).await,
    };
    match c.publish::<_, _, i64>(&channel, &message).await {
        Ok(receivers) => done(&a, json!(receivers), json!({ "receivers": receivers })),
        Err(e) => fail(&a, e.into()).await,
    }
}

#[derive(Deserialize)]
struct SubQuery {
    url: Option<String>,
    channels: Option<String>,
    pattern: Option<String>,
}

/// A pub/sub payload as `{ message, encoding }`: the text when it is UTF-8, otherwise base64
/// with a `note` saying so and a hex preview, so a binary payload never shows as empty.
fn payload_view(bytes: &[u8]) -> Value {
    use base64::Engine;
    const HEX_PREVIEW: usize = 64;
    match std::str::from_utf8(bytes) {
        Ok(s) => json!({ "message": s, "encoding": "utf8" }),
        Err(_) => {
            let hex: Vec<String> = bytes.iter().take(HEX_PREVIEW).map(|x| format!("{x:02x}")).collect();
            let more = if bytes.len() > HEX_PREVIEW { " …" } else { "" };
            json!({
                "message": base64::engine::general_purpose::STANDARD.encode(bytes),
                "encoding": "base64",
                "note": format!(
                    "binary, {} bytes, not UTF-8: shown as base64. Hex: {}{more}",
                    bytes.len(),
                    hex.join(" ")
                ),
            })
        }
    }
}

/// Pass `events` on to `tx` until either side ends. The page leaving is noticed even while no
/// message arrives, so the subscription's connection does not outlive it. True when the
/// server side ended.
async fn forward(events: impl Stream<Item = Event>, tx: &tokio::sync::mpsc::Sender<Event>) -> bool {
    tokio::pin!(events);
    loop {
        tokio::select! {
            _ = tx.closed() => return false,
            next = events.next() => match next {
                Some(ev) => {
                    if tx.send(ev).await.is_err() {
                        return false;
                    }
                }
                None => return true,
            },
        }
    }
}

/// Arguments as a record shows them: a password in AUTH, HELLO … AUTH, CONFIG SET requirepass /
/// masterauth, MIGRATE … AUTH / AUTH2 and ACL SETUSER rules is masked.
fn logged_args(args: &[String]) -> Vec<String> {
    const MASK: &str = "•••";
    let mut out = args.to_vec();
    let upper: Vec<String> = args.iter().map(|a| a.to_ascii_uppercase()).collect();
    let Some(cmd) = upper.first() else { return out };
    match cmd.as_str() {
        "AUTH" if out.len() > 1 => {
            let last = out.len() - 1;
            out[last] = MASK.into();
        }
        "HELLO" | "MIGRATE" => {
            for (i, word) in upper.iter().enumerate().skip(1) {
                // HELLO … AUTH user pass, MIGRATE … AUTH pass, MIGRATE … AUTH2 user pass
                let at = match (cmd.as_str(), word.as_str()) {
                    ("HELLO", "AUTH") | ("MIGRATE", "AUTH2") => i + 2,
                    ("MIGRATE", "AUTH") => i + 1,
                    _ => continue,
                };
                if let Some(p) = out.get_mut(at) {
                    *p = MASK.into();
                }
            }
        }
        "CONFIG" if upper.get(1).map(String::as_str) == Some("SET") => {
            let mut i = 2;
            while i + 1 < out.len() {
                if is_secret_config(&upper[i]) {
                    out[i + 1] = MASK.into();
                }
                i += 2;
            }
        }
        "ACL" if upper.get(1).map(String::as_str) == Some("SETUSER") => {
            for a in out.iter_mut().skip(3) {
                if a.starts_with('>') || a.starts_with('<') || a.starts_with('#') || a.starts_with('!') {
                    *a = format!("{}{MASK}", &a[..1]);
                }
            }
        }
        _ => {}
    }
    out
}

fn is_secret_config(name: &str) -> bool {
    matches!(name, "REQUIREPASS" | "MASTERAUTH" | "MASTERUSER") || name.contains("PASS")
}

/// An SSE `error` event carrying `{ error, detail, log }` for `f`.
async fn error_event(a: &Attempt, f: Failure) -> Event {
    let (error, log) = record_failure(a, f).await;
    let data = json!({ "error": error["message"], "detail": error, "log": log });
    Event::default().event("error").data(data.to_string())
}

async fn subscribe(
    Query(q): Query<SubQuery>,
) -> Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>> {
    let raw = q.url.unwrap_or_default();
    let url = normalize(&raw);
    let channels: Vec<String> = q
        .channels
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let pattern = q.pattern.as_deref() == Some("1");

    let (tx, rx) = tokio::sync::mpsc::channel::<Event>(256);
    let ready_data = channels.join(",");
    let what = if pattern { "PSUBSCRIBE" } else { "SUBSCRIBE" };
    let a = begin(&raw, what, json!(channels));

    tokio::spawn(async move {
        let client = match redis::Client::open(url) {
            Ok(c) => c,
            Err(e) => {
                let _ = tx.send(error_event(&a, e.into()).await).await;
                return;
            }
        };
        let mut pubsub = match redis_conn::within_connect_timeout(client.get_async_pubsub()).await {
            Ok(p) => p,
            Err(f) => {
                let _ = tx.send(error_event(&a, f).await).await;
                return;
            }
        };
        let sub_res = if pattern {
            pubsub.psubscribe(&channels).await
        } else {
            pubsub.subscribe(&channels).await
        };
        if let Err(e) = sub_res {
            let _ = tx.send(error_event(&a, e.into()).await).await;
            return;
        }
        let _ = tx
            .send(Event::default().event("ready").data(ready_data))
            .await;

        let messages = pubsub.on_message().map(|msg| {
            let mut data = payload_view(msg.get_payload_bytes());
            data["channel"] = json!(msg.get_channel_name());
            data["at"] = json!(chrono::Utc::now().to_rfc3339());
            Event::default().event("message").data(data.to_string())
        });
        if forward(messages, &tx).await {
            // the server side ended: say so instead of leaving a silent feed
            let ended = Failure::Network(vec!["the server closed the subscription connection".into()]);
            let _ = tx.send(error_event(&a, ended).await).await;
        }
    });

    let stream = tokio_stream::wrappers::ReceiverStream::new(rx).map(Ok);
    Sse::new(stream)
}

#[cfg(test)]
mod tests {

    #[test]
    fn a_ttl_typo_never_becomes_expire_0() {
        assert_eq!(parse_ttl(Some(&json!(60))), Ok(60));
        assert_eq!(parse_ttl(Some(&json!("120"))), Ok(120));
        assert_eq!(parse_ttl(Some(&json!(-1))), Ok(-1));
        for bad in [json!("1h"), json!(null), json!(1.5), json!(0), json!("0"), json!(-5)] {
            assert!(parse_ttl(Some(&bad)).is_err(), "{bad}");
        }
        assert!(parse_ttl(None).is_err());
    }

    use super::*;

    fn bulk(s: &str) -> RedisValue {
        RedisValue::BulkString(s.as_bytes().to_vec())
    }

    #[test]
    fn stream_entries_carry_their_id_and_field_pairs() {
        let raw = RedisValue::Array(vec![
            RedisValue::Array(vec![
                bulk("1-0"),
                RedisValue::Array(vec![bulk("a"), bulk("1"), bulk("b"), bulk("2")]),
            ]),
            RedisValue::Array(vec![bulk("2-0"), RedisValue::Array(vec![])]),
        ]);
        assert_eq!(
            Value::Array(stream_entries(&raw)),
            json!([
                { "id": "1-0", "fields": [["a", "1"], ["b", "2"]] },
                { "id": "2-0", "fields": [] }
            ])
        );
        assert!(stream_entries(&RedisValue::Nil).is_empty());
    }

    #[test]
    fn an_odd_field_list_keeps_the_last_field() {
        let raw = RedisValue::Array(vec![RedisValue::Array(vec![
            bulk("1-0"),
            RedisValue::Array(vec![bulk("a")]),
        ])]);
        assert_eq!(stream_entries(&raw)[0]["fields"], json!([["a", null]]));
    }

    #[test]
    fn reply_errors_name_the_usual_causes() {
        let h = reply_hints(&["NOAUTH Authentication required.".into()]);
        assert!(h.iter().any(|s| s.contains("password")), "{h:?}");
        let h = reply_hints(&["WRONGTYPE Operation against a key holding the wrong kind of value".into()]);
        assert!(h.iter().any(|s| s.contains("TYPE")), "{h:?}");
        assert!(reply_hints(&["ERR syntax error".into()]).is_empty());
        let e = reply_error(&["TTL".into(), "ERR boom".into()]);
        assert_eq!(e["message"], "TTL: ERR boom");
        assert_eq!(e["kind"], "reply");
        assert!(e["probe"].is_null());
    }

    #[test]
    fn binary_payloads_are_base64_with_a_note() {
        let v = payload_view(b"hi");
        assert_eq!(v, json!({ "message": "hi", "encoding": "utf8" }));
        let v = payload_view(&[0xff, 0x00, 0x10]);
        assert_eq!(v["encoding"], "base64");
        assert_eq!(v["message"], "/wAQ");
        let note = v["note"].as_str().unwrap();
        assert!(note.contains("3 bytes") && note.contains("ff 00 10"), "{note}");
    }

    #[test]
    fn a_type_that_could_not_be_read_says_why() {
        let mut e = json!({ "key": "k" });
        put_type(&mut e, Ok("hash".into()));
        assert_eq!(e, json!({ "key": "k", "type": "hash" }));
        let mut e = json!({ "key": "k" });
        put_type(&mut e, Err("TYPE: NOPERM no permissions".into()));
        assert!(e["type"].is_null());
        assert_eq!(e["error"], "TYPE: NOPERM no permissions");
    }

    #[test]
    fn args_become_strings() {
        assert_eq!(
            arg_strings(&[json!("SET"), json!(1), json!(null), json!(true)]),
            ["SET", "1", "", "true"]
        );
    }

    #[test]
    fn passwords_in_commands_are_never_logged() {
        let a = |s: &[&str]| logged_args(&s.iter().map(|x| x.to_string()).collect::<Vec<_>>());
        assert_eq!(a(&["auth", "pw"]), vec!["auth", "•••"]);
        assert_eq!(a(&["AUTH", "user", "pw"]), vec!["AUTH", "user", "•••"]);
        assert_eq!(a(&["HELLO", "3", "AUTH", "user", "pw", "SETNAME", "x"]), vec!["HELLO", "3", "AUTH", "user", "•••", "SETNAME", "x"]);
        assert_eq!(a(&["CONFIG", "SET", "maxmemory", "1mb", "requirepass", "pw", "masterauth", "pw2"]), vec!["CONFIG", "SET", "maxmemory", "1mb", "requirepass", "•••", "masterauth", "•••"]);
        assert_eq!(a(&["MIGRATE", "h", "6379", "k", "0", "1000", "AUTH", "pw"])[7], "•••");
        assert_eq!(a(&["MIGRATE", "h", "6379", "k", "0", "1000", "AUTH2", "u", "pw"])[8], "•••");
        assert_eq!(a(&["ACL", "SETUSER", "bob", "on", ">pw", "~*"]), vec!["ACL", "SETUSER", "bob", "on", ">•••", "~*"]);
        assert_eq!(a(&["GET", "auth"]), vec!["GET", "auth"]);
    }

    #[tokio::test]
    async fn a_subscription_ends_when_the_page_leaves_even_with_no_messages() {
        let (tx, rx) = tokio::sync::mpsc::channel::<Event>(4);
        let quiet = futures_util::stream::pending::<Event>();
        let task = tokio::spawn(async move { forward(quiet, &tx).await });
        drop(rx);
        let ended = tokio::time::timeout(std::time::Duration::from_secs(2), task).await;
        assert!(!ended.expect("the task noticed").unwrap());
    }
}
