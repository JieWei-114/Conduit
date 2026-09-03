// NEW Cargo deps: tokio-postgres = { version = "0.7", features = ["with-serde_json-1", "with-uuid-1", "with-chrono-0_4"] }, mysql_async = "0.34", mongodb = "3", futures-util = "0.3", url = "2", chrono = "0.4", uuid = "1"

use std::time::Instant;

use axum::{routing::post, Json, Router};
use futures_util::stream::TryStreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use url::Url;

const ROWS_MAX: usize = 500;

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

async fn schema(Json(req): Json<SchemaReq>) -> Json<Value> {
    let driver = req.driver.unwrap_or_default();
    let url = req.url.unwrap_or_default();
    if url.trim().is_empty() {
        return Json(json!({ "ok": false, "error": "missing connection url" }));
    }
    let url = url.trim().to_string();
    let res: Result<Vec<String>, String> = match driver.as_str() {
        "clickhouse" => ch_query(&url, "SHOW TABLES").await.map(|r| {
            r.data
                .iter()
                .filter_map(|x| x.get("name").and_then(|v| v.as_str()).map(String::from))
                .collect()
        }),
        "postgres" => pg_schema(&url).await,
        "mysql" => my_schema(&url).await,
        "mongodb" => mongo_schema(&url).await,
        other => Err(format!("unknown driver {other}")),
    };
    match res {
        Ok(tables) => Json(json!({ "ok": true, "tables": tables })),
        Err(e) => Json(json!({ "ok": false, "error": e })),
    }
}

async fn query(Json(req): Json<QueryReq>) -> Json<Value> {
    let driver = req.driver.unwrap_or_default();
    let url = req.url.unwrap_or_default();
    let query = req.query.unwrap_or_default();
    if url.trim().is_empty() {
        return Json(json!({ "ok": false, "error": "missing connection url" }));
    }
    if query.trim().is_empty() {
        return Json(json!({ "ok": false, "error": "empty query" }));
    }
    let url = url.trim().to_string();

    let t0 = Instant::now();
    let res: Result<Value, String> = match driver.as_str() {
        "clickhouse" => ch_run(&url, &query).await,
        "postgres" => pg_run(&url, &query).await,
        "mysql" => my_run(&url, &query).await,
        "mongodb" => mongo_run(&url, &query).await,
        other => Err(format!("unknown driver {other}")),
    };
    let dur = t0.elapsed().as_millis() as u64;
    match res {
        Ok(mut v) => {
            if let Value::Object(ref mut m) = v {
                m.insert("ok".into(), json!(true));
                m.insert("durationMs".into(), json!(dur));
            }
            Json(v)
        }
        Err(e) => Json(json!({ "ok": false, "error": e, "durationMs": dur })),
    }
}

// ---------- ClickHouse ----------

struct ChResult {
    data: Vec<Value>,
    rows: Option<u64>,
}

async fn ch_query(raw_url: &str, sql: &str) -> Result<ChResult, String> {
    let mut u = Url::parse(raw_url).map_err(|e| e.to_string())?;
    let db = {
        let p = u.path().trim_start_matches('/');
        if p.is_empty() { "default".to_string() } else { p.to_string() }
    };
    let user = {
        let s = urldec(u.username());
        if s.is_empty() { "default".to_string() } else { s }
    };
    let pass = u.password().map(urldec).unwrap_or_default();
    let _ = u.set_username("");
    let _ = u.set_password(None);
    let origin = u.origin().ascii_serialization();
    let endpoint = format!(
        "{origin}/?database={}&default_format=JSON",
        urlenc(&db)
    );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .post(&endpoint)
        .header("X-ClickHouse-User", user)
        .header("X-ClickHouse-Key", pass)
        .body(sql.to_string())
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let t = text.trim();
        return Err(if t.is_empty() {
            format!("HTTP {}", status.as_u16())
        } else {
            t.to_string()
        });
    }
    match serde_json::from_str::<Value>(&text) {
        Ok(v) => {
            let data = v
                .get("data")
                .and_then(|d| d.as_array())
                .cloned()
                .unwrap_or_default();
            let rows = v.get("rows").and_then(|r| r.as_u64());
            Ok(ChResult { data, rows })
        }
        Err(_) => Ok(ChResult { data: vec![], rows: None }),
    }
}

async fn ch_run(url: &str, query: &str) -> Result<Value, String> {
    let r = ch_query(url, query).await?;
    let total = r.data.len();
    let rows: Vec<Value> = r.data.into_iter().take(ROWS_MAX).collect();
    let row_count = r.rows.unwrap_or(total as u64);
    Ok(json!({
        "rows": rows,
        "rowCount": row_count,
        "truncated": total > ROWS_MAX,
    }))
}

// ---------- Postgres ----------

async fn pg_connect(url: &str) -> Result<tokio_postgres::Client, String> {
    let (client, connection) = tokio_postgres::connect(url, tokio_postgres::NoTls)
        .await
        .map_err(|e| e.to_string())?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    Ok(client)
}

async fn pg_schema(url: &str) -> Result<Vec<String>, String> {
    let client = pg_connect(url).await?;
    let rows = client
        .query(
            "select table_schema, table_name from information_schema.tables \
             where table_schema not in ('pg_catalog','information_schema') order by 1,2",
            &[],
        )
        .await
        .map_err(|e| e.to_string())?;
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

async fn pg_run(url: &str, query: &str) -> Result<Value, String> {
    let client = pg_connect(url).await?;
    let rows = client.query(query, &[]).await.map_err(|e| e.to_string())?;
    let total = rows.len();
    let out: Vec<Value> = rows
        .iter()
        .take(ROWS_MAX)
        .map(pg_row_to_json)
        .collect();
    Ok(json!({
        "rows": out,
        "rowCount": total,
        "truncated": total > ROWS_MAX,
    }))
}

fn pg_row_to_json(row: &tokio_postgres::Row) -> Value {
    use tokio_postgres::types::Type;
    let mut obj = serde_json::Map::new();
    for (i, col) in row.columns().iter().enumerate() {
        let name = col.name().to_string();
        let ty = col.type_();
        let val: Value = match *ty {
            Type::BOOL => row.try_get::<_, Option<bool>>(i).ok().flatten().map(Value::from).unwrap_or(Value::Null),
            Type::INT2 => row.try_get::<_, Option<i16>>(i).ok().flatten().map(Value::from).unwrap_or(Value::Null),
            Type::INT4 => row.try_get::<_, Option<i32>>(i).ok().flatten().map(Value::from).unwrap_or(Value::Null),
            Type::INT8 => row.try_get::<_, Option<i64>>(i).ok().flatten().map(Value::from).unwrap_or(Value::Null),
            Type::FLOAT4 => row.try_get::<_, Option<f32>>(i).ok().flatten().map(|v| Value::from(v as f64)).unwrap_or(Value::Null),
            Type::FLOAT8 => row.try_get::<_, Option<f64>>(i).ok().flatten().map(Value::from).unwrap_or(Value::Null),
            Type::JSON | Type::JSONB => row.try_get::<_, Option<Value>>(i).ok().flatten().unwrap_or(Value::Null),
            Type::UUID => row
                .try_get::<_, Option<uuid::Uuid>>(i)
                .ok()
                .flatten()
                .map(|u| Value::from(u.to_string()))
                .unwrap_or(Value::Null),
            Type::TIMESTAMP => row
                .try_get::<_, Option<chrono::NaiveDateTime>>(i)
                .ok()
                .flatten()
                .map(|d| Value::from(d.to_string()))
                .unwrap_or(Value::Null),
            Type::TIMESTAMPTZ => row
                .try_get::<_, Option<chrono::DateTime<chrono::Utc>>>(i)
                .ok()
                .flatten()
                .map(|d| Value::from(d.to_rfc3339()))
                .unwrap_or(Value::Null),
            Type::TEXT | Type::VARCHAR | Type::BPCHAR | Type::NAME => row
                .try_get::<_, Option<String>>(i)
                .ok()
                .flatten()
                .map(Value::from)
                .unwrap_or(Value::Null),
            _ => row
                .try_get::<_, Option<String>>(i)
                .ok()
                .flatten()
                .map(Value::from)
                .unwrap_or(Value::Null),
        };
        obj.insert(name, val);
    }
    Value::Object(obj)
}

// ---------- MySQL ----------

async fn my_conn(url: &str) -> Result<mysql_async::Conn, String> {
    let opts = mysql_async::Opts::from_url(url).map_err(|e| e.to_string())?;
    mysql_async::Conn::new(opts).await.map_err(|e| e.to_string())
}

async fn my_schema(url: &str) -> Result<Vec<String>, String> {
    use mysql_async::prelude::Queryable;
    let mut conn = my_conn(url).await?;
    let rows: Vec<mysql_async::Row> = conn.query("show tables").await.map_err(|e| e.to_string())?;
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

async fn my_run(url: &str, query: &str) -> Result<Value, String> {
    use mysql_async::prelude::Queryable;
    let mut conn = my_conn(url).await?;
    let rows: Vec<mysql_async::Row> = conn.query(query).await.map_err(|e| e.to_string())?;
    let total = rows.len();
    let out: Vec<Value> = rows.iter().take(ROWS_MAX).map(my_row_to_json).collect();
    Ok(json!({
        "rows": out,
        "rowCount": total,
        "truncated": total > ROWS_MAX,
    }))
}

fn my_row_to_json(row: &mysql_async::Row) -> Value {
    let cols = row.columns_ref();
    let mut obj = serde_json::Map::new();
    for (i, col) in cols.iter().enumerate() {
        let name = col.name_str().to_string();
        let val = row
            .as_ref(i)
            .map(|v| my_bson_value(v, col.column_type()))
            .unwrap_or(Value::Null);
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

async fn mongo_db(url: &str) -> Result<mongodb::Database, String> {
    let mut opts = mongodb::options::ClientOptions::parse(url)
        .await
        .map_err(|e| e.to_string())?;
    let db_name = opts.default_database.clone();
    opts.server_selection_timeout = Some(std::time::Duration::from_secs(8));
    let client = mongodb::Client::with_options(opts).map_err(|e| e.to_string())?;
    let name = db_name.unwrap_or_else(|| "test".to_string());
    Ok(client.database(&name))
}

async fn mongo_schema(url: &str) -> Result<Vec<String>, String> {
    let db = mongo_db(url).await?;
    let mut names = db
        .list_collection_names()
        .await
        .map_err(|e| e.to_string())?;
    names.sort();
    Ok(names)
}

fn bson_to_json(doc: mongodb::bson::Document) -> Value {
    mongodb::bson::Bson::Document(doc).into_relaxed_extjson()
}

async fn mongo_run(url: &str, query: &str) -> Result<Value, String> {
    use mongodb::bson::Document;

    let q: Value = serde_json::from_str(query)
        .map_err(|_| "mongodb query must be JSON — see the placeholder for the shape".to_string())?;
    let db = mongo_db(url).await?;

    let mut docs: Vec<Value> = Vec::new();

    if let Some(cmd) = q.get("command") {
        let cmd_doc: Document =
            mongodb::bson::to_document(cmd).map_err(|e| e.to_string())?;
        let res = db.run_command(cmd_doc).await.map_err(|e| e.to_string())?;
        docs.push(bson_to_json(res));
    } else if let Some(pipeline) = q.get("pipeline").and_then(|p| p.as_array()) {
        let coll_name = q
            .get("collection")
            .and_then(|c| c.as_str())
            .unwrap_or("");
        let limit = q
            .get("limit")
            .and_then(|l| l.as_u64())
            .filter(|&n| n > 0)
            .unwrap_or(ROWS_MAX as u64)
            .min(ROWS_MAX as u64);
        let mut stages: Vec<Document> = Vec::new();
        for stage in pipeline {
            stages.push(mongodb::bson::to_document(stage).map_err(|e| e.to_string())?);
        }
        stages.push(mongodb::bson::doc! { "$limit": limit as i64 });
        let coll = db.collection::<Document>(coll_name);
        let mut cursor = coll.aggregate(stages).await.map_err(|e| e.to_string())?;
        while let Some(d) = cursor.try_next().await.map_err(|e| e.to_string())? {
            docs.push(bson_to_json(d));
        }
    } else {
        let coll_name = q
            .get("collection")
            .and_then(|c| c.as_str())
            .unwrap_or("");
        let limit = q
            .get("limit")
            .and_then(|l| l.as_u64())
            .filter(|&n| n > 0)
            .unwrap_or(50)
            .min(ROWS_MAX as u64);
        let filter: Document = match q.get("filter") {
            Some(f) => mongodb::bson::to_document(f).map_err(|e| e.to_string())?,
            None => Document::new(),
        };
        let coll = db.collection::<Document>(coll_name);
        let mut find = coll.find(filter).limit(limit as i64);
        if let Some(sort) = q.get("sort") {
            let sort_doc = mongodb::bson::to_document(sort).map_err(|e| e.to_string())?;
            find = find.sort(sort_doc);
        }
        let mut cursor = find.await.map_err(|e| e.to_string())?;
        while let Some(d) = cursor.try_next().await.map_err(|e| e.to_string())? {
            docs.push(bson_to_json(d));
        }
    }

    let count = docs.len();
    Ok(json!({
        "rows": docs,
        "rowCount": count,
        "truncated": false,
    }))
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
