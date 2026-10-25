import { useEffect, useRef, useState } from 'react';
import { useFlash } from './useFlash';
import { SaveAs } from './SaveAs';
import { useArmedConfirm } from './useArmedConfirm';
import { ConnPill, Empty, FeedRow, LongField, PanelHead, ReqTabs, Section, persistLater } from './ui';
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
    persistLater(LS_LAST, () => JSON.stringify(conn));
  }, [conn]);
  useEffect(() => {
    localStorage.setItem('conduit.pulsar.adminUrl.v1', adminUrl);
  }, [adminUrl]);
  useEffect(() => {
    persistLater(LS_TABS, () => JSON.stringify({ tabs, activeId }));
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

  const subAction = useArmedConfirm();

  const skipBacklog = async (sub: string) => {
    subAction.disarm();
    const r = await adminPost('sub-skip', { topic: active.topic.trim(), sub });
    setStatus(r.ok ? `backlog cleared for "${sub}"` : `✗ ${r.error}`);
    if (r.ok) loadSubs();
  };

  const deleteSub = async (sub: string) => {
    subAction.disarm();
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
  const [flashMsg, flash] = useFlash();

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
  // one wording for connection state across every streaming panel
  const cs = connState[active.id]?.s ?? 'idle';
  const csMsg = connState[active.id]?.msg;
  const connText =
    cs === 'live'
      ? `Connected${csMsg ? ` · ${csMsg}` : ''}`
      : cs === 'connecting'
        ? 'Connecting…'
        : cs === 'error'
          ? `Error — ${csMsg}`
          : 'Disconnected';

  const needAdmin = !adminUrl.trim();

  return (
    <div className="grpc-wrap">
      <ReqTabs
        tabs={tabs}
        activeId={activeId}
        ariaLabel="Pulsar tabs"
        label={tabLabel}
        title={(t) => t.topic}
        state={(t) => {
          const s = connState[t.id]?.s;
          return s === 'idle' ? undefined : s;
        }}
        onSelect={setActiveId}
        onClose={closeTab}
        onAdd={addTab}
        addTitle="New tab (same connection)"
      />

      <div className="layout">
        <div className="left">
          <PanelHead
            title="Pulsar"
            badge="pulsar-rs"
            tagline="Connect to a broker, then consume, produce, peek or inspect a topic. Each tab is its own consumer."
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
              canSave={() => (conn.serviceUrl?.trim() ? null : 'Enter a service URL first')}
              onSave={(name) => {
                const c = { ...conn, name };
                persistConns([...conns.filter((x) => x.name !== name), c]);
                setConn(c);
                setPickedConn(name);
                return `Saved "${name}"`;
              }}
              onMessage={flash}
            />
            <button className="btn-secondary btn-danger" disabled={!pickedConn} onClick={deleteConn}>
              Delete
            </button>
          </div>
          {flashMsg && <div className="toast">{flashMsg}</div>}

          <Section title="Broker" hint="Shared by every tab in this panel.">
            <label className="field-first">Service URL</label>
            <LongField url aria-label="Service URL" value={conn.serviceUrl} spellCheck={false} placeholder="pulsar://localhost:6650" onChange={(v) => setC('serviceUrl', v)} />
            <div className="hint">
              <code>pulsar://host:6650</code> or <code>pulsar+ssl://host:6651</code>.
            </div>

            <label>Auth</label>
            <div className="seg" role="group" aria-label="Auth">
              {(['none', 'token', 'oauth2'] as const).map((t) => (
                <button
                  type="button"
                  key={t}
                  className={conn.authType === t ? 'on' : ''}
                  aria-pressed={conn.authType === t}
                  onClick={() => setC('authType', t as any)}
                >
                  {t === 'none' ? 'None' : t === 'token' ? 'Token' : 'OAuth2'}
                </button>
              ))}
            </div>
            {conn.authType === 'token' && (
              <textarea
                className="mt-2"
                rows={3}
                aria-label="Token"
                placeholder="eyJhbGciOi…"
                value={conn.token}
                spellCheck={false}
                onChange={(e) => setC('token', e.target.value)}
              />
            )}
            {conn.authType === 'oauth2' && (
              <>
                <label>Issuer URL</label>
                <LongField url aria-label="Issuer URL" value={conn.oauth!.issuerUrl} spellCheck={false} onChange={(v) => setC('oauth', { ...conn.oauth!, issuerUrl: v })} />
                <div className="conn-row">
                  <div className="grow">
                    <label>Client ID</label>
                    <LongField aria-label="Client ID" value={conn.oauth!.clientId} spellCheck={false} onChange={(v) => setC('oauth', { ...conn.oauth!, clientId: v })} />
                  </div>
                  <div className="grow">
                    <label>Client secret</label>
                    <input type="password" value={conn.oauth!.clientSecret} onChange={(e) => setC('oauth', { ...conn.oauth!, clientSecret: e.target.value })} />
                  </div>
                </div>
                <label>Audience</label>
                <LongField aria-label="Audience" value={conn.oauth!.audience} spellCheck={false} onChange={(v) => setC('oauth', { ...conn.oauth!, audience: v })} />
              </>
            )}
          </Section>

          <Section title="Admin API" hint="Optional. Lists topics and enables Subscriptions, Peek and Stats.">
            <div className="row row-tight">
              <LongField
                url
                className="grow"
                value={adminUrl}
                spellCheck={false}
                aria-label="Admin URL"
                placeholder="http://localhost:8080"
                onChange={setAdminUrl}
              />
              <button className="btn-secondary" disabled={needAdmin} onClick={loadTenants}>
                Load tenants
              </button>
            </div>
            <label>Tenant / namespace</label>
            <div className="row">
              <select value={tenant} aria-label="Tenant" onChange={(e) => pickTenant(e.target.value)}>
                {!tenants.includes(tenant) && <option value={tenant}>{tenant}</option>}
                {tenants.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <select value={namespace} aria-label="Namespace" onChange={(e) => setNamespace(e.target.value)}>
                {!namespaces.includes(namespace) && <option value={namespace}>{namespace}</option>}
                {namespaces.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              <button className="btn-secondary" disabled={needAdmin} onClick={listTopics}>
                List topics
              </button>
            </div>
            {topics.length > 0 && (
              <div className="keylist">
                {topics.map((t) => (
                  <div
                    key={t}
                    className={`keyrow ${t === active.topic ? 'keyrow-active' : ''}`}
                    title="Use this topic in the current tab"
                    onClick={() => editConsumeField('topic', t)}
                  >
                    <span className="kname" title={t}>{t}</span>
                  </div>
                ))}
              </div>
            )}
            {status && <div className={status.startsWith('✗') || status.includes('error') ? 'error break' : 'hint'}>{status.replace(/^✗ /, '')}</div>}
          </Section>
        </div>

        <div className="right">
          <label className="field-first">
            Topic <span className="count">(this tab)</span>
          </label>
          <LongField
            url
            suggestions={topics}
            value={active.topic}
            spellCheck={false}
            aria-label="Topic"
            onChange={(v) => editConsumeField('topic', v)}
            placeholder="persistent://public/default/my-topic"
          />

          <div className="tabs mt-4" role="tablist" aria-label="Pulsar view">
            {(
              [
                ['consume', 'Consume'],
                ['produce', 'Produce'],
                ['subs', 'Subscriptions'],
                ['peek', 'Peek'],
                ['stats', 'Stats'],
              ] as const
            ).map(([id, label]) => (
              <button
                type="button"
                key={id}
                className={rtab === id ? 'tab active' : 'tab'}
                role="tab"
                aria-selected={rtab === id}
                onClick={() => setRtab(id)}
              >
                {label}
                {id === 'consume' && isConsuming && <span className="dot live" />}
              </button>
            ))}
          </div>

          <div hidden={rtab !== 'produce'}>
            <label className="field-first">Payload</label>
            <textarea
              rows={7}
              value={active.payload}
              spellCheck={false}
              placeholder='{"event":"order-created"}'
              onChange={(e) => setA('payload', e.target.value)}
            />
            <div className="hint">JSON or plain text.</div>
            <label>Properties</label>
            <textarea rows={2} value={active.props} spellCheck={false} placeholder="source: conduit" onChange={(e) => setA('props', e.target.value)} />
            <div className="hint">
              Per-message metadata, one <code>name: value</code> per line.
            </div>
            <div className="conn-row">
              <div className="grow">
                <label>Key</label>
                <LongField aria-label="Key" value={active.key} spellCheck={false} placeholder="order-123" onChange={(v) => setA('key', v)} />
              </div>
              <div className="w-md">
                <label>Deliver after (ms)</label>
                <input value={active.delayMs} placeholder="blank = now" onChange={(e) => setA('delayMs', e.target.value)} />
              </div>
            </div>
            <div className="hint">
              Key routes the message and orders Key_Shared consumers.
              {Number(active.delayMs) > 0 && ' Delayed messages are only honoured by Shared and Key_Shared subscriptions.'}
            </div>
            <div className="inline mt-3">
              <button className="btn-primary" disabled={!active.topic.trim()} onClick={produce}>
                Send message
              </button>
            </div>
          </div>

          <div hidden={rtab !== 'subs'}>
            <div className="inline">
              <button className="btn-secondary" disabled={needAdmin || !active.topic.trim()} onClick={loadSubs}>
                Load subscriptions
              </button>
              <span className="hint m-0">
                {needAdmin ? 'Set the Admin URL on the left first.' : 'Who consumes this topic, and how far behind they are.'}
              </span>
            </div>
            {subs && subs.length === 0 && (
              <Empty
                className="mt-3"
                title="No subscriptions"
                hint="Nothing is subscribed to this topic yet. Start a consumer on the Consume tab, then load again."
              />
            )}
            {!subs && <Empty className="mt-3" compact title="Not loaded" hint="Press Load subscriptions to see consumers and backlog." />}
            {subs && subs.length > 0 && (
              <div className="table-scroll mt-3">
                <table className="rtable">
                  <thead>
                    <tr>
                      <th>subscription</th>
                      <th>type</th>
                      <th>backlog</th>
                      <th>consumers</th>
                      <th>rate out</th>
                      <th>last consumed</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {subs.map((s) => (
                      <tr key={s.name}>
                        <td>{s.name}</td>
                        <td>{s.type}</td>
                        <td className={s.backlog > 0 ? 'text-warn' : undefined}>{s.backlog}</td>
                        <td className={s.consumers === 0 ? 'text-bad' : undefined}>{s.consumers}</td>
                        <td>{s.msgRateOut}/s</td>
                        <td>{s.lastConsumedTimestamp ? new Date(s.lastConsumedTimestamp).toLocaleString() : '-'}</td>
                        <td className="nowrap">
                          <button
                            className="btn-secondary btn-sm btn-danger"
                            title={`Skip the whole backlog (${s.backlog} msgs) for "${s.name}": those messages are never delivered to it`}
                            onClick={() =>
                              subAction.isArmed(`skip:${s.name}`) ? skipBacklog(s.name) : subAction.arm(`skip:${s.name}`)
                            }
                            onMouseLeave={subAction.disarm}
                            onBlur={subAction.disarm}
                          >
                            {subAction.showsArmed(`skip:${s.name}`) ? `Confirm: skip ${s.backlog}` : 'Clear backlog'}
                          </button>{' '}
                          <button
                            className="btn-secondary btn-sm btn-danger"
                            title={`Delete subscription "${s.name}"; fails if consumers are still connected`}
                            onClick={() => (subAction.isArmed(`del:${s.name}`) ? deleteSub(s.name) : subAction.arm(`del:${s.name}`))}
                            onMouseLeave={subAction.disarm}
                            onBlur={subAction.disarm}
                          >
                            {subAction.showsArmed(`del:${s.name}`) ? 'Confirm delete' : 'Delete'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {subs && subs.length > 0 && (
              <div className="hint mt-2">
                Backlog above 0 with no consumers means nobody is reading (stuck or not deployed). A high backlog with consumers
                attached means they are too slow.
              </div>
            )}
          </div>

          <div hidden={rtab !== 'peek'}>
            <div className="row">
              <select className="w-sm" value={peekPos} aria-label="Peek from" onChange={(e) => setPeekPos(e.target.value as any)} title="Read from the newest or the oldest end">
                <option value="latest">latest</option>
                <option value="earliest">earliest</option>
              </select>
              <input className="w-xs" value={peekCount} aria-label="How many" title="How many messages to read (max 20)" onChange={(e) => setPeekCount(e.target.value)} />
              <button className="btn-secondary" disabled={needAdmin || !active.topic.trim()} onClick={doPeek}>
                Peek
              </button>
              <span className="hint grow">Reads without consuming: nothing is acked and no subscription is touched.</span>
            </div>
            {!peeked && <Empty className="mt-3" compact title="Nothing peeked yet" hint="Choose an end of the topic and press Peek." />}
            {peeked && peeked.length === 0 && (
              <Empty className="mt-3" title="Topic is empty" hint="No messages are retained here. Publish one from the Produce tab, then peek again." />
            )}
            {peeked && peeked.length > 0 && (
              <div className="feed">
                {peeked.map((m) => (
                  <FeedRow key={m.pos} channel={`#${m.pos} from ${peekPos}`} at={m.publishTime} text={m.payload} />
                ))}
              </div>
            )}
          </div>

          <div hidden={rtab !== 'consume'}>
            <div className="row">
              <LongField
                className="grow"
                placeholder="subscription (blank = auto, unique)"
                aria-label="Subscription name"
                value={active.subscription}
                onChange={(v) => editConsumeField('subscription', v)}
              />
              <select className="w-sm" value={active.subType} aria-label="Subscription type" onChange={(e) => editConsumeField('subType', e.target.value)} title="Subscription type">
                <option>Exclusive</option>
                <option>Shared</option>
                <option>Failover</option>
                <option>KeyShared</option>
              </select>
              <select className="w-sm" value={active.position} aria-label="Start position" onChange={(e) => editConsumeField('position', e.target.value)} title="Where the subscription starts reading">
                <option value="latest">latest</option>
                <option value="earliest">earliest</option>
              </select>
              <button
                className={isConsuming ? 'btn-secondary btn-on' : 'btn-primary'}
                disabled={!isConsuming && !active.topic.trim()}
                onClick={() => toggleConsume(active.id)}
              >
                {isConsuming ? 'Disconnect' : 'Connect'}
              </button>
            </div>
            <input
              className="mt-2"
              placeholder="Live filter: only show messages containing this (blank = all)"
              aria-label="Live filter"
              value={active.filter}
              spellCheck={false}
              onChange={(e) => editConsumeField('filter', e.target.value)}
            />
            <div className="inline mt-2">
              <ConnPill state={cs} text={cs === 'error' ? 'Error' : connText} />
              <span className="hint m-0">
                {isConsuming && active.filter.trim()
                  ? `Filtering on "${active.filter.trim()}": other messages are acked but hidden.`
                  : 'Other tabs keep streaming in the background.'}
              </span>
            </div>
            {cs === 'error' && csMsg && <div className="error">{csMsg}</div>}
            {rawFeed.length === 0 && cs !== 'live' && (
              <Empty
                className="mt-3"
                icon="⇣"
                title="Not consuming"
                hint={
                  <>
                    Set a topic such as <code>persistent://public/default/my-topic</code> and press <kbd>Connect</kbd>.
                  </>
                }
              />
            )}
            {rawFeed.length === 0 && cs === 'live' && (
              <Empty
                className="mt-3"
                icon="⇣"
                title="Connected, no messages yet"
                hint="Messages published to this topic will appear here. Publish one from the Produce tab to check the path end to end."
              />
            )}
            {rawFeed.length > 0 && (
              <>
                <div className="feed-head">
                  <span className="count">{fq ? `${feed.length} / ${rawFeed.length}` : rawFeed.length} messages</span>
                  <input
                    className="grow"
                    placeholder="Filter messages"
                    aria-label="Filter messages"
                    value={feedFilter[active.id] ?? ''}
                    spellCheck={false}
                    onChange={(e) => setFeedFilter((f) => ({ ...f, [active.id]: e.target.value }))}
                  />
                  <button
                    className="btn-ghost btn-sm"
                    title="Discard the messages received so far"
                    onClick={() => setFeeds((f) => ({ ...f, [active.id]: [] }))}
                  >
                    Clear
                  </button>
                </div>
                <div className="feed">
                  {feed.map((m) => (
                    <FeedRow
                      key={m.messageId}
                      channel={m.messageId}
                      at={m.at}
                      text={m.payload}
                      meta={Object.keys(m.properties).length > 0 ? JSON.stringify(m.properties) : undefined}
                    />
                  ))}
                </div>
              </>
            )}
          </div>

          <div hidden={rtab !== 'stats'}>
            <div className="inline">
              <button className="btn-secondary" disabled={needAdmin || !active.topic.trim()} onClick={loadStats}>
                Load stats
              </button>
              <span className="hint m-0">
                {needAdmin ? 'Set the Admin URL on the left first.' : 'Rates, backlog and subscriptions for this topic.'}
              </span>
              {stats && (
                <button className="btn-ghost btn-sm spacer" title="Discard the loaded stats" onClick={() => setStats('')}>
                  Clear
                </button>
              )}
            </div>
            {!stats && <Empty className="mt-3" compact title="No stats loaded" hint="Press Load stats for throughput and backlog counters." />}
            {stats && <pre className="mt-3">{stats}</pre>}
          </div>
        </div>
      </div>
    </div>
  );
}
