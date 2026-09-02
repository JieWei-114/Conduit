/**
 * SSE proxy — lets the UI consume any Server-Sent-Events endpoint, including
 * cross-origin ones and ones that need auth headers (the browser EventSource
 * can't set headers). We open the upstream with fetch + headers and stream its
 * body straight back as text/event-stream.
 *
 *   GET /api/sse/proxy?target=<url>&headers=<base64 json>
 */
import { Hono } from 'hono';

export const sseRoutes = new Hono();

sseRoutes.get('/proxy', async (c) => {
  const target = c.req.query('target') ?? '';
  if (!/^https?:\/\//i.test(target)) return c.text('target must be http(s)://', 400);

  let headers: Record<string, string> = {};
  const hb = c.req.query('headers');
  if (hb) {
    try {
      headers = JSON.parse(Buffer.from(hb, 'base64').toString('utf8'));
    } catch {
      /* ignore malformed header blob */
    }
  }

  let upstream: Response;
  try {
    // forward the client's abort so closing the browser tab cancels the upstream
    // stream instead of leaking the connection until it ends on its own.
    upstream = await fetch(target, {
      headers: { accept: 'text/event-stream', ...headers },
      signal: c.req.raw.signal,
    });
  } catch (e: any) {
    return c.text(`upstream connect failed: ${String(e?.message ?? e)}`, 502);
  }
  if (!upstream.body) return c.text(`upstream ${upstream.status} — no stream body`, 502);

  // pass the upstream event stream straight through
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
});
