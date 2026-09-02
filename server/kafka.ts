/**
 * Kafka route module (kafkajs).
 *
 *   POST /api/kafka/topics    { brokers, ssl?, sasl? }             → { topics }
 *   POST /api/kafka/produce   { …, topic, key?, value }            → { ok }
 *   GET  /api/kafka/consume?cfg=<b64>&topic=&group=&fromBeginning= → SSE feed
 *
 * `cfg` (consume) is the base64 of { brokers, ssl, saslUser, saslPass } since
 * EventSource can't send a body. SASL = plain when user+pass provided.
 */
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { Kafka, logLevel } from 'kafkajs';

interface Cfg {
  brokers: string; // comma-separated host:port
  ssl?: boolean;
  saslUser?: string;
  saslPass?: string;
}

function client(cfg: Cfg): Kafka {
  return new Kafka({
    clientId: 'conduit',
    brokers: cfg.brokers.split(',').map((b) => b.trim()).filter(Boolean),
    ssl: !!cfg.ssl,
    sasl:
      cfg.saslUser && cfg.saslPass
        ? { mechanism: 'plain', username: cfg.saslUser, password: cfg.saslPass }
        : undefined,
    logLevel: logLevel.NOTHING,
    connectionTimeout: 8000,
    requestTimeout: 15000,
  });
}

export const kafkaRoutes = new Hono();

kafkaRoutes.post('/topics', async (c) => {
  const cfg = await c.req.json<Cfg>();
  const admin = client(cfg).admin();
  try {
    await admin.connect();
    const topics = (await admin.listTopics()).sort();
    return c.json({ ok: true, topics });
  } catch (e: any) {
    return c.json({ ok: false, error: String(e?.message ?? e) });
  } finally {
    await admin.disconnect().catch(() => {});
  }
});

kafkaRoutes.post('/produce', async (c) => {
  const body = await c.req.json<
    Cfg & { topic: string; key?: string; value: string; headers?: Record<string, string> }
  >();
  const producer = client(body).producer();
  try {
    await producer.connect();
    const res = await producer.send({
      topic: body.topic,
      messages: [
        {
          key: body.key || undefined,
          value: body.value,
          headers: body.headers && Object.keys(body.headers).length ? body.headers : undefined,
        },
      ],
    });
    return c.json({ ok: true, result: res });
  } catch (e: any) {
    return c.json({ ok: false, error: String(e?.message ?? e) });
  } finally {
    await producer.disconnect().catch(() => {});
  }
});

kafkaRoutes.get('/consume', (c) => {
  const raw = c.req.query('cfg') ?? '';
  const topic = c.req.query('topic') ?? '';
  const groupId = c.req.query('group') || `conduit-${Math.random().toString(36).slice(2, 10)}`;
  const fromBeginning = c.req.query('fromBeginning') === '1';

  return streamSSE(c, async (stream) => {
    let cfg: Cfg;
    try {
      cfg = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    } catch {
      await stream.writeSSE({ event: 'error', data: 'bad cfg payload' });
      return;
    }
    const consumer = client(cfg).consumer({ groupId });
    let alive = true;
    stream.onAbort(async () => {
      alive = false;
      await consumer.disconnect().catch(() => {});
    });
    try {
      await consumer.connect();
      await consumer.subscribe({ topic, fromBeginning });
      await stream.writeSSE({ event: 'ready', data: `${topic} · group ${groupId}` });
      await consumer.run({
        eachMessage: async ({ partition, message }) => {
          if (!alive) return;
          await stream.writeSSE({
            event: 'message',
            data: JSON.stringify({
              at: new Date().toISOString(),
              partition,
              offset: message.offset,
              key: message.key?.toString('utf8') ?? '',
              headers: Object.fromEntries(
                Object.entries(message.headers ?? {}).map(([k, v]) => [
                  k,
                  Buffer.isBuffer(v) ? v.toString('utf8') : String(v ?? ''),
                ]),
              ),
              payload: message.value?.toString('utf8') ?? '',
            }),
          });
        },
      });
      while (alive) await stream.sleep(30000);
    } catch (e: any) {
      if (alive) await stream.writeSSE({ event: 'error', data: String(e?.message ?? e) });
      await consumer.disconnect().catch(() => {});
    }
  });
});
