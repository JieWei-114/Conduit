import { useEffect, useMemo, useRef, useState } from 'react';
import AuthBox, { AUTH_DEFAULTS, authHeader, type AuthState } from './AuthBox';
import type {
  CallRequest,
  CallResult,
  FieldDef,
  HistoryEntry,
  ProtoInfo,
  RpcDef,
} from './types';

const LS_FORM = 'grpcwebtester.form.v3';
const LS_HISTORY = 'grpcwebtester.history.v1';
const LS_BASES = 'grpcwebtester.bases.v1';
const LS_BODIES = 'conduit.grpc.bodies.v1';
const LS_PINS = 'conduit.grpc.pins.v1';
const LS_TABS = 'conduit.grpc.tabs.v1';
const LS_PREFIXES = 'conduit.grpc.prefixes.v1';
const LS_TARGETS = 'conduit.grpc.targets.v1';
const HISTORY_MAX = 30;

// gRPC status code → canonical name (grpc.io status codes)
const GRPC_STATUS: Record<string, string> = {
  '0': 'OK', '1': 'CANCELLED', '2': 'UNKNOWN', '3': 'INVALID_ARGUMENT',
  '4': 'DEADLINE_EXCEEDED', '5': 'NOT_FOUND', '6': 'ALREADY_EXISTS',
  '7': 'PERMISSION_DENIED', '8': 'RESOURCE_EXHAUSTED', '9': 'FAILED_PRECONDITION',
  '10': 'ABORTED', '11': 'OUT_OF_RANGE', '12': 'UNIMPLEMENTED', '13': 'INTERNAL',
  '14': 'UNAVAILABLE', '15': 'DATA_LOSS', '16': 'UNAUTHENTICATED',
};
const statusLabel = (code: string) =>
  code ? `${code}${GRPC_STATUS[code] ? ' ' + GRPC_STATUS[code] : ''}` : '';

interface FormState {
  root: string;
  proto: string;
  rpc: string;
  base: string;
  prefix: string;
  urlOverride: string;
  auth: AuthState;
  extraHeaders: string;
  body: string;
  /** gateway = gRPC-Web through the gateway; direct = native gRPC to host:port */
  transport: 'gateway' | 'direct';
  targetHost: string;
  targetPort: string;
  plaintext: boolean;
}

const DEFAULTS: FormState = {
  root: '',
  proto: '',
  rpc: '',
  base: '',
  prefix: '',
  urlOverride: '',
  auth: AUTH_DEFAULTS,
  extraHeaders: '',
  body: '',
  transport: 'gateway',
  targetHost: 'localhost',
  targetPort: '50051',
  plaintext: true,
};

/** direct target as host:port — tolerates a pasted host:port in the Host field */
function buildTarget(host: string, port: string): string {
  let h = host.trim();
  let p = (port || '50051').trim();
  const m = h.match(/^(.+):(\d+)$/);
  if (m) {
    h = m[1];
    p = m[2];
  }
  return `${h}:${p}`;
}

// one-click templates for common request headers — edit values after inserting.
const QUICK_HEADERS: Record<string, string> = {
  'platform-id': 'platform-id: ',
  'x-env-tag': 'x-env-tag: ',
  'x-request-id': 'x-request-id: ',
  'accept-language': 'accept-language: en-US',
  'user-agent': 'user-agent: conduit',
  'x-api-key': 'x-api-key: ',
};

const SCALAR_DEFAULTS: Record<string, string> = {
  string: '""',
  bytes: '""',
  bool: 'false',
  double: '0',
  float: '0',
  int32: '0',
  int64: '0',
  uint32: '0',
  uint64: '0',
  sint32: '0',
  sint64: '0',
  fixed32: '0',
  fixed64: '0',
  sfixed32: '0',
  sfixed64: '0',
};

function load<T>(key: string, fallback: T): T {
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem(key) ?? 'null') };
  } catch {
    return fallback;
  }
}

function loadList<T>(key: string): T[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Restore state that was shared via URL hash (#s=base64json). */
function fromShareHash(): Partial<FormState> | null {
  const m = location.hash.match(/^#s=(.+)$/);
  if (!m) return null;
  try {
    return JSON.parse(decodeURIComponent(escape(atob(m[1]))));
  } catch {
    return null;
  }
}

// ── Chrome-style request tabs: each holds an independent request form. The
// response follows the ACTIVE tab (kept per tab, in memory); history is global.
interface ReqTab {
  id: number;
  form: FormState;
}

function loadTabs(): { tabs: ReqTab[]; activeId: number } {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_TABS) ?? 'null');
    if (raw && Array.isArray(raw.tabs) && raw.tabs.length) {
      const tabs: ReqTab[] = raw.tabs.map((t: any, i: number) => {
        const form = { ...DEFAULTS, ...(t.form ?? {}) };
        // migrate pre-split `target` ("host:port") into targetHost/targetPort
        if (t.form?.target && !t.form?.targetHost) {
          const m = String(t.form.target).match(/^(.+):(\d+)$/);
          form.targetHost = m ? m[1] : String(t.form.target);
          form.targetPort = m ? m[2] : '50051';
        }
        // migrate the pre-AuthBox flat `token` into auth.bearer
        if (t.form?.token && !t.form?.auth)
          form.auth = { ...AUTH_DEFAULTS, type: 'bearer', bearer: String(t.form.token) };
        form.auth = { ...AUTH_DEFAULTS, ...(form.auth ?? {}) };
        return { id: typeof t.id === 'number' ? t.id : i + 1, form };
      });
      const activeId = tabs.some((t) => t.id === raw.activeId) ? raw.activeId : tabs[0].id;
      return { tabs, activeId };
    }
  } catch {
    /* fall through to migration */
  }
  // migrate the pre-tabs single form into tab 1
  return { tabs: [{ id: 1, form: load(LS_FORM, DEFAULTS) }], activeId: 1 };
}

export default function GrpcPanel() {
  // one-time init: load tabs, apply a share-link payload to the active tab
  const initRef = useRef<{ tabs: ReqTab[]; activeId: number } | null>(null);
  if (!initRef.current) {
    const loaded = loadTabs();
    // one-time migration: earlier versions had dedicated platform-id / x-env-tag
    // fields; when they were folded into Extra headers the stored VALUES were
    // dropped, silently un-sending those headers. Carry them over once.
    const MIGR = 'conduit.grpc.hdrmigr.v1';
    if (!localStorage.getItem(MIGR)) {
      try {
        const legacy = JSON.parse(localStorage.getItem(LS_FORM) ?? '{}');
        const lines: string[] = [];
        if (legacy.platformId) lines.push(`platform-id: ${legacy.platformId}`);
        if (legacy.envTag) lines.push(`x-env-tag: ${legacy.envTag}`);
        if (lines.length)
          loaded.tabs = loaded.tabs.map((t) => ({
            ...t,
            form: {
              ...t.form,
              extraHeaders: t.form.extraHeaders
                ? `${t.form.extraHeaders.replace(/\n$/, '')}\n${lines.join('\n')}`
                : lines.join('\n'),
            },
          }));
      } catch {
        /* no legacy form — nothing to migrate */
      }
      localStorage.setItem(MIGR, '1');
    }
    const shared = fromShareHash();
    if (shared) {
      history.replaceState(null, '', location.pathname);
      loaded.tabs = loaded.tabs.map((t) =>
        t.id === loaded.activeId
          ? {
              ...t,
              // shared payloads never carry auth (stripped on export); keep the
              // tab's own auth and never let the spread null it out.
              form: { ...t.form, ...shared, auth: t.form.auth },
            }
          : t,
      );
    }
    initRef.current = loaded;
  }
  const [reqTabs, setReqTabs] = useState<ReqTab[]>(initRef.current.tabs);
  const [activeId, setActiveId] = useState<number>(initRef.current.activeId);
  const active = reqTabs.find((t) => t.id === activeId) ?? reqTabs[0];
  const form = active.form;

  const setActiveForm = (fn: (f: FormState) => FormState) =>
    setReqTabs((ts) => ts.map((t) => (t.id === active.id ? { ...t, form: fn(t.form) } : t)));

  // per-tab results & busy flags (in memory only — not persisted)
  const [resultsMap, setResultsMap] = useState<Record<number, CallResult | null>>({});
  const [busyMap, setBusyMap] = useState<Record<number, boolean>>({});
  const result = resultsMap[active.id] ?? null;
  const busy = !!busyMap[active.id];
  const setResultFor = (id: number, r: CallResult | null) =>
    setResultsMap((m) => ({ ...m, [id]: r }));

  const [protos, setProtos] = useState<string[]>([]);
  const [rootError, setRootError] = useState('');
  const [filter, setFilter] = useState('');
  const [info, setInfo] = useState<ProtoInfo | null>(null);
  const [histEntries, setHistEntries] = useState<HistoryEntry[]>(() =>
    loadList<HistoryEntry>(LS_HISTORY),
  );
  const [savedBases, setSavedBases] = useState<{ name: string; url: string }[]>(
    () => {
      // migrate old string[] shape → {name,url}[]
      const raw = loadList<unknown>(LS_BASES);
      return raw.map((b) =>
        typeof b === 'string' ? { name: b, url: b } : (b as { name: string; url: string }),
      );
    },
  );
  const [pickedEnv, setPickedEnv] = useState('');
  const [savedPrefixes, setSavedPrefixes] = useState<string[]>(() =>
    loadList<string>(LS_PREFIXES),
  );
  const [savedTargets, setSavedTargets] = useState<{ name: string; host: string; port: string }[]>(
    () => loadList<{ name: string; host: string; port: string }>(LS_TARGETS),
  );
  const [pickedTarget, setPickedTarget] = useState('');
  const [tab, setTab] = useState<'response' | 'history'>('response');
  const [toast, setToast] = useState('');
  const [methodFilter, setMethodFilter] = useState('');
  const [timeout, setTimeoutMs] = useState('15000');
  const [showHeaders, setShowHeaders] = useState(false);
  const [pins, setPins] = useState<HistoryEntry[]>(() => loadList<HistoryEntry>(LS_PINS));

  // ── reflection (direct transport only): pull services/methods from the server
  //    so you don't need a local .proto. Separate from the protoc pipeline.
  interface ReflMethod {
    name: string;
    path: string;
    requestType: string;
    responseType: string;
    requestStream: boolean;
    responseStream: boolean;
    template: string;
  }
  interface ReflSvc { service: string; methods: ReflMethod[]; error?: string }
  const [reflSvcs, setReflSvcs] = useState<ReflSvc[] | null>(null);
  const [reflBusy, setReflBusy] = useState(false);
  const [reflErr, setReflErr] = useState('');
  const [reflSvcSel, setReflSvcSel] = useState('');
  const [reflMethodSel, setReflMethodSel] = useState('');
  const clearReflect = () => {
    setReflSvcs(null);
    setReflErr('');
    setReflSvcSel('');
    setReflMethodSel('');
  };

  // per-method body memory: bodies keyed by "proto|Service/Method"
  const bodies = useRef<Record<string, string>>(
    JSON.parse(localStorage.getItem(LS_BODIES) ?? '{}'),
  );
  const firstBodyRun = useRef(true);
  const prevActiveId = useRef(activeId);
  const skipBodySwap = useRef(false);
  const bodyKey = `${form.proto}|${form.rpc}`;

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setActiveForm((f) => ({ ...f, [k]: v }));

  // ── tab operations ─────────────────────────────────────────────────────────
  const tabLabel = (t: ReqTab) =>
    t.form.rpc ? t.form.rpc.split('/')[1] || t.form.rpc : 'new';

  const addTab = () => {
    const id = Math.max(...reqTabs.map((t) => t.id)) + 1;
    // clone the current tab — same env/root/token, likely a different method next
    setReqTabs((ts) => [...ts, { id, form: { ...active.form } }]);
    setActiveId(id);
  };

  const closeTab = (id: number) => {
    if (reqTabs.length === 1) return;
    const idx = reqTabs.findIndex((t) => t.id === id);
    const next = reqTabs.filter((t) => t.id !== id);
    setReqTabs(next);
    setResultsMap((m) => {
      const c = { ...m };
      delete c[id];
      return c;
    });
    if (id === activeId) setActiveId(next[Math.max(0, idx - 1)].id);
  };

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 1600);
  };

  // bootstrap: default root from server
  useEffect(() => {
    if (form.root) return;
    fetch('/api/grpc/config')
      .then((r) => r.json())
      .then((d) => set('root', d.defaultRoot));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // load protos whenever root changes (debounced)
  useEffect(() => {
    if (!form.root) return;
    const t = setTimeout(() => {
      fetch(`/api/grpc/protos?root=${encodeURIComponent(form.root)}`)
        .then((r) => r.json())
        .then((d) => {
          if (d.error) {
            setRootError(d.error);
            setProtos([]);
            return;
          }
          setRootError('');
          setProtos(d.protos);
          if (!d.protos.includes(form.proto)) set('proto', d.protos[0] ?? '');
        })
        .catch((e) => setRootError(String(e)));
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.root]);

  // inspect selected proto
  useEffect(() => {
    if (!form.proto || !form.root) return;
    setInfo(null);
    fetch(
      `/api/grpc/inspect?root=${encodeURIComponent(form.root)}&proto=${encodeURIComponent(form.proto)}`,
    )
      .then((r) => r.json())
      .then((d: ProtoInfo & { error?: string }) => {
        if (d.error) return;
        setInfo(d);
        const all = d.services.flatMap((s) =>
          s.rpcs.map((r) => `${s.service}/${r.method}`),
        );
        if (!all.includes(form.rpc)) set('rpc', all[0] ?? '');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.proto, form.root]);

  useEffect(() => {
    // strip auth secrets from the persisted form — don't write tokens/passwords
    // to disk (saved prefixes/targets don't carry auth either).
    const slim = reqTabs.map((t) => ({ ...t, form: { ...t.form, auth: AUTH_DEFAULTS } }));
    localStorage.setItem(LS_TABS, JSON.stringify({ tabs: slim, activeId }));
  }, [reqTabs, activeId]);

  // #4 per-method body: on method/proto switch, swap in that method's saved body.
  // Skipped on: first render (keep a restored/shared body), tab switches (each
  // tab owns its body), and history restores (keep the historical body).
  useEffect(() => {
    if (firstBodyRun.current) {
      firstBodyRun.current = false;
      prevActiveId.current = activeId;
      return;
    }
    if (prevActiveId.current !== activeId) {
      prevActiveId.current = activeId;
      return;
    }
    if (skipBodySwap.current) {
      skipBodySwap.current = false;
      return;
    }
    set('body', bodies.current[bodyKey] ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.proto, form.rpc, activeId]);

  // persist the current body under its method key as it's edited
  useEffect(() => {
    if (!form.rpc) return;
    bodies.current[bodyKey] = form.body;
    localStorage.setItem(LS_BODIES, JSON.stringify(bodies.current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.body]);

  const filteredProtos = filter
    ? protos.filter((p) => p.toLowerCase().includes(filter.toLowerCase()))
    : protos;

  // filter narrows the list past the current selection → follow the list,
  // otherwise Service/Method silently keeps showing the previous proto.
  useEffect(() => {
    if (
      filteredProtos.length > 0 &&
      !filteredProtos.includes(form.proto)
    )
      set('proto', filteredProtos[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, protos]);

  const current: (RpcDef & { service: string }) | null = useMemo(() => {
    if (!info) return null;
    const [service, method] = form.rpc.split('/');
    const svc = info.services.find((s) => s.service === service);
    const rpc = svc?.rpcs.find((r) => r.method === method);
    return rpc ? { ...rpc, service: svc!.service } : null;
  }, [info, form.rpc]);

  const fq = (t: string) => (t.includes('.') ? t : `${info?.pkg}.${t}`);
  const short = (t: string) => t.split('.').pop() ?? t;

  const reqFields: FieldDef[] = useMemo(() => {
    if (!info || !current) return [];
    return info.messages.find((m) => m.name === short(current.req))?.fields ?? [];
  }, [info, current]);

  // enum options for a field type (null if not an enum) — shown as a filling hint
  const enumValues = (type: string): string[] | null =>
    info?.enums.find((e) => e.name === short(type))?.values ?? null;

  const copyResponse = async () => {
    if (result?.ok) {
      await navigator.clipboard.writeText(result.decoded);
      flash('Response copied');
    }
  };

  // #9 pinned requests (survive the 30-entry history cap)
  const pinKey = (e: HistoryEntry) => `${e.proto}|${e.rpc}|${e.url}|${e.body}`;
  const isPinned = (e: HistoryEntry) => pins.some((p) => pinKey(p) === pinKey(e));
  const togglePin = (e: HistoryEntry) => {
    const next = isPinned(e)
      ? pins.filter((p) => pinKey(p) !== pinKey(e))
      : [e, ...pins];
    setPins(next);
    localStorage.setItem(LS_PINS, JSON.stringify(next));
  };

  const autoUrl = current
    ? `${form.base.replace(/\/$/, '')}${form.prefix}/${info!.pkg}.${current.service}/${current.method}`
    : '';
  const url = form.urlOverride || autoUrl;

  // ------------------------------------------------------------- template --

  const templateFor = (typeName: string, depth: number): string[] => {
    if (!info) return [];
    const msg = info.messages.find((m) => m.name === short(typeName));
    if (!msg) return [];
    const pad = '  '.repeat(depth);
    const lines: string[] = [];
    for (const f of msg.fields) {
      const note = [
        f.repeated ? 'repeated' : '',
        f.type,
        f.comment,
      ]
        .filter(Boolean)
        .join(' · ');
      if (f.type in SCALAR_DEFAULTS) {
        lines.push(`${pad}${f.name}: ${SCALAR_DEFAULTS[f.type]}  # ${note}`);
      } else if (info.enums.some((e) => e.name === short(f.type))) {
        const first = info.enums.find((e) => e.name === short(f.type))!.values[0];
        lines.push(`${pad}${f.name}: ${first ?? '0'}  # enum · ${note}`);
      } else if (f.type.startsWith('map<')) {
        lines.push(`${pad}# ${f.name}: map ${f.type} — add entries as ${f.name} { key: ... value: ... }`);
      } else if (depth < 2 && info.messages.some((m) => m.name === short(f.type))) {
        lines.push(`${pad}${f.name} {  # ${note}`);
        lines.push(...templateFor(f.type, depth + 1));
        lines.push(`${pad}}`);
      } else {
        lines.push(`${pad}# ${f.name}: ${f.type} (define manually)`);
      }
    }
    return lines;
  };

  const generateTemplate = () => {
    if (!current) return;
    set('body', templateFor(current.req, 0).join('\n'));
  };

  // --------------------------------------------------------------- export --

  const buildHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = {
      authorization: authHeader(form.auth),
    };
    for (const line of form.extraHeaders.split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return headers;
  };

  const copyCurl = async () => {
    if (!current) return;
    if (form.transport === 'direct') {
      flash('cURL export is gateway-mode only');
      return;
    }
    const dir = form.proto.split('/').slice(0, -1).join('/');
    const hdrs = Object.entries(buildHeaders())
      .filter(([, v]) => v)
      .map(([k, v]) => `  -H '${k}: ${v.replace(/'/g, `'\\''`)}' \\`)
      .join('\n');
    const bodyEsc = form.body.replace(/'/g, `'\\''`);
    const script = `# ${form.rpc} — generated by conduit
cd '${form.root}' && \\
printf '%s' '${bodyEsc}' | protoc -I . -I '${dir}' --encode=${fq(current.req)} '${form.proto}' > /tmp/req.bin && \\
python3 -c "import struct;p=open('/tmp/req.bin','rb').read();open('/tmp/frame.bin','wb').write(b'\\x00'+struct.pack('>I',len(p))+p)" && \\
curl -s '${url}' \\
  -H 'content-type: application/grpc-web+proto' \\
  -H 'x-grpc-web: 1' \\
${hdrs}
  --data-binary @/tmp/frame.bin -o /tmp/res.bin && \\
python3 -c "import struct;d=open('/tmp/res.bin','rb').read();open('/tmp/p.bin','wb').write(d[5:5+struct.unpack('>I',d[1:5])[0]])" && \\
protoc -I . -I '${dir}' --decode=${fq(current.res)} '${form.proto}' < /tmp/p.bin`;
    await navigator.clipboard.writeText(script);
    flash('cURL script copied');
  };

  const copyShareLink = async () => {
    // strip ALL credentials from the share payload
    const { auth: _omit, ...rest } = form;
    const payload = btoa(unescape(encodeURIComponent(JSON.stringify(rest))));
    await navigator.clipboard.writeText(
      `${location.origin}${location.pathname}#s=${payload}`,
    );
    flash('Share link copied (auth excluded)');
  };

  // ---------------------------------------------------------- saved bases --

  const persistBases = (next: { name: string; url: string }[]) => {
    setSavedBases(next);
    localStorage.setItem(LS_BASES, JSON.stringify(next));
  };

  const saveCurrentBase = () => {
    const url = form.base.trim().replace(/\/$/, '');
    if (!url) return;
    const name = prompt('Name this environment (e.g. local, staging, prod):', '');
    if (!name) return;
    persistBases([...savedBases.filter((b) => b.name !== name), { name, url }]);
    setPickedEnv(name);
    flash(`Saved "${name}"`);
  };

  const removeBase = (name: string) => {
    persistBases(savedBases.filter((b) => b.name !== name));
    if (pickedEnv === name) setPickedEnv('');
  };

  // saved route prefixes — short strings, the prefix itself is the name
  const persistPrefixes = (next: string[]) => {
    setSavedPrefixes(next);
    localStorage.setItem(LS_PREFIXES, JSON.stringify(next));
  };
  const savePrefix = () => {
    const p = form.prefix.trim();
    if (!p || savedPrefixes.includes(p)) return;
    persistPrefixes([...savedPrefixes, p].sort());
    flash(`Saved "${p}"`);
  };
  const removePrefix = (p: string) => persistPrefixes(savedPrefixes.filter((x) => x !== p));

  // saved direct targets (host + port, named)
  const persistTargets = (next: { name: string; host: string; port: string }[]) => {
    setSavedTargets(next);
    localStorage.setItem(LS_TARGETS, JSON.stringify(next));
  };
  const saveTarget = () => {
    if (!form.targetHost.trim()) return;
    const name = prompt('Name this target (e.g. local, promotion-pf):', '');
    if (!name) return;
    persistTargets([
      ...savedTargets.filter((t) => t.name !== name),
      { name, host: form.targetHost.trim(), port: form.targetPort.trim() || '50051' },
    ]);
    setPickedTarget(name);
    flash(`Saved "${name}"`);
  };
  const applyTarget = (name: string) => {
    setPickedTarget(name);
    const t = savedTargets.find((x) => x.name === name);
    if (t) {
      set('targetHost', t.host);
      set('targetPort', t.port);
    }
  };
  const deleteTarget = () => {
    persistTargets(savedTargets.filter((t) => t.name !== pickedTarget));
    setPickedTarget('');
  };

  // -------------------------------------------------------------- history --

  const pushHistory = (entry: HistoryEntry) => {
    setHistEntries((h) => {
      const next = [entry, ...h].slice(0, HISTORY_MAX);
      localStorage.setItem(LS_HISTORY, JSON.stringify(next));
      return next;
    });
  };

  const restoreHistory = (e: HistoryEntry) => {
    // Keep the historical body — suppress the method-change body swap. Only arm
    // the flag when the effect will actually fire (proto/rpc changing), else it
    // would go stale and swallow the NEXT legitimate method switch.
    if (e.proto !== form.proto || e.rpc !== form.rpc) skipBodySwap.current = true;
    setActiveForm((f) => ({
      ...f,
      root: e.root,
      proto: e.proto,
      rpc: e.rpc,
      // grpc:// entries were direct-mode calls — no gateway URL to restore
      urlOverride: e.url.startsWith('grpc://') ? f.urlOverride : e.url,
      body: e.body,
    }));
    // show the stored response snapshot without re-sending
    if (e.response) {
      const r = e.response;
      const note = r.truncated ? '\n… (truncated in history)' : '';
      setResultFor(
        active.id,
        r.ok
          ? {
              ok: true,
              httpStatus: r.httpStatus ?? 0,
              grpcStatus: r.grpcStatus,
              grpcMessage: r.grpcMessage ?? '',
              decoded: r.text + note,
              frames: r.frames ?? 1,
              rawBytes: 0,
              durationMs: r.durationMs ?? 0,
            }
          : {
              ok: false,
              stage: 'gateway',
              httpStatus: r.httpStatus,
              error: r.text + note,
              durationMs: r.durationMs,
            },
      );
    }
    setTab('response');
  };

  const addQuickHeader = (v: string) =>
    set(
      'extraHeaders',
      form.extraHeaders ? `${form.extraHeaders.replace(/\n$/, '')}\n${v}` : v,
    );

  // ----------------------------------------------------------------- send --

  // history stores a bounded snapshot of the response for later review
  const RESP_SNAP_MAX = 20_000;
  const snapResponse = (res: CallResult): HistoryEntry['response'] => {
    const full = res.ok ? res.decoded : res.error;
    return {
      ok: res.ok,
      text: full.slice(0, RESP_SNAP_MAX),
      truncated: full.length > RESP_SNAP_MAX,
      grpcStatus: res.ok ? res.grpcStatus : '',
      grpcMessage: res.ok ? res.grpcMessage : undefined,
      httpStatus: res.httpStatus,
      durationMs: res.durationMs,
      frames: res.ok ? res.frames : undefined,
    };
  };

  const send = async () => {
    if (!current || !info || busyMap[active.id]) return; // no-op while in flight
    const tid = active.id; // pin the originating tab — user may switch mid-flight
    const sentForm = form;
    setBusyMap((m) => ({ ...m, [tid]: true }));
    setResultFor(tid, null);
    setTab('response');
    const req: CallRequest = {
      url,
      root: sentForm.root,
      proto: sentForm.proto,
      reqType: fq(current.req),
      resType: fq(current.res),
      textBody: sentForm.body,
      headers: buildHeaders(),
      timeoutMs: Number(timeout) || 15000,
      transport: sentForm.transport,
      target: buildTarget(sentForm.targetHost, sentForm.targetPort),
      plaintext: sentForm.plaintext,
      grpcPath: `/${info!.pkg}.${current.service}/${current.method}`,
    };
    let res: CallResult;
    try {
      const r = await fetch('/api/grpc/call', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req),
      });
      res = (await r.json()) as CallResult;
    } catch (e) {
      res = { ok: false, stage: 'network', error: String(e) };
    }
    setResultFor(tid, res);
    pushHistory({
      at: new Date().toISOString(),
      rpc: sentForm.rpc,
      url: sentForm.transport === 'direct' ? `grpc://${req.target}` : req.url,
      body: sentForm.body,
      proto: sentForm.proto,
      root: sentForm.root,
      ok: res.ok && res.grpcStatus === '0',
      grpcStatus: res.ok ? res.grpcStatus : `ERR:${res.stage}`,
      httpStatus: res.httpStatus,
      durationMs: res.durationMs,
      response: snapResponse(res),
    });
    setBusyMap((m) => ({ ...m, [tid]: false }));
  };

  // ── reflection: list services/methods off the live server (direct mode) ──────
  const runReflect = async () => {
    setReflBusy(true);
    setReflErr('');
    setReflSvcs(null);
    try {
      const r = await fetch('/api/grpc/reflect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          target: buildTarget(form.targetHost, form.targetPort),
          plaintext: form.plaintext,
        }),
      }).then((x) => x.json());
      if (!r.ok) {
        setReflErr(r.error || 'reflection failed');
      } else {
        setReflSvcs(r.services);
        const first = r.services.find((s: ReflSvc) => s.methods.length);
        if (first) {
          setReflSvcSel(first.service);
          setReflMethodSel('');
        }
      }
    } catch (e) {
      setReflErr(String(e));
    }
    setReflBusy(false);
  };

  // pick a reflected method → drop its template into the body for editing
  const pickReflMethod = (svc: string, methodName: string) => {
    setReflSvcSel(svc);
    setReflMethodSel(methodName);
    const m = reflSvcs?.find((s) => s.service === svc)?.methods.find((x) => x.name === methodName);
    if (m) {
      set('body', m.template);
      set('rpc', `${svc}/${methodName}`);
    }
  };

  const sendReflect = async () => {
    const svc = reflSvcs?.find((s) => s.service === reflSvcSel);
    const m = svc?.methods.find((x) => x.name === reflMethodSel);
    if (!m || busyMap[active.id]) return; // no-op while in flight
    const tid = active.id;
    const sentForm = form;
    setBusyMap((mm) => ({ ...mm, [tid]: true }));
    setResultFor(tid, null);
    setTab('response');
    let res: CallResult;
    try {
      const r = await fetch('/api/grpc/reflect/call', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          target: buildTarget(sentForm.targetHost, sentForm.targetPort),
          plaintext: sentForm.plaintext,
          service: reflSvcSel,
          method: reflMethodSel,
          requestJson: sentForm.body,
          headers: buildHeaders(),
          timeoutMs: Number(timeout) || 15000,
        }),
      });
      res = (await r.json()) as CallResult;
    } catch (e) {
      res = { ok: false, stage: 'network', error: String(e) };
    }
    setResultFor(tid, res);
    setBusyMap((mm) => ({ ...mm, [tid]: false }));
  };

  // ------------------------------------------------------------------- UI --

  // reflection is "driving" once services are loaded in direct mode — the proto
  // selectors are then hidden to avoid two competing Service/Method pickers.
  const reflecting = form.transport === 'direct' && !!reflSvcs && reflSvcs.length > 0;

  return (
    <div className="grpc-wrap">
      {/* Chrome-style request tabs — each holds an independent request */}
      <div className="req-tabs">
        {reqTabs.map((t) => (
          <span
            key={t.id}
            className={`req-tab ${t.id === activeId ? 'active' : ''}`}
            onClick={() => setActiveId(t.id)}
            title={t.form.rpc || 'new request'}
          >
            {busyMap[t.id] ? '⏳ ' : ''}
            {tabLabel(t)}
            {reqTabs.length > 1 && (
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
        <span className="req-tab req-tab-add" title="new request tab (clones this one)" onClick={addTab}>
          +
        </span>
      </div>

      <div className="layout">
      <div className="left">
        <h3>
          gRPC <span className="badge">{reflecting ? 'reflection' : 'proto files'}</span>
        </h3>

        {reflecting && (
          <div className="hint" style={{ marginTop: 6 }}>
            ⚡ driven by server reflection — proto selection hidden ·{' '}
            <span className="chip" onClick={clearReflect}>use .proto instead</span>
          </div>
        )}

        {!reflecting && (
          <>
            <label>Proto repo path (.proto files)</label>
            <input
              value={form.root}
              spellCheck={false}
              onChange={(e) => set('root', e.target.value)}
            />
            {rootError && <div className="error">{rootError}</div>}

            <label>
              Proto file{' '}
              <span className="count">
                ({filteredProtos.length}/{protos.length})
              </span>
            </label>
            <input
              className="mb4"
              placeholder="filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <select value={form.proto} onChange={(e) => set('proto', e.target.value)}>
              {filteredProtos.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>

            <label>Service / Method</label>
            <input
              className="mb4"
              placeholder="filter methods"
              value={methodFilter}
              onChange={(e) => setMethodFilter(e.target.value)}
            />
            <select
              value={form.rpc}
              onChange={(e) => {
                set('rpc', e.target.value);
                set('urlOverride', '');
              }}
            >
              {info?.services.flatMap((s) =>
                s.rpcs
                  .filter((r) =>
                    methodFilter
                      ? `${s.service}/${r.method}`
                          .toLowerCase()
                          .includes(methodFilter.toLowerCase())
                      : true,
                  )
                  .map((r) => {
                    const v = `${s.service}/${r.method}`;
                    return <option key={v}>{v}</option>;
                  }),
              )}
            </select>
          </>
        )}

        {/* transport: same proto/body pipeline, different wire */}
        <label>Send via</label>
        <select
          value={form.transport}
          onChange={(e) => set('transport', e.target.value as FormState['transport'])}
        >
          <option value="gateway">Gateway (gRPC-Web) — like the frontend</option>
          <option value="direct">Direct (native gRPC to host:port)</option>
        </select>
        {form.transport === 'direct' && (
          <>
            <div className="row field-row field-row-gap">
              <select className="grow" value={pickedTarget} onChange={(e) => applyTarget(e.target.value)}>
                <option value=""> - </option>
                {savedTargets.map((t) => (
                  <option key={t.name} value={t.name}>{t.name}</option>
                ))}
              </select>
              <button className="btn-field" onClick={saveTarget}>save</button>
              <button className="btn-field btn-danger" disabled={!pickedTarget} onClick={deleteTarget}>
                delete
              </button>
            </div>
            <div className="conn-row">
              <div className="grow">
                <label>Host</label>
                <input
                  value={form.targetHost}
                  spellCheck={false}
                  placeholder="localhost  ·  port-forwarded svc"
                  onChange={(e) => set('targetHost', e.target.value)}
                />
              </div>
              <div className="conn-sm">
                <label>Port</label>
                <input value={form.targetPort} onChange={(e) => set('targetPort', e.target.value)} />
              </div>
              <label style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6, flex: '0 0 auto', paddingBottom: 8 }}>
                <input
                  type="checkbox"
                  style={{ width: 'auto' }}
                  checked={form.plaintext}
                  onChange={(e) => set('plaintext', e.target.checked)}
                />
                plaintext
              </label>
            </div>
            <div className="hint">
              bypasses the gateway — local service or kubectl port-forward; unary calls only ·
              plaintext = no TLS (internal ports); uncheck for public TLS endpoints
            </div>

            {/* reflection — list services/methods off the server, no .proto needed */}
            {!(reflSvcs && reflSvcs.length > 0) && (
              <div className="row field-row" style={{ marginTop: 10 }}>
                <button className="btn-accent" style={{ width: 'auto', marginTop: 0 }} disabled={reflBusy} onClick={runReflect}>
                  {reflBusy ? 'reflecting…' : '⚡ Reflect services'}
                </button>
                <div className="hint" style={{ margin: 0 }}>
                  list services from the server, no .proto — needs reflection enabled
                </div>
              </div>
            )}
            {reflErr && <div className="hint error" style={{ marginTop: 4 }}>🔴 {reflErr}</div>}
            {reflSvcs && reflSvcs.length === 0 && (
              <div className="hint" style={{ marginTop: 4 }}>
                no user services exposed via reflection · <span className="chip" onClick={clearReflect}>back</span>
              </div>
            )}
            {reflSvcs && reflSvcs.length > 0 && (
              <div className="refl-box">
                <div className="refl-head">
                  <span className="badge">⚡ reflection</span>
                  <span className="chip" onClick={runReflect}>{reflBusy ? '…' : 're-fetch'}</span>
                  <span className="chip" onClick={clearReflect}>clear</span>
                </div>
                <label style={{ marginTop: 8 }}>Service</label>
                <select
                  value={reflSvcSel}
                  onChange={(e) => { setReflSvcSel(e.target.value); setReflMethodSel(''); }}
                >
                  {reflSvcs.map((s) => (
                    <option key={s.service} value={s.service}>{s.service}</option>
                  ))}
                </select>
                <label>Method</label>
                <select
                  value={reflMethodSel}
                  onChange={(e) => pickReflMethod(reflSvcSel, e.target.value)}
                >
                  <option value="">— pick a method —</option>
                  {reflSvcs.find((s) => s.service === reflSvcSel)?.methods.map((m) => (
                    <option key={m.name} value={m.name}>
                      {m.name}{m.requestStream || m.responseStream ? ' (stream)' : ''}
                    </option>
                  ))}
                </select>
                {reflMethodSel && (() => {
                  const m = reflSvcs.find((s) => s.service === reflSvcSel)?.methods.find((x) => x.name === reflMethodSel);
                  if (!m) return null;
                  const streaming = m.requestStream || m.responseStream;
                  return (
                    <>
                      <div className="hint" style={{ marginTop: 8 }}>
                        {m.requestType} → {m.responseType} · template loaded into the request body below
                      </div>
                      <button
                        style={{ marginTop: 10 }}
                        disabled={busy || streaming}
                        onClick={sendReflect}
                        title={streaming ? 'streaming RPCs are not supported here' : ''}
                      >
                        {busy ? 'Sending…' : streaming ? 'streaming — not supported' : 'Send (reflection) ▶'}
                      </button>
                    </>
                  );
                })()}
              </div>
            )}
          </>
        )}

        {form.transport === 'gateway' && (
        <>
        <label>Gateway base URL</label>
        <div className="row field-row">
          <select
            className="grow"
            value={pickedEnv}
            onChange={(e) => {
              const name = e.target.value;
              setPickedEnv(name);
              const b = savedBases.find((x) => x.name === name);
              if (b) {
                set('base', b.url);
                set('urlOverride', '');
              }
            }}
          >
            <option value=""> - </option>
            {savedBases.map((b) => (
              <option key={b.name} value={b.name}>{b.name}</option>
            ))}
          </select>
          <button className="btn-field" onClick={saveCurrentBase}>save</button>
        </div>
        <div className="row field-row field-row-gap">
          <input
            className="grow"
            value={form.base}
            onChange={(e) => {
              set('base', e.target.value);
              set('urlOverride', '');
            }}
          />
          <button
            className="btn-field btn-danger"
            disabled={!pickedEnv}
            title={pickedEnv ? `delete saved "${pickedEnv}"` : 'pick a saved environment first'}
            onClick={() => removeBase(pickedEnv)}
          >
            delete
          </button>
        </div>

        <label>Route prefix (gateway path before the gRPC path)</label>
        <div className="row field-row">
          <select
            style={{ maxWidth: 160, flex: '0 0 auto' }}
            value={savedPrefixes.includes(form.prefix) ? form.prefix : ''}
            onChange={(e) => {
              if (e.target.value) {
                set('prefix', e.target.value);
                set('urlOverride', '');
              }
            }}
          >
            <option value=""> - </option>
            {savedPrefixes.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <input
            className="grow"
            value={form.prefix}
            spellCheck={false}
            placeholder="/myservice"
            onChange={(e) => {
              set('prefix', e.target.value);
              set('urlOverride', '');
            }}
          />
          <button className="btn-field" onClick={savePrefix}>save</button>
          <button
            className="btn-field btn-danger"
            disabled={!savedPrefixes.includes(form.prefix)}
            onClick={() => removePrefix(form.prefix)}
          >
            delete
          </button>
        </div>

        <label>Full URL (auto — edit to override)</label>
        <input value={url} onChange={(e) => set('urlOverride', e.target.value)} />
        </>
        )}

        <AuthBox value={form.auth} onChange={(a) => set('auth', a)} />

        <label>Extra headers (one per line)</label>
        <textarea
          rows={5}
          value={form.extraHeaders}
          placeholder="devicetype: 2"
          spellCheck={false}
          onChange={(e) => set('extraHeaders', e.target.value)}
        />
        <div className="chips">
          {Object.entries(QUICK_HEADERS).map(([k, v]) => (
            <span key={k} className="chip" onClick={() => addQuickHeader(v)}>
              + {k}
            </span>
          ))}
        </div>

        <label>
          {form.transport === 'direct' && reflMethodSel
            ? 'Request body — JSON (reflection)'
            : 'Request body — proto text format (not JSON)'}
        </label>
        {reqFields.length > 0 && (
          <div className="fields">
            {reqFields.map((f) => {
              const evs = enumValues(f.type);
              return (
                <div key={f.name}>
                  <b>{f.name}</b>: {f.repeated ? 'repeated ' : ''}{f.type}
                  {evs && <span className="fcomment"> {'{ ' + evs.join(' | ') + ' }'}</span>}
                  {f.comment && <span className="fcomment"> — {f.comment}</span>}
                </div>
              );
            })}
          </div>
        )}
        <textarea
          rows={14}
          value={form.body}
          spellCheck={false}
          placeholder={'field1: "value"\nlimit: 10'}
          onChange={(e) => set('body', e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              if (form.transport === 'direct' && reflMethodSel) sendReflect();
              else send();
            }
          }}
        />
        <div className="chips">
          <span className="chip" onClick={generateTemplate}>generate template</span>
          <span className="chip" onClick={copyCurl}>copy as cURL</span>
          <span className="chip" onClick={copyShareLink}>copy share link</span>
        </div>

        <div className="row field-row" style={{ marginTop: 12 }}>
          <button
            style={{ marginTop: 0 }}
            disabled={busy || !current}
            onClick={send}
            className="grow"
          >
            {busy ? 'Sending…' : 'Send ▶'}
          </button>
          <div style={{ flex: '0 0 auto' }}>
            <input
              style={{ width: 110 }}
              value={timeout}
              title="request timeout (ms)"
              onChange={(e) => setTimeoutMs(e.target.value)}
            />
          </div>
        </div>
        <div className="hint">timeout ms · ⌘/Ctrl+Enter to send</div>
        {toast && <div className="toast">{toast}</div>}
      </div>

      <div className="right">
        <div className="tabs">
          <span
            className={tab === 'response' ? 'tab active' : 'tab'}
            onClick={() => setTab('response')}
          >
            Response
          </span>
          <span
            className={tab === 'history' ? 'tab active' : 'tab'}
            onClick={() => setTab('history')}
          >
            History ({histEntries.length})
          </span>
        </div>

        {tab === 'response' && (
          <>
            {result &&
              (result.ok ? (
                <div className={`status ${result.grpcStatus === '0' ? 'ok' : 'bad'}`}>
                  HTTP {result.httpStatus} · grpc-status {statusLabel(result.grpcStatus)}
                  {result.grpcMessage ? ` · ${result.grpcMessage}` : ''} ·{' '}
                  {result.durationMs}ms · {result.rawBytes}B
                  {result.frames > 1 ? ` · ${result.frames} messages (stream)` : ''}
                </div>
              ) : (
                <div className="status bad">
                  FAILED @ {result.stage}
                  {result.httpStatus ? ` · HTTP ${result.httpStatus}` : ''}
                  {result.durationMs != null ? ` · ${result.durationMs}ms` : ''}
                </div>
              ))}

            {result?.ok && (
              <div className="chips" style={{ marginBottom: 8 }}>
                <span className="chip" onClick={copyResponse}>copy response</span>
                {(result.headers || result.trailers) && (
                  <span className="chip" onClick={() => setShowHeaders((s) => !s)}>
                    {showHeaders ? 'hide' : 'show'} headers / trailers
                  </span>
                )}
              </div>
            )}

            {result?.ok && showHeaders && (
              <pre style={{ marginBottom: 8 }}>
                {'── request headers (sent by conduit) ──\n' +
                  Object.entries(result.reqHeaders ?? {})
                    .map(([k, v]) => `${k}: ${v}`)
                    .join('\n') +
                  '\n\n── response headers ──\n' +
                  Object.entries(result.headers ?? {})
                    .map(([k, v]) => `${k}: ${v}`)
                    .join('\n') +
                  (result.trailers && Object.keys(result.trailers).length
                    ? '\n\n── trailers ──\n' +
                      Object.entries(result.trailers)
                        .map(([k, v]) => `${k}: ${v}`)
                        .join('\n')
                    : '')}
              </pre>
            )}

            <pre>
              {result == null
                ? 'Send a request to see the decoded response here.'
                : result.ok
                  ? result.decoded || '(empty response body)'
                  : result.error}
            </pre>
          </>
        )}

        {tab === 'history' && (
          <div className="history">
            {pins.length > 0 && (
              <>
                <div className="hint" style={{ marginBottom: 2 }}>★ pinned</div>
                {pins.map((h, i) => (
                  <HistItem
                    key={'pin' + i}
                    h={h}
                    pinned
                    onRestore={() => restoreHistory(h)}
                    onPin={() => togglePin(h)}
                  />
                ))}
                <div className="hint" style={{ margin: '6px 0 2px' }}>recent</div>
              </>
            )}
            {histEntries.length === 0 && pins.length === 0 && <pre>No requests yet.</pre>}
            {histEntries.map((h, i) => (
              <HistItem
                key={i}
                h={h}
                pinned={isPinned(h)}
                onRestore={() => restoreHistory(h)}
                onPin={() => togglePin(h)}
              />
            ))}
            {histEntries.length > 0 && (
              <span
                className="chip"
                onClick={() => {
                  setHistEntries([]);
                  localStorage.removeItem(LS_HISTORY);
                }}
              >
                clear history
              </span>
            )}
          </div>
        )}
      </div>
      </div>
    </div>
  );
}

function HistItem({
  h,
  pinned,
  onRestore,
  onPin,
}: {
  h: HistoryEntry;
  pinned: boolean;
  onRestore: () => void;
  onPin: () => void;
}) {
  return (
    <div
      className={`hist-item ${h.ok ? 'hist-ok' : 'hist-bad'}`}
      onClick={onRestore}
      title="Click to restore this request into the form"
    >
      <div className="hist-head">
        <b>{h.rpc}</b>
        <span>
          <i
            className={`pin ${pinned ? 'pin-on' : ''}`}
            title={pinned ? 'unpin' : 'pin'}
            onClick={(e) => {
              e.stopPropagation();
              onPin();
            }}
          >
            ★
          </i>{' '}
          {h.grpcStatus === '0' ? 'OK' : h.grpcStatus}
          {h.durationMs != null ? ` · ${h.durationMs}ms` : ''} ·{' '}
          {new Date(h.at).toLocaleTimeString()}
        </span>
      </div>
      {h.body && <div className="hist-body">{h.body}</div>}
    </div>
  );
}
