/**
 * gRPC-Web route module — encodes proto text-format via system `protoc`,
 * frames it as gRPC-Web, forwards to the gateway, decodes the response.
 *
 *   GET  /api/grpc/config                  → default proto root
 *   GET  /api/grpc/protos?root=…           → .proto files under root
 *   GET  /api/grpc/inspect?root=…&proto=…  → package / services / rpcs
 *   POST /api/grpc/call                    → CallRequest → CallResult
 */
import * as grpc from '@grpc/grpc-js';
import { Hono } from 'hono';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CallRequest, CallResult, ProtoInfo } from '../src/types';

// Default proto root — point at any repo/dir containing .proto files.
// Override with the PROTO_ROOT env var, or just edit the field in the UI.
const DEFAULT_ROOT = process.env.PROTO_ROOT ?? process.cwd();

const SKIP_DIRS = new Set(['node_modules', 'output-grpc', 'dist', '.git']);

function resolveRoot(root?: string | null): string {
  const r = (root ?? '').trim() || DEFAULT_ROOT;
  const abs = r.startsWith('~') ? path.join(os.homedir(), r.slice(1)) : r;
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory())
    throw new Error(`root directory not found: ${abs}`);
  return abs;
}

// ---------------------------------------------------------------- proto fs --

function listProtos(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 8) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith('.proto')) out.push(path.relative(root, p));
    }
  };
  walk(root, 0);
  return out.sort();
}

/** Regex-parse package / services / rpcs / messages / enums. Good enough for
 *  codegen-style protos; swap for protobufjs if descriptors get exotic.
 *
 *  Messages/enums are merged in from IMPORTED files too (recursively, capped) —
 *  services often live in one file with their request messages in another, and
 *  field hints / template generation need those definitions. */
function inspectProto(root: string, rel: string): ProtoInfo {
  const services: ProtoInfo['services'] = [];
  const enums: ProtoInfo['enums'] = [];
  const messages: ProtoInfo['messages'] = [];
  let pkg = '';

  const visited = new Set<string>();
  const MAX_FILES = 25;

  const parse = (fileRel: string, isEntry: boolean) => {
    if (visited.has(fileRel) || visited.size >= MAX_FILES) return;
    visited.add(fileRel);
    let src: string;
    try {
      src = fs.readFileSync(path.join(root, fileRel), 'utf8');
    } catch {
      return; // unresolvable import — skip, protoc will surface real errors
    }

    if (isEntry) pkg = src.match(/^\s*package\s+([\w.]+)\s*;/m)?.[1] ?? '';

    // services only from the entry file — the dropdown lists what YOU selected
    if (isEntry) {
      for (const m of src.matchAll(/service\s+(\w+)\s*\{([\s\S]*?)\n\}/g)) {
        const rpcs = [
          ...m[2].matchAll(
            /rpc\s+(\w+)\s*\(\s*([\w.]+)\s*\)\s*returns\s*\(\s*(?:stream\s+)?([\w.]+)\s*\)/g,
          ),
        ].map(([, method, req, res]) => ({ method, req, res }));
        services.push({ service: m[1], rpcs });
      }
    }

    for (const m of src.matchAll(/enum\s+(\w+)\s*\{([^{}]*)\}/g)) {
      const values = [...m[2].matchAll(/^\s*(\w+)\s*=\s*\d+/gm)].map((v) => v[1]);
      if (!enums.some((e) => e.name === m[1])) enums.push({ name: m[1], values });
    }

    // Flat (non-nested) message bodies — codegen protos are typically flat.
    for (const m of src.matchAll(/message\s+(\w+)\s*\{([^{}]*)\}/g)) {
      if (messages.some((x) => x.name === m[1])) continue;
      const fields = [
        ...m[2].matchAll(
          /^\s*(repeated\s+|optional\s+)?([\w.]+|map\s*<[^>]+>)\s+(\w+)\s*=\s*\d+\s*;[ \t]*(?:\/\/\s*(.*))?$/gm,
        ),
      ].map(([, label, type, name, comment]) => ({
        name,
        type: type.replace(/\s+/g, ''),
        repeated: (label ?? '').trim() === 'repeated',
        comment: (comment ?? '').trim(),
      }));
      messages.push({ name: m[1], fields });
    }

    // follow imports (paths are relative to the -I root, our convention)
    for (const im of src.matchAll(/^\s*import\s+"([^"]+)"\s*;/gm)) {
      if (!im[1].startsWith('google/')) parse(im[1], false);
    }
  };

  parse(rel, true);
  return { pkg, services, messages, enums };
}

// ------------------------------------------------------------------ protoc --

/** Resolve which protoc to use, ONCE at startup:
 *   1. system `protoc` on PATH  →  use it (zero-config for devs who have it)
 *   2. else the binary bundled in the app (CONDUIT_PROTOC_HOME, set by Electron)
 * The bundled dir also ships google/protobuf/*.proto (well-known types); when we
 * fall back to it we add its include/ so imports like struct.proto resolve. */
const PROTOC = (() => {
  try {
    execFileSync('protoc', ['--version'], { stdio: 'ignore' });
    return { bin: 'protoc', include: '' }; // system protoc bundles its own includes
  } catch {
    const home = process.env.CONDUIT_PROTOC_HOME ?? '';
    if (home) return { bin: path.join(home, 'bin', 'protoc'), include: path.join(home, 'include') };
    return { bin: 'protoc', include: '' }; // last resort — will error clearly if truly absent
  }
})();

function protoc(root: string, args: string[], input?: Buffer | string): Buffer {
  return execFileSync(PROTOC.bin, args, {
    cwd: root,
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
}

const includeArgs = (protoRel: string) => {
  const args = ['-I', '.', '-I', path.dirname(protoRel)];
  if (PROTOC.include) args.push('-I', PROTOC.include); // well-known types for bundled protoc
  return args;
};

function frame(payload: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

/** Split a gRPC-Web response into ALL data frames + parsed trailers.
 *  Server-streaming RPCs return one frame per message. */
function deframe(buf: Buffer): { frames: Buffer[]; trailers: Record<string, string> } {
  let off = 0;
  const frames: Buffer[] = [];
  let trailerText = '';
  while (off + 5 <= buf.length) {
    const flag = buf[off];
    const len = buf.readUInt32BE(off + 1);
    const chunk = buf.subarray(off + 5, off + 5 + len);
    if (flag & 0x80) trailerText += chunk.toString('utf8');
    else frames.push(chunk);
    off += 5 + len;
  }
  const trailers: Record<string, string> = {};
  for (const line of trailerText.split(/\r\n/)) {
    const i = line.indexOf(':');
    if (i > 0) trailers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { frames, trailers };
}

/** gRPC trailers percent-encode the message per spec; make it human-readable. */
function decodeGrpcMessage(m: string): string {
  try {
    return decodeURIComponent(m);
  } catch {
    return m;
  }
}

// -------------------------------------------------------- direct transport --

// Native gRPC via grpc-js with identity (de)serializers: we hand it the
// protoc-encoded request bytes and get raw response bytes back — the SAME
// encode/decode pipeline as gateway mode, only the wire differs.
// A fresh client per call: a cached channel remembers connection failures
// (backoff) and would keep returning stale UNAVAILABLE after the server is up.

const mdToObj = (m?: grpc.Metadata): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const [k, v] of Object.entries(m.getMap())) out[k] = String(v);
  return out;
};

function callDirect(
  req: CallRequest,
  payload: Buffer,
  timeoutMs: number,
): Promise<
  | { ok: true; resp: Buffer; headers: Record<string, string>; trailers: Record<string, string> }
  | { ok: false; code: number; details: string; trailers: Record<string, string> }
> {
  return new Promise((resolve) => {
    const md = new grpc.Metadata();
    for (const [k, v] of Object.entries(req.headers ?? {})) {
      if (!v || k === 'content-type' || k === 'x-grpc-web') continue;
      try {
        md.set(k.toLowerCase(), v);
      } catch {
        /* invalid metadata key — skip */
      }
    }
    let headers: Record<string, string> = {};
    let trailers: Record<string, string> = {};
    const client = new grpc.Client(
      req.target!.trim(),
      req.plaintext !== false ? grpc.credentials.createInsecure() : grpc.credentials.createSsl(),
    );
    const call = client.makeUnaryRequest(
      req.grpcPath!,
      (b: Buffer) => b,
      (b: Buffer) => b,
      payload,
      md,
      { deadline: new Date(Date.now() + timeoutMs) },
      (err, resp) => {
        client.close();
        if (err)
          resolve({
            ok: false,
            code: err.code ?? 2,
            details: err.details || String(err.message ?? err),
            trailers: mdToObj((err as any).metadata),
          });
        else resolve({ ok: true, resp: resp as Buffer, headers, trailers });
      },
    );
    call.on('metadata', (m) => (headers = mdToObj(m)));
    call.on('status', (s) => (trailers = mdToObj(s.metadata)));
  });
}

// -------------------------------------------------------------------- call --

async function doCall(req: CallRequest): Promise<CallResult> {
  const root = resolveRoot(req.root);

  let payload: Buffer;
  try {
    payload = protoc(
      root,
      [...includeArgs(req.proto), `--encode=${req.reqType}`, req.proto],
      req.textBody ?? '',
    );
  } catch (e: any) {
    const msg = String(e.stderr ?? e.message);
    // protoc absent → make it obvious rather than a cryptic spawn error
    if (/ENOENT/.test(msg) && /protoc/.test(String(e.path ?? e.message)))
      return {
        ok: false,
        stage: 'encode',
        error: 'protoc not found. Install it (brew install protobuf) or run the packaged app which bundles it.',
      };
    return { ok: false, stage: 'encode', error: msg };
  }

  // ── direct (native gRPC) ───────────────────────────────────────────────────
  if (req.transport === 'direct') {
    if (!req.target?.trim() || !req.grpcPath)
      return { ok: false, stage: 'network', error: 'direct mode needs a target host:port' };
    const t0 = Date.now();
    const timeoutMs = req.timeoutMs && req.timeoutMs > 0 ? req.timeoutMs : 15000;
    const r = await callDirect(req, payload, timeoutMs);
    const durationMs = Date.now() - t0;
    if (!r.ok)
      return {
        ok: true, // transport-level answer with a gRPC status, mirroring gateway mode
        httpStatus: 200,
        grpcStatus: String(r.code),
        grpcMessage: r.details,
        decoded: '',
        frames: 0,
        rawBytes: 0,
        durationMs,
        reqHeaders: req.headers,
        trailers: r.trailers,
      };
    let decoded = '';
    try {
      decoded = protoc(
        root,
        [...includeArgs(req.proto), `--decode=${req.resType}`, req.proto],
        r.resp,
      ).toString('utf8');
    } catch (e: any) {
      decoded = `<decode failed: ${String(e.stderr ?? e.message)}>`;
    }
    return {
      ok: true,
      httpStatus: 200,
      grpcStatus: '0',
      grpcMessage: '',
      decoded,
      frames: 1,
      rawBytes: r.resp.length,
      durationMs,
      reqHeaders: req.headers,
      headers: r.headers,
      trailers: r.trailers,
    };
  }

  const headers: Record<string, string> = {
    'content-type': 'application/grpc-web+proto',
    'x-grpc-web': '1',
  };
  for (const [k, v] of Object.entries(req.headers ?? {}))
    if (v) headers[k.toLowerCase()] = v;

  const t0 = Date.now();
  const ac = new AbortController();
  const timeoutMs = req.timeoutMs && req.timeoutMs > 0 ? req.timeoutMs : 15000;
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let resp: Response;
  let buf: Buffer;
  try {
    resp = await fetch(req.url, {
      method: 'POST',
      headers,
      body: new Uint8Array(frame(payload)),
      signal: ac.signal,
    });
    buf = Buffer.from(await resp.arrayBuffer());
  } catch (e: any) {
    const durationMs = Date.now() - t0;
    if (e?.name === 'AbortError')
      return { ok: false, stage: 'timeout', error: `request aborted after ${timeoutMs}ms`, durationMs };
    return { ok: false, stage: 'network', error: String(e), durationMs };
  } finally {
    clearTimeout(timer);
  }
  const durationMs = Date.now() - t0;

  // capture all response headers for the viewer
  const respHeaders: Record<string, string> = {};
  resp.headers.forEach((v, k) => (respHeaders[k] = v));

  const ct = resp.headers.get('content-type') ?? '';
  if (!ct.includes('grpc')) {
    return {
      ok: false,
      stage: 'gateway',
      httpStatus: resp.status,
      error: buf.toString('utf8').slice(0, 2000),
      durationMs,
    };
  }

  const { frames, trailers } = deframe(buf);
  const grpcStatus = trailers['grpc-status'] ?? resp.headers.get('grpc-status') ?? '';
  const grpcMessage = decodeGrpcMessage(
    trailers['grpc-message'] ?? resp.headers.get('grpc-message') ?? '',
  );

  const decodedParts = frames
    .filter((f) => f.length)
    .map((f, i) => {
      try {
        const text = protoc(
          root,
          [...includeArgs(req.proto), `--decode=${req.resType}`, req.proto],
          f,
        ).toString('utf8');
        return frames.length > 1 ? `──── message ${i + 1} ────\n${text}` : text;
      } catch (e: any) {
        return `<decode failed: ${String(e.stderr ?? e.message)}>`;
      }
    });

  return {
    ok: true,
    httpStatus: resp.status,
    grpcStatus,
    grpcMessage,
    decoded: decodedParts.join('\n'),
    frames: decodedParts.length,
    rawBytes: buf.length,
    durationMs,
    reqHeaders: headers,
    headers: respHeaders,
    trailers,
  };
}

// --------------------------------------------------------------------- app --

export const grpcRoutes = new Hono();

grpcRoutes.get('/config', (c) => c.json({ defaultRoot: DEFAULT_ROOT }));

grpcRoutes.get('/protos', (c) => {
  try {
    const root = resolveRoot(c.req.query('root'));
    return c.json({ root, protos: listProtos(root) });
  } catch (e: any) {
    return c.json({ error: String(e.message ?? e) }, 400);
  }
});

grpcRoutes.get('/inspect', (c) => {
  const rel = c.req.query('proto');
  if (!rel) return c.json({ error: 'missing ?proto=' }, 400);
  try {
    return c.json(inspectProto(resolveRoot(c.req.query('root')), rel));
  } catch (e: any) {
    return c.json({ error: String(e.message ?? e) }, 500);
  }
});

grpcRoutes.post('/call', async (c) => {
  try {
    return c.json(await doCall(await c.req.json<CallRequest>()));
  } catch (e: any) {
    return c.json({ ok: false, stage: 'encode', error: String(e.message ?? e) }, 200);
  }
});
