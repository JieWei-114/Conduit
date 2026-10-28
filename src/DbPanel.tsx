import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { useFlash } from './useFlash';
import { SaveAs } from './SaveAs';
import { rowKeyDown, rowTabIndex } from './rowNav';
import { useDialog } from './useDialog';
import { Empty, LongField, PanelHead, ReqTabs, Section, usePersist } from './ui';
import { EXAMPLES } from './examples';
import { CopyButton, OutcomeView, type Outcome } from './AttemptLog';
import { downloadJson, downloadText } from './share';
import type { AttemptError, AttemptLog } from './types';

const LS_FORM = 'conduit.db.form.v1';
const LS_TABS = 'conduit.db.tabs.v1';
const LS_CONNS = 'conduit.db.conns.v1';
const LS_HISTORY = 'conduit.db.history.v1';
const HISTORY_MAX = 40;

type Driver = 'postgres' | 'mysql' | 'mongodb' | 'clickhouse';

interface DbForm {
  driver: Driver;
  url: string;
  query: string;
}
interface SavedConn {
  name: string;
  driver: Driver;
  url: string;
}
interface HistItem {
  at: string;
  driver: Driver;
  query: string;
  ok: boolean;
  rowCount?: number;
  affected?: number | null;
  durationMs?: number;
  error?: string;
}

const PLACEHOLDER_URL: Record<Driver, string> = {
  postgres: 'postgres://user:pass@localhost:5432/mydb',
  mysql: 'mysql://user:pass@localhost:3306/mydb',
  mongodb: 'mongodb://user:pass@localhost:27017/mydb',
  clickhouse: 'http://user:pass@localhost:8123/mydb',
};
const PLACEHOLDER_QUERY: Record<Driver, string> = {
  postgres: 'SELECT * FROM users LIMIT 20',
  mysql: 'SELECT * FROM users LIMIT 20',
  mongodb: '{"collection":"users","filter":{},"limit":20}',
  clickhouse: 'SELECT * FROM events LIMIT 20',
};

const DEFAULTS: DbForm = { driver: 'postgres', url: '', query: '' };

interface DbRes {
  ok: boolean;
  /** column names in SELECT order */
  columns?: string[];
  rows?: Record<string, unknown>[];
  /** rows sent back (at most ROWS_CAP), on every driver */
  rowCount?: number;
  /** how many rows the result had in all, when the server said so and more than were sent */
  totalRows?: number | null;
  /** rows an INSERT / UPDATE / DELETE touched; set instead of rows */
  affected?: number | null;
  truncated?: boolean;
  durationMs?: number;
  error?: string;
  detail?: AttemptError;
  log?: AttemptLog;
  /** values to mask in a copied log: the connection's password */
  secrets?: string[];
}

/** The last List tables / collections call of a tab, shown in the schema browser. */
interface SchemaOutcome {
  o: Outcome;
  secrets: string[];
}

/** Rows the server hands back per query (and so the most a CSV export can hold). */
const ROWS_CAP = 500;
/** How long the server lets one query run before it stops it. */
const QUERY_LIMIT_S = 60;
const RUN_KEY = navigator.platform.includes('Mac') ? '⌘↵' : 'Ctrl↵';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** What a query came to, in one line: "20 rows", "First 500 of 1234 rows", "3 rows affected". */
function resultText(r: DbRes): string {
  if (r.affected != null) return `${plural(r.affected, 'row')} affected`;
  const n = r.rowCount ?? r.rows?.length ?? 0;
  if (!r.truncated) return plural(n, 'row');
  return r.totalRows != null ? `First ${n} of ${r.totalRows} rows` : `First ${n} rows, more not fetched`;
}

function resOutcome(r: DbRes): Outcome {
  return r.ok
    ? { ok: true, text: resultText(r), ms: r.durationMs, log: r.log }
    : { ok: false, text: r.error, detail: r.detail, ms: r.durationMs, log: r.log };
}

function maskDbPassword(url: string): string {
  return url
    .replace(/^([a-z][a-z0-9+.-]*:\/\/[^:/?#@\s]*):([^@\s]+)@/i, '$1:••••@')
    .replace(/(\bpassword\s*=\s*)('(?:[^'\\]|\\.)*'|[^\s&;]+)/gi, '$1••••');
}

/** The password in a connection URL or a `key=value` connection string, to mask in copied logs. */
function urlSecrets(raw: string): string[] {
  const out: string[] = [];
  try {
    const u = new URL(raw.trim());
    if (u.password) {
      out.push(u.password);
      try {
        const dec = decodeURIComponent(u.password);
        if (dec !== u.password) out.push(dec);
      } catch {
        /* not percent-encoded */
      }
    }
  } catch {
    const m = /(?:^|\s)password=(\S+)/i.exec(raw);
    if (m) out.push(m[1]);
  }
  return out;
}

function loadJson<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback;
  } catch {
    return fallback;
  }
}

// Chrome-style query tabs — each tab is an independent connection + query;
// saved connections and query history are shared.
interface DbTab { id: number; form: DbForm }
function loadTabs(): { tabs: DbTab[]; activeId: number } {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_TABS) ?? 'null');
    if (raw && Array.isArray(raw.tabs) && raw.tabs.length) {
      const tabs: DbTab[] = raw.tabs.map((t: any, i: number) => ({
        id: t.id ?? i + 1,
        form: { ...DEFAULTS, ...(t.form ?? {}) },
      }));
      const activeId = tabs.some((t) => t.id === raw.activeId) ? raw.activeId : tabs[0].id;
      return { tabs, activeId };
    }
  } catch {
    /* fall through */
  }
  const old = loadJson<Partial<DbForm>>(LS_FORM, {});
  return { tabs: [{ id: 1, form: { ...DEFAULTS, ...old } }], activeId: 1 };
}

/** click a table name → a sensible default query for the driver */
function queryForTable(driver: Driver, t: string): string {
  if (driver === 'mongodb') return JSON.stringify({ collection: t, filter: {}, limit: 20 });
  return `SELECT * FROM ${t} LIMIT 50`;
}

function toCsv(rows: Record<string, unknown>[], cols: string[]): string {
  const esc = (v: unknown) => {
    const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.map(esc).join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}

export default function DbPanel() {
  const init = useRef<{ tabs: DbTab[]; activeId: number } | null>(null);
  if (!init.current) init.current = loadTabs();
  const [tabs, setTabs] = useState<DbTab[]>(init.current.tabs);
  const [activeId, setActiveId] = useState<number>(init.current.activeId);
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const form = active.form;
  const setForm = (u: DbForm | ((f: DbForm) => DbForm)) =>
    setTabs((ts) =>
      ts.map((t) => (t.id === active.id ? { ...t, form: typeof u === 'function' ? (u as (f: DbForm) => DbForm)(t.form) : u } : t)),
    );

  const [conns, setConns] = useState<SavedConn[]>(() => loadJson(LS_CONNS, []));
  const [picked, setPicked] = useState('');
  const [tableFilter, setTableFilter] = useState('');
  const [hist, setHist] = useState<HistItem[]>(() => loadJson(LS_HISTORY, []));
  const [view, setView] = useState<'table' | 'json'>('table');
  const [expanded, setExpanded] = useState<{ v: string } | null>(null);
  const closeExpanded = useCallback(() => setExpanded(null), []);
  const dialogRef = useDialog(expanded !== null, closeExpanded);
  // per-tab result / busy / schema list
  const [resMap, setResMap] = useState<Record<number, DbRes | null>>({});
  const [busyMap, setBusyMap] = useState<Record<number, boolean>>({});
  const [tablesMap, setTablesMap] = useState<Record<number, string[]>>({});
  const [schemaMap, setSchemaMap] = useState<Record<number, SchemaOutcome | null>>({});
  const [listingMap, setListingMap] = useState<Record<number, boolean>>({});
  const res = resMap[activeId] ?? null;
  const busy = !!busyMap[activeId];
  const tables = tablesMap[activeId] ?? [];
  const schema = schemaMap[activeId] ?? null;
  const listing = !!listingMap[activeId];
  const setTables = (t: string[]) => {
    setTablesMap((m) => ({ ...m, [activeId]: t }));
    setSchemaMap((m) => ({ ...m, [activeId]: null }));
  };

  const set = <K extends keyof DbForm>(k: K, v: DbForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  const persisted = useMemo(() => ({ tabs, activeId }), [tabs, activeId]);
  usePersist(LS_TABS, persisted, () => JSON.stringify({ tabs, activeId }));
  const openCell = useCallback((v: string) => setExpanded({ v }), []);

  // ── tab operations ──────────────────────────────────────────────────────────
  const tabLabel = (t: DbTab) => {
    const q = t.form.query.replace(/\s+/g, ' ').trim();
    return q ? q.slice(0, 22) : t.form.driver;
  };
  const addTab = () => {
    const id = Math.max(0, ...tabs.map((t) => t.id)) + 1;
    // clone current connection so a new tab is ready to query the same DB
    setTabs((ts) => [...ts, { id, form: { ...DEFAULTS, driver: form.driver, url: form.url } }]);
    setActiveId(id);
  };
  const closeTab = (id: number) => {
    if (tabs.length === 1) return;
    const idx = tabs.findIndex((t) => t.id === id);
    const next = tabs.filter((t) => t.id !== id);
    setTabs(next);
    setResMap((m) => { const c = { ...m }; delete c[id]; return c; });
    setBusyMap((m) => { const c = { ...m }; delete c[id]; return c; });
    setTablesMap((m) => { const c = { ...m }; delete c[id]; return c; });
    setSchemaMap((m) => { const c = { ...m }; delete c[id]; return c; });
    setListingMap((m) => { const c = { ...m }; delete c[id]; return c; });
    if (id === activeId) setActiveId(next[Math.max(0, idx - 1)].id);
  };

  const persistConns = (next: SavedConn[]) => {
    setConns(next);
    localStorage.setItem(LS_CONNS, JSON.stringify(next));
  };

  const [flashMsg, flash] = useFlash();
  const [urlFocus, setUrlFocus] = useState(false);
  const driverHist = hist.filter((h) => (h.driver ?? 'postgres') === form.driver);

  const loadTables = async () => {
    if (!form.url.trim() || listingMap[active.id]) return; // no double submit
    const tid = active.id; // pin — schema must land on the tab it was requested from
    const secrets = urlSecrets(form.url);
    const noun = form.driver === 'mongodb' ? 'collection' : 'table';
    setListingMap((m) => ({ ...m, [tid]: true }));
    // the outcome stays beside the schema browser, so it never replaces a query result
    let o: Outcome;
    try {
      const r = await fetch('/api/db/schema', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ driver: form.driver, url: form.url }),
      }).then((x) => x.json());
      if (r.ok) {
        setTablesMap((m) => ({ ...m, [tid]: r.tables }));
        o = { ok: true, text: plural(r.tables.length, noun), ms: r.durationMs, log: r.log };
      } else {
        o = { ok: false, text: r.error, detail: r.detail, ms: r.durationMs, log: r.log };
      }
    } catch (e) {
      o = { ok: false, text: String(e) };
    }
    setSchemaMap((m) => ({ ...m, [tid]: { o, secrets } }));
    setListingMap((m) => ({ ...m, [tid]: false }));
  };

  const aborts = useRef<Record<number, AbortController>>({});
  const run = async (q = form.query) => {
    if (!form.url.trim() || !q.trim() || busyMap[active.id]) return; // no-op while a query runs
    const tid = active.id; // pin the originating tab
    const driver = form.driver;
    setBusyMap((m) => ({ ...m, [tid]: true }));
    let r: DbRes;
    const ctl = new AbortController();
    aborts.current[tid] = ctl;
    try {
      r = await fetch('/api/db/query', {
        method: 'POST',
        signal: ctl.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...form, query: q }),
      }).then((x) => x.json());
    } catch (e) {
      r = { ok: false, error: String(e) };
    }
    delete aborts.current[tid];
    if (ctl.signal.aborted) {
      setResMap((m) => ({ ...m, [tid]: { ok: false, error: 'Cancelled: the result was not waited for.' } }));
      setBusyMap((m) => ({ ...m, [tid]: false }));
      return;
    }
    r.secrets = urlSecrets(form.url);
    setResMap((m) => ({ ...m, [tid]: r }));
    const item: HistItem = {
      at: new Date().toISOString(),
      driver,
      query: q,
      ok: !!r.ok,
      rowCount: r.rowCount,
      affected: r.affected,
      durationMs: r.durationMs,
      error: r.ok ? undefined : r.error,
    };
    setHist((h) => {
      const next = [item, ...h].slice(0, HISTORY_MAX);
      localStorage.setItem(LS_HISTORY, JSON.stringify(next));
      return next;
    });
    setBusyMap((m) => ({ ...m, [tid]: false }));
  };

  // the server's column list keeps SELECT order (object keys would put numeric names first)
  const cols = useMemo(
    () =>
      res?.ok && res.rows?.length
        ? res.columns?.length
          ? res.columns
          : [...new Set(res.rows.flatMap((r) => Object.keys(r)))]
        : [],
    [res],
  );

  const exportRows = (fmt: 'csv' | 'json') => {
    if (!res?.ok || !res.rows) return;
    if (fmt === 'csv') downloadText('db', 'rows', 'csv', toCsv(res.rows, cols), 'text/csv');
    else downloadJson('db', 'rows', res.rows);
    if (res.truncated) flash(`The file holds the first ${res.rows.length} rows only (results are capped at ${ROWS_CAP})`);
  };
  const outcome: Outcome | null = busy ? { ok: true, busy: true, text: 'Running query…' } : res ? resOutcome(res) : null;

  const listLabel = form.driver === 'mongodb' ? 'List collections' : 'List tables';
  const shownTables = tableFilter
    ? tables.filter((t) => t.toLowerCase().includes(tableFilter.toLowerCase()))
    : tables;

  const loadExample = (ex: typeof EXAMPLES.db) => {
    const fields = { driver: ex.driver, url: ex.url, query: ex.query };
    if (!form.url.trim() && !form.query.trim()) {
      setForm((f) => ({ ...f, ...fields }));
      setTables([]);
      return;
    }
    const id = Math.max(0, ...tabs.map((t) => t.id)) + 1;
    setTabs((ts) => [...ts, { id, form: { ...DEFAULTS, ...fields } }]);
    setActiveId(id);
  };

  return (
    <div className="grpc-wrap">
      <ReqTabs
        tabs={tabs}
        activeId={activeId}
        ariaLabel="Query tabs"
        label={tabLabel}
        title={(t) => t.form.query || t.form.url || 'New query'}
        state={(t) => (busyMap[t.id] ? 'busy' : undefined)}
        onSelect={setActiveId}
        onClose={closeTab}
        onAdd={addTab}
        addTitle="New tab with the same connection"
      />

      <div className="layout">
        <div className="left">
          <PanelHead
            title="Database"
            badge="postgres · mysql · mongodb · clickhouse"
            tagline="Connect with a URL, browse tables, run a query and export the rows."
          />

          <div className="saved-bar">
            <select
              value={picked}
              aria-label="Saved connections"
              onChange={(e) => {
                setPicked(e.target.value);
                const c = conns.find((x) => x.name === e.target.value);
                if (c) setForm((f) => ({ ...f, driver: c.driver, url: c.url }));
                setTables([]);
              }}
            >
              <option value="">{conns.length ? 'Open a saved connection…' : 'No saved connections yet'}</option>
              {conns.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
            <SaveAs
              canSave={() => (form.url.trim() ? null : 'Enter a connection URL first')}
              onSave={(name) => {
                persistConns([...conns.filter((c) => c.name !== name), { name, driver: form.driver, url: form.url.trim() }]);
                setPicked(name);
                return `Saved "${name}"`;
              }}
              onMessage={flash}
            />
            <button
              className="btn-secondary btn-danger"
              title="Delete the selected saved connection"
              disabled={!picked}
              onClick={() => {
                persistConns(conns.filter((c) => c.name !== picked));
                setPicked('');
              }}
            >
              Delete
            </button>
          </div>
          {flashMsg && <div className="toast">{flashMsg}</div>}

          <Section title="Connection">
            <div className="row">
              <select
                className="w-md"
                aria-label="Driver"
                value={form.driver}
                onChange={(e) => {
                  const next = e.target.value as Driver;
                  setForm((f) => {
                    const prev = f.driver;
                    const urlIsDefault =
                      !f.url.trim() || f.url.trim() === PLACEHOLDER_URL[prev] || (prev === EXAMPLES.db.driver && f.url.trim() === EXAMPLES.db.url);
                    const queryIsDefault =
                      !f.query.trim() || f.query.trim() === PLACEHOLDER_QUERY[prev] || (prev === EXAMPLES.db.driver && f.query.trim() === EXAMPLES.db.query);
                    return {
                      ...f,
                      driver: next,
                      url: urlIsDefault ? '' : f.url,
                      query: queryIsDefault ? '' : f.query,
                    };
                  });
                  setTables([]);
                }}
              >
                <option value="postgres">PostgreSQL</option>
                <option value="mysql">MySQL</option>
                <option value="mongodb">MongoDB</option>
                <option value="clickhouse">ClickHouse</option>
              </select>
              <LongField
                url
                className="grow"
                value={urlFocus ? form.url : maskDbPassword(form.url)}
                spellCheck={false}
                aria-label="Connection URL"
                title={urlFocus || maskDbPassword(form.url) === form.url ? undefined : 'The password is hidden until you click into the field'}
                placeholder={PLACEHOLDER_URL[form.driver]}
                onFocus={() => setUrlFocus(true)}
                onBlur={() => setUrlFocus(false)}
                onChange={(v) => urlFocus && set('url', v)}
              />
            </div>
            <div className="hint">
              e.g. <code>{PLACEHOLDER_URL[form.driver]}</code>
              {form.driver === 'postgres' && (
                <>
                  . TLS when the server offers it; add <code>?sslmode=verify-full</code> to check the certificate, and{' '}
                  <code>&amp;sslrootcert=/path/ca.pem</code> for a cloud database's own CA.
                </>
              )}
              {form.driver === 'mysql' && (
                <>
                  . TLS when the server offers it; add <code>?ssl-mode=VERIFY_IDENTITY</code> to check the certificate, and{' '}
                  <code>&amp;ssl-ca=/path/ca.pem</code> for a cloud database's own CA.
                </>
              )}
            </div>
          </Section>

          <Section
            title={
              <>
                {form.driver === 'mongodb' ? 'Collections' : 'Tables'}
                {tables.length > 0 && <span className="count"> ({tables.length})</span>}
              </>
            }
            actions={
              <button
                className="btn-secondary btn-sm"
                onClick={loadTables}
                disabled={listing || !form.url.trim()}
                title={form.url.trim() ? 'Read the schema from this connection' : 'Enter a connection URL first'}
              >
                {listing ? 'Listing…' : listLabel}
              </button>
            }
          >
            <OutcomeView o={listing ? { ok: true, busy: true, text: 'Listing…' } : schema?.o} secrets={schema?.secrets ?? []} />
            {tables.length > 0 ? (
              <>
                <input placeholder="Filter" aria-label="Filter tables" value={tableFilter} onChange={(e) => setTableFilter(e.target.value)} />
                <div className="keylist">
                  {shownTables.map((t) => (
                    <button
                      type="button"
                      key={t}
                      className="keyrow"
                      onClick={() => {
                        const q = queryForTable(form.driver, t);
                        set('query', q);
                        run(q);
                      }}
                      title={`Run a first-rows query on ${t}`}
                    >
                      <span className="kname">{t}</span>
                    </button>
                  ))}
                </div>
                <div className="hint">Click a {form.driver === 'mongodb' ? 'collection' : 'table'} to see its first rows.</div>
              </>
            ) : (
              !schema?.o.ok ? (
                <Empty
                  compact
                  title={form.driver === 'mongodb' ? 'No collections yet' : 'No tables yet'}
                  hint={
                    <>
                      Press <kbd>{listLabel}</kbd> to click straight into a first-rows query.
                    </>
                  }
                />
              ) : null
            )}
          </Section>

          <Section
            title="Query"
            hint={
              form.driver === 'mongodb'
                ? 'JSON: {collection, filter?, limit?, sort?} · {collection, pipeline} · {command}'
                : 'Plain SQL for this driver. Results are capped at 500 rows.'
            }
          >
            <textarea
              rows={8}
              value={form.query}
              spellCheck={false}
              aria-label="Query"
              placeholder={PLACEHOLDER_QUERY[form.driver]}
              onChange={(e) => set('query', e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) run();
              }}
            />
          </Section>

          {driverHist.length > 0 && (
            <Section
              title="Recent queries"
              actions={
                <button
                  className="btn-ghost btn-sm btn-danger"
                  onClick={() => {
                    const next = hist.filter((h) => (h.driver ?? 'postgres') !== form.driver);
                    setHist(next);
                    localStorage.setItem(LS_HISTORY, JSON.stringify(next));
                  }}
                  title="Forget the remembered queries for this driver"
                >
                  Clear
                </button>
              }
            >
              <div className="keylist">
                {driverHist.slice(0, 12).map((h, i) => (
                  <div
                    key={i}
                    className={`keyrow ${h.ok ? '' : 'hist-bad'}`}
                    role="button"
                    tabIndex={rowTabIndex(i)}
                    title={`Load this query into the box:\n${h.query}${h.error ? `\n\nFailed: ${h.error}` : ''}${
                      h.durationMs != null ? `\n${h.durationMs} ms` : ''
                    }`}
                    onClick={() => set('query', h.query)}
                    onKeyDown={rowKeyDown(() => set('query', h.query))}
                  >
                    <span className="badge">
                      {h.ok ? (h.affected != null ? `${h.affected} affected` : plural(h.rowCount ?? 0, 'row')) : 'error'}
                      {h.durationMs != null ? ` · ${h.durationMs} ms` : ''}
                    </span>
                    <span className="kname">{h.query.replace(/\s+/g, ' ').slice(0, 80)}</span>
                  </div>
                ))}
              </div>
            </Section>
          )}

          <div className="action-bar">
            {busy ? (
              <button className="btn-secondary" title="Stop waiting for this query" onClick={() => aborts.current[active.id]?.abort()}>
                Cancel
              </button>
            ) : (
              <button className="btn-primary" disabled={!form.url.trim() || !form.query.trim()} onClick={() => run()}>
                Run
              </button>
            )}
            {!form.url.trim() ? (
              <span className="hint">Enter a connection URL first.</span>
            ) : !form.query.trim() ? (
              <span className="hint">Write a query first.</span>
            ) : (
              <span className="hint">
                <kbd>{RUN_KEY}</kbd> in the query also runs it
              </span>
            )}
            <span className="spacer" />
            <span className="hint">Stops after {QUERY_LIMIT_S} s</span>
          </div>
        </div>

        <div className="right">
          <OutcomeView o={outcome} secrets={res?.secrets ?? []} />
          <div className={busy && res ? 'stale' : undefined}>
          {res?.ok && res.affected == null && (
            <div className="result-bar">
              <div className="seg seg-sm" role="group" aria-label="Result view">
                {(['table', 'json'] as const).map((v) => (
                  <button
                    type="button"
                    key={v}
                    className={view === v ? 'on' : ''}
                    aria-pressed={view === v}
                    onClick={() => setView(v)}
                  >
                    {v === 'table' ? 'Table' : 'JSON'}
                  </button>
                ))}
              </div>
              <span className="spacer" />
              {res.rows?.length ? (
                <>
                  <CopyButton
                    label="Copy JSON"
                    title="Copy the rows shown as JSON"
                    text={() => JSON.stringify(res.rows, null, 2)}
                  />
                  <button
                    type="button"
                    className="btn-ghost btn-sm"
                    onClick={() => exportRows('csv')}
                    title={`Save the rows shown as a CSV file (at most ${ROWS_CAP})`}
                  >
                    Export CSV
                  </button>
                  <button
                    type="button"
                    className="btn-ghost btn-sm"
                    onClick={() => exportRows('json')}
                    title={`Save the rows shown as a JSON file (at most ${ROWS_CAP})`}
                  >
                    Export JSON
                  </button>
                </>
              ) : null}
            </div>
          )}

          {res == null && !busy && (
            <Empty
              icon="⛁"
              title="No rows yet"
              hint={
                <>
                  Paste a connection URL on the left, then click a table or write a query and press <kbd>Run</kbd>.
                  For a local Postgres try <code>postgres://postgres:postgres@localhost:5432/postgres</code> with{' '}
                  <code>SELECT now()</code>.
                </>
              }
            >
              <button className="btn-secondary btn-sm" onClick={() => loadExample(EXAMPLES.db)}>
                Fill in this example
              </button>
            </Empty>
          )}

          {res?.ok && res.affected != null && (
            <div className="hint">
              The statement returned no rows. Add RETURNING (Postgres) or run a SELECT to see the data.
            </div>
          )}
          {res?.ok && res.affected == null && view === 'json' && <pre>{JSON.stringify(res.rows, null, 2)}</pre>}
          {res?.ok && res.affected == null && view === 'table' &&
            (cols.length === 0 ? (
              <Empty
                compact
                title="Nothing matched"
                hint="Loosen the WHERE clause, or click a table on the left to see its first rows."
              />
            ) : (
              <ResultTable rows={res.rows!} cols={cols} onExpand={openCell} />
            ))}
          </div>

          {expanded && (
            <div className="modal" onClick={closeExpanded}>
              <div
                className="modal-box"
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-label="Cell value"
                tabIndex={-1}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="modal-head">
                  <span className="out-title">Cell value</span>
                  <span className="spacer" />
                  <CopyButton label="Copy value" title="Copy the full value" text={expanded.v} />
                  <button className="btn-ghost btn-sm" onClick={closeExpanded} title="Close (Esc)">
                    Close
                  </button>
                </div>
                <pre className="cell-json">
                  {(() => {
                    try {
                      return JSON.stringify(JSON.parse(expanded.v), null, 2);
                    } catch {
                      return expanded.v;
                    }
                  })()}
                </pre>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const cellText = (v: unknown): string => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

const ResultTable = memo(function ResultTable({
  rows,
  cols,
  onExpand,
}: {
  rows: Record<string, unknown>[];
  cols: string[];
  onExpand: (v: string) => void;
}) {
  return (
    <div className="table-scroll">
      <table className="rtable data-table">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {cols.map((c) => {
                const s = cellText(r[c]);
                const long = s.length > 80;
                return (
                  <td
                    key={c}
                    className={long ? 'cell-click' : undefined}
                    title={long ? 'Click to see the full value' : s || undefined}
                    onClick={() => long && onExpand(s)}
                  >
                    {long ? s.slice(0, 80) + '…' : s}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});
