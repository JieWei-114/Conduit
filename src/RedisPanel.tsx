import { memo, useEffect, useRef, useState } from 'react';
import { useFlash } from './useFlash';
import { SaveAs } from './SaveAs';
import { useArmedConfirm } from './useArmedConfirm';
import type { RedisKeyView, RedisType } from './types';
import { Empty, FeedRow, PanelHead, Section, tryJson, useStableCallback } from './ui';
import { EXAMPLES, useExample } from './examples';

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
  const [flashMsg, flash] = useFlash();

  const deleteConn = () => {
    persistConns(conns.filter((c) => c.name !== pickedConn));
    setPickedConn('');
  };

  const ping = async () => {
    const r = await post('ping', { url });
    setStatus(
      r.ok
        ? `PONG ✓${r.cluster ? ` · cluster, ${r.masters} masters` : ''}${r.note ? ` · ⚠ ${r.note}` : ''}`
        : `✗ ${r.error}`,
    );
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

  const [scanSoon, setScanSoon] = useState(false);
  useEffect(() => {
    if (!scanSoon) return;
    setScanSoon(false);
    loadChildren('');
  }, [scanSoon]);
  const exampleArm = useArmedConfirm();
  const isExampleConn = (ex: typeof EXAMPLES.redis) =>
    (!host.trim() || host.trim() === ex.host) && (!port.trim() || port.trim() === ex.port) && !password && !db;
  const applyExample = (ex: typeof EXAMPLES.redis) => {
    exampleArm.disarm();
    setHost(ex.host);
    setPort(ex.port);
    setPassword('');
    setDb('');
    setPath('');
    setRtab('value');
    setScanSoon(true);
  };
  const clickExample = (ex: typeof EXAMPLES.redis) => {
    if (isExampleConn(ex) || exampleArm.isArmed('example')) applyExample(ex);
    else exampleArm.arm('example');
  };
  useExample<typeof EXAMPLES.redis>('redis', (ex) => {
    if (isExampleConn(ex)) return applyExample(ex);
    setRtab('value');
    flash(`Kept your connection to ${host}:${port}; the ${ex.host}:${ex.port} example was not applied.`);
  });

  return (
    <div className="layout">
      <div className="left">
        <PanelHead
          title="Redis"
          badge="redis-rs"
          tagline="Browse keys by prefix, view and edit values, run commands, and watch Pub/Sub."
        />

        <div className="saved-bar">
          <select value={pickedConn} aria-label="Saved connections" onChange={(e) => applyConn(e.target.value)}>
            <option value="">{conns.length ? 'Open a saved connection…' : 'No saved connections yet'}</option>
            {conns.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
          <SaveAs
            canSave={() => (host.trim() ? null : 'Enter a host first')}
            onSave={(name) => {
              persistConns([...conns.filter((c) => c.name !== name), { name, host, port, password, db }]);
              setPickedConn(name);
              return `Saved "${name}"`;
            }}
            onMessage={flash}
          />
          <button
            className="btn-secondary btn-danger"
            disabled={!pickedConn}
            onClick={deleteConn}
            title="Delete the selected saved connection"
          >
            Delete
          </button>
        </div>
        {flashMsg && <div className="toast">{flashMsg}</div>}

        <Section title="Connection">
          <div className="conn-row mt-0">
            <div className="grow">
              <label>Host</label>
              <input
                value={host}
                spellCheck={false}
                placeholder="127.0.0.1 or redis://host:port"
                onChange={(e) => setHost(e.target.value)}
              />
            </div>
            <div className="conn-sm">
              <label>Port</label>
              <input value={port} placeholder="6379" onChange={(e) => setPort(e.target.value)} />
            </div>
          </div>
          <div className="conn-row">
            <div className="grow">
              <label>Password</label>
              <input
                type="password"
                value={password}
                spellCheck={false}
                placeholder="blank if none"
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <div className="conn-sm">
              <label>DB</label>
              <input value={db} placeholder="0" onChange={(e) => setDb(e.target.value)} />
            </div>
            <button className="btn-secondary" onClick={ping} title="Send PING to check the connection">
              Ping
            </button>
          </div>
          <div className="hint mono break">{url.replace(/:\/\/:[^@]*@/, '://:***@')}</div>
          {status && <div className={status.startsWith('✗') ? 'error break' : 'hint text-ok'}>{status.replace(/^✗ /, '')}</div>}
        </Section>

        <Section title="Keys" hint="An exact key opens its value; anything else is browsed as a prefix. Leave it empty to list the top level.">
          <div className="row row-tight">
            <input
              className="grow"
              value={path}
              spellCheck={false}
              aria-label="Key or prefix"
              placeholder="user:  or  session:42"
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && go()}
            />
            <button className="btn-primary" onClick={go} title="Open this exact key, or browse it as a prefix">
              Scan
            </button>
          </div>

          {children.length > 0 && (
            <>
              <div className="crumbs">
                <button type="button" className="crumb" title="Browse from the top level" onClick={() => crumbTo('')}>
                  root
                </button>
                {path
                  .replace(/:$/, '')
                  .split(':')
                  .filter(Boolean)
                  .flatMap((seg, i, arr) => {
                    const prefix = arr.slice(0, i + 1).join(':') + ':';
                    return [
                      <span key={`sep-${i}`} className="crumb-sep">
                        /
                      </span>,
                      <button type="button" key={`seg-${i}`} className="crumb" title={`Browse ${prefix}`} onClick={() => crumbTo(prefix)}>
                        {seg}
                      </button>,
                    ];
                  })}
              </div>
              <input
                placeholder="Filter this level"
                aria-label="Filter this level"
                value={levelFilter}
                onChange={(e) => setLevelFilter(e.target.value)}
              />
            </>
          )}

          {children.length === 0 ? (
            <Empty
              compact
              className="mt-3"
              title="No keys listed yet"
              hint={
                <>
                  Press <kbd>Scan</kbd> with the box empty to list the top level, or type a prefix like <code>user:</code>.
                </>
              }
            />
          ) : (
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
                      <span className="tbadge" style={{ background: `color-mix(in srgb, ${color} 18%, transparent)`, color }}>
                        {badge}
                      </span>
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
        </Section>
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
            <Empty
              icon="⌗"
              title="No key open"
              hint={
                <>
                  Connect on the left (default <code>127.0.0.1:6379</code>), press <kbd>Scan</kbd>, then click a key to view,
                  edit and expire its value.
                </>
              }
            >
              <button
                className="btn-secondary btn-sm"
                onClick={() => clickExample(EXAMPLES.redis)}
                onMouseLeave={exampleArm.disarm}
                onBlur={exampleArm.disarm}
              >
                {exampleArm.showsArmed('example') ? 'Click again to replace your connection' : 'Scan 127.0.0.1:6379'}
              </button>
            </Empty>
          )}
        </div>

        <div hidden={rtab !== 'commands'}>
          <CommandsTab url={url} targetKey={commandsKey} hintType={view?.type} />
        </div>

        <div hidden={rtab !== 'pubsub'}>
          <Section flush title="Publish" hint="Pub/Sub is independent of keys. Send a message to a channel, or listen below.">
            <div className="row">
              <input className="w-md" placeholder="channel" aria-label="Channel" value={channel} onChange={(e) => setChannel(e.target.value)} />
              <input
                className="grow"
                placeholder='{"event":"ping"}'
                aria-label="Message"
                value={pubMsg}
                spellCheck={false}
                onChange={(e) => setPubMsg(e.target.value)}
              />
              <button className="btn-secondary" onClick={publish} title="Publish this message to the channel">
                Publish
              </button>
            </div>
          </Section>

          <Section
            title="Subscribe"
            hint={
              <>
                Comma-separated channels. <code>*</code> is a wildcard, e.g. <code>events:*</code>, or <code>*</code> for all.
              </>
            }
          >
            <div className="row">
              <input
                className="grow"
                placeholder="channel1, channel2"
                aria-label="Channels"
                value={subChannels}
                disabled={subscribed}
                onChange={(e) => setSubChannels(e.target.value)}
              />
              <button
                className={subscribed ? 'btn-secondary btn-on' : 'btn-primary'}
                onClick={toggleSubscribe}
                title={subscribed ? 'Stop listening on these channels' : 'Start listening on these channels'}
              >
                {subscribed ? 'Stop' : 'Listen'}
              </button>
              {subscribed && <span className="pill ok live">Listening</span>}
            </div>
            {feed.length > 0 ? (
              <>
                <div className="feed-head">
                  <span className="count">{feed.length} messages</span>
                  <span className="spacer" />
                  <button className="btn-ghost btn-sm" onClick={() => setFeed([])} title="Discard the messages received so far">
                    Clear
                  </button>
                </div>
                <div className="feed">
                  {feed.map((f) => (
                    <FeedRow key={f.id} channel={f.channel} at={f.at} text={f.message} />
                  ))}
                </div>
              </>
            ) : (
              <Empty compact className="mt-3" title={subscribed ? 'Listening, nothing yet' : 'Not listening'} hint="Messages published to these channels will appear here, newest first." />
            )}
          </Section>
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
      <div className="inline mb-3">
        <button className="btn-secondary" onClick={refresh} title="Read INFO from the connected instance">
          Load server stats
        </button>
        <span className="hint m-0">Version, memory, clients and ops/sec from INFO.</span>
      </div>
      {!sections && (
        <Empty compact title="No server stats yet" hint="Press Load server stats to read them from the connected instance." />
      )}

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
              <div className="subhead">Keyspace</div>
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

      <Section title="Export keys" hint="Downloads a JSON file of keys matching the pattern, up to 2000 keys.">
        <div className="row">
          <input
            className="grow"
            value={exportMatch}
            spellCheck={false}
            placeholder="myprefix:*"
            onChange={(e) => setExportMatch(e.target.value)}
          />
          <button
            className="btn-secondary"
            disabled={exporting}
            onClick={doExport}
            title="Download matching keys and values as JSON"
          >
            {exporting ? 'Exporting…' : 'Export'}
          </button>
        </div>
      </Section>

      {err && <div className="hint mt-2">{err}</div>}
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
      <div className="hint m-0 mb-2">
        Run any Redis commands, one per line. Insert a template below, edit it, then press <b>Run all</b>.
      </div>

      <label className="field-first">Target key</label>
      <input
        value={key}
        spellCheck={false}
        placeholder="myprefix:sub:key"
        onChange={(e) => setKey(e.target.value)}
      />
      <div className="hint">
        Fills <code>{'{k}'}</code> in the templates. Opening a key on the left sets it.
      </div>

      <label>Insert a template</label>
      {order.map((t) => (
        <div key={t} className="tpl-group">
          <span className="tpl-type">{t}</span>
          {TEMPLATES[t].map(({ tpl, desc }) => (
            <button
              type="button"
              key={tpl}
              className="chip chip-mono"
              title={`${tpl.split(' ')[0]}: ${desc}\n\n${tpl.replaceAll('{k}', key || '<key>')}`}
              onClick={() => append(tpl)}
            >
              {tpl.split(' ')[0]}
            </button>
          ))}
        </div>
      ))}

      <label>Commands</label>
      <textarea
        rows={10}
        value={script}
        spellCheck={false}
        aria-label="Commands"
        placeholder={`TTL user:1\nHGETALL user:1\nSADD tags a b`}
        onChange={(e) => setScript(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) runAll();
        }}
      />
      <div className="hint">
        Quotes are respected, <code>#</code> starts a comment, <kbd>⌘↵</kbd> runs them all.
      </div>
      <div className="inline mt-2">
        <button className="btn-primary" disabled={busy || !script.trim()} onClick={runAll} title="Run every command line in order">
          {busy ? 'Running…' : 'Run all'}
        </button>
        <button
          className="btn-ghost"
          onClick={() => {
            setScript('');
            setResults(null);
          }}
          title="Empty the command box and drop the results"
        >
          Clear
        </button>
      </div>

      {results ? (
        <Section
          title={
            <>
              Replies <span className="count">({okCount}/{results.length} ok)</span>
            </>
          }
          actions={
            <button className="btn-ghost btn-sm" onClick={() => setResults(null)} title="Discard these replies">
              Clear
            </button>
          }
        >
          <div className="history">
            {results.map((r, i) => (
              <div key={i} className={`hist-item ${r.ok ? 'hist-ok' : 'hist-bad'}`}>
                <div className="cmd-preview">{r.argv.join(' ')}</div>
                <pre className="cell-json mt-1">{r.ok ? JSON.stringify(r.reply) : `ERROR: ${r.error}`}</pre>
              </div>
            ))}
          </div>
        </Section>
      ) : (
        <Empty
          compact
          className="mt-4"
          title="No commands run yet"
          hint={
            <>
              Insert a template above or type a line like <code>TTL user:1</code>, then press Run all.
            </>
          }
        />
      )}
    </div>
  );
}

function Cell({ value, fmtJsonOn }: { value: string; fmtJsonOn: boolean }) {
  const pretty = fmtJsonOn ? tryJson(value) : null;
  return pretty ? <pre className="cell-json">{pretty}</pre> : <>{value}</>;
}

const ValueRows = memo(function ValueRows({
view,
fmtJsonOn,
onDelMember,
}: {
view: RedisKeyView;
fmtJsonOn: boolean;
onDelMember: (m: string) => void;
}) {
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
});

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
  // Deleting the whole key is the destructive one here; removing a single
  // member is cheap and undone by adding it back, so only the key arms.
  const delArmed = useArmedConfirm();
  const color = TYPE_COLORS[view.type] ?? 'var(--text-dim)';
  const delMember = useStableCallback(onDelMember);

  const copyValue = () =>
    navigator.clipboard.writeText(
      typeof view.value === 'string' ? view.value : JSON.stringify(view.value, null, 2),
    );

  const shown = Array.isArray(view.value) ? (view.value as unknown[]).length : 0;
  const count = Array.isArray(view.value)
    ? view.total != null && view.total > shown
      ? ` · ${view.total} items (showing first ${shown})`
      : ` · ${shown} items`
    : '';

  return (
    <div>
      <div className="status break" style={{ background: `color-mix(in srgb, ${color} 12%, transparent)`, color, borderColor: `color-mix(in srgb, ${color} 45%, transparent)` }}>
        <span>{view.type}</span>
        <span className="sep">·</span>
        <span>{view.key}</span>
        <span className="sep">·</span>
        <span>TTL {view.ttl === -1 ? '∞' : view.ttl === -2 ? 'gone' : `${view.ttl}s`}</span>
        {count && (
          <>
            <span className="sep">·</span>
            <span>{count.replace(/^ · /, '')}</span>
          </>
        )}
      </div>
      <div className="result-bar">
        <input
          className="w-md"
          placeholder="TTL seconds, -1 = keep"
          aria-label="New TTL in seconds"
          value={ttlInput}
          onChange={(e) => setTtlInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && ttlInput.trim() && onExpire(Number(ttlInput))}
        />
        <button className="btn-secondary btn-sm" disabled={!ttlInput.trim()} onClick={() => onExpire(Number(ttlInput))} title="Set this key's TTL">
          Set TTL
        </button>
        <span className="spacer" />
        <button
          className={`btn-ghost btn-sm ${fmtJsonOn ? 'btn-on' : ''}`}
          aria-pressed={fmtJsonOn}
          onClick={onToggleFmt}
          title="Pretty-print values that parse as JSON"
        >
          Format JSON
        </button>
        <button className="btn-ghost btn-sm" onClick={onRefresh} title="Read this key again">
          Refresh
        </button>
        <button className="btn-ghost btn-sm" onClick={copyValue} title="Copy the whole value">
          Copy
        </button>
        <button
          className={`btn-secondary btn-sm btn-danger ${delArmed.showsArmed('key') ? 'btn-on' : ''}`}
          onClick={() => (delArmed.isArmed('key') ? onDelKey() : delArmed.arm('key'))}
          onMouseLeave={delArmed.disarm}
          onBlur={delArmed.disarm}
          title={`Delete the whole key ${view.key}`}
        >
          {delArmed.showsArmed('key') ? 'Click again to delete' : 'Delete key'}
        </button>
      </div>
      <ValueRows view={view} fmtJsonOn={fmtJsonOn} onDelMember={delMember} />
      {view.nextCursor && (
        <div className="more-row">
          <button className="btn-secondary btn-sm" onClick={onLoadMore} title="Append the next page of elements">
            Load more (next ~500 of {view.total})
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
      <div className="row addrow">
        <input className="grow" placeholder="new value" value={a} onChange={(e) => setA(e.target.value)} />
        <button className="btn-secondary" onClick={() => onAdd({ value: a })} title="Overwrite the string value">set</button>
      </div>
    );
  if (type === 'hash')
    return (
      <div className="row addrow">
        <input className="w-md" placeholder="field" value={a} onChange={(e) => setA(e.target.value)} />
        <input className="grow" placeholder="value" value={b} onChange={(e) => setB(e.target.value)} />
        <button className="btn-secondary" onClick={() => onAdd({ field: a, value: b })} title="Set this field on the hash">
          hset
        </button>
      </div>
    );
  if (type === 'zset')
    return (
      <div className="row addrow">
        <input className="w-sm" placeholder="score" value={a} onChange={(e) => setA(e.target.value)} />
        <input className="grow" placeholder="member" value={b} onChange={(e) => setB(e.target.value)} />
        <button className="btn-secondary" onClick={() => onAdd({ score: a, member: b })} title="Add this member with the given score">
          zadd
        </button>
      </div>
    );
  if (type === 'set')
    return (
      <div className="row addrow">
        <input className="grow" placeholder="member" value={a} onChange={(e) => setA(e.target.value)} />
        <button className="btn-secondary" onClick={() => onAdd({ member: a })} title="Add this member to the set">sadd</button>
      </div>
    );
  if (type === 'list')
    return (
      <div className="row addrow">
        <input className="grow" placeholder="value" value={a} onChange={(e) => setA(e.target.value)} />
        <button className="btn-secondary" onClick={() => onAdd({ value: a, left: false })} title="Append to the tail of the list">
          rpush
        </button>
        <button className="btn-secondary" onClick={() => onAdd({ value: a, left: true })} title="Prepend to the head of the list">
          lpush
        </button>
      </div>
    );
  return null;
}
