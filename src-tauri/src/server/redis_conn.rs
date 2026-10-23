//! A Redis connection that is either one server or a cluster, found out on connect, and a key
//! scan that covers every master of a cluster.
//!
//! A cluster routes keyed commands itself, so most callers see no difference. `SCAN` is the
//! exception: it walks one node's keyspace only, so a cluster scan visits each master in turn
//! and carries the node with the cursor (`node:cursor`).

use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

use once_cell::sync::Lazy;
use redis::{
    aio::{ConnectionLike, MultiplexedConnection},
    cluster_async::ClusterConnection,
    Cmd, Pipeline, RedisFuture, Value,
};

/// One server, or a cluster with the addresses of its masters.
pub enum Conn {
    /// One server. The note says why a cluster node is being used as one, when it is.
    Single(MultiplexedConnection, Option<String>),
    Cluster {
        conn: ClusterConnection,
        /// Connection URLs of the masters, sorted, for scanning.
        masters: Vec<String>,
    },
}

impl ConnectionLike for Conn {
    fn req_packed_command<'a>(&'a mut self, cmd: &'a Cmd) -> RedisFuture<'a, Value> {
        match self {
            Conn::Single(c, _) => c.req_packed_command(cmd),
            Conn::Cluster { conn, .. } => conn.req_packed_command(cmd),
        }
    }

    fn req_packed_commands<'a>(
        &'a mut self,
        cmd: &'a Pipeline,
        offset: usize,
        count: usize,
    ) -> RedisFuture<'a, Vec<Value>> {
        match self {
            Conn::Single(c, _) => c.req_packed_commands(cmd, offset, count),
            Conn::Cluster { conn, .. } => conn.req_packed_commands(cmd, offset, count),
        }
    }

    fn get_db(&self) -> i64 {
        match self {
            Conn::Single(c, _) => c.get_db(),
            Conn::Cluster { conn, .. } => conn.get_db(),
        }
    }
}

impl Conn {
    /// Masters scanned for keys: none for a single server, which scans itself.
    pub fn masters(&self) -> &[String] {
        match self {
            Conn::Single(..) => &[],
            Conn::Cluster { masters, .. } => masters,
        }
    }

    /// A warning for the user about how this connection is being used, if any.
    pub fn note(&self) -> Option<&str> {
        match self {
            Conn::Single(_, note) => note.as_deref(),
            Conn::Cluster { .. } => None,
        }
    }
}

/// `raw` with a `redis://` scheme when it has none.
pub fn normalize(raw: &str) -> String {
    let t = raw.trim();
    let lower = t.to_ascii_lowercase();
    if lower.starts_with("redis://") || lower.starts_with("rediss://") {
        t.to_string()
    } else {
        format!("redis://{t}")
    }
}

async fn single(url: &str) -> Result<MultiplexedConnection, String> {
    redis::Client::open(url)
        .map_err(|e| e.to_string())?
        .get_multiplexed_async_connection()
        .await
        .map_err(|e| e.to_string())
}

/// How long a server's mode (one server, or a cluster and its masters) is remembered, so
/// each request does not ask again.
const MODE_TTL: Duration = Duration::from_secs(60);

/// Per URL: `None` for one server, else the cluster's masters.
type Mode = Option<Vec<String>>;
static MODES: Lazy<Mutex<HashMap<String, (Instant, Mode)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Connect to `raw`. A server with cluster mode on gets a cluster connection seeded from it.
/// When the cluster's nodes cannot be reached from here (port-forward, NAT, a container), the
/// one server given is used on its own, with a note saying so.
pub async fn connect(raw: &str) -> Result<Conn, String> {
    if raw.trim().is_empty() {
        return Err("missing connection url".into());
    }
    let url = normalize(raw);
    let mut first = single(&url).await?;
    let cached = MODES.lock().ok().and_then(|m| {
        m.get(&url)
            .filter(|(at, _)| at.elapsed() < MODE_TTL)
            .map(|(_, mode)| mode.clone())
    });
    let mode = match cached {
        Some(mode) => mode,
        None => {
            let mode = detect(&url, &mut first).await?;
            if let Ok(mut m) = MODES.lock() {
                m.insert(url.clone(), (Instant::now(), mode.clone()));
            }
            mode
        }
    };
    let Some(masters) = mode else {
        return Ok(Conn::Single(first, None));
    };
    let client =
        redis::cluster::ClusterClient::new(vec![url.as_str()]).map_err(|e| e.to_string())?;
    // the cluster client connects to nodes lazily: one PING proves they can be reached
    let reached = async {
        let mut conn = client.get_async_connection().await?;
        redis::cmd("PING").query_async::<String>(&mut conn).await?;
        Ok::<_, redis::RedisError>(conn)
    };
    match tokio::time::timeout(Duration::from_secs(5), reached).await {
        Ok(Ok(conn)) => Ok(Conn::Cluster { conn, masters }),
        outcome => {
            let why = match outcome {
                Ok(Err(e)) => e.to_string(),
                _ => "no answer within 5 s".to_string(),
            };
            Ok(Conn::Single(
                first,
                Some(format!(
                    "the cluster's nodes are not reachable from here ({why}); using this node alone, so only its keys are visible"
                )),
            ))
        }
    }
}

/// `Some(masters)` when the server at `url` runs in cluster mode, `None` when it is one server.
async fn detect(url: &str, first: &mut MultiplexedConnection) -> Result<Mode, String> {
    // `INFO cluster` answers on every server; only a cluster node says it is enabled.
    let info: String = redis::cmd("INFO")
        .arg("cluster")
        .query_async(first)
        .await
        .unwrap_or_default();
    if !info.lines().any(|l| l.trim() == "cluster_enabled:1") {
        return Ok(None);
    }
    let slots: Value = redis::cmd("CLUSTER")
        .arg("SLOTS")
        .query_async(first)
        .await
        .map_err(|e| format!("CLUSTER SLOTS: {e}"))?;
    master_urls(url, &slots).map(Some)
}

/// The masters in a `CLUSTER SLOTS` reply, as URLs keeping `seed`'s scheme and credentials.
/// An empty host means "the node you asked", as the protocol allows.
fn master_urls(seed: &str, slots: &Value) -> Result<Vec<String>, String> {
    let seed_url = url::Url::parse(seed).map_err(|e| e.to_string())?;
    let text = |v: &Value| match v {
        Value::BulkString(b) => Some(String::from_utf8_lossy(b).to_string()),
        Value::SimpleString(s) => Some(s.clone()),
        _ => None,
    };
    let mut out = Vec::new();
    let Value::Array(ranges) = slots else {
        return Err("CLUSTER SLOTS: unexpected reply".into());
    };
    for range in ranges {
        let Value::Array(parts) = range else { continue };
        // [start, end, [host, port, id, …] master, replicas…]
        let Some(Value::Array(master)) = parts.get(2) else {
            continue;
        };
        let host = master.first().and_then(text).unwrap_or_default();
        let Some(Value::Int(port)) = master.get(1) else {
            continue;
        };
        let mut u = seed_url.clone();
        // empty or `?`: the node you asked; an IPv6 address needs brackets in a URL
        if !host.is_empty() && host != "?" {
            let host = if host.contains(':') && !host.starts_with('[') {
                format!("[{host}]")
            } else {
                host
            };
            u.set_host(Some(&host))
                .map_err(|e| format!("node host {host}: {e}"))?;
        }
        u.set_port(u16::try_from(*port).ok())
            .map_err(|()| format!("node port {port}"))?;
        let s = u.to_string();
        if !out.contains(&s) {
            out.push(s);
        }
    }
    if out.is_empty() {
        return Err("CLUSTER SLOTS listed no masters".into());
    }
    out.sort();
    Ok(out)
}

/// One page of a key scan.
pub struct ScanPage {
    pub keys: Vec<String>,
    /// `"0"` when the whole keyspace has been walked.
    pub cursor: String,
}

/// How far one scan call goes.
pub struct ScanLimits {
    /// `COUNT` per `SCAN` call.
    pub count: usize,
    /// Stop once at least this many keys were found.
    pub want: usize,
    /// Stop after this many `SCAN` calls, found or not.
    pub max_calls: usize,
}

/// Keys matching `pattern`, continuing from `cursor` (`"0"` to start). On a cluster the cursor
/// is `node:cursor` and the scan moves through the masters in order.
pub async fn scan(
    conn: &mut Conn,
    pattern: &str,
    cursor: &str,
    limits: &ScanLimits,
) -> Result<ScanPage, String> {
    let masters = conn.masters().to_vec();
    if masters.is_empty() {
        let mut keys = Vec::new();
        let next = scan_node(conn, pattern, cursor, limits, &mut keys, limits.max_calls).await?;
        return Ok(ScanPage {
            keys,
            cursor: next.0,
        });
    }
    let (mut node, mut cur) = parse_cursor(cursor, masters.len())?;
    let mut keys = Vec::new();
    let mut calls_left = limits.max_calls;
    while node < masters.len() && keys.len() < limits.want && calls_left > 0 {
        let mut c = single(&masters[node])
            .await
            .map_err(|e| format!("{}: {e}", masters[node]))?;
        let (next, used) = scan_node(&mut c, pattern, &cur, limits, &mut keys, calls_left).await?;
        calls_left -= used;
        if next == "0" {
            node += 1;
            cur = "0".into();
        } else {
            cur = next;
        }
    }
    let cursor = if node >= masters.len() {
        "0".to_string()
    } else {
        format!("{node}:{cur}")
    };
    Ok(ScanPage { keys, cursor })
}

/// `SCAN` one node from `cursor` until it wraps, `want` keys are in `keys`, or `calls` calls
/// were made. Returns the next cursor and the calls used.
async fn scan_node<C: ConnectionLike>(
    c: &mut C,
    pattern: &str,
    cursor: &str,
    limits: &ScanLimits,
    keys: &mut Vec<String>,
    calls: usize,
) -> Result<(String, usize), String> {
    let mut cur = cursor.to_string();
    let mut used = 0;
    loop {
        let (next, batch): (String, Vec<String>) = redis::cmd("SCAN")
            .arg(&cur)
            .arg("MATCH")
            .arg(pattern)
            .arg("COUNT")
            .arg(limits.count)
            .query_async(c)
            .await
            .map_err(|e| e.to_string())?;
        keys.extend(batch);
        cur = next;
        used += 1;
        if cur == "0" || keys.len() >= limits.want || used >= calls {
            return Ok((cur, used));
        }
    }
}

/// `node:cursor` for a cluster scan; a plain `0` starts at the first node.
fn parse_cursor(cursor: &str, nodes: usize) -> Result<(usize, String), String> {
    if cursor.is_empty() || cursor == "0" {
        return Ok((0, "0".into()));
    }
    let (node, cur) = cursor
        .split_once(':')
        .ok_or_else(|| format!("cursor `{cursor}` is not node:cursor"))?;
    let node: usize = node
        .parse()
        .map_err(|_| format!("cursor `{cursor}` names no node"))?;
    if node >= nodes {
        return Err(format!("cursor `{cursor}` names node {node} of {nodes}"));
    }
    Ok((node, cur.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(host: &str, port: i64) -> Value {
        Value::Array(vec![
            Value::BulkString(host.as_bytes().to_vec()),
            Value::Int(port),
        ])
    }

    fn range(start: i64, end: i64, master: Value) -> Value {
        Value::Array(vec![
            Value::Int(start),
            Value::Int(end),
            master,
            node("replica", 7000),
        ])
    }

    #[test]
    fn masters_keep_the_seed_credentials_and_drop_duplicates() {
        let slots = Value::Array(vec![
            range(0, 5460, node("10.0.0.2", 6380)),
            range(5461, 10922, node("10.0.0.1", 6379)),
            range(10923, 16383, node("10.0.0.2", 6380)),
        ]);
        let got = master_urls("redis://user:pw@seed:6379", &slots).unwrap();
        assert_eq!(
            got,
            [
                "redis://user:pw@10.0.0.1:6379",
                "redis://user:pw@10.0.0.2:6380"
            ]
        );
    }

    #[test]
    fn an_empty_host_means_the_seed_itself() {
        let slots = Value::Array(vec![range(0, 16383, node("", 7001))]);
        assert_eq!(
            master_urls("redis://seed:7000", &slots).unwrap(),
            ["redis://seed:7001"]
        );
    }

    #[test]
    fn unknown_and_ipv6_hosts_are_handled() {
        let slots = Value::Array(vec![
            range(0, 8000, node("?", 7001)),
            range(8001, 16383, node("::1", 7002)),
        ]);
        assert_eq!(
            master_urls("redis://seed:7000", &slots).unwrap(),
            ["redis://[::1]:7002", "redis://seed:7001"]
        );
    }

    #[test]
    fn cluster_cursors_carry_the_node() {
        assert_eq!(parse_cursor("0", 3).unwrap(), (0, "0".to_string()));
        assert_eq!(parse_cursor("2:1536", 3).unwrap(), (2, "1536".to_string()));
        assert!(parse_cursor("5:0", 3).is_err());
        assert!(parse_cursor("1536", 3).is_err());
    }

    #[test]
    fn scheme_is_added_once() {
        assert_eq!(normalize("h:6379"), "redis://h:6379");
        assert_eq!(normalize(" rediss://h "), "rediss://h");
    }
}
