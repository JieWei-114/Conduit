//! Text ↔ bytes: how a parameter written as text (a key, an IV, a signature) becomes bytes,
//! and how a step's output is shown.

use base64::Engine;
use serde::Serialize;

/// How a text parameter is read as bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Encoding {
    Utf8,
    Hex,
    Base64,
    Base64Url,
}

impl Encoding {
    pub fn parse(name: &str) -> Result<Self, String> {
        match name {
            "" | "utf8" => Ok(Self::Utf8),
            "hex" => Ok(Self::Hex),
            "base64" => Ok(Self::Base64),
            "base64url" => Ok(Self::Base64Url),
            other => Err(format!("unknown encoding `{other}`")),
        }
    }

    pub fn decode(self, text: &str) -> Result<Vec<u8>, String> {
        match self {
            Self::Utf8 => Ok(text.as_bytes().to_vec()),
            Self::Hex => hex_decode(text),
            Self::Base64 => b64_decode(text, false),
            Self::Base64Url => b64_decode(text, true),
        }
    }
}

/// Hex, ignoring whitespace and `:`, and a leading `0x`/`0X`.
pub fn hex_decode(text: &str) -> Result<Vec<u8>, String> {
    let body = text
        .trim_start()
        .strip_prefix("0x")
        .or_else(|| text.trim_start().strip_prefix("0X"))
        .unwrap_or(text);
    let clean: String = body
        .chars()
        .filter(|c| !c.is_whitespace() && *c != ':')
        .collect();
    hex::decode(&clean).map_err(|e| format!("not hex: {e}"))
}

/// Base64 in the standard or URL-safe alphabet, padded or not, ignoring whitespace.
pub fn b64_decode(text: &str, url_safe: bool) -> Result<Vec<u8>, String> {
    use base64::engine::general_purpose::{STANDARD_NO_PAD, URL_SAFE_NO_PAD};
    let clean: String = text
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '=')
        .collect();
    let engine = if url_safe {
        &URL_SAFE_NO_PAD
    } else {
        &STANDARD_NO_PAD
    };
    engine
        .decode(clean.as_bytes())
        .map_err(|e| format!("not base64: {e}"))
}

/// A step's output in the forms the UI shows.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Shown {
    /// The bytes as text, when they are valid UTF-8 without control characters (other than
    /// newline and tab).
    pub text: Option<String>,
    pub hex: String,
    pub base64: String,
    pub size: usize,
}

impl Shown {
    pub fn of(bytes: &[u8]) -> Self {
        let text = std::str::from_utf8(bytes)
            .ok()
            .filter(|s| {
                !s.chars()
                    .any(|c| c.is_control() && c != '\n' && c != '\t' && c != '\r')
            })
            .map(str::to_string);
        Self {
            text,
            hex: hex::encode(bytes),
            base64: base64::engine::general_purpose::STANDARD.encode(bytes),
            size: bytes.len(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_accepts_common_spellings() {
        assert_eq!(
            hex_decode("0xDE ad:BE ef").unwrap(),
            [0xde, 0xad, 0xbe, 0xef]
        );
        assert!(hex_decode("abc").is_err());
    }

    #[test]
    fn base64_accepts_padding_and_both_alphabets() {
        assert_eq!(b64_decode("aGk=", false).unwrap(), b"hi");
        assert_eq!(b64_decode("aGk", false).unwrap(), b"hi");
        assert_eq!(b64_decode("-_8", true).unwrap(), [0xfb, 0xff]);
    }

    #[test]
    fn output_is_text_only_when_readable() {
        assert_eq!(Shown::of(b"ok\n").text.as_deref(), Some("ok\n"));
        assert_eq!(Shown::of(&[0x00, 0x01]).text, None);
        assert_eq!(Shown::of(&[0xff]).hex, "ff");
    }
}
