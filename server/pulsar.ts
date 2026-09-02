/**
 * Pulsar route module — produce & consume via the native pulsar-client (same
 * binding the backend uses, so pulsar:// / pulsar+ssl:// + token/oauth2 work
 * identically).
 *
 *   POST /api/pulsar/produce   {conn, topic, payload, properties}  → send one
 *   GET  /api/pulsar/consume?conn=<b64>&topic=&subscription=&type= → SSE feed
 *
 * `conn` in produce is the PulsarConnConfig object; in consume it is the same
 * object base64-encoded (EventSource can't send a body).
 */
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
// eslint-disable-next-line @typescript-eslint/no-var-requires
import Pulsar from 'pulsar-client';
import type { PulsarConnConfig } from '../src/types';

// Reuse one native Client per serviceUrl+auth (native clients are heavy).
const clients = new Map<string, any>();

function clientKey(conn: PulsarConnConfig): string {
  return JSON.stringify([conn.serviceUrl, conn.authType, conn.token, conn.oauth]);
}

function getClient(conn: PulsarConnConfig): any {
  const key = clientKey(conn);
  let cli = clients.get(key);
  if (cli) return cli;

  const opts: any = { serviceUrl: conn.serviceUrl, operationTimeoutSeconds: 30 };
  if (conn.authType === 'token' && conn.token) {
    opts.authentication = new Pulsar.AuthenticationToken({ token: conn.token });
  } else if (conn.authType === 'oauth2' && conn.oauth) {
    opts.authentication = new Pulsar.AuthenticationOauth2({
      type: 'oauth2',
      issuer_url: conn.oauth.issuerUrl,
      client_id: conn.oauth.clientId,
      client_secret: conn.oauth.clientSecret,
      audience: conn.oauth.audience,
    });
  }
  cli = new Pulsar.Client(opts);
  clients.set(key, cli);
  return cli;
}

export const pulsarRoutes = new Hono();

// ── admin REST API (topic list / stats) — separate from the broker URL ──────
async function adminFetch(adminUrl: string, path: string, token?: string) {
  const base = adminUrl.trim().replace(/\/$/, '');
  const resp = await fetch(`${base}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  return resp.json();
}

/** persistent://tenant/ns/name → "persistent/tenant/ns/name" for admin paths */
function topicPath(topic: string): string {
  const m = topic.trim().match(/^(persistent|non-persistent):\/\/(.+)$/);
  return m ? `${m[1]}/${m[2]}` : `persistent/public/default/${topic.trim()}`;
}

pulsarRoutes.post('/tenants', async (c) => {
  try {
    const { adminUrl, token } = await c.req.json();
    const tenants = (await adminFetch(adminUrl, '/admin/v2/tenants', token)) as string[];
    return c.json({ ok: true, tenants: tenants.sort() });
  } catch (e: any) {
    return c.json({ ok: false, error: String(e?.message ?? e) });
  }
});

pulsarRoutes.post('/namespaces', async (c) => {
  try {
    const { adminUrl, tenant = 'public', token } = await c.req.json();
    // returns ["tenant/ns", …] — strip the tenant prefix for display
    const raw = (await adminFetch(adminUrl, `/admin/v2/namespaces/${tenant}`, token)) as string[];
    const namespaces = raw.map((n) => n.split('/').pop()!).sort();
    return c.json({ ok: true, namespaces });
  } catch (e: any) {
    return c.json({ ok: false, error: String(e?.message ?? e) });
  }
});

pulsarRoutes.post('/topics', async (c) => {
  try {
    const { adminUrl, tenant = 'public', namespace = 'default', token } = await c.req.json();
    if (!adminUrl?.trim()) return c.json({ ok: false, error: 'missing admin URL (usually http://host:8080)' });
    const topics = (await adminFetch(adminUrl, `/admin/v2/persistent/${tenant}/${namespace}`, token)) as string[];
    return c.json({ ok: true, topics: topics.sort() });
  } catch (e: any) {
    return c.json({ ok: false, error: String(e?.message ?? e) });
  }
});

// ── subscription management ──────────────────────────────────────────────────
// Summarised from topic stats: one row per subscription with the fields that
// matter when hunting a stuck consumer.
pulsarRoutes.post('/subs', async (c) => {
  try {
    const { adminUrl, topic, token } = await c.req.json();
    const stats = (await adminFetch(adminUrl, `/admin/v2/${topicPath(topic)}/stats`, token)) as any;
    const subs = Object.entries(stats.subscriptions ?? {}).map(([name, s]: [string, any]) => ({
      name,
      type: s.type ?? '',
      backlog: s.msgBacklog ?? 0,
      consumers: (s.consumers ?? []).length,
      msgRateOut: Math.round((s.msgRateOut ?? 0) * 10) / 10,
      lastConsumedTimestamp: s.lastConsumedTimestamp ?? 0,
    }));
    return c.json({ ok: true, subs });
  } catch (e: any) {
    return c.json({ ok: false, error: String(e?.message ?? e) });
  }
});

async function adminPost(adminUrl: string, path: string, method: 'POST' | 'DELETE', token?: string) {
  const base = adminUrl.trim().replace(/\/$/, '');
  const resp = await fetch(`${base}${path}`, {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
}

// clear (skip) the whole backlog of one subscription
pulsarRoutes.post('/sub-skip', async (c) => {
  try {
    const { adminUrl, topic, sub, token } = await c.req.json();
    await adminPost(adminUrl, `/admin/v2/${topicPath(topic)}/subscription/${encodeURIComponent(sub)}/skip_all`, 'POST', token);
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ ok: false, error: String(e?.message ?? e) });
  }
});

// delete a subscription (fails if consumers are still connected — surfaced as-is)
pulsarRoutes.post('/sub-delete', async (c) => {
  try {
    const { adminUrl, topic, sub, token } = await c.req.json();
    await adminPost(adminUrl, `/admin/v2/${topicPath(topic)}/subscription/${encodeURIComponent(sub)}`, 'DELETE', token);
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ ok: false, error: String(e?.message ?? e) });
  }
});

// ── peek (examinemessage): read messages WITHOUT consuming/acking ────────────
pulsarRoutes.post('/peek', async (c) => {
  try {
    const { adminUrl, topic, position = 'latest', count = 5, token } = await c.req.json();
    const base = adminUrl.trim().replace(/\/$/, '');
    const n = Math.min(Math.max(1, Number(count) || 5), 20);
    const messages: { pos: number; payload: string; publishTime?: string; messageId?: string }[] = [];
    for (let i = 1; i <= n; i++) {
      const resp = await fetch(
        `${base}/admin/v2/${topicPath(topic)}/examinemessage?initialPosition=${position}&messagePosition=${i}`,
        { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(10000) },
      );
      if (!resp.ok) {
        if (messages.length) break; // ran past the end of the topic
        throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
      }
      const buf = Buffer.from(await resp.arrayBuffer());
      messages.push({
        pos: i,
        payload: buf.toString('utf8'),
        publishTime: resp.headers.get('x-pulsar-publish-time') ?? undefined,
        messageId: resp.headers.get('x-pulsar-message-id') ?? undefined,
      });
    }
    return c.json({ ok: true, messages });
  } catch (e: any) {
    return c.json({ ok: false, error: String(e?.message ?? e) });
  }
});

pulsarRoutes.post('/stats', async (c) => {
  try {
    const { adminUrl, topic, token } = await c.req.json();
    if (!adminUrl?.trim() || !topic?.trim())
      return c.json({ ok: false, error: 'missing admin URL or topic' });
    // topic like persistent://tenant/ns/name → /admin/v2/persistent/tenant/ns/name/stats
    const m = topic.match(/^(persistent|non-persistent):\/\/(.+)$/);
    const pathPart = m ? `${m[1]}/${m[2]}` : `persistent/public/default/${topic}`;
    const stats = await adminFetch(adminUrl, `/admin/v2/${pathPart}/stats`, token);
    return c.json({ ok: true, stats });
  } catch (e: any) {
    return c.json({ ok: false, error: String(e?.message ?? e) });
  }
});

pulsarRoutes.post('/produce', async (c) => {
  let producer: any;
  try {
    const { conn, topic, payload, properties, key, deliverAfterMs } = await c.req.json<{
      conn: PulsarConnConfig;
      topic: string;
      payload: string;
      properties?: Record<string, string>;
      key?: string;
      deliverAfterMs?: number;
    }>();
    producer = await getClient(conn).createProducer({ topic, sendTimeoutMs: 10000 });
    const id = await producer.send({
      data: Buffer.from(payload, 'utf8'),
      properties: properties ?? {},
      ...(key?.trim() ? { partitionKey: key.trim() } : {}),
      // delayed delivery — broker holds the message until the delay elapses
      // (needs a Shared/Key_Shared subscription on the consumer side to apply)
      ...(deliverAfterMs && deliverAfterMs > 0 ? { deliverAfter: deliverAfterMs } : {}),
    });
    return c.json({ ok: true, messageId: String(id) });
  } catch (e: any) {
    return c.json({ ok: false, error: String(e.message ?? e) });
  } finally {
    if (producer) await producer.close().catch(() => {});
  }
});

pulsarRoutes.get('/consume', (c) => {
  const raw = c.req.query('conn') ?? '';
  const topic = c.req.query('topic') ?? '';
  const subscription = c.req.query('subscription') || `conduit-${Date.now()}`;
  const subType = c.req.query('type') || 'Exclusive';
  const position = c.req.query('position') === 'earliest' ? 'Earliest' : 'Latest';
  // Optional server-side substring filter — only messages whose payload OR
  // properties contain this string are forwarded (others are still acked so the
  // subscription never backs up). Handy for a firehose topic like the bet
  // stream: pass ?filter=<playerId> to see only that player's bets.
  const filter = c.req.query('filter') || '';

  return streamSSE(c, async (stream) => {
    let conn: PulsarConnConfig;
    try {
      conn = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    } catch {
      await stream.writeSSE({ event: 'error', data: 'bad conn payload' });
      return;
    }
    let consumer: any;
    try {
      consumer = await getClient(conn).subscribe({
        topic,
        subscription,
        subscriptionType: subType as any,
        subscriptionInitialPosition: position as any,
      });
    } catch (e: any) {
      await stream.writeSSE({ event: 'error', data: String(e.message ?? e) });
      return;
    }
    await stream.writeSSE({ event: 'ready', data: `${topic} · ${subscription}` });

    let alive = true;
    stream.onAbort(async () => {
      alive = false;
      await consumer?.close().catch(() => {});
    });

    while (alive) {
      try {
        const msg = await consumer.receive(); // resolves on next message
        const payload = msg.getData().toString('utf8');
        const props = msg.getProperties();
        // Firehose filter: skip (but still ack) anything not matching `filter`.
        if (!filter || payload.includes(filter) || JSON.stringify(props).includes(filter)) {
          await stream.writeSSE({
            event: 'message',
            data: JSON.stringify({
              at: new Date().toISOString(),
              messageId: String(msg.getMessageId()),
              publishTime: msg.getPublishTimestamp(),
              properties: props,
              payload,
            }),
          });
        }
        consumer.acknowledge(msg).catch(() => {}); // ack failure must not crash the stream
      } catch (e: any) {
        if (alive) await stream.writeSSE({ event: 'error', data: String(e.message ?? e) });
        break;
      }
    }
  });
});
