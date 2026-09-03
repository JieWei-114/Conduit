// redis = { version = "0.27", features = ["tokio-comp"] }
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

fn normalize(raw: &str) -> String {
    let t = raw.trim();
    let lower = t.to_ascii_lowercase();
    if lower.starts_with("redis://") || lower.starts_with("rediss://") {
        t.to_string()
    } else {
        format!("redis://{}", t)
    }
}

async fn conn(raw: &str) -> Result<redis::aio::MultiplexedConnection, String> {
    if raw.trim().is_empty() {
        return Err("missing connection url".into());
    }
    let url = normalize(raw);
    let client = redis::Client::open(url).map_err(|e| e.to_string())?;
    client
        .get_multiplexed_async_connection()
        .await
        .map_err(|e| e.to_string())
}

fn err(e: impl std::fmt::Display) -> Json<Value> {
    Json(json!({ "ok": false, "error": e.to_string() }))
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

#[derive(Deserialize)]
struct PingReq {
    url: Option<String>,
}

async fn ping(Json(b): Json<PingReq>) -> Json<Value> {
    let url = b.url.unwrap_or_default();
    let mut c = match conn(&url).await {
        Ok(c) => c,
        Err(e) => return err(e),
    };
    match redis::cmd("PING").query_async::<String>(&mut c).await {
        Ok(pong) => Json(json!({ "ok": true, "pong": pong })),
        Err(e) => err(e),
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
    let mut c = match conn(&url).await {
        Ok(c) => c,
        Err(e) => return err(e),
    };

    if !has_glob(&pat) {
        let t: String = match redis::cmd("TYPE").arg(&pat).query_async(&mut c).await {
            Ok(t) => t,
            Err(e) => return err(e),
        };
        let keys = if t == "none" {
            vec![]
        } else {
            vec![json!({ "key": pat, "type": t })]
        };
        return Json(json!({ "ok": true, "cursor": "0", "keys": keys }));
    }

    let target = 200usize;
    let max_iter = 60;
    let mut cur = cursor;
    let mut found: Vec<String> = Vec::new();
    let mut iter = 0;
    loop {
        let res: Result<(String, Vec<String>), _> = redis::cmd("SCAN")
            .arg(&cur)
            .arg("MATCH")
            .arg(&pat)
            .arg("COUNT")
            .arg(300)
            .query_async(&mut c)
            .await;
        let (next, batch) = match res {
            Ok(v) => v,
            Err(e) => return err(e),
        };
        found.extend(batch);
        cur = next;
        iter += 1;
        if cur == "0" || found.len() >= target || iter >= max_iter {
            break;
        }
    }

    let mut keys = Vec::with_capacity(found.len());
    for k in &found {
        let t: String = redis::cmd("TYPE")
            .arg(k)
            .query_async(&mut c)
            .await
            .unwrap_or_else(|_| "none".into());
        keys.push(json!({ "key": k, "type": t }));
    }

    Json(json!({ "ok": true, "cursor": cur, "keys": keys }))
}

async fn read_value(
    c: &mut redis::aio::MultiplexedConnection,
    key: &str,
    ty: &str,
    cursor: Option<&str>,
) -> Result<(Value, i64, Value), String> {
    match ty {
        "string" => {
            let v: Option<String> = c.get(key).await.map_err(|e| e.to_string())?;
            Ok((json!(v), 1, Value::Null))
        }
        "hash" => {
            let total: i64 = c.hlen(key).await.map_err(|e| e.to_string())?;
            let mut pairs: Vec<Value> = Vec::new();
            let mut cur = cursor.unwrap_or("0").to_string();
            loop {
                let (next, flat): (String, Vec<String>) = redis::cmd("HSCAN")
                    .arg(key)
                    .arg(&cur)
                    .arg("COUNT")
                    .arg(200)
                    .query_async(c)
                    .await
                    .map_err(|e| e.to_string())?;
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
            let total: i64 = c.zcard(key).await.map_err(|e| e.to_string())?;
            let off: isize = cursor.and_then(|s| s.parse().ok()).unwrap_or(0);
            let flat: Vec<String> = redis::cmd("ZRANGE")
                .arg(key)
                .arg(off)
                .arg(off + ELEM_MAX - 1)
                .arg("WITHSCORES")
                .query_async(c)
                .await
                .map_err(|e| e.to_string())?;
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
            let total: i64 = c.llen(key).await.map_err(|e| e.to_string())?;
            let off: isize = cursor.and_then(|s| s.parse().ok()).unwrap_or(0);
            let page: Vec<String> = c
                .lrange(key, off, off + ELEM_MAX - 1)
                .await
                .map_err(|e| e.to_string())?;
            let consumed = off + page.len() as isize;
            let nc = if (consumed as i64) < total {
                json!(consumed.to_string())
            } else {
                Value::Null
            };
            Ok((json!(page), total, nc))
        }
        "set" => {
            let total: i64 = c.scard(key).await.map_err(|e| e.to_string())?;
            let mut members: Vec<String> = Vec::new();
            let mut cur = cursor.unwrap_or("0").to_string();
            loop {
                let (next, batch): (String, Vec<String>) = redis::cmd("SSCAN")
                    .arg(key)
                    .arg(&cur)
                    .arg("COUNT")
                    .arg(200)
                    .query_async(c)
                    .await
                    .map_err(|e| e.to_string())?;
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
            let total: i64 = c.xlen(key).await.map_err(|e| e.to_string())?;
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
                .await
                .map_err(|e| e.to_string())?;
            let page = resp_to_json(&raw);
            let arr = page.as_array().cloned().unwrap_or_default();
            let nc = if arr.len() == ELEM_MAX as usize {
                arr.last()
                    .and_then(|e| e.as_array())
                    .and_then(|e| e.first())
                    .cloned()
                    .unwrap_or(Value::Null)
            } else {
                Value::Null
            };
            Ok((page, total, nc))
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
    let mut c = match conn(&url).await {
        Ok(c) => c,
        Err(e) => return err(e),
    };
    let ty: String = match redis::cmd("TYPE").arg(&key).query_async(&mut c).await {
        Ok(t) => t,
        Err(e) => return err(e),
    };
    if ty == "none" {
        return Json(json!({ "ok": false, "error": "key does not exist" }));
    }
    let ttl: i64 = redis::cmd("TTL")
        .arg(&key)
        .query_async(&mut c)
        .await
        .unwrap_or(-2);
    match read_value(&mut c, &key, &ty, b.cursor.as_deref()).await {
        Ok((value, total, next_cursor)) => Json(json!({
            "ok": true,
            "view": {
                "key": key,
                "type": ty,
                "ttl": ttl,
                "value": value,
                "total": total,
                "nextCursor": next_cursor
            }
        })),
        Err(e) => err(e),
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
    let mut c = match conn(&url).await {
        Ok(c) => c,
        Err(e) => return err(e),
    };

    let res: Result<(), String> = async {
        match ty.as_str() {
            "string" => {
                let _: () = c
                    .set(&key, as_str(&b.value))
                    .await
                    .map_err(|e| e.to_string())?;
            }
            "hash" => {
                let _: () = c
                    .hset(&key, b.field.clone().unwrap_or_default(), as_str(&b.value))
                    .await
                    .map_err(|e| e.to_string())?;
            }
            "zset" => {
                let score = as_str(&b.score);
                let _: () = redis::cmd("ZADD")
                    .arg(&key)
                    .arg(score)
                    .arg(b.member.clone().unwrap_or_default())
                    .query_async(&mut c)
                    .await
                    .map_err(|e| e.to_string())?;
            }
            "list" => {
                let cmd = if b.left { "LPUSH" } else { "RPUSH" };
                let _: () = redis::cmd(cmd)
                    .arg(&key)
                    .arg(as_str(&b.value))
                    .query_async(&mut c)
                    .await
                    .map_err(|e| e.to_string())?;
            }
            "set" => {
                let _: () = c
                    .sadd(&key, b.member.clone().unwrap_or_default())
                    .await
                    .map_err(|e| e.to_string())?;
            }
            _ => return Err(format!("unsupported type {}", ty)),
        }
        Ok(())
    }
    .await;

    if let Err(e) = res {
        return err(e);
    }

    let ttl = b
        .ttl
        .as_ref()
        .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())));
    if let Some(t) = ttl {
        if t > 0 {
            let _: Result<i64, _> = c.expire(&key, t).await;
        }
    }

    Json(json!({ "ok": true }))
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
    let mut c = match conn(&url).await {
        Ok(c) => c,
        Err(e) => return err(e),
    };

    let res: Result<(), String> = async {
        match (b.member.as_deref(), b.r#type.as_deref()) {
            (Some(m), Some(ty)) => {
                match ty {
                    "hash" => {
                        let _: () = c.hdel(&key, m).await.map_err(|e| e.to_string())?;
                    }
                    "zset" => {
                        let _: () = c.zrem(&key, m).await.map_err(|e| e.to_string())?;
                    }
                    "set" => {
                        let _: () = c.srem(&key, m).await.map_err(|e| e.to_string())?;
                    }
                    "list" => {
                        let _: () = redis::cmd("LREM")
                            .arg(&key)
                            .arg(1)
                            .arg(m)
                            .query_async(&mut c)
                            .await
                            .map_err(|e| e.to_string())?;
                    }
                    _ => {
                        let _: () = c.del(&key).await.map_err(|e| e.to_string())?;
                    }
                }
            }
            _ => {
                let _: () = c.del(&key).await.map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }
    .await;

    match res {
        Ok(()) => Json(json!({ "ok": true })),
        Err(e) => err(e),
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
    let ttl = b
        .ttl
        .as_ref()
        .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
        .unwrap_or(0);
    let mut c = match conn(&url).await {
        Ok(c) => c,
        Err(e) => return err(e),
    };
    let res: Result<(), String> = if ttl < 0 {
        redis::cmd("PERSIST")
            .arg(&key)
            .query_async::<i64>(&mut c)
            .await
            .map(|_| ())
            .map_err(|e| e.to_string())
    } else {
        redis::cmd("EXPIRE")
            .arg(&key)
            .arg(ttl)
            .query_async::<i64>(&mut c)
            .await
            .map(|_| ())
            .map_err(|e| e.to_string())
    };
    match res {
        Ok(()) => Json(json!({ "ok": true })),
        Err(e) => err(e),
    }
}

#[derive(Deserialize)]
struct CmdReq {
    url: Option<String>,
    args: Option<Vec<Value>>,
}

async fn cmd(Json(b): Json<CmdReq>) -> Json<Value> {
    let url = b.url.unwrap_or_default();
    let args = b.args.unwrap_or_default();
    if args.is_empty() {
        return Json(json!({ "ok": false, "error": "empty command" }));
    }
    let strs: Vec<String> = args
        .iter()
        .map(|v| match v {
            Value::String(s) => s.clone(),
            Value::Null => String::new(),
            other => other.to_string(),
        })
        .collect();
    let mut c = match conn(&url).await {
        Ok(c) => c,
        Err(e) => return err(e),
    };
    let mut command = redis::cmd(&strs[0]);
    for a in &strs[1..] {
        command.arg(a);
    }
    match command.query_async::<RedisValue>(&mut c).await {
        Ok(v) => Json(json!({ "ok": true, "reply": resp_to_json(&v) })),
        Err(e) => err(e),
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
    let mut c = match conn(&url).await {
        Ok(c) => c,
        Err(e) => return err(e),
    };

    let pat = format!("{}*", prefix);
    let mut cur = "0".to_string();
    let mut iter = 0;
    let mut keys: Vec<String> = Vec::new();
    loop {
        let res: Result<(String, Vec<String>), _> = redis::cmd("SCAN")
            .arg(&cur)
            .arg("MATCH")
            .arg(&pat)
            .arg("COUNT")
            .arg(1000)
            .query_async(&mut c)
            .await;
        let (next, batch) = match res {
            Ok(v) => v,
            Err(e) => return err(e),
        };
        keys.extend(batch);
        cur = next;
        iter += 1;
        if cur == "0" || keys.len() >= 5000 || iter >= 60 {
            break;
        }
    }

    struct Seg {
        seg: String,
        has_children: bool,
        is_key: bool,
        count: i64,
    }
    let mut order: Vec<String> = Vec::new();
    let mut map: std::collections::HashMap<String, Seg> = std::collections::HashMap::new();
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

    let mut type_of: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for name in &order {
        let e = &map[name];
        if e.is_key {
            let full = format!("{}{}", prefix, e.seg);
            let t: String = redis::cmd("TYPE")
                .arg(&full)
                .query_async(&mut c)
                .await
                .unwrap_or_else(|_| "none".into());
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
                obj["type"] = json!(type_of.get(&format!("{}{}", prefix, e.seg)).cloned().unwrap_or_else(|| "none".into()));
            }
            obj
        })
        .collect();

    Json(json!({
        "ok": true,
        "prefix": prefix,
        "truncated": keys.len() >= 5000,
        "children": children,
    }))
}

#[derive(Deserialize)]
struct InfoReq {
    url: Option<String>,
}

async fn info(Json(b): Json<InfoReq>) -> Json<Value> {
    let url = b.url.unwrap_or_default();
    let mut c = match conn(&url).await {
        Ok(c) => c,
        Err(e) => return err(e),
    };
    let raw: String = match redis::cmd("INFO").query_async(&mut c).await {
        Ok(v) => v,
        Err(e) => return err(e),
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
    Json(json!({ "ok": true, "sections": Value::Object(sections) }))
}

#[derive(Deserialize)]
struct ExportReq {
    url: Option<String>,
    #[serde(default)]
    r#match: Option<String>,
    #[serde(default)]
    limit: Option<Value>,
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
    let mut c = match conn(&url).await {
        Ok(c) => c,
        Err(e) => return err(e),
    };

    let mut cur = "0".to_string();
    let mut iter = 0;
    let mut keys: Vec<String> = Vec::new();
    loop {
        let res: Result<(String, Vec<String>), _> = redis::cmd("SCAN")
            .arg(&cur)
            .arg("MATCH")
            .arg(&pat)
            .arg("COUNT")
            .arg(500)
            .query_async(&mut c)
            .await;
        let (next, batch) = match res {
            Ok(v) => v,
            Err(e) => return err(e),
        };
        keys.extend(batch);
        cur = next;
        iter += 1;
        if cur == "0" || keys.len() >= cap || iter >= 100 {
            break;
        }
    }

    let slice: Vec<String> = keys.iter().take(cap).cloned().collect();
    let mut data = serde_json::Map::new();
    for k in &slice {
        let ty: String = redis::cmd("TYPE")
            .arg(k)
            .query_async(&mut c)
            .await
            .unwrap_or_else(|_| "none".into());
        let (value, total, _nc) = match read_value(&mut c, k, &ty, None).await {
            Ok(v) => v,
            Err(e) => return err(e),
        };
        let ttl: i64 = redis::cmd("TTL")
            .arg(k)
            .query_async(&mut c)
            .await
            .unwrap_or(-2);
        data.insert(
            k.clone(),
            json!({ "type": ty, "ttl": ttl, "value": value, "total": total }),
        );
    }

    let truncated = keys.len() > cap || cur != "0";
    Json(json!({
        "ok": true,
        "count": slice.len(),
        "truncated": truncated,
        "data": Value::Object(data),
    }))
}

#[derive(Deserialize)]
struct CmdBatchReq {
    url: Option<String>,
    argvs: Option<Vec<Vec<Value>>>,
}

async fn cmd_batch(Json(b): Json<CmdBatchReq>) -> Json<Value> {
    let url = b.url.unwrap_or_default();
    let argvs = b.argvs.unwrap_or_default();
    if argvs.is_empty() {
        return Json(json!({ "ok": false, "error": "no commands" }));
    }
    let mut c = match conn(&url).await {
        Ok(c) => c,
        Err(e) => return err(e),
    };
    let mut results: Vec<Value> = Vec::with_capacity(argvs.len());
    for argv in &argvs {
        if argv.is_empty() {
            results.push(json!({ "argv": argv, "ok": false, "error": "empty command" }));
            continue;
        }
        let strs: Vec<String> = argv
            .iter()
            .map(|v| match v {
                Value::String(s) => s.clone(),
                Value::Null => String::new(),
                other => other.to_string(),
            })
            .collect();
        let mut command = redis::cmd(&strs[0]);
        for a in &strs[1..] {
            command.arg(a);
        }
        match command.query_async::<RedisValue>(&mut c).await {
            Ok(v) => results.push(json!({ "argv": argv, "ok": true, "reply": resp_to_json(&v) })),
            Err(e) => results.push(json!({ "argv": argv, "ok": false, "error": e.to_string() })),
        }
    }
    Json(json!({ "ok": true, "results": results }))
}

#[derive(Deserialize)]
struct PublishReq {
    url: Option<String>,
    channel: Option<String>,
    message: Option<String>,
}

async fn publish(Json(b): Json<PublishReq>) -> Json<Value> {
    let url = b.url.unwrap_or_default();
    let mut c = match conn(&url).await {
        Ok(c) => c,
        Err(e) => return err(e),
    };
    let res: Result<i64, _> = c
        .publish(
            b.channel.unwrap_or_default(),
            b.message.unwrap_or_default(),
        )
        .await;
    match res {
        Ok(receivers) => Json(json!({ "ok": true, "receivers": receivers })),
        Err(e) => err(e),
    }
}

#[derive(Deserialize)]
struct SubQuery {
    url: Option<String>,
    channels: Option<String>,
    pattern: Option<String>,
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

    tokio::spawn(async move {
        let client = match redis::Client::open(url) {
            Ok(c) => c,
            Err(e) => {
                let _ = tx
                    .send(Event::default().event("error").data(e.to_string()))
                    .await;
                return;
            }
        };
        let pubsub = match client.get_async_pubsub().await {
            Ok(p) => p,
            Err(e) => {
                let _ = tx
                    .send(Event::default().event("error").data(e.to_string()))
                    .await;
                return;
            }
        };
        let mut pubsub = pubsub;
        let sub_res = if pattern {
            pubsub.psubscribe(&channels).await
        } else {
            pubsub.subscribe(&channels).await
        };
        if let Err(e) = sub_res {
            let _ = tx
                .send(Event::default().event("error").data(e.to_string()))
                .await;
            return;
        }
        let _ = tx
            .send(Event::default().event("ready").data(ready_data))
            .await;

        let mut stream = pubsub.on_message();
        while let Some(msg) = stream.next().await {
            let channel = msg.get_channel_name().to_string();
            let payload: String = msg.get_payload().unwrap_or_default();
            let at = chrono::Utc::now().to_rfc3339();
            let data = json!({ "channel": channel, "message": payload, "at": at }).to_string();
            if tx
                .send(Event::default().event("message").data(data))
                .await
                .is_err()
            {
                break;
            }
        }
    });

    let stream = tokio_stream::wrappers::ReceiverStream::new(rx).map(Ok);
    Sse::new(stream)
}
