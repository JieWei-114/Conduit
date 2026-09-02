/**
 * gRPC server-reflection — list services/methods and call them WITHOUT a local
 * .proto. Uses grpc-reflection-js to pull descriptors (returns a protobufjs
 * Root), protobufjs for dynamic encode/decode, and grpc-js (identity
 * serializers) for the direct native-gRPC call. Parallel to the protoc path in
 * grpc.ts — this one needs the target server to have reflection ENABLED.
 *
 *   POST /api/grpc/reflect       { target, plaintext } → { ok, services:[{service, methods:[…]}] }
 *   POST /api/grpc/reflect/call  { target, plaintext, service, method, requestJson, headers, timeoutMs }
 *                                → { ok, grpcStatus, grpcMessage, decoded, durationMs, ... }
 *
 * Reflection works over the DIRECT transport only (native gRPC host:port), not
 * the gRPC-Web gateway.
 */
import * as grpc from '@grpc/grpc-js';
import { Client as ReflectionClient } from 'grpc-reflection-js';
import { Hono } from 'hono';
import protobuf from 'protobufjs';

const INTERNAL = /^grpc\.(reflection|health|channelz)\./;

function creds(plaintext?: boolean): grpc.ChannelCredentials {
  return plaintext !== false ? grpc.credentials.createInsecure() : grpc.credentials.createSsl();
}

// cache the protobufjs Root per (target, plaintext, service) so /call doesn't
// re-fetch descriptors on every request.
const rootCache = new Map<string, protobuf.Root>();
const keyOf = (t: string, p: boolean | undefined, s: string) => `${t}|${p !== false}|${s}`;

async function rootForService(target: string, plaintext: boolean | undefined, service: string): Promise<protobuf.Root> {
  const k = keyOf(target, plaintext, service);
  const cached = rootCache.get(k);
  if (cached) return cached;
  const client = new ReflectionClient(target, creds(plaintext));
  const root = (await client.fileContainingSymbol(service)) as unknown as protobuf.Root;
  // link every field to its message/enum type (across dependency files) so
  // template generation can see nested types; best-effort (a missing import
  // shouldn't blow up listing).
  try {
    root.resolveAll();
  } catch {
    /* leave partially-resolved — encode still resolves per-message at call time */
  }
  rootCache.set(k, root);
  return root;
}

/** Build a skeleton request object (zero/empty values) to guide the user.
 *  Duck-typed, NOT instanceof: grpc-reflection-js bundles its own protobufjs
 *  copy, so `x instanceof protobuf.Type` from our copy is always false. We test
 *  shape instead — a Type has fieldsArray, an Enum has values, a MapField has
 *  keyType. */
function buildTemplate(type: any, depth = 0): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  if (depth > 4 || !type?.fieldsArray) return obj;
  for (const f of type.fieldsArray) {
    if (typeof f.resolve === 'function') f.resolve();
    obj[f.name] = f.keyType ? {} : f.repeated ? [sample(f, depth)] : sample(f, depth);
  }
  return obj;
}
function sample(f: any, depth: number): unknown {
  const rt = f.resolvedType;
  if (rt?.fieldsArray) return buildTemplate(rt, depth + 1); // nested message
  if (rt?.values) return Object.keys(rt.values)[0] ?? 0; // enum → first name
  switch (f.type) {
    case 'string':
      return '';
    case 'bool':
      return false;
    case 'bytes':
      return '';
    default:
      return 0; // all numeric scalar types
  }
}

// small unary caller — mirrors callDirect in grpc.ts but decoupled from CallRequest
const mdToObj = (m?: grpc.Metadata): Record<string, string> => {
  const out: Record<string, string> = {};
  if (m) for (const [k, v] of Object.entries(m.getMap())) out[k] = String(v);
  return out;
};

function unary(
  target: string,
  plaintext: boolean | undefined,
  path: string,
  payload: Buffer,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<
  | { ok: true; resp: Buffer; headers: Record<string, string>; trailers: Record<string, string> }
  | { ok: false; code: number; details: string; trailers: Record<string, string> }
> {
  return new Promise((resolve) => {
    const md = new grpc.Metadata();
    for (const [k, v] of Object.entries(headers ?? {})) {
      if (!v || k === 'content-type' || k === 'x-grpc-web') continue;
      try {
        md.set(k.toLowerCase(), v);
      } catch {
        /* invalid metadata key — skip */
      }
    }
    let respHeaders: Record<string, string> = {};
    let trailers: Record<string, string> = {};
    const client = new grpc.Client(target.trim(), creds(plaintext));
    const call = client.makeUnaryRequest(
      path,
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
        else resolve({ ok: true, resp: resp as Buffer, headers: respHeaders, trailers });
      },
    );
    call.on('metadata', (m) => (respHeaders = mdToObj(m)));
    call.on('status', (s) => (trailers = mdToObj(s.metadata)));
  });
}

export const reflectRoutes = new Hono();

reflectRoutes.post('/reflect', async (c) => {
  const { target, plaintext } = await c.req.json<{ target: string; plaintext?: boolean }>();
  if (!target?.trim()) return c.json({ ok: false, error: 'target host:port required' });
  try {
    const client = new ReflectionClient(target.trim(), creds(plaintext));
    const names = (await client.listServices()) as string[];
    const services = [];
    for (const svc of names.filter((s) => !INTERNAL.test(s))) {
      try {
        const root = await rootForService(target.trim(), plaintext, svc);
        const Svc = root.lookupService(svc);
        const methods = Svc.methodsArray.map((m) => {
          m.resolve();
          const reqType = m.resolvedRequestType;
          return {
            name: m.name,
            path: `/${svc}/${m.name}`,
            requestType: m.requestType,
            responseType: m.responseType,
            requestStream: !!m.requestStream,
            responseStream: !!m.responseStream,
            template: reqType ? JSON.stringify(buildTemplate(reqType), null, 2) : '{}',
          };
        });
        services.push({ service: svc, methods });
      } catch (e: any) {
        services.push({ service: svc, methods: [], error: String(e?.message ?? e) });
      }
    }
    return c.json({ ok: true, services });
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    const hint = /UNIMPLEMENTED|Method not found|not implemented/i.test(msg)
      ? ' — the server does not have gRPC reflection enabled'
      : /UNAVAILABLE|ECONNREFUSED|connect/i.test(msg)
        ? ' — cannot reach the target (check host:port / plaintext-vs-TLS)'
        : '';
    return c.json({ ok: false, error: msg + hint });
  }
});

reflectRoutes.post('/reflect/call', async (c) => {
  const { target, plaintext, service, method, requestJson, headers, timeoutMs } = await c.req.json<{
    target: string;
    plaintext?: boolean;
    service: string;
    method: string;
    requestJson?: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
  }>();
  if (!target?.trim() || !service || !method)
    return c.json({ ok: false, stage: 'encode', error: 'target, service and method are required' });

  let ReqType: protobuf.Type;
  let RespType: protobuf.Type;
  let path: string;
  try {
    const root = await rootForService(target.trim(), plaintext, service);
    const Svc = root.lookupService(service);
    const m = Svc.methods[method];
    if (!m) return c.json({ ok: false, stage: 'encode', error: `method ${method} not found on ${service}` });
    m.resolve();
    if (m.requestStream || m.responseStream)
      return c.json({ ok: false, stage: 'encode', error: 'streaming RPCs are not supported here — unary only' });
    ReqType = root.lookupType(m.resolvedRequestType!.fullName);
    RespType = root.lookupType(m.resolvedResponseType!.fullName);
    path = `/${service}/${method}`;
  } catch (e: any) {
    return c.json({ ok: false, stage: 'encode', error: String(e?.message ?? e) });
  }

  let payload: Buffer;
  try {
    const obj = requestJson?.trim() ? JSON.parse(requestJson) : {};
    const verr = ReqType.verify(obj);
    if (verr) return c.json({ ok: false, stage: 'encode', error: `request does not match ${ReqType.name}: ${verr}` });
    payload = Buffer.from(ReqType.encode(ReqType.fromObject(obj)).finish());
  } catch (e: any) {
    return c.json({ ok: false, stage: 'encode', error: `bad request JSON: ${String(e?.message ?? e)}` });
  }

  const t0 = Date.now();
  const r = await unary(target.trim(), plaintext, path, payload, headers ?? {}, timeoutMs && timeoutMs > 0 ? timeoutMs : 15000);
  const durationMs = Date.now() - t0;

  if (!r.ok)
    return c.json({
      ok: true,
      httpStatus: 200,
      grpcStatus: String(r.code),
      grpcMessage: r.details,
      decoded: '',
      frames: 0,
      rawBytes: 0,
      durationMs,
      reqHeaders: headers,
      trailers: r.trailers,
    });

  let decoded = '';
  try {
    decoded = JSON.stringify(
      RespType.toObject(RespType.decode(r.resp), { enums: String, longs: String, bytes: String, defaults: true }),
      null,
      2,
    );
  } catch (e: any) {
    decoded = `<decode failed: ${String(e?.message ?? e)}>`;
  }
  return c.json({
    ok: true,
    httpStatus: 200,
    grpcStatus: '0',
    grpcMessage: '',
    decoded,
    frames: 1,
    rawBytes: r.resp.length,
    durationMs,
    reqHeaders: headers,
    headers: r.headers,
    trailers: r.trailers,
  });
});
