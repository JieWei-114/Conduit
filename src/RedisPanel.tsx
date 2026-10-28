import { memo, useEffect, useRef, useState } from 'react';
import { useFlash } from './useFlash';
import { SaveAs } from './SaveAs';
import { useArmedConfirm } from './useArmedConfirm';
import type { RedisKeyView, RedisType } from './types';
import { ConnPill, Empty, FeedRow, LongField, PanelHead, Section, tryJson, useStableCallback } from './ui';
import { EXAMPLES, useExample } from './examples';
import { CopyButton, OutcomeView, type Outcome } from './AttemptLog';
import { downloadJson } from './share';
import { rowKeyDown, rowTabIndex } from './rowNav';

const LS_CONNS = 'conduit.redis.conns.v3';
const LS_LAST = 'conduit.redis.last.v2';
const LS_HISTORY = 'conduit.redis.history.v1';
const HISTORY_MAX = 100;

/** What a failed call answered, as an outcome. */
const failed = (r: any): Outcome => ({
  ok: false,
  text: String(r?.error ?? 'failed'),
  ms: r?.durationMs,
  detail: r?.detail ?? undefined,
  log: r?.log ?? undefined,
});

/** A successful call's outcome, said as `text`. */
const succeeded = (r: any, text: string): Outcome => ({ ok: true, text, ms: r?.durationMs, log: r?.log ?? undefined });

/** An operation still running, said as `text` ("Scanning…"). */
const running = (text: string): Outcome => ({ ok: true, busy: true, text });

/** `n` and the noun, plural when it is not 1: "1 key", "3 keys". */
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The modifier key's name for keyboard hints. */
const MOD_KEY = navigator.platform.includes('Mac') ? '⌘↵' : 'Ctrl↵';

/**
 * A TTL typed by a person, checked before it is sent: a whole number of seconds, positive, or -1
 * to remove the expiry. 0 is let through: the server refuses it and says to use Delete.
 */
function checkTtl(raw: string): { ttl: number } | { error: string } {
  const t = raw.trim();
  if (!/^-?\d+$/.test(t)) return { error: 'TTL must be a whole number of seconds, or -1 to remove the expiry' };
  const n = Number(t);
  if (n < -1) return { error: 'TTL must be a positive number of seconds, or -1 to remove the expiry' };
  return { ttl: n };
}

/** A stream entry as the server sends it. */
interface StreamEntry {
  id: string;
  fields: [string, string | null][];
}

/** One line of the batch runner's history. */
interface HistoryItem {
  at: string;
  command: string;
  ok: boolean;
  error?: string;
  ms?: number;
}

function loadHistory(): HistoryItem[] {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_HISTORY) ?? '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

/** `items` (newest last, as run) in front of `prev`, newest first, at most `max`. */
function addHistory(prev: HistoryItem[], items: HistoryItem[], max = HISTORY_MAX): HistoryItem[] {
  return [...[...items].reverse(), ...prev].slice(0, max);
}

interface Conn {
  name: string;
  host: string;
  port: string;
  username?: string;
  password: string;
  db: string;
  tls?: boolean;
}

type ConnParts = Omit<Conn, 'name'>;

function parseUrl(url: string): ConnParts {
  try {
    const u = new URL(url.includes('://') ? url : `redis://${url}`);
    return {
      host: u.hostname.replace(/^\[|\]$/g, ''),
      port: u.port || '6379',
      username: decodeURIComponent(u.username || ''),
      password: decodeURIComponent(u.password || ''),
      db: u.pathname.replace(/^\//, ''),
      tls: u.protocol === 'rediss:',
    };
  } catch {
    return { host: url, port: '6379', password: '', db: '' };
  }
}

/** Whether the Host field holds a rediss:// URL, which turns TLS on whatever the checkbox says. */
function hostWantsTls(host: string): boolean {
  return /^\s*rediss:\/\//i.test(host);
}

function buildUrl(c: ConnParts): string {
  let host = c.host.trim();
  let port = (c.port || '6379').trim();
  let username = c.username?.trim() ?? '';
  let password = c.password;
  let db = c.db;
  let tls = !!c.tls;

  if (/:\/\//.test(host)) {
    const p = parseUrl(host);
    host = p.host;
    port = p.port;
    if (p.username) username = p.username;
    if (p.password) password = p.password;
    if (p.db) db = p.db;
    if (p.tls) tls = true;
  } else {
    const m = host.match(/^(.+):(\d+)$/);
    if (m && !m[1].includes(':')) {
      host = m[1];
      port = m[2];
    }
  }

  const auth = username || password
    ? `${encodeURIComponent(username)}${password ? `:${encodeURIComponent(password)}` : ''}@`
    : '';
  const h = host.includes(':') ? `[${host}]` : host;
  const d = db && db !== '0' ? `/${db}` : '';
  return `${tls ? 'rediss' : 'redis'}://${auth}${h}:${port}${d}`;
}

function shownUrl(url: string): string {
  return url.replace(/^(rediss?:\/\/[^:@/]*):[^@]*@/, '$1:***@');
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
  const [username, setUsername] = useState<string>(last.username ?? '');
  const [password, setPassword] = useState<string>(last.password ?? '');
  const [db, setDb] = useState<string>(last.db ?? '');
  const [tls, setTls] = useState<boolean>(!!last.tls);
  const tlsOn = tls || hostWantsTls(host);
  const url = buildUrl({ host, port, username, password, db, tls: tlsOn });
  const [conns, setConns] = useState(loadConns);
  const [pickedConn, setPickedConn] = useState('');
  const [view, setView] = useState<RedisKeyView | null>(null);
  // reading the open key (open, Refresh, Load more): busy, time taken, the record, or why it failed
  const [viewRead, setViewRead] = useState<Outcome | null>(null);
  // changing the open key (TTL, add, remove, delete), shown next to the value
  const [editStatus, setEditStatus] = useState<Outcome | null>(null);
  const [keyOutLatest, setKeyOutLatest] = useState<'read' | 'edit'>('read');
  const setRead = (o: Outcome | null) => {
    setViewRead(o);
    if (o) setKeyOutLatest('read');
  };
  const setEdit = (o: Outcome | null) => {
    setEditStatus(o);
    if (o) setKeyOutLatest('edit');
  };
  const [pingStatus, setPingStatus] = useState<Outcome | null>(null);
  // scanning and opening from the key list, shown under the Scan box
  const [keysStatus, setKeysStatus] = useState<Outcome | null>(null);
  const secrets = password ? [password] : [];
  const [fmtJsonOn, setFmtJsonOn] = useState(true);
  const [rtab, setRtab] = useState<'value' | 'commands' | 'pubsub' | 'info'>('value');

  // prefix drill-down browser
  interface Child {
    seg: string;
    full: string;
    type?: RedisType | null;
    /** why TYPE could not be read for this key (no permission, another cluster node…) */
    error?: string;
    isKey: boolean;
    hasChildren: boolean;
    count: number;
  }
  const [path, setPath] = useState(''); // the single key/prefix box
  const [children, setChildren] = useState<Child[]>([]);
  const [levelFilter, setLevelFilter] = useState('');
  const [commandsKey, setCommandsKey] = useState(''); // target key for Commands tab

  // pub/sub
  const [channel, setChannel] = useState('');
  const [pubMsg, setPubMsg] = useState('');
  const [subChannels, setSubChannels] = useState('');
  const [feed, setFeed] = useState<{ id: number; channel: string; message: string; at: string; note?: string }[]>([]);
  const [feedFilter, setFeedFilter] = useState('');
  const feedIdRef = useRef(0);
  const esRef = useRef<EventSource | null>(null);
  const [subState, setSubState] = useState<'idle' | 'connecting' | 'live' | 'error'>('idle');
  const [pubStatus, setPubStatus] = useState<Outcome | null>(null);
  const [subStatus, setSubStatus] = useState<Outcome | null>(null);

  useEffect(() => {
    localStorage.setItem(LS_LAST, JSON.stringify({ host, port, username, password, db, tls }));
  }, [host, port, username, password, db, tls]);

  const keysBusy = !!keysStatus?.busy;

  const loadChildren = async (prefix: string) => {
    setKeysStatus(running('Scanning…'));
    const r = await post('children', { url, prefix });
    if (!r.ok) return setKeysStatus(failed(r));
    setPath(prefix);
    setChildren(r.children);
    setLevelFilter('');
    const where = prefix ? `under ${prefix}` : 'at the top level';
    setKeysStatus(
      succeeded(
        r,
        `${plural(r.children.length, 'entry', 'entries')} ${where}${r.truncated ? ' (scan capped: narrow the prefix for the rest)' : ''}`,
      ),
    );
  };
  const drill = (full: string) => {
    setCommandsKey(full);
    loadChildren(full + ':');
  };
  const crumbTo = (prefix: string) => loadChildren(prefix);

  const showView = (r: any, quiet = false) => {
    if (r.view.key !== view?.key) setEdit(null);
    setView(r.view);
    if (!quiet) setRead(succeeded(r, 'Read'));
    setCommandsKey(r.view.key);
  };

  // one box: Enter → open if it's an exact key, else browse it as a prefix. Only a key that
  // does not exist is browsed; any other failure (a refused connection, say) is shown.
  const go = async () => {
    if (keysBusy) return;
    const v = path.trim();
    if (!v) return loadChildren('');
    setKeysStatus(running('Scanning…'));
    const r = await post('get', { url, key: v });
    if (r.ok) {
      setKeysStatus(null);
      showView(r);
      setChildren((cs) =>
        cs.some((c) => c.full === v)
          ? cs
          : [{ seg: v, full: v, type: r.view.type, isKey: true, hasChildren: false, count: 1 }],
      );
    } else if (r.missing) loadChildren(v);
    else setKeysStatus(failed(r));
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
      setUsername(c.username ?? '');
      setPassword(c.password);
      setDb(c.db);
      setTls(!!c.tls);
    }
  };
  const [flashMsg, flash] = useFlash();

  const deleteConn = () => {
    persistConns(conns.filter((c) => c.name !== pickedConn));
    setPickedConn('');
  };

  const ping = async () => {
    setPingStatus(running('Pinging…'));
    const r = await post('ping', { url });
    setPingStatus(
      r.ok
        ? succeeded(
            r,
            `${r.pong ?? 'PONG'}${r.cluster ? ` · cluster, ${plural(r.masters, 'master')}` : ''}${r.note ? ` · ${r.note}` : ''}`,
          )
        : failed(r),
    );
  };

  // open a key from the list: a failure is shown under the list, the value on the right
  const openKey = async (key: string) => {
    if (keysBusy) return;
    setKeysStatus(running(`Opening ${key}…`));
    const r = await post('get', { url, key });
    if (!r.ok) return setKeysStatus(failed(r));
    setKeysStatus(null);
    showView(r);
  };

  // read the open key again, after a change or on Refresh: the outcome shows next to the value
  const rereadKey = async (quiet = false) => {
    if (!view) return;
    if (!quiet) setRead(running('Reading…'));
    const r = await post('get', { url, key: view.key });
    if (!r.ok) return setRead(failed(r));
    showView(r, quiet);
  };

  // fetch the next ~500 elements and APPEND to the current view
  const loadMoreValue = async () => {
    if (!view?.nextCursor) return;
    setRead(running('Loading more…'));
    const r = await post('get', { url, key: view.key, cursor: view.nextCursor });
    if (!r.ok) return setRead(failed(r));
    setRead(succeeded(r, 'Read'));
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
    const key = view.key;
    setEdit(running(member != null ? 'Removing…' : 'Deleting…'));
    const r = await post('del', { url, key, type: view.type, member });
    if (!r.ok) return setEdit(failed(r));
    if (member != null) {
      const what =
        view.type === 'stream' ? 'entry' : view.type === 'hash' ? 'field' : view.type === 'list' ? 'element' : 'member';
      setEdit(succeeded(r, r.removed === 0 ? `Nothing removed: that ${what} is no longer in ${key}` : `Removed 1 ${what}`));
      rereadKey(true);
    } else {
      setView(null);
      setRead(null);
      setEdit(null);
      // the key leaves the list; a key that is also a prefix stays as one
      setChildren((cs) =>
        cs.flatMap((ch) => (ch.full !== key ? [ch] : ch.hasChildren ? [{ ...ch, isKey: false, type: undefined, error: undefined }] : [])),
      );
      setKeysStatus(succeeded(r, r.removed === 0 ? `${key} was already gone` : `Deleted ${key}`));
    }
  };

  const expireKey = async (raw: string) => {
    if (!view) return;
    const checked = checkTtl(raw);
    if ('error' in checked) return setEdit({ ok: false, text: checked.error });
    setEdit(running('Setting TTL…'));
    // 0 goes to the server as typed: it refuses it, saying to use Delete
    const r = await post('expire', { url, key: view.key, ttl: checked.ttl });
    if (!r.ok) return setEdit(failed(r));
    const text =
      checked.ttl === -1
        ? r.applied
          ? 'Expiry removed'
          : 'The key had no expiry'
        : r.applied
          ? `TTL set to ${checked.ttl} s`
          : 'Key not found: no TTL set';
    setEdit(succeeded(r, text));
    rereadKey(true);
  };

  const addToKey = async (payload: Record<string, unknown>) => {
    if (!view) return;
    setEdit(running('Saving…'));
    const r = await post('set', { url, key: view.key, type: view.type, ...payload });
    if (!r.ok) return setEdit(failed(r));
    setEdit(succeeded(r, 'Saved'));
    rereadKey(true);
  };

  const publish = async () => {
    if (pubStatus?.busy || !channel.trim()) return;
    setPubStatus(running('Publishing…'));
    const r = await post('publish', { url, channel, message: pubMsg });
    setPubStatus(r.ok ? succeeded(r, `Published · ${plural(r.receivers, 'receiver')}`) : failed(r));
  };

  const subscribing = subState === 'connecting' || subState === 'live';
  const disconnect = () => {
    esRef.current?.close();
    esRef.current = null;
    setSubState('idle');
  };
  const connect = () => {
    const chans = subChannels.trim();
    if (!chans || subscribing) return;
    const pattern = /[*?[]/.test(chans) ? '1' : '0';
    setSubStatus(null);
    setSubState('connecting');
    const es = new EventSource(
      `/api/redis/subscribe?url=${encodeURIComponent(url)}&channels=${encodeURIComponent(chans)}&pattern=${pattern}`,
    );
    es.addEventListener('ready', () => setSubState('live'));
    es.addEventListener('message', (e) => {
      let d: any;
      try { d = JSON.parse((e as MessageEvent).data); } catch { return; } // drop malformed frame, keep stream
      const row = { id: feedIdRef.current++, channel: String(d.channel ?? ''), message: String(d.message ?? ''), at: String(d.at ?? ''), note: d.note };
      setFeed((f) => [row, ...f].slice(0, 200));
    });
    // The server's error event carries { error, detail, log }; a native failure carries no
    // data, and EventSource would retry forever: stop and flag either way, so a broken
    // subscription is not shown as still listening.
    es.addEventListener('error', (e) => {
      const data = (e as MessageEvent).data;
      let r: any = null;
      try { r = data ? JSON.parse(data) : null; } catch { r = { error: data }; }
      setSubStatus(failed(r ?? { error: 'Connection to conduit lost' }));
      es.close();
      esRef.current = null;
      setSubState('error');
    });
    esRef.current = es;
  };

  useEffect(() => () => esRef.current?.close(), []);

  const fq = feedFilter.trim().toLowerCase();
  const shownFeed = fq ? feed.filter((f) => f.channel.toLowerCase().includes(fq) || f.message.toLowerCase().includes(fq)) : feed;
  const subText =
    subState === 'live'
      ? `Listening on ${subChannels.trim()}`
      : subState === 'connecting'
        ? 'Connecting…'
        : subState === 'error'
          ? 'Error'
          : 'Not connected';

  const [scanSoon, setScanSoon] = useState(false);
  useEffect(() => {
    if (!scanSoon) return;
    setScanSoon(false);
    loadChildren('');
  }, [scanSoon]);
  const exampleArm = useArmedConfirm();
  const isExampleConn = (ex: typeof EXAMPLES.redis) =>
    (!host.trim() || host.trim() === ex.host) && (!port.trim() || port.trim() === ex.port) && !password && !db && !username && !tlsOn;
  const applyExample = (ex: typeof EXAMPLES.redis) => {
    exampleArm.disarm();
    setHost(ex.host);
    setPort(ex.port);
    setUsername('');
    setPassword('');
    setDb('');
    setTls(false);
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

  const shownChildren = children.filter((ch) =>
    levelFilter ? ch.seg.toLowerCase().includes(levelFilter.toLowerCase()) : true,
  );

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
              persistConns([...conns.filter((c) => c.name !== name), { name, host, port, username, password, db, tls: tlsOn }]);
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
              <label htmlFor="redis-host">Host</label>
              <LongField
                id="redis-host"
                url
                value={host}
                spellCheck={false}
                placeholder="127.0.0.1 or rediss://host:port"
                onChange={setHost}
              />
            </div>
            <div className="conn-sm">
              <label htmlFor="redis-port">Port</label>
              <input id="redis-port" value={port} placeholder="6379" onChange={(e) => setPort(e.target.value)} />
            </div>
          </div>
          <div className="conn-row">
            <div className="grow">
              <label htmlFor="redis-username">Username</label>
              <input
                id="redis-username"
                value={username}
                spellCheck={false}
                autoComplete="off"
                placeholder="optional"
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
            <div className="grow">
              <label htmlFor="redis-password">Password</label>
              <input
                id="redis-password"
                type="password"
                value={password}
                spellCheck={false}
                placeholder="optional"
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <div className="conn-sm">
              <label htmlFor="redis-db">DB</label>
              <input id="redis-db" value={db} placeholder="0" onChange={(e) => setDb(e.target.value)} />
            </div>
            <button
              className="btn-secondary"
              disabled={!!pingStatus?.busy || !host.trim()}
              onClick={ping}
              title={host.trim() ? 'Send PING to check the connection' : 'Enter a host first'}
            >
              {pingStatus?.busy ? 'Pinging…' : 'Ping'}
            </button>
          </div>
          <div className="inline mt-2">
            <label className="check" title={hostWantsTls(host) ? 'The Host is a rediss:// URL, so TLS is always on' : 'Connect over TLS (rediss://)'}>
              <input
                type="checkbox"
                checked={tlsOn}
                disabled={hostWantsTls(host)}
                onChange={(e) => setTls(e.target.checked)}
              />
              TLS
            </label>
            <span className="hint m-0 mono break grow">{shownUrl(url)}</span>
          </div>
          <OutcomeView o={pingStatus} secrets={secrets} />
        </Section>

        <Section title="Keys" hint="An exact key opens its value; anything else is browsed as a prefix. Leave it empty to list the top level.">
          <div className="row row-tight">
            <LongField
              className="grow"
              value={path}
              spellCheck={false}
              aria-label="Key or prefix"
              placeholder="user:  or  session:42"
              onChange={setPath}
              onEnter={() => go()}
            />
            <button
              className="btn-primary"
              disabled={keysBusy || !host.trim()}
              onClick={go}
              title={host.trim() ? 'Open this exact key, or browse it as a prefix' : 'Enter a host first'}
            >
              {keysBusy ? 'Scanning…' : 'Scan'}
            </button>
          </div>
          <OutcomeView o={keysStatus} secrets={secrets} />

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
              title="No keys yet"
              hint={
                <>
                  Press <kbd>Scan</kbd> with the box empty to list the top level, or type a prefix like <code>user:</code>.
                </>
              }
            />
          ) : (
            // rows are role=button (not <button>) because a key that is also a prefix holds its own Open button
            <div className="keylist">
              <div className="keylist-head" aria-hidden>
                <span>type · name</span>
                <span title="How many keys share this name or prefix">keys</span>
              </div>
              {shownChildren.map((ch, i) => {
                const color = ch.error ? 'var(--bad)' : ch.isKey ? TYPE_COLORS[ch.type ?? ''] ?? 'var(--text-dim)' : 'var(--text-dim)';
                const badge = ch.isKey ? (ch.error ? 'error' : ch.type) : 'dir';
                const activate = () => (ch.hasChildren ? drill(ch.full) : openKey(ch.full));
                const title = ch.error
                  ? `${ch.full}: ${ch.error}`
                  : ch.hasChildren
                    ? `Browse inside ${ch.full}`
                    : `Open ${ch.full}`;
                return (
                  <div
                    key={ch.full}
                    role="button"
                    tabIndex={rowTabIndex(i)}
                    className={`keyrow ${view?.key === ch.full ? 'keyrow-active' : ''}`}
                    title={title}
                    onClick={activate}
                    onKeyDown={rowKeyDown(activate)}
                  >
                    <span className="tbadge" style={{ background: `color-mix(in srgb, ${color} 18%, transparent)`, color }}>
                      {badge}
                    </span>
                    <span className="kname">{ch.seg}</span>
                    <span className="kcount" title={`${plural(ch.count, 'key')} under this name`}>
                      {ch.count}
                      {ch.hasChildren ? ' ›' : ''}
                    </span>
                    {ch.isKey && ch.hasChildren && (
                      <button
                        type="button"
                        className="open-mini"
                        title={`Open the value of ${ch.full} instead of browsing into it`}
                        onClick={(e) => {
                          e.stopPropagation();
                          openKey(ch.full);
                        }}
                        onKeyDown={(e) => e.stopPropagation()}
                      >
                        Open
                      </button>
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
              read={viewRead}
              edit={editStatus}
              latest={keyOutLatest}
              secrets={secrets}
              fmtJsonOn={fmtJsonOn}
              onToggleFmt={() => setFmtJsonOn((v) => !v)}
              onDelKey={() => delKey()}
              onDelMember={(m) => delKey(m)}
              onExpire={expireKey}
              onAdd={addToKey}
              onRefresh={() => rereadKey()}
              onLoadMore={loadMoreValue}
            />
          ) : (
            <Empty
              icon="⌗"
              title="No key open yet"
              hint={
                <>
                  Connect on the left (now <code>{url.replace(/^rediss?:\/\/([^@]*@)?/, '').replace(/\/\d+$/, '')}</code>), press <kbd>Scan</kbd>, then
                  click a key to view, edit and expire its value.
                </>
              }
            >
              <button
                className="btn-secondary btn-sm"
                onClick={() => clickExample(EXAMPLES.redis)}
                onMouseLeave={exampleArm.disarm}
                onBlur={exampleArm.disarm}
              >
                {exampleArm.showsArmed('example') ? 'Click again to replace your connection' : 'Try 127.0.0.1:6379'}
              </button>
            </Empty>
          )}
        </div>

        <div hidden={rtab !== 'commands'}>
          <CommandsTab url={url} secrets={secrets} targetKey={commandsKey} hintType={view?.type} />
        </div>

        <div hidden={rtab !== 'pubsub'}>
          <Section flush title="Publish" hint="Pub/Sub is independent of keys. Send a message to a channel, or listen below.">
            <label htmlFor="redis-pub-channel" className="field-first">Channel</label>
            <input
              id="redis-pub-channel"
              className="w-md"
              placeholder="events"
              value={channel}
              spellCheck={false}
              onChange={(e) => setChannel(e.target.value)}
            />
            <label htmlFor="redis-pub-message">Message</label>
            <LongField
              id="redis-pub-message"
              placeholder='{"event":"ping"}'
              value={pubMsg}
              spellCheck={false}
              onChange={setPubMsg}
              onEnter={() => publish()}
            />
            <div className="inline mt-2">
              <button
                className="btn-primary"
                disabled={!!pubStatus?.busy || !channel.trim()}
                onClick={publish}
                title="Publish this message to the channel"
              >
                {pubStatus?.busy ? 'Publishing…' : 'Publish'}
              </button>
              {channel.trim() ? (
                <span className="hint m-0">
                  <kbd>Enter</kbd> in the message also publishes
                </span>
              ) : (
                <span className="hint m-0">Enter a channel first.</span>
              )}
            </div>
            <OutcomeView o={pubStatus} secrets={secrets} />
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
              <LongField
                className="grow"
                placeholder="channel1, channel2"
                aria-label="Channels to subscribe to"
                value={subChannels}
                disabled={subscribing}
                onChange={setSubChannels}
                onEnter={() => connect()}
              />
              <button
                className={subscribing ? 'btn-secondary btn-on' : 'btn-primary'}
                disabled={!subscribing && !subChannels.trim()}
                onClick={subscribing ? disconnect : connect}
                title={subscribing ? 'Stop listening on these channels' : subChannels.trim() ? 'Start listening on these channels' : 'Enter a channel first'}
              >
                {subscribing ? 'Disconnect' : 'Connect'}
              </button>
            </div>
            <div className="inline mt-2">
              <ConnPill state={subState} text={subText} />
            </div>
            <OutcomeView o={subStatus} secrets={secrets} />
            {feed.length > 0 ? (
              <>
                <div className="feed-head">
                  <span className="count">{fq ? `${shownFeed.length} / ${feed.length}` : feed.length} messages</span>
                  <input
                    className="grow"
                    placeholder="Filter messages"
                    aria-label="Filter messages"
                    value={feedFilter}
                    spellCheck={false}
                    onChange={(e) => setFeedFilter(e.target.value)}
                  />
                  <span className="spacer" />
                  <button
                    className="btn-ghost btn-sm"
                    onClick={() =>
                      downloadJson(
                        'redis',
                        'feed',
                        [...shownFeed].reverse().map(({ channel, message, at, note }) => ({ channel, message, at, ...(note ? { note } : {}) })),
                      )
                    }
                    title="Save the messages shown (with the filter applied) as a JSON file, oldest first"
                  >
                    Export JSON
                  </button>
                  <button className="btn-ghost btn-sm" onClick={() => setFeed([])} title="Discard the messages received so far">
                    Clear
                  </button>
                </div>
                <div className="feed">
                  {shownFeed.map((f) => (
                    <FeedRow key={f.id} channel={f.channel} at={f.at} text={f.message} meta={f.note} pretty={!f.note} copy />
                  ))}
                </div>
              </>
            ) : (
              <Empty
                compact
                className="mt-3"
                title={subState === 'live' ? 'No messages yet' : 'Not listening yet'}
                hint={
                  subState === 'live' ? (
                    'Messages published to these channels appear here, newest first.'
                  ) : (
                    <>
                      Enter channels and press <kbd>Connect</kbd>; messages appear here, newest first.
                    </>
                  )
                }
              />
            )}
          </Section>
        </div>

        <div hidden={rtab !== 'info'}>
          <InfoTab url={url} secrets={secrets} />
        </div>
      </div>
    </div>
  );
}

// ── INFO dashboard + key export ──────────────────────────────────────────────
function InfoTab({ url, secrets }: { url: string; secrets: string[] }) {
  const [sections, setSections] = useState<Record<string, Record<string, string>> | null>(null);
  const [infoStatus, setInfoStatus] = useState<Outcome | null>(null);
  const [exportStatus, setExportStatus] = useState<Outcome | null>(null);
  // keys that could not be read in full, from the last export
  const [exportFailed, setExportFailed] = useState<{ key: string; error: string }[]>([]);
  const [exportMatch, setExportMatch] = useState('*');
  const loading = !!infoStatus?.busy;
  const exporting = !!exportStatus?.busy;

  const refresh = async () => {
    if (loading) return;
    setInfoStatus(running('Loading…'));
    const r = await post('info', { url });
    if (!r.ok) return setInfoStatus(failed(r));
    setSections(r.sections);
    setInfoStatus(succeeded(r, 'Server stats loaded'));
  };

  const doExport = async () => {
    if (exporting) return;
    setExportStatus(running('Exporting…'));
    setExportFailed([]);
    const r = await post('export', { url, match: exportMatch, limit: 2000 });
    if (!r.ok) return setExportStatus(failed(r));
    downloadJson('redis', 'keys', r.data);
    const bad: { key: string; error: string }[] = r.failed ?? [];
    setExportFailed(bad);
    setExportStatus(
      succeeded(
        r,
        `Exported ${plural(r.count, 'key')}${bad.length ? `, ${bad.length} with errors (listed below and under "error" in the file)` : ''}${r.truncated ? ' (capped: narrow the pattern for more)' : ''}`,
      ),
    );
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
        <button className="btn-secondary" disabled={loading} onClick={refresh} title="Read INFO from the connected instance">
          {loading ? 'Loading…' : 'Load server stats'}
        </button>
        <span className="hint m-0">Version, memory, clients and ops/sec from INFO.</span>
      </div>
      <OutcomeView o={infoStatus} secrets={secrets} />
      {!sections && (
        <Empty
          compact
          title="No server stats yet"
          hint={
            <>
              Press <kbd>Load server stats</kbd> to read them from the connected instance.
            </>
          }
        />
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
          <LongField
            className="grow"
            value={exportMatch}
            spellCheck={false}
            aria-label="Export pattern"
            placeholder="myprefix:*"
            onChange={setExportMatch}
          />
          <button
            className="btn-secondary"
            disabled={exporting}
            onClick={doExport}
            title="Download matching keys and values as JSON"
          >
            {exporting ? 'Exporting…' : 'Export JSON'}
          </button>
        </div>
        <OutcomeView o={exportStatus} secrets={secrets} />
        {exportFailed.length > 0 && (
          <table className="rtable">
            <thead>
              <tr>
                <th>key</th>
                <th>error</th>
              </tr>
            </thead>
            <tbody>
              {exportFailed.map((f) => (
                <tr key={f.key}>
                  <td className="mono break">{f.key}</td>
                  <td className="break">{f.error}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  );
}

// ── commands chosen by the selected key's type ──────────────────────────────
// Free-form target key (root → drill down, may not exist yet) + multi-line
// batch runner + type-aware template chips. Run many at once.
function CommandsTab({
  url,
  secrets,
  targetKey,
  hintType,
}: {
  url: string;
  secrets: string[];
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
    { argv: string[]; ok: boolean; reply?: unknown; error?: string; ms?: number }[] | null
  >(null);
  // the whole batch: its time and record, or why it could not run
  const [batch, setBatch] = useState<Outcome | null>(null);
  const busy = !!batch?.busy;
  const [history, setHistory] = useState<HistoryItem[]>(loadHistory);
  const [showHistory, setShowHistory] = useState(false);
  const saveHistory = (next: HistoryItem[]) => {
    setHistory(next);
    try {
      localStorage.setItem(LS_HISTORY, JSON.stringify(next));
    } catch {
      // full or blocked storage: history stays for this session only
    }
  };

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
    if (!argvs.length || busy) return;
    setBatch(running('Running…'));
    const r = await post('cmd-batch', { url, argvs });
    const at = new Date().toISOString();
    if (r.ok) {
      const res = r.results as NonNullable<typeof results>;
      const bad = res.filter((x) => !x.ok).length;
      setResults(res);
      setBatch({
        ...succeeded(
          r,
          bad ? `${res.length - bad} of ${plural(res.length, 'command')} ok, ${bad} failed` : `${plural(res.length, 'command')} ok`,
        ),
        warn: bad > 0,
      });
      saveHistory(
        addHistory(
          history,
          res.map((x) => ({
            at,
            command: x.argv.join(' '),
            ok: x.ok,
            error: x.error,
            ms: x.ms,
          })),
        ),
      );
    } else {
      setResults(null);
      setBatch(failed(r));
      saveHistory(
        addHistory(
          history,
          argvs.map((a) => ({ at, command: a.join(' '), ok: false, error: String(r.error ?? 'failed'), ms: r.durationMs })),
        ),
      );
    }
  };

  const okCount = results?.filter((r) => r.ok).length ?? 0;
  const replyText = (r: { ok: boolean; reply?: unknown; error?: string }) =>
    r.ok ? (typeof r.reply === 'string' ? r.reply : JSON.stringify(r.reply, null, 2)) : `Error: ${r.error}`;

  return (
    <div>
      <div className="hint m-0 mb-2">
        Run any Redis commands, one per line. Insert a template below, edit it, then press <kbd>Run</kbd>.
      </div>

      <label className="field-first" htmlFor="redis-target-key">Target key</label>
      <LongField
        id="redis-target-key"
        value={key}
        spellCheck={false}
        placeholder="myprefix:sub:key"
        onChange={setKey}
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

      <label htmlFor="redis-commands">Commands</label>
      <textarea
        id="redis-commands"
        rows={10}
        value={script}
        spellCheck={false}
        placeholder={`TTL user:1\nHGETALL user:1\nSADD tags a b`}
        onChange={(e) => setScript(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) runAll();
        }}
      />
      <div className="hint">
        Quotes are respected and <code>#</code> starts a comment.
      </div>
      <div className="inline mt-2">
        <button className="btn-primary" disabled={busy || !script.trim()} onClick={runAll} title="Run every command line in order">
          {busy ? 'Running…' : 'Run'}
        </button>
        {script.trim() ? (
          <span className="hint m-0">
            <kbd>{MOD_KEY}</kbd> runs
          </span>
        ) : (
          <span className="hint m-0">Enter a command first.</span>
        )}
        <button
          className="btn-ghost"
          onClick={() => {
            setScript('');
            setResults(null);
            setBatch(null);
          }}
          title="Empty the command box and drop the results"
        >
          Clear
        </button>
        <span className="spacer" />
        <button
          className={`btn-ghost btn-sm ${showHistory ? 'btn-on' : ''}`}
          aria-pressed={showHistory}
          onClick={() => setShowHistory((v) => !v)}
          title="Commands run before, newest first"
        >
          History ({history.length})
        </button>
      </div>

      {showHistory && (
        <Section
          title={
            <>
              History <span className="count">(last {HISTORY_MAX}, kept in this browser)</span>
            </>
          }
          actions={
            <button className="btn-ghost btn-sm" disabled={!history.length} onClick={() => saveHistory([])} title="Forget every command in the history">
              Clear history
            </button>
          }
        >
          {history.length ? (
            <div className="history">
              {history.map((h, i) => (
                <button
                  type="button"
                  key={`${h.at}-${i}`}
                  className={`hist-item ${h.ok ? 'hist-ok' : 'hist-bad'}`}
                  title="Add this command to the command box"
                  onClick={() => setScript((s) => (s ? `${s.replace(/\n$/, '')}\n${h.command}` : h.command))}
                >
                  <div className="hist-head">
                    <code className="break">{h.command}</code>
                    <span>
                      {h.ms != null && `${h.ms} ms · `}
                      {new Date(h.at).toLocaleString()}
                    </span>
                  </div>
                  {!h.ok && h.error && <div className="hist-body">Error: {h.error}</div>}
                </button>
              ))}
            </div>
          ) : (
            <Empty compact title="No history yet" hint="Commands you run appear here." />
          )}
        </Section>
      )}

      <OutcomeView o={batch} secrets={secrets} />

      {results ? (
        <Section
          title={
            <>
              Replies <span className="count">({okCount}/{results.length} ok)</span>
            </>
          }
          actions={
            <>
              <CopyButton
                label="Copy replies"
                title="Copy every command and its reply as JSON"
                text={() => JSON.stringify(results, null, 2)}
              />
              <button
                className="btn-ghost btn-sm"
                onClick={() => downloadJson('redis', 'replies', results)}
                title="Save every command and its reply as a JSON file"
              >
                Export JSON
              </button>
              <button
                className="btn-ghost btn-sm"
                onClick={() => {
                  setResults(null);
                  setBatch(null);
                }}
                title="Discard these replies"
              >
                Clear
              </button>
            </>
          }
        >
          <div className="history">
            {results.map((r, i) => (
              <div key={i} className={`hist-item ${r.ok ? 'hist-ok' : 'hist-bad'}`}>
                <div className="hist-head">
                  <code className="cmd-preview break">{r.argv.join(' ')}</code>
                  <span>
                    {r.ms != null && `${r.ms} ms`}
                    <CopyButton label="Copy reply" title="Copy this reply" text={() => replyText(r)} />
                  </span>
                </div>
                <pre className="cell-json mt-1">{r.ok ? JSON.stringify(r.reply) : `Error: ${r.error}`}</pre>
              </div>
            ))}
          </div>
        </Section>
      ) : (
        <Empty
          compact
          className="mt-4"
          title="No replies yet"
          hint={
            <>
              Insert a template above or type a line like <code>TTL user:1</code>, then press <kbd>Run</kbd>.
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
  const arm = useArmedConfirm();
  const delX = (key: string, label: string, member: string) => (
    <button
      type="button"
      className={`del-x ${arm.showsArmed(key) ? 'del-x-armed' : ''}`}
      aria-label={label}
      title={arm.showsArmed(key) ? 'Click again to remove' : label}
      onClick={() => (arm.isArmed(key) ? (arm.disarm(), onDelMember(member)) : arm.arm(key))}
      onMouseLeave={arm.disarm}
      onBlur={arm.disarm}
    >
      {arm.showsArmed(key) ? 'Remove?' : '✕'}
    </button>
  );
  if (view.type === 'string') {
    const s = String(view.value ?? '');
    const pretty = fmtJsonOn ? tryJson(s) : null;
    return <pre>{pretty ?? s}</pre>;
  }
  if (view.type === 'hash' || view.type === 'zset') {
    // rows are [field, value] for a hash and [member, score] for a zset: the first is the name
    const pairs = view.value as [string, string][];
    const isZ = view.type === 'zset';
    const what = isZ ? 'this member' : 'this field';
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
          {pairs.map(([name, v], i) => (
            <tr key={i}>
              <td><Cell value={name} fmtJsonOn={fmtJsonOn} /></td>
              <td><Cell value={v} fmtJsonOn={fmtJsonOn} /></td>
              <td>
                {delX(`p${i}`, `Remove ${what} from ${view.key}`, name)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  if (view.type === 'stream') {
    const entries = (view.value ?? []) as StreamEntry[];
    return (
      <table className="rtable">
        <thead>
          <tr>
            <th>id</th>
            <th>fields</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id}>
              <td className="mono">{e.id}</td>
              <td>
                <table className="rtable kv-table">
                  <tbody>
                    {e.fields.map(([f, v], j) => (
                      <tr key={j}>
                        <td className="mono">{f}</td>
                        <td><Cell value={v ?? ''} fmtJsonOn={fmtJsonOn} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </td>
              <td>
                {delX(`e${e.id}`, `Delete entry ${e.id} from ${view.key} (XDEL)`, e.id)}
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
              {delX(`a${i}`, `Remove this ${view.type === 'set' ? 'member' : 'element'} from ${view.key}`, v)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
});

function KeyDetail({
  view,
  read,
  edit,
  secrets,
  fmtJsonOn,
  onToggleFmt,
  onDelKey,
  onDelMember,
  onExpire,
  onAdd,
  onRefresh,
  onLoadMore,
  latest,
}: {
  view: RedisKeyView;
  read: Outcome | null;
  edit: Outcome | null;
  latest: 'read' | 'edit';
  secrets: string[];
  fmtJsonOn: boolean;
  onToggleFmt: () => void;
  onDelKey: () => void;
  onDelMember: (m: string) => void;
  /** the TTL as typed: checked before it is sent */
  onExpire: (ttl: string) => void;
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
  const editBusy = !!edit?.busy;

  const copyValue = () => (typeof view.value === 'string' ? view.value : JSON.stringify(view.value, null, 2));

  const shown = Array.isArray(view.value) ? (view.value as unknown[]).length : 0;
  const count = Array.isArray(view.value)
    ? view.total != null && view.total > shown
      ? ` · ${plural(view.total, 'item')} (showing first ${shown})`
      : ` · ${plural(shown, 'item')}`
    : '';

  return (
    <div>
      <div className="status break" style={{ background: `color-mix(in srgb, ${color} 12%, transparent)`, color, borderColor: `color-mix(in srgb, ${color} 45%, transparent)` }}>
        <span>{view.type}</span>
        <span className="sep">·</span>
        <span>{view.key}</span>
        <span className="sep">·</span>
        <span>{view.ttl === -1 ? 'No expiry' : view.ttl === -2 ? 'Gone' : `TTL ${view.ttl} s`}</span>
        {count && (
          <>
            <span className="sep">·</span>
            <span>{count.replace(/^ · /, '')}</span>
          </>
        )}
      </div>
      <OutcomeView o={latest === 'edit' && edit ? edit : read} secrets={secrets} />
      <div className="result-bar">
        <input
          className="w-md"
          placeholder="TTL seconds"
          title="Whole seconds, or -1 for no expiry"
          aria-label="New TTL in seconds"
          inputMode="numeric"
          value={ttlInput}
          onChange={(e) => setTtlInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && ttlInput.trim() && !editBusy && onExpire(ttlInput)}
        />
        <button
          className="btn-secondary btn-sm"
          disabled={!ttlInput.trim() || editBusy}
          onClick={() => onExpire(ttlInput)}
          title="Set this key's TTL in whole seconds; -1 removes the expiry"
        >
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
        <button className="btn-ghost btn-sm" disabled={!!read?.busy} onClick={onRefresh} title="Read this key again">
          {read?.busy ? 'Reading…' : 'Refresh'}
        </button>
        <CopyButton label="Copy value" text={copyValue} title="Copy the whole value" />
        <button
          disabled={editBusy}
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
          <button className="btn-secondary btn-sm" disabled={!!read?.busy} onClick={onLoadMore} title="Append the next page of elements">
            {read?.busy ? 'Loading…' : `Load more (next ~500 of ${view.total})`}
          </button>
        </div>
      )}
      <AddRow type={view.type} busy={editBusy} onAdd={onAdd} />
    </div>
  );
}

function AddRow({ type, busy, onAdd }: { type: RedisType; busy: boolean; onAdd: (p: Record<string, unknown>) => void }) {
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const btn = (label: string, title: string, payload: Record<string, unknown>) => (
    <button className="btn-secondary" disabled={busy} onClick={() => onAdd(payload)} title={title}>
      {label}
    </button>
  );
  if (type === 'string')
    return (
      <div className="row addrow">
        <LongField className="grow" placeholder="New value" aria-label="New value" value={a} onChange={setA} />
        {btn('SET', 'Overwrite the string value', { value: a })}
      </div>
    );
  if (type === 'hash')
    return (
      <div className="row addrow">
        <input className="w-md" placeholder="Field" aria-label="Field" value={a} onChange={(e) => setA(e.target.value)} />
        <LongField className="grow" placeholder="Value" aria-label="Value" value={b} onChange={setB} />
        {btn('HSET', 'Set this field on the hash', { field: a, value: b })}
      </div>
    );
  if (type === 'zset')
    return (
      <div className="row addrow">
        <input className="w-sm" placeholder="Score" aria-label="Score" value={a} onChange={(e) => setA(e.target.value)} />
        <LongField className="grow" placeholder="Member" aria-label="Member" value={b} onChange={setB} />
        {btn('ZADD', 'Add this member with the given score', { score: a, member: b })}
      </div>
    );
  if (type === 'set')
    return (
      <div className="row addrow">
        <LongField className="grow" placeholder="Member" aria-label="Member" value={a} onChange={setA} />
        {btn('SADD', 'Add this member to the set', { member: a })}
      </div>
    );
  if (type === 'list')
    return (
      <div className="row addrow">
        <LongField className="grow" placeholder="Value" aria-label="Value" value={a} onChange={setA} />
        {btn('RPUSH', 'Append to the tail of the list', { value: a, left: false })}
        {btn('LPUSH', 'Prepend to the head of the list', { value: a, left: true })}
      </div>
    );
  return null;
}
