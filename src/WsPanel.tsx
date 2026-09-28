import { useEffect, useRef, useState } from 'react';
import { useFlash } from './useFlash';
import { SaveAs } from './SaveAs';

const LS_TABS = 'conduit.ws.tabs.v1';
const LS_FORM = 'conduit.ws.form.v1'; // legacy single-form (migrated)
const LS_SAVED = 'conduit.ws.saved.v1';

/**
 * Socket.IO rides on a WebSocket, so it lives here as a third mode rather than
 * in a panel of its own: same proxy, same saved connections, same tabs, same
 * message feed. Only the framing differs, and only the `sio*` fields below.
 *
 * Wire format (one text frame each):
 *   engine.io  0{...}=open  1=close  2=ping  3=pong  4<sio>=message
 *   socket.io  0=CONNECT 1=DISCONNECT 2=EVENT 3=ACK 4=CONNECT_ERROR
 *   connect    40[/ns,][authJSON]        event  42[/ns,][ackId]["name",arg]
 * The server pings, we pong; without that it drops the connection.
 */
interface WsForm {
  mode: 'ws' | 'sio' | 'sse';
  url: string;
  headers: string; // k: v per line (Authorization etc.)
  protocols: string; // comma-separated subprotocols
  sioPath: string; // socket.io mount path
  sioNamespace: string; // socket.io namespace
  sioQuery: string; // extra handshake query string
  sioAuth: string; // JSON carried in the CONNECT packet
  sioEvent: string; // event name to emit
  sioPayload: string; // JSON argument to emit with it
}
const DEFAULTS: WsForm = {
  mode: 'ws',
  url: 'wss://',
  headers: '',
  protocols: '',
  sioPath: '/socket.io',
  sioNamespace: '/',
  sioQuery: '',
  sioAuth: '',
  sioEvent: '',
  sioPayload: '{}',
};

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
/* A binary frame arrives base64-encoded with its byte count, because the wire
   is JSON and the bytes are not guaranteed to be valid UTF-8. Label it so the
   feed cannot be mistaken for text the server actually sent. */
function frameText(env: { data?: unknown; encoding?: string; bytes?: number }): string {
  const data = String(env.data ?? '');
  return env.encoding === 'base64' ? `[binary ${env.bytes ?? 0} bytes, base64]\n${data}` : data;
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

  /* Socket.IO's own handshake URL. The path falls back only when it is blank
     after trimming the slashes off — `'/' + ''` is still truthy, so a plain
     `||` fallback would let an empty path through as `//`. */
  const sioTarget = (f: WsForm): string | null => {
    let u = f.url.trim();
    if (!u) return null;
    u = u.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
    // A host is required, not just a scheme: trimming trailing slashes off a
    // bare "wss://" would otherwise yield "wss:" and a malformed target.
    if (!/^wss?:\/\/[^/?#]+/i.test(u)) return null;
    u = u.replace(/\/+$/, '');
    const trimmed = f.sioPath.trim().replace(/^\/+|\/+$/g, '');
    const path = trimmed ? `/${trimmed}` : '/socket.io';
    const extra = f.sioQuery.trim() ? `&${f.sioQuery.trim().replace(/^[?&]/, '')}` : '';
    return `${u}${path}/?EIO=4&transport=websocket${extra}`;
  };

  /** "/ns," for a real namespace, empty for the default one. */
  const nsPrefix = (f: WsForm) => {
    const ns = f.sioNamespace.trim();
    return ns && ns !== '/' ? `${ns.startsWith('/') ? ns : `/${ns}`},` : '';
  };

  /* A Socket.IO connection is live only once the server acks CONNECT, so the
     proxy opening is not enough — `live` gates Emit, and emitting before the
     ack is dropped by the server. */
  const handleSio = (id: number, f: WsForm, ws: WebSocket, raw: string) => {
    if (!raw) return;
    const at = () => new Date().toISOString();
    const send = (frame: string) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(frame);
    };
    const engine = raw[0];
    if (engine === '0') {
      push(id, { dir: 'sys', at: at(), text: '● engine.io open' });
      send(`40${nsPrefix(f)}${f.sioAuth.trim()}`);
      return;
    }
    if (engine === '2') return send('3'); // ping → pong
    if (engine === '1') return push(id, { dir: 'sys', at: at(), text: '● engine.io close' });
    if (engine !== '4') return;

    const packet = raw.slice(1);
    const type = packet[0];
    let rest = packet.slice(1);
    if (rest.startsWith('/')) {
      const comma = rest.indexOf(',');
      if (comma >= 0) rest = rest.slice(comma + 1);
    }
    if (type === '0') {
      setSt(id, { s: 'live' });
      push(id, { dir: 'sys', at: at(), text: '✔ connected (Socket.IO)' });
    } else if (type === '1') {
      push(id, { dir: 'sys', at: at(), text: '● disconnected by server' });
    } else if (type === '4') {
      setSt(id, { s: 'error', msg: 'connect_error' });
      push(id, { dir: 'in', at: at(), text: `connect_error ${rest}` });
    } else if (type === '2' || type === '3') {
      // EVENT or ACK: drop a leading ack id, keep the JSON array for the feed
      const m = rest.match(/^(\d+)?([[{][\s\S]*)$/);
      push(id, { dir: 'in', at: at(), text: m ? m[2] : rest });
    }
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
    const sio = f.mode === 'sio';
    const target = sio ? sioTarget(f) : f.url.trim();
    if (!target || (!sio && !/^wss?:\/\//i.test(target))) {
      setSt(id, {
        s: 'error',
        msg: sio
          ? 'URL must start with http://, https://, ws:// or wss://'
          : 'URL must start with ws:// or wss://',
      });
      return;
    }
    const q = new URLSearchParams({
      target,
      headers: btoa(unescape(encodeURIComponent(JSON.stringify(headersObj(f))))),
      ...(f.protocols.trim() ? { protocols: f.protocols.trim() } : {}),
    });
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/ws/proxy?${q}`);
    setSt(id, { s: 'connecting' });
    ws.onmessage = (e) => {
      let env: any;
      try { env = JSON.parse(e.data); } catch { return; }
      if (env.kind === 'open') {
        // For Socket.IO the proxy being open is only the transport; `live`
        // waits for the CONNECT ack in handleSio.
        push(id, { dir: 'sys', at: new Date().toISOString(), text: sio ? '● proxy connected' : '● connected' });
        if (!sio) setSt(id, { s: 'live' });
      }
      else if (env.kind === 'message') {
        // A binary frame is never engine.io framing — it is a Socket.IO
        // attachment — so it goes straight to the feed in both modes rather
        // than through handleSio, which would read base64 as a frame type.
        if (env.encoding === 'base64') push(id, { dir: 'in', at: env.at, text: frameText(env) });
        else if (sio) handleSio(id, f, ws, String(env.data ?? ''));
        else push(id, { dir: 'in', at: env.at, text: frameText(env) });
      }
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

  /* Every refusal names its reason. An Emit that quietly does nothing is
     indistinguishable from a broken button. */
  const emitEvent = (id: number) => {
    const f = tabs.find((t) => t.id === id)?.form;
    if (!f) return;
    const ws = wsRefs.current.get(id);
    if (ws?.readyState !== WebSocket.OPEN) return flashEmit('Connect first');
    const name = f.sioEvent.trim();
    if (!name) return flashEmit('Enter an event name first');
    let arg: unknown = {};
    const raw = f.sioPayload.trim();
    if (raw) {
      try {
        arg = JSON.parse(raw);
      } catch {
        return flashEmit('Payload is not valid JSON');
      }
    }
    const body = JSON.stringify([name, arg]);
    ws.send(`42${nsPrefix(f)}${body}`);
    push(id, { dir: 'out', at: new Date().toISOString(), text: body });
  };

  const persistSaved = (next: { name: string; form: WsForm }[]) => {
    setSaved(next);
    localStorage.setItem(LS_SAVED, JSON.stringify(next));
  };

  const [flashMsg, flash] = useFlash();
  // The Emit button sits in the right column; its refusals belong there,
  // not under the saved-connection row on the left.
  const [emitMsg, flashEmit] = useFlash();


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
  const sio = form.mode === 'sio';
  const st = stateMap[active.id] ?? { s: 'idle' as const };
  const live = st.s === 'live';
  const connState = st.s;
  const editable = st.s === 'idle' || st.s === 'error';
  const msgs = msgsMap[active.id] ?? [];
  const filter = filterMap[active.id] ?? '';
  const fq = filter.trim().toLowerCase();
  const shown = fq ? msgs.filter((m) => m.text.toLowerCase().includes(fq)) : msgs;

  // one wording for connection state across every streaming panel
  const connText =
    connState === 'live'
      ? 'Connected'
      : connState === 'connecting'
        ? 'Connecting…'
        : connState === 'error'
          ? `Error — ${st.msg}`
          : `Disconnected${st.msg ? ` · ${st.msg}` : ''}`;
  const connCls = connState === 'live' ? 'status ok' : connState === 'error' ? 'status bad' : 'status';

  const switchMode = (mode: WsForm['mode']) => {
    if (!editable) disconnect(active.id);
    set('mode', mode);
  };

  return (
    <div className="grpc-wrap">
      <div className="req-tabs" role="tablist" aria-label="Connections">
        {tabs.map((t) => {
          const s = stateMap[t.id]?.s;
          return (
            <button
              type="button"
              key={t.id}
              className={`req-tab ${t.id === activeId ? 'active' : ''}`}
              role="tab"
              aria-selected={t.id === activeId}
              onClick={() => setActiveId(t.id)}
              title={t.form.url}
            >
              {s === 'live' ? '🟢 ' : s === 'connecting' ? '🟡 ' : s === 'error' ? '🔴 ' : ''}
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
          );
        })}
        <button
          type="button"
          className="req-tab req-tab-add"
          aria-label="New tab"
          title="New tab"
          onClick={addTab}
        >+</button>
      </div>

      <div className="layout">
        <div className="left">
          <h3>
            {sse ? 'SSE' : sio ? 'Socket.IO' : 'WebSocket'}{' '}
            <span className="badge">live stream</span>
          </h3>
          <div className="tabs" role="tablist" aria-label="Transport">
            {([
              ['ws', 'WebSocket'],
              ['sio', 'Socket.IO'],
              ['sse', 'SSE'],
            ] as const).map(([m, label]) => (
              <button
                type="button"
                key={m}
                className={form.mode === m ? 'tab active' : 'tab'}
                role="tab"
                aria-selected={form.mode === m}
                onClick={() => switchMode(m)}
              >
                {label}
              </button>
            ))}
          </div>

          <label>Saved connection</label>
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
            <SaveAs
              canSave={() => (form.url.trim() ? null : 'Enter a URL first')}
              onSave={(name) => {
                persistSaved([...saved.filter((s) => s.name !== name), { name, form }]);
                setPicked(name);
                return `Saved "${name}"`;
              }}
              onMessage={flash}
            />
            <button className="btn-field btn-danger" disabled={!picked} onClick={() => { persistSaved(saved.filter((s) => s.name !== picked)); setPicked(''); }}>
              Delete
            </button>
          </div>
          {flashMsg && <div className="toast">{flashMsg}</div>}

          <label>URL</label>
          <div className="row field-row">
            <input
              className="grow"
              value={form.url}
              spellCheck={false}
              placeholder={sse ? 'https://host/events' : sio ? 'http://host:3000' : 'wss://host/path'}
              disabled={!editable}
              onChange={(e) => set('url', e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && connect(active.id)}
            />
            <button className={`btn-field ${live || connState === 'connecting' ? 'btn-on' : ''}`} onClick={() => connect(active.id)}>
              {live || connState === 'connecting' ? 'Disconnect' : 'Connect'}
            </button>
          </div>
          <div className="hint">
            {sse
              ? 'http:// or https://'
              : sio
                ? 'the server root — the handshake path below is appended'
                : 'ws:// or wss://'}
          </div>

          {sio && (
            <>
              <label>Path</label>
              <input
                value={form.sioPath}
                spellCheck={false}
                placeholder="/socket.io"
                disabled={!editable}
                onChange={(e) => set('sioPath', e.target.value)}
              />
              <div className="hint">where Socket.IO is mounted on the server</div>

              <label>Namespace</label>
              <input
                value={form.sioNamespace}
                spellCheck={false}
                placeholder="/"
                disabled={!editable}
                onChange={(e) => set('sioNamespace', e.target.value)}
              />
              <div className="hint">sent in the CONNECT packet · leave as / for the default</div>

              <label>Handshake query</label>
              <input
                value={form.sioQuery}
                spellCheck={false}
                placeholder="token=abc&room=1"
                disabled={!editable}
                onChange={(e) => set('sioQuery', e.target.value)}
              />
              <div className="hint">appended to the handshake URL · for servers that read auth there</div>

              <label>Auth JSON</label>
              <input
                value={form.sioAuth}
                spellCheck={false}
                placeholder={'{"token":"…"}'}
                disabled={!editable}
                onChange={(e) => set('sioAuth', e.target.value)}
              />
              <div className="hint">carried in the CONNECT packet · for servers that read auth there</div>
            </>
          )}

          <label>Headers</label>
          <textarea rows={4} value={form.headers} spellCheck={false} placeholder="authorization: Bearer …" disabled={!editable} onChange={(e) => set('headers', e.target.value)} />
          <div className="hint">One <code>k: v</code> per line — Authorization and the like.</div>

          {!sse && !sio && (
            <>
              <label>Subprotocols</label>
              <input value={form.protocols} spellCheck={false} placeholder="graphql-ws" disabled={!editable} onChange={(e) => set('protocols', e.target.value)} />
              <div className="hint">Optional, comma-separated.</div>
            </>
          )}

          <div className={`${connCls} mt-4`}>{connText}</div>
        </div>

        <div className="right">
          {sse ? (
            <div className="hint">
              SSE is receive-only — connect on the left and events stream below. Only the default
              (unnamed) <code>message</code> events are shown.
            </div>
          ) : sio ? (
            <>
              <label>Event</label>
              <input
                value={form.sioEvent}
                spellCheck={false}
                placeholder="chat:message"
                onChange={(e) => set('sioEvent', e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) emitEvent(active.id); }}
              />
              <div className="hint">the name the server listens for</div>

              <label>Payload JSON</label>
              <textarea
                rows={4}
                value={form.sioPayload}
                spellCheck={false}
                placeholder={'{"id":1}'}
                onChange={(e) => set('sioPayload', e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) emitEvent(active.id); }}
              />
              <div className="hint"><kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>Enter</kbd> emits.</div>
              {/* Deliberately always enabled: a refusal that names its reason
                  beats a dead button with no explanation. */}
              <button onClick={() => emitEvent(active.id)}>Emit</button>
              {emitMsg && <div className="toast">{emitMsg}</div>}
            </>
          ) : (
            <>
              <label>Send a message</label>
              <textarea
                rows={4}
                value={outboxMap[active.id] ?? ''}
                spellCheck={false}
                placeholder={live ? '{"type":"subscribe",…}' : 'connect first'}
                disabled={!live}
                onChange={(e) => setOutboxMap((m) => ({ ...m, [active.id]: e.target.value }))}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendMsg(active.id); }}
              />
              <div className="hint"><kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>Enter</kbd> sends.</div>
              <button disabled={!live} onClick={() => sendMsg(active.id)}>Send</button>
            </>
          )}

          <div className="section">
            {msgs.length > 0 && (
              <div className="feed-head inline">
                <span className="count">{fq ? `${shown.length} / ${msgs.length}` : msgs.length} messages</span>
                <input
                  className="grow"
                  placeholder="filter messages"
                  value={filter}
                  spellCheck={false}
                  onChange={(e) => setFilterMap((m) => ({ ...m, [active.id]: e.target.value }))}
                />
                <button className="btn-field btn-danger" title="Discard the messages received so far" onClick={() => setMsgsMap((m) => ({ ...m, [active.id]: [] }))}>Clear</button>
              </div>
            )}
            {msgs.length === 0 && connState !== 'live' && (
              <div className="empty">
                <div className="empty-icon">◈</div>
                <div className="empty-title">Not connected</div>
                <div className="empty-hint">Enter a URL on the left and press <kbd>Connect</kbd> to stream messages here.</div>
              </div>
            )}
            {msgs.length === 0 && connState === 'live' && (
              <div className="empty">
                <div className="empty-icon">◈</div>
                <div className="empty-title">Connected, no messages yet</div>
                <div className="empty-hint">
                  {sse
                    ? 'Events pushed by the server will appear here.'
                    : sio
                      ? 'Events pushed by the server appear here. Emit one above to check the round trip.'
                      : 'Incoming frames appear here. Send a message above to check the round trip.'}
                </div>
              </div>
            )}
            {msgs.length > 0 && (
              <div className="feed">
                {shown.map((m) => {
                  const pretty = m.dir !== 'sys' ? tryJson(m.text) : null;
                  return (
                    <div key={m.id} className={`feed-item ws-${m.dir}`}>
                      <span className="feed-ch">{m.dir === 'in' ? '↓ recv' : m.dir === 'out' ? '↑ sent' : '•'}</span>
                      <span className="feed-time">{new Date(m.at).toLocaleTimeString()}</span>
                      <div className="feed-msg break">{pretty ?? m.text}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
