use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::Manager;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    name: String,
    stem: String,
    ext: Option<String>,
    is_dir: bool,
    is_symlink: bool,
    size: u64,
    modified_ms: Option<i64>,
    created_ms: Option<i64>,
    permissions: Option<String>,
    hidden: bool,
}

/// `ls -l`-style type + rwx string, e.g. "drwxr-xr-x" or "-rw-r--r--".
pub fn perm_string(meta: &std::fs::Metadata, is_symlink: bool) -> Option<String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = meta.permissions().mode();
        let t = if is_symlink {
            'l'
        } else if meta.is_dir() {
            'd'
        } else {
            '-'
        };
        let bit = |shift: u32, ch: char| if mode & (1 << shift) != 0 { ch } else { '-' };
        let s: String = [
            t,
            bit(8, 'r'), bit(7, 'w'), bit(6, 'x'),
            bit(5, 'r'), bit(4, 'w'), bit(3, 'x'),
            bit(2, 'r'), bit(1, 'w'), bit(0, 'x'),
        ]
        .iter()
        .collect();
        Some(s)
    }
    #[cfg(not(unix))]
    {
        let _ = (meta, is_symlink);
        None
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    path: String,
    name: String,
    parent: Option<String>,
    entries: Vec<Entry>,
}

fn friendly_io(e: &std::io::Error) -> String {
    use std::io::ErrorKind;
    match e.kind() {
        ErrorKind::PermissionDenied => "Permission denied".into(),
        ErrorKind::NotFound => "No such folder".into(),
        ErrorKind::NotADirectory => "Not a folder".into(),
        _ => e.to_string(),
    }
}

fn expand_home(input: &str, home: Option<&PathBuf>) -> PathBuf {
    if let (Some(home), Some(rest)) = (home, input.strip_prefix('~')) {
        if rest.is_empty() {
            return home.clone();
        }
        let rest = rest.trim_start_matches(std::path::MAIN_SEPARATOR);
        if rest.len() < input.len() - 1 {
            return home.join(rest);
        }
    }
    PathBuf::from(input)
}

fn read_listing(path: String, child: Option<String>, home: Option<PathBuf>) -> Result<Listing, String> {
    let mut p = expand_home(path.trim(), home.as_ref());
    if let Some(c) = child {
        p.push(c);
    }
    let p = fs::canonicalize(&p).map_err(|e| friendly_io(&e))?;
    let rd = fs::read_dir(&p).map_err(|e| friendly_io(&e))?;

    let mut entries = Vec::new();
    for de in rd.flatten() {
        let name = de.file_name().to_string_lossy().into_owned();
        // DirEntry::metadata does not follow symlinks.
        let Ok(smeta) = de.metadata() else { continue };
        let is_symlink = smeta.file_type().is_symlink();
        // For symlinks, follow to the target for dir-ness/size; fall back to the
        // link's own metadata when the target is unresolvable.
        let fmeta = if is_symlink { fs::metadata(de.path()).ok() } else { None };
        let meta = fmeta.as_ref().unwrap_or(&smeta);
        let is_dir = meta.is_dir();
        let size = if is_dir { 0 } else { meta.len() };
        let to_ms = |t: std::time::SystemTime| t.duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as i64);
        let modified_ms = meta.modified().ok().and_then(to_ms);
        let created_ms = meta.created().ok().and_then(to_ms);
        // Permissions reflect the link's own bits (matches `ls -l` on symlinks).
        let permissions = perm_string(&smeta, is_symlink);
        let as_path = Path::new(&name);
        let (stem, ext) = if is_dir {
            (name.clone(), None)
        } else {
            (
                as_path
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_else(|| name.clone()),
                as_path.extension().map(|e| e.to_string_lossy().into_owned()),
            )
        };
        let hidden = name.starts_with('.');
        entries.push(Entry {
            name,
            stem,
            ext,
            is_dir,
            is_symlink,
            size,
            modified_ms,
            created_ms,
            permissions,
            hidden,
        });
    }

    let parent = p.parent().map(|q| q.to_string_lossy().into_owned());
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| p.to_string_lossy().into_owned());
    Ok(Listing {
        path: p.to_string_lossy().into_owned(),
        name,
        parent,
        entries,
    })
}

#[tauri::command]
pub async fn list_dir(
    app: tauri::AppHandle,
    path: String,
    child: Option<String>,
) -> Result<Listing, String> {
    let home = app.path().home_dir().ok();
    tauri::async_runtime::spawn_blocking(move || read_listing(path, child, home))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn home_dir(app: tauri::AppHandle) -> Result<String, String> {
    app.path()
        .home_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}
