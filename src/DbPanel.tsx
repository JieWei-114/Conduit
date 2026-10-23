import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { useFlash } from './useFlash';
import { SaveAs } from './SaveAs';
import { rowKeyDown, rowTabIndex } from './rowNav';
import { useDialog } from './useDialog';
import { Empty, PanelHead, ReqTabs, Section, usePersist } from './ui';
import { EXAMPLES } from './examples';

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
  rows?: Record<string, unknown>[];
  rowCount?: number;
  truncated?: boolean;
  durationMs?: number;
  error?: string;
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
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
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
  const res = resMap[activeId] ?? null;
  const busy = !!busyMap[activeId];
  const tables = tablesMap[activeId] ?? [];
  const setTables = (t: string[]) => setTablesMap((m) => ({ ...m, [activeId]: t }));

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
    if (id === activeId) setActiveId(next[Math.max(0, idx - 1)].id);
  };

  const persistConns = (next: SavedConn[]) => {
    setConns(next);
    localStorage.setItem(LS_CONNS, JSON.stringify(next));
  };

  const [flashMsg, flash] = useFlash();


  const loadTables = async () => {
    if (!form.url.trim()) return;
    const tid = active.id; // pin — schema must land on the tab it was requested from
    try {
      const r = await fetch('/api/db/schema', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ driver: form.driver, url: form.url }),
      }).then((x) => x.json());
      if (r.ok) setTablesMap((m) => ({ ...m, [tid]: r.tables }));
      else setResMap((m) => ({ ...m, [tid]: { ok: false, error: r.error } }));
    } catch (e) {
      setResMap((m) => ({ ...m, [tid]: { ok: false, error: String(e) } }));
    }
  };

  const run = async (q = form.query) => {
    if (!form.url.trim() || !q.trim() || busyMap[active.id]) return; // no-op while a query runs
    const tid = active.id; // pin the originating tab
    const driver = form.driver;
    setBusyMap((m) => ({ ...m, [tid]: true }));
    let r: any;
    try {
      r = await fetch('/api/db/query', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...form, query: q }),
      }).then((x) => x.json());
    } catch (e) {
      r = { ok: false, error: String(e) };
    }
    setResMap((m) => ({ ...m, [tid]: r }));
    setHist((h) => {
      const next = [
        { at: new Date().toISOString(), driver, query: q, ok: !!r.ok, rowCount: r.rowCount },
        ...h,
      ].slice(0, HISTORY_MAX);
      localStorage.setItem(LS_HISTORY, JSON.stringify(next));
      return next;
    });
    setBusyMap((m) => ({ ...m, [tid]: false }));
  };

  const cols = useMemo(
    () => (res?.ok && res.rows?.length ? [...new Set(res.rows.flatMap((r) => Object.keys(r)))] : []),
    [res],
  );

  const download = () => {
    if (!res?.ok || !res.rows) return;
    const csv = toCsv(res.rows, cols);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `query-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

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
        addTitle="New query tab (same connection)"
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
                  set('driver', e.target.value as Driver);
                  setTables([]);
                }}
              >
                <option value="postgres">PostgreSQL</option>
                <option value="mysql">MySQL</option>
                <option value="mongodb">MongoDB</option>
                <option value="clickhouse">ClickHouse</option>
              </select>
              <input
                className="grow"
                value={form.url}
                spellCheck={false}
                aria-label="Connection URL"
                placeholder={PLACEHOLDER_URL[form.driver]}
                onChange={(e) => set('url', e.target.value)}
              />
            </div>
            <div className="hint">
              e.g. <code>{PLACEHOLDER_URL[form.driver]}</code>
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
              <button className="btn-secondary btn-sm" onClick={loadTables} disabled={!form.url.trim()} title="Read the schema from this connection">
                {form.driver === 'mongodb' ? 'List collections' : 'List tables'}
              </button>
            }
          >
            {tables.length > 0 ? (
              <>
                <input placeholder="Filter" aria-label="Filter tables" value={tableFilter} onChange={(e) => setTableFilter(e.target.value)} />
                <div className="keylist">
                  {shownTables.map((t) => (
                    <div
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
                    </div>
                  ))}
                </div>
                <div className="hint">Click a table to see its first rows.</div>
              </>
            ) : (
              <div className="hint m-0">List them to click straight into a first-rows query.</div>
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
            <div className="inline mt-2">
              <button className="btn-primary" disabled={busy || !form.url.trim() || !form.query.trim()} onClick={() => run()}>
                {busy ? 'Running…' : 'Run query'}
              </button>
              <span className="hint m-0">
                <kbd>⌘↵</kbd> in the query also runs it
              </span>
            </div>
          </Section>

          {hist.length > 0 && (
            <Section
              title="Recent queries"
              actions={
                <button
                  className="btn-ghost btn-sm btn-danger"
                  onClick={() => {
                    setHist([]);
                    localStorage.removeItem(LS_HISTORY);
                  }}
                  title="Forget every remembered query"
                >
                  Clear
                </button>
              }
            >
              <div className="keylist">
                {hist.slice(0, 12).map((h, i) => (
                  <div
                    key={i}
                    className={`keyrow ${h.ok ? '' : 'hist-bad'}`}
                    role="button"
                    tabIndex={rowTabIndex(i)}
                    title={`Load this query into the box:\n${h.query}`}
                    onClick={() => set('query', h.query)}
                    onKeyDown={rowKeyDown(() => set('query', h.query))}
                  >
                    <span className="badge">{h.ok ? `${h.rowCount ?? 0} rows` : 'error'}</span>
                    <span className="kname">{h.query.replace(/\s+/g, ' ').slice(0, 80)}</span>
                  </div>
                ))}
              </div>
            </Section>
          )}
        </div>

        <div className="right">
          {busy && <div className="status busy">Running query…</div>}
          <div className={busy && res ? 'stale' : undefined}>
          {res &&
            (res.ok ? (
              <div className="status ok">
                <span>
                  {res.rowCount} row{res.rowCount === 1 ? '' : 's'}
                </span>
                {res.truncated && (
                  <>
                    <span className="sep">·</span>
                    <span>display truncated</span>
                  </>
                )}
                <span className="sep">·</span>
                <span>{res.durationMs} ms</span>
              </div>
            ) : (
              <div className="status bad">Query failed</div>
            ))}

          {res?.ok && (
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
              <button
                className="btn-ghost btn-sm"
                onClick={() => navigator.clipboard.writeText(JSON.stringify(res.rows, null, 2)).then(() => flash('Rows copied as JSON'))}
                title="Copy all rows as JSON"
              >
                Copy JSON
              </button>
              <button className="btn-ghost btn-sm" onClick={download} title="Download all rows as a CSV file">
                Export CSV
              </button>
            </div>
          )}

          {res == null && !busy && (
            <Empty
              icon="⛁"
              title="No query run yet"
              hint={
                <>
                  Paste a connection URL on the left, then click a table or write a query and press <kbd>Run query</kbd>.
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

          {res && !res.ok && <pre>{res.error}</pre>}
          {res?.ok && view === 'json' && <pre>{JSON.stringify(res.rows, null, 2)}</pre>}
          {res?.ok && view === 'table' &&
            (cols.length === 0 ? (
              <Empty
                icon="∅"
                title="No rows"
                hint="The query ran but matched nothing. Loosen the WHERE clause, or click a table on the left to see its first rows."
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
                  <button className="btn-secondary btn-sm" onClick={() => navigator.clipboard.writeText(expanded.v)}>
                    Copy
                  </button>
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
      <table className="rtable">
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
