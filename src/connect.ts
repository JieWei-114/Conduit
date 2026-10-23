/**
 * A unary call over the Connect protocol: a JSON POST to `/<service>/<method>`, sent through
 * the backend's HTTP proxy. The answer is shaped like a gRPC call's, so the panel shows both
 * the same way.
 */
import type { CallResult } from './types';

/** Connect error codes (`"not_found"`) as gRPC status numbers. */
const CODES: Record<string, string> = {
  canceled: '1', unknown: '2', invalid_argument: '3', deadline_exceeded: '4', not_found: '5',
  already_exists: '6', permission_denied: '7', resource_exhausted: '8', failed_precondition: '9',
  aborted: '10', out_of_range: '11', unimplemented: '12', internal: '13', unavailable: '14',
  data_loss: '15', unauthenticated: '16',
};

/** The HTTP status Connect falls back on when an error body names no code. */
function codeForHttp(status: number): string {
  return { 400: '3', 401: '16', 403: '7', 404: '12', 408: '4', 409: '10', 429: '14', 502: '14', 503: '14', 504: '14' }[status] ?? '2';
}

function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export async function callConnect(opts: {
  /** `http://host:port` */
  base: string;
  service: string;
  method: string;
  body: string;
  headers: Record<string, string>;
  timeoutMs: number;
}): Promise<CallResult> {
  // Connect's own headers replace any the caller typed in another case (`Content-Type`)
  const own = new Set(['content-type', 'connect-protocol-version']);
  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(opts.headers).filter(([k]) => !own.has(k.toLowerCase()))),
    'content-type': 'application/json',
    'connect-protocol-version': '1',
  };
  const r = await fetch('/api/http/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      url: `${opts.base.replace(/\/$/, '')}/${opts.service}/${opts.method}`,
      method: 'POST',
      headers,
      bodyKind: 'raw',
      body: opts.body.trim() || '{}',
      timeoutMs: opts.timeoutMs,
    }),
  }).then((x) => x.json());
  if (!r.ok)
    return {
      ok: false,
      stage: 'network',
      error: `${r.error ?? 'request failed'} — is the server reachable, and does it speak Connect (HTTP/1.1 or HTTP/2 with JSON)?`,
      durationMs: r.durationMs,
    };
  const text: string = r.bodyText ?? '';
  const common = {
    ok: true as const,
    httpStatus: r.status,
    frames: 1,
    rawBytes: r.size ?? text.length,
    durationMs: r.durationMs ?? 0,
    reqHeaders: headers,
    headers: r.headers,
  };
  if (r.status === 200) return { ...common, grpcStatus: '0', grpcMessage: '', decoded: pretty(text) };
  // an error body is {code, message, details: [{type, value, debug?}]}
  let err: { code?: string; message?: string; details?: { type: string; value?: string; debug?: unknown }[] } = {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') err = parsed;
  } catch {
    /* not a Connect error body: the HTTP status speaks for it */
  }
  const grpcStatus = (err.code && CODES[err.code]) || codeForHttp(r.status);
  return {
    ...common,
    frames: 0,
    grpcStatus,
    grpcMessage: err.message ?? (text.slice(0, 300) || `HTTP ${r.status}`),
    decoded: '',
    statusDetails: err.details?.length
      ? {
          code: Number(grpcStatus),
          message: err.message ?? '',
          details: err.details.map((d) => ({ type: d.type, value: d.debug ?? d.value })),
        }
      : null,
  };
}
