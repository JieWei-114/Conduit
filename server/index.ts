/**
 * conduit — multi-protocol backend debug console.
 * Mounts three route modules under /api/{grpc,redis,pulsar} and serves the
 * built React UI. Exports start() so the Electron shell can boot it in-process;
 * auto-starts when run directly (pnpm start / tsx).
 */
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { grpcRoutes } from './grpc';
import { reflectRoutes } from './grpc-reflect';
import { httpRoutes } from './http';
import { dbRoutes } from './db';
import { kafkaRoutes } from './kafka';
import { redisRoutes } from './redis';
import { pulsarRoutes } from './pulsar';
import { storeRoutes } from './store';
import { webhookRoutes } from './webhook';
import { sseRoutes } from './sse';
import { diagRoutes } from './diag';
import { attachWs } from './ws';

// import.meta.url works under tsx (ESM) but is empty once esbuild bundles this
// to CommonJS for the Electron build — guard so the module still loads there.
// The packaged app sets CONDUIT_STATIC explicitly, so the fallback dir is only
// used in dev.
let here = process.cwd();
try {
  here = path.dirname(fileURLToPath(import.meta.url));
} catch {
  /* bundled CJS — fall back to cwd; CONDUIT_STATIC overrides anyway */
}

const PORT = Number(process.env.PORT ?? 7788);

// UI build dir — overridable so the packaged Electron app can point at its own
// unpacked location. Absolute so it works regardless of cwd.
const STATIC_DIR = process.env.CONDUIT_STATIC ?? path.join(here, '../dist');

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const app = new Hono();

// Any thrown error (incl. malformed JSON bodies) → a clean JSON envelope instead
// of a 500 with a stack trace. Keeps error shape consistent and avoids leaking
// internals to the page.
app.onError((err, c) => c.json({ ok: false, error: String((err as any)?.message ?? err) }, 200));

app.route('/api/grpc', grpcRoutes);
app.route('/api/grpc', reflectRoutes);
app.route('/api/http', httpRoutes);
app.route('/api/db', dbRoutes);
app.route('/api/kafka', kafkaRoutes);
app.route('/api/redis', redisRoutes);
app.route('/api/pulsar', pulsarRoutes);
app.route('/api/webhook', webhookRoutes);
app.route('/api/sse', sseRoutes);
app.route('/api/diag', diagRoutes);
app.route('/api/store', storeRoutes);

// Minimal static server with SPA fallback — reads from an absolute dir via fs
// (works inside an Electron asar, where fs is patched to read archive entries).
app.get('*', (c) => {
  const urlPath = new URL(c.req.url).pathname;
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  let file = path.resolve(STATIC_DIR, rel);
  // contain within STATIC_DIR — reject `..` traversal out of the build dir
  const root = path.resolve(STATIC_DIR);
  if (!file.startsWith(root + path.sep) && file !== root) file = path.join(root, 'index.html');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile())
    file = path.join(STATIC_DIR, 'index.html'); // SPA fallback
  try {
    const body = fs.readFileSync(file);
    const ext = path.extname(file);
    return c.body(body, 200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
  } catch {
    return c.text('not found', 404);
  }
});

export function start(port: number = PORT): Promise<{ port: number }> {
  return new Promise((resolve, reject) => {
    // Bind loopback only. conduit deliberately proxies to arbitrary hosts, runs
    // arbitrary DB/Redis commands and reads local files — that's fine for a
    // personal dev tool, but ONLY if it isn't reachable from the LAN. Override
    // with CONDUIT_HOST if you really need to expose it.
    const hostname = process.env.CONDUIT_HOST ?? '127.0.0.1';
    const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
      const bound = info.port;
      console.log(`conduit → http://${hostname}:${bound}`);
      console.log('panels: gRPC · HTTP · DB · Redis · WS/SSE · Pulsar · Kafka · Webhook · Diag · Utils');
      resolve({ port: bound });
    });
    (server as unknown as import('node:events').EventEmitter).on('error', reject);
    attachWs(server as unknown as import('node:http').Server);

    // Graceful shutdown: stop accepting, close the HTTP server, exit. K8s/CLI
    // send SIGTERM/SIGINT; without this the process is SIGKILLed mid-stream.
    const shutdown = (sig: string) => {
      console.log(`conduit ← ${sig}, shutting down`);
      (server as unknown as import('node:http').Server).close(() => process.exit(0));
      // hard cap so a hung stream can't block exit forever
      setTimeout(() => process.exit(0), 5000).unref();
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
  });
}

// Auto-start unless the Electron shell opts out (it calls start() itself).
if (process.env.CONDUIT_NO_AUTOSTART !== '1') start().catch((e) => {
  console.error('conduit failed to start:', e?.message ?? e);
  process.exit(1);
});
