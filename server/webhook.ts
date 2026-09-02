/**
 * Webhook receiver — turns conduit into a server that CAPTURES inbound HTTP.
 *
 *   ANY  /api/webhook/in/*      → records the request, replies with the
 *                                 configured status/body, and pushes it to
 *                                 every open /stream listener (live).
 *   GET  /api/webhook/list      → { ok, captured: [...] }  (backfill on load)
 *   POST /api/webhook/clear     → wipe the buffer
 *   GET  /api/webhook/config    → current canned response
 *   POST /api/webhook/config    → { status, contentType, body } set canned response
 *   GET  /api/webhook/stream    → SSE feed of newly-captured requests
 *
 * Point any external caller (payment / CRM / 3rd-party push) at
 *   http://<your-ip>:7788/api/webhook/in/<anything>
 * and watch it land here without a public tunnel.
 */
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

interface Captured {
  id: number;
  at: string;
  method: string;
  path: string; // portion after /in
  query: Record<string, string>;
  headers: Record<string, string>;
  body: string;
}

const CAP_MAX = 200;
const captured: Captured[] = [];
let seq = 0;

// live listeners — each is a writer that pushes one record as an SSE event
const subs = new Set<(rec: Captured) => void>();

// canned response returned to the CALLER (not to the conduit UI)
let response = { status: 200, contentType: 'application/json', body: '{"ok":true}' };

export const webhookRoutes = new Hono();

async function capture(c: any) {
  const url = new URL(c.req.url);
  const path = url.pathname.replace(/^\/api\/webhook\/in/, '') || '/';
  let body = '';
  try {
    body = await c.req.text();
  } catch {
    /* no body */
  }
  const rec: Captured = {
    id: seq++,
    at: new Date().toISOString(),
    method: c.req.method,
    path,
    query: Object.fromEntries(url.searchParams),
    headers: Object.fromEntries(
      [...c.req.raw.headers.entries()].map(([k, v]) => [k, String(v)]),
    ),
    body,
  };
  captured.unshift(rec);
  if (captured.length > CAP_MAX) captured.length = CAP_MAX;
  for (const push of subs) {
    try {
      push(rec);
    } catch {
      /* listener gone */
    }
  }
  return c.body(response.body, response.status as any, { 'content-type': response.contentType });
}

webhookRoutes.all('/in', capture);
webhookRoutes.all('/in/*', capture);

webhookRoutes.get('/list', (c) => c.json({ ok: true, captured }));

webhookRoutes.post('/clear', (c) => {
  captured.length = 0;
  return c.json({ ok: true });
});

webhookRoutes.get('/config', (c) => c.json({ ok: true, ...response }));
webhookRoutes.post('/config', async (c) => {
  const b = await c.req.json<Partial<typeof response>>();
  response = {
    status: Number(b.status) || 200,
    contentType: b.contentType || 'application/json',
    body: b.body ?? '',
  };
  return c.json({ ok: true, ...response });
});

webhookRoutes.get('/stream', (c) =>
  streamSSE(c, async (stream) => {
    let alive = true;
    const push = (rec: Captured) => {
      stream.writeSSE({ event: 'hit', data: JSON.stringify(rec) }).catch(() => {});
    };
    subs.add(push);
    stream.onAbort(() => {
      alive = false;
      subs.delete(push);
    });
    await stream.writeSSE({ event: 'ready', data: 'listening' });
    // keep the generator alive; records arrive via the `push` callback
    while (alive) await stream.sleep(30000);
  }),
);
