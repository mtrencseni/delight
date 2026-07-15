//! Filesystem roots abstraction. On Unix there is a single root; on Windows
//! this becomes the set of drive letters. v0.1 UI doesn't surface roots yet,
//! but the type and command exist so drives slot in without refactoring.

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsRoot {
    pub name: String,
    pub path: String,
}

#[cfg(unix)]
fn native_roots() -> Vec<FsRoot> {
    let sep = std::path::MAIN_SEPARATOR_STR;
    vec![FsRoot {
        name: sep.to_string(),
        path: sep.to_string(),
    }]
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

#[tauri::command]
pub fn fs_roots() -> Vec<FsRoot> {
    native_roots()
}

/// Best-effort path to the user's Dropbox folder, or None if there isn't one.
///
/// Dropbox records its real location in `~/.dropbox/info.json` (the folder moved
/// under `~/Library/CloudStorage/…` in recent versions, so a fixed `~/Dropbox`
/// guess is unreliable). We read that first, then fall back to the common spots.
#[tauri::command]
pub fn dropbox_dir(app: tauri::AppHandle) -> Option<String> {
    use tauri::Manager;
    let home = app.path().home_dir().ok()?;

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
