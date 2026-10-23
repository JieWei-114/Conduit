// New Cargo deps: tonic = { version = "0.12", features = ["tls", "tls-roots"] }, tonic-reflection = "0.12", prost = "0.13", prost-reflect = { version = "0.14", features = ["serde"] }, prost-types = "0.13", bytes = "1", http = "1"
use std::collections::{HashMap, HashSet};
use std::time::Instant;

use axum::{routing::post, Json, Router};
use bytes::{Buf, BufMut};
use prost::Message as _;
use prost_reflect::{DescriptorPool, DynamicMessage, Kind, MessageDescriptor, SerializeOptions};
use prost_types::FileDescriptorProto;
use serde::Deserialize;
use serde_json::{json, Value};
use tonic::codec::{Codec, DecodeBuf, Decoder, EncodeBuf, Encoder};
use tonic::{Request, Status};

use tonic_reflection::pb::v1::server_reflection_client::ServerReflectionClient as V1Client;
use tonic_reflection::pb::v1::server_reflection_request::MessageRequest as V1Req;
use tonic_reflection::pb::v1::server_reflection_response::MessageResponse as V1Resp;
use tonic_reflection::pb::v1::ServerReflectionRequest as V1Request;
use tonic_reflection::pb::v1alpha::server_reflection_client::ServerReflectionClient as AlphaClient;
use tonic_reflection::pb::v1alpha::server_reflection_request::MessageRequest as AlphaReq;
use tonic_reflection::pb::v1alpha::server_reflection_response::MessageResponse as AlphaResp;
use tonic_reflection::pb::v1alpha::ServerReflectionRequest as AlphaRequest;

pub fn routes() -> Router {
    Router::new()
        .route("/reflect", post(reflect))
        .route("/reflect/call", post(reflect_call))
        .route("/health", post(health))
}

fn is_internal(name: &str) -> bool {
    name.starts_with("grpc.reflection.")
        || name.starts_with("grpc.health.")
        || name.starts_with("grpc.channelz.")
}

fn endpoint_uri(target: &str, plaintext: Option<bool>) -> String {
    let t = target.trim();
    let scheme = if plaintext == Some(false) { "https" } else { "http" };
    if t.starts_with("http://") || t.starts_with("https://") {
        t.to_string()
    } else {
        format!("{scheme}://{t}")
    }
}

async fn connect(target: &str, plaintext: Option<bool>) -> Result<tonic::transport::Channel, String> {
    let uri = endpoint_uri(target, plaintext);
    let mut ep = tonic::transport::Channel::from_shared(uri).map_err(|e| e.to_string())?;
    if plaintext == Some(false) {
        ep = ep
            .tls_config(tonic::transport::ClientTlsConfig::new().with_native_roots())
            .map_err(|e| e.to_string())?;
    }
    // a host that never answers would otherwise hold the request for the OS connect timeout
    ep.connect_timeout(std::time::Duration::from_secs(8))
        .connect()
        .await
        .map_err(|e| with_causes(&e))
}

/// `e` and every error under it: tonic's own text is only "transport error", the reason
/// (refused, timed out, no such host) is in its sources.
fn with_causes(e: &dyn std::error::Error) -> String {
    let mut out = e.to_string();
    let mut source = e.source();
    while let Some(s) = source {
        let text = s.to_string();
        if !out.contains(&text) {
            out.push_str(": ");
            out.push_str(&text);
        }
        source = s.source();
    }
    out
}

enum ReflectItem {
    Files(Vec<Vec<u8>>),
    Services(Vec<String>),
    Error(String),
}

async fn reflect_query(
    channel: tonic::transport::Channel,
    req: V1Req,
) -> Result<ReflectItem, String> {
    match reflect_query_v1(channel.clone(), req.clone()).await {
        Ok(item) => Ok(item),
        Err(e) if is_unimplemented(&e) => reflect_query_alpha(channel, to_alpha(req)).await,
        Err(e) => Err(e),
    }
}

fn is_unimplemented(msg: &str) -> bool {
    let m = msg.to_lowercase();
    m.contains("unimplemented") || m.contains("not found") || m.contains("not implemented")
}

fn to_alpha(req: V1Req) -> AlphaReq {
    match req {
        V1Req::FileByFilename(s) => AlphaReq::FileByFilename(s),
        V1Req::FileContainingSymbol(s) => AlphaReq::FileContainingSymbol(s),
        V1Req::ListServices(s) => AlphaReq::ListServices(s),
        V1Req::AllExtensionNumbersOfType(s) => AlphaReq::AllExtensionNumbersOfType(s),
        V1Req::FileContainingExtension(e) => {
            AlphaReq::FileContainingExtension(tonic_reflection::pb::v1alpha::ExtensionRequest {
                containing_type: e.containing_type,
                extension_number: e.extension_number,
            })
        }
    }
}

async fn reflect_query_v1(
    channel: tonic::transport::Channel,
    req: V1Req,
) -> Result<ReflectItem, String> {
    let mut client = V1Client::new(channel);
    let request = V1Request {
        host: String::new(),
        message_request: Some(req),
    };
    let stream = tokio_stream::iter(vec![request]);
    let resp = client
        .server_reflection_info(Request::new(stream))
        .await
        .map_err(|s| status_string(&s))?;
    let mut inbound = resp.into_inner();
    while let Some(msg) = inbound.message().await.map_err(|s| status_string(&s))? {
        match msg.message_response {
            Some(V1Resp::FileDescriptorResponse(f)) => {
                return Ok(ReflectItem::Files(f.file_descriptor_proto))
            }
            Some(V1Resp::ListServicesResponse(l)) => {
                return Ok(ReflectItem::Services(l.service.into_iter().map(|s| s.name).collect()))
            }
            Some(V1Resp::ErrorResponse(e)) => {
                return Ok(ReflectItem::Error(format!("{}: {}", e.error_code, e.error_message)))
            }
            _ => continue,
        }
    }
    Err("empty reflection response".into())
}

async fn reflect_query_alpha(
    channel: tonic::transport::Channel,
    req: AlphaReq,
) -> Result<ReflectItem, String> {
    let mut client = AlphaClient::new(channel);
    let request = AlphaRequest {
        host: String::new(),
        message_request: Some(req),
    };
    let stream = tokio_stream::iter(vec![request]);
    let resp = client
        .server_reflection_info(Request::new(stream))
        .await
        .map_err(|s| status_string(&s))?;
    let mut inbound = resp.into_inner();
    while let Some(msg) = inbound.message().await.map_err(|s| status_string(&s))? {
        match msg.message_response {
            Some(AlphaResp::FileDescriptorResponse(f)) => {
                return Ok(ReflectItem::Files(f.file_descriptor_proto))
            }
            Some(AlphaResp::ListServicesResponse(l)) => {
                return Ok(ReflectItem::Services(l.service.into_iter().map(|s| s.name).collect()))
            }
            Some(AlphaResp::ErrorResponse(e)) => {
                return Ok(ReflectItem::Error(format!("{}: {}", e.error_code, e.error_message)))
            }
            _ => continue,
        }
    }
    Err("empty reflection response".into())
}

fn status_string(s: &Status) -> String {
    format!("{:?}: {}", s.code(), s.message())
}

async fn collect_pool(
    channel: &tonic::transport::Channel,
    symbol: &str,
) -> Result<DescriptorPool, String> {
    let mut by_name: HashMap<String, FileDescriptorProto> = HashMap::new();
    let mut pending: HashSet<String> = HashSet::new();

    let first = reflect_query(channel.clone(), V1Req::FileContainingSymbol(symbol.to_string())).await?;
    ingest(first, &mut by_name, &mut pending)?;

    let mut guard = 0;
    while !pending.is_empty() && guard < 512 {
        guard += 1;
        let name = pending.iter().next().cloned().unwrap();
        pending.remove(&name);
        if by_name.contains_key(&name) {
            continue;
        }
        let item = reflect_query(channel.clone(), V1Req::FileByFilename(name.clone())).await?;
        ingest(item, &mut by_name, &mut pending)?;
    }

    let mut pool = DescriptorPool::new();
    let files: Vec<FileDescriptorProto> = by_name.into_values().collect();
    pool.add_file_descriptor_protos(files).map_err(|e| e.to_string())?;
    Ok(pool)
}

fn ingest(
    item: ReflectItem,
    by_name: &mut HashMap<String, FileDescriptorProto>,
    pending: &mut HashSet<String>,
) -> Result<(), String> {
    match item {
        ReflectItem::Files(raw) => {
            for bytes in raw {
                let fdp = FileDescriptorProto::decode(bytes.as_slice()).map_err(|e| e.to_string())?;
                let name = fdp.name().to_string();
                for dep in &fdp.dependency {
                    if !by_name.contains_key(dep) {
                        pending.insert(dep.clone());
                    }
                }
                by_name.insert(name, fdp);
            }
            Ok(())
        }
        ReflectItem::Error(e) => Err(e),
        ReflectItem::Services(_) => Ok(()),
    }
}

fn build_template(md: &MessageDescriptor, depth: usize) -> Value {
    let mut obj = serde_json::Map::new();
    if depth > 4 {
        return Value::Object(obj);
    }
    for f in md.fields() {
        let v = if f.is_map() {
            json!({})
        } else if f.is_list() {
            Value::Array(vec![sample(&f.kind(), depth)])
        } else {
            sample(&f.kind(), depth)
        };
        obj.insert(f.name().to_string(), v);
    }
    Value::Object(obj)
}

fn sample(kind: &Kind, depth: usize) -> Value {
    match kind {
        Kind::Message(m) => build_template(m, depth + 1),
        Kind::Enum(e) => e
            .values()
            .next()
            .map(|v| Value::String(v.name().to_string()))
            .unwrap_or_else(|| json!(0)),
        Kind::String | Kind::Bytes => Value::String(String::new()),
        Kind::Bool => Value::Bool(false),
        _ => json!(0),
    }
}

#[derive(Deserialize)]
struct ReflectReq {
    target: Option<String>,
    plaintext: Option<bool>,
}

async fn reflect(Json(req): Json<ReflectReq>) -> Json<Value> {
    let target = req.target.unwrap_or_default();
    if target.trim().is_empty() {
        return Json(json!({ "ok": false, "error": "target host:port required" }));
    }
    let channel = match connect(&target, req.plaintext).await {
        Ok(c) => c,
        Err(e) => return Json(json!({ "ok": false, "error": hint(&e) })),
    };

    let names = match reflect_query(channel.clone(), V1Req::ListServices(String::new())).await {
        Ok(ReflectItem::Services(n)) => n,
        Ok(ReflectItem::Error(e)) => return Json(json!({ "ok": false, "error": hint(&e) })),
        Ok(_) => return Json(json!({ "ok": false, "error": "unexpected reflection response" })),
        Err(e) => return Json(json!({ "ok": false, "error": hint(&e) })),
    };

    let mut services = Vec::new();
    for svc in names.into_iter().filter(|s| !is_internal(s)) {
        match collect_pool(&channel, &svc).await {
            Ok(pool) => match pool.get_service_by_name(&svc) {
                Some(sd) => {
                    let methods: Vec<Value> = sd
                        .methods()
                        .map(|m| {
                            let input = m.input();
                            let template = serde_json::to_string_pretty(&build_template(&input, 0))
                                .unwrap_or_else(|_| "{}".into());
                            json!({
                                "name": m.name(),
                                "path": format!("/{}/{}", svc, m.name()),
                                "requestType": input.full_name(),
                                "responseType": m.output().full_name(),
                                "requestStream": m.is_client_streaming(),
                                "responseStream": m.is_server_streaming(),
                                "template": template,
                            })
                        })
                        .collect();
                    services.push(json!({ "service": svc, "methods": methods }));
                }
                None => services.push(json!({ "service": svc, "methods": [], "error": "service not found in descriptors" })),
            },
            Err(e) => services.push(json!({ "service": svc, "methods": [], "error": e })),
        }
    }

    Json(json!({ "ok": true, "services": services }))
}

fn hint(msg: &str) -> String {
    let m = msg.to_lowercase();
    if is_unimplemented(msg) {
        format!("{msg} — the server does not have gRPC reflection enabled")
    } else if m.contains("unavailable") || m.contains("connect") || m.contains("refused") || m.contains("transport error") {
        format!("{msg} — cannot reach the target (check host:port / plaintext-vs-TLS)")
    } else {
        msg.to_string()
    }
}

#[derive(Clone, Default)]
struct BytesCodec;

impl Codec for BytesCodec {
    type Encode = Vec<u8>;
    type Decode = Vec<u8>;
    type Encoder = BytesCodec;
    type Decoder = BytesCodec;
    fn encoder(&mut self) -> Self::Encoder {
        BytesCodec
    }
    fn decoder(&mut self) -> Self::Decoder {
        BytesCodec
    }
}

impl Encoder for BytesCodec {
    type Item = Vec<u8>;
    type Error = Status;
    fn encode(&mut self, item: Self::Item, dst: &mut EncodeBuf<'_>) -> Result<(), Self::Error> {
        dst.put_slice(&item);
        Ok(())
    }
}

impl Decoder for BytesCodec {
    type Item = Vec<u8>;
    type Error = Status;
    fn decode(&mut self, src: &mut DecodeBuf<'_>) -> Result<Option<Self::Item>, Self::Error> {
        let mut out = vec![0u8; src.remaining()];
        src.copy_to_slice(&mut out);
        Ok(Some(out))
    }
}

struct UnaryOk {
    resp: Vec<u8>,
    headers: HashMap<String, String>,
    trailers: HashMap<String, String>,
}

struct UnaryErr {
    code: i32,
    details: String,
    trailers: HashMap<String, String>,
    /// `grpc-status-details-bin`, when the server attached a `google.rpc.Status`.
    status_bin: Vec<u8>,
}

impl UnaryErr {
    fn new(code: i32, details: impl Into<String>) -> Self {
        Self {
            code,
            details: details.into(),
            trailers: HashMap::new(),
            status_bin: Vec::new(),
        }
    }

    fn from_status(status: &Status) -> Self {
        Self {
            code: status.code() as i32,
            details: if status.message().is_empty() {
                format!("{:?}", status.code())
            } else {
                status.message().to_string()
            },
            trailers: md_to_map(status.metadata()),
            status_bin: status.details().to_vec(),
        }
    }
}

/// The messages of a server-streaming call, with its headers and trailers.
struct StreamOk {
    messages: Vec<Vec<u8>>,
    headers: HashMap<String, String>,
    trailers: HashMap<String, String>,
    /// Why the stream was cut short, when it was: a cap, or the deadline on an open stream.
    note: Option<String>,
}

/// More messages, or more bytes, than any interactive look needs; the rest is dropped.
const STREAM_MAX: usize = 500;
const STREAM_MAX_BYTES: usize = 8 * 1024 * 1024;

fn md_to_map(md: &tonic::metadata::MetadataMap) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for kv in md.iter() {
        if let tonic::metadata::KeyAndValueRef::Ascii(k, v) = kv {
            if let Ok(v) = v.to_str() {
                out.insert(k.as_str().to_string(), v.to_string());
            }
        }
    }
    out
}

/// A request carrying `payload`, the caller's headers as metadata, and the deadline.
fn build_request(
    payload: Vec<u8>,
    headers: &HashMap<String, String>,
    timeout_ms: u64,
) -> Request<Vec<u8>> {
    let mut request = Request::new(payload);
    for (k, v) in headers {
        let lk = k.to_lowercase();
        if v.is_empty() || lk == "content-type" || lk == "x-grpc-web" {
            continue;
        }
        if let (Ok(key), Ok(val)) = (
            tonic::metadata::MetadataKey::from_bytes(lk.as_bytes()),
            tonic::metadata::MetadataValue::try_from(v.as_str()),
        ) {
            request.metadata_mut().insert(key, val);
        }
    }
    request.set_timeout(std::time::Duration::from_millis(timeout_ms));
    request
}

/// A ready client and the call path.
async fn client(
    channel: tonic::transport::Channel,
    path: &str,
) -> Result<
    (
        tonic::client::Grpc<tonic::transport::Channel>,
        http::uri::PathAndQuery,
    ),
    UnaryErr,
> {
    let mut grpc = tonic::client::Grpc::new(channel);
    grpc.ready()
        .await
        .map_err(|e| UnaryErr::new(14, e.to_string()))?;
    // `from_maybe_shared` requires `'static`, and `path` is a borrowed `&str`,
    // so the allocation is load-bearing. Clippy does not weigh that bound and
    // suggests passing the reference, which does not compile.
    #[allow(clippy::unnecessary_to_owned)]
    let path = http::uri::PathAndQuery::from_maybe_shared(path.to_string())
        .map_err(|e| UnaryErr::new(3, e.to_string()))?;
    Ok((grpc, path))
}

async fn unary(
    channel: tonic::transport::Channel,
    path: &str,
    payload: Vec<u8>,
    headers: &HashMap<String, String>,
    timeout_ms: u64,
) -> Result<UnaryOk, UnaryErr> {
    let (mut grpc, path) = client(channel, path).await?;
    let request = build_request(payload, headers, timeout_ms);
    // the deadline is also sent to the server, but one that ignores it must not hold the call open
    let call = grpc.unary(request, path, BytesCodec);
    let Ok(answer) = tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), call).await else {
        return Err(UnaryErr::new(4, format!("no answer within {timeout_ms} ms (Conduit's timeout)")));
    };
    match answer {
        Ok(resp) => {
            let headers = md_to_map(resp.metadata());
            Ok(UnaryOk {
                resp: resp.into_inner(),
                headers,
                trailers: HashMap::new(),
            })
        }
        Err(status) => Err(UnaryErr::from_status(&status)),
    }
}

/// A server-streaming call: every message until the stream ends, up to `STREAM_MAX`. The
/// deadline covers the whole stream.
async fn server_stream(
    channel: tonic::transport::Channel,
    path: &str,
    payload: Vec<u8>,
    headers: &HashMap<String, String>,
    timeout_ms: u64,
) -> Result<StreamOk, UnaryErr> {
    let (mut grpc, path) = client(channel, path).await?;
    let request = build_request(payload, headers, timeout_ms);
    // the deadline is also sent to the server, but one that ignores it must not hold the call open
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
    let resp = tokio::time::timeout_at(deadline, grpc.server_streaming(request, path, BytesCodec))
        .await
        .map_err(|_| UnaryErr::new(4, format!("no answer within {timeout_ms} ms (Conduit's timeout)")))?
        .map_err(|s| UnaryErr::from_status(&s))?;
    let headers = md_to_map(resp.metadata());
    let mut stream = resp.into_inner();
    let mut messages: Vec<Vec<u8>> = Vec::new();
    let mut bytes = 0;
    loop {
        if messages.len() >= STREAM_MAX || bytes >= STREAM_MAX_BYTES {
            // stop reading: asking for the trailers would wait for the rest of the stream
            let note = format!(
                "stopped after {} messages ({} KB); the stream had more",
                messages.len(),
                bytes / 1024
            );
            return Ok(StreamOk {
                messages,
                headers,
                trailers: HashMap::new(),
                note: Some(note),
            });
        }
        let Ok(next) = tokio::time::timeout_at(deadline, stream.message()).await else {
            if messages.is_empty() {
                return Err(UnaryErr::new(4, format!("no message within {timeout_ms} ms (Conduit's timeout)")));
            }
            let note = format!(
                "stopped at the {timeout_ms} ms timeout with the stream still open; showing the {} message(s) received",
                messages.len()
            );
            return Ok(StreamOk { messages, headers, trailers: HashMap::new(), note: Some(note) });
        };
        match next {
            Ok(Some(m)) => {
                bytes += m.len();
                messages.push(m);
            }
            Ok(None) => break,
            // a stream that stays open (watch / subscribe) ends at the deadline: keep what came
            Err(status)
                if !messages.is_empty()
                    && matches!(
                        status.code(),
                        tonic::Code::DeadlineExceeded | tonic::Code::Cancelled
                    ) =>
            {
                let note = format!(
                    "the stream was still open at the timeout; showing the {} message(s) received",
                    messages.len()
                );
                return Ok(StreamOk {
                    messages,
                    headers,
                    trailers: HashMap::new(),
                    note: Some(note),
                });
            }
            Err(status) => {
                let mut err = UnaryErr::from_status(&status);
                err.details = format!("{} (after {} message(s))", err.details, messages.len());
                return Err(err);
            }
        }
    }
    let trailers = match stream.trailers().await {
        Ok(Some(md)) => md_to_map(&md),
        _ => HashMap::new(),
    };
    Ok(StreamOk {
        messages,
        headers,
        trailers,
        note: None,
    })
}

#[derive(Deserialize)]
struct CallReq {
    target: Option<String>,
    plaintext: Option<bool>,
    service: Option<String>,
    method: Option<String>,
    #[serde(rename = "requestJson")]
    request_json: Option<String>,
    headers: Option<HashMap<String, String>>,
    #[serde(rename = "timeoutMs")]
    timeout_ms: Option<u64>,
}

async fn reflect_call(Json(req): Json<CallReq>) -> Json<Value> {
    let target = req.target.unwrap_or_default();
    let service = req.service.unwrap_or_default();
    let method = req.method.unwrap_or_default();
    if target.trim().is_empty() || service.is_empty() || method.is_empty() {
        return Json(json!({ "ok": false, "stage": "encode", "error": "target, service and method are required" }));
    }

    let channel = match connect(&target, req.plaintext).await {
        Ok(c) => c,
        Err(e) => return Json(json!({ "ok": false, "stage": "encode", "error": hint(&e) })),
    };

    let pool = match collect_pool(&channel, &service).await {
        Ok(p) => p,
        Err(e) => return Json(json!({ "ok": false, "stage": "encode", "error": e })),
    };

    let sd = match pool.get_service_by_name(&service) {
        Some(s) => s,
        None => return Json(json!({ "ok": false, "stage": "encode", "error": format!("service {service} not found") })),
    };
    let md = match sd.methods().find(|m| m.name() == method) {
        Some(m) => m,
        None => return Json(json!({ "ok": false, "stage": "encode", "error": format!("method {method} not found on {service}") })),
    };
    if md.is_client_streaming() {
        return Json(json!({ "ok": false, "stage": "encode", "error": "client and bidirectional streaming are not supported here — unary and server streaming only" }));
    }

    let input = md.input();
    let output = md.output();
    let path = format!("/{service}/{method}");

    let raw = req.request_json.unwrap_or_default();
    let payload = match encode_request(&input, &raw) {
        Ok(p) => p,
        Err(e) => return Json(json!({ "ok": false, "stage": "encode", "error": e })),
    };

    let headers = req.headers.clone().unwrap_or_default();
    let timeout_ms = req.timeout_ms.filter(|&t| t > 0).unwrap_or(15000);

    let t0 = Instant::now();
    if md.is_server_streaming() {
        let result = server_stream(channel, &path, payload, &headers, timeout_ms).await;
        let duration_ms = t0.elapsed().as_millis() as u64;
        return Json(match result {
            Err(e) => failed(e, &pool, duration_ms, &req.headers),
            Ok(ok) => {
                let total = ok.messages.len();
                let raw_bytes: usize = ok.messages.iter().map(Vec::len).sum();
                let decoded: Vec<String> = ok
                    .messages
                    .iter()
                    .enumerate()
                    .map(|(i, m)| {
                        let text = decode_response(&output, m)
                            .unwrap_or_else(|e| format!("<decode failed: {e}>"));
                        format!("──── message {} of {total} ────\n{text}", i + 1)
                    })
                    .collect();
                json!({
                    "ok": true,
                    "httpStatus": 200,
                    "grpcStatus": "0",
                    "grpcMessage": ok.note.clone().unwrap_or_default(),
                    "decoded": if total == 0 { "(the stream ended without a message)".to_string() } else { decoded.join("\n") },
                    "frames": total,
                    "rawBytes": raw_bytes,
                    "durationMs": duration_ms,
                    "reqHeaders": req.headers,
                    "headers": ok.headers,
                    "trailers": ok.trailers,
                })
            }
        });
    }
    let result = unary(channel, &path, payload, &headers, timeout_ms).await;
    let duration_ms = t0.elapsed().as_millis() as u64;

    match result {
        Err(e) => Json(failed(e, &pool, duration_ms, &req.headers)),
        Ok(ok) => {
            let raw_bytes = ok.resp.len();
            let decoded = match decode_response(&output, &ok.resp) {
                Ok(s) => s,
                Err(e) => format!("<decode failed: {e}>"),
            };
            Json(json!({
                "ok": true,
                "httpStatus": 200,
                "grpcStatus": "0",
                "grpcMessage": "",
                "decoded": decoded,
                "frames": 1,
                "rawBytes": raw_bytes,
                "durationMs": duration_ms,
                "reqHeaders": req.headers,
                "headers": ok.headers,
                "trailers": ok.trailers,
            }))
        }
    }
}

/// The response for a call the server answered with an error status, with its rich error
/// details decoded against the server's descriptors when it sent any.
fn failed(
    e: UnaryErr,
    pool: &DescriptorPool,
    duration_ms: u64,
    req_headers: &Option<HashMap<String, String>>,
) -> Value {
    json!({
        "ok": true,
        "httpStatus": 200,
        "grpcStatus": e.code.to_string(),
        "grpcMessage": e.details,
        "decoded": "",
        "frames": 0,
        "rawBytes": 0,
        "durationMs": duration_ms,
        "reqHeaders": req_headers,
        "trailers": e.trailers,
        "statusDetails": super::grpc_status::decode(&e.status_bin, Some(pool)),
    })
}

#[derive(Deserialize)]
struct HealthReq {
    target: Option<String>,
    plaintext: Option<bool>,
    /// The service to ask about; empty asks about the server as a whole.
    #[serde(default)]
    service: String,
    headers: Option<HashMap<String, String>>,
    #[serde(rename = "timeoutMs")]
    timeout_ms: Option<u64>,
}

/// `grpc.health.v1.HealthCheckResponse.ServingStatus` by number.
fn serving_status(n: u64) -> &'static str {
    match n {
        1 => "SERVING",
        2 => "NOT_SERVING",
        3 => "SERVICE_UNKNOWN",
        _ => "UNKNOWN",
    }
}

/// `grpc.health.v1.Health/Check`. Its two messages are one field each, so they are written
/// and read by hand rather than through reflection, which a server may not offer.
async fn health(Json(req): Json<HealthReq>) -> Json<Value> {
    let target = req.target.unwrap_or_default();
    if target.trim().is_empty() {
        return Json(json!({ "ok": false, "error": "target host:port required" }));
    }
    let channel = match connect(&target, req.plaintext).await {
        Ok(c) => c,
        Err(e) => return Json(json!({ "ok": false, "error": hint(&e) })),
    };
    // HealthCheckRequest { string service = 1; }
    let mut payload = Vec::new();
    if !req.service.is_empty() {
        payload.push(0x0a);
        prost::encoding::encode_varint(req.service.len() as u64, &mut payload);
        payload.extend_from_slice(req.service.as_bytes());
    }
    let t0 = Instant::now();
    let headers = req.headers.unwrap_or_default();
    let timeout_ms = req.timeout_ms.filter(|&t| t > 0).unwrap_or(5000);
    let result = unary(
        channel,
        "/grpc.health.v1.Health/Check",
        payload,
        &headers,
        timeout_ms,
    )
    .await;
    let duration_ms = t0.elapsed().as_millis() as u64;
    Json(match result {
        // HealthCheckResponse { ServingStatus status = 1; } — absent means 0, UNKNOWN
        Ok(ok) => {
            let status = super::grpc_status::wire_dump(&ok.resp)
                .get("1")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            json!({ "ok": true, "status": serving_status(status), "durationMs": duration_ms })
        }
        Err(e) => json!({
            "ok": false,
            "error": match e.code {
                12 => "the server does not implement the gRPC health service (grpc.health.v1.Health)".to_string(),
                5 => format!("the server has no health status for this service ({})", e.details),
                _ => format!("{}: {}", e.code, e.details),
            },
            "durationMs": duration_ms,
        }),
    })
}

fn encode_request(input: &MessageDescriptor, raw: &str) -> Result<Vec<u8>, String> {
    let msg = if raw.trim().is_empty() {
        DynamicMessage::new(input.clone())
    } else {
        let mut de = serde_json::Deserializer::from_str(raw);
        DynamicMessage::deserialize(input.clone(), &mut de)
            .map_err(|e| format!("bad request JSON: {e}"))?
    };
    Ok(msg.encode_to_vec())
}

fn decode_response(output: &MessageDescriptor, bytes: &[u8]) -> Result<String, String> {
    let msg = DynamicMessage::decode(output.clone(), bytes).map_err(|e| e.to_string())?;
    let opts = SerializeOptions::new().skip_default_fields(false);
    let mut buf = Vec::new();
    let mut ser = serde_json::Serializer::pretty(&mut buf);
    msg.serialize_with_options(&mut ser, &opts).map_err(|e| e.to_string())?;
    String::from_utf8(buf).map_err(|e| e.to_string())
}
