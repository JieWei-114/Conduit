/**
 * DB query route module — Postgres / MySQL / MongoDB / ClickHouse behind one endpoint.
 *
 *   POST /api/db/query { driver, url, query } →
 *     { ok, rows, rowCount, durationMs }  |  { ok:false, error }
 *
 * query semantics:
 *   postgres / mysql → the SQL text, run as-is.
 *   clickhouse       → the SQL text, run over the HTTP interface (:8123), no driver dep.
 *   mongodb          → JSON: {"collection":"c","filter":{…},"limit":50,"sort":{…}}
 *                      or {"collection":"c","pipeline":[…]} (aggregate)
 *                      or {"command":{…}} (raw db command)
 * Connections are pooled per url and reused. Row output capped at ROWS_MAX.
 */
import { Hono } from 'hono';
import { MongoClient } from 'mongodb';
import mysql from 'mysql2/promise';
import pg from 'pg';

type Driver = 'postgres' | 'mysql' | 'mongodb' | 'clickhouse';

const ROWS_MAX = 500;

const pgPools = new Map<string, pg.Pool>();
const myPools = new Map<string, mysql.Pool>();
const mongoClients = new Map<string, MongoClient>();

function pgPool(url: string): pg.Pool {
  let p = pgPools.get(url);
  if (!p) {
    p = new pg.Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 8000 });
    p.on('error', () => {});
    pgPools.set(url, p);
  }
  return p;
}

function myPool(url: string): mysql.Pool {
  let p = myPools.get(url);
  if (!p) {
    p = mysql.createPool({ uri: url, connectionLimit: 2, connectTimeout: 8000 });
    myPools.set(url, p);
  }
  return p;
}

async function mongo(url: string): Promise<MongoClient> {
  let m = mongoClients.get(url);
  if (!m) {
    m = new MongoClient(url, { serverSelectionTimeoutMS: 8000 });
    await m.connect();
    mongoClients.set(url, m);
  }
  return m;
}

/**
 * Run a query against ClickHouse's HTTP interface — no native client needed.
 * URL shape: http(s)://user:pass@host:8123/database  (db + creds optional).
 * Returns ClickHouse's JSON envelope { data, rows, meta, ... }; for DDL/empty
 * responses `data` defaults to []. Errors surface ClickHouse's text body.
 */
async function chQuery(rawUrl: string, sql: string): Promise<{ data: any[]; rows?: number }> {
  const u = new URL(rawUrl);
  const db = u.pathname.replace(/^\/+/, '') || 'default';
  const user = decodeURIComponent(u.username) || 'default';
  const pass = decodeURIComponent(u.password) || '';
  u.username = '';
  u.password = '';
  const endpoint = `${u.origin}/?database=${encodeURIComponent(db)}&default_format=JSON`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'X-ClickHouse-User': user, 'X-ClickHouse-Key': pass },
      body: sql,
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(text.trim() || `HTTP ${res.status}`);
    try {
      return JSON.parse(text); // SELECT → { data, rows, meta }
    } catch {
      return { data: [] }; // DDL / INSERT → empty body
    }
  } finally {
    clearTimeout(timer);
  }
}

export const dbRoutes = new Hono();

// list tables / collections so you don't have to remember names
dbRoutes.post('/schema', async (c) => {
  const { driver, url } = await c.req.json<{ driver: Driver; url: string }>();
  if (!url?.trim()) return c.json({ ok: false, error: 'missing connection url' });
  try {
    if (driver === 'clickhouse') {
      const r = await chQuery(url.trim(), 'SHOW TABLES');
      return c.json({ ok: true, tables: r.data.map((x: any) => x.name).filter(Boolean) });
    }
    if (driver === 'postgres') {
      const r = await pgPool(url.trim()).query(
        `select table_schema, table_name from information_schema.tables
         where table_schema not in ('pg_catalog','information_schema') order by 1,2`,
      );
      return c.json({
        ok: true,
        tables: r.rows.map((x: any) => (x.table_schema === 'public' ? x.table_name : `${x.table_schema}.${x.table_name}`)),
      });
    }
    if (driver === 'mysql') {
      const [rows] = await myPool(url.trim()).query('show tables');
      return c.json({ ok: true, tables: (rows as any[]).map((r) => Object.values(r)[0]) });
    }
    if (driver === 'mongodb') {
      const cli = await mongo(url.trim());
      const cols = await cli.db().listCollections().toArray();
      return c.json({ ok: true, tables: cols.map((c) => c.name).sort() });
    }
    return c.json({ ok: false, error: `unknown driver ${driver}` });
  } catch (e: any) {
    return c.json({ ok: false, error: String(e?.message ?? e) });
  }
});

dbRoutes.post('/query', async (c) => {
  const { driver, url, query } = await c.req.json<{
    driver: Driver;
    url: string;
    query: string;
  }>();
  if (!url?.trim()) return c.json({ ok: false, error: 'missing connection url' });
  if (!query?.trim()) return c.json({ ok: false, error: 'empty query' });

  const t0 = Date.now();
  try {
    if (driver === 'clickhouse') {
      const r = await chQuery(url.trim(), query);
      const rows = (r.data ?? []).slice(0, ROWS_MAX);
      return c.json({
        ok: true,
        rows,
        rowCount: r.rows ?? r.data?.length ?? rows.length,
        truncated: (r.data?.length ?? 0) > ROWS_MAX,
        durationMs: Date.now() - t0,
      });
    }

    if (driver === 'postgres') {
      const res = await pgPool(url.trim()).query(query);
      const rows = (res.rows ?? []).slice(0, ROWS_MAX);
      return c.json({
        ok: true,
        rows,
        rowCount: res.rowCount ?? rows.length,
        truncated: (res.rows?.length ?? 0) > ROWS_MAX,
        durationMs: Date.now() - t0,
      });
    }

    if (driver === 'mysql') {
      const [result] = await myPool(url.trim()).query(query);
      const rows = Array.isArray(result) ? (result as any[]).slice(0, ROWS_MAX) : [result];
      return c.json({
        ok: true,
        rows,
        rowCount: Array.isArray(result) ? result.length : 1,
        truncated: Array.isArray(result) && result.length > ROWS_MAX,
        durationMs: Date.now() - t0,
      });
    }

    if (driver === 'mongodb') {
      let q: any;
      try {
        q = JSON.parse(query);
      } catch {
        return c.json({ ok: false, error: 'mongodb query must be JSON — see the placeholder for the shape' });
      }
      const cli = await mongo(url.trim());
      const db = cli.db(); // db name from the connection string path
      let rows: any[];
      if (q.command) {
        rows = [await db.command(q.command)];
      } else if (q.pipeline) {
        rows = await db
          .collection(String(q.collection ?? ''))
          .aggregate(q.pipeline)
          .limit(Math.min(Number(q.limit) || ROWS_MAX, ROWS_MAX))
          .toArray();
      } else {
        let cur = db
          .collection(String(q.collection ?? ''))
          .find(q.filter ?? {})
          .limit(Math.min(Number(q.limit) || 50, ROWS_MAX));
        if (q.sort) cur = cur.sort(q.sort);
        rows = await cur.toArray();
      }
      return c.json({ ok: true, rows, rowCount: rows.length, truncated: false, durationMs: Date.now() - t0 });
    }

    return c.json({ ok: false, error: `unknown driver ${driver}` });
  } catch (e: any) {
    return c.json({ ok: false, error: String(e?.message ?? e), durationMs: Date.now() - t0 });
  }
});
