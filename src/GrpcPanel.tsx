import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { SaveAs } from './SaveAs';
import AuthBox, { AUTH_DEFAULTS, authHeader, type AuthState } from './AuthBox';
import { rowKeyDown, rowTabIndex } from './rowNav';
import { RequestVarsBox } from './RequestVarsBox';
import { callConnect } from './connect';
import { withoutSecretValues } from './VarList';
import { useFlash } from './useFlash';
import { Empty, PanelHead, ReqTabs, Section, persistLater } from './ui';
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
  /**
   * Where the Service/Method list comes from. A gateway needs a descriptor to
   * encode gRPC-Web, so it is always 'proto'; a direct target can ask the
   * server itself. Held in state rather than inferred from whether reflection
   * has returned yet, so the panel changes the moment the transport does.
   */
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
  // per-tab secret values the last send used, to mask them in the shown request headers
  const [secretsMap, setSecretsMap] = useState<Record<number, string[]>>({});
  const envs = useEnvs();

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
  const [reflSvcFilter, setReflSvcFilter] = useState('');
  const [reflMethodFilter, setReflMethodFilter] = useState('');
  /** Show the .proto picker instead of the server's own list. */
  const useProtoInstead = () => {
    set('methodSource', 'proto');
    setReflSvcs(null);
    setReflErr('');
    setReflSvcSel('');
    setReflMethodSel('');
  };

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
    setSecretsMap((m) => {
      const c = { ...m };
      delete c[id];
      return c;
    });
    if (id === activeId) setActiveId(next[Math.max(0, idx - 1)].id);
  };


  const [toast, flash] = useFlash();

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
    flash(
      usesVars(Object.values(templatesOf(form, url)), form.vars)
        ? 'cURL script copied — {{variables}} are left as written'
        : 'cURL script copied',
    );
  };

  const copyShareLink = async () => {
    // strip ALL credentials from the share payload: auth and secret variable values
    const { auth: _omit, ...rest } = { ...form, vars: { ...form.vars, vars: withoutSecretValues(form.vars.vars) } };
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
    setReflBusy(true);
    setReflErr('');
    setReflSvcs(null);
    let target: string;
    try {
      target = override ? override.target : (await directTarget()).target;
    } catch (e: any) {
      setReflErr(`variables: ${e?.message ?? e}`);
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
      }).then((x) => x.json());
      if (!r.ok) {
        setReflErr(r.error || 'reflection failed');
      } else {
        setReflSvcs(r.services);
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
    let res: CallResult;
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
        });
      } catch (e) {
        res = { ok: false, stage: 'network', error: String(e) };
      }
      setResultFor(tid, res);
      extractAfter(sentForm, res, sentEnv, true);
      setBusyMap((mm) => ({ ...mm, [tid]: false }));
      return;
    }
    try {
      const r = await fetch('/api/grpc/reflect/call', {
        method: 'POST',
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
      res = (await r.json()) as CallResult;
    } catch (e) {
      res = { ok: false, stage: 'network', error: String(e) };
    }
    setResultFor(tid, res);
    extractAfter(sentForm, res, sentEnv, true);
    setBusyMap((mm) => ({ ...mm, [tid]: false }));
  };

  // ------------------------------------------------------------------- UI --

  /**
   * Which Service/Method picker is showing.
   *
   * A gateway has to encode gRPC-Web from a descriptor, so it is always the
   * .proto pipeline. A direct target asks the server by default, and can fall
   * back to .proto for servers with reflection turned off.
   *
   * Held in the form so the panel answers the transport choice immediately,
   * without waiting on a network round trip to decide what to show.
   */
  const source: 'proto' | 'reflection' =
    form.transport === 'gateway' ? 'proto' : form.methodSource;
  const reflecting = source === 'reflection';

  /* The reflected method in hand, so the one Invoke button below can answer for
     both pickers: which call to make, whether it is callable, and what to say
     when it is not. Without this the button can only see `current`, which the
     .proto pipeline fills and reflection never does. */
  const reflSvc = reflSvcs?.find((s) => s.service === reflSvcSel);
  const reflMethod = reflecting
    ? reflSvc?.methods.find((m) => m.name === reflMethodSel) ?? null
    : null;
  /* Why the reflected method cannot be called from here, or '' when it can. Server
     streaming works over gRPC; sending a stream does not fit a single request body. */
  const unsupported = !reflMethod
    ? ''
    : reflMethod.requestStream
      ? 'client / bidi streaming — not supported'
      : reflMethod.responseStream && form.rpcProtocol === 'connect'
        ? 'server streaming needs gRPC, not Connect'
        : '';
  const canInvoke = reflecting ? !!reflMethod && !unsupported : !!current;
  /* The one gate for both the button and Cmd/Ctrl+Enter, so the keyboard path
     cannot fire a call the button refuses. */
  const invoke = () => {
    if (busy || !canInvoke) return;
    return reflecting ? sendReflect() : send();
  };

  /* Filtering matches the .proto picker: the same two boxes, the same n/total
     counts. The selected entry is always kept in its list, so narrowing the
     filter can never leave the select showing something other than what is
     actually selected. */
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
        addTitle="New request tab (copies this one)"
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
                    <input
                      value={form.targetHost}
                      spellCheck={false}
                      placeholder="localhost"
                      onChange={(e) => set('targetHost', e.target.value)}
                    />
                  </div>
                  <div className="conn-sm">
                    <label>Port</label>
                    <input value={form.targetPort} placeholder="50051" onChange={(e) => set('targetPort', e.target.value)} />
                  </div>
                  <label className="check" title="Plaintext means no TLS. Untick it for public TLS endpoints.">
                    <input type="checkbox" checked={form.plaintext} onChange={(e) => set('plaintext', e.target.checked)} />
                    Plaintext
                  </label>
                </div>
                <div className="hint">
                  A local service or a kubectl port-forward. Plaintext means no TLS; untick it for public TLS endpoints.
                </div>
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
                <input
                  className="mt-2"
                  value={form.base}
                  spellCheck={false}
                  aria-label="Gateway base URL"
                  placeholder="https://gateway.example.com"
                  onChange={(e) => {
                    set('base', e.target.value);
                    set('urlOverride', '');
                  }}
                />

                <label>Route prefix</label>
                <div className="row row-tight">
                  <input
                    className="grow"
                    list="grpc-prefixes"
                    value={form.prefix}
                    spellCheck={false}
                    placeholder="/myservice"
                    onChange={(e) => {
                      set('prefix', e.target.value);
                      set('urlOverride', '');
                    }}
                  />
                  <datalist id="grpc-prefixes">
                    {savedPrefixes.map((p) => (
                      <option key={p} value={p} />
                    ))}
                  </datalist>
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
                    {reflBusy ? 'Asking the server…' : 'Reflect services'}
                  </button>
                  <span className="hint grow">Lists the server's services and methods. Needs gRPC reflection enabled.</span>
                </div>
                {reflErr && <div className="error">{reflErr}</div>}
                {reflSvcs && reflSvcs.length === 0 && (
                  <div className="hint">The server exposes no services through reflection. Use .proto files instead.</div>
                )}
              </>
            )}
            {reflecting && reflSvcs && reflSvcs.length > 0 && (
              <div className="refl-box">
                <div className="refl-head">
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
                  <span className="hint m-0">{reflSvcs.length} services</span>
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
                <input value={form.root} spellCheck={false} onChange={(e) => set('root', e.target.value)} />
                <div className="hint">Folder scanned for .proto files.</div>
                {rootError && <div className="error">{rootError}</div>}

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
                <input value={url} spellCheck={false} onChange={(e) => set('urlOverride', e.target.value)} />
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
              {form.transport === 'gateway' && (
                <button type="button" className="chip" onClick={copyCurl}>
                  Copy as cURL script
                </button>
              )}
              <button type="button" className="chip" onClick={copyShareLink} title="A link that opens this request, without auth">
                Copy share link
              </button>
            </div>
          </Section>

          <div className="action-bar">
            <button className="btn-primary" disabled={busy || !canInvoke} onClick={invoke} title={unsupported}>
              {busy ? 'Invoking…' : 'Invoke'}
            </button>
            {unsupported ? (
              <span className="hint text-warn">{unsupported}</span>
            ) : !canInvoke ? (
              <span className="hint">{reflecting ? 'Reflect and pick a method first.' : 'Pick a method first.'}</span>
            ) : (
              <span className="hint">
                <kbd>⌘↵</kbd> in the body also invokes
              </span>
            )}
            <span className="spacer" />
            <label className="check" title="Request timeout in milliseconds">
              Timeout
              <input className="w-xs" value={timeout} inputMode="numeric" onChange={(e) => setTimeoutMs(e.target.value)} />
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
              {busy && <div className="status busy">Calling {form.rpc || 'the method'}…</div>}
              <div className={busy && result ? 'stale' : undefined}>
              {result &&
                (result.ok ? (
                  <div className={`status ${statusOk ? 'ok' : 'bad'}`}>
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
                    <span>{result.rawBytes} B</span>
                    {result.frames > 1 && (
                      <>
                        <span className="sep">·</span>
                        <span>{result.frames} messages (stream)</span>
                      </>
                    )}
                  </div>
                ) : (
                  <div className="status bad">
                    <span>Failed at {result.stage}</span>
                    {result.httpStatus ? (
                      <>
                        <span className="sep">·</span>
                        <span>HTTP {result.httpStatus}</span>
                      </>
                    ) : null}
                    {result.durationMs != null && (
                      <>
                        <span className="sep">·</span>
                        <span>{result.durationMs} ms</span>
                      </>
                    )}
                  </div>
                ))}

              {result?.ok && (
                <div className="result-bar">
                  {(result.headers || result.trailers) && (
                    <button
                      type="button"
                      className={`btn-ghost btn-sm ${showHeaders ? 'btn-on' : ''}`}
                      aria-pressed={showHeaders}
                      onClick={() => setShowHeaders((s) => !s)}
                    >
                      {showHeaders ? 'Hide headers' : 'Show headers'}
                    </button>
                  )}
                  <span className="spacer" />
                  <button type="button" className="btn-ghost btn-sm" onClick={copyResponse}>
                    Copy
                  </button>
                </div>
              )}

              {result?.ok && showHeaders && (
                <div className="mb-3">
                  <HeaderTable title="Request headers (sent by Conduit)" rows={result.reqHeaders} mask={secretsMap[active.id] ?? []} />
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
                        JSON body, then <kbd>Invoke</kbd>. Try the public test server <code>grpcb.in:9000</code>.
                      </>
                    }
                  >
                    <button className="btn-secondary btn-sm" onClick={() => loadExample(EXAMPLES.grpc)}>
                      Try grpcb.in:9000
                    </button>
                  </Empty>
                )
              ) : (
                <GrpcBody result={result} />
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
                  hint="Every Invoke is recorded here with its response. Click one to restore it; star it to keep it."
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

function HeaderTable({ title, rows, mask = [] }: { title: string; rows?: Record<string, string>; mask?: string[] }) {
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
                <td>{maskSecrets(v, mask)}</td>
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

const GrpcBody = memo(function GrpcBody({ result }: { result: CallResult }) {
  return (
    <>
      {result.ok && result.statusDetails && (
        <div className="mb-2">
          <div className="block-label">Error details</div>
          <pre>{JSON.stringify(result.statusDetails, null, 2)}</pre>
        </div>
      )}
      <pre>
        {result.ok
          ? result.decoded || (result.grpcStatus === '0' ? '(empty response body)' : '(no response body)')
          : result.error}
      </pre>
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
      {h.body && <div className="hist-body">{h.body}</div>}
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
  const [result, setResult] = useState<{ ok: boolean; text: string; reached?: boolean } | null>(null);

  // a result is about the target it was taken against
  useEffect(() => setResult(null), [target, plaintext]);

  const check = async () => {
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
      }).then((x) => x.json());
      setResult(
        r.ok
          ? { ok: r.status === 'SERVING', text: `${r.status} · ${r.durationMs} ms`, reached: true }
          : { ok: false, text: r.error ?? 'health check failed' },
      );
    } catch (e) {
      setResult({ ok: false, text: String(e) });
    }
    setBusy(false);
  };

  return (
    <>
      <label>
        Health check{' '}
        <span
          className="help"
          title="Calls grpc.health.v1.Health/Check. SERVING means the server (or the named service) is up and ready. Leave the service empty to check the whole server."
        >
          ?
        </span>
      </label>
      <div className="row">
        <input
          className="grow"
          value={service}
          spellCheck={false}
          placeholder="service name, or empty for the whole server"
          aria-label="Health check service"
          onChange={(e) => setService(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && check()}
        />
        <button className="btn-secondary" disabled={busy} onClick={check} title="grpc.health.v1.Health/Check">
          {busy ? 'Checking…' : 'Check health'}
        </button>
        {result && (
          <span className={`pill ${result.ok ? 'ok' : 'bad'}`} aria-live="polite" title={result.text}>
            {result.reached ? result.text : 'Failed'}
          </span>
        )}
      </div>
      {result && !result.reached && <div className="error break">{result.text}</div>}
      <div className="hint">
        Calls <code>grpc.health.v1.Health/Check</code> to see whether the server is <code>SERVING</code>. Name a service to
        check just that one.
      </div>
    </>
  );
}
