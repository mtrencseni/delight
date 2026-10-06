//! Filesystem roots abstraction: what the Alt+F1 / Alt+F2 drive picker lists.
//! macOS has a single root; Windows has drive letters; Linux has `/` plus the
//! volumes the desktop mounted for the user.

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsRoot {
    pub name: String,
    pub path: String,
}

#[cfg(all(unix, not(target_os = "linux")))]
fn native_roots() -> Vec<FsRoot> {
    let sep = std::path::MAIN_SEPARATOR_STR;
    vec![FsRoot {
        name: sep.to_string(),
        path: sep.to_string(),
    }]
}

#[cfg(target_os = "linux")]
fn native_roots() -> Vec<FsRoot> {
    // "/" plus what udisks mounts for the user (/media, /run/media) and hand
    // mounts under /mnt — the Linux answer to Windows' drive letters. Read from
    // /proc/mounts, which never touches the volumes themselves.
    let mut roots = vec![FsRoot { name: "/".to_string(), path: "/".to_string() }];
    let mounts = std::fs::read_to_string("/proc/mounts").unwrap_or_default();
    for line in mounts.lines() {
        let Some(raw) = line.split(' ').nth(1) else { continue };
        let path = unescape_mount(raw);
        let user_volume = ["/media/", "/run/media/", "/mnt/"].iter().any(|p| path.starts_with(p));
        if user_volume && !roots.iter().any(|r| r.path == path) {
            let name = path.rsplit('/').next().unwrap_or(&path).to_string();
            roots.push(FsRoot { name, path });
        }
    }
    roots
}

/// /proc/mounts writes space, tab, newline and backslash as `\ooo` octal escapes.
#[cfg(target_os = "linux")]
fn unescape_mount(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let esc = (b[i] == b'\\' && i + 3 < b.len())
            .then(|| u8::from_str_radix(&s[i + 1..i + 4], 8).ok())
            .flatten();
        match esc {
            Some(c) => {
                out.push(c);
                i += 4;
            }
            None => {
                out.push(b[i]);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    #[test]
    fn mount_escapes_decode() {
        assert_eq!(super::unescape_mount("/media/me/My\\040Disk"), "/media/me/My Disk");
        assert_eq!(super::unescape_mount("/mnt/plain"), "/mnt/plain");
        assert_eq!(super::unescape_mount("/mnt/trailing\\"), "/mnt/trailing\\");
    }
}

#[cfg(windows)]
fn native_roots() -> Vec<FsRoot> {
    // GetLogicalDrives returns a bitmask of the mounted drive letters (bit 0 = A,
    // …, bit 25 = Z) without touching the drives themselves — no floppy spin-up,
    // no per-letter existence probe. Powers the Alt+F1 / Alt+F2 drive picker.
    use windows::Win32::Storage::FileSystem::GetLogicalDrives;
    let mask = unsafe { GetLogicalDrives() };
    let mut roots: Vec<FsRoot> = (0..26u32)
        .filter(|i| mask & (1 << i) != 0)
        .map(|i| {
            let letter = (b'A' + i as u8) as char;
            FsRoot {
                name: format!("{letter}:"),
                path: format!("{letter}:\\"),
            }
        })
        .collect();
    if roots.is_empty() {
        // Should never happen (C: is always present), but never hand back nothing.
        roots.push(FsRoot { name: "C:".to_string(), path: "C:\\".to_string() });
    }
    roots
}

pub fn fs_roots() -> Vec<FsRoot> {
    native_roots()
}

/// Best-effort path to the user's Dropbox folder, or None if there isn't one.
///
/// Dropbox records its real location in `~/.dropbox/info.json` (the folder moved
/// under `~/Library/CloudStorage/…` in recent versions, so a fixed `~/Dropbox`
/// guess is unreliable). We read that first, then fall back to the common spots.
pub fn dropbox_dir(env: &crate::env::Env) -> Option<String> {
    let home = env.home.clone()?;

    // 1) Authoritative: the path recorded in Dropbox's own info.json.
    for rel in [".dropbox/info.json", ".config/dropbox/info.json"] {
        let info = home.join(rel);
        if let Ok(text) = std::fs::read_to_string(&info) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                for account in ["personal", "business"] {
                    if let Some(path) = json
                        .get(account)
                        .and_then(|a| a.get("path"))
                        .and_then(|p| p.as_str())
                    {
                        if std::path::Path::new(path).is_dir() {
                            return Some(path.to_string());
                        }
                    }
                }
            }
        }
    }

    // 2) Fallback to the usual locations if info.json is missing.
    for rel in ["Library/CloudStorage/Dropbox", "Dropbox"] {
        let p = home.join(rel);
        if p.is_dir() {
            return Some(p.to_string_lossy().into_owned());
        }
    }
    None
}
