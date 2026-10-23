//! JSON Web Tokens: sign a claims object, decode one without checking it, or verify it.

use base64::Engine;
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde_json::{json, Value};

/// `alg` by its JOSE name: `HS256`…`HS512`, `RS256`…`RS512`, `PS256`…`PS512`, `ES256`, `ES384`.
fn algorithm(name: &str) -> Result<Algorithm, String> {
    name.parse::<Algorithm>()
        .map_err(|_| format!("unknown JWT algorithm `{name}`"))
}

fn is_hmac(alg: Algorithm) -> bool {
    matches!(alg, Algorithm::HS256 | Algorithm::HS384 | Algorithm::HS512)
}

/// Sign `claims` (a JSON object). `key` is the shared secret for HS*, a PEM private key
/// otherwise. `extra_header` (a JSON object, may be empty) adds fields such as `kid`.
pub fn sign(alg: &str, key: &[u8], claims: &str, extra_header: &str) -> Result<String, String> {
    let alg = algorithm(alg)?;
    let claims: Value =
        serde_json::from_str(claims).map_err(|e| format!("claims are not JSON: {e}"))?;
    if !claims.is_object() {
        return Err("claims must be a JSON object".into());
    }
    let header = header_with(alg, extra_header)?;
    let key = if is_hmac(alg) {
        EncodingKey::from_secret(key)
    } else if matches!(alg, Algorithm::ES256 | Algorithm::ES384) {
        EncodingKey::from_ec_pem(key).map_err(|e| format!("not an EC private key in PEM: {e}"))?
    } else {
        EncodingKey::from_rsa_pem(key).map_err(|e| format!("not an RSA private key in PEM: {e}"))?
    };
    jsonwebtoken::encode(&header, &claims, &key).map_err(|e| sign_error(&e))
}

/// Header fields the extra-header JSON may set: every registered JWS header but `alg`, which
/// the algorithm parameter owns.
const HEADER_FIELDS: [&str; 8] = ["typ", "cty", "kid", "jku", "jwk", "x5u", "x5c", "x5t"];

/// The JOSE header for `alg` with the fields of `extra` (a JSON object, may be empty).
fn header_with(alg: Algorithm, extra: &str) -> Result<Header, String> {
    let mut header = serde_json::to_value(Header::new(alg)).map_err(|e| e.to_string())?;
    if extra.trim().is_empty() {
        return serde_json::from_value(header).map_err(|e| e.to_string());
    }
    let extra: Value =
        serde_json::from_str(extra).map_err(|e| format!("extra header is not JSON: {e}"))?;
    let Value::Object(fields) = extra else {
        return Err("extra header must be a JSON object".into());
    };
    for (k, v) in fields {
        if !HEADER_FIELDS.contains(&k.as_str()) && k != "x5t#S256" {
            return Err(format!(
                "extra header field `{k}` is not a JWS header this tool can set ({}, x5t#S256)",
                HEADER_FIELDS.join(", ")
            ));
        }
        header[k.as_str()] = v;
    }
    serde_json::from_value(header).map_err(|e| format!("extra header: {e}"))
}

/// A signing failure in words: the library's key errors name the problem but not the fix.
fn sign_error(e: &jsonwebtoken::errors::Error) -> String {
    let text = e.to_string();
    if text.contains("TooSmall") {
        "the RSA key is too small: use at least 2048 bits".into()
    } else {
        format!("could not sign: {text}")
    }
}

/// Header and payload as one JSON object `{header, payload}`, without checking the signature.
pub fn decode(token: &str) -> Result<String, String> {
    let token = token.trim().trim_start_matches("Bearer ").trim();
    let mut parts = token.split('.');
    let (Some(h), Some(p), Some(_), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err("a JWT has three dot-separated parts".into());
    };
    let part = |s: &str| -> Result<Value, String> {
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(s.trim_end_matches('='))
            .map_err(|_| "a JWT part is not base64url".to_string())?;
        serde_json::from_slice(&bytes).map_err(|_| "a JWT part is not JSON".to_string())
    };
    let out = json!({ "header": part(h)?, "payload": part(p)? });
    serde_json::to_string_pretty(&out).map_err(|e| e.to_string())
}

/// The payload as JSON when the signature is valid for `key` and `exp` / `nbf`, when present,
/// hold now. `key` is the secret for HS*, a PEM public key otherwise.
pub fn verify(alg: &str, key: &[u8], token: &str) -> Result<String, String> {
    let alg = algorithm(alg)?;
    let key = if is_hmac(alg) {
        DecodingKey::from_secret(key)
    } else if matches!(alg, Algorithm::ES256 | Algorithm::ES384) {
        DecodingKey::from_ec_pem(key).map_err(|e| format!("not an EC public key in PEM: {e}"))?
    } else {
        DecodingKey::from_rsa_pem(key).map_err(|e| format!("not an RSA public key in PEM: {e}"))?
    };
    let mut v = Validation::new(alg);
    v.required_spec_claims.clear();
    v.validate_aud = false;
    v.validate_nbf = true;
    let data = jsonwebtoken::decode::<Value>(token.trim(), &key, &v)
        .map_err(|e| format!("invalid token: {e}"))?;
    serde_json::to_string_pretty(&data.claims).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hs256_signs_decodes_and_verifies() {
        let token = sign(
            "HS256",
            b"secret",
            r#"{"sub":"p1","n":1}"#,
            r#"{"kid":"k1"}"#,
        )
        .unwrap();
        let decoded: Value = serde_json::from_str(&decode(&token).unwrap()).unwrap();
        assert_eq!(decoded["header"]["alg"], "HS256");
        assert_eq!(decoded["header"]["kid"], "k1");
        assert_eq!(decoded["payload"]["sub"], "p1");
        let claims: Value =
            serde_json::from_str(&verify("HS256", b"secret", &token).unwrap()).unwrap();
        assert_eq!(claims["n"], 1);
        assert!(verify("HS256", b"wrong", &token).is_err());
    }

    #[test]
    fn an_expired_token_does_not_verify() {
        let token = sign("HS256", b"s", r#"{"exp":1000}"#, "").unwrap();
        assert!(verify("HS256", b"s", &token)
            .unwrap_err()
            .contains("invalid token"));
    }

    #[test]
    fn rs256_uses_the_pem_pair() {
        let (private, public) = crate::server::ops::crypto::rsa_generate(2048).unwrap();
        let token = sign("RS256", private.as_bytes(), r#"{"sub":"x"}"#, "").unwrap();
        assert!(verify("RS256", public.as_bytes(), &token).is_ok());
    }

    #[test]
    fn the_extra_header_sets_registered_fields_and_refuses_others() {
        let token = sign(
            "HS256",
            b"s",
            "{}",
            r#"{"kid":"k1","x5t":"abc","cty":"JWT"}"#,
        )
        .unwrap();
        let decoded: Value = serde_json::from_str(&decode(&token).unwrap()).unwrap();
        assert_eq!(decoded["header"]["x5t"], "abc");
        assert_eq!(decoded["header"]["cty"], "JWT");
        assert!(sign("HS256", b"s", "{}", r#"{"foo":1}"#)
            .unwrap_err()
            .contains("`foo`"));
        assert!(sign("HS256", b"s", "{}", "[1]")
            .unwrap_err()
            .contains("JSON object"));
    }

    #[test]
    fn a_small_rsa_key_is_explained() {
        let (private, _) = crate::server::ops::crypto::rsa_generate(1024).unwrap();
        let err = sign("RS256", private.as_bytes(), "{}", "").unwrap_err();
        assert!(err.contains("at least 2048 bits"), "{err}");
    }

    #[test]
    fn bad_input_is_explained() {
        assert!(sign("XX1", b"k", "{}", "")
            .unwrap_err()
            .contains("unknown JWT algorithm"));
        assert!(sign("HS256", b"k", "[1]", "")
            .unwrap_err()
            .contains("JSON object"));
        assert!(decode("a.b").is_err());
    }
}
