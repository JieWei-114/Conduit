//! The rich error a gRPC server may attach to a failed call: `google.rpc.Status` (code,
//! message, details), carried in the `grpc-status-details-bin` trailer. Each detail is an
//! `Any`; it is decoded with the server's own descriptors when they are at hand, and otherwise
//! shown field by field from the protobuf wire format, so nothing is lost for a type we do not
//! know.

use base64::Engine;
use prost::Message;
use prost_reflect::{DescriptorPool, DynamicMessage, SerializeOptions};
use serde_json::{json, Map, Value};

/// `google.rpc.Status`.
#[derive(Clone, PartialEq, prost::Message)]
struct RpcStatus {
    #[prost(int32, tag = "1")]
    code: i32,
    #[prost(string, tag = "2")]
    message: String,
    #[prost(message, repeated, tag = "3")]
    details: Vec<prost_types::Any>,
}

/// The status in `bytes` as `{code, message, details: [{type, value}]}`, or `None` when the
/// bytes are not a `google.rpc.Status`.
pub fn decode(bytes: &[u8], pool: Option<&DescriptorPool>) -> Option<Value> {
    if bytes.is_empty() {
        return None;
    }
    let status = RpcStatus::decode(bytes).ok()?;
    let details: Vec<Value> = status
        .details
        .iter()
        .map(|any| {
            let type_name = any.type_url.rsplit('/').next().unwrap_or(&any.type_url);
            let value = pool
                .and_then(|p| p.get_message_by_name(type_name))
                .and_then(|md| DynamicMessage::decode(md, any.value.as_slice()).ok())
                .and_then(|m| to_json(&m))
                .unwrap_or_else(|| named(wire_dump(&any.value), type_name));
            json!({ "type": any.type_url, "value": value })
        })
        .collect();
    Some(json!({ "code": status.code, "message": status.message, "details": details }))
}

/// The `grpc-status-details-bin` trailer as text (base64, padded or not) decoded the same way.
pub fn decode_trailer(b64: &str, pool: Option<&DescriptorPool>) -> Option<Value> {
    use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
    let t = b64.trim();
    let bytes = STANDARD
        .decode(t)
        .or_else(|_| STANDARD_NO_PAD.decode(t.trim_end_matches('=')))
        .ok()?;
    decode(&bytes, pool)
}

fn to_json(m: &DynamicMessage) -> Option<Value> {
    m.serialize_with_options(serde_json::value::Serializer, &SerializeOptions::new())
        .ok()
}

/// Any protobuf message without its schema: field number → value. A length-delimited field is
/// shown as a nested message when it parses as one, as text when it is UTF-8, else as base64.
/// A repeated field becomes an array.
pub fn wire_dump(bytes: &[u8]) -> Value {
    parse_fields(bytes, 0).map_or_else(|| json!({ "base64": b64(bytes) }), Value::Object)
}

/// Nesting deeper than this is shown as base64: real error details are shallow, and a
/// hostile trailer must not be able to recurse without bound.
const MAX_DEPTH: usize = 32;

/// A field of a known message: its number, name, whether it repeats, and its message type
/// when it is one (`map` for a string map).
type FieldName = (u64, &'static str, bool, Option<&'static str>);

/// Field names of the standard error details (`google/rpc/error_details.proto`, public and
/// stable), so they read by name even when the server's descriptors are not at hand.
fn known_fields(type_name: &str) -> Option<&'static [FieldName]> {
    Some(match type_name {
        "google.rpc.ErrorInfo" => &[
            (1, "reason", false, None),
            (2, "domain", false, None),
            (3, "metadata", true, Some("map")),
        ],
        "google.rpc.RetryInfo" => &[(1, "retry_delay", false, Some("google.protobuf.Duration"))],
        "google.rpc.DebugInfo" => &[(1, "stack_entries", true, None), (2, "detail", false, None)],
        "google.rpc.QuotaFailure" => &[(
            1,
            "violations",
            true,
            Some("google.rpc.QuotaFailure.Violation"),
        )],
        "google.rpc.QuotaFailure.Violation" => {
            &[(1, "subject", false, None), (2, "description", false, None)]
        }
        "google.rpc.PreconditionFailure" => &[(
            1,
            "violations",
            true,
            Some("google.rpc.PreconditionFailure.Violation"),
        )],
        "google.rpc.PreconditionFailure.Violation" => &[
            (1, "type", false, None),
            (2, "subject", false, None),
            (3, "description", false, None),
        ],
        "google.rpc.BadRequest" => &[(
            1,
            "field_violations",
            true,
            Some("google.rpc.BadRequest.FieldViolation"),
        )],
        "google.rpc.BadRequest.FieldViolation" => &[
            (1, "field", false, None),
            (2, "description", false, None),
            (3, "reason", false, None),
            (
                4,
                "localized_message",
                false,
                Some("google.rpc.LocalizedMessage"),
            ),
        ],
        "google.rpc.RequestInfo" => &[
            (1, "request_id", false, None),
            (2, "serving_data", false, None),
        ],
        "google.rpc.ResourceInfo" => &[
            (1, "resource_type", false, None),
            (2, "resource_name", false, None),
            (3, "owner", false, None),
            (4, "description", false, None),
        ],
        "google.rpc.Help" => &[(1, "links", true, Some("google.rpc.Help.Link"))],
        "google.rpc.Help.Link" => &[(1, "description", false, None), (2, "url", false, None)],
        "google.rpc.LocalizedMessage" => &[(1, "locale", false, None), (2, "message", false, None)],
        "google.protobuf.Duration" => &[(1, "seconds", false, None), (2, "nanos", false, None)],
        _ => return None,
    })
}

/// `dump` (from `wire_dump`) with field numbers replaced by names when `type_name` is a known
/// type. Unknown types and fields keep their numbers.
fn named(dump: Value, type_name: &str) -> Value {
    let (Some(fields), Value::Object(map)) = (known_fields(type_name), &dump) else {
        return dump;
    };
    let mut out = Map::new();
    for (key, value) in map {
        let Some(&(_, name, repeated, nested)) = fields.iter().find(|f| f.0.to_string() == *key)
        else {
            out.insert(key.clone(), value.clone());
            continue;
        };
        let items: Vec<Value> = match value {
            Value::Array(list) if repeated => list.clone(),
            v => vec![v.clone()],
        };
        let v = if nested == Some("map") {
            // map entries are messages { 1: key, 2: value }
            let text = |e: &Value, k: &str| {
                e.get(k)
                    .map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_string))
                    .unwrap_or_default()
            };
            Value::Object(
                items
                    .iter()
                    .map(|e| (text(e, "1"), Value::String(text(e, "2"))))
                    .collect(),
            )
        } else {
            let items: Vec<Value> = items
                .into_iter()
                .map(|v| nested.map_or_else(|| v.clone(), |t| named(v.clone(), t)))
                .collect();
            if repeated {
                Value::Array(items)
            } else {
                items.into_iter().next().unwrap_or(Value::Null)
            }
        };
        out.insert(name.to_string(), v);
    }
    Value::Object(out)
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Fields of `bytes`, or `None` when they are not a well-formed message.
fn parse_fields(bytes: &[u8], depth: usize) -> Option<Map<String, Value>> {
    // in order of first appearance; a field seen more than once is repeated
    let mut fields: Vec<(u64, Vec<Value>)> = Vec::new();
    let mut buf = bytes;
    while !buf.is_empty() {
        let key = varint(&mut buf)?;
        let (field, wire) = (key >> 3, key & 7);
        if field == 0 {
            return None;
        }
        let value = match wire {
            0 => json!(varint(&mut buf)?),
            1 => {
                let (b, rest) = buf.split_first_chunk::<8>()?;
                buf = rest;
                json!(u64::from_le_bytes(*b))
            }
            5 => {
                let (b, rest) = buf.split_first_chunk::<4>()?;
                buf = rest;
                json!(u32::from_le_bytes(*b))
            }
            2 => {
                let len = usize::try_from(varint(&mut buf)?).ok()?;
                if len > buf.len() {
                    return None;
                }
                let (body, rest) = buf.split_at(len);
                buf = rest;
                length_delimited(body, depth + 1)
            }
            _ => return None,
        };
        match fields.iter_mut().find(|(f, _)| *f == field) {
            Some((_, values)) => values.push(value),
            None => fields.push((field, vec![value])),
        }
    }
    Some(
        fields
            .into_iter()
            .map(|(f, mut values)| {
                let v = if values.len() == 1 {
                    values.remove(0)
                } else {
                    Value::Array(values)
                };
                (f.to_string(), v)
            })
            .collect(),
    )
}

/// A nested message, text, or base64 — whichever reads best.
fn length_delimited(body: &[u8], depth: usize) -> Value {
    if let Ok(text) = std::str::from_utf8(body) {
        if !text
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
        {
            return Value::String(text.to_string());
        }
    }
    if depth >= MAX_DEPTH {
        return json!({ "base64": b64(body) });
    }
    match parse_fields(body, depth) {
        Some(fields) if !fields.is_empty() => Value::Object(fields),
        _ => json!({ "base64": b64(body) }),
    }
}

fn varint(buf: &mut &[u8]) -> Option<u64> {
    let mut out = 0u64;
    for shift in (0..64).step_by(7) {
        let (&b, rest) = buf.split_first()?;
        *buf = rest;
        out |= u64::from(b & 0x7f) << shift;
        if b & 0x80 == 0 {
            return Some(out);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `google.rpc.ErrorInfo { reason: "QUOTA", domain: "example.com" }` without its schema.
    fn error_info() -> Vec<u8> {
        let mut b = vec![0x0a, 5];
        b.extend_from_slice(b"QUOTA");
        b.extend_from_slice(&[0x12, 11]);
        b.extend_from_slice(b"example.com");
        b
    }

    #[test]
    fn a_status_with_an_unknown_detail_is_dumped_by_field_number() {
        let status = RpcStatus {
            code: 8,
            message: "too many".into(),
            details: vec![prost_types::Any {
                type_url: "type.googleapis.com/google.rpc.ErrorInfo".into(),
                value: error_info(),
            }],
        };
        let v = decode(&status.encode_to_vec(), None).unwrap();
        assert_eq!(v["code"], 8);
        assert_eq!(v["message"], "too many");
        assert_eq!(
            v["details"][0]["type"],
            "type.googleapis.com/google.rpc.ErrorInfo"
        );
        assert_eq!(
            v["details"][0]["value"],
            json!({ "reason": "QUOTA", "domain": "example.com" })
        );
        let unknown = RpcStatus {
            code: 8,
            message: String::new(),
            details: vec![prost_types::Any {
                type_url: "type.example.com/acme.Custom".into(),
                value: error_info(),
            }],
        };
        let v = decode(&unknown.encode_to_vec(), None).unwrap();
        assert_eq!(
            v["details"][0]["value"],
            json!({ "1": "QUOTA", "2": "example.com" }),
            "unknown types keep their numbers"
        );
    }

    #[test]
    fn standard_details_read_by_name_including_repeats_and_maps() {
        // BadRequest { field_violations: [{ field: "a", description: "bad" }] }
        let violation = [0x0a, 1, b'a', 0x12, 3, b'b', b'a', b'd'];
        let mut bad_request = vec![0x0a, violation.len() as u8];
        bad_request.extend_from_slice(&violation);
        assert_eq!(
            named(wire_dump(&bad_request), "google.rpc.BadRequest"),
            json!({ "field_violations": [{ "field": "a", "description": "bad" }] })
        );
        // ErrorInfo { reason: "R", metadata: { "k": "v" } }
        let entry = [0x0a, 1, b'k', 0x12, 1, b'v'];
        let mut info = vec![0x0a, 1, b'R', 0x1a, entry.len() as u8];
        info.extend_from_slice(&entry);
        assert_eq!(
            named(wire_dump(&info), "google.rpc.ErrorInfo"),
            json!({ "reason": "R", "metadata": { "k": "v" } })
        );
    }

    #[test]
    fn deep_nesting_stops_at_the_limit_instead_of_recursing() {
        let mut bytes = vec![0x08, 1];
        for _ in 0..200 {
            let mut outer = vec![0x0a];
            prost::encoding::encode_varint(bytes.len() as u64, &mut outer);
            outer.extend_from_slice(&bytes);
            bytes = outer;
        }
        assert!(
            wire_dump(&bytes).to_string().contains("base64"),
            "the deep end is base64"
        );
    }

    #[test]
    fn the_trailer_form_is_base64_with_or_without_padding() {
        let status = RpcStatus {
            code: 3,
            message: "bad".into(),
            details: vec![],
        };
        let b = base64::engine::general_purpose::STANDARD.encode(status.encode_to_vec());
        assert_eq!(decode_trailer(&b, None).unwrap()["code"], 3);
        assert_eq!(
            decode_trailer(b.trim_end_matches('='), None).unwrap()["message"],
            "bad"
        );
        assert!(decode_trailer("@@@", None).is_none());
    }

    #[test]
    fn wire_dump_reads_varints_repeats_and_nesting() {
        // field 1 = 150 (varint), field 2 repeated "a","b", field 3 = nested { 1: 7 }
        let bytes = [
            0x08, 0x96, 0x01, 0x12, 1, b'a', 0x12, 1, b'b', 0x1a, 2, 0x08, 7,
        ];
        assert_eq!(
            wire_dump(&bytes),
            json!({ "1": 150, "2": ["a", "b"], "3": { "1": 7 } })
        );
        assert_eq!(wire_dump(&[0xff]), json!({ "base64": "/w==" }));
    }
}
