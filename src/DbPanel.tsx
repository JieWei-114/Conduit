import { useEffect, useRef, useState } from 'react';

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
      <div className="req-tabs">
        {tabs.map((t) => (
          <span
            key={t.id}
            className={`req-tab ${t.id === activeId ? 'active' : ''}`}
            onClick={() => setActiveId(t.id)}
            title={t.form.query || t.form.url || 'new query'}
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
        <span className="req-tab req-tab-add" title="new query tab (clones this connection)" onClick={addTab}>+</span>
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
          >
            save
          </button>
          <button
            className="btn-field btn-danger"
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
          <select value={form.driver} onChange={(e) => { set('driver', e.target.value as Driver); setTables([]); }} style={{ width: 150, flex: '0 0 auto' }}>
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

        <div className="row field-row" style={{ marginTop: 6 }}>
          <button className="btn-field" onClick={loadTables} style={{ width: 150, flex: '0 0 auto' }}>
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
        {tables.length > 0 && (
          <div className="keylist" style={{ maxHeight: 160 }}>
            {shownTables.map((t) => (
              <div
                key={t}
                className="keyrow"
                onClick={() => {
                  const q = queryForTable(form.driver, t);
                  set('query', q);
                  run(q);
                }}
                title="fill the query box and run SELECT * on this"
              >
                <span className="kname">{t}</span>
              </div>
            ))}
          </div>
        )}

        <label>
          {form.driver === 'mongodb'
            ? 'Query — {collection, filter?, limit?, sort?} | {collection, pipeline} | {command}'
            : 'Query — SQL'}
        </label>
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

        <button disabled={busy} onClick={() => run()}>
          {busy ? 'Running…' : 'Run ▶'}
        </button>

        {hist.length > 0 && (
          <>
            <label>Recent queries</label>
            <div className="keylist" style={{ maxHeight: 150 }}>
              {hist.slice(0, 12).map((h, i) => (
                <div
                  key={i}
                  className={`keyrow ${h.ok ? '' : 'hist-bad'}`}
                  title={h.query}
                  onClick={() => set('query', h.query)}
                >
                  <span className="tbadge" style={{ background: 'var(--border-soft)', color: 'var(--text-faint)' }}>
                    {h.ok ? (h.rowCount ?? '') : 'err'}
                  </span>
                  <span className="kname">{h.query.replace(/\s+/g, ' ').slice(0, 42)}</span>
                </div>
              ))}
              <span className="chip" onClick={() => { setHist([]); localStorage.removeItem(LS_HISTORY); }}>clear</span>
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
          <div className="chips" style={{ marginBottom: 8 }}>
            <span className={`chip ${view === 'table' ? 'chip-active' : ''}`} onClick={() => setView('table')}>table</span>
            <span className={`chip ${view === 'json' ? 'chip-active' : ''}`} onClick={() => setView('json')}>json</span>
            <span className="chip" onClick={() => navigator.clipboard.writeText(JSON.stringify(res.rows, null, 2))}>copy JSON</span>
            <span className="chip" onClick={download}>export CSV</span>
          </div>
        )}

        {res == null && <pre>Pick a driver, paste a connection URL, list tables or write a query, Run.</pre>}

        {res?.ok && view === 'json' && <pre>{JSON.stringify(res.rows, null, 2)}</pre>}

        {res?.ok && view === 'table' && (
          <div style={{ overflowX: 'auto' }}>
            {cols.length === 0 ? (
              <pre>(no rows)</pre>
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
                          <td
                            key={c}
                            style={long ? { cursor: 'pointer' } : undefined}
                            title={long ? 'click to expand' : undefined}
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
          <div className="modal" onClick={() => setExpanded(null)}>
            <div className="modal-box" onClick={(e) => e.stopPropagation()}>
              <div className="feed-head">
                <span className="count">cell value</span>
                <span className="chip" onClick={() => navigator.clipboard.writeText(expanded.v)}>copy</span>
                <span className="chip" onClick={() => setExpanded(null)}>close</span>
              </div>
              <pre style={{ maxHeight: '60vh', overflow: 'auto' }}>
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
