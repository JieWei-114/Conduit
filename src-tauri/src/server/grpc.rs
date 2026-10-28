use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use axum::extract::Query;
use axum::routing::{get, post};
use axum::{Json, Router};
use once_cell::sync::Lazy;
use serde::Deserialize;
use serde_json::{json, Value};

use super::attempt::{Attempt, Reply};

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
    let raw = match std::fs::read_to_string(root.join(file_rel)) {
        Ok(s) => s,
        Err(_) => return,
    };
    // Strip comments first so a `service` / `message` word inside a comment
    // can't be mistaken for a real declaration.
    let src_str = strip_comments(&raw);
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

fn strip_comments(s: &str) -> String {
    let b: Vec<char> = s.chars().collect();
    let n = b.len();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    let mut in_str = false;
    let mut quote = '"';
    while i < n {
        let c = b[i];
        if in_str {
            out.push(c);
            if c == '\\' && i + 1 < n {
                out.push(b[i + 1]);
                i += 2;
                continue;
            }
            if c == quote {
                in_str = false;
            }
            i += 1;
            continue;
        }
        if c == '"' || c == '\'' {
            in_str = true;
            quote = c;
            out.push(c);
            i += 1;
            continue;
        }
        if c == '/' && i + 1 < n && b[i + 1] == '/' {
            while i < n && b[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if c == '/' && i + 1 < n && b[i + 1] == '*' {
            i += 2;
            while i + 1 < n && !(b[i] == '*' && b[i + 1] == '/') {
                i += 1;
            }
            i += 2;
            out.push(' ');
            continue;
        }
        out.push(c);
        i += 1;
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

/* Encoding and decoding parse the .proto (and its imports) from disk, which is
   blocking work, so the request handlers run them on the blocking pool — the
   same reason as the scan in `protos`. Decoding takes every frame at once so a
   multi-message response parses its descriptor on one thread, not one each. */
async fn encode_off_thread(root: &Path, proto_rel: &str, req_type: &str, text: &str) -> Result<Vec<u8>, String> {
    let (root, proto_rel, req_type, text) =
        (root.to_path_buf(), proto_rel.to_string(), req_type.to_string(), text.to_string());
    tokio::task::spawn_blocking(move || encode_text(&root, &proto_rel, &req_type, &text))
        .await
        .map_err(|e| format!("encode task failed: {e}"))?
}

async fn decode_off_thread(root: &Path, proto_rel: &str, res_type: &str, frames: Vec<Vec<u8>>) -> Vec<Result<String, String>> {
    let (root, proto_rel, res_type) = (root.to_path_buf(), proto_rel.to_string(), res_type.to_string());
    let n = frames.len();
    tokio::task::spawn_blocking(move || {
        frames.iter().map(|f| decode_bytes(&root, &proto_rel, &res_type, f)).collect()
    })
    .await
    .unwrap_or_else(|e| vec![Err(format!("decode task failed: {e}")); n])
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

/// How a direct call failed.
enum DirectErr {
    /// Refused before anything was sent: a bad target, the TLS setup, a bad method path.
    NotSent(String),
    /// Broke in Conduit or on the way, never answered by the server: the cause chain, and
    /// whether it was Conduit's own timeout.
    Failed { chain: Vec<String>, timed_out: bool },
    /// A status the server sent.
    Status {
        code: i32,
        details: String,
        trailers: HashMap<String, String>,
        /// `grpc-status-details-bin`, when the server attached a `google.rpc.Status`.
        status_bin: Vec<u8>,
    },
}

impl DirectErr {
    fn from_status(status: &tonic::Status) -> Self {
        if let Some((chain, timed_out)) = local_failure(status) {
            return Self::Failed { chain, timed_out };
        }
        Self::Status {
            code: status.code() as i32,
            details: if status.message().is_empty() { status.code().to_string() } else { status.message().to_string() },
            trailers: md_to_obj(status.metadata()),
            status_bin: status.details().to_vec(),
        }
    }
}

/// Whether a failed call's status was made on this side rather than sent by the server, and if
/// so its cause chain and whether it was Conduit's own timeout. tonic builds a status for
/// Conduit's timeout and for a transport error after connecting, and keeps the cause as its
/// `source()`; a status the server sent has none.
pub(super) fn local_failure(status: &tonic::Status) -> Option<(Vec<String>, bool)> {
    let source = std::error::Error::source(status)?;
    let mut chain = super::attempt::chain(source);
    if chain.is_empty() {
        chain.push(status.message().to_string());
    }
    Some((chain, conduit_timed_out(source)))
}

/// Whether `err` or a cause under it is one of Conduit's own time limits (the call's timeout,
/// or the connect timeout) running out.
pub(super) fn conduit_timed_out(err: &(dyn std::error::Error + 'static)) -> bool {
    let mut cur = Some(err);
    while let Some(e) = cur {
        if e.is::<tonic::TimeoutExpired>() || e.is::<tokio::time::error::Elapsed>() {
            return true;
        }
        cur = e.source();
    }
    false
}

/// Text metadata as a map. A value with bytes outside visible ASCII is kept, lossily, instead
/// of being dropped.
pub(super) fn md_to_obj(md: &tonic::metadata::MetadataMap) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for kv in md.iter() {
        if let tonic::metadata::KeyAndValueRef::Ascii(k, v) = kv {
            out.insert(k.as_str().to_string(), super::http::header_text(v.as_bytes()));
        }
    }
    out
}

/// The caller's headers as gRPC metadata. A key ending in `-bin` carries its value as bytes; a
/// name or value a header cannot carry is refused, never dropped.
pub(super) fn apply_metadata(md: &mut tonic::metadata::MetadataMap, headers: &HashMap<String, String>) -> Result<(), String> {
    use tonic::metadata::{AsciiMetadataKey, BinaryMetadataKey, BinaryMetadataValue, MetadataValue};
    let mut names: Vec<&String> = headers.keys().collect();
    names.sort();
    for k in names {
        let v = &headers[k];
        let kl = k.to_lowercase();
        if v.is_empty() || kl == "content-type" || kl == "x-grpc-web" {
            continue;
        }
        if kl.ends_with("-bin") {
            let key = BinaryMetadataKey::from_bytes(kl.as_bytes()).map_err(|_| format!("metadata name {k:?} is not a valid gRPC metadata key"))?;
            md.insert_bin(key, BinaryMetadataValue::from_bytes(v.as_bytes()));
            continue;
        }
        let key = AsciiMetadataKey::from_bytes(kl.as_bytes()).map_err(|_| format!("metadata name {k:?} is not a valid gRPC metadata key (lowercase letters, digits, - _ .)"))?;
        let val = MetadataValue::try_from(v.as_str()).map_err(|_| {
            format!("metadata {k:?} has characters a metadata value cannot carry (a line break or another control character): send it under a key ending in -bin to send its bytes")
        })?;
        md.insert(key, val);
    }
    Ok(())
}

async fn call_direct(
    req: &CallReq,
    payload: Vec<u8>,
    timeout_ms: u64,
) -> Result<DirectOk, DirectErr> {
    use super::attempt::{chain, describe};
    let target = req.target.clone().unwrap_or_default();
    let target = target.trim().to_string();
    let plaintext = req.plaintext.unwrap_or(true);
    let scheme = if plaintext { "http" } else { "https" };
    let uri = format!("{scheme}://{target}");

    let grpc_path = req.grpc_path.clone().unwrap_or_default();
    let path = http::uri::PathAndQuery::from_maybe_shared(grpc_path.clone())
        .map_err(|e| DirectErr::NotSent(format!("bad method path {grpc_path:?}: {}", describe(&e))))?;
    let mut ep = tonic::transport::Channel::from_shared(uri)
        .map_err(|e| DirectErr::NotSent(format!("bad target {target:?}: {}", describe(&e))))?;
    ep = ep.timeout(Duration::from_millis(timeout_ms)).connect_timeout(Duration::from_millis(timeout_ms));
    if !plaintext {
        ep = ep
            .tls_config(tonic::transport::ClientTlsConfig::new().with_native_roots())
            .map_err(|e| DirectErr::NotSent(format!("TLS setup failed: {}", describe(&e))))?;
    }

    let channel = ep
        .connect()
        .await
        .map_err(|e| DirectErr::Failed { chain: chain(&e), timed_out: conduit_timed_out(&e) })?;

    let mut grpc = tonic::client::Grpc::new(channel);
    grpc.ready()
        .await
        .map_err(|e| DirectErr::Failed { chain: chain(&e), timed_out: conduit_timed_out(&e) })?;

    let mut request = tonic::Request::new(payload);
    apply_metadata(request.metadata_mut(), &req.headers.clone().unwrap_or_default()).map_err(DirectErr::NotSent)?;

    match grpc.unary(request, path, RawCodec).await {
        Ok(resp) => {
            let headers = md_to_obj(resp.metadata());
            let (meta, body, extensions) = resp.into_parts();
            let _ = extensions;
            let trailers = md_to_obj(&meta);
            Ok(DirectOk { resp: body.to_vec(), headers, trailers })
        }
        Err(status) => Err(DirectErr::from_status(&status)),
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

/* The scan is a synchronous directory walk, so it runs on a blocking thread.
   Run directly, a wide root (`/` reaches a great deal at depth 8) holds a
   runtime worker for minutes, and enough of those stall the whole server —
   every other request queues behind it, WebSocket upgrades included. */
async fn protos(Query(q): Query<RootQuery>) -> Json<Value> {
    let root = match resolve_root(q.root.as_deref()) {
        Ok(r) => r,
        Err(e) => return Json(json!({ "error": e })),
    };
    match tokio::task::spawn_blocking(move || {
        let found = list_protos(&root);
        (root, found)
    })
    .await
    {
        Ok((root, found)) => {
            Json(json!({ "ok": true, "root": root.to_string_lossy(), "protos": found }))
        }
        Err(e) => Json(json!({ "error": format!("proto scan failed: {e}") })),
    }
}

async fn inspect(Query(q): Query<InspectQuery>) -> Json<Value> {
    let rel = match q.proto {
        Some(p) if !p.is_empty() => p,
        _ => return Json(json!({ "error": "missing ?proto=" })),
    };
    let root = match resolve_root(q.root.as_deref()) {
        Ok(r) => r,
        Err(e) => return Json(json!({ "error": e })),
    };
    // Parsing a descriptor is blocking work too, for the same reason.
    match tokio::task::spawn_blocking(move || inspect_proto(&root, &rel)).await {
        Ok(info) => Json(serde_json::to_value(info).unwrap_or(json!({}))),
        Err(e) => Json(json!({ "error": format!("proto inspect failed: {e}") })),
    }
}

async fn call(Json(req): Json<CallReq>) -> Json<Value> {
    Json(do_call(req).await)
}

async fn do_call(req: CallReq) -> Value {
    let transport = req.transport.clone().unwrap_or_default();
    let direct = transport == "direct";
    let timeout_ms = req.timeout_ms.filter(|&t| t > 0).unwrap_or(15000);
    let request_body = Value::String(req.text_body.clone());
    let target = req.target.as_deref().unwrap_or("").trim().to_string();
    let grpc_path = req.grpc_path.clone().unwrap_or_default();
    let scheme = if req.plaintext.unwrap_or(true) { "http" } else { "https" };
    let direct_url = format!("{scheme}://{target}{grpc_path}");
    let (method, url) = if direct {
        ("POST (gRPC)", direct_url.as_str())
    } else {
        ("POST (gRPC-Web)", req.url.as_str())
    };

    // refused before anything is sent: the same failure shape (and record) as a failed call
    let not_sent = |stage: &str, message: &str| {
        let attempt = Attempt::start(method, url, req.headers.clone().unwrap_or_default(), request_body.clone(), 0);
        let (error, log) = attempt.not_sent(stage, message);
        json!({ "ok": false, "stage": stage, "error": message, "detail": error, "durationMs": 0, "log": log })
    };
    if let Some(missing) = direct_missing(direct, &target, &grpc_path) {
        return not_sent("request", missing);
    }

    let root = match resolve_root(Some(&req.root)) {
        Ok(r) => r,
        Err(e) => return not_sent("encode", &e),
    };

    let payload = match encode_off_thread(&root, &req.proto, &req.req_type, &req.text_body).await {
        Ok(p) => p,
        Err(e) => return not_sent("encode", &e),
    };

    if direct {
        let attempt = Attempt::start(method, url, req.headers.clone().unwrap_or_default(), request_body, payload.len());
        let r = call_direct(&req, payload, timeout_ms).await;
        let duration_ms = attempt.elapsed_ms();
        match r {
            Err(DirectErr::NotSent(message)) => {
                let (error, log) = attempt.not_sent("request", &message);
                return json!({ "ok": false, "stage": "request", "error": message, "detail": error, "durationMs": duration_ms, "log": log });
            }
            Err(DirectErr::Failed { chain, timed_out }) => {
                let stage = if timed_out { "timeout" } else { "network" };
                let (error, log) = attempt.failed_with(stage, chain, timed_out, timeout_ms).await;
                return json!({
                    "ok": false,
                    "stage": stage,
                    "error": error["message"],
                    "detail": error,
                    "durationMs": duration_ms,
                    "log": log,
                });
            }
            Err(DirectErr::Status { code, details, trailers, status_bin }) => {
                let log = attempt.succeeded(Reply {
                    status: 200,
                    headers: &HashMap::new(),
                    trailers: Some(&trailers),
                    body: json!({ "grpcStatus": code.to_string(), "grpcMessage": details }),
                    bytes: 0,
                });
                return json!({
                    "ok": true,
                    "httpStatus": 200,
                    "grpcStatus": code.to_string(),
                    "grpcMessage": details,
                    "decoded": "",
                    "frames": 0,
                    "rawBytes": 0,
                    "durationMs": duration_ms,
                    "reqHeaders": req.headers,
                    "trailers": trailers,
                    "statusDetails": super::grpc_status::decode(&status_bin, None),
                    "log": log,
                });
            }
            Ok(ok) => {
                let decoded = match decode_off_thread(&root, &req.proto, &req.res_type, vec![ok.resp.clone()])
                    .await
                    .pop()
                    .unwrap_or_else(|| Err("no frame".into()))
                {
                    Ok(s) => s,
                    Err(e) => format!("<decode failed: {e}>"),
                };
                let log = attempt.succeeded(Reply {
                    status: 200,
                    headers: &ok.headers,
                    trailers: Some(&ok.trailers),
                    body: Value::String(decoded.clone()),
                    bytes: ok.resp.len(),
                });
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
                    "log": log,
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
    headers.entry("user-agent".into()).or_insert_with(super::http::user_agent);
    let body = frame(&payload);
    let attempt = Attempt::start("POST (gRPC-Web)", &req.url, headers.clone(), request_body, body.len());

    let client = match reqwest::Client::builder().timeout(Duration::from_millis(timeout_ms)).build() {
        Ok(c) => c,
        Err(e) => {
            let (error, log) = attempt.not_sent("request", &super::attempt::describe(&e));
            return json!({ "ok": false, "stage": "request", "error": error["message"], "detail": error, "durationMs": attempt.elapsed_ms(), "log": log });
        }
    };

    let mut hmap = reqwest::header::HeaderMap::new();
    for (k, v) in &headers {
        match (
            reqwest::header::HeaderName::from_bytes(k.as_bytes()),
            reqwest::header::HeaderValue::from_str(v),
        ) {
            (Ok(name), Ok(val)) => {
                hmap.insert(name, val);
            }
            _ => {
                let message = format!("header {k:?} cannot be sent: its name or value has characters an HTTP header cannot carry (only visible ASCII)");
                let (error, log) = attempt.not_sent("request", &message);
                return json!({ "ok": false, "stage": "request", "error": message, "detail": error, "durationMs": 0, "log": log });
            }
        }
    }

    let resp = client.post(&req.url).headers(hmap).body(body).send().await;
    let resp = match resp {
        Ok(r) => r,
        Err(e) => {
            let duration_ms = attempt.elapsed_ms();
            let timed_out = e.is_timeout();
            let stage = if timed_out { "timeout" } else { "network" };
            let (error, log) = attempt.failed(stage, &e.without_url(), timed_out, timeout_ms).await;
            return json!({ "ok": false, "stage": stage, "error": error["message"], "detail": error, "durationMs": duration_ms, "log": log });
        }
    };

    let status = resp.status().as_u16();
    let mut resp_headers: HashMap<String, String> = HashMap::new();
    for (k, v) in resp.headers().iter() {
        resp_headers.insert(k.as_str().to_string(), super::http::header_text(v.as_bytes()));
    }
    let ct = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let header_grpc_status = resp.headers().get("grpc-status").and_then(|v| v.to_str().ok()).map(|s| s.to_string());
    let header_grpc_message = resp.headers().get("grpc-message").and_then(|v| v.to_str().ok()).map(|s| s.to_string());

    let buf = match resp.bytes().await {
        Ok(b) => b.to_vec(),
        Err(e) => {
            let duration_ms = attempt.elapsed_ms();
            let timed_out = e.is_timeout();
            let (error, log) = attempt.failed("body", &e.without_url(), timed_out, timeout_ms).await;
            return json!({ "ok": false, "stage": error["stage"], "error": error["message"], "detail": error, "durationMs": duration_ms, "log": log });
        }
    };
    let duration_ms = attempt.elapsed_ms();

    if !ct.contains("grpc") {
        let mut text = String::from_utf8_lossy(&buf).to_string();
        cut_at_char_boundary(&mut text, 2000);
        let log = attempt.succeeded(Reply {
            status,
            headers: &resp_headers,
            trailers: None,
            body: Value::String(text.clone()),
            bytes: buf.len(),
        });
        return json!({ "ok": false, "stage": "gateway", "httpStatus": status, "error": text, "durationMs": duration_ms, "log": log });
    }

    let (frames, trailers) = deframe(&buf);
    let grpc_status = trailers.get("grpc-status").cloned().or(header_grpc_status).unwrap_or_default();
    let grpc_message = decode_grpc_message(&trailers.get("grpc-message").cloned().or(header_grpc_message).unwrap_or_default());

    let non_empty: Vec<&Vec<u8>> = frames.iter().filter(|f| !f.is_empty()).collect();
    let total = non_empty.len();
    let mut parts: Vec<String> = Vec::new();
    let decoded = decode_off_thread(&root, &req.proto, &req.res_type, non_empty.iter().map(|f| f.to_vec()).collect()).await;
    for (i, d) in decoded.into_iter().enumerate() {
        let text = match d {
            Ok(s) => s,
            Err(e) => format!("<decode failed: {e}>"),
        };
        if total > 1 {
            parts.push(format!("──── message {} ────\n{}", i + 1, text));
        } else {
            parts.push(text);
        }
    }
    let decoded = parts.join("\n");
    let log = attempt.succeeded(Reply {
        status,
        headers: &resp_headers,
        trailers: Some(&trailers),
        body: json!({ "grpcStatus": grpc_status, "grpcMessage": grpc_message, "message": decoded }),
        bytes: buf.len(),
    });

    json!({
        "ok": true,
        "httpStatus": status,
        "grpcStatus": grpc_status,
        "grpcMessage": grpc_message,
        "decoded": decoded,
        "frames": parts.len(),
        "rawBytes": buf.len(),
        "durationMs": duration_ms,
        "reqHeaders": headers,
        "headers": resp_headers,
        "statusDetails": trailers
            .get("grpc-status-details-bin")
            .or_else(|| resp_headers.get("grpc-status-details-bin"))
            .and_then(|b| super::grpc_status::decode_trailer(b, None)),
        "trailers": trailers,
        "log": log,
    })
}

/// What a direct call is missing before it can be sent, if anything.
fn direct_missing(direct: bool, target: &str, grpc_path: &str) -> Option<&'static str> {
    match (direct, target.is_empty(), grpc_path.is_empty()) {
        (false, ..) => None,
        (true, true, true) => Some("direct mode needs a target host:port and a method"),
        (true, true, false) => Some("direct mode needs a target host:port"),
        (true, false, true) => Some("direct mode needs a method (its /package.Service/Method path)"),
        (true, false, false) => None,
    }
}

/// Shorten `text` to at most `max` bytes without splitting a character: `String::truncate`
/// panics when `max` falls inside a multi-byte character.
fn cut_at_char_boundary(text: &mut String, max: usize) {
    if text.len() <= max {
        return;
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conduits_own_timeout_is_a_timeout_not_a_server_status() {
        // Arrange: the status tonic builds when the channel's timeout runs out
        let status = tonic::Status::from_error(Box::new(tonic::TimeoutExpired(())));
        // Act
        let failure = local_failure(&status);
        // Assert
        let (chain, timed_out) = failure.expect("made on this side");
        assert!(timed_out);
        assert_eq!(chain, vec!["Timeout expired".to_string()]);
    }

    #[test]
    fn a_transport_error_after_connecting_is_a_network_failure() {
        let io = std::io::Error::new(std::io::ErrorKind::ConnectionReset, "connection reset by peer");
        let status = tonic::Status::from_error(Box::new(io));
        let (chain, timed_out) = local_failure(&status).expect("made on this side");
        assert!(!timed_out);
        assert!(chain.iter().any(|c| c.contains("connection reset")), "{chain:?}");
    }

    #[test]
    fn a_status_the_server_sent_stays_a_status() {
        assert!(local_failure(&tonic::Status::not_found("no such user")).is_none());
        assert!(matches!(
            DirectErr::from_status(&tonic::Status::not_found("no such user")),
            DirectErr::Status { code: 5, .. }
        ));
    }

    #[test]
    fn direct_mode_names_what_is_missing() {
        assert_eq!(direct_missing(false, "", ""), None);
        assert_eq!(direct_missing(true, "h:1", "/a.B/C"), None);
        assert_eq!(direct_missing(true, "h:1", ""), Some("direct mode needs a method (its /package.Service/Method path)"));
        assert_eq!(direct_missing(true, "", "/a.B/C"), Some("direct mode needs a target host:port"));
    }

    #[test]
    fn metadata_with_non_ascii_bytes_is_kept() {
        let mut md = tonic::metadata::MetadataMap::new();
        md.insert("x-name", tonic::metadata::MetadataValue::try_from("caf\u{e9}".as_bytes()).unwrap());
        assert_eq!(md_to_obj(&md)["x-name"], "caf\u{e9}");
    }

    #[test]
    fn non_ascii_metadata_is_refused_or_sent_as_bytes_never_dropped() {
        let mut md = tonic::metadata::MetadataMap::new();
        let mut h = HashMap::new();
        h.insert("x-name".to_string(), "line\nbreak".to_string());
        let e = apply_metadata(&mut md, &h).unwrap_err();
        assert!(e.contains("x-name") && e.contains("-bin"), "{e}");
        let mut h = HashMap::new();
        h.insert("bad key".to_string(), "v".to_string());
        assert!(apply_metadata(&mut md, &h).unwrap_err().contains("bad key"));
        let mut h = HashMap::new();
        h.insert("x-utf8".to_string(), "caf\u{e9}".to_string());
        apply_metadata(&mut md, &h).unwrap();
        assert_eq!(md.get("x-utf8").unwrap().as_bytes(), "caf\u{e9}".as_bytes());
        let mut h = HashMap::new();
        h.insert("x-name-bin".to_string(), "caf\u{e9}".to_string());
        h.insert("x-plain".to_string(), "ok".to_string());
        apply_metadata(&mut md, &h).unwrap();
        assert_eq!(md.get_bin("x-name-bin").unwrap().to_bytes().unwrap().as_ref(), "caf\u{e9}".as_bytes());
        assert_eq!(md.get("x-plain").unwrap(), "ok");
    }

    #[tokio::test]
    async fn a_bad_direct_target_is_not_sent_rather_than_a_server_reply() {
        let req: CallReq = serde_json::from_value(json!({
            "transport": "direct",
            "target": "bad host:1",
            "grpcPath": "/a.B/C",
        }))
        .unwrap();
        let out = match call_direct(&req, Vec::new(), 1000).await {
            Err(DirectErr::NotSent(m)) => m,
            _ => panic!("expected a refusal before sending"),
        };
        assert!(out.contains("bad target"), "{out}");
    }

    #[test]
    fn a_long_non_ascii_page_is_cut_without_splitting_a_character() {
        // "€" is 3 bytes, so 2000 falls inside a character
        let mut text = "€".repeat(1000);
        cut_at_char_boundary(&mut text, 2000);
        assert_eq!(text.len(), 1998);
        assert!(text.chars().all(|c| c == '€'));

        let mut short = "ok".to_string();
        cut_at_char_boundary(&mut short, 2000);
        assert_eq!(short, "ok");
    }
}
