import { useEffect, useRef, useState } from 'react';

const LS_TABS = 'conduit.ws.tabs.v1';
const LS_FORM = 'conduit.ws.form.v1'; // legacy single-form (migrated)
const LS_SAVED = 'conduit.ws.saved.v1';

interface WsForm {
  mode: 'ws' | 'sse';
  url: string;
  headers: string; // k: v per line (Authorization etc.)
  protocols: string; // comma-separated subprotocols
}
const DEFAULTS: WsForm = { mode: 'ws', url: 'wss://', headers: '', protocols: '' };

interface WTab { id: number; form: WsForm }
interface Msg { id: number; dir: 'in' | 'out' | 'sys'; at: string; text: string }
type St = { s: 'idle' | 'connecting' | 'live' | 'error'; msg?: string };

function tryJson(s: string): string | null {
  const t = s.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return null;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return null;
  }
}
function loadJson<T>(key: string, fb: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fb;
  } catch {
    return fb;
  }
}
function hydrate(f: Partial<WsForm>): WsForm {
  return { ...DEFAULTS, ...f };
}
function loadTabs(): { tabs: WTab[]; activeId: number } {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_TABS) ?? 'null');
    if (raw && Array.isArray(raw.tabs) && raw.tabs.length) {
      const tabs: WTab[] = raw.tabs.map((t: any, i: number) => ({ id: t.id ?? i + 1, form: hydrate(t.form ?? {}) }));
      const activeId = tabs.some((t) => t.id === raw.activeId) ? raw.activeId : tabs[0].id;
      return { tabs, activeId };
    }
  } catch {
    /* fall through */
  }
  const old = loadJson<Partial<WsForm>>(LS_FORM, {});
  return { tabs: [{ id: 1, form: hydrate(old) }], activeId: 1 };
}

export default function WsPanel() {
  const init = useRef<{ tabs: WTab[]; activeId: number } | null>(null);
  if (!init.current) init.current = loadTabs();
  const [tabs, setTabs] = useState<WTab[]>(init.current.tabs);
  const [activeId, setActiveId] = useState<number>(init.current.activeId);
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const form = active.form;

  const [saved, setSaved] = useState<{ name: string; form: WsForm }[]>(() => loadJson(LS_SAVED, []));
  const [picked, setPicked] = useState('');

  // per-tab runtime (memory only)
  const [msgsMap, setMsgsMap] = useState<Record<number, Msg[]>>({});
  const [stateMap, setStateMap] = useState<Record<number, St>>({});
  const [filterMap, setFilterMap] = useState<Record<number, string>>({});
  const [outboxMap, setOutboxMap] = useState<Record<number, string>>({});
  const wsRefs = useRef<Map<number, WebSocket>>(new Map());
  const esRefs = useRef<Map<number, EventSource>>(new Map());
  const idRef = useRef(0);

  const setForm = (u: (f: WsForm) => WsForm) =>
    setTabs((ts) => ts.map((t) => (t.id === active.id ? { ...t, form: u(t.form) } : t)));
  const set = <K extends keyof WsForm>(k: K, v: WsForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    localStorage.setItem(LS_TABS, JSON.stringify({ tabs, activeId }));
  }, [tabs, activeId]);
  useEffect(
    () => () => {
      wsRefs.current.forEach((ws) => ws.close());
      esRefs.current.forEach((es) => es.close());
    },
    [],
  );

  const push = (id: number, m: Omit<Msg, 'id'>) =>
    setMsgsMap((mm) => ({ ...mm, [id]: [{ ...m, id: idRef.current++ }, ...(mm[id] ?? [])].slice(0, 300) }));
  const setSt = (id: number, s: St) => setStateMap((m) => ({ ...m, [id]: s }));

  const headersObj = (f: WsForm) => {
    const h: Record<string, string> = {};
    for (const line of f.headers.split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) h[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return h;
  };

  const disconnect = (id: number) => {
    wsRefs.current.get(id)?.close();
    wsRefs.current.delete(id);
    esRefs.current.get(id)?.close();
    esRefs.current.delete(id);
    setSt(id, { s: 'idle' });
  };

  const connectSse = (id: number, f: WsForm) => {
    if (!/^https?:\/\//i.test(f.url.trim())) {
      setSt(id, { s: 'error', msg: 'URL must start with http:// or https://' });
      return;
    }
    const q = new URLSearchParams({
      target: f.url.trim(),
      headers: btoa(unescape(encodeURIComponent(JSON.stringify(headersObj(f))))),
    });
    const es = new EventSource(`/api/sse/proxy?${q}`);
    setSt(id, { s: 'connecting' });
    es.onopen = () => { setSt(id, { s: 'live' }); push(id, { dir: 'sys', at: new Date().toISOString(), text: '● connected (SSE)' }); };
    es.onmessage = (e) => push(id, { dir: 'in', at: new Date().toISOString(), text: e.data });
    es.onerror = () => {
      setSt(id, { s: 'error', msg: 'connection failed / closed — check URL, auth header, reachability' });
      push(id, { dir: 'sys', at: new Date().toISOString(), text: '✗ SSE error / closed' });
      es.close();
      esRefs.current.delete(id);
    };
    esRefs.current.set(id, es);
  };

  const connectWs = (id: number, f: WsForm) => {
    if (!/^wss?:\/\//i.test(f.url.trim())) {
      setSt(id, { s: 'error', msg: 'URL must start with ws:// or wss://' });
      return;
    }
    const q = new URLSearchParams({
      target: f.url.trim(),
      headers: btoa(unescape(encodeURIComponent(JSON.stringify(headersObj(f))))),
      ...(f.protocols.trim() ? { protocols: f.protocols.trim() } : {}),
    });
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/ws/proxy?${q}`);
    setSt(id, { s: 'connecting' });
    ws.onmessage = (e) => {
      let env: any;
      try { env = JSON.parse(e.data); } catch { return; }
      if (env.kind === 'open') { setSt(id, { s: 'live' }); push(id, { dir: 'sys', at: new Date().toISOString(), text: '● connected' }); }
      else if (env.kind === 'message') push(id, { dir: 'in', at: env.at, text: env.data });
      else if (env.kind === 'close') {
        setSt(id, { s: 'idle', msg: `closed ${env.code}` });
        push(id, { dir: 'sys', at: new Date().toISOString(), text: `● closed ${env.code} ${env.reason ?? ''}` });
        wsRefs.current.delete(id);
      } else if (env.kind === 'error') {
        setSt(id, { s: 'error', msg: env.error });
        push(id, { dir: 'sys', at: new Date().toISOString(), text: `✗ ${env.error}` });
      }
    };
    ws.onerror = () => {
      setSt(id, { s: 'error', msg: 'connection failed — check URL / auth / reachability' });
      // drop the ref so the next click reconnects instead of toggling to disconnect
      if (wsRefs.current.get(id) === ws) wsRefs.current.delete(id);
    };
    ws.onclose = () => {
      if (wsRefs.current.get(id) === ws) {
        wsRefs.current.delete(id);
        setStateMap((m) => ({ ...m, [id]: m[id]?.s === 'error' ? m[id] : { s: 'idle' } }));
      }
    };
    wsRefs.current.set(id, ws);
  };

  const connect = (id: number) => {
    if (wsRefs.current.get(id) || esRefs.current.get(id)) return disconnect(id);
    const t = tabs.find((x) => x.id === id);
    if (!t) return;
    if (t.form.mode === 'sse') connectSse(id, t.form);
    else connectWs(id, t.form);
  };

  const sendMsg = (id: number) => {
    const text = outboxMap[id] ?? '';
    const ws = wsRefs.current.get(id);
    if (!text.trim() || ws?.readyState !== WebSocket.OPEN) return;
    ws.send(text);
    push(id, { dir: 'out', at: new Date().toISOString(), text });
    setOutboxMap((m) => ({ ...m, [id]: '' }));
  };

  const persistSaved = (next: { name: string; form: WsForm }[]) => {
    setSaved(next);
    localStorage.setItem(LS_SAVED, JSON.stringify(next));
  };

  // ── tabs ─────────────────────────────────────────────────────────────────
  const tabLabel = (t: WTab) => {
    const host = t.form.url.replace(/^(wss?|https?):\/\//, '').split(/[/?]/)[0] || t.form.mode;
    return host;
  };
  const addTab = () => {
    const id = Math.max(0, ...tabs.map((t) => t.id)) + 1;
    setTabs((ts) => [...ts, { id, form: hydrate({}) }]);
    setActiveId(id);
  };
  const closeTab = (id: number) => {
    if (tabs.length === 1) return;
    disconnect(id);
    const idx = tabs.findIndex((t) => t.id === id);
    const next = tabs.filter((t) => t.id !== id);
    setTabs(next);
    setMsgsMap((m) => { const c = { ...m }; delete c[id]; return c; });
    setStateMap((m) => { const c = { ...m }; delete c[id]; return c; });
    setFilterMap((m) => { const c = { ...m }; delete c[id]; return c; });
    setOutboxMap((m) => { const c = { ...m }; delete c[id]; return c; });
    if (id === activeId) setActiveId(next[Math.max(0, idx - 1)].id);
  };

  const sse = form.mode === 'sse';
  const st = stateMap[active.id] ?? { s: 'idle' as const };
  const live = st.s === 'live';
  const connState = st.s;
  const editable = st.s === 'idle' || st.s === 'error';
  const msgs = msgsMap[active.id] ?? [];
  const filter = filterMap[active.id] ?? '';
  const fq = filter.trim().toLowerCase();
  const shown = fq ? msgs.filter((m) => m.text.toLowerCase().includes(fq)) : msgs;

  const switchMode = (mode: 'ws' | 'sse') => {
    if (!editable) disconnect(active.id);
    set('mode', mode);
  };

  return (
    <div className="grpc-wrap">
      <div className="req-tabs">
        {tabs.map((t) => {
          const s = stateMap[t.id]?.s;
          return (
            <span key={t.id} className={`req-tab ${t.id === activeId ? 'active' : ''}`} onClick={() => setActiveId(t.id)} title={t.form.url}>
              {s === 'live' ? '🟢 ' : s === 'connecting' ? '🟡 ' : s === 'error' ? '🔴 ' : ''}
              {tabLabel(t)}
              {tabs.length > 1 && (
                <i className="chip-x" title="close tab" onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}> ✕</i>
              )}
            </span>
          );
        })}
        <span className="req-tab req-tab-add" title="new connection tab" onClick={addTab}>+</span>
      </div>

      <div className="layout">
        <div className="left">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
            <h3 style={{ margin: 0 }}>
              {sse ? 'SSE' : 'WebSocket'} <span className="badge">live stream</span>
            </h3>
            <div className="tabs" style={{ margin: 0 }}>
              <span className={form.mode === 'ws' ? 'tab active' : 'tab'} onClick={() => switchMode('ws')}>WebSocket</span>
              <span className={form.mode === 'sse' ? 'tab active' : 'tab'} onClick={() => switchMode('sse')}>SSE</span>
            </div>
          </div>

          <label>Saved connections</label>
          <div className="row field-row">
            <select
              className="grow"
              value={picked}
              onChange={(e) => {
                setPicked(e.target.value);
                const s = saved.find((x) => x.name === e.target.value);
                if (s) setForm(() => hydrate(s.form));
              }}
            >
              <option value=""> - </option>
              {saved.map((s) => (
                <option key={s.name} value={s.name}>{s.name}</option>
              ))}
            </select>
            <button
              className="btn-field"
              onClick={() => {
                if (!form.url.trim()) return;
                const name = prompt('Name this connection:', '');
                if (!name) return;
                persistSaved([...saved.filter((s) => s.name !== name), { name, form }]);
                setPicked(name);
              }}
            >
              save
            </button>
            <button className="btn-field btn-danger" disabled={!picked} onClick={() => { persistSaved(saved.filter((s) => s.name !== picked)); setPicked(''); }}>
              delete
            </button>
          </div>

          <label>URL ({sse ? 'http:// or https://' : 'ws:// or wss://'})</label>
          <div className="row field-row">
            <input
              className="grow"
              value={form.url}
              spellCheck={false}
              placeholder={sse ? 'https://host/events' : 'wss://host/path'}
              disabled={!editable}
              onChange={(e) => set('url', e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && connect(active.id)}
            />
            <button className={`btn-field ${live || connState === 'connecting' ? 'btn-danger' : ''}`} onClick={() => connect(active.id)}>
              {live || connState === 'connecting' ? 'disconnect' : 'connect'}
            </button>
          </div>

          <label>Headers (one per line — Authorization etc.)</label>
          <textarea rows={4} value={form.headers} spellCheck={false} placeholder="authorization: Bearer …" disabled={!editable} onChange={(e) => set('headers', e.target.value)} />

          {!sse && (
            <>
              <label>Subprotocols (optional, comma-separated)</label>
              <input value={form.protocols} spellCheck={false} placeholder="graphql-ws" disabled={!editable} onChange={(e) => set('protocols', e.target.value)} />
            </>
          )}

          <div className={`hint ${connState === 'error' ? 'error' : ''}`} style={{ marginTop: 8 }}>
            {connState === 'live'
              ? '🟢 connected — receiving'
              : connState === 'connecting'
                ? '🟡 connecting…'
                : connState === 'error'
                  ? `🔴 ${st.msg}`
                  : `⚪ ${st.msg || 'not connected'}`}
          </div>
        </div>

        <div className="right">
          {sse ? (
            <div className="hint" style={{ marginTop: 0 }}>
              SSE is receive-only — connect on the left and events stream below. Only the default
              (unnamed) <code>message</code> events are shown.
            </div>
          ) : (
            <>
              <label style={{ marginTop: 0 }}>Send a message</label>
              <textarea
                rows={4}
                value={outboxMap[active.id] ?? ''}
                spellCheck={false}
                placeholder={live ? '{"type":"subscribe",…}   ·   ⌘/Ctrl+Enter to send' : 'connect first'}
                disabled={!live}
                onChange={(e) => setOutboxMap((m) => ({ ...m, [active.id]: e.target.value }))}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendMsg(active.id); }}
              />
              <button style={{ width: 'auto' }} disabled={!live} onClick={() => sendMsg(active.id)}>Send ▶</button>
            </>
          )}

          <div className="section">
            {msgs.length > 0 && (
              <div className="feed-head">
                <span className="count">{fq ? `${shown.length} / ${msgs.length}` : msgs.length} messages</span>
                <input
                  className="grow"
                  style={{ margin: '0 8px', padding: '2px 6px', fontSize: 12 }}
                  placeholder="filter messages"
                  value={filter}
                  spellCheck={false}
                  onChange={(e) => setFilterMap((m) => ({ ...m, [active.id]: e.target.value }))}
                />
                <span className="chip" onClick={() => setMsgsMap((m) => ({ ...m, [active.id]: [] }))}>clear</span>
              </div>
            )}
            <div className="feed">
              {msgs.length === 0 && <pre>Connect, then messages stream here. Sent messages are echoed too.</pre>}
              {shown.map((m) => {
                const pretty = m.dir !== 'sys' ? tryJson(m.text) : null;
                return (
                  <div key={m.id} className={`feed-item ws-${m.dir}`}>
                    <span className="feed-ch">{m.dir === 'in' ? '↓ recv' : m.dir === 'out' ? '↑ sent' : '•'}</span>
                    <span className="feed-time">{new Date(m.at).toLocaleTimeString()}</span>
                    <div className="feed-msg">{pretty ?? m.text}</div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
