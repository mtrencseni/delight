//! SMB support. The UI speaks one portable form everywhere — `smb://[user@]host/share/…`
//! with forward slashes — and this module translates it to whatever the OS
//! wants at the IO boundary. On Windows that's a UNC path (`\\host\share\…`)
//! plus two API calls: NetShareEnum to list a server's shares and
//! WNetAddConnection2W to sign in; everything else is ordinary std::fs over
//! UNC. On macOS SMB works through *mounts* (NetFS), which is not wired up
//! yet — the stubs below return a clear message instead.
//!
//! Passwords never persist and are never echoed back: a `smb://user:pass@host`
//! typed into the path bar is used once to sign in (frontend calls smb_login),
//! then the canonical, password-less form is what gets stored and shown.
//! Windows itself holds the authenticated session after that.

/// Sentinel error meaning "this server wants credentials" — the frontend shows
/// its sign-in dialog and retries. Keep in sync with SMB_AUTH_NEEDED in src/smb.ts.
pub const AUTH_NEEDED: &str = "__smb_auth_required";

pub fn is_smb(path: &str) -> bool {
    path.len() >= 6 && path[..6].eq_ignore_ascii_case("smb://")
}

/// A parsed smb:// URL. `password` only ever holds what the user just typed
/// inline — used once for sign-in, never stored, never re-serialized. The
/// backend itself never reads it (the frontend strips it before sending paths
/// anywhere); parsing it out is what keeps it out of `canonical()`.
pub struct SmbUrl {
    pub user: Option<String>,
    #[allow(dead_code)]
    pub password: Option<String>,
    pub host: String,
    /// share + path below it, '/'-separated, no leading slash; empty at host
    /// level (which lists the server's shares). May carry the archive marker.
    pub rest: String,
}

impl SmbUrl {
    pub fn parse(s: &str) -> Option<SmbUrl> {
        if !is_smb(s) {
            return None;
        }
        let body = &s[6..];
        let (authority, rest) = match body.find('/') {
            Some(i) => (&body[..i], body[i + 1..].trim_start_matches('/')),
            None => (body, ""),
        };
        // rfind: user names can't contain '@' but "user@domain" logins exist —
        // the LAST '@' separates credentials from host.
        let (cred, host) = match authority.rfind('@') {
            Some(i) => (Some(&authority[..i]), &authority[i + 1..]),
            None => (None, authority),
        };
        if host.is_empty() {
            return None;
        }
        let (user, password) = match cred {
            None => (None, None),
            Some(c) => match c.find(':') {
                Some(i) => (Some(c[..i].to_string()), Some(c[i + 1..].to_string())),
                None => (Some(c.to_string()), None),
            },
        };
        Some(SmbUrl {
            user: user.filter(|u| !u.is_empty()),
            password,
            host: host.to_string(),
            rest: rest.trim_end_matches('/').to_string(),
        })
    }

    /// The canonical (password-less) form the UI shows and stores.
    pub fn canonical(&self) -> String {
        let auth = match &self.user {
            Some(u) => format!("{u}@{}", self.host),
            None => self.host.clone(),
        };
        if self.rest.is_empty() {
            format!("smb://{auth}")
        } else {
            format!("smb://{auth}/{}", self.rest)
        }
    }

    /// The host-level canonical form (the server's share listing).
    pub fn host_canonical(&self) -> String {
        match &self.user {
            Some(u) => format!("smb://{u}@{}", self.host),
            None => format!("smb://{}", self.host),
        }
    }
}

/// Where the archive marker splits `s`, honoring the same rule as Loc::parse:
/// a `!` only counts when the text before it names an archive.
fn archive_split_at(s: &str) -> usize {
    for (i, c) in s.char_indices() {
        if c == '!' && crate::archive::is_archive_name(&s[..i]) {
            return i;
        }
    }
    s.len()
}

/// smb:// → the OS-native path string; non-smb input passes through untouched.
/// Windows: `smb://u@host/share/a.zip!x/y` → `\\host\share\a.zip!x/y` — the
/// separator flip stops at the archive boundary, whose inner part is
/// '/'-separated by definition (Loc::parse owns it).
#[cfg(windows)]
pub fn localize(path: &str) -> String {
    let Some(u) = SmbUrl::parse(path) else {
        return path.to_string();
    };
    if u.rest.is_empty() {
        return format!("\\\\{}", u.host);
    }
    let cut = archive_split_at(&u.rest);
    let outer = u.rest[..cut].replace('/', "\\");
    format!("\\\\{}\\{}{}", u.host, outer, &u.rest[cut..])
}

/// macOS/Linux: SMB isn't wired up yet (it goes through NetFS mounts there);
/// pass through so the caller's clear not-supported error surfaces instead.
#[cfg(not(windows))]
pub fn localize(path: &str) -> String {
    path.to_string()
}

/// The inverse, for paths handed back to the UI: a native (UNC) path becomes
/// the canonical smb:// form again, keeping the user@ the pane was addressed
/// with. Non-matching input passes through.
#[cfg(windows)]
pub fn delocalize(native: &str, like: &SmbUrl) -> String {
    // dunce::canonicalize only simplifies verbatim DISK paths (\\?\C:\ → C:\);
    // a canonicalized share keeps the verbatim UNC form, so normalize
    // \\?\UNC\host\share back to \\host\share first — otherwise nothing below
    // matches and the raw \\?\UNC\… would reach the path bar.
    const VERBATIM_UNC: &str = r"\\?\UNC\";
    let owned;
    let native = if native.len() > VERBATIM_UNC.len()
        && native[..VERBATIM_UNC.len()].eq_ignore_ascii_case(VERBATIM_UNC)
    {
        owned = format!(r"\\{}", &native[VERBATIM_UNC.len()..]);
        owned.as_str()
    } else {
        native
    };
    let prefix = format!("\\\\{}", like.host);
    if native.len() < prefix.len() || !native[..prefix.len()].eq_ignore_ascii_case(&prefix) {
        return native.to_string();
    }
    // Trim BOTH ends: Path::parent() on a verbatim UNC path keeps a trailing
    // separator (`\\?\UNC\host\share\`), which would otherwise show up as
    // "smb://host/share/" in the path bar after going up. (A backslash can't
    // occur inside a Windows file name, so this can't eat a real one.)
    let rest = native[prefix.len()..].trim_matches('\\');
    if rest.is_empty() {
        return like.host_canonical();
    }
    let cut = archive_split_at(rest);
    let outer = rest[..cut].replace('\\', "/");
    format!("{}/{}{}", like.host_canonical(), outer, &rest[cut..])
}

/// List a server's shares as directory-like entries. Only disk shares; the
/// administrative/hidden ones (`C$`, `ADMIN$`, …) are marked hidden so they
/// ride the ordinary show-hidden toggle, like dotfiles.
#[cfg(windows)]
pub fn list_shares(host: &str) -> Result<Vec<crate::fs_cmds::Entry>, String> {
    use windows::core::PCWSTR;
    use windows::Win32::NetworkManagement::NetManagement::{NetApiBufferFree, MAX_PREFERRED_LENGTH};
    use windows::Win32::Storage::FileSystem::{NetShareEnum, SHARE_INFO_1};

    let server: Vec<u16> = format!("\\\\{host}").encode_utf16().chain([0]).collect();
    let mut entries = Vec::new();
    let mut resume: u32 = 0;
    loop {
        let mut buf: *mut u8 = std::ptr::null_mut();
        let mut read: u32 = 0;
        let mut total: u32 = 0;
        let status = unsafe {
            NetShareEnum(
                PCWSTR(server.as_ptr()),
                1,
                &mut buf,
                MAX_PREFERRED_LENGTH,
                &mut read,
                &mut total,
                Some(&mut resume),
            )
        };
        const ERROR_MORE_DATA: u32 = 234;
        if status != 0 && status != ERROR_MORE_DATA {
            return Err(match status {
                // Access denied / logon failure → the sign-in flow.
                5 | 1326 => AUTH_NEEDED.into(),
                53 => "Server not found".into(),
                1219 => "Windows already has a session to this server as a different user — disconnect it first (net use \\\\server /delete)".into(),
                _ => format!("Couldn't list shares (Windows error {status})"),
            });
        }
        if !buf.is_null() {
            let infos = unsafe { std::slice::from_raw_parts(buf as *const SHARE_INFO_1, read as usize) };
            for si in infos {
                let raw = si.shi1_type.0;
                // Base type 0 = STYPE_DISKTREE; skip printers, IPC pipes, devices.
                // The top bits flag special (admin) and temporary shares.
                if raw & 0x3FFF_FFFF != 0 {
                    continue;
                }
                let name = unsafe { si.shi1_netname.to_string() }.unwrap_or_default();
                if name.is_empty() {
                    continue;
                }
                let hidden = name.ends_with('$') || raw & 0x8000_0000 != 0;
                entries.push(crate::fs_cmds::Entry {
                    stem: name.clone(),
                    name,
                    ext: None,
                    is_dir: true,
                    is_symlink: false,
                    size: 0,
                    modified_ms: None,
                    created_ms: None,
                    permissions: None,
                    hidden,
                });
            }
            unsafe {
                let _ = NetApiBufferFree(Some(buf as *const _));
            }
        }
        if status != ERROR_MORE_DATA {
            break;
        }
    }
    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(entries)
}

#[cfg(not(windows))]
pub fn list_shares(_host: &str) -> Result<Vec<crate::fs_cmds::Entry>, String> {
    Err(NOT_SUPPORTED.into())
}

#[cfg(not(windows))]
pub const NOT_SUPPORTED: &str =
    "SMB isn't wired up on this platform yet — mount the share in Finder and browse /Volumes";

/// Establish an authenticated session to `host` (via its IPC$ pipe — the
/// standard way to attach credentials to a server without mapping a drive).
/// Windows keeps the session; subsequent UNC access under these credentials
/// just works. Wrong credentials fail HERE, so nothing broken is ever cached.
#[tauri::command]
pub async fn smb_login(host: String, user: String, password: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || do_login(&host, &user, &password))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(windows)]
fn do_login(host: &str, user: &str, password: &str) -> Result<(), String> {
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::NetworkManagement::WNet::{
        WNetAddConnection2W, NETRESOURCEW, NET_CONNECT_FLAGS, RESOURCETYPE_ANY,
    };

    let mut remote: Vec<u16> = format!("\\\\{host}\\IPC$").encode_utf16().chain([0]).collect();
    let user_w: Vec<u16> = user.encode_utf16().chain([0]).collect();
    let pass_w: Vec<u16> = password.encode_utf16().chain([0]).collect();
    let mut res = NETRESOURCEW::default();
    res.dwType = RESOURCETYPE_ANY;
    res.lpRemoteName = PWSTR(remote.as_mut_ptr());
    let status = unsafe {
        WNetAddConnection2W(
            &res,
            PCWSTR(pass_w.as_ptr()),
            PCWSTR(user_w.as_ptr()),
            NET_CONNECT_FLAGS(0),
        )
    };
    match status.0 {
        0 => Ok(()),
        86 | 1326 => Err("Wrong user name or password".into()),
        1219 => Err("Windows already has a session to this server as a different user — disconnect it first (net use \\\\server /delete)".into()),
        5 => Err("Access denied".into()),
        53 | 67 => Err("Server not found".into()),
        n => Err(format!("Couldn't sign in (Windows error {n})")),
    }
}

#[cfg(not(windows))]
fn do_login(_host: &str, _user: &str, _password: &str) -> Result<(), String> {
    Err(NOT_SUPPORTED.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_canonicalizes() {
        let u = SmbUrl::parse("smb://nas/media/photos").unwrap();
        assert_eq!(u.host, "nas");
        assert_eq!(u.rest, "media/photos");
        assert_eq!(u.canonical(), "smb://nas/media/photos");
        assert!(u.user.is_none() && u.password.is_none());
    }

    #[test]
    fn password_parses_out_and_never_reserializes() {
        let u = SmbUrl::parse("smb://marton:hunter2@nas/media").unwrap();
        assert_eq!(u.user.as_deref(), Some("marton"));
        assert_eq!(u.password.as_deref(), Some("hunter2"));
        // The canonical form the UI stores/shows must not carry the password.
        assert_eq!(u.canonical(), "smb://marton@nas/media");
    }

    #[test]
    fn domain_user_logins_keep_their_at_sign() {
        let u = SmbUrl::parse("smb://marton@corp.example@nas/x").unwrap();
        assert_eq!(u.user.as_deref(), Some("marton@corp.example"));
        assert_eq!(u.host, "nas");
    }

    #[test]
    fn host_level_and_trailing_slashes() {
        assert_eq!(SmbUrl::parse("smb://nas").unwrap().rest, "");
        assert_eq!(SmbUrl::parse("smb://nas/").unwrap().rest, "");
        assert_eq!(SmbUrl::parse("SMB://nas/media/").unwrap().rest, "media");
        assert!(SmbUrl::parse("smb://").is_none());
        assert!(SmbUrl::parse("C:\\smb://nope").is_none());
    }

    #[cfg(windows)]
    #[test]
    fn localize_round_trips() {
        assert_eq!(localize("smb://nas/media/a b/c.txt"), r"\\nas\media\a b\c.txt");
        assert_eq!(localize("smb://user@nas"), r"\\nas");
        // The archive boundary stops the separator flip: inner stays '/'.
        assert_eq!(
            localize("smb://nas/media/backup.zip!docs/readme.md"),
            r"\\nas\media\backup.zip!docs/readme.md"
        );
        // A '!' in an ordinary folder name is NOT a boundary (same rule as Loc).
        assert_eq!(localize("smb://nas/my!stuff/file"), r"\\nas\my!stuff\file");

        let like = SmbUrl::parse("smb://user@nas/media").unwrap();
        assert_eq!(delocalize(r"\\nas\media\sub", &like), "smb://user@nas/media/sub");
        // What canonicalize actually returns for a share (dunce only simplifies
        // verbatim DISK paths) — this must not leak to the path bar.
        assert_eq!(
            delocalize(r"\\?\UNC\nas\media\sub", &like),
            "smb://user@nas/media/sub"
        );
        assert_eq!(delocalize(r"\\?\UNC\nas\media", &like), "smb://user@nas/media");
        // Path::parent() on a verbatim UNC path keeps a trailing separator —
        // going up from a subfolder must not yield "…/media/".
        assert_eq!(delocalize(r"\\?\UNC\nas\media\", &like), "smb://user@nas/media");
        assert_eq!(delocalize(r"\\nas\media\", &like), "smb://user@nas/media");
        assert_eq!(delocalize(r"\\NAS\media", &like), "smb://user@nas/media");
        assert_eq!(delocalize(r"\\nas", &like), "smb://user@nas");
        assert_eq!(
            delocalize(r"\\nas\media\backup.zip!docs/x", &like),
            "smb://user@nas/media/backup.zip!docs/x"
        );
        assert_eq!(delocalize(r"C:\other", &like), r"C:\other");
    }

    /// Environment-dependent (needs the Server service): run by hand with
    /// `cargo test -- --ignored`. Every stock Windows exposes hidden admin
    /// shares, so localhost enumeration returning Ok is a real end-to-end check.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn enumerates_localhost_shares() {
        let shares = list_shares("localhost").expect("NetShareEnum against localhost");
        // Typically ADMIN$/C$ etc — all hidden — but any Ok result proves the call.
        for s in &shares {
            assert!(s.is_dir);
        }
    }
}
