import { memo, useMemo, useRef, useState } from 'react';
import { useFlash } from './useFlash';
import { SaveAs } from './SaveAs';
import AuthBox, { AUTH_DEFAULTS, authHeader, type AuthState } from './AuthBox';
import JsonTree from './JsonTree';
import { rowKeyDown, rowTabIndex } from './rowNav';
import { RequestVarsBox } from './RequestVarsBox';
import { withoutSecretValues } from './VarList';
import { Empty, LongField, PanelHead, ReqTabs, Section, usePersist } from './ui';
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
import { appendQuery } from './url';

const LS_FORM = 'conduit.http.form.v2';
const LS_TABS = 'conduit.http.tabs.v1';
const LS_SAVED = 'conduit.http.saved.v1';
const LS_HISTORY = 'conduit.http.history.v1';
const HISTORY_MAX = 30;
const SNAP_MAX = 20_000;

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
type BodyKind = 'none' | 'json' | 'raw' | 'form' | 'multipart';

interface KV {
  key: string;
  value: string;
}
interface FileItem {
  field: string;
  name: string;
  contentB64: string;
}

interface HttpForm {
  method: string;
  url: string;
  query: KV[];
  headers: string; // extra headers, k: v per line
  auth: AuthState;
  bodyKind: BodyKind;
  body: string; // json/raw text
  form: KV[];
  files: FileItem[];
  timeoutMs: string;
  /** `{{name}}` variables, computed values and response extraction for this request. */
  vars: RequestVars;
}

interface HttpResult {
  ok: boolean;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  bodyText?: string;
  truncated?: boolean;
  durationMs?: number;
  size?: number;
  error?: string;
  binary?: boolean;
  contentType?: string;
  bodyBase64?: string;
}

interface HttpHist {
  at: string;
  form: HttpForm;
  ok: boolean;
  status?: number;
  durationMs?: number;
  snapshot?: { text: string; truncated: boolean };
}

const DEFAULTS: HttpForm = {
  method: 'GET',
  url: '',
  query: [],
  headers: '',
  auth: AUTH_DEFAULTS,
  bodyKind: 'none',
  body: '',
  form: [],
  files: [],
  timeoutMs: '15000',
  vars: NO_REQUEST_VARS,
};

function tryParse(s: unknown): unknown | undefined {
  if (typeof s !== 'string') return undefined;
  const t = s.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

function loadJson<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback;
  } catch {
    return fallback;
  }
}

/** Merge saved partial into DEFAULTS, keeping nested objects complete. */
function hydrate(saved: Partial<HttpForm>): HttpForm {
  return {
    ...DEFAULTS,
    ...saved,
    auth: { ...AUTH_DEFAULTS, ...(saved.auth ?? {}) },
    query: saved.query ?? [],
    form: saved.form ?? [],
    files: saved.files ?? [],
    vars: { ...NO_REQUEST_VARS, ...(saved.vars ?? {}) },
  };
}

/** `form` as kept without the user saving it: no auth, no secret variable values. */
function unsaved(form: HttpForm): HttpForm {
  return { ...form, auth: AUTH_DEFAULTS, vars: { ...form.vars, vars: withoutSecretValues(form.vars.vars) } };
}

/** Whether `f` sends a body at all. */
function sendsBody(f: HttpForm): boolean {
  return f.bodyKind !== 'none' && f.method !== 'GET' && f.method !== 'HEAD';
}

/**
 * The text fields `f` will actually send that may hold `{{name}}` references, keyed by how
 * an error should name them. Fields a send leaves out (another auth type's, a body on GET)
 * are not filled, so a stale reference there cannot block the request.
 */
function templatesOf(f: HttpForm): Record<string, string> {
  const t: Record<string, string> = { URL: f.url, headers: f.headers };
  if (f.auth.type === 'bearer' || f.auth.type === 'oauth2') t['auth token'] = f.auth.bearer;
  if (f.auth.type === 'basic') {
    t['auth user'] = f.auth.basicUser;
    t['auth password'] = f.auth.basicPass;
  }
  if (f.auth.type === 'raw') t['auth value'] = f.auth.raw;
  f.query.forEach((q, i) => {
    t[`query param ${i + 1} name`] = q.key;
    t[`query param ${i + 1} value`] = q.value;
  });
  if (sendsBody(f) && (f.bodyKind === 'json' || f.bodyKind === 'raw')) t.body = f.body;
  if (sendsBody(f) && (f.bodyKind === 'form' || f.bodyKind === 'multipart'))
    f.form.forEach((q, i) => {
      t[`form field ${i + 1} name`] = q.key;
      t[`form field ${i + 1} value`] = q.value;
    });
  return t;
}

/** `f` with the fields `templatesOf(f)` named replaced by their filled values in `r`. */
function applyRendered(f: HttpForm, r: Record<string, string>): HttpForm {
  const v = (key: string, fallback: string) => r[key] ?? fallback;
  return {
    ...f,
    url: v('URL', f.url),
    headers: v('headers', f.headers),
    body: v('body', f.body),
    auth: {
      ...f.auth,
      bearer: v('auth token', f.auth.bearer),
      basicUser: v('auth user', f.auth.basicUser),
      basicPass: v('auth password', f.auth.basicPass),
      raw: v('auth value', f.auth.raw),
    },
    query: f.query.map((q, i) => ({ key: v(`query param ${i + 1} name`, q.key), value: v(`query param ${i + 1} value`, q.value) })),
    form: f.form.map((q, i) => ({ key: v(`form field ${i + 1} name`, q.key), value: v(`form field ${i + 1} value`, q.value) })),
  };
}

/** Request headers of `f`: the extra header lines, then its Authorization. */
function headersOf(f: HttpForm): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of f.headers.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const a = authHeader(f.auth);
  if (a) out['authorization'] = a;
  return out;
}

/** The URL of `f` with its query parameters appended. */
function urlOf(f: HttpForm): string {
  const active = f.query.filter((q) => q.key);
  if (!active.length) return f.url;
  const qs = active.map((q) => `${encodeURIComponent(q.key)}=${encodeURIComponent(q.value)}`).join('&');
  return appendQuery(f.url, qs);
}

// ── Chrome-style request tabs: each tab is an independent request; history +
// saved requests are shared. Mirrors the gRPC panel.
interface HttpTab {
  id: number;
  form: HttpForm;
}
function loadTabs(): { tabs: HttpTab[]; activeId: number } {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_TABS) ?? 'null');
    if (raw && Array.isArray(raw.tabs) && raw.tabs.length) {
      const tabs: HttpTab[] = raw.tabs.map((t: any, i: number) => ({
        id: t.id ?? i + 1,
        form: hydrate(t.form ?? {}),
      }));
      const activeId = tabs.some((t) => t.id === raw.activeId) ? raw.activeId : tabs[0].id;
      return { tabs, activeId };
    }
  } catch {
    /* fall through to migration */
  }
  // migrate a pre-tabs single form (LS_FORM), else start with one empty tab
  const old = loadJson<Partial<HttpForm>>(LS_FORM, {});
  return { tabs: [{ id: 1, form: hydrate(old) }], activeId: 1 };
}

// ── cURL parsing (import) ────────────────────────────────────────────────────
function parseCurl(text: string): Partial<HttpForm> | { error: string } | null {
  let cleaned = text.replace(/\\\r?\n/g, ' '); // join line-continuations
  // tolerate comments / `cd … &&` wrappers: start parsing at the curl token
  const idx = cleaned.search(/(^|\s)curl\s/);
  if (idx === -1) return null;
  cleaned = cleaned.slice(idx).replace(/^\s*curl\b/, 'curl');
  // gRPC-Web export (from the gRPC panel) — not a REST request
  if (/application\/grpc-web|x-grpc-web|--data-binary\s+@/.test(cleaned))
    return { error: 'This is a gRPC-Web request — use the gRPC panel, not HTTP.' };
  const toks: string[] = [];
  const re = /'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+)/g;
  let m;
  while ((m = re.exec(cleaned))) toks.push(m[1] ?? m[2]?.replace(/\\"/g, '"') ?? m[3]);
  const out: Partial<HttpForm> = { headers: '', query: [] };
  let method = '';
  const headerLines: string[] = [];
  let body = '';
  let auth: AuthState | undefined;
  for (let i = 1; i < toks.length; i++) {
    const a = toks[i];
    if (a === '-X' || a === '--request') method = toks[++i]?.toUpperCase() ?? '';
    else if (a === '-H' || a === '--header') {
      const line = toks[++i] ?? '';
      const idx = line.indexOf(':');
      if (idx > 0 && line.slice(0, idx).trim().toLowerCase() === 'authorization') {
        auth = { ...AUTH_DEFAULTS, type: 'raw', raw: line.slice(idx + 1).trim() };
      } else headerLines.push(line);
    } else if (a === '-d' || a === '--data' || a === '--data-raw' || a === '--data-binary') {
      body = toks[++i] ?? '';
    } else if (a === '-u' || a === '--user') {
      const [u, ...p] = (toks[++i] ?? '').split(':');
      auth = { ...AUTH_DEFAULTS, type: 'basic', basicUser: u, basicPass: p.join(':') };
    } else if (!a.startsWith('-') && !out.url) {
      out.url = a;
    }
  }
  if (out.url && out.url.includes('?')) {
    const [base, qs] = out.url.split('?');
    out.url = base;
    out.query = [...(qs ? new URLSearchParams(qs) : [])].map(([key, value]) => ({ key, value }));
  }
  out.method = method || (body ? 'POST' : 'GET');
  out.headers = headerLines.join('\n');
  if (auth) out.auth = auth;
  if (body) {
    out.body = body;
    out.bodyKind = tryParse(body) !== undefined ? 'json' : 'raw';
  }
  return out;
}

function KvTable({
  rows,
  onChange,
  ph,
}: {
  rows: KV[];
  onChange: (r: KV[]) => void;
  ph: [string, string];
}) {
  const display = [...rows, { key: '', value: '' }];
  const edit = (i: number, patch: Partial<KV>) => {
    const next = display.map((r, j) => (j === i ? { ...r, ...patch } : r));
    onChange(next.filter((r) => r.key || r.value));
  };
  return (
    <div className="kv">
      {display.map((r, i) => (
        <div key={i} className="kv-row">
          <input
            placeholder={ph[0]}
            value={r.key}
            spellCheck={false}
            aria-label={`${ph[0]} ${i + 1}`}
            onChange={(e) => edit(i, { key: e.target.value })}
          />
          <LongField
            placeholder={ph[1]}
            value={r.value}
            spellCheck={false}
            aria-label={`${ph[1]} ${i + 1}`}
            onChange={(value) => edit(i, { value })}
          />
          {i < rows.length ? (
            <button
              type="button"
              className="btn-ghost btn-icon btn-danger"
              aria-label={`Remove ${r.key || 'row'}`}
              title="Remove"
              onClick={() => onChange(rows.filter((_, j) => j !== i))}
            >
              ✕
            </button>
          ) : (
            <span />
          )}
        </div>
      ))}
    </div>
  );
}

const ResponseBody = memo(function ResponseBody({
  result,
  parsed,
  view,
}: {
  result: HttpResult;
  parsed: unknown;
  view: string;
}) {
  if (!result.ok) return <pre>{result.error}</pre>;
  if (result.binary)
    return (
      <div>
        <div className="hint mb-2">
          Binary response ({result.contentType || 'unknown type'}, {result.size} B), not shown as text.
        </div>
        <button
          className="btn-secondary"
          title="Save the binary response to a file"
          onClick={() => {
            const bin = atob(result.bodyBase64 ?? '');
            const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
            const url = URL.createObjectURL(new Blob([bytes], { type: result.contentType || 'application/octet-stream' }));
            const a = document.createElement('a');
            a.href = url;
            a.download =
              'response' +
              (result.contentType?.includes('image/png') ? '.png' : result.contentType?.includes('pdf') ? '.pdf' : '.bin');
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          Download
        </button>
      </div>
    );
  if (parsed !== undefined && view === 'tree') return <JsonTree data={parsed} />;
  if (parsed !== undefined && view === 'pretty') return <pre>{JSON.stringify(parsed, null, 2)}</pre>;
  return <pre>{result.bodyText || '(empty body)'}</pre>;
});

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export default function HttpPanel() {
  const init = useRef<{ tabs: HttpTab[]; activeId: number } | null>(null);
  if (!init.current) init.current = loadTabs();
  const [tabs, setTabs] = useState<HttpTab[]>(init.current.tabs);
  const [activeId, setActiveId] = useState<number>(init.current.activeId);
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const form = active.form;
  const setForm = (u: HttpForm | ((f: HttpForm) => HttpForm)) =>
    setTabs((ts) =>
      ts.map((t) => (t.id === active.id ? { ...t, form: typeof u === 'function' ? (u as (f: HttpForm) => HttpForm)(t.form) : u } : t)),
    );

  const [saved, setSaved] = useState<{ name: string; form: HttpForm }[]>(() => loadJson(LS_SAVED, []));
  const [pickedSaved, setPickedSaved] = useState('');
  // per-tab result & busy (in memory only), so parallel sends don't clobber
  const [resultsMap, setResultsMap] = useState<Record<number, HttpResult | null>>({});
  const [busyMap, setBusyMap] = useState<Record<number, boolean>>({});
  const result = resultsMap[activeId] ?? null;
  const busy = !!busyMap[activeId];
  const setResult = (r: HttpResult | null) => setResultsMap((m) => ({ ...m, [activeId]: r }));
  const [showHeaders, setShowHeaders] = useState(false);
  const [respView, setRespView] = useState<'pretty' | 'tree' | 'raw'>('tree');
  const [hist, setHist] = useState<HttpHist[]>(() => loadJson(LS_HISTORY, []));
  const [tab, setTab] = useState<'response' | 'history'>('response');

  const set = <K extends keyof HttpForm>(k: K, v: HttpForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  const persisted = useMemo(() => ({ tabs, activeId }), [tabs, activeId]);
  usePersist(LS_TABS, persisted, () =>
    JSON.stringify({ tabs: tabs.map((t) => ({ id: t.id, form: { ...unsaved(t.form), files: [] } })), activeId }),
  );

  // ── tab operations ──────────────────────────────────────────────────────────
  const tabLabel = (t: HttpTab) => {
    const host = t.form.url.replace(/^https?:\/\//, '').split(/[/?]/)[0] || 'new';
    return `${t.form.method} ${host}`;
  };
  const addTab = () => {
    const id = Math.max(0, ...tabs.map((t) => t.id)) + 1;
    setTabs((ts) => [...ts, { id, form: hydrate({}) }]);
    setActiveId(id);
  };
  const closeTab = (id: number) => {
    if (tabs.length === 1) return;
    const idx = tabs.findIndex((t) => t.id === id);
    const next = tabs.filter((t) => t.id !== id);
    setTabs(next);
    setResultsMap((m) => { const c = { ...m }; delete c[id]; return c; });
    setBusyMap((m) => { const c = { ...m }; delete c[id]; return c; });
    if (id === activeId) setActiveId(next[Math.max(0, idx - 1)].id);
  };

  const parseHeaders = () => headersOf(form);
  const fullUrl = useMemo(() => urlOf(form), [form]);
  const envs = useEnvs();

  const send = async () => {
    if (!form.url.trim() || busyMap[active.id]) return; // no-op while a send is in flight
    const tid = active.id; // pin the originating tab — user may switch mid-flight
    const sentForm = form; // snapshot: history must record what was actually sent
    const sentEnv = envs.active; // extracted values go back to the environment that was used
    setBusyMap((m) => ({ ...m, [tid]: true }));
    setTab('response');
    // fill {{variables}} first; a request that cannot be filled is not sent
    let out = sentForm;
    let secrets: string[] = [];
    const templates = templatesOf(sentForm);
    if (usesVars(Object.values(templates), sentForm.vars)) {
      try {
        const resolved = await resolve(templates, sentForm.vars, activeEnv(envs));
        out = applyRendered(sentForm, resolved.rendered);
        secrets = resolved.secrets;
      } catch (e: any) {
        setResultsMap((m) => ({ ...m, [tid]: { ok: false, error: `variables: ${e?.message ?? e}` } }));
        setBusyMap((m) => ({ ...m, [tid]: false }));
        return;
      }
    }
    const kindForServer = out.bodyKind === 'json' ? 'raw' : out.bodyKind;
    const headers = headersOf(out);
    if (out.bodyKind === 'json' && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type'))
      headers['content-type'] = 'application/json';
    let res: HttpResult;
    try {
      res = await fetch('/api/http/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          url: urlOf(out),
          method: out.method,
          headers,
          bodyKind: kindForServer,
          body: out.body,
          form: out.form.filter((f) => f.key),
          files: out.files.filter((f) => f.field && f.name),
          timeoutMs: Number(out.timeoutMs) || 15000,
        }),
      }).then((r) => r.json());
    } catch (e) {
      res = { ok: false, error: String(e) };
    }
    setResultsMap((m) => ({ ...m, [tid]: res }));
    if (res.ok && sentForm.vars.extract.some((x) => x.name.trim() && x.path.trim())) {
      // only a successful answer is read: an error body must not overwrite a good value
      if ((res.status ?? 0) < 200 || (res.status ?? 0) >= 300)
        flash(`Nothing extracted: the response was HTTP ${res.status}`);
      else
        extractInto(sentForm.vars.extract, { body: res.bodyText ?? '', headers: res.headers ?? {}, jsonBody: true }, sentEnv).then(
          ({ env, names }) => names.length && flash(`Saved ${names.join(', ')} to environment "${env}"`),
          (e) => flash(String(e?.message ?? e)),
        );
    }
    // a server may echo what it was sent: the kept snapshot never carries a secret value
    const text = maskSecrets(res.ok ? (res.bodyText ?? '') : (res.error ?? ''), secrets);
    setHist((h) => {
      const next: HttpHist[] = [
        {
          at: new Date().toISOString(),
          // strip credentials and secret values — history is an implicit record of every
          // request; saved requests keep them, opt-in. {{templates}} are kept as written.
          form: unsaved(sentForm),
          ok: res.ok && (res.status ?? 0) < 400,
          status: res.status,
          durationMs: res.durationMs,
          snapshot: { text: text.slice(0, SNAP_MAX), truncated: text.length > SNAP_MAX },
        },
        ...h,
      ].slice(0, HISTORY_MAX);
      localStorage.setItem(LS_HISTORY, JSON.stringify(next));
      return next;
    });
    setBusyMap((m) => ({ ...m, [tid]: false }));
  };

  const persistSaved = (next: { name: string; form: HttpForm }[]) => {
    setSaved(next);
    localStorage.setItem(LS_SAVED, JSON.stringify(next));
  };
  const [flashMsg, flash] = useFlash();


  /**
   * A cURL command is multi-line and long, so it is pasted into a field rather
   * than a single-line dialog, and the outcome is reported in the same place
   * every other outcome in this panel is.
   */
  const [curlOpen, setCurlOpen] = useState(false);
  const [curlText, setCurlText] = useState('');

  const importCurl = () => {
    const text = curlText.trim();
    if (!text) return flash('Paste a cURL command first');
    const parsed = parseCurl(text);
    if (!parsed) return flash('No cURL command found in that text');
    if ('error' in parsed) return flash(parsed.error);
    setForm((f) => hydrate({ ...f, ...parsed }));
    setCurlText('');
    setCurlOpen(false);
    flash('Request filled from cURL');
  };
  const exportCurl = () => {
    const lines = [`curl -X ${form.method} '${fullUrl}'`];
    for (const [k, v] of Object.entries(parseHeaders()))
      lines.push(`  -H '${k}: ${v.replace(/'/g, "'\\''")}'`);
    if (!['GET', 'HEAD'].includes(form.method) && form.bodyKind !== 'none') {
      if (form.bodyKind === 'form')
        lines.push(`  --data '${form.form.filter((f) => f.key).map((f) => `${f.key}=${f.value}`).join('&')}'`);
      else if (form.bodyKind === 'multipart')
        form.form.filter((f) => f.key).forEach((f) => lines.push(`  -F '${f.key}=${f.value}'`));
      else if (form.body) lines.push(`  --data-raw '${form.body.replace(/'/g, "'\\''")}'`);
    }
    navigator.clipboard.writeText(lines.join(' \\\n')).then(
      () => flash(form.vars && usesVars(Object.values(templatesOf(form)), form.vars)
        ? 'Copied as cURL — {{variables}} are left as written'
        : 'Copied as cURL'),
      () => flash('Copy failed — the clipboard is not available'),
    );
  };

  const restore = (h: HttpHist) => {
    setForm(hydrate(h.form));
    if (h.snapshot)
      setResult({
        ok: (h.status ?? 0) < 400,
        status: h.status,
        bodyText: h.snapshot.text + (h.snapshot.truncated ? '\n… (truncated in history)' : ''),
        durationMs: h.durationMs,
      });
    setTab('response');
  };

  const parsedResp = useMemo(
    () => (result?.ok ? tryParse(result.bodyText) : undefined),
    [result?.ok, result?.bodyText],
  );

  /* A response that is not JSON offers only the raw view. `respView` is sticky
     across responses, so it can name a view the current response does not have;
     the effective view is what both the tab strip and the body render from, so
     the highlighted tab always matches what is on screen. */
  const respViews = parsedResp !== undefined ? (['tree', 'pretty', 'raw'] as const) : (['raw'] as const);
  const respViewEff = (respViews as readonly string[]).includes(respView) ? respView : 'raw';

  const loadExample = (ex: typeof EXAMPLES.http) => {
    const blank = !form.url.trim();
    const next = hydrate({ method: ex.method, url: ex.url, query: ex.query });
    if (blank) setForm(next);
    else {
      const id = Math.max(0, ...tabs.map((t) => t.id)) + 1;
      setTabs((ts) => [...ts, { id, form: next }]);
      setActiveId(id);
    }
    setTab('response');
  };
  useExample<typeof EXAMPLES.http>('http', loadExample);

  const activeQuery = form.query.filter((q) => q.key).length;
  const bodyAllowed = form.method !== 'GET' && form.method !== 'HEAD';

  return (
    <div className="grpc-wrap">
      <ReqTabs
        tabs={tabs}
        activeId={activeId}
        ariaLabel="Request tabs"
        label={tabLabel}
        title={(t) => t.form.url || 'New request'}
        state={(t) => (busyMap[t.id] ? 'busy' : undefined)}
        onSelect={setActiveId}
        onClose={closeTab}
        onAdd={addTab}
        addTitle="New request tab"
      />

      <div className="layout">
        <div className="left">
          <PanelHead
            title="HTTP"
            tagline="Send a request, then read the response on the right. Every send is kept in History."
            actions={
              <>
                <button
                  className={`btn-ghost btn-sm ${curlOpen ? 'btn-on' : ''}`}
                  title="Fill this request from a pasted cURL command"
                  onClick={() => setCurlOpen((o) => !o)}
                >
                  Import cURL
                </button>
                <button className="btn-ghost btn-sm" title="Copy this request as a cURL command" onClick={exportCurl}>
                  Copy as cURL
                </button>
              </>
            }
          />

          <div className="saved-bar">
            <select
              value={pickedSaved}
              aria-label="Saved requests"
              onChange={(e) => {
                setPickedSaved(e.target.value);
                const s = saved.find((x) => x.name === e.target.value);
                if (s) setForm(hydrate(s.form));
              }}
            >
              <option value="">{saved.length ? 'Open a saved request…' : 'No saved requests yet'}</option>
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
                setPickedSaved(name);
                return `Saved "${name}"`;
              }}
              onMessage={flash}
            />
            <button
              className="btn-secondary btn-danger"
              title="Delete the selected saved request"
              disabled={!pickedSaved}
              onClick={() => {
                persistSaved(saved.filter((s) => s.name !== pickedSaved));
                setPickedSaved('');
              }}
            >
              Delete
            </button>
          </div>
          {flashMsg && <div className="toast">{flashMsg}</div>}

          {curlOpen && (
            <div className="refl-box">
              <textarea
                rows={4}
                spellCheck={false}
                autoFocus
                placeholder="curl 'https://api.example.com/v1/things' -H 'authorization: Bearer …'"
                value={curlText}
                onChange={(e) => setCurlText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) importCurl();
                }}
              />
              <div className="inline mt-2">
                <button className="btn-primary" onClick={importCurl}>
                  Fill from cURL
                </button>
                <button
                  className="btn-ghost"
                  onClick={() => {
                    setCurlOpen(false);
                    setCurlText('');
                  }}
                >
                  Cancel
                </button>
                <span className="hint m-0">Paste the whole command. <kbd>⌘↵</kbd> fills.</span>
              </div>
            </div>
          )}

          <Section title="Request">
            <div className="row row-tight">
              <select className="w-sm" aria-label="Method" value={form.method} onChange={(e) => set('method', e.target.value)}>
                {METHODS.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
              <LongField
                url
                className="grow"
                value={form.url}
                spellCheck={false}
                aria-label="URL"
                placeholder="https://httpbin.org/get"
                onChange={(v) => set('url', v)}
                onEnter={() => send()}
              />
              <button className="btn-primary" disabled={busy || !form.url.trim()} onClick={send} title="Send (Enter in the URL, or ⌘↵ in the body)">
                {busy ? 'Sending…' : 'Send'}
              </button>
            </div>
            {activeQuery > 0 ? (
              <div className="hint break">Sends to {fullUrl}</div>
            ) : (
              <div className="hint">
                Press <kbd>Enter</kbd> to send. Use <code>{'{{name}}'}</code> for values from Variables below.
              </div>
            )}
          </Section>

          <Section
            title={
              <>
                Query params {activeQuery > 0 && <span className="count">({activeQuery})</span>}
              </>
            }
            hint={<>Appended to the URL as <code>?key=value</code>, encoded for you.</>}
          >
            <KvTable rows={form.query} onChange={(r) => set('query', r)} ph={['key', 'value']} />
          </Section>

          <RequestVarsBox
            key={active.id}
            value={form.vars}
            onChange={(v) => set('vars', v)}
            texts={Object.values(templatesOf(form))}
            onMessage={flash}
          />

          <AuthBox value={form.auth} onChange={(a) => set('auth', a)} />

          <Section
            title="Body"
            hint={!bodyAllowed && form.bodyKind !== 'none' ? `${form.method} requests are sent without a body.` : undefined}
          >
            <div className="seg" role="group" aria-label="Body type">
              {(
                [
                  ['none', 'None'],
                  ['json', 'JSON'],
                  ['raw', 'Text'],
                  ['form', 'Form'],
                  ['multipart', 'Multipart'],
                ] as const
              ).map(([k, label]) => (
                <button
                  type="button"
                  key={k}
                  className={form.bodyKind === k ? 'on' : ''}
                  aria-pressed={form.bodyKind === k}
                  title={k === 'form' ? 'application/x-www-form-urlencoded' : k === 'multipart' ? 'multipart/form-data, with file upload' : undefined}
                  onClick={() => set('bodyKind', k)}
                >
                  {label}
                </button>
              ))}
            </div>

            {(form.bodyKind === 'json' || form.bodyKind === 'raw') && (
              <textarea
                className="mt-2"
                rows={9}
                value={form.body}
                spellCheck={false}
                aria-label="Body"
                placeholder={form.bodyKind === 'json' ? '{"name": "value"}' : 'Raw body text'}
                onChange={(e) => set('body', e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
                }}
              />
            )}
            {(form.bodyKind === 'form' || form.bodyKind === 'multipart') && (
              <div className="mt-2">
                <KvTable rows={form.form} onChange={(r) => set('form', r)} ph={['field', 'value']} />
              </div>
            )}
            {form.bodyKind === 'multipart' && (
              <>
                <label>Files</label>
                <input
                  type="file"
                  multiple
                  onChange={async (e) => {
                    const picked = Array.from(e.target.files ?? []);
                    const items: FileItem[] = [];
                    for (const f of picked) {
                      if (f.size > 25 * 1024 * 1024) {
                        flash(`"${f.name}" is ${(f.size / 1048576).toFixed(1)}MB, over the 25MB limit`);
                        continue;
                      }
                      const bytes = new Uint8Array(await f.arrayBuffer());
                      let bin = '';
                      for (let i = 0; i < bytes.length; i += 0x8000)
                        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
                      items.push({ field: 'file', name: f.name, contentB64: btoa(bin) });
                    }
                    set('files', [...form.files, ...items]);
                    e.target.value = '';
                  }}
                />
                {form.files.map((f, i) => (
                  <div key={i} className="row mt-2">
                    <input
                      className="w-md"
                      placeholder="field"
                      aria-label="Form field for this file"
                      value={f.field}
                      onChange={(e) => {
                        const next = [...form.files];
                        next[i] = { ...f, field: e.target.value };
                        set('files', next);
                      }}
                    />
                    <span className="grow faint break">{f.name}</span>
                    <button
                      className="btn-ghost btn-icon btn-danger"
                      title={`Remove ${f.name}`}
                      aria-label={`Remove ${f.name}`}
                      onClick={() => set('files', form.files.filter((_, j) => j !== i))}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </>
            )}
          </Section>

          <Section title="Headers" hint={<>One per line, as <code>name: value</code>. Auth adds its own Authorization header.</>}>
            <textarea
              rows={3}
              value={form.headers}
              spellCheck={false}
              aria-label="Headers"
              placeholder="accept: application/json"
              onChange={(e) => set('headers', e.target.value)}
            />
          </Section>

          <Section title="Options">
            <div className="row">
              <label className="check" htmlFor="http-timeout">
                Timeout
              </label>
              <input
                id="http-timeout"
                className="w-sm"
                value={form.timeoutMs}
                inputMode="numeric"
                onChange={(e) => set('timeoutMs', e.target.value)}
              />
              <span className="hint">milliseconds</span>
            </div>
          </Section>
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
              History <span className="count">{hist.length}</span>
            </button>
          </div>

          {tab === 'response' && (
            <>
              {busy && <div className="status busy">Sending {form.method} {form.url}…</div>}
              <div className={busy && result ? 'stale' : undefined}>
              {result &&
                (result.ok ? (
                  <div className={`status ${(result.status ?? 0) < 400 ? 'ok' : 'bad'}`}>
                    <span>
                      {result.status} {result.statusText}
                    </span>
                    {result.durationMs != null && (
                      <>
                        <span className="sep">·</span>
                        <span>{result.durationMs} ms</span>
                      </>
                    )}
                    {result.size != null && (
                      <>
                        <span className="sep">·</span>
                        <span>{fmtBytes(result.size)}</span>
                      </>
                    )}
                    {result.truncated && (
                      <>
                        <span className="sep">·</span>
                        <span>truncated</span>
                      </>
                    )}
                  </div>
                ) : (
                  <div className="status bad">Request failed</div>
                ))}
              {result?.ok && (
                <div className="result-bar">
                  {respViews.length > 1 && (
                    <div className="seg seg-sm" role="group" aria-label="Response view">
                      {respViews.map((v) => (
                        <button
                          type="button"
                          key={v}
                          className={respViewEff === v ? 'on' : ''}
                          aria-pressed={respViewEff === v}
                          title={`Show the response as ${v}`}
                          onClick={() => setRespView(v)}
                        >
                          {v === 'tree' ? 'Tree' : v === 'pretty' ? 'Pretty' : 'Raw'}
                        </button>
                      ))}
                    </div>
                  )}
                  {result.headers && (
                    <button
                      type="button"
                      className={`btn-ghost btn-sm ${showHeaders ? 'btn-on' : ''}`}
                      aria-pressed={showHeaders}
                      onClick={() => setShowHeaders((s) => !s)}
                    >
                      Headers <span className="count">{Object.keys(result.headers).length}</span>
                    </button>
                  )}
                  <span className="spacer" />
                  <button
                    className="btn-ghost btn-sm"
                    title="Copy the response body"
                    onClick={() =>
                      navigator.clipboard.writeText(result.bodyText ?? '').then(
                        () => flash('Response copied'),
                        () => flash('Copy failed: the clipboard is not available'),
                      )
                    }
                  >
                    Copy
                  </button>
                </div>
              )}
              {result?.ok && showHeaders && result.headers && (
                <table className="rtable kv-table mb-3">
                  <tbody>
                    {Object.entries(result.headers).map(([k, v]) => (
                      <tr key={k}>
                        <td>{k}</td>
                        <td>{v}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {result ? (
                <ResponseBody result={result} parsed={parsedResp} view={respViewEff} />
              ) : (
                !busy && (
                  <Empty
                    icon="↗"
                    title="No response yet"
                    hint={
                      <>
                        Enter a URL on the left and press <kbd>Send</kbd>. For a first try, use{' '}
                        <code>GET https://httpbin.org/get</code>, which echoes your request back as JSON.
                      </>
                    }
                  >
                    <button className="btn-secondary btn-sm" onClick={() => loadExample(EXAMPLES.http)}>
                      Fill in this example
                    </button>
                  </Empty>
                )
              )}
              </div>
            </>
          )}

          {tab === 'history' && hist.length === 0 && (
            <Empty
              icon="↺"
              title="No requests yet"
              hint="Every request you send lands here with its response. Click an entry to bring it back."
            />
          )}

          {tab === 'history' && hist.length > 0 && (
            <div className="history">
              {hist.map((h, i) => (
                <div
                  key={i}
                  className={`hist-item ${h.ok ? 'hist-ok' : 'hist-bad'}`}
                  role="button"
                  tabIndex={rowTabIndex(i)}
                  onClick={() => restore(h)}
                  onKeyDown={rowKeyDown(() => restore(h))}
                  title="Restore this request and its response"
                >
                  <div className="hist-head">
                    <b className="break" title={`${h.form.method} ${h.form.url}`}>
                      {h.form.method} {h.form.url.replace(/^https?:\/\//, '').slice(0, 70)}
                    </b>
                    <span>
                      <span className={h.ok ? 'text-ok' : 'text-bad'}>{h.status ?? 'ERR'}</span>
                      {h.durationMs != null ? `· ${h.durationMs} ms` : ''} · {new Date(h.at).toLocaleTimeString()}
                    </span>
                  </div>
                </div>
              ))}
              <div className="mt-2">
                <button
                  className="btn-secondary btn-danger btn-sm"
                  title="Delete every entry in the request history"
                  onClick={() => {
                    setHist([]);
                    localStorage.removeItem(LS_HISTORY);
                  }}
                >
                  Clear history
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
