/**
 * Connectivity diagnostics — TCP reachability, TLS cert inspection, DNS, and
 * HTTP health ping. All via Node built-ins (net / tls / dns), no deps.
 *
 *   POST /api/diag/tcp   { host, port }   → { open, ms, error? }
 *   POST /api/diag/tls   { host, port? }  → { ok, subject, issuer, validTo, daysLeft, ... }
 *   POST /api/diag/dns   { host }         → { A, AAAA, CNAME, MX }
 *   POST /api/diag/ping  { url }          → { ok, status, ms, error? }
 */
import dns from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import { Hono } from 'hono';

export const diagRoutes = new Hono();

function tcpCheck(host: string, port: number, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = net.connect({ host, port });
    let done = false;
    const finish = (open: boolean, error?: string) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve({ open, ms: Date.now() - t0, error });
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false, 'timeout'));
    sock.once('error', (e: any) => finish(false, String(e?.message ?? e)));
  });
}

function tlsCheck(host: string, port: number, timeoutMs = 8000): Promise<any> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = tls.connect({ host, port, servername: host, rejectUnauthorized: false }, () => {
      const c: any = sock.getPeerCertificate();
      const validTo = c?.valid_to;
      const daysLeft = validTo ? Math.floor((new Date(validTo).getTime() - Date.now()) / 86400000) : null;
      resolve({
        ok: true,
        ms: Date.now() - t0,
        subject: c?.subject?.CN ?? '',
        issuer: c?.issuer?.CN ?? '',
        validFrom: c?.valid_from ?? '',
        validTo: validTo ?? '',
        daysLeft,
        altNames: c?.subjectaltname ?? '',
        authorized: sock.authorized,
        authError: sock.authorizationError ? String(sock.authorizationError) : '',
      });
      sock.destroy();
    });
    sock.setTimeout(timeoutMs);
    sock.once('timeout', () => {
      sock.destroy();
      resolve({ ok: false, error: 'timeout' });
    });
    sock.once('error', (e: any) => resolve({ ok: false, error: String(e?.message ?? e) }));
  });
}

diagRoutes.post('/tcp', async (c) => {
  const { host, port } = await c.req.json<{ host: string; port: number }>();
  if (!host?.trim() || !port) return c.json({ ok: false, error: 'host and port required' });
  return c.json({ ok: true, ...(await tcpCheck(host.trim(), Number(port))) });
});

diagRoutes.post('/tls', async (c) => {
  const { host, port } = await c.req.json<{ host: string; port?: number }>();
  if (!host?.trim()) return c.json({ ok: false, error: 'host required' });
  return c.json(await tlsCheck(host.trim(), Number(port) || 443));
});

diagRoutes.post('/dns', async (c) => {
  const { host } = await c.req.json<{ host: string }>();
  if (!host?.trim()) return c.json({ ok: false, error: 'host required' });
  const h = host.trim();
  const safe = async (fn: () => Promise<any>) => {
    try {
      return await fn();
    } catch {
      return [];
    }
  };
  const [A, AAAA, CNAME, MX] = await Promise.all([
    safe(() => dns.resolve4(h)),
    safe(() => dns.resolve6(h)),
    safe(() => dns.resolveCname(h)),
    safe(() => dns.resolveMx(h)),
  ]);
  return c.json({ ok: true, A, AAAA, CNAME, MX });
});

diagRoutes.post('/ping', async (c) => {
  const { url } = await c.req.json<{ url: string }>();
  if (!/^https?:\/\//i.test(url ?? '')) return c.json({ ok: false, error: 'url must be http(s)://' });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  const t0 = Date.now();
  try {
    const r = await fetch(url, { method: 'GET', signal: ctrl.signal, redirect: 'manual' });
    return c.json({ ok: true, status: r.status, ms: Date.now() - t0 });
  } catch (e: any) {
    return c.json({ ok: false, error: String(e?.name === 'AbortError' ? 'timeout' : e?.message ?? e), ms: Date.now() - t0 });
  } finally {
    clearTimeout(timer);
  }
});
