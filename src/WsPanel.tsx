import { useEffect, useMemo, useRef, useState } from 'react';
import { useFlash } from './useFlash';
import { SaveAs } from './SaveAs';
import { ConnPill, Empty, FeedRow, LongField, PanelHead, ReqTabs, Section, usePersist } from './ui';
import { EXAMPLES } from './examples';
import { OutcomeView, type Outcome } from './AttemptLog';
import { downloadJson, isSensitiveHeader, maskUrl } from './share';
import { maskSecrets } from './vars';
import type { AttemptLog } from './types';

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
interface Msg { id: number; dir: 'in' | 'out' | 'sys'; at: string; text: string; channel?: string; meta?: string }
/** What the server answered instead of a stream (a 401, say), passed on by the proxy. */
interface Refusal { status: number; body?: string; bodyError?: string | null }
type St = {
  s: 'idle' | 'connecting' | 'live' | 'error';
  /** why it closed, while idle */
  msg?: string;
  /** why it failed, while in error */
  outcome?: Outcome;
  response?: Refusal;
  /** the record of the handshake that opened the stream */
  openLog?: AttemptLog;
};

const MOD = navigator.platform.includes('Mac') ? '⌘' : 'Ctrl';

/** RFC 6455 close codes, for reading a close at a glance. */
const CLOSE_CODES: Record<number, string> = {
  1000: 'normal closure',
  1001: 'going away',
  1002: 'protocol error',
  1003: 'unsupported data',
  1005: 'no status code',
  1006: 'abnormal closure',
  1007: 'invalid payload',
  1008: 'policy violation',
  1009: 'message too big',
  1010: 'missing extension',
  1011: 'server error',
  1012: 'service restart',
  1013: 'try again later',
  1014: 'bad gateway',
  1015: 'TLS handshake failed',
};
function closeText(code: number, reason?: string): string {
  const name = CLOSE_CODES[code] ?? (code >= 4000 ? 'application-defined' : '');
  return `closed ${code}${name ? ` (${name})` : ''}${reason ? ` · ${reason}` : ''}`;
}
/** Headers one per line, credential values blanked: the feed can be copied and shared. */
function headerLines(h?: Record<string, string> | null): string {
  return Object.entries(h ?? {})
    .map(([k, v]) => `${k}: ${isSensitiveHeader(k) ? '•••' : v}`)
    .join('\n');
}
/** A failure as connection state: flat text, or the proxy's error envelope / JSON error body. */
function errorState(j: any, fallback: string): St {
  return {
    s: 'error',
    outcome: { ok: false, text: j?.error || fallback, ms: j?.ms, detail: j?.detail ?? null, log: j?.log ?? null },
    response: typeof j?.status === 'number' ? { status: j.status, body: j.body, bodyError: j.bodyError } : undefined,
  };
}

/* A binary frame arrives base64-encoded with its byte count, because the wire
   is JSON and the bytes are not guaranteed to be valid UTF-8. Label it so the
   feed cannot be mistaken for text the server actually sent. */
function frameText(env: { data?: unknown; encoding?: string; bytes?: number }): string {
  const data = String(env.data ?? '');
  return env.encoding === 'base64' ? `[binary ${env.bytes ?? 0} bytes, base64]\n${data}` : data;
}
const MODE_DEFAULT: Record<WsForm['mode'], string> = { ws: 'wss://', sio: 'http://', sse: 'https://' };

/** A URL nobody typed: empty, a bare scheme, or one of the examples. */
function isPlaceholderUrl(url: string): boolean {
  const u = url.trim();
  return !u || /^(wss?|https?):\/\/$/i.test(u) || u === EXAMPLES.ws.url || u === EXAMPLES.sse.url;
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
  const sseRefs = useRef<Map<number, AbortController>>(new Map());
  const idRef = useRef(0);

  const setForm = (u: (f: WsForm) => WsForm) =>
    setTabs((ts) => ts.map((t) => (t.id === active.id ? { ...t, form: u(t.form) } : t)));
  const set = <K extends keyof WsForm>(k: K, v: WsForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  const persisted = useMemo(() => ({ tabs, activeId }), [tabs, activeId]);
  usePersist(LS_TABS, persisted, () => JSON.stringify({ tabs, activeId }));
  useEffect(
    () => () => {
      wsRefs.current.forEach((ws) => ws.close());
      sseRefs.current.forEach((ac) => ac.abort());
    },
    [],
  );

  const push = (id: number, m: Omit<Msg, 'id'>) =>
    setMsgsMap((mm) => ({ ...mm, [id]: [{ ...m, id: idRef.current++ }, ...(mm[id] ?? [])].slice(0, 300) }));
  const setSt = (id: number, s: St) => setStateMap((m) => ({ ...m, [id]: s }));

  /** The header lines as an object, or which lines cannot be one (no `name:` part). */
  const headersObj = (f: WsForm): { h: Record<string, string>; bad: string[] } => {
    const h: Record<string, string> = {};
    const bad: string[] = [];
    f.headers.split('\n').forEach((line, n) => {
      if (!line.trim()) return;
      const i = line.indexOf(':');
      if (i > 0 && line.slice(0, i).trim()) h[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      else bad.push(`line ${n + 1} ("${line.trim().slice(0, 40)}") has no "name:" part`);
    });
    return { h, bad };
  };
  /** The headers query parameter (the lines were checked by `notReady`). */
  const headersParam = (f: WsForm): string => btoa(unescape(encodeURIComponent(JSON.stringify(headersObj(f).h))));

  /** Why the form cannot connect yet, or null when it can. */
  const notReady = (f: WsForm): string | null => {
    const url = f.url.trim();
    if (!url || /^(wss?|https?):\/\/$/i.test(url)) return 'Enter a URL first.';
    if (f.mode === 'sse' && !/^https?:\/\//i.test(url)) return 'The URL must start with http:// or https://.';
    if (f.mode === 'sio' && !sioTarget(f)) return 'The URL must start with http://, https://, ws:// or wss:// and name a host.';
    if (f.mode === 'ws' && !/^wss?:\/\//i.test(url)) return 'The URL must start with ws:// or wss://.';
    const { bad } = headersObj(f);
    return bad.length ? `Fix the headers: ${bad.join('; ')}.` : null;
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
      push(id, { dir: 'sys', at: at(), text: 'engine.io open' });
      send(`40${nsPrefix(f)}${f.sioAuth.trim()}`);
      return;
    }
    if (engine === '2') return send('3'); // ping → pong
    if (engine === '1') return push(id, { dir: 'sys', at: at(), text: 'engine.io close' });
    if (engine !== '4') return;

    const packet = raw.slice(1);
    const type = packet[0];
    let rest = packet.slice(1);
    if (rest.startsWith('/')) {
      const comma = rest.indexOf(',');
      if (comma >= 0) rest = rest.slice(comma + 1);
    }
    if (type === '0') {
      setStateMap((m) => ({ ...m, [id]: { s: 'live', openLog: m[id]?.openLog } }));
      push(id, { dir: 'sys', at: at(), text: 'Connected (Socket.IO)' });
    } else if (type === '1') {
      push(id, { dir: 'sys', at: at(), text: 'Disconnected by the server' });
    } else if (type === '4') {
      setSt(id, { s: 'error', outcome: { ok: false, text: `The server refused the Socket.IO connection (connect_error)${rest ? `: ${rest}` : ''}` } });
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
    sseRefs.current.get(id)?.abort();
    sseRefs.current.delete(id);
    setSt(id, { s: 'idle' });
  };

  /* SSE goes through fetch, not EventSource: the proxy hands back NDJSON (one line per event,
     with its name, id and retry), and when the server refuses the stream, a JSON error the
     browser can read; EventSource would see neither. */
  const connectSse = async (id: number, f: WsForm) => {
    const headers = headersParam(f);
    const q = new URLSearchParams({ target: f.url.trim(), headers });
    const ac = new AbortController();
    sseRefs.current.set(id, ac);
    const mine = () => sseRefs.current.get(id) === ac;
    const now = () => new Date().toISOString();
    setSt(id, { s: 'connecting' });

    let r: Response;
    try {
      r = await fetch(`/api/sse/proxy?${q}`, { signal: ac.signal });
    } catch (e) {
      if (!mine()) return;
      sseRefs.current.delete(id);
      setSt(id, errorState(null, `Could not reach conduit's SSE proxy: ${(e as Error).message || e}`));
      return;
    }
    if (!r.ok || !(r.headers.get('content-type') ?? '').includes('ndjson')) {
      const text = await r.text().catch(() => '');
      if (!mine()) return;
      sseRefs.current.delete(id);
      let j: any = null;
      try {
        j = JSON.parse(text);
      } catch {
        /* not JSON */
      }
      setSt(id, errorState(j, `Conduit's SSE proxy answered ${r.status}${text ? `: ${text.slice(0, 200)}` : ''}`));
      return;
    }

    const reader = r.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    const handle = (env: any) => {
      if (env.kind === 'open') {
        setSt(id, { s: 'live', openLog: env.log });
        const info = [`HTTP ${env.status}`, env.contentType || 'no content-type', `${env.ms} ms`].join(' · ');
        push(id, { dir: 'sys', at: now(), text: headerLines(env.headers), channel: `Connected (SSE) · ${info}`, meta: env.warning || undefined });
      } else if (env.kind === 'event') {
        const meta = [env.event !== 'message' ? `event: ${env.event}` : '', env.id != null ? `id: ${env.id}` : '', env.retry != null ? `retry: ${env.retry} ms` : '']
          .filter(Boolean)
          .join(' · ');
        push(id, { dir: 'in', at: env.at, text: env.data, channel: `↓ ${env.event}`, meta: meta || undefined });
      } else if (env.kind === 'close') {
        setStateMap((m) => ({ ...m, [id]: { s: 'idle', msg: env.reason, openLog: m[id]?.openLog } }));
        push(id, { dir: 'sys', at: now(), text: env.reason });
      } else if (env.kind === 'error') {
        setSt(id, errorState(env, 'The stream failed'));
      }
    };
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          try {
            handle(JSON.parse(line));
          } catch {
            push(id, { dir: 'sys', at: now(), text: `Unreadable line from the proxy: ${line.slice(0, 200)}` });
          }
        }
      }
    } catch (e) {
      if (mine()) setSt(id, errorState(null, `The stream from conduit broke: ${(e as Error).message || e}`));
    } finally {
      if (mine()) sseRefs.current.delete(id);
    }
  };

  const connectWs = (id: number, f: WsForm) => {
    const sio = f.mode === 'sio';
    const target = (sio ? sioTarget(f) : f.url.trim()) ?? '';
    const headers = headersParam(f);
    const q = new URLSearchParams({
      target,
      headers,
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
        const info = [
          env.status != null ? `HTTP ${env.status}` : '',
          env.protocol ? `subprotocol ${env.protocol}` : f.protocols.trim() ? 'no subprotocol accepted' : '',
          env.ms != null ? `${env.ms} ms` : '',
        ]
          .filter(Boolean)
          .join(' · ');
        push(id, {
          dir: 'sys',
          at: new Date().toISOString(),
          text: headerLines(env.headers),
          channel: `${sio ? 'Transport connected' : 'Connected'}${info ? ` · ${info}` : ''}`,
        });
        setSt(id, { s: sio ? 'connecting' : 'live', openLog: env.log });
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
        const text = `${env.by === 'server' ? 'Server ' : ''}${closeText(Number(env.code), env.reason)}`;
        setStateMap((m) => ({ ...m, [id]: { s: 'idle', msg: text, openLog: m[id]?.openLog } }));
        push(id, { dir: 'sys', at: new Date().toISOString(), text });
        wsRefs.current.delete(id);
      } else if (env.kind === 'error') {
        setSt(id, errorState(env, 'The connection failed'));
      }
    };
    ws.onerror = () => {
      // the proxy's own error envelope, when there was one, says more than this
      setStateMap((m) =>
        m[id]?.s === 'error'
          ? m
          : { ...m, [id]: errorState(null, "The connection to conduit's WebSocket proxy failed") },
      );
      // drop the ref so the next click reconnects instead of toggling to disconnect
      if (wsRefs.current.get(id) === ws) wsRefs.current.delete(id);
    };
    ws.onclose = (ev) => {
      if (wsRefs.current.get(id) === ws && ev.code !== 1000 && ev.code !== 1005) {
        push(id, { dir: 'sys', at: new Date().toISOString(), text: `Proxy ${closeText(ev.code, ev.reason)}` });
      }
      if (wsRefs.current.get(id) === ws) {
        wsRefs.current.delete(id);
        setStateMap((m) => ({ ...m, [id]: m[id]?.s === 'error' ? m[id] : { s: 'idle' } }));
      }
    };
    wsRefs.current.set(id, ws);
  };

  const connect = (id: number) => {
    if (wsRefs.current.get(id) || sseRefs.current.get(id)) return disconnect(id);
    const t = tabs.find((x) => x.id === id);
    if (!t || notReady(t.form)) return;
    const prev = msgsMap[id];
    if (prev?.length && !(prev[0].dir === 'sys' && prev[0].channel === 'Disconnected'))
      push(id, { dir: 'sys', at: new Date().toISOString(), text: '', channel: 'Disconnected', meta: 'Messages below are from the previous connection.' });
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

  /** Why an event cannot be sent yet, or null when it can: shown next to the disabled button. */
  const emitBlock = (f: WsForm, isLive: boolean): string | null => {
    if (!isLive) return 'Connect first.';
    if (!f.sioEvent.trim()) return 'Enter an event name first.';
    const raw = f.sioPayload.trim();
    if (raw) {
      try {
        JSON.parse(raw);
      } catch {
        return 'The payload is not valid JSON.';
      }
    }
    return null;
  };

  const emitEvent = (id: number) => {
    const f = tabs.find((t) => t.id === id)?.form;
    const ws = wsRefs.current.get(id);
    if (!f || ws?.readyState !== WebSocket.OPEN || emitBlock(f, stateMap[id]?.s === 'live')) return;
    const raw = f.sioPayload.trim();
    const body = JSON.stringify([f.sioEvent.trim(), raw ? JSON.parse(raw) : {}]);
    ws.send(`42${nsPrefix(f)}${body}`);
    push(id, { dir: 'out', at: new Date().toISOString(), text: body });
  };

  const persistSaved = (next: { name: string; form: WsForm }[]) => {
    setSaved(next);
    localStorage.setItem(LS_SAVED, JSON.stringify(next));
  };

  const [flashMsg, flash] = useFlash();


  // ── tabs ─────────────────────────────────────────────────────────────────
  const tabLabel = (t: WTab) => {
    const host = t.form.url.replace(/^(wss?|https?):\/\//, '').split(/[/?]/)[0] || t.form.mode;
    return host;
  };
  const addTab = () => {
    const id = Math.max(0, ...tabs.map((t) => t.id)) + 1;
    const f = active.form;
    setTabs((ts) => [
      ...ts,
      {
        id,
        form: hydrate({
          mode: f.mode,
          url: f.url,
          headers: f.headers,
          protocols: f.protocols,
          sioPath: f.sioPath,
          sioNamespace: f.sioNamespace,
          sioQuery: f.sioQuery,
          sioAuth: f.sioAuth,
        }),
      },
    ]);
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
  const shown = fq
    ? msgs.filter((m) => `${m.channel ?? ''} ${m.meta ?? ''} ${m.text}`.toLowerCase().includes(fq))
    : msgs;

  // one wording for connection state across every streaming panel
  const connText =
    connState === 'live'
      ? 'Connected'
      : connState === 'connecting'
        ? 'Connecting…'
        : connState === 'error'
          ? 'Error'
          : 'Disconnected';
  const blocked = notReady(form);
  const emitWhy = sio ? emitBlock(form, live) : null;
  const outbox = outboxMap[active.id] ?? '';
  // the values of credential headers: masked wherever a log or a copy leaves the app
  const secrets = Object.entries(headersObj(form).h)
    .filter(([k, v]) => isSensitiveHeader(k) && v)
    .map(([, v]) => v);

  const switchMode = (mode: WsForm['mode']) => {
    if (!editable) disconnect(active.id);
    setForm((f) => ({ ...f, mode, url: f.mode !== mode && isPlaceholderUrl(f.url) ? MODE_DEFAULT[mode] : f.url }));
  };

  const loadExample = (mode: 'ws' | 'sse') => {
    if (!editable) disconnect(active.id);
    setForm((f) => ({ ...f, mode, url: mode === 'sse' ? EXAMPLES.sse.url : EXAMPLES.ws.url }));
  };

  const pillState = connState === 'live' ? 'live' : connState === 'connecting' ? 'connecting' : connState === 'error' ? 'error' : 'idle';

  return (
    <div className="grpc-wrap">
      <ReqTabs
        tabs={tabs}
        activeId={activeId}
        ariaLabel="Connections"
        label={tabLabel}
        title={(t) => t.form.url}
        state={(t) => {
          const s = stateMap[t.id]?.s;
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
            title="WebSocket / SSE"
            badge={sse ? 'SSE' : sio ? 'Socket.IO' : 'WebSocket'}
            tagline="Open a WebSocket, Socket.IO or Server-Sent Events stream and watch messages arrive."
          />
          <div className="seg" role="group" aria-label="Protocol">
            {(
              [
                ['ws', 'WebSocket'],
                ['sio', 'Socket.IO'],
                ['sse', 'SSE'],
              ] as const
            ).map(([m, label]) => (
              <button
                type="button"
                key={m}
                className={form.mode === m ? 'on' : ''}
                aria-pressed={form.mode === m}
                onClick={() => switchMode(m)}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="saved-bar mt-3">
            <select
              value={picked}
              aria-label="Saved connections"
              onChange={(e) => {
                setPicked(e.target.value);
                const s = saved.find((x) => x.name === e.target.value);
                if (s) setForm(() => hydrate(s.form));
              }}
            >
              <option value="">{saved.length ? 'Open a saved connection…' : 'No saved connections yet'}</option>
              {saved.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name}
                </option>
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
            <button
              className="btn-secondary btn-danger"
              disabled={!picked}
              onClick={() => {
                persistSaved(saved.filter((s) => s.name !== picked));
                setPicked('');
              }}
            >
              Delete
            </button>
          </div>
          {flashMsg && <div className="toast">{flashMsg}</div>}

          <Section title="Connection" actions={<ConnPill state={pillState} text={connText} />}>
            <div className="row row-tight">
              <LongField
                url
                className="grow"
                value={form.url}
                spellCheck={false}
                aria-label="URL"
                placeholder={sse ? 'https://host/events' : sio ? 'http://host:3000' : 'wss://echo.websocket.org'}
                disabled={!editable}
                onChange={(v) => set('url', v)}
                onEnter={() => connect(active.id)}
              />
              {live ? (
                <button className="btn-secondary btn-on" onClick={() => disconnect(active.id)}>
                  Disconnect
                </button>
              ) : connState === 'connecting' ? (
                <>
                  <button className="btn-primary" disabled>
                    Connecting…
                  </button>
                  <button className="btn-ghost" title="Stop waiting for the server" onClick={() => disconnect(active.id)}>
                    Cancel
                  </button>
                </>
              ) : (
                <button className="btn-primary" disabled={!!blocked} title={blocked ?? undefined} onClick={() => connect(active.id)}>
                  Connect
                </button>
              )}
            </div>
            <div className="hint">
              {blocked && editable
                ? blocked
                : sse
                  ? 'An http:// or https:// endpoint that streams text/event-stream. Enter connects.'
                  : sio
                    ? 'The server root, e.g. http://localhost:3000. The handshake path below is added for you.'
                    : 'A ws:// or wss:// URL. Enter connects; fields lock while connected.'}
            </div>
            {connState === 'idle' && st.msg && <div className="hint">Last connection: {st.msg}</div>}
            {connState === 'error' && <OutcomeView o={st.outcome} secrets={secrets} />}
            {connState === 'error' && st.response?.body && (
              <>
                <div className="block-label">Body of the {st.response.status} answer</div>
                <pre className="feed-msg">{st.response.body}</pre>
              </>
            )}
            {connState === 'error' && st.response?.bodyError && (
              <div className="hint">The body of the answer could not be read: {st.response.bodyError}</div>
            )}
            {connState === 'live' && st.openLog && (
              <OutcomeView o={{ ok: true, text: 'Connected', ms: st.openLog.durationMs, log: st.openLog }} secrets={secrets} />
            )}

            {sio && (
              <>
                <div className="conn-row">
                  <div className="grow">
                    <label>Path</label>
                    <input value={form.sioPath} spellCheck={false} placeholder="/socket.io" disabled={!editable} onChange={(e) => set('sioPath', e.target.value)} />
                  </div>
                  <div className="grow">
                    <label>Namespace</label>
                    <input value={form.sioNamespace} spellCheck={false} placeholder="/" disabled={!editable} onChange={(e) => set('sioNamespace', e.target.value)} />
                  </div>
                </div>
                <div className="hint">Where Socket.IO is mounted, and the namespace to join (/ is the default).</div>

                <label>Handshake query</label>
                <LongField url aria-label="Handshake query" value={form.sioQuery} spellCheck={false} placeholder="token=abc&room=1" disabled={!editable} onChange={(v) => set('sioQuery', v)} />
                <div className="hint">Added to the handshake URL, for servers that read auth there.</div>

                <label>Auth JSON</label>
                <LongField aria-label="Auth JSON" value={form.sioAuth} spellCheck={false} placeholder={'{"token":"…"}'} disabled={!editable} onChange={(v) => set('sioAuth', v)} />
                <div className="hint">Sent in the CONNECT packet, for servers that read auth there.</div>
              </>
            )}
          </Section>

          <Section title="Headers" hint={<>One <code>name: value</code> per line, e.g. Authorization.</>}>
            <textarea
              rows={3}
              value={form.headers}
              spellCheck={false}
              aria-label="Headers"
              placeholder="authorization: Bearer …"
              disabled={!editable}
              onChange={(e) => set('headers', e.target.value)}
            />
            {!sse && !sio && (
              <>
                <label>Subprotocols</label>
                <LongField aria-label="Subprotocols" value={form.protocols} spellCheck={false} placeholder="graphql-ws" disabled={!editable} onChange={(v) => set('protocols', v)} />
                <div className="hint">Optional, comma-separated.</div>
              </>
            )}
          </Section>
        </div>

        <div className="right">
          {sse ? (
            <div className="hint m-0 mb-3">
              SSE is receive-only: connect on the left and events stream below, named events included, each with its{' '}
              <code>event</code>, <code>id</code> and <code>retry</code>.
            </div>
          ) : sio ? (
            <Section flush title="Send an event">
              <div className="row">
                <input
                  className="w-lg"
                  value={form.sioEvent}
                  spellCheck={false}
                  aria-label="Event name"
                  placeholder="chat:message"
                  onChange={(e) => set('sioEvent', e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) emitEvent(active.id);
                  }}
                />
                <span className="hint grow">The event name the server listens for.</span>
              </div>
              <textarea
                className="mt-2"
                rows={4}
                value={form.sioPayload}
                spellCheck={false}
                aria-label="Payload JSON"
                placeholder={'{"id":1}'}
                onChange={(e) => set('sioPayload', e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) emitEvent(active.id);
                }}
              />
              <div className="inline mt-2">
                <button className="btn-primary" disabled={!!emitWhy} onClick={() => emitEvent(active.id)}>
                  Send
                </button>
                <span className="hint m-0">
                  {emitWhy ?? (
                    <>
                      JSON payload. <kbd>{MOD}↵</kbd> sends.
                    </>
                  )}
                </span>
              </div>
            </Section>
          ) : (
            <Section flush title="Send a message">
              <textarea
                rows={4}
                value={outbox}
                spellCheck={false}
                aria-label="Message"
                placeholder={live ? '{"type":"subscribe"}' : 'Connect first'}
                disabled={!live}
                onChange={(e) => setOutboxMap((m) => ({ ...m, [active.id]: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendMsg(active.id);
                }}
              />
              <div className="inline mt-2">
                <button className="btn-primary" disabled={!live || !outbox.trim()} onClick={() => sendMsg(active.id)}>
                  Send
                </button>
                <span className="hint m-0">
                  {!live ? (
                    'Connect first.'
                  ) : !outbox.trim() ? (
                    'Type a message first.'
                  ) : (
                    <>
                      <kbd>{MOD}↵</kbd> sends.
                    </>
                  )}
                </span>
              </div>
            </Section>
          )}

          <Section title="Messages">
            {msgs.length > 0 && (
              <div className="feed-head mt-0">
                <span className="count">{fq ? `${shown.length} / ${msgs.length}` : msgs.length} messages</span>
                <input
                  className="grow"
                  placeholder="Filter messages"
                  aria-label="Filter messages"
                  value={filter}
                  spellCheck={false}
                  onChange={(e) => setFilterMap((m) => ({ ...m, [active.id]: e.target.value }))}
                />
                <button
                  className="btn-ghost btn-sm"
                  title="Save every message in this feed, oldest first, as a JSON file"
                  onClick={() =>
                    downloadJson(form.mode, 'feed', {
                      url: maskUrl(form.url),
                      mode: form.mode,
                      exportedAt: new Date().toISOString(),
                      messages: [...msgs].reverse().map(({ dir, at, channel, meta, text }) => ({
                        dir,
                        at,
                        channel,
                        meta: meta && maskSecrets(meta, secrets),
                        text: maskSecrets(text, secrets),
                      })),
                    })
                  }
                >
                  Export JSON
                </button>
                <button
                  className="btn-ghost btn-sm"
                  title="Discard the messages received so far"
                  onClick={() => setMsgsMap((m) => ({ ...m, [active.id]: [] }))}
                >
                  Clear
                </button>
              </div>
            )}
            {msgs.length === 0 && connState !== 'live' && (
              <Empty
                icon="⇅"
                title="No messages yet"
                hint={
                  sse ? (
                    <>
                      Enter a URL on the left and press <kbd>Connect</kbd>. To try it, <code>{EXAMPLES.sse.url}</code> streams
                      Wikipedia edits as they happen.
                    </>
                  ) : (
                    <>
                      Enter a URL on the left and press <kbd>Connect</kbd>. To try it, <code>wss://echo.websocket.org</code>{' '}
                      sends back whatever you send.
                    </>
                  )
                }
              >
                <button className="btn-secondary btn-sm" onClick={() => loadExample(sse ? 'sse' : 'ws')}>
                  {sse ? 'Use the Wikimedia stream' : 'Use the echo server'}
                </button>
              </Empty>
            )}
            {msgs.length === 0 && connState === 'live' && (
              <Empty
                icon="⇅"
                title="No messages yet"
                hint={
                  sse ? (
                    'Connected. Events pushed by the server will appear here.'
                  ) : (
                    <>
                      Connected. Messages from the server appear here; press <kbd>Send</kbd> above to check the round trip.
                    </>
                  )
                }
              />
            )}
            {msgs.length > 0 && (
              <div className="feed">
                {shown.map((m) => (
                  <FeedRow
                    key={m.id}
                    tone={`ws-${m.dir}`}
                    channel={m.channel ?? (m.dir === 'in' ? '↓ received' : m.dir === 'out' ? '↑ sent' : 'event')}
                    at={m.at}
                    text={m.text}
                    meta={m.meta}
                    pretty={m.dir !== 'sys'}
                    copy
                  />
                ))}
              </div>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}
