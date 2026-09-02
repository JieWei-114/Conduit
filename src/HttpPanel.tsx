import { useEffect, useMemo, useRef, useState } from 'react';
import AuthBox, { AUTH_DEFAULTS, authHeader, type AuthState } from './AuthBox';
import JsonTree from './JsonTree';

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
  };
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

// ── KV table editor (module-level so it isn't remounted every render) ────────
function KvTable({
  rows,
  onChange,
  ph,
}: {
  rows: KV[];
  onChange: (r: KV[]) => void;
  ph: [string, string];
}) {
  const display = [...rows, { key: '', value: '' }]; // trailing blank row to add
  const edit = (i: number, patch: Partial<KV>) => {
    const next = display.map((r, j) => (j === i ? { ...r, ...patch } : r));
    onChange(next.filter((r) => r.key || r.value));
  };
  return (
    <div className="kv">
      {display.map((r, i) => (
        <div key={i} className="row field-row" style={{ marginBottom: 4 }}>
          <input placeholder={ph[0]} value={r.key} spellCheck={false} onChange={(e) => edit(i, { key: e.target.value })} />
          <input className="grow" placeholder={ph[1]} value={r.value} spellCheck={false} onChange={(e) => edit(i, { value: e.target.value })} />
        </div>
      ))}
    </div>
  );
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
  const setBusy = (b: boolean) => setBusyMap((m) => ({ ...m, [activeId]: b }));
  const [showHeaders, setShowHeaders] = useState(false);
  const [respView, setRespView] = useState<'pretty' | 'tree' | 'raw'>('tree');
  const [hist, setHist] = useState<HttpHist[]>(() => loadJson(LS_HISTORY, []));
  const [tab, setTab] = useState<'response' | 'history'>('response');

  const set = <K extends keyof HttpForm>(k: K, v: HttpForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    // persist tabs but drop (a) file blobs — base64 would blow the quota, and
    // (b) auth secrets — tokens/passwords shouldn't sit on disk. Re-enter after
    // reload, or use a saved request (explicit) to keep auth.
    const slim = tabs.map((t) => ({ id: t.id, form: { ...t.form, files: [], auth: AUTH_DEFAULTS } }));
    localStorage.setItem(LS_TABS, JSON.stringify({ tabs: slim, activeId }));
  }, [tabs, activeId]);

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

  const parseHeaders = () => {
    const out: Record<string, string> = {};
    for (const line of form.headers.split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    const a = authHeader(form.auth);
    if (a) out['authorization'] = a;
    return out;
  };

  const fullUrl = useMemo(() => {
    const active = form.query.filter((q) => q.key);
    if (!active.length) return form.url;
    const qs = active.map((q) => `${encodeURIComponent(q.key)}=${encodeURIComponent(q.value)}`).join('&');
    return form.url + (form.url.includes('?') ? '&' : '?') + qs;
  }, [form.url, form.query]);

  const send = async () => {
    if (!form.url.trim() || busyMap[active.id]) return; // no-op while a send is in flight
    const tid = active.id; // pin the originating tab — user may switch mid-flight
    const sentForm = form; // snapshot: history must record what was actually sent
    setBusyMap((m) => ({ ...m, [tid]: true }));
    setResultsMap((m) => ({ ...m, [tid]: null }));
    setTab('response');
    const kindForServer = form.bodyKind === 'json' ? 'raw' : form.bodyKind;
    const headers = parseHeaders();
    if (form.bodyKind === 'json' && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type'))
      headers['content-type'] = 'application/json';
    let res: HttpResult;
    try {
      res = await fetch('/api/http/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          url: fullUrl,
          method: form.method,
          headers,
          bodyKind: kindForServer,
          body: form.body,
          form: form.form.filter((f) => f.key),
          files: form.files.filter((f) => f.field && f.name),
          timeoutMs: Number(form.timeoutMs) || 15000,
        }),
      }).then((r) => r.json());
    } catch (e) {
      res = { ok: false, error: String(e) };
    }
    setResultsMap((m) => ({ ...m, [tid]: res }));
    const text = res.ok ? (res.bodyText ?? '') : (res.error ?? '');
    setHist((h) => {
      const next: HttpHist[] = [
        {
          at: new Date().toISOString(),
          // strip credentials — history is an implicit record of every request;
          // don't persist tokens/passwords to disk (saved requests keep auth, opt-in).
          form: { ...sentForm, auth: AUTH_DEFAULTS },
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
  const saveRequest = () => {
    if (!form.url.trim()) return;
    const name = prompt('Name this request:', pickedSaved || form.url.replace(/^https?:\/\//, '').slice(0, 40));
    if (!name) return;
    persistSaved([...saved.filter((s) => s.name !== name), { name, form }]);
    setPickedSaved(name);
  };

  const importCurl = () => {
    const text = prompt('Paste a cURL command:');
    if (!text) return;
    const parsed = parseCurl(text);
    if (!parsed) return alert('No cURL command found in the pasted text.');
    if ('error' in parsed) return alert(parsed.error);
    setForm((f) => hydrate({ ...f, ...parsed }));
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
    navigator.clipboard.writeText(lines.join(' \\\n'));
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

  return (
    <div className="grpc-wrap">
      <div className="req-tabs">
        {tabs.map((t) => (
          <span
            key={t.id}
            className={`req-tab ${t.id === activeId ? 'active' : ''}`}
            onClick={() => setActiveId(t.id)}
            title={t.form.url || 'new request'}
          >
            {busyMap[t.id] ? '⏳ ' : ''}
            {tabLabel(t)}
            {tabs.length > 1 && (
              <i
                className="chip-x"
                title="close tab"
                onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}
              >
                {' '}✕
              </i>
            )}
          </span>
        ))}
        <span className="req-tab req-tab-add" title="new request tab" onClick={addTab}>+</span>
      </div>

    <div className="layout">
      <div className="left">
        <h3>
          HTTP <span className="badge">REST client</span>
        </h3>

        <label>Saved requests</label>
        <div className="row field-row">
          <select
            className="grow"
            value={pickedSaved}
            onChange={(e) => {
              setPickedSaved(e.target.value);
              const s = saved.find((x) => x.name === e.target.value);
              if (s) setForm(hydrate(s.form));
            }}
          >
            <option value=""> - </option>
            {saved.map((s) => (
              <option key={s.name} value={s.name}>{s.name}</option>
            ))}
          </select>
          <button className="btn-field" onClick={saveRequest}>save</button>
          <button
            className="btn-field btn-danger"
            disabled={!pickedSaved}
            onClick={() => {
              persistSaved(saved.filter((s) => s.name !== pickedSaved));
              setPickedSaved('');
            }}
          >
            delete
          </button>
        </div>
        <div className="chips">
          <span className="chip" onClick={importCurl}>import cURL</span>
          <span className="chip" onClick={exportCurl}>copy as cURL</span>
        </div>

        <label>Request</label>
        <div className="row field-row">
          <select value={form.method} onChange={(e) => set('method', e.target.value)} style={{ maxWidth: 110 }}>
            {METHODS.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
          <input
            className="grow"
            value={form.url}
            spellCheck={false}
            placeholder="https://api.example.com/v1/things"
            onChange={(e) => set('url', e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && send()}
          />
        </div>
        {form.query.filter((q) => q.key).length > 0 && (
          <div className="hint" style={{ wordBreak: 'break-all' }}>→ {fullUrl}</div>
        )}

        <label>Query params</label>
        <KvTable rows={form.query} onChange={(r) => set('query', r)} ph={['key', 'value']} />

        <AuthBox value={form.auth} onChange={(a) => set('auth', a)} />

        <label>Body</label>
        <select
          value={form.bodyKind}
          style={{ marginBottom: 8 }}
          onChange={(e) => set('bodyKind', e.target.value as BodyKind)}
        >
          <option value="none">none</option>
          <option value="json">JSON</option>
          <option value="raw">raw / text</option>
          <option value="form">form-urlencoded</option>
          <option value="multipart">multipart (file upload)</option>
        </select>

        {(form.bodyKind === 'json' || form.bodyKind === 'raw') && (
          <textarea
            rows={9}
            value={form.body}
            spellCheck={false}
            placeholder={form.bodyKind === 'json' ? '{"name":"value"}' : 'raw body…'}
            onChange={(e) => set('body', e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
            }}
          />
        )}
        {(form.bodyKind === 'form' || form.bodyKind === 'multipart') && (
          <KvTable rows={form.form} onChange={(r) => set('form', r)} ph={['field', 'value']} />
        )}
        {form.bodyKind === 'multipart' && (
          <>
            <label>Files</label>
            <input
              type="file"
              multiple
              style={{ padding: 4 }}
              onChange={async (e) => {
                const picked = Array.from(e.target.files ?? []);
                const items: FileItem[] = [];
                for (const f of picked) {
                  if (f.size > 25 * 1024 * 1024) {
                    alert(`"${f.name}" is ${(f.size / 1048576).toFixed(1)}MB — over the 25MB upload limit.`);
                    continue;
                  }
                  // chunked base64 — avoids stack overflow on big files
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
              <div key={i} className="row field-row" style={{ marginTop: 4 }}>
                <input
                  placeholder="field"
                  value={f.field}
                  style={{ maxWidth: 120 }}
                  onChange={(e) => {
                    const next = [...form.files];
                    next[i] = { ...f, field: e.target.value };
                    set('files', next);
                  }}
                />
                <span className="grow hint" style={{ margin: 0, alignSelf: 'center' }}>{f.name}</span>
                <span className="chip" onClick={() => set('files', form.files.filter((_, j) => j !== i))}>✕</span>
              </div>
            ))}
          </>
        )}

        <label>Extra headers (one per line)</label>
        <textarea
          rows={3}
          value={form.headers}
          spellCheck={false}
          placeholder="x-custom: value"
          onChange={(e) => set('headers', e.target.value)}
        />

        <div className="row field-row" style={{ marginTop: 12 }}>
          <button className="grow" style={{ marginTop: 0 }} disabled={busy} onClick={send}>
            {busy ? 'Sending…' : 'Send ▶'}
          </button>
          <input style={{ width: 100 }} value={form.timeoutMs} title="timeout (ms)" onChange={(e) => set('timeoutMs', e.target.value)} />
        </div>
        <div className="hint">timeout ms · ⌘/Ctrl+Enter to send</div>
      </div>

      <div className="right">
        <div className="tabs">
          <span className={tab === 'response' ? 'tab active' : 'tab'} onClick={() => setTab('response')}>Response</span>
          <span className={tab === 'history' ? 'tab active' : 'tab'} onClick={() => setTab('history')}>
            History ({hist.length})
          </span>
        </div>

        {tab === 'response' && (
          <>
            {result &&
              (result.ok ? (
                <div className={`status ${(result.status ?? 0) < 400 ? 'ok' : 'bad'}`}>
                  HTTP {result.status} {result.statusText}
                  {result.durationMs != null ? ` · ${result.durationMs}ms` : ''}
                  {result.size != null ? ` · ${result.size}B` : ''}
                  {result.truncated ? ' · truncated' : ''}
                </div>
              ) : (
                <div className="status bad">FAILED · {result.error}</div>
              ))}
            {result?.ok && (
              <div className="chips" style={{ marginBottom: 8 }}>
                {parsedResp !== undefined && (
                  <>
                    <span className={`chip ${respView === 'tree' ? 'chip-active' : ''}`} onClick={() => setRespView('tree')}>tree</span>
                    <span className={`chip ${respView === 'pretty' ? 'chip-active' : ''}`} onClick={() => setRespView('pretty')}>pretty</span>
                  </>
                )}
                <span className={`chip ${respView === 'raw' ? 'chip-active' : ''}`} onClick={() => setRespView('raw')}>raw</span>
                <span className="chip" onClick={() => navigator.clipboard.writeText(result.bodyText ?? '')}>copy</span>
                {result.headers && (
                  <span className="chip" onClick={() => setShowHeaders((s) => !s)}>
                    {showHeaders ? 'hide' : 'show'} headers
                  </span>
                )}
              </div>
            )}
            {result?.ok && showHeaders && result.headers && (
              <pre style={{ marginBottom: 8 }}>
                {Object.entries(result.headers).map(([k, v]) => `${k}: ${v}`).join('\n')}
              </pre>
            )}
            {result == null ? (
              <pre>Send a request to see the response here.</pre>
            ) : !result.ok ? (
              <pre>{result.error}</pre>
            ) : result.binary ? (
              <div>
                <div className="hint" style={{ marginBottom: 8 }}>
                  binary response ({result.contentType || 'unknown type'}, {result.size}B) — not shown as text
                </div>
                <button
                  style={{ width: 'auto', marginTop: 0 }}
                  onClick={() => {
                    const bin = atob(result.bodyBase64 ?? '');
                    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
                    const url = URL.createObjectURL(new Blob([bytes], { type: result.contentType || 'application/octet-stream' }));
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'response' + (result.contentType?.includes('image/png') ? '.png' : result.contentType?.includes('pdf') ? '.pdf' : '.bin');
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                >
                  download
                </button>
              </div>
            ) : parsedResp !== undefined && respView === 'tree' ? (
              <JsonTree data={parsedResp} />
            ) : parsedResp !== undefined && respView === 'pretty' ? (
              <pre>{JSON.stringify(parsedResp, null, 2)}</pre>
            ) : (
              <pre>{result.bodyText || '(empty body)'}</pre>
            )}
          </>
        )}

        {tab === 'history' && (
          <div className="history">
            {hist.length === 0 && <pre>No requests yet.</pre>}
            {hist.map((h, i) => (
              <div
                key={i}
                className={`hist-item ${h.ok ? 'hist-ok' : 'hist-bad'}`}
                onClick={() => restore(h)}
                title="Click to restore this request and review its response"
              >
                <div className="hist-head">
                  <b>{h.form.method} {h.form.url.replace(/^https?:\/\//, '').slice(0, 55)}</b>
                  <span>
                    {h.status ?? 'ERR'}
                    {h.durationMs != null ? ` · ${h.durationMs}ms` : ''} · {new Date(h.at).toLocaleTimeString()}
                  </span>
                </div>
              </div>
            ))}
            {hist.length > 0 && (
              <span className="chip" onClick={() => { setHist([]); localStorage.removeItem(LS_HISTORY); }}>
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
