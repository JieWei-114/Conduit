//! Every operation the engine knows, with its parameters. The UI builds its forms from this
//! list, so adding an operation here and in `step.rs` is all it takes to offer it.

use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct OpSpec {
    pub id: &'static str,
    pub group: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    /// Whether the step reads the previous output. A generator (`uuid`, `now`) does not.
    pub uses_input: bool,
    pub params: &'static [ParamSpec],
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct ParamSpec {
    pub name: &'static str,
    pub label: &'static str,
    /// `text`, `textarea`, `select`, `number` or `bool`.
    pub kind: &'static str,
    /// Masked in the UI and kept out of history.
    pub secret: bool,
    pub options: &'static [&'static str],
    pub default: &'static str,
    pub placeholder: &'static str,
    /// Shown only when another parameter has one of these values: `(param, values)`.
    pub when: Option<(&'static str, &'static [&'static str])>,
}

const fn p(name: &'static str, label: &'static str) -> ParamSpec {
    ParamSpec {
        name,
        label,
        kind: "text",
        secret: false,
        options: &[],
        default: "",
        placeholder: "",
        when: None,
    }
}

impl ParamSpec {
    const fn textarea(mut self) -> Self {
        self.kind = "textarea";
        self
    }
    const fn number(mut self) -> Self {
        self.kind = "number";
        self
    }
    const fn bool(mut self) -> Self {
        self.kind = "bool";
        self
    }
    const fn secret(mut self) -> Self {
        self.secret = true;
        self
    }
    const fn select(mut self, options: &'static [&'static str]) -> Self {
        self.kind = "select";
        self.options = options;
        self
    }
    const fn default(mut self, value: &'static str) -> Self {
        self.default = value;
        self
    }
    const fn placeholder(mut self, value: &'static str) -> Self {
        self.placeholder = value;
        self
    }
    const fn when(mut self, param: &'static str, values: &'static [&'static str]) -> Self {
        self.when = Some((param, values));
        self
    }
}

const fn op(
    id: &'static str,
    group: &'static str,
    label: &'static str,
    description: &'static str,
    uses_input: bool,
    params: &'static [ParamSpec],
) -> OpSpec {
    OpSpec {
        id,
        group,
        label,
        description,
        uses_input,
        params,
    }
}

pub const ENCODINGS: &[&str] = &["utf8", "hex", "base64", "base64url"];
const HASHES: &[&str] = &["md5", "sha1", "sha256", "sha384", "sha512"];
const AES_MODES: &[&str] = &["cbc", "ecb", "ctr", "gcm"];
const RSA_SCHEMES: &[&str] = &["pkcs1v15", "pss"];
const RSA_HASHES: &[&str] = &["sha256", "sha1", "sha512"];
const RSA_PADDINGS: &[&str] = &["oaep-sha256", "oaep-sha1", "pkcs1v15"];
const JWT_ALGS: &[&str] = &[
    "HS256", "HS384", "HS512", "RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256",
    "ES384",
];

const AES_PARAMS: &[ParamSpec] = &[
    p("mode", "Mode").select(AES_MODES).default("cbc"),
    p("padding", "Padding")
        .select(&["pkcs7", "none"])
        .default("pkcs7")
        .when("mode", &["cbc", "ecb"]),
    p("key", "Key")
        .secret()
        .placeholder("16 / 24 / 32 bytes → AES-128 / 192 / 256"),
    p("key_encoding", "Key encoding")
        .select(ENCODINGS)
        .default("hex"),
    p("iv", "IV / nonce")
        .placeholder("16 bytes (CBC, CTR) · 12 bytes (GCM)")
        .when("mode", &["cbc", "ctr", "gcm"]),
    p("iv_encoding", "IV encoding")
        .select(ENCODINGS)
        .default("hex")
        .when("mode", &["cbc", "ctr", "gcm"]),
    p("aad", "Additional data (AAD)").when("mode", &["gcm"]),
];

const JWT_ALG: ParamSpec = p("alg", "Algorithm").select(JWT_ALGS).default("HS256");
const JWT_KEY: ParamSpec = p("key", "Key")
    .textarea()
    .secret()
    .placeholder("shared secret (HS*) or PEM key");
const JWT_KEY_ENCODING: ParamSpec = p("key_encoding", "Key encoding")
    .select(ENCODINGS)
    .default("utf8")
    .when("alg", &["HS256", "HS384", "HS512"]);

pub const CATALOG: &[OpSpec] = &[
    // ── generate ─────────────────────────────────────────────────────────────
    op(
        "text",
        "Generate",
        "Text",
        "Fixed text; may reference variables with {{name}}.",
        false,
        &[p("value", "Text")
            .textarea()
            .placeholder("{{a}}{{b}} or any text")],
    ),
    op("uuid", "Generate", "UUID v4", "A random UUID.", false, &[]),
    op(
        "now",
        "Generate",
        "Current time",
        "The current time, shifted and formatted.",
        false,
        &[
            p("format", "Format")
                .select(&["iso", "iso_ms", "unix", "unix_ms", "custom"])
                .default("iso_ms"),
            p("pattern", "Pattern")
                .default("%Y-%m-%dT%H:%M:%S%.3fZ")
                .placeholder("strftime, e.g. %Y-%m-%d %H:%M:%S")
                .when("format", &["custom"]),
            p("timezone", "Time zone")
                .default("UTC")
                .placeholder("UTC or +08:00")
                .when("format", &["iso", "iso_ms", "custom"]),
            p("shift", "Shift")
                .default("0")
                .placeholder("+1h · -30m · +7d · 0"),
        ],
    ),
    op(
        "random",
        "Generate",
        "Random bytes",
        "Cryptographically random bytes.",
        false,
        &[p("bytes", "Bytes").number().default("16")],
    ),
    // ── encode ───────────────────────────────────────────────────────────────
    op(
        "base64.encode",
        "Encode",
        "Base64 encode",
        "Bytes to Base64.",
        true,
        &[
            p("alphabet", "Alphabet")
                .select(&["standard", "url"])
                .default("standard"),
            p("padding", "Padding").bool().default("true"),
        ],
    ),
    op(
        "base64.decode",
        "Encode",
        "Base64 decode",
        "Base64 (either alphabet, padded or not) to bytes.",
        true,
        &[],
    ),
    op(
        "hex.encode",
        "Encode",
        "Hex encode",
        "Bytes to hex.",
        true,
        &[p("case", "Case")
            .select(&["lower", "upper"])
            .default("lower")],
    ),
    op(
        "hex.decode",
        "Encode",
        "Hex decode",
        "Hex (spaces, colons, 0x allowed) to bytes.",
        true,
        &[],
    ),
    op(
        "url.encode",
        "Encode",
        "URL encode",
        "Percent-encode everything but A–Z a–z 0–9 - _ . ~",
        true,
        &[],
    ),
    op(
        "url.decode",
        "Encode",
        "URL decode",
        "Percent-decode; `+` becomes a space.",
        true,
        &[],
    ),
    // ── text ─────────────────────────────────────────────────────────────────
    op(
        "text.case",
        "Text",
        "Change case",
        "Upper or lower case.",
        true,
        &[p("case", "Case")
            .select(&["upper", "lower"])
            .default("upper")],
    ),
    op(
        "text.trim",
        "Text",
        "Trim",
        "Remove leading and trailing whitespace.",
        true,
        &[],
    ),
    op(
        "text.wrap",
        "Text",
        "Prefix / suffix",
        "Add text before and after the input.",
        true,
        &[p("prefix", "Prefix"), p("suffix", "Suffix")],
    ),
    // ── hash ─────────────────────────────────────────────────────────────────
    op(
        "hash",
        "Hash & MAC",
        "Hash",
        "Message digest of the input.",
        true,
        &[p("alg", "Algorithm").select(HASHES).default("sha256")],
    ),
    op(
        "hmac",
        "Hash & MAC",
        "HMAC",
        "Keyed MAC of the input.",
        true,
        &[
            p("alg", "Hash").select(HASHES).default("sha256"),
            p("key", "Key").secret(),
            p("key_encoding", "Key encoding")
                .select(ENCODINGS)
                .default("utf8"),
        ],
    ),
    // ── cipher ───────────────────────────────────────────────────────────────
    op(
        "aes.encrypt",
        "Cipher",
        "AES encrypt",
        "AES; the key length picks 128 / 192 / 256. GCM appends the 16-byte tag.",
        true,
        AES_PARAMS,
    ),
    op(
        "aes.decrypt",
        "Cipher",
        "AES decrypt",
        "AES; GCM expects the tag at the end.",
        true,
        AES_PARAMS,
    ),
    op(
        "rsa.encrypt",
        "Cipher",
        "RSA encrypt",
        "Encrypt with a public key.",
        true,
        &[
            p("key", "Public key (PEM)")
                .textarea()
                .placeholder("-----BEGIN PUBLIC KEY-----"),
            p("padding", "Padding")
                .select(RSA_PADDINGS)
                .default("oaep-sha256"),
        ],
    ),
    op(
        "rsa.decrypt",
        "Cipher",
        "RSA decrypt",
        "Decrypt with a private key.",
        true,
        &[
            p("key", "Private key (PEM)")
                .textarea()
                .secret()
                .placeholder("-----BEGIN PRIVATE KEY-----"),
            p("padding", "Padding")
                .select(RSA_PADDINGS)
                .default("oaep-sha256"),
        ],
    ),
    // ── signature ────────────────────────────────────────────────────────────
    op(
        "rsa.sign",
        "Signature",
        "RSA sign",
        "Sign the input with a private key.",
        true,
        &[
            p("key", "Private key (PEM)")
                .textarea()
                .secret()
                .placeholder("-----BEGIN PRIVATE KEY-----"),
            p("scheme", "Scheme")
                .select(RSA_SCHEMES)
                .default("pkcs1v15"),
            p("hash", "Hash").select(RSA_HASHES).default("sha256"),
        ],
    ),
    op(
        "rsa.verify",
        "Signature",
        "RSA verify",
        "`true` when the signature is valid for the input, else `false`.",
        true,
        &[
            p("key", "Public key (PEM)").textarea(),
            p("scheme", "Scheme")
                .select(RSA_SCHEMES)
                .default("pkcs1v15"),
            p("hash", "Hash").select(RSA_HASHES).default("sha256"),
            p("signature", "Signature"),
            p("signature_encoding", "Signature encoding")
                .select(ENCODINGS)
                .default("base64"),
        ],
    ),
    op(
        "rsa.generate",
        "Signature",
        "RSA key pair",
        "A new key pair as JSON {privateKey, publicKey} in PEM.",
        false,
        &[p("bits", "Bits")
            .select(&["2048", "3072", "4096", "1024"])
            .default("2048")],
    ),
    // ── JWT ──────────────────────────────────────────────────────────────────
    op(
        "jwt.sign",
        "JWT",
        "JWT sign",
        "Sign the input (a JSON claims object) into a token.",
        true,
        &[
            JWT_ALG,
            JWT_KEY,
            JWT_KEY_ENCODING,
            p("header", "Extra header (JSON)").placeholder(r#"{"kid":"key-1"}"#),
        ],
    ),
    op(
        "jwt.decode",
        "JWT",
        "JWT decode",
        "Header and payload of the input token, unverified.",
        true,
        &[],
    ),
    op(
        "jwt.verify",
        "JWT",
        "JWT verify",
        "The payload when the signature, exp and nbf check out.",
        true,
        &[JWT_ALG, JWT_KEY, JWT_KEY_ENCODING],
    ),
    // ── JSON ─────────────────────────────────────────────────────────────────
    op(
        "json.get",
        "JSON",
        "Get field",
        "A value by path: a.b[0].c — strings come out without quotes.",
        true,
        &[p("path", "Path").placeholder("data.items[0].id")],
    ),
    op(
        "json.format",
        "JSON",
        "Format",
        "Pretty-print or minify.",
        true,
        &[p("style", "Style")
            .select(&["pretty", "minify"])
            .default("pretty")],
    ),
    // ── compression ──────────────────────────────────────────────────────────
    op(
        "gzip",
        "Compress",
        "Gzip",
        "Gzip-compress the input.",
        true,
        &[],
    ),
    op(
        "gunzip",
        "Compress",
        "Gunzip",
        "Decompress gzip input.",
        true,
        &[],
    ),
];

pub fn find(id: &str) -> Option<&'static OpSpec> {
    CATALOG.iter().find(|o| o.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_unique_and_conditions_name_real_params() {
        let mut ids: Vec<_> = CATALOG.iter().map(|o| o.id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), CATALOG.len(), "duplicate op id");
        for o in CATALOG {
            for prm in o.params {
                if let Some((other, _)) = prm.when {
                    assert!(
                        o.params.iter().any(|q| q.name == other),
                        "{}.{}",
                        o.id,
                        prm.name
                    );
                }
                if prm.kind == "select" {
                    assert!(
                        prm.default.is_empty() || prm.options.contains(&prm.default),
                        "{}.{} default not an option",
                        o.id,
                        prm.name
                    );
                }
            }
        }
    }
}
