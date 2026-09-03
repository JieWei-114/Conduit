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
      <div className="req-tabs">
        {tabs.map((t) => (
          <span
            key={t.id}
            className={`req-tab ${t.id === activeId ? 'active' : ''}`}
            onClick={() => setActiveId(t.id)}
            title={t.topic}
          >
            {connMap[t.id]?.s === 'live' ? '🟢 ' : connMap[t.id]?.s === 'connecting' ? '🟡 ' : connMap[t.id]?.s === 'error' ? '🔴 ' : ''}
            {tabLabel(t)}
            {tabs.length > 1 && (
              <i className="chip-x" title="close tab" onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}> ✕</i>
            )}
          </span>
        ))}
        <span className="req-tab req-tab-add" title="new consumer tab (shares this connection)" onClick={addTab}>+</span>
      </div>

      <div className="layout">
        <div className="left">
          <h3>
            Kafka <span className="badge">rdkafka</span>
          </h3>

          <label>Saved connections (shared across tabs)</label>
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
              save
            </button>
            <button className="btn-field btn-danger" disabled={!picked} onClick={() => { persistConns(conns.filter((c) => c.name !== picked)); setPicked(''); }}>
              delete
            </button>
          </div>

          <label>Brokers (comma-separated host:port)</label>
          <div className="row field-row">
            <input className="grow" value={conn.brokers} spellCheck={false} placeholder="localhost:9092" onChange={(e) => setConn('brokers', e.target.value)} />
            <button className="btn-field" onClick={listTopics}>list topics</button>
          </div>

          <div className="row field-row" style={{ marginTop: 6 }}>
            <label style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={conn.ssl} onChange={(e) => setConn('ssl', e.target.checked)} />
              SSL
            </label>
          </div>
          <div className="row field-row field-row-gap">
            <input placeholder="SASL user (optional)" value={conn.saslUser} onChange={(e) => setConn('saslUser', e.target.value)} />
            <input type="password" placeholder="SASL password" value={conn.saslPass} onChange={(e) => setConn('saslPass', e.target.value)} />
          </div>

          {topics.length > 0 && (
            <>
              <label>Topics <span className="count">({topics.length})</span></label>
              <div className="keylist" style={{ maxHeight: 200 }}>
                {topics.map((t) => (
                  <div key={t} className={`keyrow ${t === active.topic ? 'keyrow-active' : ''}`} onClick={() => editConsumeField('topic', t)} title="select for this tab">
                    <span className="kname">{t}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {status && <div className="hint">{status}</div>}
        </div>

        <div className="right">
          <label style={{ marginTop: 0 }}>Topic <span className="count">(this tab)</span></label>
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

          <div className="tabs" style={{ margin: '12px 0' }}>
            <span className={rtab === 'consume' ? 'tab active' : 'tab'} onClick={() => setRtab('consume')}>
              Consume {isConsuming ? '🟢' : ''}
            </span>
            <span className={rtab === 'produce' ? 'tab active' : 'tab'} onClick={() => setRtab('produce')}>
              Produce
            </span>
          </div>

          <div style={{ display: rtab === 'produce' ? undefined : 'none' }}>
            <label>Key (optional)</label>
            <input placeholder="player-123" value={active.key} spellCheck={false} onChange={(e) => setA('key', e.target.value)} />
            <label>Headers (k: v per line — per-message metadata)</label>
            <textarea rows={3} value={active.headers} spellCheck={false} placeholder="trace-id: abc" onChange={(e) => setA('headers', e.target.value)} />
            <label>Value (JSON or text)</label>
            <textarea
              rows={7}
              value={active.value}
              spellCheck={false}
              placeholder='{"event":"something-happened"}   ·   ⌘/Ctrl+Enter to send'
              onChange={(e) => setA('value', e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) produce(); }}
            />
            <button onClick={produce}>Send ▶</button>
          </div>

          <div style={{ display: rtab === 'consume' ? undefined : 'none' }}>
            <label>Consume (live) <span className="count">— other tabs keep streaming in background</span></label>
            <div className="row field-row">
              <input className="grow" placeholder="group id (blank = auto, throwaway)" value={active.group} onChange={(e) => setA('group', e.target.value)} />
              <label style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6, flex: '0 0 auto' }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={active.fromBeginning} onChange={(e) => editConsumeField('fromBeginning', e.target.checked)} />
                from beginning
              </label>
              <button className={`btn-field ${isConsuming ? 'btn-danger' : ''}`} onClick={() => toggleConsume(active.id)}>
                {isConsuming ? 'stop' : 'consume'}
              </button>
            </div>
            <div className={`hint ${cs === 'error' ? 'error' : ''}`} style={{ marginTop: 4 }}>
              {cs === 'live'
                ? `🟢 LIVE · subscribed${connMap[active.id]?.msg ? ` (${connMap[active.id]!.msg})` : ''}`
                : cs === 'connecting'
                  ? '🟡 connecting…'
                  : cs === 'error'
                    ? `🔴 ERROR — ${connMap[active.id]?.msg}`
                    : '⚪ stopped'}
            </div>
            {rawFeed.length > 0 && (
              <>
                <div className="feed-head">
                  <span className="count">{fq ? `${shownFeed.length} / ${rawFeed.length}` : rawFeed.length} messages</span>
                  <input
                    className="grow"
                    style={{ margin: '0 8px', padding: '2px 6px', fontSize: 12 }}
                    placeholder="filter messages"
                    value={feedFilter[active.id] ?? ''}
                    spellCheck={false}
                    onChange={(e) => setFeedFilter((f) => ({ ...f, [active.id]: e.target.value }))}
                  />
                  <span className="chip" onClick={() => setFeeds((f) => ({ ...f, [active.id]: [] }))}>clear</span>
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
                          <span className="chip" style={{ marginLeft: 8 }} onClick={() => navigator.clipboard.writeText(m.payload)}>copy</span>
                        </span>
                        <span className="feed-time">{new Date(m.at).toLocaleTimeString()}</span>
                        {hdrs && (
                          <div className="feed-ch" style={{ opacity: 0.7 }}>
                            {Object.entries(hdrs).map(([k, v]) => `${k}: ${v}`).join('  ·  ')}
                          </div>
                        )}
                        <div className="feed-msg">{pretty ?? m.payload}</div>
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
