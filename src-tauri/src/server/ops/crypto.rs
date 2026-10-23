//! Digests, MACs, AES and RSA over bytes. Everything here is a thin call into the RustCrypto
//! crates; the only logic is choosing the variant from the parameters.

use aes::cipher::{
    block_padding::{NoPadding, Pkcs7},
    BlockDecryptMut, BlockEncryptMut, KeyInit, KeyIvInit, StreamCipher,
};
use aes_gcm::aead::{Aead, Payload};
use hmac::{Hmac, Mac};
use rsa::{
    pkcs1::{DecodeRsaPrivateKey, DecodeRsaPublicKey},
    pkcs1v15,
    pkcs8::{DecodePrivateKey, DecodePublicKey},
    pss,
    signature::{RandomizedSigner, SignatureEncoding, Signer, Verifier},
    Oaep, Pkcs1v15Encrypt, RsaPrivateKey, RsaPublicKey,
};
use sha2::Digest;

// ── digests and MACs ──────────────────────────────────────────────────────────

/// `alg` of `data`: `md5`, `sha1`, `sha256`, `sha384` or `sha512`.
pub fn digest(alg: &str, data: &[u8]) -> Result<Vec<u8>, String> {
    Ok(match alg {
        "md5" => md5::Md5::digest(data).to_vec(),
        "sha1" => sha1::Sha1::digest(data).to_vec(),
        "sha256" => sha2::Sha256::digest(data).to_vec(),
        "sha384" => sha2::Sha384::digest(data).to_vec(),
        "sha512" => sha2::Sha512::digest(data).to_vec(),
        other => return Err(format!("unknown hash `{other}`")),
    })
}

/// HMAC-`alg` of `data` under `key`.
pub fn hmac(alg: &str, key: &[u8], data: &[u8]) -> Result<Vec<u8>, String> {
    fn mac<M: Mac + KeyInit>(key: &[u8], data: &[u8]) -> Vec<u8> {
        let mut m = <M as KeyInit>::new_from_slice(key).expect("HMAC accepts a key of any length");
        m.update(data);
        m.finalize().into_bytes().to_vec()
    }
    Ok(match alg {
        "md5" => mac::<Hmac<md5::Md5>>(key, data),
        "sha1" => mac::<Hmac<sha1::Sha1>>(key, data),
        "sha256" => mac::<Hmac<sha2::Sha256>>(key, data),
        "sha384" => mac::<Hmac<sha2::Sha384>>(key, data),
        "sha512" => mac::<Hmac<sha2::Sha512>>(key, data),
        other => return Err(format!("unknown HMAC hash `{other}`")),
    })
}

// ── AES ───────────────────────────────────────────────────────────────────────

/// What an AES call needs besides the data.
pub struct AesParams<'a> {
    /// `cbc`, `ecb`, `ctr` or `gcm`.
    pub mode: &'a str,
    /// `pkcs7` or `none`; CBC and ECB only.
    pub padding: &'a str,
    /// 16, 24 or 32 bytes: AES-128, -192 or -256.
    pub key: &'a [u8],
    /// 16 bytes for CBC / CTR, 12 for GCM; unused by ECB.
    pub iv: &'a [u8],
    /// GCM additional authenticated data.
    pub aad: &'a [u8],
}

/// Runs `$body` with `$Aes` bound to the AES variant the key length selects.
macro_rules! with_aes {
    ($key:expr, $Aes:ident => $body:expr) => {
        match $key.len() {
            16 => {
                type $Aes = aes::Aes128;
                $body
            }
            24 => {
                type $Aes = aes::Aes192;
                $body
            }
            32 => {
                type $Aes = aes::Aes256;
                $body
            }
            n => Err(format!("an AES key is 16, 24 or 32 bytes, not {n}")),
        }
    };
}

pub fn aes_encrypt(p: &AesParams, data: &[u8]) -> Result<Vec<u8>, String> {
    match p.mode {
        "cbc" => with_aes!(p.key, A => {
            let c = cbc::Encryptor::<A>::new_from_slices(p.key, p.iv).map_err(|_| iv_len("CBC", 16, p.iv))?;
            match padding(p.padding)? {
                Pad::Pkcs7 => Ok(c.encrypt_padded_vec_mut::<Pkcs7>(data)),
                Pad::None => block_aligned(data).map(|()| c.encrypt_padded_vec_mut::<NoPadding>(data)),
            }
        }),
        "ecb" => with_aes!(p.key, A => {
            let c = ecb::Encryptor::<A>::new_from_slice(p.key).map_err(|e| e.to_string())?;
            match padding(p.padding)? {
                Pad::Pkcs7 => Ok(c.encrypt_padded_vec_mut::<Pkcs7>(data)),
                Pad::None => block_aligned(data).map(|()| c.encrypt_padded_vec_mut::<NoPadding>(data)),
            }
        }),
        "ctr" => ctr_apply(p, data),
        "gcm" => gcm(p, data, true),
        other => Err(format!("unknown AES mode `{other}`")),
    }
}

pub fn aes_decrypt(p: &AesParams, data: &[u8]) -> Result<Vec<u8>, String> {
    const BAD_PAD: &str = "decryption failed: wrong key / IV, or the data is not PKCS7-padded";
    match p.mode {
        "cbc" => with_aes!(p.key, A => {
            let c = cbc::Decryptor::<A>::new_from_slices(p.key, p.iv).map_err(|_| iv_len("CBC", 16, p.iv))?;
            match padding(p.padding)? {
                Pad::Pkcs7 => c.decrypt_padded_vec_mut::<Pkcs7>(data).map_err(|_| BAD_PAD.to_string()),
                Pad::None => block_aligned(data).and_then(|()| c.decrypt_padded_vec_mut::<NoPadding>(data).map_err(|e| e.to_string())),
            }
        }),
        "ecb" => with_aes!(p.key, A => {
            let c = ecb::Decryptor::<A>::new_from_slice(p.key).map_err(|e| e.to_string())?;
            match padding(p.padding)? {
                Pad::Pkcs7 => c.decrypt_padded_vec_mut::<Pkcs7>(data).map_err(|_| BAD_PAD.to_string()),
                Pad::None => block_aligned(data).and_then(|()| c.decrypt_padded_vec_mut::<NoPadding>(data).map_err(|e| e.to_string())),
            }
        }),
        "ctr" => ctr_apply(p, data),
        "gcm" => gcm(p, data, false),
        other => Err(format!("unknown AES mode `{other}`")),
    }
}

/// CTR is its own inverse: encrypting and decrypting are the same keystream XOR.
fn ctr_apply(p: &AesParams, data: &[u8]) -> Result<Vec<u8>, String> {
    with_aes!(p.key, A => {
        let mut c = ctr::Ctr128BE::<A>::new_from_slices(p.key, p.iv).map_err(|_| iv_len("CTR", 16, p.iv))?;
        let mut out = data.to_vec();
        c.apply_keystream(&mut out);
        Ok(out)
    })
}

/// GCM with a 12-byte nonce; the 16-byte tag is appended on encrypt and expected at the end on
/// decrypt.
fn gcm(p: &AesParams, data: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
    use aes_gcm::{AesGcm, Nonce};
    type Gcm<A> = AesGcm<A, aes_gcm::aead::consts::U12>;
    if p.iv.len() != 12 {
        return Err(iv_len("GCM", 12, p.iv));
    }
    let nonce = Nonce::from_slice(p.iv);
    let payload = Payload {
        msg: data,
        aad: p.aad,
    };
    with_aes!(p.key, A => {
        let c = Gcm::<A>::new_from_slice(p.key).map_err(|e| e.to_string())?;
        if encrypt {
            c.encrypt(nonce, payload).map_err(|_| "GCM encryption failed".to_string())
        } else {
            c.decrypt(nonce, payload)
                .map_err(|_| "GCM decryption failed: wrong key / nonce / AAD, or the data was altered".to_string())
        }
    })
}

enum Pad {
    Pkcs7,
    None,
}

fn padding(name: &str) -> Result<Pad, String> {
    match name {
        "" | "pkcs7" => Ok(Pad::Pkcs7),
        "none" => Ok(Pad::None),
        other => Err(format!("unknown padding `{other}`")),
    }
}

fn block_aligned(data: &[u8]) -> Result<(), String> {
    if data.len() % 16 == 0 {
        Ok(())
    } else {
        Err(format!(
            "without padding the data must be a multiple of 16 bytes, not {}",
            data.len()
        ))
    }
}

fn iv_len(mode: &str, want: usize, iv: &[u8]) -> String {
    format!("{mode} needs a {want}-byte IV, not {}", iv.len())
}

// ── RSA ───────────────────────────────────────────────────────────────────────

/// A private key from PEM, PKCS#8 (`BEGIN PRIVATE KEY`) or PKCS#1 (`BEGIN RSA PRIVATE KEY`).
pub fn private_key(pem: &str) -> Result<RsaPrivateKey, String> {
    let pem = pem.trim();
    RsaPrivateKey::from_pkcs8_pem(pem)
        .or_else(|_| RsaPrivateKey::from_pkcs1_pem(pem))
        .map_err(|_| "not an RSA private key in PEM (PKCS#8 or PKCS#1)".to_string())
}

/// A public key from PEM (`BEGIN PUBLIC KEY` or `BEGIN RSA PUBLIC KEY`), or the public half of
/// a private key.
pub fn public_key(pem: &str) -> Result<RsaPublicKey, String> {
    let pem = pem.trim();
    RsaPublicKey::from_public_key_pem(pem)
        .or_else(|_| RsaPublicKey::from_pkcs1_pem(pem))
        .or_else(|_| private_key(pem).map(|k| k.to_public_key()))
        .map_err(|_| "not an RSA public (or private) key in PEM".to_string())
}

/// Sign `data`: `scheme` is `pkcs1v15` or `pss`, `hash` is `sha1`, `sha256` or `sha512`.
pub fn rsa_sign(pem: &str, scheme: &str, hash: &str, data: &[u8]) -> Result<Vec<u8>, String> {
    let key = private_key(pem)?;
    let mut rng = rand::thread_rng();
    macro_rules! sign {
        ($H:ty) => {
            match scheme {
                "pkcs1v15" => Ok(pkcs1v15::SigningKey::<$H>::new(key).sign(data).to_vec()),
                "pss" => Ok(pss::BlindedSigningKey::<$H>::new(key)
                    .sign_with_rng(&mut rng, data)
                    .to_vec()),
                other => Err(format!("unknown RSA signature scheme `{other}`")),
            }
        };
    }
    match hash {
        "sha1" => sign!(sha1::Sha1),
        "sha256" => sign!(sha2::Sha256),
        "sha512" => sign!(sha2::Sha512),
        other => Err(format!("unsupported RSA signature hash `{other}`")),
    }
}

/// Whether `signature` is valid for `data`.
pub fn rsa_verify(
    pem: &str,
    scheme: &str,
    hash: &str,
    data: &[u8],
    signature: &[u8],
) -> Result<bool, String> {
    let key = public_key(pem)?;
    macro_rules! verify {
        ($H:ty) => {
            match scheme {
                "pkcs1v15" => {
                    let Ok(sig) = pkcs1v15::Signature::try_from(signature) else {
                        return Ok(false);
                    };
                    Ok(pkcs1v15::VerifyingKey::<$H>::new(key)
                        .verify(data, &sig)
                        .is_ok())
                }
                "pss" => {
                    let Ok(sig) = pss::Signature::try_from(signature) else {
                        return Ok(false);
                    };
                    Ok(pss::VerifyingKey::<$H>::new(key).verify(data, &sig).is_ok())
                }
                other => Err(format!("unknown RSA signature scheme `{other}`")),
            }
        };
    }
    match hash {
        "sha1" => verify!(sha1::Sha1),
        "sha256" => verify!(sha2::Sha256),
        "sha512" => verify!(sha2::Sha512),
        other => Err(format!("unsupported RSA signature hash `{other}`")),
    }
}

/// Encrypt with the public key: `padding` is `oaep-sha256`, `oaep-sha1` or `pkcs1v15`.
pub fn rsa_encrypt(pem: &str, padding: &str, data: &[u8]) -> Result<Vec<u8>, String> {
    let key = public_key(pem)?;
    let mut rng = rand::thread_rng();
    let out = match padding {
        "oaep-sha256" => key.encrypt(&mut rng, Oaep::new::<sha2::Sha256>(), data),
        "oaep-sha1" => key.encrypt(&mut rng, Oaep::new::<sha1::Sha1>(), data),
        "pkcs1v15" => key.encrypt(&mut rng, Pkcs1v15Encrypt, data),
        other => return Err(format!("unknown RSA padding `{other}`")),
    };
    out.map_err(|e| format!("RSA encryption failed: {e}"))
}

/// Decrypt with the private key.
pub fn rsa_decrypt(pem: &str, padding: &str, data: &[u8]) -> Result<Vec<u8>, String> {
    let key = private_key(pem)?;
    let out = match padding {
        "oaep-sha256" => key.decrypt(Oaep::new::<sha2::Sha256>(), data),
        "oaep-sha1" => key.decrypt(Oaep::new::<sha1::Sha1>(), data),
        "pkcs1v15" => key.decrypt(Pkcs1v15Encrypt, data),
        other => return Err(format!("unknown RSA padding `{other}`")),
    };
    out.map_err(|_| "RSA decryption failed: wrong key or padding".to_string())
}

/// A new key pair as PKCS#8 PEM: `(private, public)`.
pub fn rsa_generate(bits: usize) -> Result<(String, String), String> {
    use rsa::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
    if !matches!(bits, 1024 | 2048 | 3072 | 4096) {
        return Err(format!(
            "key size is 1024, 2048, 3072 or 4096 bits, not {bits}"
        ));
    }
    let key = RsaPrivateKey::new(&mut rand::thread_rng(), bits).map_err(|e| e.to_string())?;
    let private = key
        .to_pkcs8_pem(LineEnding::LF)
        .map_err(|e| e.to_string())?
        .to_string();
    let public = key
        .to_public_key()
        .to_public_key_pem(LineEnding::LF)
        .map_err(|e| e.to_string())?;
    Ok((private, public))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::ops::codec::hex_decode;

    fn h(s: &str) -> Vec<u8> {
        hex_decode(s).unwrap()
    }

    #[test]
    fn digests_match_the_published_vectors() {
        // FIPS 180 / RFC 1321 values for "abc".
        assert_eq!(
            hex::encode(digest("md5", b"abc").unwrap()),
            "900150983cd24fb0d6963f7d28e17f72"
        );
        assert_eq!(
            hex::encode(digest("sha1", b"abc").unwrap()),
            "a9993e364706816aba3e25717850c26c9cd0d89d"
        );
        assert_eq!(
            hex::encode(digest("sha256", b"abc").unwrap()),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert!(digest("sha3", b"abc").is_err());
    }

    #[test]
    fn hmac_matches_rfc_4231_case_2() {
        let mac = hmac("sha256", b"Jefe", b"what do ya want for nothing?").unwrap();
        assert_eq!(
            hex::encode(mac),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    #[test]
    fn aes_cbc_matches_nist_sp800_38a_and_round_trips() {
        // SP 800-38A F.2.1, CBC-AES128.Encrypt, first block, no padding.
        let p = AesParams {
            mode: "cbc",
            padding: "none",
            key: &h("2b7e151628aed2a6abf7158809cf4f3c"),
            iv: &h("000102030405060708090a0b0c0d0e0f"),
            aad: &[],
        };
        let ct = aes_encrypt(&p, &h("6bc1bee22e409f96e93d7e117393172a")).unwrap();
        assert_eq!(hex::encode(&ct), "7649abac8119b246cee98e9b12e9197d");
        assert_eq!(
            aes_decrypt(&p, &ct).unwrap(),
            h("6bc1bee22e409f96e93d7e117393172a")
        );
        let padded = AesParams {
            padding: "pkcs7",
            ..p
        };
        let ct = aes_encrypt(&padded, b"hello").unwrap();
        assert_eq!(ct.len(), 16);
        assert_eq!(aes_decrypt(&padded, &ct).unwrap(), b"hello");
    }

    #[test]
    fn aes_ctr_matches_nist_sp800_38a() {
        // SP 800-38A F.5.1, CTR-AES128.Encrypt, first block.
        let p = AesParams {
            mode: "ctr",
            padding: "",
            key: &h("2b7e151628aed2a6abf7158809cf4f3c"),
            iv: &h("f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff"),
            aad: &[],
        };
        let ct = aes_encrypt(&p, &h("6bc1bee22e409f96e93d7e117393172a")).unwrap();
        assert_eq!(hex::encode(ct), "874d6191b620e3261bef6864990db6ce");
    }

    #[test]
    fn aes_gcm_round_trips_and_rejects_tampering() {
        let p = AesParams {
            mode: "gcm",
            padding: "",
            key: &[7u8; 32],
            iv: &[1u8; 12],
            aad: b"header",
        };
        let mut ct = aes_encrypt(&p, b"secret").unwrap();
        assert_eq!(ct.len(), 6 + 16, "ciphertext plus tag");
        assert_eq!(aes_decrypt(&p, &ct).unwrap(), b"secret");
        ct[0] ^= 1;
        assert!(aes_decrypt(&p, &ct).is_err());
    }

    #[test]
    fn aes_explains_bad_parameters() {
        let p = AesParams {
            mode: "cbc",
            padding: "pkcs7",
            key: &[0u8; 10],
            iv: &[0u8; 16],
            aad: &[],
        };
        assert!(aes_encrypt(&p, b"x").unwrap_err().contains("16, 24 or 32"));
        let p = AesParams {
            key: &[0u8; 16],
            iv: &[0u8; 8],
            ..p
        };
        assert!(aes_encrypt(&p, b"x").unwrap_err().contains("16-byte IV"));
        let p = AesParams {
            iv: &[0u8; 16],
            padding: "none",
            ..p
        };
        assert!(aes_encrypt(&p, b"short")
            .unwrap_err()
            .contains("multiple of 16"));
    }

    #[test]
    fn rsa_signs_verifies_encrypts_and_decrypts_with_a_generated_pair() {
        let (private, public) = rsa_generate(1024).unwrap();
        for scheme in ["pkcs1v15", "pss"] {
            let sig = rsa_sign(&private, scheme, "sha256", b"msg").unwrap();
            assert!(rsa_verify(&public, scheme, "sha256", b"msg", &sig).unwrap());
            assert!(!rsa_verify(&public, scheme, "sha256", b"other", &sig).unwrap());
        }
        for padding in ["oaep-sha256", "oaep-sha1", "pkcs1v15"] {
            let ct = rsa_encrypt(&public, padding, b"payload").unwrap();
            assert_eq!(rsa_decrypt(&private, padding, &ct).unwrap(), b"payload");
        }
        assert!(
            public_key(&private).is_ok(),
            "a private key yields its public half"
        );
        assert!(private_key("nope").is_err());
    }
}
