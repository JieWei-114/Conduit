import { useEffect, useRef, useState } from 'react';
import { useFlash } from './useFlash';
import { SaveAs } from './SaveAs';
import { useArmedConfirm } from './useArmedConfirm';
import { ConnPill, Empty, FeedRow, LongField, PanelHead, ReqTabs, Section, persistLater } from './ui';
import { CopyButton, Outcome, OutcomeView } from './AttemptLog';
import { downloadJson } from './share';
import type { AttemptError, AttemptLog, PulsarConnConfig, PulsarMessageIn } from './types';

/** A consumed message as the server streams it now: the full id, key and event time too. */
interface PMsg extends PulsarMessageIn {
  topic?: string;
  key?: string | null;
  eventTime?: number | null;
  /** 'base64' when the payload was not UTF-8; the note says so */
  payloadEncoding?: 'utf8' | 'base64' | null;
  payloadNote?: string | null;
}
/** A line in the live feed: a message, or a warning such as a failed ack. */
type PFeed = PMsg | { at: string; warning: string };
const isWarning = (m: PFeed): m is { at: string; warning: string } => 'warning' in m;

interface PeekMsg {
  pos: number;
  payload: string;
  payloadEncoding?: 'utf8' | 'base64' | null;
  payloadNote?: string | null;
  publishTime?: string | null;
  eventTime?: string | null;
  messageId?: string | null;
  key?: string | null;
  batchSize?: string | null;
  properties?: Record<string, string>;
}

interface SubRow {
  name: string;
  type: string;
  backlog: number;
  consumers: number;
  msgRateOut: number;
  lastConsumedTimestamp: number;
}

type Op = 'admin' | 'produce' | 'subs' | 'peek' | 'stats';

/** What a tab has loaded and done (memory only): never shown on another tab. */
interface TabRun {
  subs?: SubRow[] | null;
  peeked?: PeekMsg[] | null;
  peekWarning?: string;
  stats?: unknown;
  /** the id of the last message published from this tab */
  published?: string;
  outcomes: Partial<Record<Op, Outcome>>;
}
const NO_RUN: TabRun = { outcomes: {} };

const SEND_KEY = navigator.platform.includes('Mac') ? '⌘↵' : 'Ctrl↵';
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The live filter, matched the way it always was (case-sensitive) against what a person reads. */
function matchesLiveFilter(m: PMsg, filter: string): boolean {
  if (!filter) return true;
  return (
    m.payload.includes(filter) || (m.key ?? '').includes(filter) || JSON.stringify(m.properties ?? {}).includes(filter)
  );
}

/** One line of metadata for a message: key, times, properties, and a note about binary bytes. */
function msgMeta(m: {
  key?: string | null;
  publishTime?: number | string | null;
  eventTime?: number | string | null;
  properties?: Record<string, string>;
  payloadNote?: string | null;
}): string | undefined {
  const time = (t: number | string) => (typeof t === 'number' ? new Date(t).toISOString() : t);
  const parts: string[] = [];
  if (m.key != null) parts.push(`key ${m.key === '' ? '""' : m.key}`);
  if (m.publishTime) parts.push(`published ${time(m.publishTime)}`);
  if (m.eventTime) parts.push(`event ${time(m.eventTime)}`);
  if (m.properties && Object.keys(m.properties).length) parts.push(JSON.stringify(m.properties));
  if (m.payloadNote) parts.push(`payload ${m.payloadNote}`);
  return parts.length ? parts.join('  ·  ') : undefined;
}

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

  // admin API (topic list / stats) — separate from the broker URL
  const [adminUrl, setAdminUrl] = useState<string>(
    () => localStorage.getItem('conduit.pulsar.adminUrl.v1') ?? '',
  );
  const [topics, setTopics] = useState<string[]>([]);

  // tenant / namespace for topic listing (defaults match a stock Pulsar)
  const [tenants, setTenants] = useState<string[]>([]);
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [tenant, setTenant] = useState<string>(
    () => localStorage.getItem('conduit.pulsar.tenant.v1') ?? 'public',
  );
  const [namespace, setNamespace] = useState<string>(
    () => localStorage.getItem('conduit.pulsar.namespace.v1') ?? 'default',
  );

  const [peekPos, setPeekPos] = useState<'latest' | 'earliest'>('latest');
  const [peekCount, setPeekCount] = useState('5');

  // ── tabs (persisted, minus runtime feed state) ─────────────────────────────
  const init = useRef<{ tabs: PTab[]; activeId: number } | null>(null);
  if (!init.current) init.current = loadTabs();
  const [tabs, setTabs] = useState<PTab[]>(init.current.tabs);
  const [activeId, setActiveId] = useState<number>(init.current.activeId);
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];
  // the latest tabs, for a call that finishes after its tab moved to another topic
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  // per-tab runtime (in memory only): live feed + consuming flag + EventSource
  const [feeds, setFeeds] = useState<Record<number, PFeed[]>>({});
  const [feedFilter, setFeedFilter] = useState<Record<number, string>>({});
  const [consuming, setConsuming] = useState<Record<number, boolean>>({});
  // real connection state per tab: idle | connecting | live (subscribed) | error
  type ConnS = { s: 'idle' | 'connecting' | 'live' | 'error'; msg?: string; detail?: AttemptError; log?: AttemptLog };
  const [connState, setConnState] = useState<Record<number, ConnS>>({});
  // the subscription name a tab's person agreed to join (valid only while the name is unchanged)
  const [joinOk, setJoinOk] = useState<Record<number, string>>({});
  const esRefs = useRef<Map<number, EventSource>>(new Map());

  // per-tab results: subscriptions, peeked messages, stats and every operation's outcome
  const [runs, setRuns] = useState<Record<number, TabRun>>({});
  const patchRun = (id: number, fn: (r: TabRun) => Partial<TabRun>) =>
    setRuns((m) => {
      const r = m[id] ?? NO_RUN;
      return { ...m, [id]: { ...r, ...fn(r) } };
    });
  const note = (
    id: number,
    op: Op,
    r: { ok?: boolean; error?: string; durationMs?: number; detail?: AttemptError; log?: AttemptLog },
    done: string,
  ) =>
    patchRun(id, (x) => ({
      outcomes: { ...x.outcomes, [op]: { ok: !!r.ok, text: r.ok ? done : r.error, ms: r.durationMs ?? r.log?.durationMs, detail: r.detail, log: r.log } },
    }));
  const working = (id: number, op: Op, text: string) =>
    patchRun(id, (x) => ({ outcomes: { ...x.outcomes, [op]: { ok: true, busy: true, text } } }));
  /** Whether tab `id` still shows `topic`: a reply for a topic the tab has left is dropped. */
  const stillOn = (id: number, topic: string) => tabsRef.current.find((t) => t.id === id)?.topic.trim() === topic;

  const setC = <K extends keyof PulsarConnConfig>(k: K, v: PulsarConnConfig[K]) =>
    setConn((c) => ({ ...c, [k]: v }));
  const setActive = (fn: (t: PTab) => PTab) =>
    setTabs((ts) => ts.map((t) => (t.id === active.id ? fn(t) : t)));
  const setA = <K extends keyof PTab>(k: K, v: PTab[K]) => setActive((t) => ({ ...t, [k]: v }));
  // editing a consume field while live → auto-stop so stale params can't keep
  // running silently (you always re-consume to apply the change).
  const editConsumeField = <K extends keyof PTab>(k: K, v: PTab[K]) => {
    if (esRefs.current.get(active.id)) toggleConsume(active.id);
    // what was loaded for the old topic does not describe the new one
    if (k === 'topic' && v !== active.topic) {
      setRuns((m) => ({ ...m, [active.id]: { outcomes: { admin: m[active.id]?.outcomes.admin } } }));
    }
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
    const id = active.id;
    working(id, 'admin', 'Loading tenants…');
    const r = await adminPost('tenants', {});
    note(id, 'admin', r, r.ok ? plural(r.tenants.length, 'tenant') : '');
    if (!r.ok) return;
    setTenants(r.tenants);
    const r2 = await adminPost('namespaces', { tenant });
    if (r2.ok) setNamespaces(r2.namespaces);
  };

  const pickTenant = async (t: string) => {
    const id = active.id;
    setTenant(t);
    working(id, 'admin', 'Loading namespaces…');
    const r = await adminPost('namespaces', { tenant: t });
    note(id, 'admin', r, r.ok ? `${plural(r.namespaces.length, 'namespace')} in ${t}` : '');
    if (!r.ok) return;
    setNamespaces(r.namespaces);
    if (!r.namespaces.includes(namespace)) setNamespace(r.namespaces[0] ?? 'default');
  };

  const listTopics = async () => {
    const id = active.id;
    working(id, 'admin', 'Listing topics…');
    const r = await adminPost('topics', { tenant, namespace });
    note(id, 'admin', r, r.ok ? `${plural(r.topics.length, 'topic')} in ${tenant}/${namespace}` : '');
    if (!r.ok) return;
    setTopics(r.topics);
  };

  const loadSubs = async () => {
    const id = active.id;
    const topic = active.topic.trim();
    patchRun(id, () => ({ subs: null }));
    working(id, 'subs', 'Loading subscriptions…');
    const r = await adminPost('subs', { topic });
    if (!stillOn(id, topic)) return;
    note(id, 'subs', r, r.ok ? plural(r.subs.length, 'subscription') : '');
    if (r.ok) patchRun(id, () => ({ subs: r.subs }));
  };

  const subAction = useArmedConfirm();

  const skipBacklog = async (sub: string) => {
    subAction.disarm();
    const id = active.id;
    const topic = active.topic.trim();
    working(id, 'subs', `Clearing the backlog of ${sub}…`);
    const r = await adminPost('sub-skip', { topic, sub });
    if (!stillOn(id, topic)) return;
    note(id, 'subs', r, `Backlog cleared for ${sub}`);
    if (r.ok) loadSubs();
  };

  const deleteSub = async (sub: string) => {
    subAction.disarm();
    const id = active.id;
    const topic = active.topic.trim();
    working(id, 'subs', `Deleting ${sub}…`);
    const r = await adminPost('sub-delete', { topic, sub });
    if (!stillOn(id, topic)) return;
    note(id, 'subs', r, `Deleted ${sub}`);
    if (r.ok) loadSubs();
  };

  const doPeek = async () => {
    const id = active.id;
    const topic = active.topic.trim();
    patchRun(id, () => ({ peeked: null, peekWarning: '' }));
    working(id, 'peek', 'Peeking…');
    const r = await adminPost('peek', { topic, position: peekPos, count: Number(peekCount) || 5 });
    if (!stillOn(id, topic)) return;
    note(id, 'peek', r, r.ok ? `${plural(r.messages.length, 'message')} peeked, nothing consumed` : '');
    if (r.ok) patchRun(id, () => ({ peeked: r.messages, peekWarning: r.warning ?? '' }));
  };

  const loadStats = async () => {
    const id = active.id;
    const topic = active.topic.trim();
    if (!topic) return;
    patchRun(id, () => ({ stats: undefined }));
    working(id, 'stats', 'Loading stats…');
    const r = await adminPost('stats', { topic });
    if (!stillOn(id, topic)) return;
    note(id, 'stats', r, 'Stats loaded');
    if (r.ok) patchRun(id, () => ({ stats: r.stats }));
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

  const run = runs[active.id] ?? NO_RUN;
  const outcomes = run.outcomes;
  const publishing = !!outcomes.produce?.busy;

  const produce = async () => {
    const id = active.id;
    const topic = active.topic.trim();
    if (!topic || publishing) return;
    working(id, 'produce', 'Publishing…');
    patchRun(id, () => ({ published: undefined }));
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
    })
      .then((x) => x.json())
      .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
    if (!stillOn(id, topic)) return;
    note(id, 'produce', r, r.ok ? (r.messageId ? `Published · id ${r.messageId}` : 'Published · no id in the receipt') : '');
    if (r.ok && r.messageId) patchRun(id, () => ({ published: r.messageId }));
  };
  const secrets = [conn.token, conn.oauth?.clientSecret].filter((s): s is string => !!s);

  // ── tab operations ─────────────────────────────────────────────────────────
  const tabLabel = (t: PTab) => {
    const leaf = t.topic.replace(/\/$/, '').split('/').pop();
    return leaf || 'new';
  };

  const addTab = () => {
    const id = Math.max(0, ...tabs.map((t) => t.id)) + 1;
    setTabs((ts) => [...ts, NEW_TAB(id)]);
    setActiveId(id);
  };

  const dropKey = <V,>(m: Record<number, V>, id: number) => {
    const c = { ...m };
    delete c[id];
    return c;
  };

  const closeTab = (id: number) => {
    if (tabs.length === 1) return;
    esRefs.current.get(id)?.close();
    esRefs.current.delete(id);
    const idx = tabs.findIndex((t) => t.id === id);
    const next = tabs.filter((t) => t.id !== id);
    setTabs(next);
    setFeeds((m) => dropKey(m, id));
    setConsuming((m) => dropKey(m, id));
    setConnState((m) => dropKey(m, id));
    setFeedFilter((m) => dropKey(m, id));
    setRuns((m) => dropKey(m, id));
    setJoinOk((m) => dropKey(m, id));
    if (id === activeId) setActiveId(next[Math.max(0, idx - 1)].id);
  };

  /** Stop tab `id`'s stream and leave its state at `state`. */
  const stopStream = (id: number, state: ConnS) => {
    esRefs.current.get(id)?.close();
    esRefs.current.delete(id);
    setConsuming((m) => ({ ...m, [id]: false }));
    setConnState((m) => ({ ...m, [id]: state }));
  };

  const toggleConsume = (id: number) => {
    if (esRefs.current.get(id)) return stopStream(id, { s: 'idle' });
    const t = tabs.find((x) => x.id === id);
    if (!t) return;
    const sub = t.subscription.trim();
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(conn))));
    // a blank subscription is named by the server (conduit-<time>); a typed one needs the confirmation
    const q = new URLSearchParams({
      conn: b64,
      topic: t.topic,
      subscription: sub,
      type: t.subType,
      position: t.position,
      confirmJoin: sub && joinOk[id] === sub ? '1' : '0',
    });
    const es = new EventSource(`/api/pulsar/consume?${q}`);
    setConnState((m) => ({ ...m, [id]: { s: 'connecting' } }));
    // native open = HTTP stream established (not yet subscribed on broker)
    es.onopen = () => setConnState((m) => ({ ...m, [id]: m[id]?.s === 'live' ? m[id] : { s: 'connecting' } }));
    // server 'ready' = broker subscription actually succeeded → truly listening
    es.addEventListener('ready', (e) => {
      setConnState((m) => ({ ...m, [id]: { s: 'live', msg: (e as MessageEvent).data } }));
    });
    const push = (d: PFeed) => setFeeds((f) => ({ ...f, [id]: [d, ...(f[id] ?? [])].slice(0, 200) }));
    es.addEventListener('message', (e) => {
      let d: PMsg;
      try { d = JSON.parse((e as MessageEvent).data) as PMsg; } catch { return; } // drop malformed frame, keep stream
      push(d);
    });
    // e.g. a failed ack: the stream goes on, the feed says so
    es.addEventListener('warning', (e) => {
      try { push(JSON.parse((e as MessageEvent).data)); } catch { /* malformed frame */ }
    });
    // the broker ended the consumer (topic or subscription removed, unloaded): not an error of ours
    es.addEventListener('close', (e) => {
      stopStream(id, { s: 'idle', msg: (e as MessageEvent).data || 'Disconnected by the broker' });
    });
    // both server-sent 'error' events AND native connection failures land here.
    // Native failures (blocked by IP whitelist / auth / broker down) carry no
    // data → EventSource would silently retry forever, so we stop & flag it.
    es.addEventListener('error', (e) => {
      // the server sends `{error, detail, log}`; a native failure (blocked, broker down) has no data
      const data = (e as MessageEvent).data as string | undefined;
      let failure: { error?: string; detail?: AttemptError; log?: AttemptLog } = {};
      try { if (data) failure = JSON.parse(data); } catch { failure = { error: data }; }
      const msg = failure.error || 'The connection failed before the broker answered: check the service URL, auth and network.';
      stopStream(id, { s: 'error', msg, detail: failure.detail, log: failure.log });
    });
    esRefs.current.set(id, es);
    setConsuming((m) => ({ ...m, [id]: true }));
  };

  // right-column sub-tabs — Consume first (the primary probe action)
  const [rtab, setRtab] = useState<'consume' | 'produce' | 'subs' | 'peek' | 'stats'>('consume');

  const rawFeed = feeds[active.id] ?? [];
  const fq = (feedFilter[active.id] ?? '').trim().toLowerCase();
  // the live filter only hides: every message was received and acked all the same
  const live = active.filter.trim();
  const feed = rawFeed.filter((m) => {
    if (isWarning(m)) return true;
    if (!matchesLiveFilter(m, live)) return false;
    return (
      !fq ||
      m.payload.toLowerCase().includes(fq) ||
      m.messageId.toLowerCase().includes(fq) ||
      (m.key ?? '').toLowerCase().includes(fq) ||
      JSON.stringify(m.properties).toLowerCase().includes(fq)
    );
  });
  const filtering = !!(fq || live);
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
          ? 'Error'
          : csMsg || 'Disconnected';

  const needAdmin = !adminUrl.trim();
  const topicSet = !!active.topic.trim();
  // a typed subscription name joins a real subscription: Connect waits for the confirmation
  const typedSub = active.subscription.trim();
  const joinConfirmed = !!typedSub && joinOk[active.id] === typedSub;
  const connectBlock = !topicSet ? 'Enter a topic first.' : typedSub && !joinConfirmed ? 'Tick the confirmation above first.' : '';
  const statsText = run.stats !== undefined ? JSON.stringify(run.stats, null, 2) : '';
  const subs = run.subs;
  const subExists = subs ? subs.some((x) => x.name === typedSub) : null;
  const joinWhat =
    subExists === true
      ? `joins the existing subscription ${typedSub}`
      : subExists === false
        ? `creates the subscription ${typedSub} on the broker, which stays after this tab disconnects,`
        : `joins the subscription ${typedSub} if it exists, or creates it on the broker,`;
  const peeked = run.peeked;
  const adminHint = needAdmin ? 'Set the Admin URL on the left first.' : !topicSet ? 'Enter a topic first.' : '';

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
        addTitle="New tab with the same connection"
      />

      <div className="layout">
        <div className="left">
          <PanelHead
            title="Pulsar"
            badge="pulsar-rs"
            tagline="Connect to a broker, then consume, publish, peek or inspect a topic. Each tab is its own consumer."
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
            <label className="field-first" htmlFor="pulsar-service-url">Service URL</label>
            <LongField url id="pulsar-service-url" value={conn.serviceUrl} spellCheck={false} placeholder="pulsar://localhost:6650" onChange={(v) => setC('serviceUrl', v)} />
            <div className="hint">
              <code>pulsar://host:6650</code> or <code>pulsar+ssl://host:6651</code>.
            </div>

            <label id="pulsar-auth-label">Auth</label>
            <div className="seg" role="group" aria-labelledby="pulsar-auth-label">
              {(['none', 'token', 'oauth2'] as const).map((t) => (
                <button
                  type="button"
                  key={t}
                  className={conn.authType === t ? 'on' : ''}
                  aria-pressed={conn.authType === t}
                  onClick={() => setC('authType', t)}
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
                <label htmlFor="pulsar-issuer">Issuer URL</label>
                <LongField url id="pulsar-issuer" value={conn.oauth!.issuerUrl} spellCheck={false} onChange={(v) => setC('oauth', { ...conn.oauth!, issuerUrl: v })} />
                <div className="conn-row">
                  <div className="grow">
                    <label htmlFor="pulsar-client-id">Client ID</label>
                    <LongField id="pulsar-client-id" value={conn.oauth!.clientId} spellCheck={false} onChange={(v) => setC('oauth', { ...conn.oauth!, clientId: v })} />
                  </div>
                  <div className="grow">
                    <label htmlFor="pulsar-client-secret">Client secret</label>
                    <input id="pulsar-client-secret" type="password" value={conn.oauth!.clientSecret} onChange={(e) => setC('oauth', { ...conn.oauth!, clientSecret: e.target.value })} />
                  </div>
                </div>
                <label htmlFor="pulsar-audience">Audience</label>
                <LongField id="pulsar-audience" value={conn.oauth!.audience} spellCheck={false} onChange={(v) => setC('oauth', { ...conn.oauth!, audience: v })} />
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
              <button className="btn-secondary" disabled={needAdmin || !!outcomes.admin?.busy} onClick={loadTenants}>
                Load tenants
              </button>
            </div>
            <label id="pulsar-tenant-ns">Tenant / namespace</label>
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
              <button className="btn-secondary" disabled={needAdmin || !!outcomes.admin?.busy} onClick={listTopics}>
                {outcomes.admin?.busy ? 'Listing…' : 'List topics'}
              </button>
            </div>
            {needAdmin && <div className="hint">Enter the Admin URL first.</div>}
            <OutcomeView o={outcomes.admin} secrets={secrets} />
            {topics.length > 0 && (
              <div className="keylist">
                {topics.map((t) => (
                  <button
                    type="button"
                    key={t}
                    className={`keyrow ${t === active.topic ? 'keyrow-active' : ''}`}
                    title="Use this topic in the current tab"
                    aria-pressed={t === active.topic}
                    onClick={() => editConsumeField('topic', t)}
                  >
                    <span className="kname" title={t}>{t}</span>
                  </button>
                ))}
              </div>
            )}
          </Section>
        </div>

        <div className="right">
          <label className="field-first" htmlFor="pulsar-topic">
            Topic <span className="count">(this tab)</span>
          </label>
          <LongField
            url
            id="pulsar-topic"
            suggestions={topics}
            value={active.topic}
            spellCheck={false}
            onChange={(v) => editConsumeField('topic', v)}
            placeholder="persistent://public/default/my-topic"
          />

          <div className="tabs mt-4" role="tablist" aria-label="Pulsar view">
            {(
              [
                ['consume', 'Consume'],
                ['produce', 'Publish'],
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
            <label className="field-first" htmlFor="pulsar-payload">Payload</label>
            <textarea
              id="pulsar-payload"
              rows={7}
              value={active.payload}
              spellCheck={false}
              placeholder='{"event":"order-created"}'
              onChange={(e) => setA('payload', e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  produce();
                }
              }}
            />
            <div className="hint">JSON or plain text.</div>
            <label htmlFor="pulsar-props">Properties</label>
            <textarea id="pulsar-props" rows={2} value={active.props} spellCheck={false} placeholder="source: conduit" onChange={(e) => setA('props', e.target.value)} />
            <div className="hint">
              Per-message metadata, one <code>name: value</code> per line.
            </div>
            <div className="conn-row">
              <div className="grow">
                <label htmlFor="pulsar-key">Key</label>
                <LongField id="pulsar-key" value={active.key} spellCheck={false} placeholder="order-123" onChange={(v) => setA('key', v)} />
              </div>
              <div className="w-md">
                <label htmlFor="pulsar-delay">Deliver after (ms)</label>
                <input id="pulsar-delay" value={active.delayMs} inputMode="numeric" placeholder="blank = now" onChange={(e) => setA('delayMs', e.target.value)} />
              </div>
            </div>
            <div className="hint">
              Key routes the message and orders Key_Shared consumers.
              {Number(active.delayMs) > 0 && ' Delayed messages are only honoured by Shared and Key_Shared subscriptions.'}
            </div>
            <div className="inline mt-3">
              <button className="btn-primary" disabled={!topicSet || publishing} onClick={produce}>
                {publishing ? 'Publishing…' : 'Publish'}
              </button>
              <span className="hint m-0">
                {topicSet ? (
                  <>
                    <kbd>{SEND_KEY}</kbd> in the payload also publishes
                  </>
                ) : (
                  'Enter a topic first.'
                )}
              </span>
            </div>
            <OutcomeView o={outcomes.produce} secrets={secrets} />
            {run.published && outcomes.produce?.ok && !outcomes.produce.busy && (
              <div className="result-bar">
                <span className="spacer" />
                <CopyButton text={run.published} label="Copy message ID" />
              </div>
            )}
          </div>

          <div hidden={rtab !== 'subs'}>
            <div className="inline">
              <button className="btn-secondary" disabled={!!adminHint || !!outcomes.subs?.busy} onClick={loadSubs}>
                Load subscriptions
              </button>
              <span className="hint m-0">{adminHint || 'Who consumes this topic, and how far behind they are.'}</span>
            </div>
            <OutcomeView o={outcomes.subs} secrets={secrets} />
            {subs && subs.length === 0 && (
              <Empty
                className="mt-3"
                compact
                title="No subscriptions yet"
                hint={
                  <>
                    Nothing is subscribed to this topic. Press <kbd>Connect</kbd> on the Consume tab, then load again.
                  </>
                }
              />
            )}
            {!subs && !outcomes.subs?.busy && (
              <Empty
                className="mt-3"
                compact
                title="No subscriptions loaded yet"
                hint={
                  <>
                    Press <kbd>Load subscriptions</kbd> to see consumers and backlog.
                  </>
                }
              />
            )}
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
                            title={`Skip the whole backlog (${plural(s.backlog, 'message')}) for ${s.name}: those messages are never delivered to it`}
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
                            title={`Delete subscription ${s.name}; fails if consumers are still connected`}
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
              <select className="w-sm" value={peekPos} aria-label="Peek from" onChange={(e) => setPeekPos(e.target.value as 'latest' | 'earliest')} title="Read from the newest or the oldest end">
                <option value="latest">latest</option>
                <option value="earliest">earliest</option>
              </select>
              <input className="w-xs" value={peekCount} inputMode="numeric" aria-label="How many messages to peek" title="How many messages to read (max 20)" onChange={(e) => setPeekCount(e.target.value)} />
              <button className="btn-secondary" disabled={!!adminHint || !!outcomes.peek?.busy} onClick={doPeek}>
                {outcomes.peek?.busy ? 'Peeking…' : 'Peek'}
              </button>
              <span className="hint grow">{adminHint || 'Reads without consuming: nothing is acked and no subscription is touched.'}</span>
            </div>
            <OutcomeView o={outcomes.peek} secrets={secrets} />
            {run.peekWarning && <div className="text-warn break mt-2">{run.peekWarning}</div>}
            {!peeked && !outcomes.peek?.busy && (
              <Empty
                className="mt-3"
                compact
                title="No messages peeked yet"
                hint={
                  <>
                    Choose an end of the topic and press <kbd>Peek</kbd>.
                  </>
                }
              />
            )}
            {peeked && peeked.length === 0 && (
              <Empty
                className="mt-3"
                compact
                title="No messages yet"
                hint={
                  <>
                    No messages are retained on this topic. Press <kbd>Publish</kbd> on the Publish tab, then peek again.
                  </>
                }
              />
            )}
            {peeked && peeked.length > 0 && (
              <>
                <div className="feed-head">
                  <span className="count">{plural(peeked.length, 'message')} peeked</span>
                  <span className="spacer" />
                  <button className="btn-ghost btn-sm" title="Save the peeked messages as a JSON file" onClick={() => downloadJson('pulsar', 'peek', peeked)}>
                    Export JSON
                  </button>
                </div>
                <div className="feed">
                  {peeked.map((m) => (
                    <FeedRow
                      key={m.pos}
                      channel={`#${m.pos} from ${peekPos}${m.messageId ? ` · ${m.messageId}` : ''}${m.batchSize ? ` · batch of ${m.batchSize}` : ''}`}
                      at={m.publishTime ?? undefined}
                      text={m.payload}
                      pretty={m.payloadEncoding !== 'base64'}
                      meta={msgMeta(m)}
                      copy
                    />
                  ))}
                </div>
              </>
            )}
          </div>

          <div hidden={rtab !== 'consume'}>
            <div className="row">
              <LongField
                className="grow"
                placeholder="subscription (blank = new, unique)"
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
                className={isConsuming && cs !== 'connecting' ? 'btn-secondary btn-on' : 'btn-primary'}
                disabled={cs === 'connecting' || (!isConsuming && !!connectBlock)}
                title={!isConsuming ? connectBlock || undefined : undefined}
                onClick={() => toggleConsume(active.id)}
              >
                {cs === 'connecting' ? 'Connecting…' : isConsuming ? 'Disconnect' : 'Connect'}
              </button>
              {cs === 'connecting' && (
                <button className="btn-ghost btn-sm" title="Stop connecting" onClick={() => toggleConsume(active.id)}>
                  Cancel
                </button>
              )}
            </div>
            {typedSub && (
              <div className="mt-2">
                <div className="hint text-warn m-0">
                  This tab {joinWhat} and every message it receives is acked. With {active.subType === 'KeyShared' ? 'Key_Shared' : active.subType}
                  {active.subType === 'Exclusive'
                    ? ' it fails if a consumer is already attached; if none is, the messages it acks are gone from that subscription for good.'
                    : ', the broker splits messages between this tab and the live consumers: what this tab takes, they never get.'}
                </div>
                <label className="check" htmlFor="pulsar-join-ok">
                  <input
                    id="pulsar-join-ok"
                    type="checkbox"
                    checked={joinConfirmed}
                    onChange={(e) => {
                      if (esRefs.current.get(active.id)) toggleConsume(active.id);
                      setJoinOk((m) => ({ ...m, [active.id]: e.target.checked ? typedSub : '' }));
                    }}
                  />
                  I understand this {joinWhat.replace(/,$/, '')} and acks the messages it receives
                </label>
              </div>
            )}
            <input
              className="mt-2"
              placeholder="Live filter: only show messages containing this (blank = all)"
              aria-label="Live filter"
              value={active.filter}
              spellCheck={false}
              onChange={(e) => setA('filter', e.target.value)}
            />
            <div className="inline mt-2">
              <ConnPill state={cs} text={connText} />
              <span className="hint m-0">
                {!isConsuming && connectBlock
                  ? connectBlock
                  : live
                    ? `Filtering on "${live}": only what is shown changes. Every message is still received and acked.`
                    : 'Other tabs keep streaming in the background.'}
              </span>
            </div>
            {cs === 'error' && (
              <OutcomeView
                o={{ ok: false, text: csMsg, detail: connState[active.id]?.detail, log: connState[active.id]?.log }}
                secrets={secrets}
              />
            )}
            {rawFeed.length === 0 && (
              <Empty
                className="mt-3"
                icon="⇣"
                title="No messages yet"
                hint={
                  cs === 'live' ? (
                    <>
                      Connected. Messages published to this topic appear here; press <kbd>Publish</kbd> on the Publish tab to
                      check the path end to end.
                    </>
                  ) : (
                    <>
                      Set a topic such as <code>persistent://public/default/my-topic</code> and press <kbd>Connect</kbd>.
                    </>
                  )
                }
              />
            )}
            {rawFeed.length > 0 && (
              <>
                <div className="feed-head">
                  <span className="count">
                    {filtering ? `${feed.length} / ${rawFeed.length} messages` : plural(rawFeed.length, 'message')}
                  </span>
                  <input
                    className="grow"
                    placeholder="Filter messages"
                    aria-label="Filter messages"
                    value={feedFilter[active.id] ?? ''}
                    spellCheck={false}
                    onChange={(e) => setFeedFilter((f) => ({ ...f, [active.id]: e.target.value }))}
                  />
                  <span className="spacer" />
                  <button
                    className="btn-ghost btn-sm"
                    title="Save the messages shown (with the filters applied) as a JSON file"
                    onClick={() => downloadJson('pulsar', 'feed', feed)}
                  >
                    Export JSON
                  </button>
                  <button
                    className="btn-ghost btn-sm"
                    title="Discard the messages received so far"
                    onClick={() => setFeeds((f) => ({ ...f, [active.id]: [] }))}
                  >
                    Clear
                  </button>
                </div>
                <div className="feed">
                  {feed.map((m, i) =>
                    isWarning(m) ? (
                      <FeedRow
                        key={`w|${m.at}|${i}`}
                        channel={<span className="text-warn">warning</span>}
                        at={m.at}
                        text={m.warning}
                        tone="ws-sys"
                        pretty={false}
                      />
                    ) : (
                      <FeedRow
                        key={`${m.at}|${m.topic ?? ''}|${m.messageId}`}
                        channel={m.topic && m.topic !== active.topic.trim() ? `${m.messageId} · ${m.topic}` : m.messageId}
                        at={m.at}
                        text={m.payload}
                        pretty={m.payloadEncoding !== 'base64'}
                        meta={msgMeta(m)}
                        copy
                      />
                    ),
                  )}
                </div>
              </>
            )}
          </div>

          <div hidden={rtab !== 'stats'}>
            <div className="inline">
              <button className="btn-secondary" disabled={!!adminHint || !!outcomes.stats?.busy} onClick={loadStats}>
                Load stats
              </button>
              <span className="hint m-0">{adminHint || 'Rates, backlog and subscriptions for this topic.'}</span>
              {statsText && (
                <button className="btn-ghost btn-sm spacer" title="Discard the loaded stats" onClick={() => patchRun(active.id, () => ({ stats: undefined }))}>
                  Clear
                </button>
              )}
            </div>
            <OutcomeView o={outcomes.stats} secrets={secrets} />
            {!statsText && !outcomes.stats?.busy && (
              <Empty
                className="mt-3"
                compact
                title="No stats yet"
                hint={
                  <>
                    Press <kbd>Load stats</kbd> for throughput and backlog counters.
                  </>
                }
              />
            )}
            {statsText && (
              <>
                <div className="result-bar">
                  <span className="spacer" />
                  <CopyButton text={statsText} label="Copy stats" />
                  <button className="btn-ghost btn-sm" title="Save the stats as a JSON file" onClick={() => downloadJson('pulsar', 'stats', run.stats)}>
                    Export JSON
                  </button>
                </div>
                <pre className="mt-2">{statsText}</pre>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
