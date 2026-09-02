/**
 * Redis route module — a friendlier redis-cli over HTTP.
 *
 *   POST /api/redis/ping        {url}                 → connectivity check
 *   POST /api/redis/scan        {url,match,cursor}    → SCAN a page of keys (+type)
 *   POST /api/redis/get         {url,key}             → type-aware value + ttl
 *   POST /api/redis/set         {url,key,type,...}    → type-aware write
 *   POST /api/redis/del         {url,key}             → DEL
 *   POST /api/redis/expire      {url,key,ttl}         → EXPIRE (ttl<0 → PERSIST)
 *   POST /api/redis/cmd         {url,args[]}          → raw command, raw reply
 *   POST /api/redis/publish     {url,channel,message} → PUBLISH
 *   GET  /api/redis/subscribe?url=&channels=a,b       → SSE stream of messages
 *
 * Connections are pooled per url string and reused across requests.
 */
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import Redis from 'ioredis';
import type { RedisType } from '../src/types';

const pool = new Map<string, Redis>();

function client(raw: string): Redis {
  if (!raw?.trim()) throw new Error('missing connection url');
  // ioredis needs a scheme; a bare host:port fails with "Connection is closed".
  const url = /^rediss?:\/\//i.test(raw.trim()) ? raw.trim() : `redis://${raw.trim()}`;
  let c = pool.get(url);
  // Aliyun (and most managed) Redis proxies drop idle connections; a pooled
  // client that reached 'end' never recovers → recreate it.
  if (c && (c.status === 'end' || c.status === 'close')) {
    c.disconnect();
    pool.delete(url);
    c = undefined;
  }
  if (!c) {
    c = new Redis(url, {
      lazyConnect: false,
      // keep retrying (capped backoff) so an idle-dropped socket auto-reconnects
      retryStrategy: (times) => Math.min(times * 300, 3000),
      maxRetriesPerRequest: 3,
      connectTimeout: 8000,
      keepAlive: 15000,
    });
    c.on('error', () => {}); // swallow; surfaced per-command instead
    pool.set(url, c);
  }
  return c;
}

// Cap per-key reads: HGETALL/SMEMBERS/ZRANGE 0 -1 on a million-member key would
// block a prod instance and blow up the payload. Reads are PAGED: ~ELEM_MAX
// elements per call plus a `nextCursor` to continue (zset/list → numeric
// offset, hash/set → SCAN cursor, stream → last entry id). null cursor = done.
const ELEM_MAX = 500;

async function readValue(
  c: Redis,
  key: string,
  type: RedisType,
  cursor?: string | null,
): Promise<{ value: unknown; total: number; nextCursor: string | null }> {
  switch (type) {
    case 'string': {
      const v = await c.get(key);
      return { value: v, total: 1, nextCursor: null };
    }
    case 'hash': {
      const total = await c.hlen(key);
      const pairs: [string, string][] = [];
      let cur = cursor ?? '0';
      // append WHOLE scan batches (dropping mid-batch items would skip them on
      // the next page), so a page may slightly exceed ELEM_MAX — that's fine.
      do {
        const [next, flat] = await c.hscan(key, cur, 'COUNT', 200);
        for (let i = 0; i < flat.length; i += 2) pairs.push([flat[i], flat[i + 1]]);
        cur = next;
      } while (cur !== '0' && pairs.length < ELEM_MAX);
      return { value: pairs, total, nextCursor: cur !== '0' ? cur : null };
    }
    case 'zset': {
      const total = await c.zcard(key);
      const off = Number(cursor) || 0;
      const flat = await c.zrange(key, off, off + ELEM_MAX - 1, 'WITHSCORES');
      const page = chunkPairs(flat);
      const consumed = off + page.length;
      return { value: page, total, nextCursor: consumed < total ? String(consumed) : null };
    }
    case 'list': {
      const total = await c.llen(key);
      const off = Number(cursor) || 0;
      const page = await c.lrange(key, off, off + ELEM_MAX - 1);
      const consumed = off + page.length;
      return { value: page, total, nextCursor: consumed < total ? String(consumed) : null };
    }
    case 'set': {
      const total = await c.scard(key);
      const members: string[] = [];
      let cur = cursor ?? '0';
      do {
        const [next, batch] = await c.sscan(key, cur, 'COUNT', 200);
        members.push(...batch);
        cur = next;
      } while (cur !== '0' && members.length < ELEM_MAX);
      return { value: members, total, nextCursor: cur !== '0' ? cur : null };
    }
    case 'stream': {
      const total = await c.xlen(key);
      // exclusive start "(id" continues after the previous page's last entry
      const start = cursor ? `(${cursor}` : '-';
      const page = (await c.xrange(key, start, '+', 'COUNT', ELEM_MAX)) as [string, string[]][];
      const last = page.length === ELEM_MAX ? page[page.length - 1][0] : null;
      return { value: page, total, nextCursor: last };
    }
    default:
      return { value: null, total: 0, nextCursor: null };
  }
}

function chunkPairs(flat: string[]): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
  return out;
}

export const redisRoutes = new Hono();

redisRoutes.post('/ping', async (c) => {
  try {
    const { url } = await c.req.json();
    const pong = await client(url).ping();
    return c.json({ ok: true, pong });
  } catch (e: any) {
    return c.json({ ok: false, error: String(e.message ?? e) });
  }
});

const hasGlob = (p: string) => /[*?[\]]/.test(p);

async function typeKeys(cli: Redis, keys: string[]) {
  if (!keys.length) return [];
  const pipe = cli.pipeline();
  keys.forEach((k) => pipe.type(k));
  const types = await pipe.exec();
  return keys.map((k, i) => ({ key: k, type: (types?.[i]?.[1] as RedisType) ?? 'none' }));
}

redisRoutes.post('/scan', async (c) => {
  try {
    const { url, match = '*', cursor = '0' } = await c.req.json();
    const cli = client(url);

    // Exact key (no glob) → skip SCAN entirely; a single TYPE is instant even on
    // a million-key DB — SCAN walks the whole keyspace bucket by bucket, so an
    // exact lookup should never pay that cost.
    if (!hasGlob(match)) {
      const type = (await cli.type(match)) as RedisType;
      return c.json({
        ok: true,
        cursor: '0',
        keys: type === 'none' ? [] : [{ key: match, type }],
      });
    }

    // Fuzzy → accumulate across SCAN iterations so one click yields a real page
    // (SCAN filters MATCH after walking, so a big DB returns few/no hits per call).
    const TARGET = 200;
    const MAX_ITER = 60;
    let cur = cursor;
    const found: string[] = [];
    let iter = 0;
    do {
      const [next, batch] = await cli.scan(cur, 'MATCH', match, 'COUNT', 500);
      found.push(...batch);
      cur = next;
      iter++;
    } while (cur !== '0' && found.length < TARGET && iter < MAX_ITER);

    return c.json({ ok: true, cursor: cur, keys: await typeKeys(cli, found) });
  } catch (e: any) {
    return c.json({ ok: false, error: String(e.message ?? e) });
  }
});

// Prefix drill-down: given a prefix, return the distinct next-level segments
// (split on ':'), each flagged as a key / having children, with a match count.
redisRoutes.post('/children', async (c) => {
  try {
    const { url, prefix = '', sep = ':' } = await c.req.json();
    const cli = client(url);
    let cur = '0';
    let iter = 0;
    const keys: string[] = [];
    do {
      const [next, batch] = await cli.scan(cur, 'MATCH', `${prefix}*`, 'COUNT', 1000);
      keys.push(...batch);
      cur = next;
      iter++;
    } while (cur !== '0' && keys.length < 5000 && iter < 60);

    const seg = new Map<string, { seg: string; hasChildren: boolean; isKey: boolean; count: number }>();
    for (const k of keys) {
      const rest = k.slice(prefix.length);
      const i = rest.indexOf(sep);
      const name = i === -1 ? rest : rest.slice(0, i);
      const e = seg.get(name) ?? { seg: name, hasChildren: false, isKey: false, count: 0 };
      if (i === -1) e.isKey = true;
      else e.hasChildren = true;
      e.count++;
      seg.set(name, e);
    }
    const children = [...seg.values()].sort((a, b) => a.seg.localeCompare(b.seg));
    const keyFulls = children.filter((x) => x.isKey).map((x) => prefix + x.seg);
    const typed = await typeKeys(cli, keyFulls);
    const typeOf = Object.fromEntries(typed.map((t) => [t.key, t.type]));
    return c.json({
      ok: true,
      prefix,
      truncated: keys.length >= 5000,
      children: children.map((x) => ({
        ...x,
        full: prefix + x.seg,
        type: x.isKey ? typeOf[prefix + x.seg] : undefined,
      })),
    });
  } catch (e: any) {
    return c.json({ ok: false, error: String(e.message ?? e) });
  }
});

redisRoutes.post('/get', async (c) => {
  try {
    const { url, key, cursor } = await c.req.json();
    const cli = client(url);
    const type = (await cli.type(key)) as RedisType;
    if (type === 'none') return c.json({ ok: false, error: 'key does not exist' });
    const [ttl, rv] = await Promise.all([cli.ttl(key), readValue(cli, key, type, cursor)]);
    return c.json({
      ok: true,
      view: { key, type, ttl, value: rv.value, total: rv.total, nextCursor: rv.nextCursor },
    });
  } catch (e: any) {
    return c.json({ ok: false, error: String(e.message ?? e) });
  }
});

redisRoutes.post('/set', async (c) => {
  try {
    const body = await c.req.json();
    const { url, key, type } = body;
    const cli = client(url);
    switch (type as RedisType) {
      case 'string':
        await cli.set(key, String(body.value ?? ''));
        break;
      case 'hash':
        await cli.hset(key, body.field, String(body.value ?? ''));
        break;
      case 'zset':
        await cli.zadd(key, String(body.score ?? 0), body.member);
        break;
      case 'list':
        await cli[body.left ? 'lpush' : 'rpush'](key, String(body.value ?? ''));
        break;
      case 'set':
        await cli.sadd(key, String(body.member ?? ''));
        break;
      default:
        return c.json({ ok: false, error: `unsupported type ${type}` });
    }
    if (body.ttl != null && Number(body.ttl) > 0) await cli.expire(key, Number(body.ttl));
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ ok: false, error: String(e.message ?? e) });
  }
});

// Remove one element from a container, or DEL the whole key.
redisRoutes.post('/del', async (c) => {
  try {
    const { url, key, type, member } = await c.req.json();
    const cli = client(url);
    if (member != null && type) {
      if (type === 'hash') await cli.hdel(key, member);
      else if (type === 'zset') await cli.zrem(key, member);
      else if (type === 'set') await cli.srem(key, member);
      else if (type === 'list') await cli.lrem(key, 1, member);
      else await cli.del(key);
    } else {
      await cli.del(key);
    }
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ ok: false, error: String(e.message ?? e) });
  }
});

redisRoutes.post('/expire', async (c) => {
  try {
    const { url, key, ttl } = await c.req.json();
    const cli = client(url);
    if (Number(ttl) < 0) await cli.persist(key);
    else await cli.expire(key, Number(ttl));
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ ok: false, error: String(e.message ?? e) });
  }
});

redisRoutes.post('/cmd', async (c) => {
  try {
    const { url, args } = await c.req.json<{ url: string; args: string[] }>();
    if (!Array.isArray(args) || !args.length)
      return c.json({ ok: false, error: 'empty command' });
    const [cmd, ...rest] = args;
    const reply = await client(url).call(cmd, ...rest);
    return c.json({ ok: true, reply });
  } catch (e: any) {
    return c.json({ ok: false, error: String(e.message ?? e) });
  }
});

// INFO parsed into { section: { key: value } } for the dashboard.
redisRoutes.post('/info', async (c) => {
  try {
    const { url } = await c.req.json();
    const raw = await client(url).info();
    const sections: Record<string, Record<string, string>> = {};
    let cur = 'general';
    for (const line of raw.split('\n')) {
      const l = line.trim();
      if (!l) continue;
      if (l.startsWith('#')) {
        cur = l.slice(1).trim().toLowerCase();
        sections[cur] = sections[cur] ?? {};
        continue;
      }
      const i = l.indexOf(':');
      if (i > 0) (sections[cur] = sections[cur] ?? {})[l.slice(0, i)] = l.slice(i + 1);
    }
    return c.json({ ok: true, sections });
  } catch (e: any) {
    return c.json({ ok: false, error: String(e.message ?? e) });
  }
});

// Export up to `limit` keys matching a pattern, with type-aware values.
redisRoutes.post('/export', async (c) => {
  try {
    const { url, match = '*', limit = 1000 } = await c.req.json();
    const cli = client(url);
    const cap = Math.min(Number(limit) || 1000, 5000);
    let cur = '0';
    const keys: string[] = [];
    let iter = 0;
    do {
      const [next, batch] = await cli.scan(cur, 'MATCH', match, 'COUNT', 500);
      keys.push(...batch);
      cur = next;
      iter++;
    } while (cur !== '0' && keys.length < cap && iter < 100);
    const slice = keys.slice(0, cap);
    const out: Record<string, { type: RedisType; ttl: number; value: unknown; total: number }> = {};
    for (const k of slice) {
      const type = (await cli.type(k)) as RedisType;
      const rv = await readValue(cli, k, type);
      out[k] = { type, ttl: await cli.ttl(k), value: rv.value, total: rv.total };
    }
    return c.json({ ok: true, count: slice.length, truncated: keys.length > cap || cur !== '0', data: out });
  } catch (e: any) {
    return c.json({ ok: false, error: String(e.message ?? e) });
  }
});

// Batch runner — one round trip via pipeline, per-command result preserved.
redisRoutes.post('/cmd-batch', async (c) => {
  try {
    const { url, argvs } = await c.req.json<{ url: string; argvs: string[][] }>();
    if (!Array.isArray(argvs) || !argvs.length)
      return c.json({ ok: false, error: 'no commands' });
    const cli = client(url);
    const pipe = cli.pipeline();
    for (const a of argvs) pipe.call(a[0], ...a.slice(1));
    const res = await pipe.exec();
    const results = argvs.map((a, i) => {
      const [err, reply] = res?.[i] ?? [null, null];
      return err
        ? { argv: a, ok: false, error: String((err as Error).message ?? err) }
        : { argv: a, ok: true, reply };
    });
    return c.json({ ok: true, results });
  } catch (e: any) {
    return c.json({ ok: false, error: String(e.message ?? e) });
  }
});

redisRoutes.post('/publish', async (c) => {
  try {
    const { url, channel, message } = await c.req.json();
    const receivers = await client(url).publish(channel, message);
    return c.json({ ok: true, receivers });
  } catch (e: any) {
    return c.json({ ok: false, error: String(e.message ?? e) });
  }
});

// SSE live feed. Uses a DEDICATED subscriber connection (ioredis forbids normal
// commands on a subscribed connection), torn down when the client disconnects.
redisRoutes.get('/subscribe', (c) => {
  const raw = c.req.query('url') ?? '';
  const url = /^rediss?:\/\//i.test(raw.trim()) ? raw.trim() : `redis://${raw.trim()}`;
  const channels = (c.req.query('channels') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const pattern = c.req.query('pattern') === '1';
  return streamSSE(c, async (stream) => {
    const sub = new Redis(url, { connectTimeout: 5000, maxRetriesPerRequest: 2 });
    sub.on('error', (e) => {
      stream.writeSSE({ event: 'error', data: String(e.message) }).catch(() => {});
    });
    const onMsg = (channel: string, message: string) =>
      stream.writeSSE({ event: 'message', data: JSON.stringify({ channel, message, at: new Date().toISOString() }) });
    if (pattern) {
      await sub.psubscribe(...channels);
      sub.on('pmessage', (_p, ch, msg) => onMsg(ch, msg));
    } else {
      await sub.subscribe(...channels);
      sub.on('message', onMsg);
    }
    await stream.writeSSE({ event: 'ready', data: channels.join(',') });
    // hold open until the client aborts
    let alive = true;
    stream.onAbort(() => {
      alive = false;
      sub.disconnect();
    });
    while (alive) await stream.sleep(30000);
  });
});
