import { useEffect, useRef, useState } from 'react';
import { useFlash } from './useFlash';
import { SaveAs } from './SaveAs';
import { ConnPill, Empty, FeedRow, LongField, PanelHead, ReqTabs, Section, persistLater } from './ui';
import { Outcome, OutcomeView } from './AttemptLog';
import { downloadJson } from './share';
import type { AttemptError, AttemptLog } from './types';

const SEND_KEY = navigator.platform.includes('Mac') ? '⌘↵' : 'Ctrl↵';
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

const LS_CONN = 'conduit.kafka.conn.v1';
const LS_CONNS = 'conduit.kafka.conns.v1';
const LS_TABS = 'conduit.kafka.tabs.v1';

// shared connection (all tabs use it — like the Pulsar panel)
const SASL_MECHANISMS = ['PLAIN', 'SCRAM-SHA-256', 'SCRAM-SHA-512'] as const;
type SaslMechanism = (typeof SASL_MECHANISMS)[number];
interface KConn {
  brokers: string;
  ssl: boolean;
  sslCaLocation: string;
  sslCertLocation: string;
  sslKeyLocation: string;
  sslSkipVerify: boolean;
  saslUser: string;
  saslPass: string;
  saslMechanism: SaslMechanism;
}
const CONN_DEFAULT: KConn = {
  brokers: 'localhost:9092',
  ssl: false,
  sslCaLocation: '',
  sslCertLocation: '',
  sslKeyLocation: '',
  sslSkipVerify: false,
  saslUser: '',
  saslPass: '',
  saslMechanism: 'PLAIN',
};
const LS_TOPICS = 'conduit.kafka.topics.v1';

function loadTopics(brokers: string): string[] {
  try {
    const all = JSON.parse(localStorage.getItem(LS_TOPICS) ?? '{}');
    const list = all?.[brokers.trim()];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveTopics(brokers: string, topics: string[]) {
  let all: Record<string, string[]> = {};
  try {
    all = JSON.parse(localStorage.getItem(LS_TOPICS) ?? '{}') || {};
  } catch {
    /* start over */
  }
  all[brokers.trim()] = topics;
  localStorage.setItem(LS_TOPICS, JSON.stringify(all));
}

/** The consumer's own retry of IPv6 localhost when the broker listens on IPv4 only. */
function isLoopbackV6Noise(w: string): boolean {
  return /BrokerTransportFailure/i.test(w) && /\[::1\]|(^|[^:])::1([^:\d]|$)/.test(w);
}

interface SavedConn extends KConn {
  name: string;
}

// per-tab: an independent consumer + producer against one topic
interface KTab {
  id: number;
  topic: string;
  group: string;
  fromBeginning: boolean;
  key: string;
  headers: string;
  value: string;
}
const NEW_TAB = (id: number, over: Partial<KTab> = {}): KTab => ({
  id,
  topic: '',
  group: '',
  fromBeginning: false,
  key: '',
  headers: '',
  value: '',
  ...over,
});

interface Msg {
  at: string;
  partition: number;
  offset: number;
  /** ms since the epoch, and whether the producer (create) or the broker (logAppend) set it */
  timestamp?: number | null;
  timestampType?: 'create' | 'logAppend' | null;
  /** null: the record has no key; '' : an empty key */
  key: string | null;
  keyEncoding?: 'utf8' | 'base64' | null;
  keyNote?: string | null;
  headers?: Record<string, string>;
  payload: string | null;
  payloadEncoding?: 'utf8' | 'base64' | null;
  payloadNote?: string | null;
}
/** A line in the live feed: a record, or a warning the consumer reported and carried on from. */
type KFeed = Msg | { at: string; warning: string };
const isWarning = (m: KFeed): m is { at: string; warning: string } => 'warning' in m;
type ConnS = { s: 'idle' | 'connecting' | 'live' | 'error'; msg?: string; detail?: AttemptError; log?: AttemptLog };
/** A tab's operation outcomes (memory only): never shown on another tab. */
type TabOutcomes = Partial<Record<'topics' | 'produce', Outcome>>;

/** How a record reads in the feed header: where it is, and its key (absent and empty differ). */
function recordChannel(m: Msg): string {
  const key = m.key === null ? 'no key' : m.key === '' ? 'key ""' : `key ${m.keyEncoding === 'base64' ? `(base64) ${m.key}` : m.key}`;
  return `p${m.partition} · offset ${m.offset} · ${key}`;
}

/** The metadata line under a record: its timestamp, headers, and any note about binary bytes. */
function recordMeta(m: Msg): string | undefined {
  const parts: string[] = [];
  if (m.timestamp != null) {
    parts.push(`${m.timestampType === 'logAppend' ? 'log-append time' : 'create time'} ${new Date(m.timestamp).toISOString()}`);
  }
  if (m.headers && Object.keys(m.headers).length) {
    parts.push(Object.entries(m.headers).map(([k, v]) => `${k}: ${v}`).join('  ·  '));
  }
  if (m.keyNote) parts.push(`key ${m.keyNote}`);
  if (m.payloadNote) parts.push(`value ${m.payloadNote}`);
  if (m.payload === null) parts.push('value is null (a tombstone)');
  return parts.length ? parts.join('  ·  ') : undefined;
}

/** The server's error event: a JSON failure (with detail and log) or a plain message. */
function parseStreamError(data: string | undefined): { msg?: string; detail?: AttemptError; log?: AttemptLog } {
  if (!data) return {};
  try {
    const v = JSON.parse(data);
    if (v && typeof v === 'object' && typeof v.error === 'string') return { msg: v.error, detail: v.detail, log: v.log };
  } catch {
    /* plain text */
  }
  return { msg: data };
}

function parseHeaders(text: string): Record<string, string> {
  const h: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) h[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return h;
}
function loadJson<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback;
  } catch {
    return fallback;
  }
}
function loadTabs(): { tabs: KTab[]; activeId: number } {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_TABS) ?? 'null');
    if (raw && Array.isArray(raw.tabs) && raw.tabs.length) {
      const tabs: KTab[] = raw.tabs.map((t: any, i: number) => NEW_TAB(t.id ?? i + 1, t));
      const activeId = tabs.some((t) => t.id === raw.activeId) ? raw.activeId : tabs[0].id;
      return { tabs, activeId };
    }
  } catch {
    /* fall through */
  }
  return { tabs: [NEW_TAB(1)], activeId: 1 };
}

export default function KafkaPanel() {
  const [conn, setConnState_] = useState<KConn>(() => ({ ...CONN_DEFAULT, ...loadJson(LS_CONN, {}) }));
  const [conns, setConns] = useState<SavedConn[]>(() => loadJson(LS_CONNS, []));
  const [picked, setPicked] = useState('');
  const [topics, setTopics] = useState<string[]>(() => loadTopics(loadJson<Partial<KConn>>(LS_CONN, {}).brokers ?? CONN_DEFAULT.brokers));
  const [outcomes, setOutcomes] = useState<Record<number, TabOutcomes>>({});
  const [rtab, setRtab] = useState<'consume' | 'produce'>('consume');

  const init = useRef<{ tabs: KTab[]; activeId: number } | null>(null);
  if (!init.current) init.current = loadTabs();
  const [tabs, setTabs] = useState<KTab[]>(init.current.tabs);
  const [activeId, setActiveId] = useState<number>(init.current.activeId);
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];
  // the latest tabs, for a call that finishes after its tab moved to another topic
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  // per-tab runtime (memory only)
  const [feeds, setFeeds] = useState<Record<number, KFeed[]>>({});
  const [feedFilter, setFeedFilter] = useState<Record<number, string>>({});
  const [consuming, setConsuming] = useState<Record<number, boolean>>({});
  const [connMap, setConnMap] = useState<Record<number, ConnS>>({});
  // per tab: the named group whose offsets may be committed (valid only while the name is unchanged;
  // a throwaway group always commits)
  const [commit, setCommit] = useState<Record<number, string>>({});
  const esRefs = useRef<Map<number, EventSource>>(new Map());

  const setConn = <K extends keyof KConn>(k: K, v: KConn[K]) => setConnState_((c) => ({ ...c, [k]: v }));
  const setActive = (fn: (t: KTab) => KTab) =>
    setTabs((ts) => ts.map((t) => (t.id === active.id ? fn(t) : t)));
  const setA = <K extends keyof KTab>(k: K, v: KTab[K]) => setActive((t) => ({ ...t, [k]: v }));
  // editing a consume param while live → stop so a stale consumer can't run on
  const editConsumeField = <K extends keyof KTab>(k: K, v: KTab[K]) => {
    if (esRefs.current.get(active.id)) toggleConsume(active.id);
    // a publish result for the old topic does not describe the new one
    if (k === 'topic' && v !== active.topic) setOutcome(active.id, 'produce', undefined);
    setA(k, v);
  };
  const setOutcome = (id: number, op: keyof TabOutcomes, o: Outcome | undefined) =>
    setOutcomes((m) => ({ ...m, [id]: { ...m[id], [op]: o } }));
  /** The outcome of a call: `done` on success, the server's failure otherwise. */
  const settle = (
    r: { ok?: boolean; error?: string; durationMs?: number; detail?: AttemptError; log?: AttemptLog },
    done: string,
  ): Outcome => ({ ok: !!r.ok, text: r.ok ? done : r.error, ms: r.durationMs, detail: r.detail, log: r.log });

  useEffect(() => persistLater(LS_CONN, () => JSON.stringify(conn)), [conn]);
  const firstBrokers = useRef(true);
  useEffect(() => {
    if (firstBrokers.current) {
      firstBrokers.current = false;
      return;
    }
    setTopics(loadTopics(conn.brokers));
  }, [conn.brokers]);
  useEffect(() => persistLater(LS_TABS, () => JSON.stringify({ tabs, activeId })), [tabs, activeId]);
  useEffect(() => () => esRefs.current.forEach((es) => es.close()), []);

  const persistConns = (next: SavedConn[]) => {
    setConns(next);
    localStorage.setItem(LS_CONNS, JSON.stringify(next));
  };

  const [flashMsg, flash] = useFlash();

  const cfg = () => ({
    brokers: conn.brokers.trim(),
    ssl: conn.ssl,
    sslCaLocation: conn.ssl ? conn.sslCaLocation.trim() : '',
    sslCertLocation: conn.ssl ? conn.sslCertLocation.trim() : '',
    sslKeyLocation: conn.ssl ? conn.sslKeyLocation.trim() : '',
    sslSkipVerify: conn.ssl && conn.sslSkipVerify,
    saslUser: conn.saslUser,
    saslPass: conn.saslPass,
    saslMechanism: conn.saslMechanism,
  });
  const secrets = conn.saslPass ? [conn.saslPass] : [];

  const tabOutcomes = outcomes[active.id] ?? {};
  const listing = !!tabOutcomes.topics?.busy;
  const publishing = !!tabOutcomes.produce?.busy;
  const brokersSet = !!conn.brokers.trim();

  const aborts = useRef<Record<string, AbortController>>({});
  const cancelOp = (id: number, op: keyof TabOutcomes) => aborts.current[`${id}|${op}`]?.abort();
  // never rejects: a network or non-JSON failure comes back as { ok:false, error }
  const post = (path: string, body: unknown, signal?: AbortSignal) =>
    fetch(`/api/kafka/${path}`, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then((x) => x.json())
      .catch((e) =>
        signal?.aborted ? { ok: false, cancelled: true, error: 'Cancelled' } : { ok: false, error: String(e?.message ?? e) },
      );
  const startOp = (id: number, op: keyof TabOutcomes) => {
    const ctl = new AbortController();
    aborts.current[`${id}|${op}`] = ctl;
    return ctl;
  };
  const endOp = (id: number, op: keyof TabOutcomes, r: { cancelled?: boolean }) => {
    delete aborts.current[`${id}|${op}`];
    if (r.cancelled) setOutcome(id, op, { ok: false, text: 'Cancelled: the answer was not waited for.' });
    return !!r.cancelled;
  };

  const listTopics = async () => {
    const id = active.id;
    if (listing || !brokersSet) return;
    const brokers = conn.brokers;
    setOutcome(id, 'topics', { ok: true, busy: true, text: `Listing topics on ${brokers.trim()}…` });
    const ctl = startOp(id, 'topics');
    const r = await post('topics', cfg(), ctl.signal);
    if (endOp(id, 'topics', r)) return;
    setOutcome(id, 'topics', settle(r, r.ok ? plural(r.topics.length, 'topic') : ''));
    if (r.ok) {
      setTopics(r.topics);
      saveTopics(brokers, r.topics);
    }
  };

  const produce = async () => {
    const id = active.id;
    const topic = active.topic.trim();
    if (!topic || publishing) return;
    setOutcome(id, 'produce', { ok: true, busy: true, text: `Publishing to ${topic}…` });
    const ctl = startOp(id, 'produce');
    const r = await post(
      'produce',
      {
        ...cfg(),
        topic,
        key: active.key,
        headers: parseHeaders(active.headers),
        value: active.value,
      },
      ctl.signal,
    );
    if (endOp(id, 'produce', r)) return;
    // the tab moved to another topic meanwhile: this result is not about it
    if (tabsRef.current.find((t) => t.id === id)?.topic.trim() !== topic) return;
    setOutcome(id, 'produce', settle(r, r.ok ? `Published · partition ${r.result.partition} · offset ${r.result.offset}` : ''));
  };

  const toggleConsume = (id: number) => {
    const existing = esRefs.current.get(id);
    if (existing) {
      existing.close();
      esRefs.current.delete(id);
      setConsuming((m) => ({ ...m, [id]: false }));
      setConnMap((m) => ({ ...m, [id]: { s: 'idle' } }));
      return;
    }
    const t = tabs.find((x) => x.id === id);
    if (!t || !t.topic.trim()) return;
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(cfg()))));
    // a named group commits offsets only when ticked; a blank one is a throwaway the server names
    const q = new URLSearchParams({
      cfg: b64,
      topic: t.topic.trim(),
      group: t.group.trim(),
      fromBeginning: t.fromBeginning ? '1' : '0',
      commit: t.group.trim() && commit[id] === t.group.trim() ? '1' : '0',
    });
    const es = new EventSource(`/api/kafka/consume?${q}`);
    setConnMap((m) => ({ ...m, [id]: { s: 'connecting' } }));
    es.onopen = () => setConnMap((m) => ({ ...m, [id]: m[id]?.s === 'live' ? m[id] : { s: 'connecting' } }));
    es.addEventListener('ready', (e) => {
      const msg = (e as MessageEvent).data;
      setConnMap((m) => ({ ...m, [id]: { s: 'live', msg } }));
    });
    const push = (d: KFeed) => setFeeds((f) => ({ ...f, [id]: [d, ...(f[id] ?? [])].slice(0, 200) }));
    es.addEventListener('message', (e) => {
      let d: Msg;
      try { d = JSON.parse((e as MessageEvent).data) as Msg; } catch { return; } // drop malformed frame, keep stream
      push(d);
    });
    // the consumer hit an error it recovers from by itself: say so and keep streaming
    es.addEventListener('warning', (e) => {
      try { push(JSON.parse((e as MessageEvent).data)); } catch { /* malformed frame */ }
    });
    es.addEventListener('error', (e) => {
      const parsed = parseStreamError((e as MessageEvent).data);
      const msg = parsed.msg || 'The connection failed before the brokers answered: check the brokers, SASL and SSL settings.';
      setConnMap((m) => ({ ...m, [id]: { s: 'error', msg, detail: parsed.detail, log: parsed.log } }));
      es.close();
      esRefs.current.delete(id);
      setConsuming((m) => ({ ...m, [id]: false }));
    });
    esRefs.current.set(id, es);
    setConsuming((m) => ({ ...m, [id]: true }));
  };

  // ── tabs ─────────────────────────────────────────────────────────────────
  const tabLabel = (t: KTab) => t.topic.trim() || 'new';
  const addTab = () => {
    const id = Math.max(0, ...tabs.map((t) => t.id)) + 1;
    setTabs((ts) => [...ts, NEW_TAB(id)]);
    setActiveId(id);
  };
  const closeTab = (id: number) => {
    if (tabs.length === 1) return;
    esRefs.current.get(id)?.close();
    esRefs.current.delete(id);
    const idx = tabs.findIndex((t) => t.id === id);
    const next = tabs.filter((t) => t.id !== id);
    setTabs(next);
    setFeeds((m) => { const c = { ...m }; delete c[id]; return c; });
    setFeedFilter((m) => { const c = { ...m }; delete c[id]; return c; });
    setConsuming((m) => { const c = { ...m }; delete c[id]; return c; });
    setConnMap((m) => { const c = { ...m }; delete c[id]; return c; });
    setOutcomes((m) => { const c = { ...m }; delete c[id]; return c; });
    setCommit((m) => { const c = { ...m }; delete c[id]; return c; });
    if (id === activeId) setActiveId(next[Math.max(0, idx - 1)].id);
  };

  const isConsuming = !!consuming[active.id];
  const cs = connMap[active.id]?.s ?? 'idle';
  // one wording for connection state across every streaming panel
  const csMsg = connMap[active.id]?.msg;
  const connText =
    cs === 'live'
      ? `Connected${csMsg ? ` · ${csMsg}` : ''}`
      : cs === 'connecting'
        ? 'Connecting…'
        : cs === 'error'
          ? 'Error'
          : 'Disconnected';
  const allFeed = feeds[active.id] ?? [];
  const rawFeed = allFeed.filter((m) => !(isWarning(m) && isLoopbackV6Noise(m.warning)));
  const hiddenNoise = allFeed.length - rawFeed.length;
  const recordCount = rawFeed.filter((m) => !isWarning(m)).length;
  const fq = (feedFilter[active.id] ?? '').trim().toLowerCase();
  const shownFeed = fq
    ? rawFeed.filter(
        (m) =>
          isWarning(m) ||
          (m.payload ?? '').toLowerCase().includes(fq) ||
          (m.key ?? '').toLowerCase().includes(fq) ||
          JSON.stringify(m.headers ?? {}).toLowerCase().includes(fq),
      )
    : rawFeed;
  const typedGroup = active.group.trim();
  const commits = !!typedGroup && commit[active.id] === typedGroup;
  const connectBlock = !brokersSet ? 'Enter at least one broker first.' : !active.topic.trim() ? 'Enter a topic first.' : '';

  return (
    <div className="grpc-wrap">
      <ReqTabs
        tabs={tabs}
        activeId={activeId}
        ariaLabel="Kafka tabs"
        label={tabLabel}
        title={(t) => t.topic}
        state={(t) => {
          const s = connMap[t.id]?.s;
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
            title="Kafka"
            badge="rdkafka"
            tagline="Connect to brokers, pick a topic, then consume live or publish a record. Each tab is its own consumer."
          />

          <div className="saved-bar">
            <select
              value={picked}
              aria-label="Saved connections"
              onChange={(e) => {
                setPicked(e.target.value);
                const c = conns.find((x) => x.name === e.target.value);
                if (c) {
                  const { name: _name, ...saved } = c;
                  setConnState_({ ...CONN_DEFAULT, ...saved });
                }
              }}
            >
              <option value="">{conns.length ? 'Open a saved connection…' : 'No saved connections yet'}</option>
              {conns.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
            <SaveAs
              canSave={() => (conn.brokers.trim() ? null : 'Enter at least one broker first')}
              onSave={(name) => {
                persistConns([...conns.filter((c) => c.name !== name), { name, ...cfg() }]);
                setPicked(name);
                return `Saved "${name}"`;
              }}
              onMessage={flash}
            />
            <button
              className="btn-secondary btn-danger"
              disabled={!picked}
              onClick={() => {
                persistConns(conns.filter((c) => c.name !== picked));
                setPicked('');
              }}
            >
              Delete
            </button>
          </div>
          {flashMsg && <div className="toast">{flashMsg}</div>}

          <Section title="Connection" hint="Shared by every tab in this panel.">
            <label className="field-first" htmlFor="kafka-brokers">Brokers</label>
            <div className="row row-tight">
              <LongField
                url
                id="kafka-brokers"
                className="grow"
                value={conn.brokers}
                spellCheck={false}
                placeholder="localhost:9092"
                onChange={(v) => setConn('brokers', v)}
              />
              {listing ? (
                <button className="btn-secondary" title="Stop waiting for the topic list" onClick={() => cancelOp(active.id, 'topics')}>
                  Cancel
                </button>
              ) : (
                <button className="btn-secondary" disabled={!brokersSet} onClick={listTopics}>
                  List topics
                </button>
              )}
            </div>
            <div className="hint">
              One or more <code>host:port</code>, comma-separated.
            </div>
            <div className="conn-row">
              <div className="grow">
                <label htmlFor="kafka-sasl-user">SASL user</label>
                <input id="kafka-sasl-user" placeholder="optional" value={conn.saslUser} onChange={(e) => setConn('saslUser', e.target.value)} />
              </div>
              <div className="grow">
                <label htmlFor="kafka-sasl-pass">SASL password</label>
                <input id="kafka-sasl-pass" type="password" placeholder="optional" value={conn.saslPass} onChange={(e) => setConn('saslPass', e.target.value)} />
              </div>
              <div>
                <label htmlFor="kafka-sasl-mech">Mechanism</label>
                <select
                  id="kafka-sasl-mech"
                  value={conn.saslMechanism}
                  title="Used when a SASL user and password are set"
                  onChange={(e) => setConn('saslMechanism', e.target.value as SaslMechanism)}
                >
                  {SASL_MECHANISMS.map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </select>
              </div>
              <label className="check" title="Connect to the brokers over SSL">
                <input type="checkbox" checked={conn.ssl} onChange={(e) => setConn('ssl', e.target.checked)} />
                SSL
              </label>
            </div>
            {conn.ssl && (
              <div className="refl-box">
                <label className="field-first" htmlFor="kafka-ssl-ca">CA certificate file</label>
                <LongField
                  id="kafka-ssl-ca"
                  value={conn.sslCaLocation}
                  spellCheck={false}
                  placeholder="blank: this machine's CA bundle"
                  onChange={(v) => setConn('sslCaLocation', v)}
                />
                <div className="conn-row">
                  <div className="grow">
                    <label htmlFor="kafka-ssl-cert">Client certificate file</label>
                    <LongField
                      id="kafka-ssl-cert"
                      value={conn.sslCertLocation}
                      spellCheck={false}
                      placeholder="optional, for mTLS"
                      onChange={(v) => setConn('sslCertLocation', v)}
                    />
                  </div>
                  <div className="grow">
                    <label htmlFor="kafka-ssl-key">Client key file</label>
                    <LongField
                      id="kafka-ssl-key"
                      value={conn.sslKeyLocation}
                      spellCheck={false}
                      placeholder="optional, for mTLS"
                      onChange={(v) => setConn('sslKeyLocation', v)}
                    />
                  </div>
                </div>
                <div className="hint">PEM files on the machine running Conduit.</div>
                <label className="check mt-2">
                  <input
                    type="checkbox"
                    checked={conn.sslSkipVerify}
                    onChange={(e) => setConn('sslSkipVerify', e.target.checked)}
                  />
                  Skip certificate verification (insecure)
                </label>
                {conn.sslSkipVerify && (
                  <div className="hint text-warn">
                    Any certificate is accepted, so a machine in the middle can read and change the traffic. Use it only
                    against a test broker.
                  </div>
                )}
              </div>
            )}
            <OutcomeView o={tabOutcomes.topics} secrets={secrets} />
          </Section>

          <Section
            title={
              <>
                Topics {topics.length > 0 && <span className="count">({topics.length})</span>}
              </>
            }
          >
            {topics.length > 0 ? (
              <div className="keylist">
                {topics.map((t) => (
                  <button
                    type="button"
                    key={t}
                    className={`keyrow ${t === active.topic ? 'keyrow-active' : ''}`}
                    aria-pressed={t === active.topic}
                    onClick={() => editConsumeField('topic', t)}
                    title="Use this topic in the current tab"
                  >
                    <span className="kname" title={t}>{t}</span>
                  </button>
                ))}
              </div>
            ) : (
              <Empty
                compact
                title="No topics yet"
                hint={
                  <>
                    Press <kbd>List topics</kbd>, then click one to use it in this tab.
                  </>
                }
              />
            )}
          </Section>
        </div>

        <div className="right">
          <label className="field-first" htmlFor="kafka-topic">
            Topic <span className="count">(this tab)</span>
          </label>
          <LongField
            url
            id="kafka-topic"
            suggestions={topics}
            value={active.topic}
            spellCheck={false}
            placeholder="orders"
            onChange={(v) => editConsumeField('topic', v)}
          />

          <div className="tabs mt-4" role="tablist" aria-label="Direction">
            <button
              type="button"
              className={rtab === 'consume' ? 'tab active' : 'tab'}
              role="tab"
              aria-selected={rtab === 'consume'}
              onClick={() => setRtab('consume')}
            >
              Consume {isConsuming && <span className="dot live" />}
            </button>
            <button
              type="button"
              className={rtab === 'produce' ? 'tab active' : 'tab'}
              role="tab"
              aria-selected={rtab === 'produce'}
              onClick={() => setRtab('produce')}
            >
              Publish
            </button>
          </div>

          <div hidden={rtab !== 'produce'}>
            <div className="conn-row mt-0">
              <div className="grow">
                <label className="field-first" htmlFor="kafka-key">Key</label>
                <LongField id="kafka-key" placeholder="order-123" value={active.key} spellCheck={false} onChange={(v) => setA('key', v)} />
              </div>
            </div>
            <div className="hint">Optional. Picks the partition, so records with the same key stay in order.</div>
            <label htmlFor="kafka-headers">Headers</label>
            <textarea id="kafka-headers" rows={2} value={active.headers} spellCheck={false} placeholder="trace-id: abc" onChange={(e) => setA('headers', e.target.value)} />
            <div className="hint">
              Per-record metadata, one <code>name: value</code> per line.
            </div>
            <label htmlFor="kafka-value">Value</label>
            <textarea
              id="kafka-value"
              rows={7}
              value={active.value}
              spellCheck={false}
              placeholder='{"event":"order-created"}'
              onChange={(e) => setA('value', e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  produce();
                }
              }}
            />
            <div className="hint">JSON or plain text.</div>
            <div className="inline mt-3">
              {publishing ? (
                <button className="btn-secondary" title="Stop waiting for the broker" onClick={() => cancelOp(active.id, 'produce')}>
                  Cancel
                </button>
              ) : (
                <button className="btn-primary" disabled={!active.topic.trim()} onClick={produce}>
                  Publish
                </button>
              )}
              <span className="hint m-0">
                {active.topic.trim() ? (
                  <>
                    <kbd>{SEND_KEY}</kbd> in the value also publishes
                  </>
                ) : (
                  'Enter a topic first.'
                )}
              </span>
            </div>
            <OutcomeView o={tabOutcomes.produce} secrets={secrets} />
          </div>

          <div hidden={rtab !== 'consume'}>
            <div className="row">
              <LongField
                className="grow"
                placeholder="group id (blank = throwaway group)"
                aria-label="Consumer group id"
                value={active.group}
                onChange={(v) => editConsumeField('group', v)}
              />
              <label className="check" title="Read the topic from the earliest retained offset instead of the newest">
                <input
                  type="checkbox"
                  checked={active.fromBeginning}
                  onChange={(e) => editConsumeField('fromBeginning', e.target.checked)}
                />
                From beginning
              </label>
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
            {typedGroup && (
              <div className="mt-2">
                <div className="hint text-warn m-0">
                  Joining the group <code>{typedGroup}</code> rebalances its live consumers: while this tab is connected, the
                  partitions assigned to it are not processed by them.{' '}
                  {commits
                    ? 'Offsets are committed, so the records this tab reads are skipped by the group when it resumes.'
                    : 'Offsets are not committed, so the group resumes where it was.'}
                </div>
                <label className="check" htmlFor="kafka-commit">
                  <input
                    id="kafka-commit"
                    type="checkbox"
                    checked={commits}
                    onChange={(e) => {
                      if (esRefs.current.get(active.id)) toggleConsume(active.id);
                      setCommit((m) => ({ ...m, [active.id]: e.target.checked ? typedGroup : '' }));
                    }}
                  />
                  Commit offsets for this group
                </label>
              </div>
            )}
            <div className="inline mt-2">
              <ConnPill state={cs} text={connText} />
              <span className="hint m-0">
                {!isConsuming && connectBlock ? connectBlock : 'Other tabs keep streaming in the background.'}
              </span>
            </div>
            {cs === 'error' && (
              <OutcomeView
                o={{ ok: false, text: csMsg, detail: connMap[active.id]?.detail, log: connMap[active.id]?.log }}
                secrets={secrets}
              />
            )}

            {rawFeed.length === 0 && (
              <Empty
                className="mt-3"
                icon="⇣"
                title="No records yet"
                hint={
                  cs === 'live' ? (
                    <>
                      Connected. Records written to this topic appear here; press <kbd>Publish</kbd> on the Publish tab to
                      check the path end to end.
                    </>
                  ) : (
                    <>
                      Set a topic above (or click one on the left after List topics) and press <kbd>Connect</kbd>.
                    </>
                  )
                }
              />
            )}
            {rawFeed.length > 0 && (
              <>
                <div className="feed-head">
                  <span className="count">
                    {fq
                      ? `${shownFeed.filter((m) => !isWarning(m)).length} / ${recordCount} records`
                      : plural(recordCount, 'record')}
                  </span>
                  <input
                    className="grow"
                    placeholder="Filter records"
                    aria-label="Filter records"
                    value={feedFilter[active.id] ?? ''}
                    spellCheck={false}
                    onChange={(e) => setFeedFilter((f) => ({ ...f, [active.id]: e.target.value }))}
                  />
                  <span className="spacer" />
                  <button
                    className="btn-ghost btn-sm"
                    title="Save the records shown (with the filter applied) as a JSON file"
                    onClick={() => downloadJson('kafka', 'feed', shownFeed)}
                  >
                    Export JSON
                  </button>
                  <button
                    className="btn-ghost btn-sm"
                    title="Discard the records received so far"
                    onClick={() => setFeeds((f) => ({ ...f, [active.id]: [] }))}
                  >
                    Clear
                  </button>
                </div>
                {hiddenNoise > 0 && (
                  <div
                    className="hint"
                    title="The client also tried the IPv6 address ::1 for localhost, which the broker does not listen on, then connected over IPv4."
                  >
                    {plural(hiddenNoise, 'IPv6 localhost (::1) retry warning')} hidden.
                  </div>
                )}
                <div className="feed">
                  {shownFeed.map((m, i) =>
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
                        key={`${m.partition}-${m.offset}-${m.at}`}
                        channel={recordChannel(m)}
                        at={m.at}
                        text={m.payload ?? ''}
                        pretty={m.payloadEncoding !== 'base64'}
                        meta={recordMeta(m)}
                        copy
                      />
                    ),
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
