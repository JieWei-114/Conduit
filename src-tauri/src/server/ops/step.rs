//! Run one operation: its id, its parameters (already rendered, defaults filled) and the
//! previous step's output.

use std::collections::HashMap;
use std::io::{Read, Write};

use base64::Engine;
use chrono::{DateTime, FixedOffset, Offset, SecondsFormat, Utc};
use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use rand::RngCore;
use serde_json::{json, Value};

use super::{
    codec::Encoding,
    crypto::{self, AesParams},
    jwt,
};

/// Parameters by name, defaults filled in.
pub type Params = HashMap<String, String>;

fn get<'a>(p: &'a Params, name: &str) -> &'a str {
    p.get(name).map(String::as_str).unwrap_or("")
}

/// `p[name]` read as bytes with the encoding named in `p[encoding]`.
fn bytes(p: &Params, name: &str, encoding: &str) -> Result<Vec<u8>, String> {
    Encoding::parse(get(p, encoding))?
        .decode(get(p, name))
        .map_err(|e| format!("{name}: {e}"))
}

fn text(input: &[u8]) -> Result<&str, String> {
    std::str::from_utf8(input)
        .map_err(|_| "the input is binary; decode or encode it first".to_string())
}

/// Characters left as they are by `url.encode`: A–Z a–z 0–9 and `-_.~` (RFC 3986 unreserved).
const URL_KEEP: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~');

pub fn run(op: &str, p: &Params, input: &[u8]) -> Result<Vec<u8>, String> {
    match op {
        "text" => Ok(get(p, "value").as_bytes().to_vec()),
        "uuid" => Ok(uuid::Uuid::new_v4().to_string().into_bytes()),
        "now" => now(p, Utc::now()).map(String::into_bytes),
        "random" => {
            let n: usize = get(p, "bytes")
                .trim()
                .parse()
                .map_err(|_| "bytes must be a number")?;
            if !(1..=4096).contains(&n) {
                return Err("bytes must be between 1 and 4096".into());
            }
            let mut out = vec![0u8; n];
            rand::thread_rng().fill_bytes(&mut out);
            Ok(out)
        }

        "base64.encode" => {
            use base64::engine::general_purpose::{
                STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD,
            };
            let pad = get(p, "padding") != "false";
            let engine = match (get(p, "alphabet"), pad) {
                ("url", true) => &URL_SAFE,
                ("url", false) => &URL_SAFE_NO_PAD,
                (_, true) => &STANDARD,
                (_, false) => &STANDARD_NO_PAD,
            };
            Ok(engine.encode(input).into_bytes())
        }
        "base64.decode" => {
            let t = text(input)?;
            let url_safe = t.contains(['-', '_']);
            super::codec::b64_decode(t, url_safe)
        }
        "hex.encode" => {
            let h = hex::encode(input);
            Ok(if get(p, "case") == "upper" {
                h.to_uppercase()
            } else {
                h
            }
            .into_bytes())
        }
        "hex.decode" => super::codec::hex_decode(text(input)?),
        "url.encode" => Ok(utf8_percent_encode(text(input)?, URL_KEEP)
            .to_string()
            .into_bytes()),
        "url.decode" => Ok(percent_decode_str(&text(input)?.replace('+', " ")).collect()),

        "text.case" => {
            let t = text(input)?;
            Ok(if get(p, "case") == "lower" {
                t.to_lowercase()
            } else {
                t.to_uppercase()
            }
            .into_bytes())
        }
        "text.trim" => Ok(text(input)?.trim().as_bytes().to_vec()),
        "text.wrap" => Ok([
            get(p, "prefix").as_bytes(),
            input,
            get(p, "suffix").as_bytes(),
        ]
        .concat()),

        "hash" => crypto::digest(get(p, "alg"), input),
        "hmac" => crypto::hmac(get(p, "alg"), &bytes(p, "key", "key_encoding")?, input),

        "aes.encrypt" | "aes.decrypt" => {
            let mode = get(p, "mode");
            let key = bytes(p, "key", "key_encoding")?;
            let iv = if mode == "ecb" {
                Vec::new()
            } else {
                bytes(p, "iv", "iv_encoding")?
            };
            let params = AesParams {
                mode,
                padding: get(p, "padding"),
                key: &key,
                iv: &iv,
                aad: get(p, "aad").as_bytes(),
            };
            if op == "aes.encrypt" {
                crypto::aes_encrypt(&params, input)
            } else {
                crypto::aes_decrypt(&params, input)
            }
        }
        "rsa.encrypt" => crypto::rsa_encrypt(get(p, "key"), get(p, "padding"), input),
        "rsa.decrypt" => crypto::rsa_decrypt(get(p, "key"), get(p, "padding"), input),
        "rsa.sign" => crypto::rsa_sign(get(p, "key"), get(p, "scheme"), get(p, "hash"), input),
        "rsa.verify" => {
            let sig = bytes(p, "signature", "signature_encoding")?;
            let ok =
                crypto::rsa_verify(get(p, "key"), get(p, "scheme"), get(p, "hash"), input, &sig)?;
            Ok(ok.to_string().into_bytes())
        }
        "rsa.generate" => {
            let bits = get(p, "bits")
                .parse()
                .map_err(|_| "bits must be a number")?;
            let (private, public) = crypto::rsa_generate(bits)?;
            Ok(pretty(&json!({ "privateKey": private, "publicKey": public }))?.into_bytes())
        }

        "jwt.sign" => {
            let key = bytes(p, "key", "key_encoding")?;
            jwt::sign(get(p, "alg"), &key, text(input)?, get(p, "header")).map(String::into_bytes)
        }
        "jwt.decode" => jwt::decode(text(input)?).map(String::into_bytes),
        "jwt.verify" => {
            let key = bytes(p, "key", "key_encoding")?;
            jwt::verify(get(p, "alg"), &key, text(input)?).map(String::into_bytes)
        }

        "json.get" => {
            let doc: Value =
                serde_json::from_slice(input).map_err(|e| format!("the input is not JSON: {e}"))?;
            let found = json_get(&doc, get(p, "path"))?;
            if found.is_null() {
                return Err(format!("the value at `{}` is null", get(p, "path").trim()));
            }
            Ok(match found {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            }
            .into_bytes())
        }
        "json.format" => {
            let doc: Value =
                serde_json::from_slice(input).map_err(|e| format!("the input is not JSON: {e}"))?;
            if get(p, "style") == "minify" {
                Ok(doc.to_string().into_bytes())
            } else {
                pretty(&doc).map(String::into_bytes)
            }
        }

        "gzip" => {
            let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
            enc.write_all(input).map_err(|e| e.to_string())?;
            enc.finish().map_err(|e| e.to_string())
        }
        "gunzip" => {
            let mut out = Vec::new();
            flate2::read::GzDecoder::new(input)
                .read_to_end(&mut out)
                .map_err(|_| "the input is not gzip data".to_string())?;
            Ok(out)
        }

        other => Err(format!("unknown operation `{other}`")),
    }
}

fn pretty(v: &Value) -> Result<String, String> {
    serde_json::to_string_pretty(v).map_err(|e| e.to_string())
}

/// `at` shifted by `shift` and formatted by `format` / `pattern` in `timezone`.
fn now(p: &Params, at: DateTime<Utc>) -> Result<String, String> {
    let at = at
        .checked_add_signed(shift(get(p, "shift"))?)
        .ok_or("the shifted time is out of range")?;
    let tz = zone(get(p, "timezone"))?;
    let local = at.with_timezone(&tz);
    let utc = tz.local_minus_utc() == 0;
    Ok(match get(p, "format") {
        "unix" => at.timestamp().to_string(),
        "unix_ms" => at.timestamp_millis().to_string(),
        "iso" => local.to_rfc3339_opts(SecondsFormat::Secs, utc),
        "custom" => {
            use std::fmt::Write as _;
            let mut out = String::new();
            write!(out, "{}", local.format(get(p, "pattern")))
                .map_err(|_| "the pattern is not a valid strftime pattern".to_string())?;
            out
        }
        _ => local.to_rfc3339_opts(SecondsFormat::Millis, utc),
    })
}

/// `UTC`, `Z` or an offset such as `+08:00`.
fn zone(name: &str) -> Result<FixedOffset, String> {
    match name.trim() {
        "" | "UTC" | "utc" | "Z" => Ok(Utc.fix()),
        other => other
            .parse::<FixedOffset>()
            .map_err(|_| format!("time zone `{other}` is not UTC or an offset like +08:00")),
    }
}

/// `+1h`, `-30m`, `90s`, `+7d` or `0`.
fn shift(spec: &str) -> Result<chrono::Duration, String> {
    let s = spec.trim();
    if s.is_empty() || s == "0" {
        return Ok(chrono::Duration::zero());
    }
    let bad = || format!("shift `{s}` is not like +1h, -30m, 90s or +7d");
    let (sign, rest) = match s.as_bytes()[0] {
        b'-' => (-1, &s[1..]),
        b'+' => (1, &s[1..]),
        _ => (1, s),
    };
    let unit_at = rest.char_indices().last().map_or(0, |(i, _)| i);
    let (num, unit) = rest.split_at(unit_at);
    if num.is_empty() || !num.bytes().all(|b| b.is_ascii_digit()) {
        return Err(bad());
    }
    let n: i64 = num.parse().map_err(|_| bad())?;
    let per = match unit {
        "s" => 1,
        "m" => 60,
        "h" => 3600,
        "d" => 86_400,
        _ => return Err(bad()),
    };
    n.checked_mul(per)
        .and_then(|secs| chrono::Duration::try_seconds(sign * secs))
        .ok_or_else(|| format!("shift `{s}` is too large"))
}

/// The value at `path` (`a.b[0].c`, a leading `$.` allowed).
fn json_get<'a>(doc: &'a Value, path: &str) -> Result<&'a Value, String> {
    let path = path.trim().trim_start_matches('$').trim_start_matches('.');
    let mut cur = doc;
    if path.is_empty() {
        return Ok(cur);
    }
    for segment in path.split('.') {
        let (field, indexes) = match segment.find('[') {
            Some(i) => (&segment[..i], &segment[i..]),
            None => (segment, ""),
        };
        if !field.is_empty() {
            cur = cur
                .get(field)
                .ok_or_else(|| format!("no field `{field}` at `{path}`"))?;
        }
        for idx in indexes.split('[').filter(|s| !s.is_empty()) {
            let i: usize = idx
                .trim_end_matches(']')
                .parse()
                .map_err(|_| format!("`[{idx}` is not an index"))?;
            cur = cur
                .get(i)
                .ok_or_else(|| format!("no element {i} at `{path}`"))?;
        }
    }
    Ok(cur)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(pairs: &[(&str, &str)]) -> Params {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn run_text(op: &str, pairs: &[(&str, &str)], input: &str) -> String {
        String::from_utf8(run(op, &params(pairs), input.as_bytes()).unwrap()).unwrap()
    }

    #[test]
    fn encodings_round_trip() {
        assert_eq!(run_text("base64.encode", &[], "hi?"), "aGk/");
        assert_eq!(
            run_text(
                "base64.encode",
                &[("alphabet", "url"), ("padding", "false")],
                "hi?"
            ),
            "aGk_"
        );
        assert_eq!(run_text("base64.decode", &[], "aGk_"), "hi?");
        assert_eq!(run_text("hex.encode", &[("case", "upper")], "JK"), "4A4B");
        let upper = run("hex.encode", &params(&[("case", "upper")]), &[0xab]).unwrap();
        assert_eq!(upper, b"AB");
        assert_eq!(run_text("hex.decode", &[], "68 69"), "hi");
        assert_eq!(run_text("url.encode", &[], "a b&c~"), "a%20b%26c~");
        assert_eq!(run_text("url.decode", &[], "a+b%26c"), "a b&c");
    }

    #[test]
    fn text_steps_work_on_the_input() {
        assert_eq!(run_text("text.case", &[("case", "lower")], "AbC"), "abc");
        assert_eq!(run_text("text.trim", &[], "  x \n"), "x");
        assert_eq!(
            run_text("text.wrap", &[("prefix", "<"), ("suffix", ">")], "x"),
            "<x>"
        );
    }

    #[test]
    fn time_is_shifted_and_formatted() {
        let at: DateTime<Utc> = "2026-10-22T08:00:00.123Z".parse().unwrap();
        let fmt = |pairs: &[(&str, &str)]| now(&params(pairs), at).unwrap();
        assert_eq!(fmt(&[("format", "iso_ms")]), "2026-10-22T08:00:00.123Z");
        assert_eq!(
            fmt(&[("format", "iso"), ("timezone", "+08:00")]),
            "2026-10-22T16:00:00+08:00"
        );
        assert_eq!(
            fmt(&[("format", "unix"), ("shift", "+1h")]),
            (at.timestamp() + 3600).to_string()
        );
        assert_eq!(
            fmt(&[
                ("format", "custom"),
                ("pattern", "%Y/%m/%d"),
                ("shift", "-1d")
            ]),
            "2026/10/21"
        );
        assert!(now(&params(&[("shift", "1w")]), at).is_err());
        assert!(now(&params(&[("timezone", "Mars")]), at).is_err());
        assert!(
            now(&params(&[("shift", "+1µ")]), at).is_err(),
            "a non-ASCII unit is an error, not a panic"
        );
        for huge in ["+999999999999d", "+9223372036854775807s", "+99999999d"] {
            assert!(
                now(&params(&[("shift", huge)]), at).is_err(),
                "{huge}: an error, not a panic"
            );
        }
        assert!(now(&params(&[("shift", "+-5d")]), at).is_err());
        assert!(now(&params(&[("shift", "--5d")]), at).is_err());
    }

    #[test]
    fn json_paths_reach_nested_values() {
        let doc = r#"{"data":{"items":[{"id":"a1"},{"id":7}]}}"#;
        assert_eq!(
            run_text("json.get", &[("path", "data.items[0].id")], doc),
            "a1"
        );
        assert_eq!(
            run_text("json.get", &[("path", "$.data.items[1].id")], doc),
            "7"
        );
        assert!(run(
            "json.get",
            &params(&[("path", "data.nope")]),
            doc.as_bytes()
        )
        .is_err());
        let err = run("json.get", &params(&[("path", "a")]), br#"{"a":null}"#).unwrap_err();
        assert_eq!(err, "the value at `a` is null");
        assert_eq!(
            run_text("json.format", &[("style", "minify")], "{ \"a\" : 1 }"),
            r#"{"a":1}"#
        );
    }

    #[test]
    fn aes_and_hmac_read_their_keys_in_the_named_encoding() {
        let key = "000102030405060708090a0b0c0d0e0f";
        let p = [
            ("mode", "cbc"),
            ("padding", "pkcs7"),
            ("key", key),
            ("key_encoding", "hex"),
            ("iv", key),
            ("iv_encoding", "hex"),
        ];
        let ct = run("aes.encrypt", &params(&p), b"hello").unwrap();
        assert_eq!(run("aes.decrypt", &params(&p), &ct).unwrap(), b"hello");
        let bad = [("mode", "cbc"), ("key", "zz"), ("key_encoding", "hex")];
        assert!(run("aes.encrypt", &params(&bad), b"x")
            .unwrap_err()
            .starts_with("key:"));
        let mac = run(
            "hmac",
            &params(&[("alg", "sha256"), ("key", "Jefe"), ("key_encoding", "utf8")]),
            b"what do ya want for nothing?",
        )
        .unwrap();
        assert_eq!(
            hex::encode(mac),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    #[test]
    fn gzip_round_trips_and_generators_produce_fresh_values() {
        let gz = run("gzip", &Params::new(), b"payload").unwrap();
        assert_eq!(run("gunzip", &Params::new(), &gz).unwrap(), b"payload");
        let a = run("uuid", &Params::new(), b"").unwrap();
        assert_eq!(a.len(), 36);
        assert_ne!(a, run("uuid", &Params::new(), b"").unwrap());
        assert_eq!(
            run("random", &params(&[("bytes", "8")]), b"")
                .unwrap()
                .len(),
            8
        );
        assert!(run("nope", &Params::new(), b"").is_err());
    }
}
