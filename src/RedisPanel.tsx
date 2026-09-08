import { useEffect, useRef, useState } from 'react';
import type { RedisKeyView, RedisType } from './types';

const LS_CONNS = 'conduit.redis.conns.v3';
const LS_LAST = 'conduit.redis.last.v2';

interface Conn {
  name: string;
  host: string;
  port: string;
  password: string;
  db: string;
}

/** Parse a redis://[:pass@]host:port[/db] string into parts (for migration). */
function parseUrl(url: string): Omit<Conn, 'name'> {
  try {
    const u = new URL(url.includes('://') ? url : `redis://${url}`);
    return {
      host: u.hostname,
      port: u.port || '6379',
      password: decodeURIComponent(u.password || ''),
      db: u.pathname.replace(/^\//, ''),
    };
  } catch {
    return { host: url, port: '6379', password: '', db: '' };
  }
}

function buildUrl(c: { host: string; port: string; password: string; db: string }): string {
  let host = c.host.trim();
  let port = (c.port || '6379').trim();
  let password = c.password;
  let db = c.db;

  // tolerate a full url or a host:port pasted into the Host field
  if (/:\/\//.test(host)) {
    const p = parseUrl(host);
    host = p.host;
    port = p.port;
    if (p.password) password = p.password;
    if (p.db) db = p.db;
  } else {
    const m = host.match(/^(.+):(\d+)$/); // host:port → split so we don't double the port
    if (m) {
      host = m[1];
      port = m[2];
    }
  }

  const auth = password ? `:${encodeURIComponent(password)}@` : '';
  const d = db && db !== '0' ? `/${db}` : '';
  return `redis://${auth}${host}:${port}${d}`;
}

function loadConns(): Conn[] {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_CONNS) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw.map((c) => {
      if (typeof c === 'string') return { name: c, ...parseUrl(c) };
      if (c.url) return { name: c.name, ...parseUrl(c.url) }; // migrate v2 {name,url}
      return c as Conn;
    });
  } catch {
    return [];
  }
}

/** Pretty-print if the string is a JSON object/array; else return null. */
function tryJson(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return null;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return null;
  }
}

// never rejects — a network drop / non-JSON 500 comes back as { ok:false, error }
// so every caller's `if (!r.ok)` path handles it uniformly.
const post = (path: string, body: unknown) =>
  fetch(`/api/redis/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
    .then((r) => r.json())
    .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));

// theme tokens (defined per light/dark in style.css) so type colors track the theme
const TYPE_COLORS: Record<string, string> = {
  string: 'var(--accent-strong)',
  hash: 'var(--ok)',
  zset: 'var(--purple)',
  list: 'var(--orange)',
  set: 'var(--cyan)',
  stream: 'var(--pink)',
};

/** Split a raw command line into args, respecting single/double quotes. */
function tokenize(line: string): string[] {
  const out: string[] = [];
  const re = /'([^']*)'|"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// command templates for the "insert" chips — <…> are placeholders to fill,
// {k} is replaced with the target key. `desc` = what the command does (hover).
interface Tpl { tpl: string; desc: string }
const TEMPLATES: Record<string, Tpl[]> = {
  zset: [
    { tpl: "ZADD {k} <score> '<json>'", desc: 'add a member with a score (creates the sorted set if new)' },
    { tpl: 'ZRANGE {k} 0 -1 WITHSCORES', desc: 'list members by rank low→high, with scores' },
    { tpl: 'ZREVRANGE {k} 0 -1 WITHSCORES', desc: 'list members by rank high→low, with scores' },
    { tpl: 'ZSCORE {k} <member>', desc: "get one member's score" },
    { tpl: 'ZCARD {k}', desc: 'count members' },
    { tpl: 'ZREM {k} <member>', desc: 'remove a member' },
  ],
  set: [
    { tpl: 'SISMEMBER {k} <member>', desc: 'is this member in the set? → 1 yes / 0 no' },
    { tpl: 'SMEMBERS {k}', desc: 'list all members' },
    { tpl: 'SCARD {k}', desc: 'count members' },
    { tpl: 'SADD {k} <member>', desc: 'add a member' },
    { tpl: 'SREM {k} <member>', desc: 'remove a member' },
  ],
  hash: [
    { tpl: 'HGETALL {k}', desc: 'get all field → value pairs' },
    { tpl: 'HGET {k} <field>', desc: "get one field's value" },
    { tpl: 'HSET {k} <field> <value>', desc: 'set a field to a value' },
    { tpl: 'HDEL {k} <field>', desc: 'delete a field' },
  ],
  list: [
    { tpl: 'LRANGE {k} 0 -1', desc: 'list elements by index range' },
    { tpl: 'RPUSH {k} <value>', desc: 'append to the tail (right)' },
    { tpl: 'LPUSH {k} <value>', desc: 'prepend to the head (left)' },
    { tpl: 'LLEN {k}', desc: 'count elements' },
  ],
  string: [
    { tpl: "SET {k} '<value>'", desc: 'set the string value' },
    { tpl: 'GET {k}', desc: 'get the string value' },
    { tpl: 'INCRBY {k} 1', desc: 'increment a numeric value' },
  ],
  generic: [
    { tpl: 'TYPE {k}', desc: "show the key's data type" },
    { tpl: 'TTL {k}', desc: 'seconds until expiry (-1 no expiry, -2 gone)' },
    { tpl: 'EXPIRE {k} <seconds>', desc: 'set expiry in seconds' },
    { tpl: 'PERSIST {k}', desc: 'remove expiry (keep forever)' },
    { tpl: 'DEL {k}', desc: 'delete the whole key' },
  ],
};

export default function RedisPanel() {
  const last = (() => {
    try {
      return JSON.parse(localStorage.getItem(LS_LAST) ?? '{}');
    } catch {
      return {};
    }
  })();
  const [host, setHost] = useState<string>(last.host ?? '127.0.0.1');
  const [port, setPort] = useState<string>(last.port ?? '6379');
  const [password, setPassword] = useState<string>(last.password ?? '');
  const [db, setDb] = useState<string>(last.db ?? '');
  const url = buildUrl({ host, port, password, db });
  const [conns, setConns] = useState(loadConns);
  const [pickedConn, setPickedConn] = useState('');
  const [view, setView] = useState<RedisKeyView | null>(null);
  const [status, setStatus] = useState('');
  const [fmtJsonOn, setFmtJsonOn] = useState(true);
  const [rtab, setRtab] = useState<'value' | 'commands' | 'pubsub' | 'info'>('value');

  // prefix drill-down browser
  interface Child { seg: string; full: string; type?: RedisType; isKey: boolean; hasChildren: boolean; count: number }
  const [path, setPath] = useState(''); // the single key/prefix box
  const [children, setChildren] = useState<Child[]>([]);
  const [levelFilter, setLevelFilter] = useState('');
  const [commandsKey, setCommandsKey] = useState(''); // target key for Commands tab

  // pub/sub
  const [channel, setChannel] = useState('');
  const [pubMsg, setPubMsg] = useState('');
  const [subChannels, setSubChannels] = useState('');
  const [feed, setFeed] = useState<{ id: number; channel: string; message: string; at: string }[]>([]);
  const feedIdRef = useRef(0);
  const esRef = useRef<EventSource | null>(null);
  const [subscribed, setSubscribed] = useState(false);

  useEffect(() => {
    localStorage.setItem(LS_LAST, JSON.stringify({ host, port, password, db }));
  }, [host, port, password, db]);

  const loadChildren = async (prefix: string) => {
    const r = await post('children', { url, prefix });
    if (!r.ok) return setStatus(`✗ ${r.error}`);
    setPath(prefix);
    setChildren(r.children);
    setLevelFilter('');
    setStatus(`${r.children.length} at "${prefix || 'root'}"${r.truncated ? ' (truncated)' : ''}`);
  };
  const drill = (full: string) => {
    setCommandsKey(full);
    loadChildren(full + ':');
  };
  const crumbTo = (prefix: string) => loadChildren(prefix);

  // one box: Enter → open if it's an exact key, else browse it as a prefix
  const go = async () => {
    const v = path.trim();
    if (!v) return loadChildren('');
    const r = await post('get', { url, key: v });
    if (r.ok) {
      setView(r.view);
      setCommandsKey(v);
    } else {
      loadChildren(v);
    }
  };

  const persistConns = (next: Conn[]) => {
    setConns(next);
    localStorage.setItem(LS_CONNS, JSON.stringify(next));
  };
  const applyConn = (name: string) => {
    setPickedConn(name);
    const c = conns.find((x) => x.name === name);
    if (c) {
      setHost(c.host);
      setPort(c.port);
      setPassword(c.password);
      setDb(c.db);
    }
  };
  const saveConn = () => {
    if (!host.trim()) return;
    const name = prompt('Name this connection (e.g. local, staging, prod):', '');
    if (!name) return;
    persistConns([...conns.filter((c) => c.name !== name), { name, host, port, password, db }]);
    setPickedConn(name);
  };
  const deleteConn = () => {
    persistConns(conns.filter((c) => c.name !== pickedConn));
    setPickedConn('');
  };

  const ping = async () => {
    const r = await post('ping', { url });
    setStatus(r.ok ? `PONG ✓` : `✗ ${r.error}`);
  };

  const openKey = async (key: string) => {
    const r = await post('get', { url, key });
    if (!r.ok) return setStatus(`✗ ${r.error}`);
    setView(r.view);
    setCommandsKey(key);
  };
  const refreshKey = () => view && openKey(view.key);

  // fetch the next ~500 elements and APPEND to the current view
  const loadMoreValue = async () => {
    if (!view?.nextCursor) return;
    const r = await post('get', { url, key: view.key, cursor: view.nextCursor });
    if (!r.ok) return setStatus(`✗ ${r.error}`);
    setView((v) =>
      v
        ? {
            ...r.view,
            value: Array.isArray(v.value)
              ? [...(v.value as unknown[]), ...(r.view.value as unknown[])]
              : r.view.value,
          }
        : r.view,
    );
  };

  const delKey = async (member?: string) => {
    if (!view) return;
    if (!member && !confirm(`DEL ${view.key} ?`)) return;
    const r = await post('del', { url, key: view.key, type: view.type, member });
    if (!r.ok) return setStatus(`✗ ${r.error}`);
    if (member) refreshKey();
    else {
      setView(null);
      loadChildren(path);
    }
  };

  const publish = async () => {
    const r = await post('publish', { url, channel, message: pubMsg });
    setStatus(r.ok ? `PUBLISH → ${r.receivers} receiver(s)` : `✗ ${r.error}`);
  };

  const toggleSubscribe = () => {
    if (subscribed) {
      esRef.current?.close();
      esRef.current = null;
      setSubscribed(false);
      return;
    }
    const chans = subChannels.trim();
    if (!chans) return;
    const pattern = /[*?[]/.test(chans) ? '1' : '0';
    const es = new EventSource(
      `/api/redis/subscribe?url=${encodeURIComponent(url)}&channels=${encodeURIComponent(chans)}&pattern=${pattern}`,
    );
    es.addEventListener('message', (e) => {
      let d: any;
      try { d = JSON.parse((e as MessageEvent).data); } catch { return; } // drop malformed frame, keep stream
      setFeed((f) => [{ ...d, id: feedIdRef.current++ }, ...f].slice(0, 200));
    });
    // Native failures carry no data → EventSource would retry forever; stop & flag
    // so the UI doesn't show a broken subscription as still "listening".
    es.addEventListener('error', (e) => {
      setStatus(`sub error: ${(e as MessageEvent).data || 'connection lost'}`);
      es.close();
      esRef.current = null;
      setSubscribed(false);
    });
    esRef.current = es;
    setSubscribed(true);
  };

  useEffect(() => () => esRef.current?.close(), []);

  return (
    <div className="layout">
      {/* ── left: connection + scan + key list (shared by Value & Commands) ── */}
      <div className="left">
        <h3>
          Redis <span className="badge">redis-rs</span>
        </h3>

        <label>Saved connections</label>
        <div className="row field-row">
          <select className="grow" value={pickedConn} onChange={(e) => applyConn(e.target.value)}>
            <option value=""> - </option>
            {conns.map((c) => (
              <option key={c.name} value={c.name}>{c.name}</option>
            ))}
          </select>
          <button className="btn-field" onClick={saveConn} title="Save the fields below under a name">save</button>
          <button
            className="btn-field btn-danger"
            disabled={!pickedConn}
            onClick={deleteConn}
            title="Delete the selected saved connection"
          >
            delete
          </button>
        </div>

        <div className="conn-row">
          <div className="grow">
            <label>Host</label>
            <input value={host} spellCheck={false} placeholder="host  or  redis://host:port"
              onChange={(e) => setHost(e.target.value)} />
          </div>
          <div className="conn-sm">
            <label>Port</label>
            <input value={port} onChange={(e) => setPort(e.target.value)} />
          </div>
        </div>
        <div className="conn-row">
          <div className="grow">
            <label>Password</label>
            <input type="password" value={password} spellCheck={false} placeholder="blank if none"
              onChange={(e) => setPassword(e.target.value)} />
          </div>
          <div className="conn-sm">
            <label>DB</label>
            <input value={db} placeholder="0" onChange={(e) => setDb(e.target.value)} />
          </div>
          <button className="btn-field" onClick={ping} title="Send PING to check the connection">ping</button>
        </div>
        <div className="hint">{url.replace(/:\/\/:[^@]*@/, '://:***@')}</div>

        <label>Key or prefix</label>
        <input
          value={path}
          spellCheck={false}
          placeholder="*:*:* or *_*_*"
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && go()}
        />
        <div className="hint">
          An exact key opens its value; anything else is browsed as a prefix. <kbd>Enter</kbd> also scans.
        </div>
        <button onClick={go} title="Open this exact key, or browse it as a prefix">Scan ▶</button>

        {children.length > 0 && (
          <>
            <div className="crumbs">
              <button
                type="button"
                className="crumb"
                title="Browse from the root prefix"
                onClick={() => crumbTo('')}
              >
                root
              </button>
              {path
                .replace(/:$/, '')
                .split(':')
                .filter(Boolean)
                .flatMap((seg, i, arr) => {
                  const prefix = arr.slice(0, i + 1).join(':') + ':';
                  return [
                    <span key={`sep-${i}`} className="crumb-sep">/</span>,
                    <button
                      type="button"
                      key={`seg-${i}`}
                      className="crumb"
                      title={`Browse ${prefix}`}
                      onClick={() => crumbTo(prefix)}
                    >
                      {seg}
                    </button>,
                  ];
                })}
            </div>

            <input
              className="mb4"
              placeholder="filter this level"
              value={levelFilter}
              onChange={(e) => setLevelFilter(e.target.value)}
            />
          </>
        )}

        {children.length === 0 ? (
          <div className="empty mt-3">
            <div className="empty-icon">◇</div>
            <div className="empty-title">No keys loaded</div>
            <div className="empty-hint">
              Enter a pattern like <kbd>user:*</kbd> in the key box above and press Scan to list this level.
            </div>
          </div>
        ) : (
          // Key rows are a mouse shortcut only: a scan can list hundreds of
          // them, so they are not tab stops. The key box above reaches any key
          // or prefix from the keyboard — an exact key opens its value, a
          // prefix browses that level.
          <div className="keylist">
            {children
              .filter((ch) => (levelFilter ? ch.seg.toLowerCase().includes(levelFilter.toLowerCase()) : true))
              .map((ch) => {
                const color = ch.isKey ? TYPE_COLORS[ch.type ?? ''] ?? 'var(--text-dim)' : 'var(--text-dim)';
                const badge = ch.isKey ? ch.type : 'dir';
                return (
                  <div
                    key={ch.full}
                    className={`keyrow ${view?.key === ch.full ? 'keyrow-active' : ''}`}
                    title={ch.hasChildren ? `Browse inside ${ch.full}` : `Open ${ch.full}`}
                    onClick={() => (ch.hasChildren ? drill(ch.full) : openKey(ch.full))}
                  >
                    {/* the type colour is data-driven, so it cannot come from a class */}
                    <span className="tbadge" style={{ background: color + '33', color }}>{badge}</span>
                    <span className="kname">{ch.seg}</span>
                    <span className="kcount">
                      {ch.count}
                      {ch.hasChildren ? ' ›' : ''}
                    </span>
                    {ch.isKey && ch.hasChildren && (
                      <span
                        className="open-mini"
                        title={`Open the value of ${ch.full} instead of browsing into it`}
                        onClick={(e) => {
                          e.stopPropagation();
                          openKey(ch.full);
                        }}
                      >
                        open
                      </span>
                    )}
                  </div>
                );
              })}
          </div>
        )}

        {status && <div className="hint">{status}</div>}
      </div>

      {/* ── right: three clear tabs ── */}
      <div className="right">
        <div className="tabs" role="tablist" aria-label="Redis view">
          {([
            ['value', 'Value'],
            ['commands', 'Commands'],
            ['pubsub', 'Pub / Sub'],
            ['info', 'Info'],
          ] as const).map(([id, label]) => (
            <button
              type="button"
              key={id}
              className={rtab === id ? 'tab active' : 'tab'}
              role="tab"
              aria-selected={rtab === id}
              onClick={() => setRtab(id)}
            >
              {label}
            </button>
          ))}
        </div>

        {/* every tab body stays mounted so a tab switch keeps its scroll and inputs */}
        <div hidden={rtab !== 'value'}>
          {view ? (
            <KeyDetail
              view={view}
              fmtJsonOn={fmtJsonOn}
              onToggleFmt={() => setFmtJsonOn((v) => !v)}
              onDelKey={() => delKey()}
              onDelMember={(m) => delKey(m)}
              onExpire={async (ttl) => {
                await post('expire', { url, key: view.key, ttl });
                refreshKey();
              }}
              onAdd={async (payload) => {
                await post('set', { url, key: view.key, type: view.type, ...payload });
                refreshKey();
              }}
              onRefresh={refreshKey}
              onLoadMore={loadMoreValue}
            />
          ) : (
            <div className="empty">
              <div className="empty-icon">◇</div>
              <div className="empty-title">No value selected</div>
              <div className="empty-hint">
                Scan a prefix on the left, then click a key row to view, edit and expire its value.
              </div>
            </div>
          )}
        </div>

        <div hidden={rtab !== 'commands'}>
          <CommandsTab url={url} targetKey={commandsKey} hintType={view?.type} />
        </div>

        <div hidden={rtab !== 'pubsub'}>
          <div>
            <div className="hint mb-2">
              Pub/Sub is independent of keys — publish to a channel or listen live.
            </div>
            <label>Publish</label>
            <div className="row field-row">
              <input className="w-md" placeholder="channel" value={channel} onChange={(e) => setChannel(e.target.value)} />
              <input className="grow" placeholder='{"messageType":...}' value={pubMsg} spellCheck={false} onChange={(e) => setPubMsg(e.target.value)} />
              <button className="btn-field" onClick={publish} title="Publish this message to the channel">publish</button>
            </div>

            <label>Subscribe</label>
            <div className="hint mb-2">
              Comma-separated channels. <kbd>*</kbd> is a wildcard, e.g. <kbd>events:*</kbd>, or <kbd>*</kbd> for all.
            </div>
            <div className="row field-row">
              <input
                className="grow"
                placeholder="channel1, channel2"
                value={subChannels}
                disabled={subscribed}
                onChange={(e) => setSubChannels(e.target.value)}
              />
              <button
                className={`btn-field ${subscribed ? 'btn-danger' : ''}`}
                onClick={toggleSubscribe}
                title={subscribed ? 'Stop listening on these channels' : 'Start listening on these channels'}
              >
                {subscribed ? 'stop' : 'listen'}
              </button>
            </div>
            {subscribed && <div className="hint">listening: {subChannels} — press stop to change</div>}
            {feed.length > 0 && (
              <>
                <div className="feed-head inline">
                  <span className="count">{feed.length} messages</span>
                  <button className="btn-field spacer" onClick={() => setFeed([])} title="Discard the messages received so far">
                    clear feed
                  </button>
                </div>
                <div className="feed">
                  {feed.map((f) => {
                    const pretty = tryJson(f.message);
                    return (
                      <div key={f.id} className="feed-item">
                        <span className="feed-ch">{f.channel}</span>
                        <span className="feed-time">{new Date(f.at).toLocaleTimeString()}</span>
                        <div className="feed-msg">{pretty ?? f.message}</div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>

        <div hidden={rtab !== 'info'}>
          <InfoTab url={url} />
        </div>
      </div>
    </div>
  );
}

// ── INFO dashboard + key export ──────────────────────────────────────────────
function InfoTab({ url }: { url: string }) {
  const [sections, setSections] = useState<Record<string, Record<string, string>> | null>(null);
  const [err, setErr] = useState('');
  const [exportMatch, setExportMatch] = useState('*');
  const [exporting, setExporting] = useState(false);

  const refresh = async () => {
    setErr('');
    const r = await post('info', { url });
    if (!r.ok) return setErr(r.error);
    setSections(r.sections);
  };

  const doExport = async () => {
    setExporting(true);
    setErr('');
    const r = await post('export', { url, match: exportMatch, limit: 2000 });
    setExporting(false);
    if (!r.ok) return setErr(r.error);
    const blob = new Blob([JSON.stringify(r.data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `redis-export-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    setErr(`exported ${r.count} keys${r.truncated ? ' (capped — narrow the pattern for more)' : ''}`);
  };

  // the handful of stats that actually matter at a glance
  const pick = (section: string, key: string) => sections?.[section]?.[key] ?? '-';
  const CARDS: [string, string][] = [
    ['version', pick('server', 'redis_version')],
    ['uptime (days)', pick('server', 'uptime_in_days')],
    ['clients', pick('clients', 'connected_clients')],
    ['memory', pick('memory', 'used_memory_human')],
    ['peak memory', pick('memory', 'used_memory_peak_human')],
    ['ops/sec', pick('stats', 'instantaneous_ops_per_sec')],
    ['total keys hit', pick('stats', 'keyspace_hits')],
    ['evicted keys', pick('stats', 'evicted_keys')],
  ];
  const keyspace = sections?.keyspace ?? {};

  return (
    <div>
      <div className="inline mb-2">
        <button className="btn-field" onClick={refresh} title="Read INFO from the connected instance">
          refresh INFO
        </button>
        <div className="hint">server stats for the connected instance</div>
      </div>

      {sections && (
        <>
          <div className="info-cards">
            {CARDS.map(([label, v]) => (
              <div key={label} className="info-card">
                <div className="info-card-v">{v}</div>
                <div className="info-card-k">{label}</div>
              </div>
            ))}
          </div>
          {Object.keys(keyspace).length > 0 && (
            <>
              <label>Keyspace</label>
              <table className="rtable">
                <tbody>
                  {Object.entries(keyspace).map(([db, v]) => (
                    <tr key={db}>
                      <td>{db}</td>
                      <td>{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}

      <div className="section">
        <label>Export keys</label>
        <div className="hint mb-2">Downloads a JSON file of keys matching the pattern, up to 2000 keys.</div>
        <div className="row field-row">
          <input
            className="grow"
            value={exportMatch}
            spellCheck={false}
            placeholder="myprefix:*"
            onChange={(e) => setExportMatch(e.target.value)}
          />
          <button
            className="btn-field"
            disabled={exporting}
            onClick={doExport}
            title="Download matching keys and values as JSON"
          >
            {exporting ? 'exporting…' : 'export'}
          </button>
        </div>
      </div>

      {err && <div className="hint mt-2">{err}</div>}
      {!sections && (
        <div className="empty mt-3">
          <div className="empty-icon">◇</div>
          <div className="empty-title">No server stats yet</div>
          <div className="empty-hint">
            Press <kbd>refresh INFO</kbd> above to read version, memory and ops/sec from this instance.
          </div>
        </div>
      )}
    </div>
  );
}

// ── commands chosen by the selected key's type ──────────────────────────────
// Free-form target key (root → drill down, may not exist yet) + multi-line
// batch runner + type-aware template chips. Run many at once.
function CommandsTab({
  url,
  targetKey,
  hintType,
}: {
  url: string;
  targetKey: string;
  hintType?: RedisType;
}) {
  const [key, setKey] = useState(targetKey);
  const [script, setScript] = useState('');
  // follow the drilled/opened key without wiping an in-progress script
  useEffect(() => {
    if (targetKey) setKey(targetKey);
  }, [targetKey]);
  const [results, setResults] = useState<
    { argv: string[]; ok: boolean; reply?: unknown; error?: string }[] | null
  >(null);
  const [busy, setBusy] = useState(false);

  // template groups: the selected key's type first (if known), then the rest
  const order = [
    ...(hintType && TEMPLATES[hintType] ? [hintType] : []),
    ...Object.keys(TEMPLATES).filter((t) => t !== hintType),
  ];

  const append = (tpl: string) => {
    const line = tpl.replaceAll('{k}', key || '<key>');
    setScript((s) => (s ? `${s.replace(/\n$/, '')}\n${line}` : line));
  };

  const runAll = async () => {
    const argvs = script
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map(tokenize)
      .filter((a) => a.length);
    if (!argvs.length) return;
    setBusy(true);
    const r = await post('cmd-batch', { url, argvs });
    setResults(r.ok ? r.results : [{ argv: [], ok: false, error: r.error }]);
    setBusy(false);
  };

  const okCount = results?.filter((r) => r.ok).length ?? 0;

  return (
    <div>
      <div className="hint mb-1">
        Free-form batch. Set a target key (edit the root / drill down), insert command
        templates, paste as many lines as you want, then <b>Run all</b>.
      </div>

      <label>Target key</label>
      <div className="hint mb-1">
        Fills <kbd>{'{k}'}</kbd> in the insert chips below; each command line can still name its own key.
      </div>
      <input
        value={key}
        spellCheck={false}
        placeholder="myprefix:sub:key"
        onChange={(e) => setKey(e.target.value)}
      />

      <label>Insert command</label>
      {order.map((t) => (
        <div key={t} className="tpl-group">
          <span className="tpl-type">{t}</span>
          {TEMPLATES[t].map(({ tpl, desc }) => (
            <button
              type="button"
              key={tpl}
              className="chip"
              title={`${tpl.split(' ')[0]} — ${desc}\n\n${tpl.replaceAll('{k}', key || '<key>')}`}
              onClick={() => append(tpl)}
            >
              {tpl.split(' ')[0]}
            </button>
          ))}
        </div>
      ))}

      <label>Commands</label>
      <div className="hint mb-1">
        One per line · quotes respected · <kbd>#</kbd> starts a comment · <kbd>⌘/Ctrl + Enter</kbd> runs them all.
      </div>
      <textarea
        rows={12}
        value={script}
        spellCheck={false}
        placeholder={`ZADD myset:key 1 '{"id":"a"}'\nZADD myset:key 2 '{"id":"b"}'\nSADD myset:key2 member1 member2`}
        onChange={(e) => setScript(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) runAll();
        }}
      />
      <div className="inline mt-2">
        <button className="mini" disabled={busy} onClick={runAll} title="Run every command line in order">
          {busy ? 'Running…' : 'Run all ▶'}
        </button>
        <button
          className="btn-field"
          onClick={() => { setScript(''); setResults(null); }}
          title="Empty the command box and drop the results"
        >
          clear script
        </button>
      </div>

      {results ? (
        <div className="section">
          <div className={`status ${okCount === results.length ? 'ok' : 'bad'}`}>
            {okCount}/{results.length} ok
          </div>
          <div className="inline mb-2">
            <span className="count">{results.length} replies</span>
            <button
              className="btn-field spacer"
              onClick={() => setResults(null)}
              title="Discard these replies"
            >
              clear results
            </button>
          </div>
          {results.map((r, i) => (
            <div key={i} className={`hist-item ${r.ok ? 'hist-ok' : 'hist-bad'}`}>
              <div className="cmd-preview">{r.argv.join(' ')}</div>
              <pre className="cell-json mt-1">
                {r.ok ? JSON.stringify(r.reply) : `ERROR: ${r.error}`}
              </pre>
            </div>
          ))}
        </div>
      ) : (
        <div className="section">
          <div className="empty">
            <div className="empty-icon">◇</div>
            <div className="empty-title">No commands run yet</div>
            <div className="empty-hint">
              Insert a template above or type a line like <kbd>TTL user:1</kbd>, then press Run all.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Cell({ value, fmtJsonOn }: { value: string; fmtJsonOn: boolean }) {
  const pretty = fmtJsonOn ? tryJson(value) : null;
  return pretty ? <pre className="cell-json">{pretty}</pre> : <>{value}</>;
}

function KeyDetail({
  view,
  fmtJsonOn,
  onToggleFmt,
  onDelKey,
  onDelMember,
  onExpire,
  onAdd,
  onRefresh,
  onLoadMore,
}: {
  view: RedisKeyView;
  fmtJsonOn: boolean;
  onToggleFmt: () => void;
  onDelKey: () => void;
  onDelMember: (m: string) => void;
  onExpire: (ttl: number) => void;
  onAdd: (payload: Record<string, unknown>) => void;
  onRefresh: () => void;
  onLoadMore: () => void;
}) {
  const [ttlInput, setTtlInput] = useState('');
  const color = TYPE_COLORS[view.type] ?? 'var(--text-dim)';

  const copyValue = () =>
    navigator.clipboard.writeText(
      typeof view.value === 'string' ? view.value : JSON.stringify(view.value, null, 2),
    );

  const rows = () => {
    if (view.type === 'string') {
      const s = String(view.value ?? '');
      const pretty = fmtJsonOn ? tryJson(s) : null;
      return <pre>{pretty ?? s}</pre>;
    }
    if (view.type === 'hash' || view.type === 'zset') {
      const pairs = view.value as [string, string][];
      const isZ = view.type === 'zset';
      return (
        <table className="rtable">
          <thead>
            <tr>
              <th>{isZ ? 'member' : 'field'}</th>
              <th>{isZ ? 'score' : 'value'}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {pairs.map(([a, b], i) => (
              <tr key={i}>
                <td><Cell value={isZ ? b : a} fmtJsonOn={fmtJsonOn} /></td>
                <td><Cell value={isZ ? a : b} fmtJsonOn={fmtJsonOn} /></td>
                <td>
                  <button
                    type="button"
                    className="del-x"
                    aria-label={`Remove ${isZ ? 'this member' : 'this field'} from ${view.key}`}
                    title={`Remove ${isZ ? 'this member' : 'this field'} from ${view.key}`}
                    onClick={() => onDelMember(isZ ? b : a)}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    const arr = view.value as string[];
    return (
      <table className="rtable">
        <tbody>
          {arr.map((v, i) => (
            <tr key={i}>
              <td><Cell value={v} fmtJsonOn={fmtJsonOn} /></td>
              <td>
                <button
                  type="button"
                  className="del-x"
                  aria-label={`Remove this element from ${view.key}`}
                  title={`Remove this element from ${view.key}`}
                  onClick={() => onDelMember(v)}
                >
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  };

  const shown = Array.isArray(view.value) ? (view.value as unknown[]).length : 0;
  const count = Array.isArray(view.value)
    ? view.total != null && view.total > shown
      ? ` · ${view.total} items (showing first ${shown})`
      : ` · ${shown} items`
    : '';

  return (
    <div>
      {/* the header carries the key's type colour, which is data-driven */}
      <div className="status break" style={{ background: color + '22', color }}>
        {view.type} · {view.key} · TTL{' '}
        {view.ttl === -1 ? '∞' : view.ttl === -2 ? 'gone' : `${view.ttl}s`}
        {count}
      </div>
      <div className="row field-row mb-2">
        <input
          className="w-md"
          placeholder="ttl seconds (-1 persist)"
          value={ttlInput}
          onChange={(e) => setTtlInput(e.target.value)}
        />
        <button className="btn-field" onClick={() => onExpire(Number(ttlInput))} title="Set this key's TTL to the seconds entered">
          expire
        </button>
        <button className="btn-field" onClick={onRefresh} title="Re-read this key from the server">refresh</button>
        <button className="btn-field" onClick={copyValue} title="Copy the whole value to the clipboard">copy</button>
        <button
          className={`btn-field ${fmtJsonOn ? 'btn-on' : ''}`}
          onClick={onToggleFmt}
          title="Pretty-print values that parse as JSON"
        >
          {fmtJsonOn ? 'JSON: on' : 'JSON: off'}
        </button>
        <button className="btn-field btn-danger" onClick={onDelKey} title={`Delete the whole key ${view.key}`}>
          DEL key
        </button>
      </div>
      {rows()}
      {view.nextCursor && (
        <div className="inline mt-2">
          <button className="btn-field" onClick={onLoadMore} title="Append the next page of elements to this view">
            load more (next ~500 of {view.total})
          </button>
        </div>
      )}
      <AddRow type={view.type} onAdd={onAdd} />
    </div>
  );
}

function AddRow({ type, onAdd }: { type: RedisType; onAdd: (p: Record<string, unknown>) => void }) {
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  if (type === 'string')
    return (
      <div className="row field-row addrow">
        <input className="grow" placeholder="new value" value={a} onChange={(e) => setA(e.target.value)} />
        <button className="btn-field" onClick={() => onAdd({ value: a })} title="Overwrite the string value">set</button>
      </div>
    );
  if (type === 'hash')
    return (
      <div className="row field-row addrow">
        <input className="w-md" placeholder="field" value={a} onChange={(e) => setA(e.target.value)} />
        <input className="grow" placeholder="value" value={b} onChange={(e) => setB(e.target.value)} />
        <button className="btn-field" onClick={() => onAdd({ field: a, value: b })} title="Set this field on the hash">
          hset
        </button>
      </div>
    );
  if (type === 'zset')
    return (
      <div className="row field-row addrow">
        <input className="w-sm" placeholder="score" value={a} onChange={(e) => setA(e.target.value)} />
        <input className="grow" placeholder="member" value={b} onChange={(e) => setB(e.target.value)} />
        <button className="btn-field" onClick={() => onAdd({ score: a, member: b })} title="Add this member with the given score">
          zadd
        </button>
      </div>
    );
  if (type === 'set')
    return (
      <div className="row field-row addrow">
        <input className="grow" placeholder="member" value={a} onChange={(e) => setA(e.target.value)} />
        <button className="btn-field" onClick={() => onAdd({ member: a })} title="Add this member to the set">sadd</button>
      </div>
    );
  if (type === 'list')
    return (
      <div className="row field-row addrow">
        <input className="grow" placeholder="value" value={a} onChange={(e) => setA(e.target.value)} />
        <button className="btn-field" onClick={() => onAdd({ value: a, left: false })} title="Append to the tail of the list">
          rpush
        </button>
        <button className="btn-field" onClick={() => onAdd({ value: a, left: true })} title="Prepend to the head of the list">
          lpush
        </button>
      </div>
    );
  return null;
}
