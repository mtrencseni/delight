//! One shared secret, two ways to present it — the same arrangement the Buffers
//! server ended up with, for the same reason: typing a 64-character token into
//! a browser once is fine, typing it on every request is not.
//!
//! The session cookie is *signed, not stored*. Its value is an issue timestamp
//! plus an HMAC over that timestamp, keyed by a value derived from the token —
//! so there is no session table to keep, and rotating `DELIGHT_TOKEN`
//! invalidates every outstanding cookie for free. It is `HttpOnly`, so the page
//! it authenticates cannot read it back, and `SameSite=Lax`, which is also the
//! CSRF story: a cross-site POST carries no cookie, so nothing on another origin
//! can drive the endpoints that write.

use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::time::{SystemTime, UNIX_EPOCH};

pub const COOKIE: &str = "delight_session";
/// A year. Re-authenticating a browser you use daily is friction with no
/// security to show for it; the token itself is the thing that has to stay safe.
const MAX_AGE_SECS: u64 = 365 * 24 * 3600;

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn tag(token: &str, issued: u64) -> String {
    let mut mac = <Hmac<Sha256>>::new_from_slice(format!("delight-session:{token}").as_bytes())
        .expect("HMAC takes a key of any length");
    mac.update(issued.to_string().as_bytes());
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
}

/// The cookie value for a browser that just proved it knows the token.
pub fn issue(token: &str) -> String {
    let issued = now();
    format!("{issued}.{}", tag(token, issued))
}

/// Is this cookie value one we issued, and still young enough?
pub fn verify(token: &str, value: &str) -> bool {
    let Some((issued_s, mac)) = value.split_once('.') else {
        return false;
    };
    let Ok(issued) = issued_s.parse::<u64>() else {
        return false;
    };
    if now().saturating_sub(issued) > MAX_AGE_SECS {
        return false;
    }
    constant_time_eq(mac.as_bytes(), tag(token, issued).as_bytes())
}

/// Does this request carry the raw token in a header? That is how the desktop
/// clients would speak to it, and how `curl` does.
pub fn header_ok(token: &str, sent: Option<&str>) -> bool {
    sent.is_some_and(|s| constant_time_eq(s.as_bytes(), token.as_bytes()))
}

/// Comparison that doesn't return early on the first differing byte. Overkill
/// for a local secret, and exactly the sort of thing that is embarrassing to
/// have skipped if the box ever ends up somewhere noisier.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// The `Set-Cookie` header value for a fresh session.
pub fn set_cookie(value: &str, secure: bool) -> String {
    format!(
        "{COOKIE}={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={MAX_AGE_SECS}{}",
        if secure { "; Secure" } else { "" }
    )
}

/// The `Set-Cookie` header value that ends a session.
pub fn clear_cookie(secure: bool) -> String {
    format!(
        "{COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0{}",
        if secure { "; Secure" } else { "" }
    )
}

/// Pull our cookie out of a `Cookie:` header.
pub fn from_header(header: Option<&str>) -> Option<&str> {
    header?.split(';').find_map(|part| {
        let (k, v) = part.split_once('=')?;
        (k.trim() == COOKIE).then_some(v.trim())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cookie_we_issued_verifies() {
        let c = issue("secret");
        assert!(verify("secret", &c));
    }

    #[test]
    fn rotating_the_token_invalidates_every_cookie() {
        let c = issue("old");
        assert!(!verify("new", &c), "this is the whole point of deriving the key");
    }

    #[test]
    fn a_tampered_cookie_fails() {
        let c = issue("secret");
        let (issued, mac) = c.split_once('.').unwrap();
        // Same shape, different claims.
        assert!(!verify("secret", &format!("{}.{mac}", issued.parse::<u64>().unwrap() + 1)));
        assert!(!verify("secret", &format!("{issued}.{}", "A".repeat(mac.len()))));
        assert!(!verify("secret", "nonsense"));
        assert!(!verify("secret", ""));
    }

    #[test]
    fn an_expired_cookie_fails() {
        let old = now() - (MAX_AGE_SECS + 60);
        assert!(!verify("secret", &format!("{old}.{}", tag("secret", old))));
    }

    #[test]
    fn cookie_is_found_among_others() {
        assert_eq!(
            from_header(Some("a=1; delight_session=xyz; b=2")),
            Some("xyz")
        );
        assert_eq!(from_header(Some("a=1")), None);
        assert_eq!(from_header(None), None);
    }

    #[test]
    fn header_token_is_compared_whole() {
        assert!(header_ok("secret", Some("secret")));
        assert!(!header_ok("secret", Some("secretx")));
        assert!(!header_ok("secret", Some("sec")));
        assert!(!header_ok("secret", None));
    }
}
