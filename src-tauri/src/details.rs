//! Rich per-item info for the chips view: created time, owner, default app,
//! folder count + first children, and a QuickLook content thumbnail. Fetched
//! only for the one selected item, so it never touches the listing hot path.

use crate::icons::to_data_uri;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChildEntry {
    name: String,
    is_dir: bool,
    is_symlink: bool,
    ext: Option<String>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Details {
    created_ms: Option<i64>,
    owner: Option<String>,
    app_name: Option<String>,
    app_path: Option<String>,
    dir_count: Option<u64>,
    children: Vec<ChildEntry>,
}

fn join(dir: String, name: Option<String>) -> PathBuf {
    let mut p = PathBuf::from(dir);
    if let Some(n) = name {
        p.push(n);
    }
    p
}

fn split_ext(name: &str, is_dir: bool) -> Option<String> {
    if is_dir {
        return None;
    }
    Path::new(name)
        .extension()
        .map(|e| e.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn item_details(dir: String, name: Option<String>) -> Result<Details, String> {
    let p = join(dir, name);
    tauri::async_runtime::spawn_blocking(move || gather(&p))
        .await
        .map_err(|e| e.to_string())
}

fn gather(p: &PathBuf) -> Details {
    let mut d = Details::default();
    let Ok(meta) = std::fs::metadata(p) else {
        return d;
    };
    d.created_ms = meta
        .created()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|x| x.as_millis() as i64);

    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        d.owner = uzers::get_user_by_uid(meta.uid())
            .map(|u| u.name().to_string_lossy().into_owned());
    }

    if meta.is_dir() {
        if let Ok(rd) = std::fs::read_dir(p) {
            // Collect non-hidden entries, dirs-first by name (matches the pane).
            let mut all: Vec<ChildEntry> = rd
                .flatten()
                .filter_map(|de| {
                    let name = de.file_name().to_string_lossy().into_owned();
                    if name.starts_with('.') {
                        return None;
                    }
                    let ft = de.file_type().ok()?;
                    let is_symlink = ft.is_symlink();
                    let is_dir = if is_symlink {
                        std::fs::metadata(de.path()).map(|m| m.is_dir()).unwrap_or(false)
                    } else {
                        ft.is_dir()
                    };
                    let ext = split_ext(&name, is_dir);
                    Some(ChildEntry { name, is_dir, is_symlink, ext })
                })
                .collect();
            all.sort_by(|a, b| match (a.is_dir, b.is_dir) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
            });
            d.dir_count = Some(all.len() as u64);
            all.truncate(9);
            d.children = all;
        }
    } else {
        #[cfg(target_os = "macos")]
        if let Some((n, path)) = default_app(p) {
            d.app_name = Some(n);
            d.app_path = Some(path);
        }
    }
    d
}

/// The app macOS would use to open this file: (display name, bundle path).
#[cfg(target_os = "macos")]
fn default_app(p: &Path) -> Option<(String, String)> {
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSString, NSURL};
    let ws = NSWorkspace::sharedWorkspace();
    let url = NSURL::fileURLWithPath(&NSString::from_str(&p.to_string_lossy()));
    let app_url = ws.URLForApplicationToOpenURL(&url)?;
    let path = app_url.path()?.to_string();
    let name = Path::new(&path)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.clone());
    Some((name, path))
}

/// QuickLook content thumbnail (macOS) as a PNG data URI, or None.
#[tauri::command]
pub async fn file_thumbnail(
    dir: String,
    name: Option<String>,
    size: u32,
) -> Result<Option<String>, String> {
    let p = join(dir, name);
    tauri::async_runtime::spawn_blocking(move || thumbnail(&p, size))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
fn thumbnail(p: &Path, size: u32) -> Option<String> {
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);

    let out = std::env::temp_dir().join(format!(
        "dl_thumb_{}_{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&out).ok()?;
    let ok = Command::new("qlmanage")
        .arg("-t")
        .arg("-s")
        .arg(size.to_string())
        .arg("-o")
        .arg(&out)
        .arg(p)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    let result = if ok {
        std::fs::read_dir(&out)
            .ok()
            .and_then(|rd| {
                rd.flatten()
                    .map(|e| e.path())
                    .find(|pp| pp.extension().map(|e| e == "png").unwrap_or(false))
            })
            .and_then(|png| std::fs::read(&png).ok())
            .map(|bytes| to_data_uri(&bytes))
    } else {
        None
    };
    std::fs::remove_dir_all(&out).ok();
    result
}

#[cfg(not(target_os = "macos"))]
fn thumbnail(_p: &Path, _size: u32) -> Option<String> {
    None
}
