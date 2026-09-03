use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use axum::extract::Query;
use axum::routing::{get, post};
use axum::{Json, Router};
use once_cell::sync::Lazy;
use serde::Deserialize;
use serde_json::{json, Value};

pub fn routes() -> Router {
    Router::new()
        .route("/config", get(config))
        .route("/protos", get(protos))
        .route("/inspect", get(inspect))
        .route("/call", post(call))
}

static DEFAULT_ROOT: Lazy<String> = Lazy::new(|| {
    std::env::var("PROTO_ROOT").ok().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| {
        std::env::current_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_default()
    })
});

const SKIP_DIRS: &[&str] = &["node_modules", "output-grpc", "dist", ".git"];

fn home_dir() -> String {
    std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default()
}

fn resolve_root(root: Option<&str>) -> Result<PathBuf, String> {
    let r = root.map(|s| s.trim()).filter(|s| !s.is_empty()).unwrap_or(DEFAULT_ROOT.as_str());
    let abs = if let Some(rest) = r.strip_prefix('~') {
        PathBuf::from(home_dir()).join(rest.trim_start_matches('/'))
    } else {
        PathBuf::from(r)
    };
    if !abs.is_dir() {
        return Err(format!("root directory not found: {}", abs.display()));
    }
    Ok(abs)
}

fn list_protos(root: &Path) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    walk_protos(root, root, 0, &mut out);
    out.sort();
    out
}

fn walk_protos(root: &Path, dir: &Path, depth: u32, out: &mut Vec<String>) {
    if depth > 8 {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if SKIP_DIRS.contains(&name.as_str()) || name.starts_with('.') {
            continue;
        }
        let p = entry.path();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir {
            walk_protos(root, &p, depth + 1, out);
        } else if name.ends_with(".proto") {
            if let Ok(rel) = p.strip_prefix(root) {
                out.push(rel.to_string_lossy().to_string());
            }
        }
    }
}

// ---------------------------------------------------------------- inspect --

#[derive(serde::Serialize)]
struct RpcDef {
    method: String,
    req: String,
    res: String,
}

#[derive(serde::Serialize)]
struct ServiceDef {
    service: String,
    rpcs: Vec<RpcDef>,
}

#[derive(serde::Serialize)]
struct FieldDef {
    name: String,
    #[serde(rename = "type")]
    ty: String,
    repeated: bool,
    comment: String,
}

#[derive(serde::Serialize)]
struct MessageDef {
    name: String,
    fields: Vec<FieldDef>,
}

#[derive(serde::Serialize)]
struct EnumDef {
    name: String,
    values: Vec<String>,
}

#[derive(serde::Serialize)]
struct ProtoInfo {
    pkg: String,
    services: Vec<ServiceDef>,
    messages: Vec<MessageDef>,
    enums: Vec<EnumDef>,
}

fn is_ident(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn is_type_char(c: char) -> bool {
    is_ident(c) || c == '.'
}

// find matching close brace, returns index after '{' body start .. body end
fn balanced_block(src: &[char], open: usize) -> Option<(usize, usize)> {
    let mut depth = 0usize;
    let mut i = open;
    let mut body_start = 0usize;
    while i < src.len() {
        match src[i] {
            '{' => {
                if depth == 0 {
                    body_start = i + 1;
                }
                depth += 1;
            }
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some((body_start, i));
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

fn read_word(src: &[char], mut i: usize) -> (String, usize) {
    while i < src.len() && src[i].is_whitespace() {
        i += 1;
    }
    let start = i;
    while i < src.len() && is_ident(src[i]) {
        i += 1;
    }
    (src[start..i].iter().collect(), i)
}

fn find_keyword(src: &[char], from: usize, kw: &[char]) -> Option<usize> {
    let n = kw.len();
    let mut i = from;
    while i + n <= src.len() {
        if src[i..i + n] == *kw {
            let before = i == 0 || !is_ident(src[i - 1]);
            let after = i + n >= src.len() || !is_ident(src[i + n]);
            if before && after {
                return Some(i);
            }
        }
        i += 1;
    }
    None
}

fn inspect_proto(root: &Path, rel: &str) -> ProtoInfo {
    let mut services: Vec<ServiceDef> = Vec::new();
    let mut enums: Vec<EnumDef> = Vec::new();
    let mut messages: Vec<MessageDef> = Vec::new();
    let mut pkg = String::new();
    let mut visited: Vec<String> = Vec::new();
    parse_file(root, rel, true, &mut visited, &mut pkg, &mut services, &mut messages, &mut enums);
    ProtoInfo { pkg, services, messages, enums }
}

#[allow(clippy::too_many_arguments)]
fn parse_file(
    root: &Path,
    file_rel: &str,
    is_entry: bool,
    visited: &mut Vec<String>,
    pkg: &mut String,
    services: &mut Vec<ServiceDef>,
    messages: &mut Vec<MessageDef>,
    enums: &mut Vec<EnumDef>,
) {
    if visited.iter().any(|v| v == file_rel) || visited.len() >= 25 {
        return;
    }
    visited.push(file_rel.to_string());
    let src_str = match std::fs::read_to_string(root.join(file_rel)) {
        Ok(s) => s,
        Err(_) => return,
    };
    let src: Vec<char> = src_str.chars().collect();

    if is_entry {
        *pkg = parse_package(&src_str).unwrap_or_default();
    }

    if is_entry {
        parse_services(&src, services);
    }

    parse_enums(&src, enums);
    parse_messages(&src, messages);

    for import in parse_imports(&src_str) {
        if !import.starts_with("google/") {
            parse_file(root, &import, false, visited, pkg, services, messages, enums);
        }
    }
}

fn parse_package(src: &str) -> Option<String> {
    for line in src.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("package") {
            let rest = rest.trim();
            let name: String = rest.chars().take_while(|&c| is_type_char(c)).collect();
            if !name.is_empty() {
                return Some(name);
            }
        }
    }
    None
}

fn parse_imports(src: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in src.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("import") {
            let rest = rest.trim();
            if let Some(start) = rest.find('"') {
                if let Some(end) = rest[start + 1..].find('"') {
                    out.push(rest[start + 1..start + 1 + end].to_string());
                }
            }
        }
    }
    out
}

fn parse_services(src: &[char], services: &mut Vec<ServiceDef>) {
    let kw: Vec<char> = "service".chars().collect();
    let mut from = 0usize;
    while let Some(pos) = find_keyword(src, from, &kw) {
        let (name, after) = read_word(src, pos + kw.len());
        let brace = match src[after..].iter().position(|&c| c == '{') {
            Some(p) => after + p,
            None => break,
        };
        let (bs, be) = match balanced_block(src, brace) {
            Some(x) => x,
            None => break,
        };
        if !name.is_empty() {
            let rpcs = parse_rpcs(&src[bs..be]);
            services.push(ServiceDef { service: name, rpcs });
        }
        from = be + 1;
    }
}

fn parse_rpcs(body: &[char]) -> Vec<RpcDef> {
    let mut out = Vec::new();
    let kw: Vec<char> = "rpc".chars().collect();
    let mut from = 0usize;
    while let Some(pos) = find_keyword(body, from, &kw) {
        let (method, mut i) = read_word(body, pos + kw.len());
        // expect (
        while i < body.len() && body[i].is_whitespace() {
            i += 1;
        }
        if i >= body.len() || body[i] != '(' {
            from = pos + kw.len();
            continue;
        }
        i += 1;
        let (req, ni) = read_type(body, i);
        i = ni;
        // to )
        while i < body.len() && body[i] != ')' {
            i += 1;
        }
        i += 1;
        // returns
        while i < body.len() && body[i].is_whitespace() {
            i += 1;
        }
        let (kwret, ni) = read_word(body, i);
        if kwret != "returns" {
            from = pos + kw.len();
            continue;
        }
        i = ni;
        while i < body.len() && body[i] != '(' {
            i += 1;
        }
        i += 1;
        // optional stream
        let save = i;
        let (maybe_stream, ni) = read_word(body, i);
        if maybe_stream == "stream" {
            i = ni;
        } else {
            i = save;
        }
        let (res, ni) = read_type(body, i);
        i = ni;
        if !method.is_empty() && !req.is_empty() && !res.is_empty() {
            out.push(RpcDef { method, req, res });
        }
        from = i;
    }
    out
}

fn read_type(src: &[char], mut i: usize) -> (String, usize) {
    while i < src.len() && src[i].is_whitespace() {
        i += 1;
    }
    let start = i;
    while i < src.len() && is_type_char(src[i]) {
        i += 1;
    }
    (src[start..i].iter().collect(), i)
}

fn parse_enums(src: &[char], enums: &mut Vec<EnumDef>) {
    let kw: Vec<char> = "enum".chars().collect();
    let mut from = 0usize;
    while let Some(pos) = find_keyword(src, from, &kw) {
        let (name, after) = read_word(src, pos + kw.len());
        let brace = match src[after..].iter().position(|&c| c == '{') {
            Some(p) => after + p,
            None => break,
        };
        let (bs, be) = match balanced_block(src, brace) {
            Some(x) => x,
            None => break,
        };
        let body: String = src[bs..be].iter().collect();
        if !name.is_empty() && !enums.iter().any(|e| e.name == name) {
            let mut values = Vec::new();
            for line in body.lines() {
                let t = line.trim();
                let ident: String = t.chars().take_while(|&c| is_ident(c)).collect();
                let after: &str = &t[ident.len()..];
                let after = after.trim_start();
                if !ident.is_empty() && after.starts_with('=') {
                    let num = after[1..].trim_start();
                    if num.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false) {
                        values.push(ident);
                    }
                }
            }
            enums.push(EnumDef { name, values });
        }
        from = be + 1;
    }
}

fn parse_messages(src: &[char], messages: &mut Vec<MessageDef>) {
    let kw: Vec<char> = "message".chars().collect();
    let mut from = 0usize;
    while let Some(pos) = find_keyword(src, from, &kw) {
        let (name, after) = read_word(src, pos + kw.len());
        let brace = match src[after..].iter().position(|&c| c == '{') {
            Some(p) => after + p,
            None => break,
        };
        let (bs, be) = match balanced_block(src, brace) {
            Some(x) => x,
            None => break,
        };
        // flat only: skip if body contains nested braces
        let body_slice = &src[bs..be];
        let has_nested = body_slice.iter().any(|&c| c == '{' || c == '}');
        if !name.is_empty() && !has_nested && !messages.iter().any(|m| m.name == name) {
            let body: String = body_slice.iter().collect();
            let fields = parse_fields(&body);
            messages.push(MessageDef { name, fields });
        }
        from = be + 1;
    }
}

fn parse_fields(body: &str) -> Vec<FieldDef> {
    let mut out = Vec::new();
    for raw in body.lines() {
        let line = raw.trim_end();
        let mut rest = line.trim_start();
        if rest.is_empty() {
            continue;
        }
        let mut repeated = false;
        // label
        for label in ["repeated", "optional"] {
            if let Some(after) = rest.strip_prefix(label) {
                if after.starts_with(|c: char| c.is_whitespace()) {
                    if label == "repeated" {
                        repeated = true;
                    }
                    rest = after.trim_start();
                    break;
                }
            }
        }
        // type: map<...> or ident
        let ty: String;
        if rest.starts_with("map") {
            let after = rest["map".len()..].trim_start();
            if !after.starts_with('<') {
                continue;
            }
            let close = match after.find('>') {
                Some(c) => c,
                None => continue,
            };
            ty = format!("map<{}>", &after[1..close]);
            rest = after[close + 1..].trim_start();
        } else {
            let t: String = rest.chars().take_while(|&c| is_type_char(c)).collect();
            if t.is_empty() {
                continue;
            }
            ty = t.clone();
            rest = rest[t.len()..].trim_start();
        }
        // field name
        let name: String = rest.chars().take_while(|&c| is_ident(c)).collect();
        if name.is_empty() {
            continue;
        }
        rest = rest[name.len()..].trim_start();
        if !rest.starts_with('=') {
            continue;
        }
        rest = rest[1..].trim_start();
        let num: String = rest.chars().take_while(|&c| c.is_ascii_digit()).collect();
        if num.is_empty() {
            continue;
        }
        rest = rest[num.len()..].trim_start();
        if !rest.starts_with(';') {
            continue;
        }
        rest = rest[1..].trim_start();
        let comment = if let Some(c) = rest.strip_prefix("//") {
            c.trim().to_string()
        } else {
            String::new()
        };
        let ty_clean: String = ty.chars().filter(|c| !c.is_whitespace()).collect();
        out.push(FieldDef { name, ty: ty_clean, repeated, comment });
    }
    out
}

// ------------------------------------------------------------- proto reflect --

fn load_descriptor(
    root: &Path,
    proto_rel: &str,
    full_name: &str,
) -> Result<protobuf::reflect::MessageDescriptor, String> {
    let input = root.join(proto_rel);
    let mut parser = protobuf_parse::Parser::new();
    parser.pure();
    parser.include(root);
    if let Some(parent) = input.parent() {
        if parent != root {
            parser.include(parent);
        }
    }
    let inc = root.join("include");
    if inc.is_dir() {
        parser.include(&inc);
    }
    parser.input(&input);

    let parsed = parser.parse_and_typecheck().map_err(|e| format!("{e}"))?;
    let fds = parsed.file_descriptors;
    let descriptors = protobuf::reflect::FileDescriptor::new_dynamic_fds(fds, &[])
        .map_err(|e| format!("{e}"))?;

    let bare = full_name.strip_prefix('.').unwrap_or(full_name);
    let dotted = format!(".{bare}");
    for fd in &descriptors {
        if let Some(md) = fd.message_by_full_name(&dotted) {
            return Ok(md);
        }
    }
    Err(format!("message not found: {bare}"))
}

fn encode_text(root: &Path, proto_rel: &str, req_type: &str, text: &str) -> Result<Vec<u8>, String> {
    let md = load_descriptor(root, proto_rel, req_type)?;
    let mut msg = md.new_instance();
    protobuf::text_format::merge_from_str(&mut *msg, text).map_err(|e| format!("{e}"))?;
    msg.write_to_bytes_dyn().map_err(|e| format!("{e}"))
}

fn decode_bytes(root: &Path, proto_rel: &str, res_type: &str, bytes: &[u8]) -> Result<String, String> {
    let md = load_descriptor(root, proto_rel, res_type)?;
    let mut msg = md.new_instance();
    msg.merge_from_bytes_dyn(bytes).map_err(|e| format!("{e}"))?;
    Ok(protobuf::text_format::print_to_string(&*msg))
}

// ------------------------------------------------------------ gRPC-Web wire --

fn frame(payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 5);
    out.push(0x00);
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(payload);
    out
}

fn deframe(buf: &[u8]) -> (Vec<Vec<u8>>, HashMap<String, String>) {
    let mut off = 0usize;
    let mut frames: Vec<Vec<u8>> = Vec::new();
    let mut trailer_text = String::new();
    while off + 5 <= buf.len() {
        let flag = buf[off];
        let len = u32::from_be_bytes([buf[off + 1], buf[off + 2], buf[off + 3], buf[off + 4]]) as usize;
        let end = std::cmp::min(off + 5 + len, buf.len());
        let chunk = &buf[off + 5..end];
        if flag & 0x80 != 0 {
            trailer_text.push_str(&String::from_utf8_lossy(chunk));
        } else {
            frames.push(chunk.to_vec());
        }
        off += 5 + len;
    }
    let mut trailers = HashMap::new();
    for line in trailer_text.split("\r\n") {
        if let Some(i) = line.find(':') {
            if i > 0 {
                trailers.insert(line[..i].trim().to_string(), line[i + 1..].trim().to_string());
            }
        }
    }
    (frames, trailers)
}

fn decode_grpc_message(m: &str) -> String {
    percent_decode(m)
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let h = hex_val(bytes[i + 1]);
            let l = hex_val(bytes[i + 2]);
            if let (Some(h), Some(l)) = (h, l) {
                out.push(h << 4 | l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    match String::from_utf8(out) {
        Ok(s) => s,
        Err(_) => s.to_string(),
    }
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

// --------------------------------------------------------- direct transport --

#[derive(Clone, Default)]
struct RawCodec;

impl tonic::codec::Codec for RawCodec {
    type Encode = Vec<u8>;
    type Decode = bytes::Bytes;
    type Encoder = RawEncoder;
    type Decoder = RawDecoder;
    fn encoder(&mut self) -> Self::Encoder {
        RawEncoder
    }
    fn decoder(&mut self) -> Self::Decoder {
        RawDecoder
    }
}

struct RawEncoder;
impl tonic::codec::Encoder for RawEncoder {
    type Item = Vec<u8>;
    type Error = tonic::Status;
    fn encode(&mut self, item: Self::Item, dst: &mut tonic::codec::EncodeBuf<'_>) -> Result<(), Self::Error> {
        use bytes::BufMut;
        dst.put_slice(&item);
        Ok(())
    }
}

struct RawDecoder;
impl tonic::codec::Decoder for RawDecoder {
    type Item = bytes::Bytes;
    type Error = tonic::Status;
    fn decode(&mut self, src: &mut tonic::codec::DecodeBuf<'_>) -> Result<Option<Self::Item>, Self::Error> {
        use bytes::Buf;
        let len = src.remaining();
        let bytes = src.copy_to_bytes(len);
        Ok(Some(bytes))
    }
}

struct DirectOk {
    resp: Vec<u8>,
    headers: HashMap<String, String>,
    trailers: HashMap<String, String>,
}

struct DirectErr {
    code: i32,
    details: String,
    trailers: HashMap<String, String>,
}

fn md_to_obj(md: &tonic::metadata::MetadataMap) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for kv in md.iter() {
        if let tonic::metadata::KeyAndValueRef::Ascii(k, v) = kv {
            if let Ok(s) = v.to_str() {
                out.insert(k.as_str().to_string(), s.to_string());
            }
        }
    }
    out
}

async fn call_direct(
    req: &CallReq,
    payload: Vec<u8>,
    timeout_ms: u64,
) -> Result<DirectOk, DirectErr> {
    let target = req.target.clone().unwrap_or_default();
    let target = target.trim().to_string();
    let plaintext = req.plaintext.unwrap_or(true);
    let scheme = if plaintext { "http" } else { "https" };
    let uri = format!("{scheme}://{target}");

    let mut ep = match tonic::transport::Channel::from_shared(uri) {
        Ok(e) => e,
        Err(e) => {
            return Err(DirectErr { code: 2, details: format!("{e}"), trailers: HashMap::new() });
        }
    };
    ep = ep.timeout(Duration::from_millis(timeout_ms)).connect_timeout(Duration::from_millis(timeout_ms));
    if !plaintext {
        match ep.tls_config(tonic::transport::ClientTlsConfig::new().with_native_roots()) {
            Ok(e) => ep = e,
            Err(e) => return Err(DirectErr { code: 2, details: format!("{e}"), trailers: HashMap::new() }),
        }
    }

    let channel = match ep.connect().await {
        Ok(c) => c,
        Err(e) => return Err(DirectErr { code: 14, details: format!("{e}"), trailers: HashMap::new() }),
    };

    let mut grpc = tonic::client::Grpc::new(channel);
    if let Err(e) = grpc.ready().await {
        return Err(DirectErr { code: 14, details: format!("{e}"), trailers: HashMap::new() });
    }

    let mut request = tonic::Request::new(payload);
    for (k, v) in req.headers.clone().unwrap_or_default() {
        let kl = k.to_lowercase();
        if v.is_empty() || kl == "content-type" || kl == "x-grpc-web" {
            continue;
        }
        if let (Ok(key), Ok(val)) = (
            kl.parse::<tonic::metadata::MetadataKey<tonic::metadata::Ascii>>(),
            v.parse::<tonic::metadata::MetadataValue<tonic::metadata::Ascii>>(),
        ) {
            request.metadata_mut().insert(key, val);
        }
    }

    let path = match http::uri::PathAndQuery::from_maybe_shared(req.grpc_path.clone().unwrap_or_default()) {
        Ok(p) => p,
        Err(e) => return Err(DirectErr { code: 3, details: format!("{e}"), trailers: HashMap::new() }),
    };

    match grpc.unary(request, path, RawCodec).await {
        Ok(resp) => {
            let headers = md_to_obj(resp.metadata());
            let (meta, body, extensions) = resp.into_parts();
            let _ = extensions;
            let trailers = md_to_obj(&meta);
            Ok(DirectOk { resp: body.to_vec(), headers, trailers })
        }
        Err(status) => Err(DirectErr {
            code: status.code() as i32,
            details: if status.message().is_empty() { status.code().to_string() } else { status.message().to_string() },
            trailers: md_to_obj(status.metadata()),
        }),
    }
}

// -------------------------------------------------------------------- types --

#[derive(Deserialize, Clone)]
struct CallReq {
    #[serde(default)]
    url: String,
    #[serde(default)]
    root: String,
    #[serde(default)]
    proto: String,
    #[serde(rename = "reqType", default)]
    req_type: String,
    #[serde(rename = "resType", default)]
    res_type: String,
    #[serde(rename = "textBody", default)]
    text_body: String,
    #[serde(default)]
    headers: Option<HashMap<String, String>>,
    #[serde(rename = "timeoutMs", default)]
    timeout_ms: Option<u64>,
    #[serde(default)]
    transport: Option<String>,
    #[serde(default)]
    target: Option<String>,
    #[serde(default)]
    plaintext: Option<bool>,
    #[serde(rename = "grpcPath", default)]
    grpc_path: Option<String>,
}

#[derive(Deserialize)]
struct RootQuery {
    root: Option<String>,
}

#[derive(Deserialize)]
struct InspectQuery {
    root: Option<String>,
    proto: Option<String>,
}

// ----------------------------------------------------------------- handlers --

async fn config() -> Json<Value> {
    Json(json!({ "defaultRoot": DEFAULT_ROOT.as_str() }))
}

async fn protos(Query(q): Query<RootQuery>) -> Json<Value> {
    match resolve_root(q.root.as_deref()) {
        Ok(root) => Json(json!({ "ok": true, "root": root.to_string_lossy(), "protos": list_protos(&root) })),
        Err(e) => Json(json!({ "error": e })),
    }
}

async fn inspect(Query(q): Query<InspectQuery>) -> Json<Value> {
    let rel = match q.proto {
        Some(p) if !p.is_empty() => p,
        _ => return Json(json!({ "error": "missing ?proto=" })),
    };
    match resolve_root(q.root.as_deref()) {
        Ok(root) => Json(serde_json::to_value(inspect_proto(&root, &rel)).unwrap_or(json!({}))),
        Err(e) => Json(json!({ "error": e })),
    }
}

async fn call(Json(req): Json<CallReq>) -> Json<Value> {
    Json(do_call(req).await)
}

async fn do_call(req: CallReq) -> Value {
    let root = match resolve_root(Some(&req.root)) {
        Ok(r) => r,
        Err(e) => return json!({ "ok": false, "stage": "encode", "error": e }),
    };

    let payload = match encode_text(&root, &req.proto, &req.req_type, &req.text_body) {
        Ok(p) => p,
        Err(e) => return json!({ "ok": false, "stage": "encode", "error": e }),
    };

    let transport = req.transport.clone().unwrap_or_default();
    let timeout_ms = req.timeout_ms.filter(|&t| t > 0).unwrap_or(15000);

    if transport == "direct" {
        if req.target.as_deref().map(|s| s.trim().is_empty()).unwrap_or(true) || req.grpc_path.as_deref().unwrap_or("").is_empty() {
            return json!({ "ok": false, "stage": "network", "error": "direct mode needs a target host:port" });
        }
        let t0 = Instant::now();
        let r = call_direct(&req, payload, timeout_ms).await;
        let duration_ms = t0.elapsed().as_millis();
        match r {
            Err(e) => {
                return json!({
                    "ok": true,
                    "httpStatus": 200,
                    "grpcStatus": e.code.to_string(),
                    "grpcMessage": e.details,
                    "decoded": "",
                    "frames": 0,
                    "rawBytes": 0,
                    "durationMs": duration_ms,
                    "reqHeaders": req.headers,
                    "trailers": e.trailers,
                });
            }
            Ok(ok) => {
                let decoded = match decode_bytes(&root, &req.proto, &req.res_type, &ok.resp) {
                    Ok(s) => s,
                    Err(e) => format!("<decode failed: {e}>"),
                };
                return json!({
                    "ok": true,
                    "httpStatus": 200,
                    "grpcStatus": "0",
                    "grpcMessage": "",
                    "decoded": decoded,
                    "frames": 1,
                    "rawBytes": ok.resp.len(),
                    "durationMs": duration_ms,
                    "reqHeaders": req.headers,
                    "headers": ok.headers,
                    "trailers": ok.trailers,
                });
            }
        }
    }

    // gateway (gRPC-Web)
    let mut headers: HashMap<String, String> = HashMap::new();
    headers.insert("content-type".into(), "application/grpc-web+proto".into());
    headers.insert("x-grpc-web".into(), "1".into());
    for (k, v) in req.headers.clone().unwrap_or_default() {
        if !v.is_empty() {
            headers.insert(k.to_lowercase(), v);
        }
    }

    let client = match reqwest::Client::builder().timeout(Duration::from_millis(timeout_ms)).build() {
        Ok(c) => c,
        Err(e) => return json!({ "ok": false, "stage": "network", "error": format!("{e}") }),
    };

    let mut hmap = reqwest::header::HeaderMap::new();
    for (k, v) in &headers {
        if let (Ok(name), Ok(val)) = (
            reqwest::header::HeaderName::from_bytes(k.as_bytes()),
            reqwest::header::HeaderValue::from_str(v),
        ) {
            hmap.insert(name, val);
        }
    }

    let t0 = Instant::now();
    let resp = client.post(&req.url).headers(hmap).body(frame(&payload)).send().await;
    let resp = match resp {
        Ok(r) => r,
        Err(e) => {
            let duration_ms = t0.elapsed().as_millis();
            if e.is_timeout() {
                return json!({ "ok": false, "stage": "timeout", "error": format!("request aborted after {timeout_ms}ms"), "durationMs": duration_ms });
            }
            return json!({ "ok": false, "stage": "network", "error": e.to_string(), "durationMs": duration_ms });
        }
    };

    let status = resp.status().as_u16();
    let mut resp_headers: HashMap<String, String> = HashMap::new();
    for (k, v) in resp.headers().iter() {
        resp_headers.insert(k.as_str().to_string(), v.to_str().unwrap_or("").to_string());
    }
    let ct = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let header_grpc_status = resp.headers().get("grpc-status").and_then(|v| v.to_str().ok()).map(|s| s.to_string());
    let header_grpc_message = resp.headers().get("grpc-message").and_then(|v| v.to_str().ok()).map(|s| s.to_string());

    let buf = match resp.bytes().await {
        Ok(b) => b.to_vec(),
        Err(e) => {
            let duration_ms = t0.elapsed().as_millis();
            return json!({ "ok": false, "stage": "network", "error": e.to_string(), "durationMs": duration_ms });
        }
    };
    let duration_ms = t0.elapsed().as_millis();

    if !ct.contains("grpc") {
        let mut text = String::from_utf8_lossy(&buf).to_string();
        if text.len() > 2000 {
            text.truncate(2000);
        }
        return json!({ "ok": false, "stage": "gateway", "httpStatus": status, "error": text, "durationMs": duration_ms });
    }

    let (frames, trailers) = deframe(&buf);
    let grpc_status = trailers.get("grpc-status").cloned().or(header_grpc_status).unwrap_or_default();
    let grpc_message = decode_grpc_message(&trailers.get("grpc-message").cloned().or(header_grpc_message).unwrap_or_default());

    let non_empty: Vec<&Vec<u8>> = frames.iter().filter(|f| !f.is_empty()).collect();
    let total = non_empty.len();
    let mut parts: Vec<String> = Vec::new();
    for (i, f) in non_empty.iter().enumerate() {
        let text = match decode_bytes(&root, &req.proto, &req.res_type, f) {
            Ok(s) => s,
            Err(e) => format!("<decode failed: {e}>"),
        };
        if total > 1 {
            parts.push(format!("──── message {} ────\n{}", i + 1, text));
        } else {
            parts.push(text);
        }
    }

    json!({
        "ok": true,
        "httpStatus": status,
        "grpcStatus": grpc_status,
        "grpcMessage": grpc_message,
        "decoded": parts.join("\n"),
        "frames": parts.len(),
        "rawBytes": buf.len(),
        "durationMs": duration_ms,
        "reqHeaders": headers,
        "headers": resp_headers,
        "trailers": trailers,
    })
}
