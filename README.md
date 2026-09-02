# conduit

**A local, multi-protocol backend debug console.** Native and gateway gRPC, HTTP,
SQL/NoSQL databases, Redis, Pulsar, Kafka, WebSocket/SSE, an inbound webhook
catcher, connectivity diagnostics, and an offline codec scratchpad — each pointed
at whatever endpoint you give it, all in one desktop window. Think of it as a
Postman for the things Postman is awkward at.

| Panel | What it does |
|-------|--------------|
| **gRPC** | Gateway (gRPC-Web) through Envoy/APISIX, or direct native gRPC to a host:port. Driven from local `.proto` files or from server reflection (no proto needed). Request tabs, JWT decode, headers/trailers, history & pins, copy-as-cURL. |
| **HTTP** | REST client proxied server-side (no CORS): query params, Auth (Bearer/Basic/Raw/OAuth2), body (JSON/raw/form/multipart), cURL import/export, saved requests, JSON-tree responses. |
| **DB** | PostgreSQL / MySQL / MongoDB / ClickHouse — SQL (or JSON for Mongo), schema browser, query history, CSV/JSON export. |
| **Redis** | Prefix drill-down browser, type-aware value editor, batch command runner, PUBLISH/SUBSCRIBE live feed, INFO dashboard, key export. |
| **WS/SSE** | Connect to a WebSocket (custom headers/subprotocols via proxy) or consume a Server-Sent-Events stream. Each tab is an independent live connection. |
| **Pulsar** | Produce/consume over native `pulsar-client` plus admin API (topics, stats, subscriptions, peek). |
| **Kafka** | Produce (key/headers/value) and consume (kafkajs, SASL/SSL), with topic listing. |
| **Webhook** | Turns conduit into a receiver: point any caller at your capture URL and watch inbound requests stream in live, with a configurable canned response. |
| **Diag** | Connectivity diagnostics: TCP port check, TLS certificate expiry, DNS lookup, and a health board that polls a list of URLs. |
| **Utils** | Offline codec scratchpad: base64 · hex · URL · JSON format/minify · Unix timestamp ↔ date · cron explainer · UUID. |

## Quick start

```bash
pnpm install     # first run also builds the native pulsar-client binary
pnpm start       # build UI + serve at http://127.0.0.1:7788
pnpm dev         # hot reload — UI at http://localhost:5188, API proxied to :7788
```

Environment overrides: `PORT` (default `7788`), `CONDUIT_HOST` (default
`127.0.0.1`), `PROTO_ROOT` (gRPC proto root, defaults to cwd). The server binds
loopback and handles SIGTERM/SIGINT for a graceful shutdown.

## Security model

conduit is a **personal, localhost-only** tool. It deliberately does powerful
things — proxies to arbitrary hosts, runs arbitrary SQL and Redis commands, reads
local `.proto` files, and accepts inbound HTTP — which is safe **only because it
binds `127.0.0.1`** and is not reachable from the LAN. Override `CONDUIT_HOST`
only if you understand the exposure.

- It can read **and mutate** real data (DEL keys, PUBLISH, produce, run any SQL).
  Run it for yourself; do not deploy it as a shared service.
- Settings are stored **in plaintext** in `conduit-data.json`, including any
  secrets in connection strings. The file is git-ignored — don't commit or share
  it. Wipe it via **reset data** in the top bar or by deleting the file. Auth
  credentials live only in explicitly saved connections/requests, never in
  request-tab state or history.

## Panels

The **gRPC, HTTP, DB, WS/SSE, Pulsar, and Kafka** panels use Chrome-style tabs
(`+` / `✕` above the panel). Each tab is an independent request or connection;
streaming tabs keep running in the background when you switch away. Request
panels (HTTP/DB/gRPC) share history and saved items across tabs; streaming panels
(WS/Pulsar/Kafka) keep a per-tab live feed.

### gRPC

Pick a transport under **Send via**:

- **Gateway (gRPC-Web)** posts `application/grpc-web+proto` through your gateway
  like a browser frontend; server-streaming shows each message.
- **Direct (native gRPC)** dials a host:port (local service or
  `kubectl port-forward`) with grpc-js. Unary only.

Describe the call two ways:

1. **From `.proto` files** — set an absolute **proto repo root**, filter and pick
   a proto file, then a Service/Method. Body is proto text format
   (`field: "value"`, not JSON); **generate template** scaffolds it, following
   cross-file imports for field hints.
2. **From reflection** (Direct mode) — click **⚡ Reflect services**; conduit
   pulls the service/method list off the server (reflection must be enabled,
   e.g. `tonic-reflection` or gRPC-Java reflection), fills a JSON template, and
   does dynamic encode/decode.

Plus base-URL chips, route prefix, headers, inline JWT decode (`sub`/`exp`),
response history with snapshots and pins, and copy-as-cURL / share link.

### HTTP

Works against anything that speaks HTTP (REST, FastAPI/Flask/Express/Spring,
GraphQL-over-HTTP, webhooks), proxied through the local server so CORS never gets
in the way. Query-param table with live URL preview; Auth block shared with gRPC;
body as JSON/raw/form/multipart file upload/none; import/copy cURL; saved
requests; response as a collapsible JSON tree (click a row to copy its path),
pretty, or raw. ⌘/Ctrl+Enter to send.

### DB

Pick a driver, paste a connection URL, write a query, **Run** (⌘/Ctrl+Enter). SQL
runs as-is; ClickHouse goes over its HTTP interface (`:8123`, no driver dep);
MongoDB takes JSON — `{"collection":"users","filter":{},"limit":20}`,
`{"collection":"c","pipeline":[…]}`, or `{"command":{…}}`. **list tables** browses
the schema (click to autofill); results render as a table or JSON, with query
history and CSV/JSON export. Capped at 500 rows.

### Redis

Separate **Host / Port / Password / DB** fields (a bare `host:port` or full
`redis://…` is auto-parsed); `ping` to check, `save` named connections as an
environment switcher, idle connections auto-reconnect. **Find keys** by prefix
(drill-down breadcrumb with per-segment counts) or by exact key + Enter (no SCAN).
Right side: **Value** (type-aware view/edit for string/hash/zset/list/set/stream,
JSON auto-format, TTL/DEL, big keys paged 500/page), **Commands** (batch runner
with per-type template chips), and **Pub/Sub** (PUBLISH plus live SUBSCRIBE; `*` →
PSUBSCRIBE).

### WS/SSE

Toggle **WebSocket** or **SSE** (top-right). WebSocket connects through the
server's proxy so you can set headers and subprotocols the browser would
otherwise forbid; SSE consumes any `text/event-stream` endpoint (receive-only,
default `message` events). Each tab is an independent connection with its own feed
and filter.

### Pulsar

Saved connections plus **Service URL** (`pulsar://` / `pulsar+ssl://`) and auth
(none/token/oauth2). An optional **Admin URL** lists topics, stats, and
subscriptions (clear backlog / delete) and supports **peek** (read without
consuming). Produce (payload + properties + optional key + delayed delivery) and
consume (subscription name/type/position) into a per-tab live feed.

### Kafka

Shared **brokers** (comma-separated) plus optional SSL / SASL-plain. **list
topics** fills the picker. Per tab: **Produce** (key + headers + value) and
**Consume** (group id, or blank for a throwaway; optional from-beginning) into a
live feed with a connection-state indicator.

### Webhook

Copy your **capture URL** (`http://<host>:7788/api/webhook/in/<anything>`) and
point any caller at it — every inbound request (any method, any sub-path) is
captured with method/path/query/headers/body and streamed live. Configure the
canned **response** (status / content-type / body) returned to the caller. Use
your LAN IP and set `CONDUIT_HOST=0.0.0.0` if the caller is another machine (see
the security model).

### Diag

Left-nav tools: **TCP** (open/closed/filtered + latency), **TLS** (subject,
issuer, expiry with warn/critical coloring, chain trust), **DNS**
(A/AAAA/CNAME/MX), and a **Health board** (paste URLs → status + latency, with
optional 10s auto-refresh).

### Utils

Offline, no network: base64 · hex · URL encode/decode · JSON format/minify · Unix
timestamp ↔ date · cron explainer · UUID v4.

## Desktop app

```bash
pnpm dist        # → release/conduit-<version>-arm64.dmg
```

Bundles the server (esbuild → CommonJS), the UI (Vite), the Electron runtime, the
native `pulsar-client` (rebuilt for Electron's ABI), and a platform-matched
`protoc` (auto-downloaded to `vendor/protoc` by `predist`) into a `.app` wrapped
in a `.dmg`. Bump `version` in `package.json` first, and drop a `build/icon.icns`
to set the app icon.

**Install:** open the `.dmg`, drag `conduit` to Applications. It is unsigned, so
the first launch needs **right-click → Open** once. Bundled protoc means
colleagues need nothing installed. Builds target Apple Silicon (arm64); use
`--x64` / `--win` for Intel/Windows. Each user points the gRPC proto root at
their own checkout (or uses reflection). Ship the `.dmg` via a GitHub Release for
non-developers.

## Architecture

```
server/
  index.ts        Hono app — loopback bind, global error handler, graceful shutdown, serves dist/
  grpc.ts         /api/grpc/*         protoc encode/decode; gateway (gRPC-Web) or direct (grpc-js)
  grpc-reflect.ts /api/grpc/reflect*  server reflection → protobufjs dynamic encode/decode
  http.ts         /api/http/*         server-side fetch proxy (no CORS)
  db.ts           /api/db/*           pg / mysql2 / mongodb / clickhouse (HTTP) query runner
  kafka.ts        /api/kafka/*        kafkajs produce/consume (SSE) + topics
  redis.ts        /api/redis/*        ioredis: browse, batch cmds, pub/sub, INFO
  pulsar.ts       /api/pulsar/*       pulsar-client produce/consume + admin API
  ws.ts           /api/ws/proxy       WebSocket proxy (header/subprotocol passthrough)
  sse.ts          /api/sse/proxy      Server-Sent-Events passthrough proxy
  webhook.ts      /api/webhook/*      inbound request capture + SSE feed
  diag.ts         /api/diag/*         TCP / TLS / DNS / HTTP-ping (Node net/tls/dns)
  store.ts        /api/store          file-backed settings store (conduit-data.json)
src/
  App.tsx         tab shell (panels stay mounted across switches)
  <X>Panel.tsx    one panel per protocol; AuthBox + JsonTree shared
  types.ts        shared request/response types (front + back)
```

Adding a protocol = one `server/<x>.ts` route module + one `<X>Panel.tsx`,
mounted in `server/index.ts` and `App.tsx`.
