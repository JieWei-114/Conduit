import { useEffect, useRef, useState } from 'react';
import { useFlash } from './useFlash';
import { SaveAs } from './SaveAs';
import { ConnPill, Empty, FeedRow, PanelHead, ReqTabs, Section, persistLater } from './ui';

const LS_CONN = 'conduit.kafka.conn.v1';
const LS_CONNS = 'conduit.kafka.conns.v1';
const LS_TABS = 'conduit.kafka.tabs.v1';

// shared connection (all tabs use it — like the Pulsar panel)
interface KConn {
  brokers: string;
  ssl: boolean;
  saslUser: string;
  saslPass: string;
}
const CONN_DEFAULT: KConn = { brokers: 'localhost:9092', ssl: false, saslUser: '', saslPass: '' };

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
  offset: string;
  key: string;
  headers?: Record<string, string>;
  payload: string;
}
type ConnS = { s: 'idle' | 'connecting' | 'live' | 'error'; msg?: string };

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
  const [topics, setTopics] = useState<string[]>([]);
  const [status, setStatus] = useState('');
  const [rtab, setRtab] = useState<'consume' | 'produce'>('consume');

  const init = useRef<{ tabs: KTab[]; activeId: number } | null>(null);
  if (!init.current) init.current = loadTabs();
  const [tabs, setTabs] = useState<KTab[]>(init.current.tabs);
  const [activeId, setActiveId] = useState<number>(init.current.activeId);
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];

  // per-tab runtime (memory only)
  const [feeds, setFeeds] = useState<Record<number, Msg[]>>({});
  const [feedFilter, setFeedFilter] = useState<Record<number, string>>({});
  const [consuming, setConsuming] = useState<Record<number, boolean>>({});
  const [connMap, setConnMap] = useState<Record<number, ConnS>>({});
  const esRefs = useRef<Map<number, EventSource>>(new Map());

  const setConn = <K extends keyof KConn>(k: K, v: KConn[K]) => setConnState_((c) => ({ ...c, [k]: v }));
  const setActive = (fn: (t: KTab) => KTab) =>
    setTabs((ts) => ts.map((t) => (t.id === active.id ? fn(t) : t)));
  const setA = <K extends keyof KTab>(k: K, v: KTab[K]) => setActive((t) => ({ ...t, [k]: v }));
  // editing a consume param while live → stop so a stale consumer can't run on
  const editConsumeField = <K extends keyof KTab>(k: K, v: KTab[K]) => {
    if (esRefs.current.get(active.id)) toggleConsume(active.id);
    setA(k, v);
  };

  useEffect(() => persistLater(LS_CONN, () => JSON.stringify(conn)), [conn]);
  useEffect(() => persistLater(LS_TABS, () => JSON.stringify({ tabs, activeId })), [tabs, activeId]);
  useEffect(() => () => esRefs.current.forEach((es) => es.close()), []);

  const persistConns = (next: SavedConn[]) => {
    setConns(next);
    localStorage.setItem(LS_CONNS, JSON.stringify(next));
  };

  const [flashMsg, flash] = useFlash();

  const cfg = () => ({ brokers: conn.brokers.trim(), ssl: conn.ssl, saslUser: conn.saslUser, saslPass: conn.saslPass });

  const listTopics = async () => {
    setStatus('listing topics…');
    try {
      const r = await fetch('/api/kafka/topics', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(cfg()),
      }).then((x) => x.json());
      if (!r.ok) return setStatus(`✗ ${r.error}`);
      setTopics(r.topics);
      setStatus(`${r.topics.length} topics`);
    } catch (e) {
      setStatus(`✗ ${String(e)}`);
    }
  };

  const produce = async () => {
    if (!active.topic.trim()) return;
    setStatus('sending…');
    try {
      const r = await fetch('/api/kafka/produce', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...cfg(),
          topic: active.topic.trim(),
          key: active.key,
          headers: parseHeaders(active.headers),
          value: active.value,
        }),
      }).then((x) => x.json());
      setStatus(r.ok ? 'sent ✓' : `✗ ${r.error}`);
    } catch (e) {
      setStatus(`✗ ${String(e)}`);
    }
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
    const q = new URLSearchParams({
      cfg: b64,
      topic: t.topic.trim(),
      group: t.group.trim(),
      fromBeginning: t.fromBeginning ? '1' : '0',
    });
    const es = new EventSource(`/api/kafka/consume?${q}`);
    setConnMap((m) => ({ ...m, [id]: { s: 'connecting' } }));
    es.onopen = () => setConnMap((m) => ({ ...m, [id]: m[id]?.s === 'live' ? m[id] : { s: 'connecting' } }));
    es.addEventListener('ready', (e) => {
      const msg = (e as MessageEvent).data;
      setConnMap((m) => ({ ...m, [id]: { s: 'live', msg } }));
      setStatus(`subscribed: ${msg}`);
    });
    es.addEventListener('message', (e) => {
      let d: Msg;
      try { d = JSON.parse((e as MessageEvent).data) as Msg; } catch { return; } // drop malformed frame, keep stream
      setFeeds((f) => ({ ...f, [id]: [d, ...(f[id] ?? [])].slice(0, 200) }));
    });
    es.addEventListener('error', (e) => {
      const msg = (e as MessageEvent).data || 'connection failed — check brokers / SASL / SSL';
      setConnMap((m) => ({ ...m, [id]: { s: 'error', msg } }));
      setStatus(`consume error: ${msg}`);
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
    setTabs((ts) => [...ts, NEW_TAB(id, { topic: active.topic })]);
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
          ? `Error — ${csMsg}`
          : 'Disconnected';
  const rawFeed = feeds[active.id] ?? [];
  const fq = (feedFilter[active.id] ?? '').trim().toLowerCase();
  const shownFeed = fq
    ? rawFeed.filter(
        (m) =>
          m.payload.toLowerCase().includes(fq) ||
          m.key.toLowerCase().includes(fq) ||
          JSON.stringify(m.headers ?? {}).toLowerCase().includes(fq),
      )
    : rawFeed;

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
        addTitle="New tab (same connection)"
      />

      <div className="layout">
        <div className="left">
          <PanelHead
            title="Kafka"
            badge="rdkafka"
            tagline="Connect to brokers, pick a topic, then consume live or produce a record. Each tab is its own consumer."
          />

          <div className="saved-bar">
            <select
              value={picked}
              aria-label="Saved connections"
              onChange={(e) => {
                setPicked(e.target.value);
                const c = conns.find((x) => x.name === e.target.value);
                if (c) setConnState_({ brokers: c.brokers, ssl: c.ssl, saslUser: c.saslUser, saslPass: c.saslPass });
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
            <label className="field-first">Brokers</label>
            <div className="row row-tight">
              <input
                className="grow"
                value={conn.brokers}
                spellCheck={false}
                placeholder="localhost:9092"
                onChange={(e) => setConn('brokers', e.target.value)}
              />
              <button className="btn-secondary" onClick={listTopics}>
                List topics
              </button>
            </div>
            <div className="hint">
              One or more <code>host:port</code>, comma-separated.
            </div>
            <div className="conn-row">
              <div className="grow">
                <label>SASL user</label>
                <input placeholder="optional" value={conn.saslUser} onChange={(e) => setConn('saslUser', e.target.value)} />
              </div>
              <div className="grow">
                <label>SASL password</label>
                <input type="password" placeholder="optional" value={conn.saslPass} onChange={(e) => setConn('saslPass', e.target.value)} />
              </div>
              <label className="check" title="Connect to the brokers over SSL">
                <input type="checkbox" checked={conn.ssl} onChange={(e) => setConn('ssl', e.target.checked)} />
                SSL
              </label>
            </div>
            {status && <div className={status.startsWith('✗') || status.includes('error') ? 'error break' : 'hint'}>{status.replace(/^✗ /, '')}</div>}
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
                  <div
                    key={t}
                    className={`keyrow ${t === active.topic ? 'keyrow-active' : ''}`}
                    onClick={() => editConsumeField('topic', t)}
                    title="Use this topic in the current tab"
                  >
                    <span className="kname">{t}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="hint m-0">Press List topics to load them, then click one to use it in this tab.</div>
            )}
          </Section>
        </div>

        <div className="right">
          <label className="field-first">
            Topic <span className="count">(this tab)</span>
          </label>
          <input
            list="kafka-topics-r"
            value={active.topic}
            spellCheck={false}
            placeholder="orders"
            onChange={(e) => setA('topic', e.target.value)}
          />
          <datalist id="kafka-topics-r">
            {topics.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>

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
              Produce
            </button>
          </div>

          <div hidden={rtab !== 'produce'}>
            <div className="conn-row mt-0">
              <div className="grow">
                <label className="field-first">Key</label>
                <input placeholder="order-123" value={active.key} spellCheck={false} onChange={(e) => setA('key', e.target.value)} />
              </div>
            </div>
            <div className="hint">Optional. Picks the partition, so records with the same key stay in order.</div>
            <label>Headers</label>
            <textarea rows={2} value={active.headers} spellCheck={false} placeholder="trace-id: abc" onChange={(e) => setA('headers', e.target.value)} />
            <div className="hint">
              Per-record metadata, one <code>name: value</code> per line.
            </div>
            <label>Value</label>
            <textarea
              rows={7}
              value={active.value}
              spellCheck={false}
              placeholder='{"event":"order-created"}'
              onChange={(e) => setA('value', e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) produce();
              }}
            />
            <div className="inline mt-2">
              <button className="btn-primary" disabled={!active.topic.trim()} onClick={produce}>
                Send record
              </button>
              <span className="hint m-0">
                JSON or plain text. <kbd>⌘↵</kbd> sends.
              </span>
            </div>
          </div>

          <div hidden={rtab !== 'consume'}>
            <div className="row">
              <input
                className="grow"
                placeholder="group id (blank = throwaway group)"
                aria-label="Consumer group id"
                value={active.group}
                onChange={(e) => setA('group', e.target.value)}
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
                className={isConsuming ? 'btn-secondary btn-on' : 'btn-primary'}
                disabled={!isConsuming && !active.topic.trim()}
                onClick={() => toggleConsume(active.id)}
              >
                {isConsuming ? 'Disconnect' : 'Connect'}
              </button>
            </div>
            <div className="inline mt-2">
              <ConnPill state={cs} text={cs === 'error' ? 'Error' : connText} />
              <span className="hint m-0">Other tabs keep streaming in the background.</span>
            </div>
            {cs === 'error' && csMsg && <div className="error">{csMsg}</div>}

            {rawFeed.length === 0 && cs !== 'live' && (
              <Empty
                className="mt-3"
                icon="⇣"
                title="Not consuming"
                hint={
                  <>
                    Set a topic above (or click one on the left after List topics) and press <kbd>Connect</kbd>. New records
                    stream in here.
                  </>
                }
              />
            )}
            {rawFeed.length === 0 && cs === 'live' && (
              <Empty
                className="mt-3"
                icon="⇣"
                title="Connected, no records yet"
                hint="Records written to this topic will appear here. Produce one from the Produce tab to check the path end to end."
              />
            )}
            {rawFeed.length > 0 && (
              <>
                <div className="feed-head">
                  <span className="count">{fq ? `${shownFeed.length} / ${rawFeed.length}` : rawFeed.length} records</span>
                  <input
                    className="grow"
                    placeholder="Filter records"
                    aria-label="Filter records"
                    value={feedFilter[active.id] ?? ''}
                    spellCheck={false}
                    onChange={(e) => setFeedFilter((f) => ({ ...f, [active.id]: e.target.value }))}
                  />
                  <button
                    className="btn-ghost btn-sm"
                    title="Discard the records received so far"
                    onClick={() => setFeeds((f) => ({ ...f, [active.id]: [] }))}
                  >
                    Clear
                  </button>
                </div>
                <div className="feed">
                  {shownFeed.map((m) => (
                    <FeedRow
                      key={`${m.partition}-${m.offset}`}
                      channel={`p${m.partition} · offset ${m.offset}${m.key ? ` · key ${m.key}` : ''}`}
                      at={m.at}
                      text={m.payload}
                      meta={
                        m.headers && Object.keys(m.headers).length
                          ? Object.entries(m.headers)
                              .map(([k, v]) => `${k}: ${v}`)
                              .join('  ·  ')
                          : undefined
                      }
                      copy
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
