import { useEffect, useRef, useState } from 'react';

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

  useEffect(() => localStorage.setItem(LS_CONN, JSON.stringify(conn)), [conn]);
  useEffect(() => localStorage.setItem(LS_TABS, JSON.stringify({ tabs, activeId })), [tabs, activeId]);
  useEffect(() => () => esRefs.current.forEach((es) => es.close()), []);

  const persistConns = (next: SavedConn[]) => {
    setConns(next);
    localStorage.setItem(LS_CONNS, JSON.stringify(next));
  };
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
  const connCls = cs === 'live' ? 'status ok' : cs === 'error' ? 'status bad' : 'status';
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
      <div className="req-tabs" role="tablist" aria-label="Kafka tabs">
        {tabs.map((t) => (
          <button
            type="button"
            key={t.id}
            className={`req-tab ${t.id === activeId ? 'active' : ''}`}
            role="tab"
            aria-selected={t.id === activeId}
            onClick={() => setActiveId(t.id)}
            title={t.topic}
          >
            {connMap[t.id]?.s === 'live' ? '🟢 ' : connMap[t.id]?.s === 'connecting' ? '🟡 ' : connMap[t.id]?.s === 'error' ? '🔴 ' : ''}
            {tabLabel(t)}
            {tabs.length > 1 && (
              // Lives inside the tab button, so it stays a role="button" span:
              // a button cannot contain another button.
              <i
                className="chip-x"
                role="button"
                tabIndex={0}
                aria-label="Close this tab"
                title="Close this tab"
                onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    e.stopPropagation();
                    closeTab(t.id);
                  }
                }}
              > ✕</i>
            )}
          </button>
        ))}
        <button
          type="button"
          className="req-tab req-tab-add"
          aria-label="New tab (shares this connection)"
          title="New tab (shares this connection)"
          onClick={addTab}
        >+</button>
      </div>

      <div className="layout">
        <div className="left">
          <h3>
            Kafka <span className="badge">rdkafka</span>
          </h3>

          <label>Saved connection</label>
          <div className="row field-row">
            <select
              className="grow"
              value={picked}
              onChange={(e) => {
                setPicked(e.target.value);
                const c = conns.find((x) => x.name === e.target.value);
                if (c) setConnState_({ brokers: c.brokers, ssl: c.ssl, saslUser: c.saslUser, saslPass: c.saslPass });
              }}
            >
              <option value=""> - </option>
              {conns.map((c) => (
                <option key={c.name} value={c.name}>{c.name}</option>
              ))}
            </select>
            <button
              className="btn-field"
              onClick={() => {
                const name = prompt('Name this connection (e.g. local, staging):', '');
                if (!name) return;
                persistConns([...conns.filter((c) => c.name !== name), { name, ...cfg() }]);
                setPicked(name);
              }}
            >
              Save
            </button>
            <button className="btn-field btn-danger" disabled={!picked} onClick={() => { persistConns(conns.filter((c) => c.name !== picked)); setPicked(''); }}>
              Delete
            </button>
          </div>
          <div className="hint">Shared across every tab in this panel.</div>

          <label>Brokers</label>
          <div className="row field-row">
            <input className="grow" value={conn.brokers} spellCheck={false} placeholder="localhost:9092" onChange={(e) => setConn('brokers', e.target.value)} />
            <button className="btn-field" onClick={listTopics}>List topics</button>
          </div>
          <div className="hint">One or more <code>host:port</code>, comma-separated.</div>

          <label>Transport</label>
          <div className="inline">
            <button
              className={`btn-field ${conn.ssl ? 'btn-on' : ''}`}
              title="Connect to the brokers over SSL"
              onClick={() => setConn('ssl', !conn.ssl)}
            >
              SSL
            </button>
          </div>
          <div className="row field-row field-row-gap">
            <input placeholder="SASL user (optional)" value={conn.saslUser} onChange={(e) => setConn('saslUser', e.target.value)} />
            <input type="password" placeholder="SASL password" value={conn.saslPass} onChange={(e) => setConn('saslPass', e.target.value)} />
          </div>

          {topics.length > 0 && (
            <>
              <label>Topics <span className="count">({topics.length})</span></label>
              {/* Rows are a mouse shortcut only: a cluster can list hundreds of
                  topics, and the Topic field on the right offers the same
                  choice from a datalist for keyboard users. */}
              <div className="keylist">
                {topics.map((t) => (
                  <div key={t} className={`keyrow ${t === active.topic ? 'keyrow-active' : ''}`} onClick={() => editConsumeField('topic', t)} title="Select this topic for the active tab">
                    <span className="kname">{t}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {status && <div className="hint">{status}</div>}
        </div>

        <div className="right">
          <label>Topic <span className="count">(this tab)</span></label>
          <input
            list="kafka-topics-r"
            value={active.topic}
            spellCheck={false}
            placeholder="my-topic"
            onChange={(e) => setA('topic', e.target.value)}
          />
          <datalist id="kafka-topics-r">
            {topics.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>

          <div className="tabs mt-3" role="tablist" aria-label="Direction">
            <button
              type="button"
              className={rtab === 'consume' ? 'tab active' : 'tab'}
              role="tab"
              aria-selected={rtab === 'consume'}
              onClick={() => setRtab('consume')}
            >
              Consume {isConsuming ? '🟢' : ''}
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
            <label>Key</label>
            <input placeholder="player-123" value={active.key} spellCheck={false} onChange={(e) => setA('key', e.target.value)} />
            <div className="hint">Optional. Decides the partition and the ordering group.</div>
            <label>Headers</label>
            <textarea rows={3} value={active.headers} spellCheck={false} placeholder="trace-id: abc" onChange={(e) => setA('headers', e.target.value)} />
            <div className="hint">Per-message metadata. One <code>k: v</code> per line.</div>
            <label>Value</label>
            <textarea
              rows={7}
              value={active.value}
              spellCheck={false}
              placeholder='{"event":"something-happened"}'
              onChange={(e) => setA('value', e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) produce(); }}
            />
            <div className="hint">JSON or plain text. <kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>Enter</kbd> sends.</div>
            <button onClick={produce}>Send</button>
          </div>

          <div hidden={rtab !== 'consume'}>
            <label>Consume</label>
            <div className="row field-row">
              <input className="grow" placeholder="group id (blank = auto, throwaway)" value={active.group} onChange={(e) => setA('group', e.target.value)} />
              <button
                className={`btn-field ${active.fromBeginning ? 'btn-on' : ''}`}
                title="Read the topic from the earliest retained offset instead of the newest"
                onClick={() => editConsumeField('fromBeginning', !active.fromBeginning)}
              >
                From beginning
              </button>
              <button className={`btn-field ${isConsuming ? 'btn-on' : ''}`} onClick={() => toggleConsume(active.id)}>
                {isConsuming ? 'Disconnect' : 'Connect'}
              </button>
            </div>
            <div className="hint">Every other tab keeps streaming in the background.</div>
            <div className={`${connCls} mt-2`}>{connText}</div>
            {rawFeed.length === 0 && cs !== 'live' && (
              <div className="empty mt-3">
                <div className="empty-icon">◈</div>
                <div className="empty-title">Not consuming</div>
                <div className="empty-hint">Set a topic and press <kbd>Connect</kbd> to stream messages here.</div>
              </div>
            )}
            {rawFeed.length === 0 && cs === 'live' && (
              <div className="empty mt-3">
                <div className="empty-icon">◈</div>
                <div className="empty-title">Connected, no messages yet</div>
                <div className="empty-hint">Records written to this topic will appear here. Produce one from the Produce tab to check the path end to end.</div>
              </div>
            )}
            {rawFeed.length > 0 && (
              <>
                <div className="feed-head inline">
                  <span className="count">{fq ? `${shownFeed.length} / ${rawFeed.length}` : rawFeed.length} messages</span>
                  <input
                    className="grow"
                    placeholder="filter messages"
                    value={feedFilter[active.id] ?? ''}
                    spellCheck={false}
                    onChange={(e) => setFeedFilter((f) => ({ ...f, [active.id]: e.target.value }))}
                  />
                  <button className="btn-field btn-danger" title="Discard the messages received so far" onClick={() => setFeeds((f) => ({ ...f, [active.id]: [] }))}>Clear</button>
                </div>
                <div className="feed">
                  {shownFeed.map((m) => {
                    const pretty = tryJson(m.payload);
                    const hdrs = m.headers && Object.keys(m.headers).length ? m.headers : null;
                    return (
                      <div key={`${m.partition}-${m.offset}`} className="feed-item">
                        <span className="feed-ch">
                          p{m.partition} · offset {m.offset}
                          {m.key ? ` · key ${m.key}` : ''}
                        </span>
                        <span className="feed-time">{new Date(m.at).toLocaleTimeString()}</span>
                        {hdrs && (
                          <div className="feed-props">
                            {Object.entries(hdrs).map(([k, v]) => `${k}: ${v}`).join('  ·  ')}
                          </div>
                        )}
                        <div className="feed-msg break">{pretty ?? m.payload}</div>
                        <div className="inline mt-1">
                          <button className="btn-field" title="Copy this record's value to the clipboard" onClick={() => navigator.clipboard.writeText(m.payload)}>Copy</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
