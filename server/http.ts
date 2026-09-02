/**
 * HTTP / REST route module — proxies the request server-side so the browser
 * never hits CORS, and captures status/headers/timing uniformly.
 *
 *   POST /api/http/send  { url, method, headers, bodyKind, body, form, files, timeoutMs }
 *     → { ok, status, statusText, headers, bodyText, truncated, durationMs, size }
 *
 * bodyKind:
 *   'raw'       → body sent as-is (content-type from headers)
 *   'form'      → `form` (k/v) urlencoded, content-type set automatically
 *   'multipart' → `form` fields + `files` ({field,name,contentB64}) as multipart
 *   'none'      → no body
 */
import { Hono } from 'hono';

const BODY_MAX = 2_000_000; // keep responses displayable; note truncation

interface SendReq {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  bodyKind?: 'raw' | 'form' | 'multipart' | 'none';
  body?: string;
  form?: { key: string; value: string }[];
  files?: { field: string; name: string; contentB64: string }[];
  timeoutMs?: number;
}

export const httpRoutes = new Hono();

httpRoutes.post('/send', async (c) => {
  const req = await c.req.json<SendReq>();
  const { url, method = 'GET', headers = {}, bodyKind = 'raw', timeoutMs = 15000 } = req;
  if (!url?.trim()) return c.json({ ok: false, error: 'missing url' });

  // caller-supplied headers (a specific content-type here wins over auto ones)
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) if (v) h[k.toLowerCase()] = v;

  const noBody = ['GET', 'HEAD'].includes(method.toUpperCase());
  let payload: BodyInit | undefined;

  if (!noBody && bodyKind !== 'none') {
    if (bodyKind === 'form') {
      const p = new URLSearchParams();
      for (const { key, value } of req.form ?? []) if (key) p.append(key, value);
      payload = p.toString();
      if (!h['content-type']) h['content-type'] = 'application/x-www-form-urlencoded';
    } else if (bodyKind === 'multipart') {
      const fd = new FormData();
      for (const { key, value } of req.form ?? []) if (key) fd.append(key, value);
      for (const f of req.files ?? [])
        if (f.field && f.name)
          fd.append(f.field, new Blob([Buffer.from(f.contentB64, 'base64')]), f.name);
      payload = fd; // fetch sets the multipart content-type + boundary itself
      delete h['content-type'];
    } else {
      payload = req.body ?? ''; // raw
    }
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs > 0 ? timeoutMs : 15000);
  const t0 = Date.now();
  try {
    const resp = await fetch(url, {
      method: method.toUpperCase(),
      headers: h,
      body: payload,
      redirect: 'follow',
      signal: ac.signal,
    });
    const buf = Buffer.from(await resp.arrayBuffer());
    const durationMs = Date.now() - t0;
    const respHeaders: Record<string, string> = {};
    resp.headers.forEach((v, k) => (respHeaders[k] = v));

    // binary responses (images, pdf, protobuf, gzip…) aren't meant to be read as
    // text — flag them and skip the utf8 mojibake, offer base64 for download.
    const ct = (respHeaders['content-type'] ?? '').toLowerCase();
    const textual =
      !ct ||
      /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|graphql)|[^;]*\+(json|xml))/.test(ct);
    if (!textual) {
      return c.json({
        ok: true,
        status: resp.status,
        statusText: resp.statusText,
        headers: respHeaders,
        binary: true,
        contentType: ct,
        bodyBase64: buf.slice(0, BODY_MAX).toString('base64'),
        bodyText: '',
        truncated: buf.length > BODY_MAX,
        durationMs,
        size: buf.length,
      });
    }

    const text = buf.toString('utf8');
    return c.json({
      ok: true,
      status: resp.status,
      statusText: resp.statusText,
      headers: respHeaders,
      bodyText: text.slice(0, BODY_MAX),
      truncated: text.length > BODY_MAX,
      durationMs,
      size: buf.length,
    });
  } catch (e: any) {
    const durationMs = Date.now() - t0;
    if (e?.name === 'AbortError')
      return c.json({ ok: false, error: `request aborted after ${timeoutMs}ms`, durationMs });
    return c.json({ ok: false, error: String(e?.cause?.message ?? e?.message ?? e), durationMs });
  } finally {
    clearTimeout(timer);
  }
});
