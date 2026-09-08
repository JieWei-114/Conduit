import { useCallback, useEffect, useRef, useState } from 'react';
import { rowKeyDown, rowTabIndex } from './rowNav';
import { useDialog } from './useDialog';

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

  useEffect(() => {
    localStorage.setItem(LS_TABS, JSON.stringify({ tabs, activeId }));
  }, [tabs, activeId]);

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
    setResMap((m) => ({ ...m, [tid]: null }));
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

  const cols = res?.ok && res.rows?.length ? [...new Set(res.rows.flatMap((r) => Object.keys(r)))] : [];
  const cell = (v: unknown): string => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

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

  return (
    <div className="grpc-wrap">
      <div className="req-tabs" role="tablist" aria-label="Query tabs">
        {tabs.map((t) => (
          <button
            type="button"
            key={t.id}
            className={`req-tab ${t.id === activeId ? 'active' : ''}`}
            role="tab"
            aria-selected={t.id === activeId}
            onClick={() => setActiveId(t.id)}
            title={t.form.query || t.form.url || 'new query'}
          >
            {busyMap[t.id] ? '⏳ ' : ''}
            {tabLabel(t)}
            {tabs.length > 1 && (
              // Lives inside the tab button, so it stays a role="button" span:
              // a button cannot contain another button.
              <i
                className="chip-x"
                role="button"
                tabIndex={0}
                aria-label="close tab"
                title="close tab"
                onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    e.stopPropagation();
                    closeTab(t.id);
                  }
                }}
              >
                {' '}✕
              </i>
            )}
          </button>
        ))}
        <button
          type="button"
          className="req-tab req-tab-add"
          aria-label="new query tab (clones this connection)"
          title="new query tab (clones this connection)"
          onClick={addTab}
        >+</button>
      </div>

    <div className="layout">
      <div className="left">
        <h3>
          DB <span className="badge">postgres · mysql · mongodb · clickhouse</span>
        </h3>

        <label>Saved connections</label>
        <div className="row field-row">
          <select
            className="grow"
            value={picked}
            onChange={(e) => {
              setPicked(e.target.value);
              const c = conns.find((x) => x.name === e.target.value);
              if (c) setForm((f) => ({ ...f, driver: c.driver, url: c.url }));
              setTables([]);
            }}
          >
            <option value=""> - </option>
            {conns.map((c) => (
              <option key={c.name} value={c.name}>{c.name}</option>
            ))}
          </select>
          <button
            className="btn-field"
            onClick={() => {
              if (!form.url.trim()) return;
              const name = prompt('Name this connection (e.g. local, staging):', '');
              if (!name) return;
              persistConns([...conns.filter((c) => c.name !== name), { name, driver: form.driver, url: form.url.trim() }]);
              setPicked(name);
            }}
            title="Save the driver and URL below under a name"
          >
            save
          </button>
          <button
            className="btn-field btn-danger"
            title="Delete the selected saved connection"
            disabled={!picked}
            onClick={() => {
              persistConns(conns.filter((c) => c.name !== picked));
              setPicked('');
            }}
          >
            delete
          </button>
        </div>

        <div className="row field-row field-row-gap">
          <select
            className="w-md"
            value={form.driver}
            onChange={(e) => { set('driver', e.target.value as Driver); setTables([]); }}
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
            placeholder={PLACEHOLDER_URL[form.driver]}
            onChange={(e) => set('url', e.target.value)}
          />
        </div>

        <div className="row field-row field-row-gap">
          <button
            className="btn-field w-md"
            onClick={loadTables}
            title="Read the schema from this connection"
          >
            {form.driver === 'mongodb' ? 'list collections' : 'list tables'}
          </button>
          {tables.length > 0 && (
            <input
              className="grow"
              placeholder="filter"
              value={tableFilter}
              onChange={(e) => setTableFilter(e.target.value)}
            />
          )}
        </div>
        {/* Table rows are a mouse shortcut only: a schema can hold hundreds of
            them. The same result is reachable from the keyboard by typing the
            query in the box below and pressing Run. */}
        {tables.length > 0 && (
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
                title={`Fill the query box with a first-rows query on ${t} and run it`}
              >
                <span className="kname">{t}</span>
              </div>
            ))}
          </div>
        )}

        <label>Query</label>
        <div className="hint mb-1">
          {form.driver === 'mongodb'
            ? 'JSON: {collection, filter?, limit?, sort?} · {collection, pipeline} · {command}'
            : 'Plain SQL for this driver.'}
        </div>
        <textarea
          rows={10}
          value={form.query}
          spellCheck={false}
          placeholder={PLACEHOLDER_QUERY[form.driver]}
          onChange={(e) => set('query', e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) run();
          }}
        />
        <div className="hint">⌘/Ctrl + Enter to run · results capped at 500 rows</div>

        <button disabled={busy} onClick={() => run()} title="Run this query against the connection above">
          {busy ? 'Running…' : 'Run ▶'}
        </button>

        {hist.length > 0 && (
          <>
            <label>Recent queries</label>
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
                  <span className="badge">{h.ok ? (h.rowCount ?? '') : 'err'}</span>
                  <span className="kname">{h.query.replace(/\s+/g, ' ').slice(0, 42)}</span>
                </div>
              ))}
            </div>
            <div className="inline mt-2">
              <button
                className="btn-field btn-danger"
                onClick={() => { setHist([]); localStorage.removeItem(LS_HISTORY); }}
                title="Forget every remembered query"
              >
                clear history
              </button>
            </div>
          </>
        )}
      </div>

      <div className="right">
        {res &&
          (res.ok ? (
            <div className="status ok">
              {res.rowCount} row{res.rowCount === 1 ? '' : 's'}
              {res.truncated ? ' (display truncated)' : ''} · {res.durationMs}ms
            </div>
          ) : (
            <div className="status bad">FAILED · {res.error}</div>
          ))}

        {res?.ok && (
          <div className="inline mb-2">
            <button
              className={`btn-ghost ${view === 'table' ? 'btn-on' : ''}`}
              onClick={() => setView('table')}
              title="Show the rows as a table"
            >
              table
            </button>
            <button
              className={`btn-ghost ${view === 'json' ? 'btn-on' : ''}`}
              onClick={() => setView('json')}
              title="Show the raw JSON rows"
            >
              json
            </button>
            <button
              className="btn-field"
              onClick={() => navigator.clipboard.writeText(JSON.stringify(res.rows, null, 2))}
              title="Copy all rows as JSON to the clipboard"
            >
              copy JSON
            </button>
            <button className="btn-field" onClick={download} title="Download all rows as a CSV file">
              export CSV
            </button>
          </div>
        )}

        {res == null && (
          <div className="empty">
            <div className="empty-icon">◇</div>
            <div className="empty-title">No query run yet</div>
            <div className="empty-hint">
              Paste a connection URL on the left, then click a table to query it or type SQL and press{' '}
              <kbd>⌘/Ctrl + Enter</kbd>.
            </div>
          </div>
        )}

        {res?.ok && view === 'json' && <pre>{JSON.stringify(res.rows, null, 2)}</pre>}

        {res?.ok && view === 'table' && (
          // wide result sets scroll here instead of scrolling the whole page
          <div className="table-scroll">
            {cols.length === 0 ? (
              <div className="empty">
                <div className="empty-icon">◇</div>
                <div className="empty-title">Query returned no rows</div>
                <div className="empty-hint">
                  The query ran fine but matched nothing. Loosen the <kbd>WHERE</kbd> clause, or click a table on
                  the left to see its first rows.
                </div>
              </div>
            ) : (
              <table className="rtable">
                <thead>
                  <tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr>
                </thead>
                <tbody>
                  {res.rows!.map((r, i) => (
                    <tr key={i}>
                      {cols.map((c) => {
                        const s = cell(r[c]);
                        const long = s.length > 80;
                        return (
                          // Truncated cells open a panel on click but are not tab
                          // stops: a result set is up to 500 rows wide of them.
                          // The json view above shows every value in full.
                          <td
                            key={c}
                            className={long ? 'cell-click' : undefined}
                            title={long ? 'Click to open the full value in a panel' : s || undefined}
                            onClick={() => long && setExpanded({ v: s })}
                          >
                            {long ? s.slice(0, 80) + '…' : s}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

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
              <div className="feed-head inline">
                <span className="count">cell value</span>
                <button
                  className="btn-field spacer"
                  onClick={() => navigator.clipboard.writeText(expanded.v)}
                  title="Copy this cell value to the clipboard"
                >
                  copy
                </button>
                <button className="btn-ghost" onClick={closeExpanded} title="Close this panel (Esc)">
                  close
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
