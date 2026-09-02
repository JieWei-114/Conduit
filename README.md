# conduit

**A local, multi-protocol backend debug console — gRPC, HTTP, DB, Redis,
WebSocket/SSE, Pulsar, Kafka, and an inbound webhook catcher, all in one desktop
window.**

Think of it as a Postman for the things Postman is awkward at: gRPC-Web through a
gateway *and* native gRPC (with server reflection), a type-aware Redis browser,
Pulsar/Kafka produce-consume, an inbound webhook receiver, connectivity
diagnostics, and a codec scratchpad — each pointed at whatever endpoint you give
it.

| Panel | What it does |
|-------|--------------|
| **gRPC** | Two transports in one panel: **Gateway (gRPC-Web)** through Envoy/APISIX like a frontend, or **Direct (native gRPC)** to a host:port. Drive it from local `.proto` files **or from server reflection** (no proto needed — dynamic encode/decode). Request tabs, JWT decode, headers/trailers, history & pins, copy-as-cURL. |
| **HTTP** | REST client, proxied server-side (no CORS): query params, Auth (Bearer/Basic/Raw/OAuth2), body (JSON/raw/form/multipart file upload), cURL import/export, saved requests, JSON-tree responses. Multi-tab. |
| **DB** | Query **PostgreSQL / MySQL / MongoDB / ClickHouse** — SQL (or JSON find/aggregate/command for Mongo), schema browser, query history, CSV/JSON export. Multi-tab. |
| **Redis** | A friendlier `redis-cli`: prefix **drill-down** browser, **type-aware** value editor, **batch command runner** with per-type templates, **PUBLISH/SUBSCRIBE** live feed, **INFO dashboard + key export**. |
| **WS/SSE** | Connect to a **WebSocket** (with headers/subprotocols, proxied so custom headers work) or consume a **Server-Sent-Events** stream. Multi-tab — each tab is an independent live connection. |
| **Pulsar** | Produce/consume over native `pulsar-client` + admin API (topics, stats, subscriptions, peek). Multi-tab consumers sharing one connection. |
| **Kafka** | Produce (key/headers/value) / consume (kafkajs, SASL/SSL), topic listing. Multi-tab consumers sharing one connection. |
| **Webhook** | Turns conduit into a **receiver**: point any caller at your capture URL and watch inbound requests (method/path/headers/body) stream in live. Configurable canned response. |
| **Diag** | Connectivity diagnostics: **TCP** port check, **TLS** certificate (expiry), **DNS** lookup, and a **health board** that polls a list of URLs. |
| **Utils** | Offline codec scratchpad: base64 · hex · URL · JSON format/minify · Unix timestamp ↔ date · cron explainer · UUID. |

## Security model — read this

conduit is a **personal, localhost-only** dev tool. It deliberately does powerful
things: proxies to arbitrary hosts, runs arbitrary SQL / Redis commands, reads
local `.proto` files, and receives inbound HTTP. That's fine **because it binds
`127.0.0.1` only** — it is not reachable from the LAN. (Override with
`CONDUIT_HOST` only if you know what you're doing.)

- It can read **and mutate** real data (DEL keys, PUBLISH, produce, run any SQL).
  Run it for yourself; don't deploy it as a shared service.
- Settings are saved **in plaintext** in `conduit-data.json` on your machine —
  including any tokens/passwords/secrets in connection strings. It's git-ignored;
  don't commit or share it. Wipe via **reset data** in the top bar, or delete the
  file. (Auth credentials are *not* persisted in request-tab state or history —
  only in explicitly saved connections/requests.)

## Run

```bash
pnpm install     # first time (also builds the native pulsar-client binary)
pnpm start       # build UI + serve at http://127.0.0.1:7788
```

Dev mode (hot reload): `pnpm dev` → UI at http://localhost:5188, API proxied to :7788.

Env overrides: `PORT` (default 7788), `CONDUIT_HOST` (default `127.0.0.1`),
`PROTO_ROOT` (default gRPC proto root; defaults to cwd).

The server binds loopback and handles SIGTERM/SIGINT for a graceful shutdown.

## Multi-tab

The **gRPC, HTTP, DB, WS/SSE, Pulsar, and Kafka** panels have Chrome-style tabs
(`+` to add, `✕` to close, above the panel). Each tab is an independent
request/connection; streaming tabs keep running in the background when you switch
away. Request-style panels (HTTP/DB/gRPC) share history/saved items across tabs;
streaming panels (WS/Pulsar/Kafka) keep a per-tab live feed.

## gRPC panel

Pick a transport under **Send via**:

- **Gateway (gRPC-Web)** posts `application/grpc-web+proto` through your gateway
  like a browser frontend (raw JSON → 400). Server-streaming shows each message.
- **Direct (native gRPC)** dials a host:port (local service or
  `kubectl port-forward`) with grpc-js. Unary only.

Two ways to describe the call:

1. **From `.proto` files** — set a **proto repo root** (absolute path), filter +
   pick a proto file, then a Service/Method. Body is **proto text format**
   (`field: "value"`, not JSON); **generate template** scaffolds it. Cross-file
   imports are followed for field hints and templates.
2. **From reflection** (Direct mode) — click **⚡ Reflect services**; conduit
   pulls the service/method list off the server (needs reflection enabled, e.g.
   `tonic-reflection` / gRPC-Java reflection), fills a JSON template, and does
   dynamic encode/decode. The proto pickers hide while reflection drives.

Plus base URL chips, route prefix, headers, inline **JWT decode** (`sub`/`exp`),
request tabs, response history with snapshots + pins, and copy-as-cURL / share
link.

## HTTP panel

Works against anything that speaks HTTP (REST, FastAPI/Flask/Express/Spring,
GraphQL-over-HTTP, webhooks). Proxied through the local server, so CORS never
gets in the way. Query-param table with live URL preview; Auth block
(Bearer/Basic/Raw/OAuth2, shared with gRPC); body as JSON/raw/form/**multipart
file upload**/none; **import/copy cURL**; saved requests; response as a
collapsible **JSON tree** (click a row to copy its path), pretty, or raw.
⌘/Ctrl+Enter to send.

## DB panel

Pick a driver (**PostgreSQL / MySQL / MongoDB / ClickHouse**), paste a connection
URL, write a query, **Run** (⌘/Ctrl+Enter). SQL runs as-is; ClickHouse goes over
its HTTP interface (`:8123`, no driver dep); MongoDB takes JSON —
`{"collection":"users","filter":{},"limit":20}`,
`{"collection":"c","pipeline":[…]}` or `{"command":{…}}`. **list tables** browses
the schema (click to autofill a query); results as a table or JSON, with query
history and CSV/JSON export. Capped at 500 rows.

## Redis panel

Separate **Host / Port / Password / DB** fields (a bare `host:port` or full
`redis://…` is auto-parsed). `ping` to check; `save` named connections as an
environment switcher; idle connections auto-reconnect. **Find keys** — a prefix
browses (drill-down breadcrumb, per-segment counts) or an exact key + Enter opens
instantly (no SCAN). Right side: **Value** (type-aware view/edit for
string/hash/zset/list/set/stream, JSON auto-format, TTL/DEL, big keys paged
500/page), **Commands** (batch runner with per-type template chips), **Pub/Sub**
(PUBLISH + live SUBSCRIBE; `*` → PSUBSCRIBE).

## WS/SSE panel

Toggle **WebSocket** or **SSE** (top-right). WebSocket connects through the
server's WS proxy so you can set **headers** and **subprotocols** the browser
would otherwise forbid; SSE consumes any `text/event-stream` endpoint (with
headers) — receive-only, default `message` events. Each tab is an independent
connection with its own live feed and filter.

## Pulsar panel

Saved connections + **Service URL** (`pulsar://` / `pulsar+ssl://`) + auth
(none/token/oauth2). Optional **Admin URL** → list topics, stats, subscriptions
(clear backlog / delete), and **peek** (read without consuming). Produce
(payload + properties + optional key + delayed delivery) and consume (subscription
name/type/position) into a per-tab live feed.

## Kafka panel

Shared **brokers** (comma-separated) + optional SSL / SASL-plain. **list topics**
fills the picker. Per tab: **Produce** (key + headers + value) and **Consume**
(group id or blank for a throwaway, optional from-beginning) into a live feed
with a connection-state indicator.

## Webhook panel

Copy your **capture URL** (`http://<host>:7788/api/webhook/in/<anything>`) and
point any caller at it — every inbound request (any method, any sub-path) is
captured with method/path/query/headers/body and streamed live. Configure the
canned **response** (status / content-type / body) returned to the caller. Use
your LAN IP instead of localhost if the caller is another machine (and set
`CONDUIT_HOST=0.0.0.0` — see the security note).

## Diag panel

Left-nav tools: **TCP** (open/closed/filtered + latency), **TLS** (subject,
issuer, expiry days with warn/critical coloring, chain trust), **DNS**
(A/AAAA/CNAME/MX), **Health board** (paste URLs → status + latency, optional
10s auto-refresh).

## Utils panel

Offline, no network: base64 · hex · URL encode/decode · JSON format/minify ·
Unix timestamp ↔ date · cron explainer · UUID v4.

## Build a desktop app (.dmg)

```bash
pnpm dist        # → release/conduit-<version>-arm64.dmg
```

Bundles the server (esbuild → CommonJS), the UI (Vite), the Electron runtime, the
native `pulsar-client` (rebuilt for Electron's ABI), and a platform-matched
`protoc` (auto-downloaded to `vendor/protoc` by `predist`) into a `.app`, wrapped
in a `.dmg`. Bump `version` in `package.json` first.

**Install:** open the `.dmg`, drag `conduit` to Applications. Unsigned, so the
first launch needs **right-click → Open** once. Bundled protoc means colleagues
need nothing installed. Targets **Apple Silicon (arm64)**; for Intel/Windows
build with `--x64` / `--win`. Each user points the gRPC proto root at their own
checkout (or uses reflection).

## Put it on GitHub

Source only — `node_modules`, `dist*`, `release/`, `vendor/protoc`, and
`conduit-data.json` are git-ignored.

```bash
git init && git add . && git commit -m "conduit"
gh repo create conduit --private --source=. --push
```

Ship the built `.dmg` via a **GitHub Release** for non-devs.

## Architecture

```
server/
  index.ts       Hono app — loopback bind, global error handler, graceful shutdown,
                 mounts route modules + serves dist/
  grpc.ts        /api/grpc/*        protoc encode/decode; gateway (gRPC-Web) or direct (grpc-js)
  grpc-reflect.ts /api/grpc/reflect* server reflection → protobufjs dynamic encode/decode
  http.ts        /api/http/*        server-side fetch proxy (no CORS)
  db.ts          /api/db/*          pg / mysql2 / mongodb / clickhouse(HTTP) query runner
  kafka.ts       /api/kafka/*       kafkajs produce/consume (SSE) + topics
  redis.ts       /api/redis/*       ioredis: browse, batch cmds, pub/sub, INFO
  pulsar.ts      /api/pulsar/*      pulsar-client produce/consume + admin API
  ws.ts          /api/ws/proxy      WebSocket proxy (header/subprotocol passthrough)
  sse.ts         /api/sse/proxy     Server-Sent-Events passthrough proxy
  webhook.ts     /api/webhook/*     inbound request capture + SSE feed
  diag.ts        /api/diag/*        TCP / TLS / DNS / HTTP-ping (Node net/tls/dns)
  store.ts       /api/store         file-backed settings store (conduit-data.json)
src/
  App.tsx        tab shell (panels stay mounted across switches)
  <X>Panel.tsx   one panel per protocol; AuthBox + JsonTree shared
  types.ts       shared request/response types (front + back)
```

Add a protocol = one `server/<x>.ts` route module + one `<X>Panel.tsx`, mounted
in `server/index.ts` and `App.tsx`.
