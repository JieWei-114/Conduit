import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { SaveAs } from './SaveAs';
import { AttemptLogBar, CopyButton, OutcomeView, type Outcome } from './AttemptLog';
import AuthBox, { AUTH_DEFAULTS, authHeader, type AuthState } from './AuthBox';
import { rowKeyDown, rowTabIndex } from './rowNav';
import { RequestVarsBox } from './RequestVarsBox';
import { callConnect } from './connect';
import { withoutSecretValues } from './VarList';
import { useFlash } from './useFlash';
import { Empty, LongField, PanelHead, ReqTabs, Section, persistLater } from './ui';
import { EXAMPLES, useExample } from './examples';
import {
  activeEnv,
  extractInto,
  maskSecrets,
  NO_REQUEST_VARS,
  resolve,
  usesVars,
  useEnvs,
  type RequestVars,
} from './vars';
import type {
  CallRequest,
  CallResult,
  FieldDef,
  HistoryEntry,
  ProtoInfo,
  RpcDef,
} from './types';
import { joinUrl } from './url';
import { fmtBytes, isSensitiveHeader, maskHeaderValue, maskUrl, shellQuote } from './share';

const LS_FORM = 'grpcwebtester.form.v3';
const LS_HISTORY = 'grpcwebtester.history.v1';
const LS_BASES = 'grpcwebtester.bases.v1';
const LS_BODIES = 'conduit.grpc.bodies.v1';
const LS_PINS = 'conduit.grpc.pins.v1';
const LS_TABS = 'conduit.grpc.tabs.v1';
const LS_PREFIXES = 'conduit.grpc.prefixes.v1';
const LS_TARGETS = 'conduit.grpc.targets.v1';
const LS_REFL = 'conduit.grpc.reflect.v1';
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
  methodSource: 'proto' | 'reflection';
  targetHost: string;
  targetPort: string;
  plaintext: boolean;
  /** Direct + reflection: send as native gRPC, or as Connect (JSON over HTTP). */
  rpcProtocol: 'grpc' | 'connect';
  /** `{{name}}` variables, computed values and response extraction for this request. */
  vars: RequestVars;
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
  methodSource: 'proto',
  targetHost: 'localhost',
  targetPort: '50051',
  plaintext: true,
  rpcProtocol: 'grpc',
  vars: NO_REQUEST_VARS,
};

/**
 * The text fields a call will actually use that may hold `{{name}}` references, keyed by how
 * an error should name them: the gateway URL or the direct host and port, whichever the
 * transport uses, and only the active auth type's fields.
 */
function templatesOf(f: FormState, url: string): Record<string, string> {
  const t: Record<string, string> = { body: f.body, 'extra headers': f.extraHeaders };
  if (f.transport === 'gateway') t.URL = url;
  else {
    t.host = f.targetHost;
    t.port = f.targetPort;
  }
  if (f.auth.type === 'bearer' || f.auth.type === 'oauth2') t['auth token'] = f.auth.bearer;
  if (f.auth.type === 'basic') {
    t['auth user'] = f.auth.basicUser;
    t['auth password'] = f.auth.basicPass;
  }
  if (f.auth.type === 'raw') t['auth value'] = f.auth.raw;
  return t;
}

/** Request headers of `f`: its Authorization, then the extra header lines. */
function headersOf(f: FormState): Record<string, string> {
  const headers: Record<string, string> = { authorization: authHeader(f.auth) };
  for (const line of f.extraHeaders.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return headers;
}

/** The key that sends from a multi-line field, as this OS spells it. */
const SEND_KEY = typeof navigator !== 'undefined' && navigator.platform.includes('Mac') ? '⌘↵' : 'Ctrl↵';

/**
 * The JSON Conduit's own server answered. Anything else (a crash page, a proxy) is named as an
 * error instead of failing to parse.
 */
async function readJson(r: Response): Promise<any> {
  const raw = await r.text();
  try {
    return JSON.parse(raw);
  } catch {
    const head = raw.trim().slice(0, 300);
    return {
      ok: false,
      error: `Conduit's server answered HTTP ${r.status}${r.statusText ? ` ${r.statusText}` : ''} with a body that is not JSON${head ? `:\n${head}` : ' (empty)'}`,
    };
  }
}

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

const QUICK_HEADERS: Record<string, string> = {
  authorization: 'authorization: Bearer ',
  'x-request-id': 'x-request-id: ',
  'x-tenant-id': 'x-tenant-id: ',
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

interface ReflMethod {
  name: string;
  path: string;
  requestType: string;
  responseType: string;
  requestStream: boolean;
  responseStream: boolean;
  template: string;
}
interface ReflSvc {
  service: string;
  methods: ReflMethod[];
  error?: string;
}
interface ReflCache {
  services: ReflSvc[];
  target: string;
  at: string;
  stale?: boolean;
}

function loadRefl(): Record<number, ReflCache> {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_REFL) ?? '{}');
    if (!raw || typeof raw !== 'object') return {};
    const out: Record<number, ReflCache> = {};
    for (const [k, v] of Object.entries(raw as Record<string, ReflCache>))
      if (v && Array.isArray(v.services)) out[Number(k)] = { ...v, stale: true };
    return out;
  } catch {
    return {};
  }
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
        form.vars = { ...NO_REQUEST_VARS, ...(form.vars ?? {}) };
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
  // per-tab secret values the last send used, to mask them in the shown request headers
  const [secretsMap, setSecretsMap] = useState<Record<number, string[]>>({});
  const envs = useEnvs();

  const [protos, setProtos] = useState<string[]>([]);
  const [rootError, setRootError] = useState('');
  /** why the selected .proto could not be read, so Send can say why it is disabled */
  const [inspectErr, setInspectErr] = useState('');
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
  const [methodFilter, setMethodFilter] = useState('');
  const [timeout, setTimeoutMs] = useState('15000');
  const [showHeaders, setShowHeaders] = useState(false);
  const [pins, setPins] = useState<HistoryEntry[]>(() => loadList<HistoryEntry>(LS_PINS));

  const [reflMap, setReflMap] = useState<Record<number, ReflCache>>(loadRefl);
  const reflEntry = reflMap[active.id];
  const reflSvcs = reflEntry?.services ?? null;
  const setReflFor = (tid: number, entry: ReflCache | null) =>
    setReflMap((m) => {
      const c = { ...m };
      if (entry) c[tid] = entry;
      else delete c[tid];
      return c;
    });
  const setReflSvcs = (v: null) => setReflFor(active.id, v);
  const [reflBusy, setReflBusy] = useState(false);
  /** why listing failed, with the attempt's detail and record when the call went out */
  const [reflErr, setReflErr] = useState<Outcome | null>(null);
  const [reflSvcSel, setReflSvcSel] = useState('');
  const [reflMethodSel, setReflMethodSel] = useState('');
  const [reflSvcFilter, setReflSvcFilter] = useState('');
  const [reflMethodFilter, setReflMethodFilter] = useState('');
  /** Show the .proto picker instead of the server's own list. */
  const useProtoInstead = () => {
    set('methodSource', 'proto');
    setReflSvcs(null);
    setReflErr(null);
    setReflSvcSel('');
    setReflMethodSel('');
  };

  const clearReflect = () => {
    setReflSvcs(null);
    setReflErr(null);
    setReflSvcSel('');
    setReflMethodSel('');
  };

  // per-method body memory: bodies keyed by "proto|Service/Method"
  const bodies = useRef<Record<string, string>>(
    (() => {
      // a corrupt or foreign value must not stop the panel from opening
      try {
        return JSON.parse(localStorage.getItem(LS_BODIES) ?? '{}');
      } catch {
        return {};
      }
    })(),
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
    const f = active.form;
    const conn: Partial<FormState> = {
      root: f.root,
      proto: f.proto,
      base: f.base,
      prefix: f.prefix,
      transport: f.transport,
      methodSource: f.methodSource,
      targetHost: f.targetHost,
      targetPort: f.targetPort,
      plaintext: f.plaintext,
      rpcProtocol: f.rpcProtocol,
    };
    setReqTabs((ts) => [...ts, { id, form: { ...DEFAULTS, ...conn } }]);
    if (reflEntry) setReflFor(id, reflEntry);
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
    setSecretsMap((m) => {
      const c = { ...m };
      delete c[id];
      return c;
    });
    setReflFor(id, null);
    if (id === activeId) setActiveId(next[Math.max(0, idx - 1)].id);
  };


  const [toast, flash] = useFlash();

  // bootstrap: default root from server
  useEffect(() => {
    if (form.root) return;
    fetch('/api/grpc/config')
      .then(readJson)
      .then((d) => {
        if (d.defaultRoot) set('root', d.defaultRoot);
        else if (d.error) setRootError(`Could not read the default proto folder: ${d.error}`);
      })
      .catch((e) => setRootError(`Could not read the default proto folder: ${e?.message ?? e}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // load protos whenever root changes (debounced)
  useEffect(() => {
    if (!form.root) return;
    const t = setTimeout(() => {
      fetch(`/api/grpc/protos?root=${encodeURIComponent(form.root)}`)
        .then(readJson)
        .then((d) => {
          if (d.error) {
            setRootError(d.error);
            setProtos([]);
            return;
          }
          setRootError('');
          setProtos(d.protos ?? []);
          if (!d.protos.includes(form.proto)) set('proto', d.protos[0] ?? '');
        })
        .catch((e) => setRootError(String(e?.message ?? e)));
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.root]);

  // inspect selected proto
  useEffect(() => {
    if (!form.proto || !form.root) return;
    setInfo(null);
    setInspectErr('');
    fetch(
      `/api/grpc/inspect?root=${encodeURIComponent(form.root)}&proto=${encodeURIComponent(form.proto)}`,
    )
      .then(readJson)
      .then((d: ProtoInfo & { error?: string }) => {
        if (d.error) return setInspectErr(d.error);
        setInfo(d);
        const all = d.services.flatMap((s) =>
          s.rpcs.map((r) => `${s.service}/${r.method}`),
        );
        if (!all.includes(form.rpc)) set('rpc', all[0] ?? '');
      })
      .catch((e) => setInspectErr(String(e?.message ?? e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.proto, form.root]);

  useEffect(() => {
    // strip auth secrets from the persisted form — don't write tokens/passwords
    // to disk (saved prefixes/targets don't carry auth either).
    const slim = reqTabs.map((t) => ({
      ...t,
      form: {
        ...t.form,
        auth: AUTH_DEFAULTS,
        vars: { ...t.form.vars, vars: withoutSecretValues(t.form.vars.vars) },
      },
    }));
    persistLater(LS_TABS, () => JSON.stringify({ tabs: slim, activeId }));
  }, [reqTabs, activeId]);

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
    const kept = bodies.current[bodyKey];
    set('body', kept?.trim() ? kept : current ? templateFor(current.req, 0).join('\n') : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.proto, form.rpc, activeId]);

  useEffect(() => {
    persistLater(LS_REFL, () =>
      JSON.stringify(
        Object.fromEntries(
          Object.entries(reflMap)
            .filter(([id]) => reqTabs.some((t) => String(t.id) === id))
            .map(([id, v]) => [id, { services: v.services, target: v.target, at: v.at }]),
        ),
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reflMap]);

  useEffect(() => {
    const svcs = reflMap[activeId]?.services;
    if (!svcs) return;
    const [svc, method] = form.rpc.split('/');
    const hit = svcs.find((x) => x.service === svc);
    if (hit) {
      setReflSvcSel(svc);
      setReflMethodSel(hit.methods.some((m) => m.name === method) ? method : '');
    } else {
      setReflSvcSel(svcs.find((x) => x.methods.length)?.service ?? '');
      setReflMethodSel('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // persist the current body under its method key as it's edited
  useEffect(() => {
    if (!form.rpc) return;
    bodies.current[bodyKey] = form.body;
    persistLater(LS_BODIES, () => JSON.stringify(bodies.current));
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
    ? joinUrl(form.base, form.prefix, `${info!.pkg}.${current.service}`, current.method)
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

  const buildHeaders = (): Record<string, string> => headersOf(form);

  /**
   * The request as it will be sent: `{{variables}}` filled in, and the secret values used.
   * Throws naming what could not be filled; the caller then sends nothing.
   */
  const fillVars = async (f: FormState, fullUrl: string) => {
    const templates = templatesOf(f, fullUrl);
    if (!usesVars(Object.values(templates), f.vars)) return { form: f, url: fullUrl, secrets: [] as string[] };
    const { rendered: r, secrets } = await resolve(templates, f.vars, activeEnv(envs));
    const v = (key: string, fallback: string) => r[key] ?? fallback;
    const filled: FormState = {
      ...f,
      targetHost: v('host', f.targetHost),
      targetPort: v('port', f.targetPort),
      body: v('body', f.body),
      extraHeaders: v('extra headers', f.extraHeaders),
      auth: {
        ...f.auth,
        bearer: v('auth token', f.auth.bearer),
        basicUser: v('auth user', f.auth.basicUser),
        basicPass: v('auth password', f.auth.basicPass),
        raw: v('auth value', f.auth.raw),
      },
    };
    return { form: filled, url: v('URL', fullUrl), secrets };
  };

  /**
   * The direct target and headers with `{{variables}}` filled in, for the calls that do not go
   * through `fillVars` (reflection, health). Throws naming what could not be filled.
   */
  const directTarget = async () => {
    const filled = (await fillVars({ ...form, transport: 'direct', body: '' }, '')).form;
    return { target: buildTarget(filled.targetHost, filled.targetPort), headers: headersOf(filled) };
  };

  /**
   * Read the request's extract rules out of a successful call into `envName`, the environment
   * the call was sent with. `jsonBody` is false for protobuf text (the .proto pipeline).
   */
  const extractAfter = (f: FormState, res: CallResult, envName: string, jsonBody: boolean) => {
    if (!res.ok || !f.vars.extract.some((x) => x.name.trim() && x.path.trim())) return;
    // only a successful answer is read: an error must not overwrite a good value
    if (res.grpcStatus !== '0') {
      flash(`Nothing extracted: the call ended with grpc-status ${statusLabel(res.grpcStatus)}`);
      return;
    }
    extractInto(f.vars.extract, { body: res.decoded, headers: res.headers ?? {}, jsonBody }, envName).then(
      ({ env, names }) => names.length && flash(`Saved ${names.join(', ')} to environment "${env}"`),
      (e) => flash(String(e?.message ?? e)),
    );
  };

  /** A shell script that makes this gateway call with protoc and curl; `{{variables}}` are left as written. */
  const curlScript = (reveal = false) => {
    if (!current) return '';
    const dir = form.proto.split('/').slice(0, -1).join('/');
    // every header line ends in `\`, and none is blank: an empty line would end the command there
    const hdrs = [
      ['content-type', 'application/grpc-web+proto'],
      ['x-grpc-web', '1'],
      ...Object.entries(buildHeaders()).filter(
        ([k, v]) => v && !['content-type', 'x-grpc-web'].includes(k.toLowerCase()),
      ),
    ]
      .map(([k, v]) => `  -H ${shellQuote(`${k}: ${reveal ? v : maskHeaderValue(k, v)}`)} \\`)
      .join('\n');
    const script = `# ${form.rpc} — generated by conduit
cd ${shellQuote(form.root)} && \\
printf '%s' ${shellQuote(form.body)} | protoc -I . -I ${shellQuote(dir)} --encode=${fq(current.req)} ${shellQuote(form.proto)} > /tmp/req.bin && \\
python3 -c "import struct;p=open('/tmp/req.bin','rb').read();open('/tmp/frame.bin','wb').write(b'\\x00'+struct.pack('>I',len(p))+p)" && \\
curl -s ${shellQuote(reveal ? url : maskUrl(url))} \\
${hdrs}
  --data-binary @/tmp/frame.bin -o /tmp/res.bin && \\
python3 -c "import struct;d=open('/tmp/res.bin','rb').read();open('/tmp/p.bin','wb').write(d[5:5+struct.unpack('>I',d[1:5])[0]])" && \\
protoc -I . -I ${shellQuote(dir)} --decode=${fq(current.res)} ${shellQuote(form.proto)} < /tmp/p.bin`;
    return script;
  };

  const shareLink = () => {
    const { auth: _omit, ...rest } = {
      ...form,
      extraHeaders: form.extraHeaders
        .split('\n')
        .filter((line) => {
          const i = line.indexOf(':');
          return !(i > 0 && isSensitiveHeader(line.slice(0, i).trim()));
        })
        .join('\n'),
      urlOverride: maskUrl(form.urlOverride),
      vars: { ...form.vars, vars: withoutSecretValues(form.vars.vars) },
    };
    const payload = btoa(unescape(encodeURIComponent(JSON.stringify(rest))));
    return `${location.origin}${location.pathname}#s=${payload}`;
  };

  // ---------------------------------------------------------- saved bases --

  const persistBases = (next: { name: string; url: string }[]) => {
    setSavedBases(next);
    localStorage.setItem(LS_BASES, JSON.stringify(next));
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
    if (!p) return flash('Enter a route prefix first');
    if (savedPrefixes.includes(p)) return flash(`"${p}" is already saved`);
    persistPrefixes([...savedPrefixes, p].sort());
    flash(`Saved "${p}"`);
  };
  const removePrefix = (p: string) => persistPrefixes(savedPrefixes.filter((x) => x !== p));

  // saved direct targets (host + port, named)
  const persistTargets = (next: { name: string; host: string; port: string }[]) => {
    setSavedTargets(next);
    localStorage.setItem(LS_TARGETS, JSON.stringify(next));
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
  // a server may echo what it was sent: the kept snapshot never carries a secret value
  const snapResponse = (res: CallResult, secrets: string[]): HistoryEntry['response'] => {
    const full = maskSecrets(res.ok ? res.decoded : res.error, secrets);
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

  const aborts = useRef<Record<number, AbortController>>({});
  const cancelled = (tid: number, ctl: AbortController) => {
    if (aborts.current[tid] === ctl) delete aborts.current[tid];
    if (!ctl.signal.aborted) return false;
    setResultFor(tid, { ok: false, stage: 'call', error: 'Cancelled: the response was not waited for.' });
    setBusyMap((m) => ({ ...m, [tid]: false }));
    return true;
  };

  const send = async () => {
    if (!current || !info || busyMap[active.id]) return; // no-op while in flight
    const tid = active.id; // pin the originating tab — user may switch mid-flight
    const sentForm = form;
    const sentEnv = envs.active; // extracted values go back to the environment that was used
    setBusyMap((m) => ({ ...m, [tid]: true }));
    setTab('response');
    let filled: Awaited<ReturnType<typeof fillVars>>;
    try {
      filled = await fillVars(sentForm, url);
    } catch (e: any) {
      setResultFor(tid, { ok: false, stage: 'encode', error: `variables: ${e?.message ?? e}` });
      setBusyMap((m) => ({ ...m, [tid]: false }));
      return;
    }
    setSecretsMap((m) => ({ ...m, [tid]: filled.secrets }));
    const req: CallRequest = {
      url: filled.url,
      root: sentForm.root,
      proto: sentForm.proto,
      reqType: fq(current.req),
      resType: fq(current.res),
      textBody: filled.form.body,
      headers: headersOf(filled.form),
      timeoutMs: Number(timeout) || 15000,
      transport: sentForm.transport,
      target: buildTarget(filled.form.targetHost, filled.form.targetPort),
      plaintext: sentForm.plaintext,
      grpcPath: `/${info!.pkg}.${current.service}/${current.method}`,
    };
    let res: CallResult;
    const ctl = new AbortController();
    aborts.current[tid] = ctl;
    try {
      const r = await fetch('/api/grpc/call', {
        method: 'POST',
        signal: ctl.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req),
      });
      res = (await readJson(r)) as CallResult;
    } catch (e) {
      res = { ok: false, stage: 'network', error: String(e) };
    }
    if (cancelled(tid, ctl)) return;
    setResultFor(tid, res);
    extractAfter(sentForm, res, sentEnv, false);
    pushHistory({
      at: new Date().toISOString(),
      rpc: sentForm.rpc,
      // as written, {{templates}} included: history never holds a filled-in secret
      url:
        sentForm.transport === 'direct'
          ? `grpc://${buildTarget(sentForm.targetHost, sentForm.targetPort)}`
          : url,
      body: sentForm.body,
      proto: sentForm.proto,
      root: sentForm.root,
      ok: res.ok && res.grpcStatus === '0',
      grpcStatus: res.ok ? res.grpcStatus : `ERR:${res.stage}`,
      httpStatus: res.httpStatus,
      durationMs: res.durationMs,
      response: snapResponse(res, filled.secrets),
    });
    setBusyMap((m) => ({ ...m, [tid]: false }));
  };

  // ── reflection: list services/methods off the live server (direct mode) ──────
  const runReflect = async (override?: { target: string; plaintext: boolean; pick?: [string, string, string]; tabId?: number }) => {
    const reflTab = override?.tabId ?? active.id;
    setReflBusy(true);
    setReflErr(null);
    let target: string;
    try {
      target = override ? override.target : (await directTarget()).target;
    } catch (e: any) {
      setReflErr({ ok: false, text: `variables: ${e?.message ?? e}` });
      setReflBusy(false);
      return;
    }
    try {
      const r = await fetch('/api/grpc/reflect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          target,
          plaintext: override ? override.plaintext : form.plaintext,
        }),
      }).then(readJson);
      if (!r.ok) {
        // the record is kept: it says what was asked of which target, and what came back
        setReflErr({ ok: false, text: r.error || 'reflection failed', ms: r.durationMs, detail: r.detail, log: r.log });
        setReflFor(reflTab, null);
      } else {
        setReflFor(reflTab, { services: r.services, target, at: new Date().toISOString() });
        const [pSvc, pMethod, pBody] = override?.pick ?? [];
        const picked = r.services.find((s: ReflSvc) => s.service === pSvc && s.methods.some((m) => m.name === pMethod));
        const first = picked ?? r.services.find((s: ReflSvc) => s.methods.length);
        if (first) {
          setReflSvcSel(first.service);
          setReflMethodSel(picked ? pMethod! : '');
          if (picked) {
            skipBodySwap.current = true;
            const tid = override?.tabId ?? active.id;
            setReqTabs((ts) =>
              ts.map((t) => (t.id === tid ? { ...t, form: { ...t.form, rpc: `${pSvc}/${pMethod}`, body: pBody ?? '' } } : t)),
            );
          }
        }
      }
    } catch (e: any) {
      setReflErr({ ok: false, text: String(e?.message ?? e) });
    }
    setReflBusy(false);
  };

  // pick a reflected method → drop its template into the body for editing
  const pickReflMethod = (svc: string, methodName: string) => {
    setReflSvcSel(svc);
    setReflMethodSel(methodName);
    const m = reflSvcs?.find((s) => s.service === svc)?.methods.find((x) => x.name === methodName);
    if (!m) return;
    const rpc = `${svc}/${methodName}`;
    if (rpc !== form.rpc) skipBodySwap.current = true;
    const kept = bodies.current[`${form.proto}|${rpc}`];
    setActiveForm((f) => ({ ...f, rpc, body: kept?.trim() ? kept : m.template }));
  };

  const sendReflect = async () => {
    const svc = reflSvcs?.find((s) => s.service === reflSvcSel);
    const m = svc?.methods.find((x) => x.name === reflMethodSel);
    if (!m || busyMap[active.id]) return; // no-op while in flight
    const tid = active.id;
    const sentForm = form;
    const sentEnv = envs.active;
    setBusyMap((mm) => ({ ...mm, [tid]: true }));
    setTab('response');
    let filled: Awaited<ReturnType<typeof fillVars>>;
    try {
      filled = await fillVars(sentForm, url);
    } catch (e: any) {
      setResultFor(tid, { ok: false, stage: 'encode', error: `variables: ${e?.message ?? e}` });
      setBusyMap((mm) => ({ ...mm, [tid]: false }));
      return;
    }
    setSecretsMap((mm) => ({ ...mm, [tid]: filled.secrets }));
    const record = (res: CallResult) =>
      pushHistory({
        at: new Date().toISOString(),
        rpc: `${reflSvcSel}/${reflMethodSel}`,
        // as written, {{templates}} included: history never holds a filled-in secret
        url: `grpc://${buildTarget(sentForm.targetHost, sentForm.targetPort)}`,
        body: sentForm.body,
        proto: sentForm.proto,
        root: sentForm.root,
        ok: res.ok && res.grpcStatus === '0',
        grpcStatus: res.ok ? res.grpcStatus : `ERR:${res.stage}`,
        httpStatus: res.httpStatus,
        durationMs: res.durationMs,
        response: snapResponse(res, filled.secrets),
      });
    let res: CallResult;
    const ctl = new AbortController();
    aborts.current[tid] = ctl;
    if (sentForm.rpcProtocol === 'connect') {
      try {
        const scheme = sentForm.plaintext ? 'http' : 'https';
        res = await callConnect({
          base: `${scheme}://${buildTarget(filled.form.targetHost, filled.form.targetPort)}`,
          service: reflSvcSel,
          method: reflMethodSel,
          body: filled.form.body,
          headers: headersOf(filled.form),
          timeoutMs: Number(timeout) || 15000,
          signal: ctl.signal,
        });
      } catch (e) {
        res = { ok: false, stage: 'network', error: String(e) };
      }
      if (cancelled(tid, ctl)) return;
      setResultFor(tid, res);
      extractAfter(sentForm, res, sentEnv, true);
      record(res);
      setBusyMap((mm) => ({ ...mm, [tid]: false }));
      return;
    }
    try {
      const r = await fetch('/api/grpc/reflect/call', {
        method: 'POST',
        signal: ctl.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          target: buildTarget(filled.form.targetHost, filled.form.targetPort),
          plaintext: sentForm.plaintext,
          service: reflSvcSel,
          method: reflMethodSel,
          requestJson: filled.form.body,
          headers: headersOf(filled.form),
          timeoutMs: Number(timeout) || 15000,
        }),
      });
      res = (await readJson(r)) as CallResult;
    } catch (e) {
      res = { ok: false, stage: 'network', error: String(e) };
    }
    if (cancelled(tid, ctl)) return;
    setResultFor(tid, res);
    extractAfter(sentForm, res, sentEnv, true);
    record(res);
    setBusyMap((mm) => ({ ...mm, [tid]: false }));
  };

  // ------------------------------------------------------------------- UI --

  const source: 'proto' | 'reflection' =
    form.transport === 'gateway' ? 'proto' : form.methodSource;
  const reflecting = source === 'reflection';
  const reflStale =
    !!reflEntry && (reflEntry.stale || reflEntry.target !== buildTarget(form.targetHost, form.targetPort));

  const reflSvc = reflSvcs?.find((s) => s.service === reflSvcSel);
  const reflMethod = reflecting
    ? reflSvc?.methods.find((m) => m.name === reflMethodSel) ?? null
    : null;
  const unsupported = !reflMethod
    ? ''
    : reflMethod.requestStream
      ? 'client / bidi streaming — not supported'
      : reflMethod.responseStream && form.rpcProtocol === 'connect'
        ? 'server streaming needs gRPC, not Connect'
        : '';
  const canInvoke = reflecting ? !!reflMethod && !unsupported : !!current;
  const invoke = () => {
    if (busy || !canInvoke) return;
    return reflecting ? sendReflect() : send();
  };

  const svcMatches = (reflSvcs ?? []).filter(
    (s) => s.service === reflSvcSel ||
      s.service.toLowerCase().includes(reflSvcFilter.trim().toLowerCase()),
  );
  const methodMatches = (reflSvc?.methods ?? []).filter(
    (m) => m.name === reflMethodSel ||
      m.name.toLowerCase().includes(reflMethodFilter.trim().toLowerCase()),
  );

  const loadExample = (ex: typeof EXAMPLES.grpc) => {
    const fields: Partial<FormState> = {
      transport: 'direct',
      methodSource: 'reflection',
      targetHost: ex.host,
      targetPort: ex.port,
      plaintext: ex.plaintext,
      rpcProtocol: 'grpc',
    };
    let tabId = active.id;
    if (!form.rpc.trim() && !form.body.trim()) setActiveForm((f) => ({ ...f, ...fields }));
    else {
      tabId = Math.max(...reqTabs.map((t) => t.id)) + 1;
      setReqTabs((ts) => [...ts, { id: tabId, form: { ...DEFAULTS, ...fields } }]);
      setActiveId(tabId);
    }
    setTab('response');
    runReflect({
      target: buildTarget(ex.host, ex.port),
      plaintext: ex.plaintext,
      pick: ['addsvc.Add', 'Sum', '{\n  "a": 2,\n  "b": 3\n}'],
      tabId,
    });
  };
  useExample<typeof EXAMPLES.grpc>('grpc', loadExample);

  const statusOk = result?.ok && result.grpcStatus === '0';

  return (
    <div className="grpc-wrap">
      <ReqTabs
        tabs={reqTabs}
        activeId={activeId}
        ariaLabel="Request tabs"
        label={tabLabel}
        title={(t) => t.form.rpc || 'New request'}
        state={(t) => (busyMap[t.id] ? 'busy' : undefined)}
        onSelect={setActiveId}
        onClose={closeTab}
        onAdd={addTab}
        addTitle="New tab with the same connection"
      />

      <div className="layout">
        <div className="left">
          <PanelHead
            title="gRPC"
            badge={reflecting ? 'reflection' : 'proto files'}
            tagline="Call a method on a gRPC server directly, or through a gRPC-Web gateway."
          />

          <Section title="Connection" flush>
            <div className="seg" role="group" aria-label="Send via">
              {(
                [
                  ['direct', 'Direct to host:port', 'Native gRPC (or Connect) straight to the server'],
                  ['gateway', 'Through a gateway', 'gRPC-Web through an HTTP gateway, like a browser frontend'],
                ] as const
              ).map(([t, label, title]) => (
                <button
                  type="button"
                  key={t}
                  className={form.transport === t ? 'on' : ''}
                  aria-pressed={form.transport === t}
                  title={title}
                  onClick={() =>
                    setActiveForm((f) => ({ ...f, transport: t, methodSource: t === 'gateway' ? 'proto' : 'reflection' }))
                  }
                >
                  {label}
                </button>
              ))}
            </div>

            {form.transport === 'direct' && (
              <>
                <div className="saved-bar mt-3">
                  <select value={pickedTarget} aria-label="Saved targets" onChange={(e) => applyTarget(e.target.value)}>
                    <option value="">{savedTargets.length ? 'Open a saved target…' : 'No saved targets yet'}</option>
                    {savedTargets.map((t) => (
                      <option key={t.name} value={t.name}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                  <SaveAs
                    canSave={() => (form.targetHost.trim() ? null : 'Enter a host first')}
                    onSave={(name) => {
                      persistTargets([
                        ...savedTargets.filter((t) => t.name !== name),
                        { name, host: form.targetHost.trim(), port: form.targetPort.trim() || '50051' },
                      ]);
                      setPickedTarget(name);
                      return `Saved "${name}"`;
                    }}
                    onMessage={flash}
                  />
                  <button className="btn-secondary btn-danger" disabled={!pickedTarget} onClick={deleteTarget}>
                    Delete
                  </button>
                </div>
                <div className="conn-row">
                  <div className="grow">
                    <label>Host</label>
                    <LongField
                      value={form.targetHost}
                      aria-label="Host"
                      spellCheck={false}
                      placeholder="localhost"
                      onChange={(v) => set('targetHost', v)}
                    />
                  </div>
                  <div className="conn-sm">
                    <label>Port</label>
                    <input value={form.targetPort} aria-label="Port" placeholder="50051" onChange={(e) => set('targetPort', e.target.value)} />
                  </div>
                  <label className="check" title="Plaintext means no TLS. Untick it for public TLS endpoints.">
                    <input type="checkbox" checked={form.plaintext} onChange={(e) => set('plaintext', e.target.checked)} />
                    Plaintext
                  </label>
                </div>
                <div className="hint">
                  A local service or a kubectl port-forward. Plaintext means no TLS; untick it for public TLS endpoints.
                </div>
                {reflecting && (
                  <div className="inline mt-3">
                    <span className="block-label m-0">Protocol</span>
                    <div className="seg seg-sm" role="group" aria-label="Protocol">
                      {(['grpc', 'connect'] as const).map((p) => (
                        <button
                          type="button"
                          key={p}
                          className={form.rpcProtocol === p ? 'on' : ''}
                          aria-pressed={form.rpcProtocol === p}
                          title={p === 'grpc' ? 'Native gRPC over HTTP/2' : 'Connect: a JSON POST to /<service>/<method>'}
                          onClick={() => set('rpcProtocol', p)}
                        >
                          {p === 'grpc' ? 'gRPC' : 'Connect'}
                        </button>
                      ))}
                    </div>
                    <span className="hint m-0">How reflected methods are called.</span>
                  </div>
                )}
                <HealthCheck
                  target={buildTarget(form.targetHost, form.targetPort)}
                  plaintext={form.plaintext}
                  prepare={directTarget}
                />
              </>
            )}

            {form.transport === 'gateway' && (
              <>
                <label>Gateway base URL</label>
                <div className="saved-bar">
                  <select
                    value={pickedEnv}
                    aria-label="Saved gateways"
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
                    <option value="">{savedBases.length ? 'Open a saved gateway…' : 'No saved gateways yet'}</option>
                    {savedBases.map((b) => (
                      <option key={b.name} value={b.name}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                  <SaveAs
                    canSave={() => (form.base.trim() ? null : 'Enter a base URL first')}
                    onSave={(name) => {
                      persistBases([
                        ...savedBases.filter((b) => b.name !== name),
                        { name, url: form.base.trim().replace(/\/$/, '') },
                      ]);
                      setPickedEnv(name);
                      return `Saved "${name}"`;
                    }}
                    onMessage={flash}
                  />
                  <button
                    className="btn-secondary btn-danger"
                    disabled={!pickedEnv}
                    title={pickedEnv ? `Delete saved "${pickedEnv}"` : 'Pick a saved gateway first'}
                    onClick={() => removeBase(pickedEnv)}
                  >
                    Delete
                  </button>
                </div>
                <LongField
                  url
                  className="mt-2"
                  value={form.base}
                  spellCheck={false}
                  aria-label="Gateway base URL"
                  placeholder="https://gateway.example.com"
                  onChange={(v) => {
                    set('base', v);
                    set('urlOverride', '');
                  }}
                />

                <label>Route prefix</label>
                <div className="row row-tight">
                  <LongField
                    url
                    className="grow"
                    suggestions={savedPrefixes}
                    value={form.prefix}
                    spellCheck={false}
                    aria-label="Route prefix"
                    placeholder="/myservice"
                    onChange={(v) => {
                      set('prefix', v);
                      set('urlOverride', '');
                    }}
                  />
                  <button className="btn-secondary" onClick={savePrefix}>
                    Save
                  </button>
                  <button
                    className="btn-secondary btn-danger"
                    disabled={!savedPrefixes.includes(form.prefix)}
                    onClick={() => removePrefix(form.prefix)}
                  >
                    Delete
                  </button>
                </div>
                <div className="hint">The gateway path inserted before /package.Service/Method.</div>
              </>
            )}
            {toast && <div className="toast">{toast}</div>}
          </Section>

          <Section
            title="Method"
            actions={
              form.transport === 'direct' &&
              (reflecting ? (
                <button className="btn-ghost btn-sm" onClick={useProtoInstead} title="Pick the method from local .proto files">
                  Use .proto files
                </button>
              ) : (
                <button
                  className="btn-ghost btn-sm"
                  onClick={() => set('methodSource', 'reflection')}
                  title="Ask the server for its services instead"
                >
                  Use server reflection
                </button>
              ))
            }
          >
            {reflecting && !(reflSvcs && reflSvcs.length > 0) && (
              <>
                <div className="row">
                  <button className="btn-secondary" disabled={reflBusy} onClick={() => runReflect()}>
                    {reflBusy ? 'Reflecting…' : 'Reflect services'}
                  </button>
                  <span className="hint grow">Lists the server's services and methods. Needs gRPC reflection enabled.</span>
                </div>
                <OutcomeView o={reflErr} secrets={[]} />
                {reflSvcs && reflSvcs.length === 0 && (
                  <div className="hint">The server exposes no services through reflection. Use .proto files instead.</div>
                )}
              </>
            )}
            {reflecting && reflSvcs && reflSvcs.length > 0 && (
              <div className="refl-box">
                <div className="refl-head">
                  <span className="hint m-0">
                    {reflSvcs.length} service{reflSvcs.length === 1 ? '' : 's'}
                    {reflStale && reflEntry && (
                      <span className="text-warn" title={`Listed ${new Date(reflEntry.at).toLocaleString()} from ${reflEntry.target}`}>
                        {' '}· saved list, may be stale
                      </span>
                    )}
                  </span>
                  <span className="spacer" />
                  <button className="btn-ghost btn-sm" disabled={reflBusy} onClick={() => runReflect()}>
                    {reflBusy ? 'Refreshing…' : 'Refresh'}
                  </button>
                  <button className="btn-ghost btn-sm" onClick={clearReflect}>
                    Clear
                  </button>
                </div>
                <label>
                  Service <span className="count">({svcMatches.length}/{reflSvcs.length})</span>
                </label>
                <div className="filter-select">
                  <input
                    placeholder="Filter"
                    aria-label="Filter services"
                    value={reflSvcFilter}
                    spellCheck={false}
                    onChange={(e) => setReflSvcFilter(e.target.value)}
                  />
                  <select
                    value={reflSvcSel}
                    aria-label="Service"
                    onChange={(e) => {
                      setReflSvcSel(e.target.value);
                      setReflMethodSel('');
                      setReflMethodFilter('');
                    }}
                  >
                    {svcMatches.map((s) => (
                      <option key={s.service} value={s.service}>
                        {s.service}
                      </option>
                    ))}
                  </select>
                </div>
                <label>
                  Method <span className="count">({methodMatches.length}/{reflSvc?.methods.length ?? 0})</span>
                </label>
                <div className="filter-select">
                  <input
                    placeholder="Filter"
                    aria-label="Filter methods"
                    value={reflMethodFilter}
                    spellCheck={false}
                    onChange={(e) => setReflMethodFilter(e.target.value)}
                  />
                  <select
                    value={reflMethodSel}
                    aria-label="Method"
                    onChange={(e) => pickReflMethod(reflSvcSel, e.target.value)}
                  >
                    <option value="">Pick a method…</option>
                    {methodMatches.map((m) => (
                      <option key={m.name} value={m.name}>
                        {m.name}
                        {m.requestStream || m.responseStream ? ' (stream)' : ''}
                      </option>
                    ))}
                  </select>
                </div>
                {reflMethod && (
                  <div className="hint break">
                    {reflMethod.requestType} → {reflMethod.responseType}. A request template is in the body below.
                  </div>
                )}
              </div>
            )}

            {!reflecting && (
              <>
                <label className="field-first">Proto folder</label>
                <LongField aria-label="Proto folder" value={form.root} spellCheck={false} onChange={(v) => set('root', v)} />
                <div className="hint">Folder scanned for .proto files.</div>
                {rootError && <div className="error break">{rootError}</div>}

                <label>
                  Proto file <span className="count">({filteredProtos.length}/{protos.length})</span>
                </label>
                <div className="filter-select">
                  <input placeholder="Filter" aria-label="Filter proto files" value={filter} onChange={(e) => setFilter(e.target.value)} />
                  <select value={form.proto} aria-label="Proto file" onChange={(e) => set('proto', e.target.value)}>
                    {filteredProtos.map((p) => (
                      <option key={p}>{p}</option>
                    ))}
                  </select>
                </div>
                {inspectErr && <div className="error break">Could not read {form.proto}: {inspectErr}</div>}

                <label>Service / method</label>
                <div className="filter-select">
                  <input
                    placeholder="Filter"
                    aria-label="Filter methods"
                    value={methodFilter}
                    onChange={(e) => setMethodFilter(e.target.value)}
                  />
                  <select
                    value={form.rpc}
                    aria-label="Service and method"
                    onChange={(e) => {
                      set('rpc', e.target.value);
                      set('urlOverride', '');
                    }}
                  >
                    {info?.services.flatMap((s) =>
                      s.rpcs
                        .filter((r) =>
                          methodFilter
                            ? `${s.service}/${r.method}`.toLowerCase().includes(methodFilter.toLowerCase())
                            : true,
                        )
                        .map((r) => {
                          const v = `${s.service}/${r.method}`;
                          return <option key={v}>{v}</option>;
                        }),
                    )}
                  </select>
                </div>
              </>
            )}
            {form.transport === 'gateway' && (
              <>
                <label>Full URL</label>
                <LongField url aria-label="Full URL" value={url} spellCheck={false} onChange={(v) => set('urlOverride', v)} />
                <div className="hint">Built from base URL + prefix + method. Edit it to override.</div>
              </>
            )}
          </Section>

          <RequestVarsBox
            key={active.id}
            value={form.vars}
            onChange={(v) => set('vars', v)}
            texts={Object.values(templatesOf(form, url))}
            onMessage={flash}
          />

          <AuthBox value={form.auth} onChange={(a) => set('auth', a)} />

          <Section title="Metadata" hint={<>Extra headers, one <code>name: value</code> per line.</>}>
            <textarea
              rows={3}
              value={form.extraHeaders}
              placeholder="x-request-id: 123"
              spellCheck={false}
              aria-label="Metadata"
              onChange={(e) => set('extraHeaders', e.target.value)}
            />
            <div className="chips">
              {Object.entries(QUICK_HEADERS).map(([k, v]) => (
                <button type="button" key={k} className="chip chip-mono" title={`Add the ${k} header`} onClick={() => addQuickHeader(v)}>
                  + {k}
                </button>
              ))}
            </div>
          </Section>

          <Section
            title="Request body"
            hint={
              reflecting
                ? 'JSON. Conduit encodes it using the descriptor the server sent.'
                : 'Protobuf text format, not JSON, e.g. name: "value" and limit: 10.'
            }
            actions={
              !reflecting && (
                <button className="btn-ghost btn-sm" onClick={generateTemplate} disabled={!current}>
                  Fill a template
                </button>
              )
            }
          >
            {reqFields.length > 0 && (
              <div className="fields">
                {reqFields.map((f) => {
                  const evs = enumValues(f.type);
                  return (
                    <div key={f.name} className="break">
                      <b>{f.name}</b>: {f.repeated ? 'repeated ' : ''}
                      {f.type}
                      {evs && <span className="fcomment"> {'{ ' + evs.join(' | ') + ' }'}</span>}
                      {f.comment && <span className="fcomment"> · {f.comment}</span>}
                    </div>
                  );
                })}
              </div>
            )}
            <textarea
              rows={10}
              value={form.body}
              spellCheck={false}
              aria-label="Request body"
              placeholder={reflecting ? '{\n  "name": "value"\n}' : 'name: "value"\nlimit: 10'}
              onChange={(e) => set('body', e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) invoke();
              }}
            />
            <div className="chips">
              {form.transport === 'gateway' && current && (
                <>
                  <CopyButton
                    text={() => curlScript()}
                    label="Copy as cURL script"
                    title="A shell script that makes this call with protoc and curl, with credential headers and URL secrets masked. {{variables}} are left as written."
                  />
                  <CopyButton
                    text={() => curlScript(true)}
                    label="Copy with secrets"
                    title="The same script exactly as it would be sent, credentials included"
                  />
                </>
              )}
              <CopyButton text={shareLink} label="Copy share link" title="A link that opens this request, without auth" />
            </div>
          </Section>

          <div className="action-bar">
            {busy ? (
              <button className="btn-secondary" title="Stop waiting for this call" onClick={() => aborts.current[active.id]?.abort()}>
                Cancel
              </button>
            ) : (
              <button className="btn-primary" disabled={!canInvoke} onClick={invoke} title={unsupported}>
                Send
              </button>
            )}
            {unsupported ? (
              <span className="hint text-warn">{unsupported}</span>
            ) : !canInvoke ? (
              <span className="hint">
                {reflecting
                  ? 'Reflect and pick a method first.'
                  : inspectErr
                    ? 'The .proto file could not be read (see Method above).'
                    : 'Pick a method first.'}
              </span>
            ) : (
              <span className="hint">
                <kbd>{SEND_KEY}</kbd> in the body also sends
              </span>
            )}
            <span className="spacer" />
            <label className="check" title="Request timeout in milliseconds">
              Timeout
              <input className="w-xs" value={timeout} aria-label="Timeout in milliseconds" inputMode="numeric" onChange={(e) => setTimeoutMs(e.target.value)} />
              <span className="faint">ms</span>
            </label>
          </div>
        </div>

        <div className="right">
          <div className="tabs" role="tablist" aria-label="Result view">
            <button
              type="button"
              className={tab === 'response' ? 'tab active' : 'tab'}
              role="tab"
              aria-selected={tab === 'response'}
              onClick={() => setTab('response')}
            >
              Response
            </button>
            <button
              type="button"
              className={tab === 'history' ? 'tab active' : 'tab'}
              role="tab"
              aria-selected={tab === 'history'}
              onClick={() => setTab('history')}
            >
              History <span className="count">{histEntries.length}</span>
            </button>
          </div>

          {tab === 'response' && (
            <>
              {busy && <OutcomeView o={{ ok: false, busy: true, text: `Calling ${form.rpc || 'the method'}…` }} secrets={[]} />}
              <div className={busy && result ? 'stale' : undefined}>
              {result && !result.ok && (
                <OutcomeView
                  o={{
                    ok: false,
                    // a gateway that answered with something other than gRPC: its HTTP status says what
                    text: result.httpStatus ? `HTTP ${result.httpStatus}: ${result.error}` : result.error,
                    ms: result.durationMs,
                    detail: result.detail,
                    log: result.log,
                  }}
                  secrets={secretsMap[active.id] ?? []}
                />
              )}
              {result?.ok && (
                <div className={`status ${statusOk ? 'ok' : 'bad'}`} role="status">
                  <span>{statusLabel(result.grpcStatus)}</span>
                  {result.grpcMessage && (
                    <>
                      <span className="sep">·</span>
                      <span className="break">{result.grpcMessage}</span>
                    </>
                  )}
                  <span className="sep">·</span>
                  <span>HTTP {result.httpStatus}</span>
                  <span className="sep">·</span>
                  <span>{result.durationMs} ms</span>
                  <span className="sep">·</span>
                  <span>{fmtBytes(result.rawBytes)}</span>
                  {result.frames > 1 && (
                    <>
                      <span className="sep">·</span>
                      <span>{result.frames} messages (stream)</span>
                    </>
                  )}
                </div>
              )}

              {result?.ok && (
                <div className="result-bar">
                  {(result.headers || result.trailers || result.reqHeaders) && (
                    <button
                      type="button"
                      className={`btn-ghost btn-sm ${showHeaders ? 'btn-on' : ''}`}
                      aria-pressed={showHeaders}
                      title="The headers sent and received, and the trailers"
                      onClick={() => setShowHeaders((s) => !s)}
                    >
                      Headers
                    </button>
                  )}
                  <AttemptLogBar log={result.log} secrets={secretsMap[active.id] ?? []} />
                  <span className="spacer" />
                  {result.decoded && <CopyButton text={result.decoded} label="Copy response" title="Copy the decoded response" />}
                </div>
              )}

              {result?.ok && showHeaders && (
                <div className="mb-3">
                  <HeaderTable
                    title="Request headers (sent by Conduit)"
                    rows={result.reqHeaders}
                    mask={secretsMap[active.id] ?? []}
                    blankCredentials
                  />
                  <HeaderTable title="Response headers" rows={result.headers} />
                  {result.trailers && Object.keys(result.trailers).length > 0 && (
                    <HeaderTable title="Trailers" rows={result.trailers} />
                  )}
                </div>
              )}

              {result == null ? (
                !busy && (
                  <Empty
                    icon="↗"
                    title="No response yet"
                    hint={
                      <>
                        For a direct call: enter host and port, press <kbd>Reflect services</kbd>, pick a method, edit the
                        JSON body, then <kbd>Send</kbd>. Try the public test server <code>grpcb.in:9000</code>.
                      </>
                    }
                  >
                    <button className="btn-secondary btn-sm" onClick={() => loadExample(EXAMPLES.grpc)}>
                      Try grpcb.in:9000
                    </button>
                  </Empty>
                )
              ) : (
                result.ok && <GrpcBody result={result} />
              )}
              </div>
            </>
          )}

          {tab === 'history' && (
            <div className="history">
              {pins.length > 0 && (
                <>
                  <div className="list-label">Pinned</div>
                  {pins.map((h, i) => (
                    <HistItem
                      key={'pin' + i}
                      h={h}
                      index={i}
                      pinned
                      onRestore={() => restoreHistory(h)}
                      onPin={() => togglePin(h)}
                    />
                  ))}
                  <div className="list-label">Recent</div>
                </>
              )}
              {histEntries.length === 0 && pins.length === 0 && (
                <Empty
                  icon="↺"
                  title="No calls yet"
                  hint={
                    <>
                      Every call you <kbd>Send</kbd> is recorded here with its response. Click one to restore it; star it to
                      keep it.
                    </>
                  }
                />
              )}
              {histEntries.map((h, i) => (
                <HistItem
                  key={i}
                  h={h}
                  index={i}
                  pinned={isPinned(h)}
                  onRestore={() => restoreHistory(h)}
                  onPin={() => togglePin(h)}
                />
              ))}
              {histEntries.length > 0 && (
                <div className="mt-2">
                  <button
                    className="btn-secondary btn-danger btn-sm"
                    onClick={() => {
                      setHistEntries([]);
                      localStorage.removeItem(LS_HISTORY);
                    }}
                  >
                    Clear history
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Headers as a table, secret values masked. `blankCredentials` also blanks credential headers
 * (Authorization, cookies, API keys), as the copied log does.
 */
function HeaderTable({
  title,
  rows,
  mask = [],
  blankCredentials = false,
}: {
  title: string;
  rows?: Record<string, string>;
  mask?: string[];
  blankCredentials?: boolean;
}) {
  const entries = Object.entries(rows ?? {});
  return (
    <>
      <div className="list-label mb-1">{title}</div>
      {entries.length ? (
        <table className="rtable kv-table mb-2">
          <tbody>
            {entries.map(([k, v]) => (
              <tr key={k}>
                <td>{k}</td>
                <td>{blankCredentials && isSensitiveHeader(k) ? '•••' : maskSecrets(v, mask)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="hint mb-2">none</div>
      )}
    </>
  );
}

/** A call the server answered: its error details, if any, then the decoded response. */
const GrpcBody = memo(function GrpcBody({ result }: { result: Extract<CallResult, { ok: true }> }) {
  return (
    <>
      {result.statusDetails && (
        <div className="mb-2">
          <div className="block-label">Error details</div>
          <pre>{JSON.stringify(result.statusDetails, null, 2)}</pre>
        </div>
      )}
      <pre>{result.decoded || (result.grpcStatus === '0' ? '(empty response body)' : '(no response body)')}</pre>
    </>
  );
});

function HistItem({
  h,
  index,
  pinned,
  onRestore,
  onPin,
}: {
  h: HistoryEntry;
  index: number;
  pinned: boolean;
  onRestore: () => void;
  onPin: () => void;
}) {
  return (
    <div
      className={`hist-item ${h.ok ? 'hist-ok' : 'hist-bad'}`}
      role="button"
      tabIndex={rowTabIndex(index)}
      onClick={onRestore}
      onKeyDown={rowKeyDown(onRestore)}
      title="Restore this request into the form"
    >
      <div className="hist-head">
        <b className="break">{h.rpc}</b>
        <span>
          <span className={h.grpcStatus === '0' ? 'text-ok' : 'text-bad'}>{h.grpcStatus === '0' ? 'OK' : h.grpcStatus}</span>
          {h.durationMs != null ? `· ${h.durationMs} ms` : ''} · {new Date(h.at).toLocaleTimeString()}
          <button
            type="button"
            className={`pin ${pinned ? 'pin-on' : ''}`}
            aria-pressed={pinned}
            aria-label={pinned ? 'Unpin' : 'Pin'}
            title={pinned ? 'Unpin' : 'Pin: keep it past the 30-entry history limit'}
            onClick={(e) => {
              e.stopPropagation();
              onPin();
            }}
          >
            ★
          </button>
        </span>
      </div>
      {h.body && <div className="hist-body" title={h.body}>{h.body}</div>}
    </div>
  );
}

/**
 * `grpc.health.v1.Health/Check` against the direct target. An empty service asks about the
 * server as a whole; a name asks about that one (servers often use `live` / `ready`). The
 * request's auth and extra headers go with it, `{{variables}}` filled in by `prepare`.
 */
function HealthCheck({
  target,
  plaintext,
  prepare,
}: {
  target: string;
  plaintext: boolean;
  prepare: () => Promise<{ target: string; headers: Record<string, string> }>;
}) {
  const [service, setService] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Outcome | null>(null);

  // a result is about the target it was taken against
  useEffect(() => setResult(null), [target, plaintext]);

  const check = async () => {
    if (busy) return;
    setBusy(true);
    setResult(null);
    let prepared: { target: string; headers: Record<string, string> };
    try {
      prepared = await prepare();
    } catch (e: any) {
      setResult({ ok: false, text: `variables: ${e?.message ?? e}` });
      setBusy(false);
      return;
    }
    const { target: filled, headers } = prepared;
    try {
      const r = await fetch('/api/grpc/health', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target: filled, plaintext, service: service.trim(), headers }),
      }).then(readJson);
      setResult(
        r.ok
          ? r.status === 'SERVING'
            ? { ok: true, text: 'SERVING', ms: r.durationMs, log: r.log }
            : { ok: false, text: `The server answered ${r.status}`, ms: r.durationMs, log: r.log }
          : { ok: false, text: r.error ?? 'health check failed', ms: r.durationMs, detail: r.detail, log: r.log },
      );
    } catch (e: any) {
      setResult({ ok: false, text: String(e?.message ?? e) });
    }
    setBusy(false);
  };

  return (
    <>
      <label htmlFor="grpc-health-service">
        Health check{' '}
        <span
          className="help"
          title="Calls grpc.health.v1.Health/Check. SERVING means the server (or the named service) is up and ready. Leave the service empty to check the whole server."
        >
          ?
        </span>
      </label>
      <div className="row">
        <LongField
          id="grpc-health-service"
          className="grow"
          value={service}
          spellCheck={false}
          placeholder="service (optional)"
          title="A service name, or empty to check the whole server"
          aria-label="Health check service"
          onChange={setService}
          onEnter={() => check()}
        />
        <button className="btn-secondary" disabled={busy} onClick={check} title="grpc.health.v1.Health/Check">
          {busy ? 'Checking…' : 'Check'}
        </button>
      </div>
      <OutcomeView o={busy ? { ok: false, busy: true, text: 'Checking…' } : result} secrets={[]} />
      <div className="hint">
        Calls <code>grpc.health.v1.Health/Check</code> to see whether the server is <code>SERVING</code>. Name a service to
        check just that one.
      </div>
    </>
  );
}
