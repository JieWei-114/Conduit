import { useEffect, useRef, useState } from 'react';
import type { PulsarConnConfig, PulsarMessageIn } from './types';

const LS_CONNS = 'conduit.pulsar.conns.v1';
const LS_LAST = 'conduit.pulsar.last.v1';
const LS_TABS = 'conduit.pulsar.tabs.v1';

function loadConns(): PulsarConnConfig[] {
  try {
    const v = JSON.parse(localStorage.getItem(LS_CONNS) ?? '[]');
    return Array.isArray(v) ? v : [];
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

const EMPTY: PulsarConnConfig = {
  name: '',
  serviceUrl: 'pulsar://localhost:6650',
  authType: 'none',
  token: '',
  oauth: { issuerUrl: '', clientId: '', clientSecret: '', audience: '' },
};

// ── Chrome-style tabs: connection is SHARED across all tabs (left panel); each
// tab is an independent consumer/producer (topic + subscription + filter + its
// own live feed). Every tab's EventSource keeps streaming in the background even
// when another tab is active — so e.g. a bet-stream probe and a reward-stream
// probe run at the same time.
interface PTab {
  id: number;
  topic: string;
  subscription: string;
  subType: string;
  position: string;
  filter: string;
  payload: string;
  props: string;
  key: string; // produce: partition key (optional)
  delayMs: string; // produce: deliverAfter in ms (optional — delayed message)
}

const NEW_TAB = (id: number, over: Partial<PTab> = {}): PTab => ({
  id,
  topic: 'persistent://public/default/',
  subscription: '',
  subType: 'Exclusive',
  position: 'latest',
  filter: '',
  payload: '',
  props: '',
  key: '',
  delayMs: '',
  ...over,
});

function loadTabs(): { tabs: PTab[]; activeId: number } {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_TABS) ?? 'null');
    if (raw && Array.isArray(raw.tabs) && raw.tabs.length) {
      const tabs: PTab[] = raw.tabs.map((t: any, i: number) => NEW_TAB(t.id ?? i + 1, t));
      const activeId = tabs.some((t) => t.id === raw.activeId) ? raw.activeId : tabs[0].id;
      return { tabs, activeId };
    }
  } catch {
    /* fall through */
  }
  return { tabs: [NEW_TAB(1)], activeId: 1 };
}

export default function PulsarPanel() {
  const [conn, setConn] = useState<PulsarConnConfig>(() => {
    try {
      return { ...EMPTY, ...JSON.parse(localStorage.getItem(LS_LAST) ?? 'null') };
    } catch {
      return EMPTY;
    }
  });
  const [conns, setConns] = useState<PulsarConnConfig[]>(loadConns);
  const [pickedConn, setPickedConn] = useState('');
  const [status, setStatus] = useState('');

  // admin API (topic list / stats) — separate from the broker URL
  const [adminUrl, setAdminUrl] = useState<string>(
    () => localStorage.getItem('conduit.pulsar.adminUrl.v1') ?? '',
  );
  const [topics, setTopics] = useState<string[]>([]);
  const [stats, setStats] = useState<string>('');

  // tenant / namespace for topic listing (defaults match a stock Pulsar)
  const [tenants, setTenants] = useState<string[]>([]);
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [tenant, setTenant] = useState<string>(
    () => localStorage.getItem('conduit.pulsar.tenant.v1') ?? 'public',
  );
  const [namespace, setNamespace] = useState<string>(
    () => localStorage.getItem('conduit.pulsar.namespace.v1') ?? 'default',
  );

  // subscription management + peek (per active topic, loaded on demand)
  interface SubRow {
    name: string;
    type: string;
    backlog: number;
    consumers: number;
    msgRateOut: number;
    lastConsumedTimestamp: number;
  }
  const [subs, setSubs] = useState<SubRow[] | null>(null);
  const [peeked, setPeeked] = useState<{ pos: number; payload: string; publishTime?: string }[] | null>(null);
  const [peekPos, setPeekPos] = useState<'latest' | 'earliest'>('latest');
  const [peekCount, setPeekCount] = useState('5');

  // ── tabs (persisted, minus runtime feed state) ─────────────────────────────
  const init = useRef<{ tabs: PTab[]; activeId: number } | null>(null);
  if (!init.current) init.current = loadTabs();
  const [tabs, setTabs] = useState<PTab[]>(init.current.tabs);
  const [activeId, setActiveId] = useState<number>(init.current.activeId);
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];

  // per-tab runtime (in memory only): live feed + consuming flag + EventSource
  const [feeds, setFeeds] = useState<Record<number, PulsarMessageIn[]>>({});
  const [feedFilter, setFeedFilter] = useState<Record<number, string>>({});
  const [consuming, setConsuming] = useState<Record<number, boolean>>({});
  // real connection state per tab: idle | connecting | live (subscribed) | error
  type ConnS = { s: 'idle' | 'connecting' | 'live' | 'error'; msg?: string };
  const [connState, setConnState] = useState<Record<number, ConnS>>({});
  const esRefs = useRef<Map<number, EventSource>>(new Map());

  const setC = <K extends keyof PulsarConnConfig>(k: K, v: PulsarConnConfig[K]) =>
    setConn((c) => ({ ...c, [k]: v }));
  const setActive = (fn: (t: PTab) => PTab) =>
    setTabs((ts) => ts.map((t) => (t.id === active.id ? fn(t) : t)));
  const setA = <K extends keyof PTab>(k: K, v: PTab[K]) => setActive((t) => ({ ...t, [k]: v }));
  // editing a consume field while live → auto-stop so stale params can't keep
  // running silently (you always re-consume to apply the change).
  const editConsumeField = <K extends keyof PTab>(k: K, v: PTab[K]) => {
    if (esRefs.current.get(active.id)) toggleConsume(active.id);
    setA(k, v);
  };

  useEffect(() => {
    localStorage.setItem(LS_LAST, JSON.stringify(conn));
  }, [conn]);
  useEffect(() => {
    localStorage.setItem('conduit.pulsar.adminUrl.v1', adminUrl);
  }, [adminUrl]);
  useEffect(() => {
    localStorage.setItem(LS_TABS, JSON.stringify({ tabs, activeId }));
  }, [tabs, activeId]);
  // close every stream on unmount
  useEffect(() => () => esRefs.current.forEach((es) => es.close()), []);

  useEffect(() => {
    localStorage.setItem('conduit.pulsar.tenant.v1', tenant);
    localStorage.setItem('conduit.pulsar.namespace.v1', namespace);
  }, [tenant, namespace]);

  // never rejects — network/non-JSON failure comes back as { ok:false, error }
  const adminPost = (path: string, body: Record<string, unknown>) =>
    fetch(`/api/pulsar/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ adminUrl, token: conn.token, ...body }),
    })
      .then((x) => x.json())
      .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));

  const loadTenants = async () => {
    const r = await adminPost('tenants', {});
    if (!r.ok) return setStatus(`✗ ${r.error}`);
    setTenants(r.tenants);
    const r2 = await adminPost('namespaces', { tenant });
    if (r2.ok) setNamespaces(r2.namespaces);
    setStatus(`${r.tenants.length} tenants`);
  };

  const pickTenant = async (t: string) => {
    setTenant(t);
    const r = await adminPost('namespaces', { tenant: t });
    if (!r.ok) return setStatus(`✗ ${r.error}`);
    setNamespaces(r.namespaces);
    if (!r.namespaces.includes(namespace)) setNamespace(r.namespaces[0] ?? 'default');
  };

  const listTopics = async () => {
    setStatus('listing topics…');
    const r = await adminPost('topics', { tenant, namespace });
    if (!r.ok) return setStatus(`✗ ${r.error}`);
    setTopics(r.topics);
    setStatus(`${r.topics.length} topics in ${tenant}/${namespace}`);
  };

  const loadSubs = async () => {
    setSubs(null);
    const r = await adminPost('subs', { topic: active.topic.trim() });
    if (!r.ok) return setStatus(`✗ ${r.error}`);
    setSubs(r.subs);
    setStatus(`${r.subs.length} subscriptions`);
  };

  const skipBacklog = async (sub: string, backlog: number) => {
    if (!confirm(`Clear the entire backlog (${backlog} msgs) of subscription "${sub}"?\nThose messages are SKIPPED for this subscription — they will never be delivered to it.`)) return;
    const r = await adminPost('sub-skip', { topic: active.topic.trim(), sub });
    setStatus(r.ok ? `backlog cleared for "${sub}"` : `✗ ${r.error}`);
    if (r.ok) loadSubs();
  };

  const deleteSub = async (sub: string) => {
    if (!confirm(`Delete subscription "${sub}"?\nFails if consumers are still connected.`)) return;
    const r = await adminPost('sub-delete', { topic: active.topic.trim(), sub });
    setStatus(r.ok ? `deleted "${sub}"` : `✗ ${r.error}`);
    if (r.ok) loadSubs();
  };

  const doPeek = async () => {
    setPeeked(null);
    const r = await adminPost('peek', {
      topic: active.topic.trim(),
      position: peekPos,
      count: Number(peekCount) || 5,
    });
    if (!r.ok) return setStatus(`✗ ${r.error}`);
    setPeeked(r.messages);
    setStatus(`peeked ${r.messages.length} message(s) — nothing was consumed`);
  };

  const loadStats = async () => {
    if (!active.topic.trim()) return;
    setStatus('loading stats…');
    setStats('');
    const r = await fetch('/api/pulsar/stats', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ adminUrl, topic: active.topic.trim(), token: conn.token }),
    }).then((x) => x.json());
    if (!r.ok) return setStatus(`✗ ${r.error}`);
    setStats(JSON.stringify(r.stats, null, 2));
    setStatus('stats loaded');
  };

  const persistConns = (next: PulsarConnConfig[]) => {
    setConns(next);
    localStorage.setItem(LS_CONNS, JSON.stringify(next));
  };
  const applyConn = (name: string) => {
    setPickedConn(name);
    const c = conns.find((x) => x.name === name);
    if (c) setConn(c);
  };
  const saveConn = () => {
    const name = prompt('Name this connection (e.g. local, staging, prod):', '');
    if (!name) return;
    const c = { ...conn, name };
    persistConns([...conns.filter((x) => x.name !== name), c]);
    setConn(c);
    setPickedConn(name);
  };
  const deleteConn = () => {
    persistConns(conns.filter((c) => c.name !== pickedConn));
    setPickedConn('');
  };

  const parseProps = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const line of active.props.split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return out;
  };

  const produce = async () => {
    setStatus('sending…');
    const r = await fetch('/api/pulsar/produce', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        conn,
        topic: active.topic,
        payload: active.payload,
        properties: parseProps(),
        key: active.key,
        deliverAfterMs: Number(active.delayMs) || 0,
      }),
    }).then((x) => x.json());
    setStatus(r.ok ? `sent ✓ id=${r.messageId}` : `✗ ${r.error}`);
  };

  // ── tab operations ─────────────────────────────────────────────────────────
  const tabLabel = (t: PTab) => {
    if (t.subscription) return t.subscription;
    const leaf = t.topic.replace(/\/$/, '').split('/').pop();
    return leaf || 'new';
  };

  const addTab = () => {
    const id = Math.max(0, ...tabs.map((t) => t.id)) + 1;
    // clone the current tab's topic/conn context; give a fresh subscription
    setTabs((ts) => [...ts, NEW_TAB(id, { topic: active.topic, filter: active.filter })]);
    setActiveId(id);
  };

  const closeTab = (id: number) => {
    if (tabs.length === 1) return;
    esRefs.current.get(id)?.close();
    esRefs.current.delete(id);
    const idx = tabs.findIndex((t) => t.id === id);
    const next = tabs.filter((t) => t.id !== id);
    setTabs(next);
    setFeeds((f) => {
      const c = { ...f };
      delete c[id];
      return c;
    });
    setConsuming((m) => {
      const c = { ...m };
      delete c[id];
      return c;
    });
    setConnState((m) => {
      const c = { ...m };
      delete c[id];
      return c;
    });
    setFeedFilter((m) => {
      const c = { ...m };
      delete c[id];
      return c;
    });
    if (id === activeId) setActiveId(next[Math.max(0, idx - 1)].id);
  };

  const toggleConsume = (id: number) => {
    const existing = esRefs.current.get(id);
    if (existing) {
      existing.close();
      esRefs.current.delete(id);
      setConsuming((m) => ({ ...m, [id]: false }));
      setConnState((m) => ({ ...m, [id]: { s: 'idle' } }));
      return;
    }
    const t = tabs.find((x) => x.id === id);
    if (!t) return;
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(conn))));
    const q = new URLSearchParams({
      conn: b64,
      topic: t.topic,
      subscription: t.subscription || `conduit-${Date.now()}`,
      type: t.subType,
      position: t.position,
      ...(t.filter.trim() ? { filter: t.filter.trim() } : {}),
    });
    const es = new EventSource(`/api/pulsar/consume?${q}`);
    setConnState((m) => ({ ...m, [id]: { s: 'connecting' } }));
    // native open = HTTP stream established (not yet subscribed on broker)
    es.onopen = () => setConnState((m) => ({ ...m, [id]: m[id]?.s === 'live' ? m[id] : { s: 'connecting' } }));
    // server 'ready' = broker subscription actually succeeded → truly listening
    es.addEventListener('ready', (e) => {
      setConnState((m) => ({ ...m, [id]: { s: 'live', msg: (e as MessageEvent).data } }));
      setStatus(`subscribed: ${(e as MessageEvent).data}`);
    });
    es.addEventListener('message', (e) => {
      let d: PulsarMessageIn;
      try { d = JSON.parse((e as MessageEvent).data) as PulsarMessageIn; } catch { return; } // drop malformed frame, keep stream
      setFeeds((f) => ({ ...f, [id]: [d, ...(f[id] ?? [])].slice(0, 200) }));
    });
    // both server-sent 'error' events AND native connection failures land here.
    // Native failures (blocked by IP whitelist / auth / broker down) carry no
    // data → EventSource would silently retry forever, so we stop & flag it.
    es.addEventListener('error', (e) => {
      const data = (e as MessageEvent).data;
      const msg = data || 'connection failed — check IP whitelist / auth / service URL';
      setConnState((m) => ({ ...m, [id]: { s: 'error', msg } }));
      setStatus(`consume error: ${msg}`);
      es.close();
      esRefs.current.delete(id);
      setConsuming((m) => ({ ...m, [id]: false }));
    });
    esRefs.current.set(id, es);
    setConsuming((m) => ({ ...m, [id]: true }));
  };

  // right-column sub-tabs — Consume first (the primary probe action)
  const [rtab, setRtab] = useState<'consume' | 'produce' | 'subs' | 'peek' | 'stats'>('consume');

  const rawFeed = feeds[active.id] ?? [];
  const fq = (feedFilter[active.id] ?? '').trim().toLowerCase();
  const feed = fq
    ? rawFeed.filter(
        (m) =>
          m.payload.toLowerCase().includes(fq) ||
          m.messageId.toLowerCase().includes(fq) ||
          JSON.stringify(m.properties).toLowerCase().includes(fq),
      )
    : rawFeed;
  const isConsuming = !!consuming[active.id];

  return (
    <div className="grpc-wrap">
      {/* Chrome-style tabs — connection is shared; each tab is its own probe */}
      <div className="req-tabs">
        {tabs.map((t) => (
          <span
            key={t.id}
            className={`req-tab ${t.id === activeId ? 'active' : ''}`}
            onClick={() => setActiveId(t.id)}
            title={t.topic}
          >
            {connState[t.id]?.s === 'live'
              ? '🟢 '
              : connState[t.id]?.s === 'connecting'
                ? '🟡 '
                : connState[t.id]?.s === 'error'
                  ? '🔴 '
                  : ''}
            {tabLabel(t)}
            {tabs.length > 1 && (
              <i
                className="chip-x"
                title="close tab"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.id);
                }}
              >
                {' '}✕
              </i>
            )}
          </span>
        ))}
        <span className="req-tab req-tab-add" title="new probe tab (shares this connection)" onClick={addTab}>
          +
        </span>
      </div>

      <div className="layout">
        <div className="left">
          <h3>
            Pulsar <span className="badge">pulsar-client</span>
          </h3>

          <label>Saved connections (shared across all tabs)</label>
          <div className="row field-row">
            <select className="grow" value={pickedConn} onChange={(e) => applyConn(e.target.value)}>
              <option value=""> - </option>
              {conns.map((c) => (
                <option key={c.name} value={c.name}>{c.name}</option>
              ))}
            </select>
            <button className="btn-field" onClick={saveConn}>save</button>
            <button className="btn-field btn-danger" disabled={!pickedConn} onClick={deleteConn}>delete</button>
          </div>

          <label>Service URL (pulsar:// or pulsar+ssl://)</label>
          <input value={conn.serviceUrl} spellCheck={false} onChange={(e) => setC('serviceUrl', e.target.value)} />

          <label>Auth</label>
          <select value={conn.authType} onChange={(e) => setC('authType', e.target.value as any)}>
            <option value="none">none</option>
            <option value="token">token</option>
            <option value="oauth2">oauth2</option>
          </select>

          {conn.authType === 'token' && (
            <>
              <label>Token</label>
              <textarea rows={5} value={conn.token} spellCheck={false} onChange={(e) => setC('token', e.target.value)} />
            </>
          )}
          {conn.authType === 'oauth2' && (
            <>
              <label>issuer_url</label>
              <input value={conn.oauth!.issuerUrl} onChange={(e) => setC('oauth', { ...conn.oauth!, issuerUrl: e.target.value })} />
              <label>client_id</label>
              <input value={conn.oauth!.clientId} onChange={(e) => setC('oauth', { ...conn.oauth!, clientId: e.target.value })} />
              <label>client_secret</label>
              <input type="password" value={conn.oauth!.clientSecret} onChange={(e) => setC('oauth', { ...conn.oauth!, clientSecret: e.target.value })} />
              <label>audience</label>
              <input value={conn.oauth!.audience} onChange={(e) => setC('oauth', { ...conn.oauth!, audience: e.target.value })} />
            </>
          )}

          <label>Admin URL (optional — topics / subs / peek / stats, usually http://host:8080)</label>
          <div className="row field-row">
            <input
              className="grow"
              value={adminUrl}
              spellCheck={false}
              placeholder="http://localhost:8080"
              onChange={(e) => setAdminUrl(e.target.value)}
            />
            <button className="btn-field" disabled={!adminUrl.trim()} onClick={loadTenants}>
              load
            </button>
          </div>

          <label>Tenant / Namespace</label>
          <div className="row field-row">
            <select
              className="grow"
              value={tenant}
              onChange={(e) => pickTenant(e.target.value)}
            >
              {!tenants.includes(tenant) && <option value={tenant}>{tenant}</option>}
              {tenants.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            <select
              className="grow"
              value={namespace}
              onChange={(e) => setNamespace(e.target.value)}
            >
              {!namespaces.includes(namespace) && <option value={namespace}>{namespace}</option>}
              {namespaces.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
            <button className="btn-field" disabled={!adminUrl.trim()} onClick={listTopics}>
              list topics
            </button>
          </div>

          {status && <div className="hint">{status}</div>}
        </div>

        <div className="right">
          {/* per-tab work area: topic on top, then Consume / Produce / Stats */}
          <label style={{ marginTop: 0 }}>Topic <span className="count">(this tab)</span></label>
          <div className="row field-row">
            <input
              className="grow"
              list="pulsar-topics"
              value={active.topic}
              spellCheck={false}
              onChange={(e) => editConsumeField('topic', e.target.value)}
              placeholder="persistent://public/default/…"
            />
          </div>
          <datalist id="pulsar-topics">
            {topics.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>

          <div className="tabs" style={{ margin: '12px 0' }}>
            <span className={rtab === 'consume' ? 'tab active' : 'tab'} onClick={() => setRtab('consume')}>
              Consume {isConsuming ? '🟢' : ''}
            </span>
            <span className={rtab === 'produce' ? 'tab active' : 'tab'} onClick={() => setRtab('produce')}>
              Produce
            </span>
            <span className={rtab === 'subs' ? 'tab active' : 'tab'} onClick={() => setRtab('subs')}>
              Subs
            </span>
            <span className={rtab === 'peek' ? 'tab active' : 'tab'} onClick={() => setRtab('peek')}>
              Peek
            </span>
            <span className={rtab === 'stats' ? 'tab active' : 'tab'} onClick={() => setRtab('stats')}>
              Stats
            </span>
          </div>

          <div style={{ display: rtab === 'produce' ? undefined : 'none' }}>
            <label>Payload (JSON or text)</label>
            <textarea rows={8} value={active.payload} spellCheck={false}
              placeholder='{"messageType":"...","data":{...}}'
              onChange={(e) => setA('payload', e.target.value)} />
            <label>Properties (k: v per line — per-message metadata, like headers)</label>
            <textarea rows={3} value={active.props} spellCheck={false} placeholder="source: conduit" onChange={(e) => setA('props', e.target.value)} />
            <div className="row field-row" style={{ marginTop: 8 }}>
              <div className="grow">
                <label style={{ margin: '0 0 3px' }}>Key (optional — routing / Key_Shared ordering)</label>
                <input value={active.key} spellCheck={false} placeholder="player-123" onChange={(e) => setA('key', e.target.value)} />
              </div>
              <div style={{ maxWidth: 170 }}>
                <label style={{ margin: '0 0 3px' }}>Deliver after (ms, optional)</label>
                <input value={active.delayMs} placeholder="e.g. 60000 = 1min" onChange={(e) => setA('delayMs', e.target.value)} />
              </div>
            </div>
            {Number(active.delayMs) > 0 && (
              <div className="hint">delayed message — the broker holds it; only Shared / Key_Shared subscriptions honour the delay</div>
            )}
            <button onClick={produce}>Send ▶</button>
          </div>

          <div style={{ display: rtab === 'subs' ? undefined : 'none' }}>
            <div className="row field-row">
              <button className="btn-field" disabled={!adminUrl.trim() || !active.topic.trim()} onClick={loadSubs}>
                load subscriptions
              </button>
              <div className="hint" style={{ margin: 0 }}>
                {adminUrl.trim() ? 'who is consuming this topic, and how far behind' : 'set the Admin URL on the left first'}
              </div>
            </div>
            {subs && subs.length === 0 && <pre style={{ marginTop: 8 }}>(no subscriptions on this topic)</pre>}
            {subs && subs.length > 0 && (
              <table className="rtable" style={{ marginTop: 8 }}>
                <thead>
                  <tr>
                    <th>subscription</th><th>type</th><th>backlog</th><th>consumers</th>
                    <th>rate out</th><th>last consumed</th><th />
                  </tr>
                </thead>
                <tbody>
                  {subs.map((s) => (
                    <tr key={s.name}>
                      <td>{s.name}</td>
                      <td>{s.type}</td>
                      <td style={s.backlog > 0 ? { color: 'var(--warn)', fontWeight: 600 } : undefined}>{s.backlog}</td>
                      <td style={s.consumers === 0 ? { color: 'var(--bad)', fontWeight: 600 } : undefined}>{s.consumers}</td>
                      <td>{s.msgRateOut}/s</td>
                      <td>{s.lastConsumedTimestamp ? new Date(s.lastConsumedTimestamp).toLocaleString() : '-'}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <span className="chip" title="skip the whole backlog" onClick={() => skipBacklog(s.name, s.backlog)}>clear backlog</span>{' '}
                        <span className="chip chip-del" onClick={() => deleteSub(s.name)}>delete</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {subs && (
              <div className="hint" style={{ marginTop: 6 }}>
                backlog &gt; 0 + consumers = 0 → nobody is consuming (stuck / not deployed) · high backlog with consumers → consumer too slow
              </div>
            )}
          </div>

          <div style={{ display: rtab === 'peek' ? undefined : 'none' }}>
            <div className="row field-row">
              <select value={peekPos} onChange={(e) => setPeekPos(e.target.value as any)} style={{ maxWidth: 130 }}>
                <option value="latest">latest</option>
                <option value="earliest">earliest</option>
              </select>
              <input style={{ maxWidth: 80 }} value={peekCount} title="how many (max 20)" onChange={(e) => setPeekCount(e.target.value)} />
              <button className="btn-field" disabled={!adminUrl.trim() || !active.topic.trim()} onClick={doPeek}>
                peek
              </button>
              <div className="hint" style={{ margin: 0 }}>read without consuming — nothing is acked, no subscription touched</div>
            </div>
            {peeked && peeked.length === 0 && <pre style={{ marginTop: 8 }}>(topic is empty)</pre>}
            {peeked && peeked.length > 0 && (
              <div className="feed" style={{ marginTop: 8 }}>
                {peeked.map((m) => {
                  const pretty = tryJson(m.payload);
                  return (
                    <div key={m.pos} className="feed-item">
                      <span className="feed-ch">#{m.pos} from {peekPos}</span>
                      {m.publishTime && <span className="feed-time">{m.publishTime}</span>}
                      <div className="feed-msg">{pretty ?? m.payload}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div style={{ display: rtab === 'consume' ? undefined : 'none' }}>
            <label>Consume (live) <span className="count">— other tabs keep streaming in background</span></label>
            <div className="row field-row">
              <input className="grow" placeholder="subscription (blank = auto, unique)" value={active.subscription} onChange={(e) => editConsumeField('subscription', e.target.value)} />
              <select value={active.subType} onChange={(e) => editConsumeField('subType', e.target.value)} style={{ maxWidth: 130 }}>
                <option>Exclusive</option>
                <option>Shared</option>
                <option>Failover</option>
                <option>KeyShared</option>
              </select>
              <select value={active.position} onChange={(e) => editConsumeField('position', e.target.value)} style={{ maxWidth: 110 }}>
                <option value="latest">latest</option>
                <option value="earliest">earliest</option>
              </select>
              <button className={`btn-field ${isConsuming ? 'btn-danger' : ''}`} onClick={() => toggleConsume(active.id)}>
                {isConsuming ? 'stop' : 'consume'}
              </button>
            </div>
            {(() => {
              const cs = connState[active.id]?.s ?? 'idle';
              const label =
                cs === 'live'
                  ? `🟢 LIVE · subscribed${connState[active.id]?.msg ? ` (${connState[active.id]!.msg})` : ''} — really listening`
                  : cs === 'connecting'
                    ? '🟡 connecting… (not subscribed yet)'
                    : cs === 'error'
                      ? `🔴 ERROR — ${connState[active.id]?.msg}`
                      : '⚪ stopped';
              return <div className={`hint ${cs === 'error' ? 'error' : ''}`} style={{ marginTop: 4 }}>{label}</div>;
            })()}
            <input
              className="grow"
              style={{ marginTop: 6 }}
              placeholder="filter — only show messages containing this (e.g. QA playerId); blank = all"
              value={active.filter}
              spellCheck={false}
              onChange={(e) => editConsumeField('filter', e.target.value)}
            />
            {isConsuming && active.filter.trim() && (
              <div className="hint">filtering live on “{active.filter.trim()}” — non-matching messages are acked but hidden</div>
            )}
            {rawFeed.length > 0 && (
              <>
                <div className="feed-head">
                  <span className="count">
                    {fq ? `${feed.length} / ${rawFeed.length}` : rawFeed.length} messages
                  </span>
                  <input
                    className="grow"
                    style={{ margin: '0 8px', padding: '2px 6px', fontSize: 12 }}
                    placeholder="search received (e.g. QA playerId) — client-side, doesn't drop messages"
                    value={feedFilter[active.id] ?? ''}
                    spellCheck={false}
                    onChange={(e) => setFeedFilter((f) => ({ ...f, [active.id]: e.target.value }))}
                  />
                  <span className="chip" onClick={() => setFeeds((f) => ({ ...f, [active.id]: [] }))}>clear</span>
                </div>
                <div className="feed">
                {feed.map((m) => {
                  const pretty = tryJson(m.payload);
                  return (
                    <div key={m.messageId} className="feed-item">
                      <span className="feed-ch">{m.messageId}</span>
                      <span className="feed-time">{new Date(m.at).toLocaleTimeString()}</span>
                      {Object.keys(m.properties).length > 0 && (
                        <div className="feed-props">{JSON.stringify(m.properties)}</div>
                      )}
                      <div className="feed-msg">{pretty ?? m.payload}</div>
                    </div>
                  );
                })}
                </div>
              </>
            )}
          </div>

          <div style={{ display: rtab === 'stats' ? undefined : 'none' }}>
            <div className="row field-row">
              <button
                className="btn-field"
                disabled={!adminUrl.trim() || !active.topic.trim()}
                onClick={loadStats}
              >
                load stats
              </button>
              <div className="hint" style={{ margin: 0 }}>
                {adminUrl.trim() ? 'rates · backlog · subscriptions for this topic' : 'set the Admin URL on the left first'}
              </div>
              {stats && <span className="chip" onClick={() => setStats('')}>clear</span>}
            </div>
            {stats && <pre style={{ marginTop: 8, maxHeight: 480, overflow: 'auto' }}>{stats}</pre>}
          </div>
        </div>
      </div>
    </div>
  );
}
