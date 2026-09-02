export interface RpcDef {
  method: string;
  req: string;
  res: string;
}

export interface ServiceDef {
  service: string;
  rpcs: RpcDef[];
}

export interface FieldDef {
  name: string;
  type: string;
  repeated: boolean;
  comment: string;
}

export interface MessageDef {
  name: string;
  fields: FieldDef[];
}

export interface EnumDef {
  name: string;
  values: string[];
}

export interface ProtoInfo {
  pkg: string;
  services: ServiceDef[];
  messages: MessageDef[];
  enums: EnumDef[];
}

export interface CallRequest {
  url: string;
  /** proto repo root directory (absolute path, protoc -I root) */
  root: string;
  /** proto file path relative to root */
  proto: string;
  /** fully-qualified request message type, e.g. mypackage.v1.XxxReq */
  reqType: string;
  resType: string;
  /** proto text-format body */
  textBody: string;
  headers: Record<string, string>;
  /** abort the call after this many ms (default 15000) */
  timeoutMs?: number;
  /** gateway = gRPC-Web POST to `url`; direct = native gRPC to `target` */
  transport?: 'gateway' | 'direct';
  /** direct mode: host:port of the gRPC server */
  target?: string;
  /** direct mode: no TLS (typical for internal ports) */
  plaintext?: boolean;
  /** direct mode: "/pkg.Service/Method" call path */
  grpcPath?: string;
}

export type CallResult =
  | {
      ok: true;
      httpStatus: number;
      grpcStatus: string;
      grpcMessage: string;
      decoded: string;
      /** number of data frames (streaming responses return > 1) */
      frames: number;
      rawBytes: number;
      durationMs: number;
      /** request headers conduit actually sent (before gateway/CDN injection) */
      reqHeaders?: Record<string, string>;
      /** all response headers */
      headers?: Record<string, string>;
      /** parsed gRPC trailers (grpc-status/message + custom) */
      trailers?: Record<string, string>;
    }
  | {
      ok: false;
      stage: 'encode' | 'network' | 'gateway' | 'timeout';
      httpStatus?: number;
      error: string;
      durationMs?: number;
    };

export interface HistoryEntry {
  at: string; // ISO time
  rpc: string;
  url: string;
  body: string;
  proto: string;
  root: string;
  grpcStatus: string;
  httpStatus?: number;
  ok: boolean;
  durationMs?: number;
  /** snapshot of what came back, so history can be reviewed without re-sending.
   *  `text` is the decoded response (or the error text) truncated to ~20 KB. */
  response?: {
    ok: boolean;
    text: string;
    truncated: boolean;
    grpcStatus: string;
    grpcMessage?: string;
    httpStatus?: number;
    durationMs?: number;
    frames?: number;
  };
}

// ─────────────────────────────── Redis ──────────────────────────────────────

export type RedisType =
  | 'string'
  | 'hash'
  | 'zset'
  | 'list'
  | 'set'
  | 'stream'
  | 'none';

export interface RedisKeyView {
  key: string;
  type: RedisType;
  ttl: number; // seconds, -1 = no expiry, -2 = missing
  /** shape depends on type: string→string, hash→[field,val][], zset→[member,score][], list/set→string[] */
  value: unknown;
  /** true member count — `value` holds ~500 elements per page */
  total?: number;
  /** pass back to /get to fetch the next page; null/absent = no more */
  nextCursor?: string | null;
}

export interface RedisScanResult {
  cursor: string;
  keys: { key: string; type: RedisType }[];
}

export interface RedisConnConfig {
  name: string;
  /** full connection string (redis://[:pass@]host:port[/db]) OR host */
  url: string;
}

// ─────────────────────────────── Pulsar ─────────────────────────────────────

export interface PulsarConnConfig {
  name: string;
  serviceUrl: string; // pulsar:// or pulsar+ssl://
  authType: 'none' | 'token' | 'oauth2';
  token?: string;
  oauth?: {
    issuerUrl: string;
    clientId: string;
    clientSecret: string;
    audience: string;
  };
}

export interface PulsarMessageOut {
  topic: string;
  payload: string; // JSON or plain text
  properties?: Record<string, string>;
}

export interface PulsarMessageIn {
  at: string;
  messageId: string;
  publishTime: number;
  properties: Record<string, string>;
  payload: string;
}
