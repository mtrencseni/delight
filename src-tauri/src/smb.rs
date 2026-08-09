//! SMB support. The UI speaks one portable form everywhere — `smb://[user@]host/share/…`
//! with forward slashes — and this module translates it to whatever the OS
//! wants at the IO boundary.
//!
//! The two platforms disagree about what SMB *is*, and that disagreement is the
//! whole reason this file has two halves:
//!
//! - **Windows** treats a share as a path. `\\host\share\…` is addressable
//!   without any prior step, so translation is pure string work plus two API
//!   calls: NetShareEnum to list a server's shares, WNetAddConnection2W to sign
//!   in. Everything else is ordinary `std::fs` over UNC.
//! - **macOS** treats a share as a *volume*. Nothing under it is reachable
//!   until the share is mounted, and the mount point is chosen by the system —
//!   `torrents` normally lands on `/Volumes/torrents`, but if that name is
//!   taken it silently becomes `/Volumes/torrents-1`. So translation there has
//!   a side effect (mount on first access) and a lookup (read the real mount
//!   point back from the kernel, never guess it).
//!
//! `localize`/`delocalize` hide both shapes behind one signature, so the rest
//! of the backend translates a path and stops thinking about it. The one place
//! the difference shows through is [`localize_checked`], which is allowed to
//! mount and therefore allowed to fail; navigation calls that, everything
//! downstream calls the infallible `localize`.
//!
//! Passwords never persist and are never echoed back: a `smb://user:pass@host`
//! typed into the path bar is used once to sign in (frontend calls smb_login),
//! then the canonical, password-less form is what gets stored and shown.
//! Windows itself holds the authenticated session after that; macOS has no
//! equivalent server-level session, so the credentials stay in memory for the
//! app's lifetime and are handed to NetFS per mount (see `mac::login`).

/// Sentinel error meaning "this server wants credentials" — the frontend shows
/// its sign-in dialog and retries. Keep in sync with SMB_AUTH_NEEDED in src/smb.ts.
pub const AUTH_NEEDED: &str = "__smb_auth_required";

pub fn is_smb(path: &str) -> bool {
    path.len() >= 6 && path[..6].eq_ignore_ascii_case("smb://")
}

/// Does a failed listing mean "the server wants credentials" rather than
/// "that folder isn't there"? Windows only learns this from the IO error, so
/// the shapes it can arrive in are listed here; macOS resolves auth while
/// mounting and hands back the sentinel directly.
#[cfg(windows)]
pub fn is_auth_error(e: &str) -> bool {
    // On a share, "Permission denied" overwhelmingly means "no session yet".
    // Logon failures come through as raw os errors (1326 bad creds, 86 bad
    // password).
    e == "Permission denied" || e.contains("os error 1326") || e.contains("os error 86")
}

#[cfg(not(windows))]
pub fn is_auth_error(e: &str) -> bool {
    e.contains(AUTH_NEEDED)
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
/// a `!` only counts when the text before it names an archive. Windows-only:
/// it exists to stop the '/'→'\' flip at the archive boundary, and macOS paths
/// are already '/'-separated, so there is no flip there to stop.
#[cfg(windows)]
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

/// macOS: the mounted path, if the share is mounted. See `mac::localize`.
#[cfg(target_os = "macos")]
pub fn localize(path: &str) -> String {
    mac::localize(path)
}

/// Linux: SMB isn't wired up yet; pass through so the caller's clear
/// not-supported error surfaces instead.
#[cfg(not(any(windows, target_os = "macos")))]
pub fn localize(path: &str) -> String {
    path.to_string()
}

/// `localize`, for the one caller allowed to have side effects and to fail:
/// navigation. On macOS this is where a share is mounted (on first access, and
/// never unmounted); on Windows there is nothing to prepare, so it's just
/// `localize`. Splitting it out is what keeps the mount off the many callers
/// that merely translate a path on the way to a stat — some of them on the UI
/// thread, where a network round trip would be a freeze.
#[cfg(windows)]
pub fn localize_checked(path: &str) -> Result<String, String> {
    Ok(localize(path))
}

#[cfg(target_os = "macos")]
pub fn localize_checked(path: &str) -> Result<String, String> {
    mac::localize_checked(path)
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn localize_checked(_path: &str) -> Result<String, String> {
    Err(NOT_SUPPORTED.into())
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

/// macOS: a real mounted path becomes the portable smb:// form again.
/// See `mac::delocalize`.
#[cfg(target_os = "macos")]
pub fn delocalize(native: &str, like: &SmbUrl) -> String {
    mac::delocalize(native, like)
}

/// List a server's shares as directory-like entries. Only disk shares; the
/// administrative/hidden ones (`C$`, `ADMIN$`, …) are marked hidden so they
/// ride the ordinary show-hidden toggle, like dotfiles. Takes the whole URL,
/// not just the host, because the user it was addressed with is part of the
/// question on macOS (which identity is asking).
#[cfg(windows)]
pub fn list_shares(url: &SmbUrl) -> Result<Vec<crate::fs_cmds::Entry>, String> {
    let host = &url.host;
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

#[cfg(target_os = "macos")]
pub fn list_shares(url: &SmbUrl) -> Result<Vec<crate::fs_cmds::Entry>, String> {
    mac::list_shares(url)
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn list_shares(_url: &SmbUrl) -> Result<Vec<crate::fs_cmds::Entry>, String> {
    Err(NOT_SUPPORTED.into())
}

#[cfg(not(any(windows, target_os = "macos")))]
pub const NOT_SUPPORTED: &str =
    "SMB isn't wired up on this platform yet — mount the share with your file manager and browse it \
     as an ordinary folder";

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

#[cfg(target_os = "macos")]
fn do_login(host: &str, user: &str, password: &str) -> Result<(), String> {
    mac::login(host, user, password)
}

#[cfg(not(any(windows, target_os = "macos")))]
fn do_login(_host: &str, _user: &str, _password: &str) -> Result<(), String> {
    Err(NOT_SUPPORTED.into())
}

/// The macOS half: mounts instead of paths.
///
/// Three facts drive everything here:
///
/// 1. **The mount point is the system's to choose.** A share called `torrents`
///    normally appears at `/Volumes/torrents`, but if anything already owns
///    that name it becomes `/Volumes/torrents-1` without a word. So the path is
///    always read back — from NetFS's own answer when we just mounted, and from
///    the kernel's mount table otherwise. Nothing in this file builds a
///    `/Volumes/…` path by hand.
/// 2. **Mounting is the system's job too.** NetFS is what Finder's "Connect to
///    Server" drives, so going through it means the Keychain answers for a
///    server the user has already connected to, and a password we do hold is
///    passed as an argument to a C function rather than on a command line where
///    `ps` would show it.
/// 3. **Enumerating shares must not mount anything.** `smbutil view` asks the
///    server for its share list over a plain session, so opening a server in
///    the pane stays side-effect-free; a mount happens only when you enter a
///    share.
#[cfg(target_os = "macos")]
mod mac {
    use super::{SmbUrl, AUTH_NEEDED};
    use crate::fs_cmds::Entry;
    use objc2_core_foundation::{CFArray, CFMutableDictionary, CFRetained, CFString, CFURL};
    use std::collections::HashMap;
    use std::ffi::c_void;
    use std::sync::{Mutex, OnceLock};

    // ---- credentials ----------------------------------------------------------

    /// What the user typed into the sign-in dialog, keyed by lowercased host.
    /// Held for the app's lifetime and nowhere else: never written to disk,
    /// never placed in a process argument list, never logged. This is the macOS
    /// stand-in for the session Windows keeps after WNetAddConnection2W — the
    /// difference being that there the OS holds it, and here we do.
    fn creds() -> &'static Mutex<HashMap<String, (String, String)>> {
        static CREDS: OnceLock<Mutex<HashMap<String, (String, String)>>> = OnceLock::new();
        CREDS.get_or_init(Default::default)
    }

    fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
        // A panic elsewhere must not turn a poisoned lock into a dead SMB stack.
        m.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn cred_for(host: &str) -> Option<(String, String)> {
        lock(creds()).get(&host.to_lowercase()).cloned()
    }

    /// Remember credentials for this host. Unlike Windows — where
    /// WNetAddConnection2W validates on the spot, so nothing broken is ever
    /// cached — macOS exposes no public call that authenticates to a server
    /// *without* also mounting something, and mounting speculatively to check a
    /// password would be a side effect the user didn't ask for. So wrong
    /// credentials surface on the next mount instead of here. That is already
    /// the frontend's loop: the retry fails, `smbSignIn` re-opens the dialog
    /// with the error as its hint.
    pub fn login(host: &str, user: &str, password: &str) -> Result<(), String> {
        if host.is_empty() {
            return Err("No server to sign in to".into());
        }
        if user.is_empty() {
            return Err("A user name is required".into());
        }
        lock(creds()).insert(
            host.to_lowercase(),
            (user.to_string(), password.to_string()),
        );
        Ok(())
    }

    // ---- the mount table ------------------------------------------------------

    /// One mounted SMB volume, as the kernel reports it.
    struct Mount {
        host: String,
        share: String,
        point: String,
    }

    /// A fixed-size C string field (`statfs`'s name arrays) as a String.
    fn c_str(buf: &[libc::c_char]) -> String {
        // SAFETY: c_char and u8 have the same size and alignment; we only read.
        let bytes = unsafe { std::slice::from_raw_parts(buf.as_ptr() as *const u8, buf.len()) };
        let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
        String::from_utf8_lossy(&bytes[..end]).into_owned()
    }

    /// Every mounted smbfs volume. This is the authority on where a share lives
    /// — see fact 1 in the module comment.
    fn smb_mounts() -> Vec<Mount> {
        // getmntinfo returns a pointer into a static buffer that it reuses, so
        // two threads calling it at once would read each other's results.
        static LOCK: Mutex<()> = Mutex::new(());
        let _guard = lock(&LOCK);
        let mut buf: *mut libc::statfs = std::ptr::null_mut();
        // SAFETY: getmntinfo writes a pointer to `n` statfs records into `buf`;
        // they stay valid until the next call, which the lock above serializes.
        let n = unsafe { libc::getmntinfo(&mut buf, libc::MNT_NOWAIT) };
        if n <= 0 || buf.is_null() {
            return Vec::new();
        }
        let list = unsafe { std::slice::from_raw_parts(buf, n as usize) };
        list.iter()
            .filter(|fs| c_str(&fs.f_fstypename) == "smbfs")
            .filter_map(|fs| {
                let (host, share) = split_mntfrom(&c_str(&fs.f_mntfromname))?;
                Some(Mount { host, share, point: c_str(&fs.f_mntonname) })
            })
            .collect()
    }

    /// Split smbfs's `f_mntfromname` — `//[domain;][user@]host/share` — into
    /// host and share.
    fn split_mntfrom(from: &str) -> Option<(String, String)> {
        let (authority, share) = from.strip_prefix("//")?.split_once('/')?;
        // Last '@': a domain login spells the user "domain;user" or "user@domain".
        let host = match authority.rfind('@') {
            Some(i) => &authority[i + 1..],
            None => authority,
        };
        let share = share.trim_matches('/');
        if host.is_empty() || share.is_empty() {
            return None;
        }
        Some((host.to_string(), share.to_string()))
    }

    /// Whether two spellings name the same server. Exact ignoring case, plus the
    /// one difference that actually turns up: the portable URL carries the bare
    /// name a Windows favorite was saved with (`powerplant`) while the mount
    /// table carries what Bonjour resolved it to (`powerplant.local`). The
    /// digits guard keeps this away from IPv4 literals, where `192` is a prefix
    /// of every 192.x.x.x host on earth.
    fn same_host(a: &str, b: &str) -> bool {
        if a.eq_ignore_ascii_case(b) {
            return true;
        }
        let suffixed = |short: &str, long: &str| {
            !short.is_empty()
                && !short.bytes().all(|c| c.is_ascii_digit() || c == b'.')
                && long.len() > short.len()
                && long.as_bytes()[short.len()] == b'.'
                && long[..short.len()].eq_ignore_ascii_case(short)
        };
        suffixed(a, b) || suffixed(b, a)
    }

    /// EVERY place this share is mounted. Usually one, but a share can honestly
    /// be mounted twice — the user mounted it in Finder under one name and
    /// something else mounted it again — and then `/Volumes/torrents` and
    /// `/Volumes/torrents-1` are both it. Share names are case-insensitive on
    /// SMB, so the comparison is too.
    fn mount_points(host: &str, share: &str) -> Vec<String> {
        smb_mounts()
            .into_iter()
            .filter(|m| same_host(&m.host, host) && m.share.eq_ignore_ascii_case(share))
            .map(|m| m.point)
            .collect()
    }

    /// Where this share is mounted right now, if it is. Any of them will do to
    /// reach the data — they're the same volume.
    fn mount_point(host: &str, share: &str) -> Option<String> {
        mount_points(host, share).into_iter().next()
    }

    /// Split `share/below/that` into the share — the part that gets mounted —
    /// and the path under it. The archive marker rides along untouched in the
    /// remainder: macOS paths are already '/'-separated, so unlike Windows there
    /// is no separator flip that could run past the `!`.
    fn split_share(rest: &str) -> Option<(&str, &str)> {
        let rest = rest.trim_matches('/');
        if rest.is_empty() {
            return None;
        }
        Some(match rest.split_once('/') {
            Some((share, sub)) => (share, sub),
            None => (rest, ""),
        })
    }

    fn join(point: &str, sub: &str) -> String {
        if sub.is_empty() {
            point.to_string()
        } else {
            format!("{}/{}", point.trim_end_matches('/'), sub)
        }
    }

    // ---- translation ----------------------------------------------------------

    /// smb:// → the mounted path, if the share is mounted. Deliberately PURE:
    /// it never mounts, because most callers only want a path on the way to a
    /// stat and some of them run on the UI thread. An unmounted (or malformed)
    /// path comes back unchanged and fails downstream as a missing file, which
    /// is exactly what it is.
    pub fn localize(path: &str) -> String {
        let Some(u) = SmbUrl::parse(path) else {
            return path.to_string();
        };
        let Some((share, sub)) = split_share(&u.rest) else {
            return path.to_string();
        };
        match mount_point(&u.host, share) {
            Some(point) => join(&point, sub),
            None => path.to_string(),
        }
    }

    /// The navigation path: mount the share if it isn't mounted, then translate.
    /// Mounted volumes are left alone afterwards — Delight never unmounts, the
    /// same way it never closes a Finder window it didn't open.
    pub fn localize_checked(path: &str) -> Result<String, String> {
        let u = SmbUrl::parse(path).ok_or("Not a valid smb:// path")?;
        let (share, sub) = split_share(&u.rest)
            .ok_or("An smb:// path needs a share — try smb://server/share")?;
        let point = match mount_point(&u.host, share) {
            Some(p) => p,
            None => mount(&u, share)?,
        };
        Ok(join(&point, sub))
    }

    /// The inverse, for paths handed back to the UI. Anything outside the
    /// share's mount point comes back unchanged — notably `/Volumes` itself,
    /// which is what `Path::parent()` yields at a mount root; the caller
    /// recognizes that it isn't an smb:// path and substitutes the share list.
    pub fn delocalize(native: &str, like: &SmbUrl) -> String {
        let Some((share, _)) = split_share(&like.rest) else {
            return native.to_string();
        };
        // Against EVERY mount of this share, not just the first: if the volume
        // is mounted twice, the listing we're translating came from one
        // particular mount point, and matching only the other one would send a
        // raw /Volumes path to the path bar. (That is exactly what happened the
        // first time this ran against a real server.)
        let Some(sub) = mount_points(&like.host, share)
            .iter()
            .find_map(|point| strip_mount(native, point))
        else {
            return native.to_string();
        };
        let head = format!("{}/{}", like.host_canonical(), share);
        if sub.is_empty() {
            head
        } else {
            format!("{head}/{sub}")
        }
    }

    /// `native` relative to a mount point, or None if it isn't under it.
    fn strip_mount(native: &str, point: &str) -> Option<String> {
        let point = point.trim_end_matches('/');
        if native.trim_end_matches('/').eq_ignore_ascii_case(point) {
            return Some(String::new());
        }
        // The separator boundary is the point: without it /Volumes/torrents
        // would swallow /Volumes/torrents-1, which is a DIFFERENT volume. It
        // also guarantees a char boundary to slice at.
        if native.len() > point.len()
            && native.as_bytes()[point.len()] == b'/'
            && native[..point.len()].eq_ignore_ascii_case(point)
        {
            return Some(native[point.len() + 1..].trim_matches('/').to_string());
        }
        None
    }

    // ---- mounting (NetFS) -----------------------------------------------------

    #[link(name = "NetFS", kind = "framework")]
    extern "C" {
        /// `NetFSMountURLSync(url, mountpath, user, passwd, open_options,
        /// mount_options, mountpoints)` — the call behind Finder's Connect to
        /// Server. Declared with raw pointers because every argument is
        /// optional; 0 means mounted, a positive result is an errno and a
        /// negative one an OSStatus (see NetFS.h).
        fn NetFSMountURLSync(
            url: *const c_void,
            mountpath: *const c_void,
            user: *const c_void,
            passwd: *const c_void,
            open_options: *const c_void,
            mount_options: *const c_void,
            mountpoints: *mut *const c_void,
        ) -> i32;
    }

    fn cf<T: objc2_core_foundation::Type>(r: &CFRetained<T>) -> *const c_void {
        CFRetained::as_ptr(r).as_ptr() as *const c_void
    }

    /// Percent-encode one URL path segment: a share named "My Files" has to
    /// reach CFURL as "My%20Files" or the URL doesn't parse at all.
    fn enc(s: &str) -> String {
        let mut out = String::with_capacity(s.len());
        for b in s.bytes() {
            match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                    out.push(b as char)
                }
                _ => out.push_str(&format!("%{b:02X}")),
            }
        }
        out
    }

    fn mount(url: &SmbUrl, share: &str) -> Result<String, String> {
        // Two panes opening the same share at once must not both mount it. The
        // loser of that race doesn't fail — it succeeds, at
        // /Volumes/<share>-1, leaving two volumes for one share and a listing
        // whose paths translate against the wrong one. (Found by running the
        // live tests in parallel, which is the same race.)
        //
        // One lock for all mounts rather than one per share: mounting is rare,
        // and the cost of the simplification is that a mount of an unreachable
        // server delays a mount of a healthy one until NetFS gives up.
        static MOUNTING: Mutex<()> = Mutex::new(());
        let _guard = lock(&MOUNTING);
        // Re-check under the lock — whoever we queued behind may have been
        // mounting exactly this.
        if let Some(point) = mount_point(&url.host, share) {
            return Ok(point);
        }

        // The host goes in as typed — a hostname is already URL-safe, and if it
        // isn't, CFURL rejects the whole thing and says so. Only the share is
        // escaped: that one really can contain spaces.
        let target = format!("smb://{}/{}", url.host, enc(share));
        let cf_url = CFURL::from_string(None, &CFString::from_str(&target), None)
            .ok_or_else(|| format!("Not a valid server address: {}", url.host))?;

        // NoUI: Delight has its own sign-in dialog, and a system password panel
        // appearing behind the app would be a dead end. Suppressing the UI does
        // NOT suppress the Keychain — a share the user already connected to in
        // Finder still mounts without anyone being asked anything.
        let open = CFMutableDictionary::<CFString, CFString>::empty();
        open.set(&CFString::from_str("UIOption"), &CFString::from_str("NoUI"));

        // What the user typed into our dialog this session, else the user the
        // path was addressed with. Passing them here (rather than in the URL)
        // is what keeps the password out of anything observable.
        let cred = cred_for(&url.host);
        let user = cred
            .as_ref()
            .map(|c| c.0.clone())
            .or_else(|| url.user.clone())
            .map(|u| CFString::from_str(&u));
        let pass = cred.as_ref().map(|c| CFString::from_str(&c.1));

        let mut points: *const c_void = std::ptr::null();
        // SAFETY: every pointer is null or a live CF object owned by this frame.
        // `points` receives a +1 CFArray, taken over by CFRetained::from_raw.
        let rc = unsafe {
            NetFSMountURLSync(
                cf(&cf_url),
                std::ptr::null(), // default mount directory (/Volumes)
                user.as_ref().map_or(std::ptr::null(), cf),
                pass.as_ref().map_or(std::ptr::null(), cf),
                cf(&open),
                // No mount options: NetFS already defaults kNetFSSoftMountKey to
                // true, so a server that vanishes fails the IO instead of
                // wedging the app in an uninterruptible wait.
                std::ptr::null(),
                &mut points,
            )
        };
        let mounted = std::ptr::NonNull::new(points as *mut CFArray<CFString>)
            .map(|p| unsafe { CFRetained::from_raw(p) });
        if rc != 0 {
            return Err(mount_error(rc, &url.host));
        }
        // Where it actually landed, straight from NetFS — never assumed.
        if let Some(point) = mounted.as_ref().and_then(|a| a.get(0)) {
            return Ok(point.to_string());
        }
        // NetFS can report success without naming a mount point (an already
        // mounted share); the kernel still knows where it is.
        mount_point(&url.host, share)
            .ok_or_else(|| format!("Mounted {share}, but the system reported no mount point"))
    }

    /// The SMB server's own NTSTATUS, sign-extended, for "that share is not
    /// available to you" — see the arm that uses it.
    const NT_BAD_OR_FORBIDDEN_SHARE: i32 = 0xC000_019Cu32 as i32;

    /// NetFS returns 0 for success, a positive errno, or a negative OSStatus
    /// (NetFS.h documents the extended set). Only the outcomes a user can act
    /// on get their own wording; the rest keep their number so a bug report can
    /// be looked up.
    fn mount_error(rc: i32, host: &str) -> String {
        match rc {
            // Everything that means "these credentials won't do" becomes the
            // sentinel, so the frontend opens its sign-in dialog and retries.
            libc::EPERM | libc::EACCES | libc::EAUTH | libc::ENEEDAUTH => AUTH_NEEDED.to_string(),
            // ENETFSPWDNEEDSCHANGE / ENETFSPWDPOLICY / ENETFSNOAUTHMECHSUPP /
            // ENETFSACCOUNTRESTRICTED / kNetAuthErrorGuestNotSupported.
            -5045 | -5046 | -5997 | -5999 | -6004 => AUTH_NEEDED.to_string(),
            libc::ENOENT => format!("No such share on {host}"),
            // 0xC000019C, as an NTSTATUS sign-extended into an i32. Observed
            // against a real Windows server for BOTH a share that doesn't exist
            // and one the current identity may not open (an admin share as a
            // normal user) — the server doesn't distinguish the two, and
            // neither can we. Deliberately NOT the auth sentinel: a mistyped
            // share name would then reopen the sign-in dialog forever, and a
            // different account is only one of the two things that could be
            // wrong. Signing in as someone else is still available by typing
            // smb://user@server/share.
            NT_BAD_OR_FORBIDDEN_SHARE => {
                format!("Can't open that share on {host} — no such share, or this account can't use it")
            }
            // ENETFSNOSHARESAVAIL / kNetAuthErrorNoSharesAvailable.
            -5998 | -6003 => format!("{host} has no shares available to this account"),
            -128 => "Cancelled".into(),
            -5996 => format!("{host} wants an SMB version macOS won't negotiate"),
            libc::ETIMEDOUT
            | libc::ECONNREFUSED
            | libc::ECONNRESET
            | libc::EHOSTDOWN
            | libc::EHOSTUNREACH
            | libc::ENETDOWN
            | libc::ENETUNREACH => format!("Can't reach {host}"),
            n if n > 0 => format!(
                "Couldn't mount the share: {}",
                std::io::Error::from_raw_os_error(n)
            ),
            n => format!("Couldn't mount the share (NetFS error {n})"),
        }
    }

    // ---- share enumeration (smbutil) ------------------------------------------

    /// `smbutil view` exits with EX_NOPERM when the server turns the identity
    /// away — the one failure that should become a sign-in prompt rather than
    /// an error message.
    const EX_NOPERM: i32 = 77;

    /// smbutil spells a domain login `//DOMAIN;user@server`, where the portable
    /// URL spells it `user@domain` (which is what Windows accepts). Translate,
    /// so the same favorite works on both.
    fn smbutil_authority(user: Option<&str>, host: &str) -> String {
        match user {
            Some(u) => match u.split_once('@') {
                Some((u, domain)) => format!("//{domain};{u}@{host}"),
                None => format!("//{u}@{host}"),
            },
            None => format!("//{host}"),
        }
    }

    /// The spellings of a host worth trying, in order. `smbutil` resolves names
    /// through DNS/mDNS only — it does not do the NetBIOS lookup that makes a
    /// bare `powerplant` work on Windows — so a bare name gets a second shot as
    /// `powerplant.local`, which is how Bonjour knows the same machine. (NetFS,
    /// which does the mounting, resolves the bare name on its own; this is
    /// needed only here.)
    fn host_spellings(host: &str) -> Vec<String> {
        let mut out = vec![host.to_string()];
        if !host.contains('.') && !host.is_empty() {
            out.push(format!("{host}.local"));
        }
        out
    }

    pub fn list_shares(url: &SmbUrl) -> Result<Vec<Entry>, String> {
        let user = url
            .user
            .clone()
            .or_else(|| cred_for(&url.host).map(|c| c.0));
        let mut last = String::new();
        for host in host_spellings(&url.host) {
            let target = smbutil_authority(user.as_deref(), &host);
            // -N: never prompt. smbutil on current macOS doesn't prompt at all —
            // it answers from the Keychain or an already-open session, or fails
            // — so -N only makes that explicit and guarantees we can't hang.
            let out = std::process::Command::new("smbutil")
                .args(["view", "-N", &target])
                .output()
                .map_err(|e| format!("Couldn't run smbutil: {e}"))?;
            if out.status.success() {
                return parse_shares(&String::from_utf8_lossy(&out.stdout));
            }
            if out.status.code() == Some(EX_NOPERM) {
                return Err(AUTH_NEEDED.into());
            }
            last = smbutil_error(&out);
        }
        Err(last)
    }

    /// smbutil writes one line to stderr, already phrased for a human
    /// ("server connection failed: …"); keep it, minus the program name.
    fn smbutil_error(out: &std::process::Output) -> String {
        let msg = String::from_utf8_lossy(&out.stderr);
        let msg = msg.trim();
        let msg = msg.strip_prefix("smbutil:").unwrap_or(msg).trim();
        if msg.is_empty() {
            "Couldn't list the server's shares".into()
        } else {
            msg.to_string()
        }
    }

    /// Turn `smbutil view`'s table into entries:
    ///
    /// ```text
    /// Share                                           Type       Comments
    /// -------------------------------------------------------------
    /// torrents                                        Disk
    /// IPC$                                            Pipe
    /// ```
    ///
    /// The columns are fixed-width, but the width follows the longest share
    /// name, so it's measured off the header rather than hardcoded — and read
    /// as columns, not whitespace-split tokens, because share names may contain
    /// spaces.
    fn parse_shares(out: &str) -> Result<Vec<Entry>, String> {
        let Some(type_col) = out.lines().find_map(header_type_col) else {
            return Err(format!(
                "Couldn't read the share list from smbutil: {}",
                out.lines().next().unwrap_or("(no output)")
            ));
        };
        let mut entries: Vec<Entry> = out
            .lines()
            .skip_while(|l| header_type_col(l).is_none())
            .skip(1)
            .filter(|l| !l.trim().is_empty() && !l.trim_start().starts_with('-'))
            .map(|l| cut(l, type_col))
            .filter(|(name, kind)| !name.is_empty() && kind.eq_ignore_ascii_case("disk"))
            .map(|(name, _)| {
                // Same rule as Windows: administrative shares end in '$' and are
                // marked hidden, so they ride the ordinary dotfile toggle.
                let hidden = name.ends_with('$');
                Entry {
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
                }
            })
            .collect();
        entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(entries)
    }

    /// The char offset of the "Type" column in the table header, if this is it.
    fn header_type_col(line: &str) -> Option<usize> {
        if !line.trim_start().starts_with("Share") {
            return None;
        }
        line.char_indices()
            .position(|(i, _)| line[i..].starts_with("Type"))
    }

    /// Split a table row at a CHAR offset (a share name can hold non-ASCII, so
    /// byte offsets from the ASCII header wouldn't line up).
    fn cut(line: &str, col: usize) -> (String, String) {
        let split = line
            .char_indices()
            .nth(col)
            .map_or(line.len(), |(i, _)| i);
        let (name, rest) = line.split_at(split);
        (
            name.trim().to_string(),
            rest.split_whitespace().next().unwrap_or("").to_string(),
        )
    }

    #[cfg(test)]
    mod unit {
        use super::*;

        #[test]
        fn mntfromname_splits_into_host_and_share() {
            assert_eq!(
                split_mntfrom("//mtrencseni@powerplant/torrents"),
                Some(("powerplant".into(), "torrents".into()))
            );
            assert_eq!(
                split_mntfrom("//powerplant.local/Data"),
                Some(("powerplant.local".into(), "Data".into()))
            );
            // A domain login keeps its host, not the domain before the ';'.
            assert_eq!(
                split_mntfrom("//CORP;marton@nas/media"),
                Some(("nas".into(), "media".into()))
            );
            assert_eq!(split_mntfrom("/dev/disk3s1"), None);
            assert_eq!(split_mntfrom("//nas"), None);
        }

        #[test]
        fn bonjour_suffix_matches_but_ip_prefixes_do_not() {
            assert!(same_host("powerplant", "powerplant.local"));
            assert!(same_host("POWERPLANT.local", "powerplant"));
            assert!(same_host("nas", "nas"));
            assert!(!same_host("nas", "nas2"));
            assert!(!same_host("power", "powerplant.local"));
            // The trap this guard exists for: every 192.x host shares a prefix.
            assert!(!same_host("192", "192.168.1.16"));
            assert!(!same_host("192.168.1.16", "192.168.1.160"));
        }

        #[test]
        fn share_splits_off_the_first_segment_and_keeps_archive_markers() {
            assert_eq!(split_share("torrents"), Some(("torrents", "")));
            assert_eq!(split_share("/torrents/"), Some(("torrents", "")));
            assert_eq!(split_share("media/a b/c.txt"), Some(("media", "a b/c.txt")));
            // No separator flip on macOS, so the marker just rides along whole.
            assert_eq!(
                split_share("media/backup.zip!docs/readme.md"),
                Some(("media", "backup.zip!docs/readme.md"))
            );
            assert_eq!(split_share(""), None);
        }

        #[test]
        fn a_sibling_mount_point_is_not_inside_this_one() {
            let p = "/Volumes/torrents";
            assert_eq!(strip_mount(p, p), Some(String::new()));
            assert_eq!(strip_mount("/Volumes/torrents/", p), Some(String::new()));
            assert_eq!(strip_mount("/Volumes/torrents/a/b.txt", p), Some("a/b.txt".into()));
            // What a live run actually produced: mounting the same share twice
            // gives /Volumes/torrents AND /Volumes/torrents-1, two different
            // volumes whose paths must never be read as one containing the other.
            assert_eq!(strip_mount("/Volumes/torrents-1/a", p), None);
            // The native parent of a mount root leaves the SMB tree entirely.
            assert_eq!(strip_mount("/Volumes", p), None);
        }

        #[test]
        fn domain_logins_get_smbutils_spelling() {
            assert_eq!(smbutil_authority(None, "nas"), "//nas");
            assert_eq!(smbutil_authority(Some("marton"), "nas"), "//marton@nas");
            assert_eq!(
                smbutil_authority(Some("marton@corp.example"), "nas"),
                "//corp.example;marton@nas"
            );
        }

        #[test]
        fn bare_names_get_a_bonjour_second_chance() {
            assert_eq!(host_spellings("powerplant"), ["powerplant", "powerplant.local"]);
            // Already qualified (or an IP): one spelling, no guessing.
            assert_eq!(host_spellings("nas.example.com"), ["nas.example.com"]);
            assert_eq!(host_spellings("192.168.1.16"), ["192.168.1.16"]);
        }

        #[test]
        fn share_table_parses_by_column_not_by_token() {
            let out = "\
Share                                           Type       Comments
-------------------------------------------------------------
torrents                                        Disk
My Files                                        Disk       has spaces
C$                                              Disk       Default share
IPC$                                            Pipe       Remote IPC
Brother HL-2270DW                               Printer

4 shares listed from 5 available
";
            let e = parse_shares(out).expect("parses");
            let names: Vec<&str> = e.iter().map(|x| x.name.as_str()).collect();
            // Disk shares only — no pipes, no printers. Sorted, like Windows.
            assert_eq!(names, ["C$", "My Files", "torrents"]);
            assert!(e.iter().all(|x| x.is_dir));
            // '$' shares ride the dotfile toggle, exactly as on Windows.
            assert_eq!(e.iter().find(|x| x.name == "C$").unwrap().hidden, true);
            assert_eq!(e.iter().find(|x| x.name == "torrents").unwrap().hidden, false);
        }

        #[test]
        fn an_unrecognizable_table_is_an_error_not_an_empty_folder() {
            // Silently returning "no shares" would look like an empty server.
            assert!(parse_shares("smbutil: something new went wrong\n").is_err());
        }

        #[test]
        fn credentials_are_kept_per_host_case_insensitively() {
            login("MixedCaseHost", "marton", "hunter2").unwrap();
            assert_eq!(
                cred_for("mixedcasehost"),
                Some(("marton".into(), "hunter2".into()))
            );
            assert!(login("nas", "", "x").is_err(), "a user name is required");
        }

        /// What the user sees when a mount DOESN'T work — the half of the
        /// feature that unit tests can't reach, since every message here comes
        /// from a real server refusing something.
        ///
        /// The two refusals must not be confused, because they lead opposite
        /// ways: credentials the server rejects have to reopen the sign-in
        /// dialog, while a share that identity can't open has to say so and
        /// stop (looping the dialog on a mistyped share name is a trap).
        ///
        /// Point it with `DELIGHT_SMB_PROBE_HOST=server`. Deliberately one test
        /// doing an ordered sequence: the credential cache and the SMB session
        /// are per-process and per-server, so this cannot be split into
        /// independent tests that Rust would run concurrently.
        ///
        /// The bogus user name is not a placeholder — a wrong password against
        /// the user's REAL account would feed that account's lockout counter on
        /// the server. An account the server has never heard of has none.
        #[test]
        #[ignore]
        fn refusals_say_which_kind_of_refusal_they_are() {
            let Ok(host) = std::env::var("DELIGHT_SMB_PROBE_HOST") else {
                eprintln!("DELIGHT_SMB_PROBE_HOST not set — skipping");
                return;
            };
            let at = |share: &str| SmbUrl::parse(&format!("smb://{host}/{share}")).unwrap();
            let restore = cred_for(&host);

            // Whatever identity the machine already has (Keychain, or an open
            // session) against a share it can't have: a plain explanation.
            let err = mount(&at("no-such-share-here"), "no-such-share-here")
                .expect_err("a share that doesn't exist can't mount");
            eprintln!("missing share -> {err}");
            assert!(
                !super::super::is_auth_error(&err),
                "a missing share must NOT reopen the sign-in dialog: {err}"
            );
            assert!(
                !err.contains("NetFS error"),
                "a raw error number is not an explanation: {err}"
            );

            // Credentials the server rejects: the sentinel, so the frontend
            // asks again. This is also the only proof that what the dialog
            // collects reaches NetFS at all.
            login(&host, "delight-smb-test-no-such-user", "not-a-real-password").unwrap();
            let err = mount(&at("no-such-share-here"), "no-such-share-here")
                .expect_err("bogus credentials can't mount");
            eprintln!("bogus credentials -> {err}");
            assert!(
                super::super::is_auth_error(&err),
                "a refused sign-in must ask again, not dead-end with: {err}"
            );

            match restore {
                Some((u, p)) => drop(login(&host, &u, &p)),
                None => drop(lock(creds()).remove(&host.to_lowercase())),
            }
        }

        /// Everything above is pure string work; this one needs the machine.
        /// It asserts the INVARIANT rather than a particular mount: whatever is
        /// mounted, its point must be what the kernel says, and localize /
        /// delocalize must be exact inverses over it. Run with any SMB share
        /// mounted (Finder or Delight, doesn't matter).
        #[test]
        #[ignore]
        fn mounted_shares_round_trip_through_the_mount_table() {
            let mounts = smb_mounts();
            if mounts.is_empty() {
                eprintln!("no SMB share mounted — skipping");
                return;
            }
            for m in &mounts {
                eprintln!("//{}/{} on {}", m.host, m.share, m.point);
                assert!(m.point.starts_with('/'), "a mount point is absolute");
                assert!(
                    std::path::Path::new(&m.point).is_dir(),
                    "{} should exist",
                    m.point
                );
                let url = SmbUrl::parse(&format!("smb://{}/{}/sub/x.txt", m.host, m.share))
                    .expect("built from a live mount");
                assert_eq!(localize(&url.canonical()), format!("{}/sub/x.txt", m.point));
                assert_eq!(
                    delocalize(&format!("{}/sub/x.txt", m.point), &url),
                    url.canonical()
                );
                // At the mount root, and above it (where std::path leaves the
                // SMB tree entirely and the caller must notice).
                assert_eq!(
                    delocalize(&m.point, &url),
                    format!("smb://{}/{}", m.host, m.share)
                );
                assert_eq!(delocalize("/Volumes", &url), "/Volumes");
            }
        }
    }
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
        let url = SmbUrl::parse("smb://localhost").expect("a bare authority parses");
        let shares = list_shares(&url).expect("NetShareEnum against localhost");
        // Typically ADMIN$/C$ etc — all hidden — but any Ok result proves the call.
        for s in &shares {
            assert!(s.is_dir);
        }
    }
}
