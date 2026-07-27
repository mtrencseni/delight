// File operations — the only commands that MUTATE the user's files (copy, move,
// rename, new folder, trash). Everything else in the app is read-only. Each
// command validates its inputs and refuses unsafe requests (e.g. moving a folder
// into itself); deletes go to the Trash (recoverable), never a hard unlink.
//
// Copy / move / trash report progress to the UI via the "op-progress" event and
// can be stopped mid-flight (cancel_op) — the frontend shows a progress dialog
// that can be sent to the background. Progress is byte-based for copy/move and
// item-based for trash. Cross-platform: pure std::fs + the `trash` crate.

use crate::archive::{self, Loc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;
use tauri::{AppHandle, Emitter};

#[derive(Deserialize)]
pub struct Item {
    pub dir: String,
    pub name: String,
}

impl Item {
    fn path(&self) -> PathBuf {
        Path::new(&self.dir).join(&self.name)
    }
}

/// What a copy/move/trash actually did, so the UI can report skips + cancellation.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OpResult {
    /// Names successfully copied/moved/trashed.
    done: Vec<String>,
    /// Names skipped (destination already had one and overwrite = false, or a
    /// same-folder move).
    skipped: Vec<String>,
    /// True if the user cancelled before finishing.
    cancelled: bool,
}

// ---- progress + cancellation -------------------------------------------------

/// Live operations' cancel flags, keyed by the id the UI generates per op.
fn cancels() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static C: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Ask a running operation to stop at the next file boundary.
#[tauri::command]
pub fn cancel_op(id: String) {
    if let Some(flag) = cancels().lock().unwrap().get(&id) {
        flag.store(true, Ordering::Relaxed);
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    id: String,
    done: u64,
    total: u64,
    current: String,
    /// "bytes" (copy/move) or "items" (trash) — how the UI formats done/total.
    unit: &'static str,
}

/// Emits throttled "op-progress" events and carries the cancel flag. Registers the
/// op in `cancels()` on creation and removes it on drop.
struct Ctx {
    app: AppHandle,
    id: String,
    unit: &'static str,
    total: u64,
    done: u64,
    last: Instant,
    cancel: Arc<AtomicBool>,
}

impl Ctx {
    fn new(app: AppHandle, id: String, unit: &'static str, total: u64) -> Self {
        let cancel = Arc::new(AtomicBool::new(false));
        cancels().lock().unwrap().insert(id.clone(), cancel.clone());
        let mut ctx = Ctx {
            app,
            id,
            unit,
            total: total.max(1),
            done: 0,
            last: Instant::now(),
            cancel,
        };
        ctx.emit("", true); // initial 0/total so the dialog shows immediately
        ctx
    }

    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    fn advance(&mut self, by: u64, current: &str) {
        self.done = (self.done + by).min(self.total);
        self.emit(current, false);
    }

    fn emit(&mut self, current: &str, force: bool) {
        // Throttle to ~20 fps so a tree of tiny files doesn't flood the webview.
        if !force && self.last.elapsed().as_millis() < 50 {
            return;
        }
        self.last = Instant::now();
        let _ = self.app.emit(
            "op-progress",
            Progress {
                id: self.id.clone(),
                done: self.done,
                total: self.total,
                current: current.to_string(),
                unit: self.unit,
            },
        );
    }
}

impl Drop for Ctx {
    fn drop(&mut self) {
        cancels().lock().unwrap().remove(&self.id);
    }
}

/// Total size in bytes of a file / dir (recursive) / symlink. Sizes the bar.
fn tree_size(p: &Path) -> u64 {
    let Ok(meta) = fs::symlink_metadata(p) else {
        return 0;
    };
    if meta.file_type().is_symlink() {
        return meta.len();
    }
    if meta.is_dir() {
        let mut total = 0u64;
        if let Ok(rd) = fs::read_dir(p) {
            for e in rd.flatten() {
                total = total.saturating_add(tree_size(&e.path()));
            }
        }
        total
    } else {
        meta.len()
    }
}

fn friendly(e: &io::Error) -> String {
    use io::ErrorKind;
    match e.kind() {
        ErrorKind::PermissionDenied => "Permission denied".into(),
        ErrorKind::NotFound => "No longer exists".into(),
        _ => e.to_string(),
    }
}

/// Validate a user-typed file/folder name (rename + new folder).
fn valid_name(name: &str) -> Result<(), String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("Name can’t be empty".into());
    }
    if n == "." || n == ".." {
        return Err("That name is reserved".into());
    }
    if n.contains('/') || n.contains('\0') {
        return Err("Name can’t contain “/”".into());
    }
    Ok(())
}

/// Copy a file, directory (recursively), or symlink from `src` to `dst`, reporting
/// per-file byte progress and honoring cancellation.
fn copy_recursive(src: &Path, dst: &Path, ctx: &mut Ctx, name: &str) -> io::Result<()> {
    if ctx.cancelled() {
        return Err(io::Error::new(io::ErrorKind::Interrupted, "cancelled"));
    }
    let meta = fs::symlink_metadata(src)?;
    let ft = meta.file_type();
    if ft.is_symlink() {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(fs::read_link(src)?, dst)?;
            ctx.advance(meta.len().max(1), name);
        }
        #[cfg(not(unix))]
        {
            // Best-effort on non-Unix: copy the link target's contents.
            if src.is_dir() {
                copy_dir_contents(src, dst, ctx)?;
            } else {
                fs::copy(src, dst)?;
                ctx.advance(meta.len(), name);
            }
        }
        return Ok(());
    }
    if ft.is_dir() {
        copy_dir_contents(src, dst, ctx)?;
    } else {
        fs::copy(src, dst)?;
        ctx.advance(meta.len(), name);
    }
    Ok(())
}

fn copy_dir_contents(src: &Path, dst: &Path, ctx: &mut Ctx) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let child = entry.file_name();
        copy_recursive(&entry.path(), &dst.join(&child), ctx, &child.to_string_lossy())?;
    }
    Ok(())
}

/// Remove a file, symlink, or directory (recursively).
fn remove_any(p: &Path) -> io::Result<()> {
    let meta = fs::symlink_metadata(p)?;
    if meta.is_dir() && !meta.file_type().is_symlink() {
        fs::remove_dir_all(p)
    } else {
        fs::remove_file(p)
    }
}

/// Reject moving/copying a folder into itself or one of its own descendants.
fn ensure_not_into_self(src: &Path, dest_dir: &Path, name: &str) -> Result<(), String> {
    let (src_c, dest_c) = match (dunce::canonicalize(src), dunce::canonicalize(dest_dir)) {
        (Ok(a), Ok(b)) => (a, b),
        _ => return Ok(()), // can't resolve → let the copy attempt surface any error
    };
    if dest_c == src_c || dest_c.starts_with(&src_c) {
        return Err(format!("Can’t put “{name}” inside itself"));
    }
    Ok(())
}

/// True if `src`'s parent is `dest_dir` (copy/move within the same folder).
fn same_folder(src: &Path, dest_dir: &Path) -> bool {
    match (src.parent().map(dunce::canonicalize), Some(dunce::canonicalize(dest_dir))) {
        (Some(Ok(a)), Some(Ok(b))) => a == b,
        _ => false,
    }
}

/// A fresh "<stem> copy[.ext]" name in `dir` that doesn't collide.
fn dedup_target(dir: &Path, name: &str) -> PathBuf {
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    let mut candidate = dir.join(format!("{stem} copy{ext}"));
    let mut n = 2;
    while candidate.exists() {
        candidate = dir.join(format!("{stem} copy {n}{ext}"));
        n += 1;
    }
    candidate
}

#[tauri::command]
pub async fn copy_entries(
    app: AppHandle,
    id: String,
    items: Vec<Item>,
    dest: String,
    overwrite: bool,
) -> Result<OpResult, String> {
    run_op(app, id, items, dest, overwrite, false).await
}

#[tauri::command]
pub async fn move_entries(
    app: AppHandle,
    id: String,
    items: Vec<Item>,
    dest: String,
    overwrite: bool,
) -> Result<OpResult, String> {
    run_op(app, id, items, dest, overwrite, true).await
}

/// Sentinel a sink returns to unwind out of a single-pass extraction on cancel.
const CANCELLED: &str = "\u{0}cancelled";

/// Copy-out from an archive — the only way bytes ever leave one. Every wanted
/// member is streamed straight to its destination in a single pass over the
/// archive; nothing is staged in a temp file.
fn extract_op(
    app: AppHandle,
    id: String,
    items: Vec<Item>,
    dest: &Path,
    overwrite: bool,
) -> Result<OpResult, String> {
    use std::io::Write;

    let Some(Loc::Archive { archive, inner }) = items.first().map(|it| Loc::parse(&it.dir)) else {
        return Err("Not an archive".into());
    };
    let index = archive::index_for(&archive)?;
    let mut res = OpResult::default();

    // Plan first (member -> destination + metadata), so the progress total is
    // exact and every directory exists before any file lands in it.
    let prefix = if inner.is_empty() { String::new() } else { format!("{inner}/") };
    let rel_of = |p: &str| -> Option<PathBuf> {
        let rel = p.strip_prefix(&prefix).unwrap_or(p);
        let out = dest.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        // Inner paths are normalized at index time, so traversal is already
        // impossible; re-check anyway — this is the one place we write.
        out.starts_with(dest).then_some(out)
    };

    struct Planned {
        out: PathBuf,
        modified_ms: Option<i64>,
        mode: Option<u32>,
    }
    let mut plan: HashMap<String, Planned> = HashMap::new();
    let mut links: Vec<(PathBuf, String)> = Vec::new();
    let mut total = 0u64;

    for it in &items {
        if dest.join(&it.name).exists() && !overwrite {
            res.skipped.push(it.name.clone());
            continue;
        }
        let root = archive::normalize_inner(&format!("{inner}/{}", it.name));

        // Directories first — including empty ones, which have no files to imply
        // them and would otherwise be silently dropped.
        for d in index.dirs_under(&root) {
            if let Some(out) = rel_of(&d.path) {
                fs::create_dir_all(&out).map_err(|e| friendly(&e))?;
            }
        }
        for m in index.files_under(&root) {
            let Some(out) = rel_of(&m.path) else { continue };
            if m.is_link {
                if let Some(t) = &m.link_target {
                    links.push((out, t.clone()));
                }
                continue; // carries no data; materialized after the walk
            }
            total = total.saturating_add(m.size);
            plan.insert(
                m.path.clone(),
                Planned { out, modified_ms: m.modified_ms, mode: m.mode },
            );
        }
        res.done.push(it.name.clone());
    }

    let mut ctx = Ctx::new(app, id, "bytes", total);
    let wanted: Vec<String> = plan.keys().cloned().collect();
    let outcome = archive::extract_members(&archive, &wanted, |member, reader| {
        let Some(p) = plan.get(member) else { return Ok(()) };
        if let Some(parent) = p.out.parent() {
            fs::create_dir_all(parent).map_err(|e| friendly(&e))?;
        }
        let mut f = fs::File::create(&p.out).map_err(|e| friendly(&e))?;
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            if ctx.cancelled() {
                return Err(CANCELLED.to_string());
            }
            let n = reader.read(&mut buf).map_err(|e| friendly(&e))?;
            if n == 0 {
                break;
            }
            f.write_all(&buf[..n]).map_err(|e| friendly(&e))?;
            ctx.advance(n as u64, member);
        }
        drop(f); // close before stamping metadata
        restore_meta(&p.out, p.modified_ms, p.mode);
        Ok(())
    });
    match outcome {
        Ok(()) => {}
        Err(e) if e == CANCELLED => res.cancelled = true,
        Err(e) => return Err(e),
    }

    // Links last, so their targets already exist.
    for (out, target) in links {
        if !materialize_link(&out, &target) {
            res.skipped.push(out.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or(target));
        }
    }
    Ok(res)
}

/// Put back the timestamp and permission bits the archive recorded, so a
/// copied-out file isn't stamped "now" with default permissions.
fn restore_meta(path: &Path, modified_ms: Option<i64>, mode: Option<u32>) {
    if let Some(ms) = modified_ms {
        let ft = filetime::FileTime::from_unix_time(ms.div_euclid(1000), (ms.rem_euclid(1000) * 1_000_000) as u32);
        let _ = filetime::set_file_mtime(path, ft);
    }
    let Some(mode) = mode else { return };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode & 0o7777));
    }
    #[cfg(windows)]
    {
        // Windows has no mode bits; the one thing that maps is "not writable".
        if mode & 0o200 == 0 {
            if let Ok(m) = fs::metadata(path) {
                let mut perms = m.permissions();
                perms.set_readonly(true);
                let _ = fs::set_permissions(path, perms);
            }
        }
    }
}

/// Recreate a tar symlink/hardlink at `out`. Returns false when it can't be done
/// (Windows symlinks need Developer Mode or admin), so the caller can report it
/// as skipped rather than leaving a bogus empty file behind.
fn materialize_link(out: &Path, target: &str) -> bool {
    if let Some(parent) = out.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let resolved = out.parent().map(|p| p.join(target)).unwrap_or_else(|| PathBuf::from(target));
    #[cfg(unix)]
    {
        let _ = fs::remove_file(out);
        std::os::unix::fs::symlink(target, out).is_ok()
    }
    #[cfg(windows)]
    {
        // No symlink privilege in the general case: copy the target's contents
        // when it's something we just extracted, otherwise report it as skipped.
        if resolved.is_file() {
            return fs::copy(&resolved, out).is_ok();
        }
        false
    }
}

async fn run_op(
    app: AppHandle,
    id: String,
    items: Vec<Item>,
    dest: String,
    overwrite: bool,
    is_move: bool,
) -> Result<OpResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Archives are strictly read-only: never a destination, and copy-out only.
        if Loc::parse(&dest).is_archive() {
            return Err("Can’t write into an archive".into());
        }
        if items.first().is_some_and(|it| Loc::parse(&it.dir).is_archive()) {
            if is_move {
                return Err("Can’t move out of an archive — copy it instead".into());
            }
            return extract_op(app, id, items, Path::new(&dest), overwrite);
        }

        let dest_dir = Path::new(&dest);
        if !dest_dir.is_dir() {
            return Err("Destination is not a folder".into());
        }
        // Pre-scan for the progress total (bytes across every item).
        let total: u64 = items.iter().map(|it| tree_size(&it.path())).sum();
        let mut ctx = Ctx::new(app, id, "bytes", total);
        let mut res = OpResult::default();

        for it in &items {
            if ctx.cancelled() {
                res.cancelled = true;
                break;
            }
            let src = it.path();
            if src.symlink_metadata().is_err() {
                continue; // vanished since selection
            }
            ensure_not_into_self(&src, dest_dir, &it.name)?;
            let same = same_folder(&src, dest_dir);

            // Within the same folder: a move is a no-op; a copy makes a "… copy".
            let target = if same {
                if is_move {
                    res.skipped.push(it.name.clone());
                    continue;
                }
                dedup_target(dest_dir, &it.name)
            } else {
                dest_dir.join(&it.name)
            };

            if !same && target.exists() {
                if !overwrite {
                    res.skipped.push(it.name.clone());
                    continue;
                }
                remove_any(&target).map_err(|e| friendly(&e))?;
            }

            if is_move {
                let item_size = tree_size(&src);
                if fs::rename(&src, &target).is_ok() {
                    ctx.advance(item_size, &it.name); // an instant same-volume move
                } else {
                    // Cross-device (e.g. different volume): copy (with progress) then remove.
                    match copy_recursive(&src, &target, &mut ctx, &it.name) {
                        Ok(()) => remove_any(&src).map_err(|e| friendly(&e))?,
                        Err(e) if e.kind() == io::ErrorKind::Interrupted => {
                            res.cancelled = true;
                            break;
                        }
                        Err(e) => return Err(friendly(&e)),
                    }
                }
            } else {
                match copy_recursive(&src, &target, &mut ctx, &it.name) {
                    Ok(()) => {}
                    Err(e) if e.kind() == io::ErrorKind::Interrupted => {
                        res.cancelled = true;
                        break;
                    }
                    Err(e) => return Err(friendly(&e)),
                }
            }
            res.done.push(it.name.clone());
        }
        Ok(res)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn rename_entry(dir: String, name: String, new_name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if Loc::parse(&dir).is_archive() {
            return Err("Can’t rename inside an archive".into());
        }
        valid_name(&new_name)?;
        let target = new_name.trim();
        if target == name {
            return Ok(());
        }
        let d = Path::new(&dir);
        let dst = d.join(target);
        if dst.symlink_metadata().is_ok() {
            return Err(format!("“{target}” already exists"));
        }
        fs::rename(d.join(&name), &dst).map_err(|e| friendly(&e))?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn create_folder(dir: String, name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if Loc::parse(&dir).is_archive() {
            return Err("Can’t create a folder inside an archive".into());
        }
        valid_name(&name)?;
        let target = Path::new(&dir).join(name.trim());
        if target.symlink_metadata().is_ok() {
            return Err(format!("“{}” already exists", name.trim()));
        }
        fs::create_dir(&target).map_err(|e| friendly(&e))?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod meta_tests {
    use super::*;

    /// A file copied out of an archive should carry the archive's timestamp, not
    /// the moment it was extracted.
    #[test]
    fn restores_the_recorded_mtime() {
        let p = std::env::temp_dir().join("delight-ops-test-mtime.txt");
        fs::write(&p, b"x").unwrap();
        let ms = 1_614_834_368_000i64; // 2021-03-04T05:06:08Z
        restore_meta(&p, Some(ms), Some(0o644));
        let got = fs::metadata(&p)
            .unwrap()
            .modified()
            .unwrap()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        assert_eq!(got, ms, "extracted file must keep the archive's timestamp");
        let _ = fs::remove_file(&p);
    }

    /// The one mode bit that maps onto Windows is "not writable".
    #[test]
    fn read_only_mode_carries_over() {
        let p = std::env::temp_dir().join("delight-ops-test-ro.txt");
        let _ = fs::remove_file(&p);
        fs::write(&p, b"x").unwrap();
        restore_meta(&p, None, Some(0o444));
        assert!(fs::metadata(&p).unwrap().permissions().readonly());
        // Clear it again so the temp file can be removed.
        let mut perms = fs::metadata(&p).unwrap().permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
        let _ = fs::set_permissions(&p, perms);
        let _ = fs::remove_file(&p);
    }
}

#[tauri::command]
pub async fn trash_entries(app: AppHandle, id: String, items: Vec<Item>) -> Result<OpResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if items.first().is_some_and(|it| Loc::parse(&it.dir).is_archive()) {
            return Err("Can’t delete inside an archive".into());
        }
        let paths: Vec<(String, PathBuf)> = items
            .iter()
            .map(|it| (it.name.clone(), it.path()))
            .filter(|(_, p)| p.symlink_metadata().is_ok())
            .collect();
        let mut ctx = Ctx::new(app, id, "items", paths.len() as u64);
        let mut res = OpResult::default();
        for (name, p) in &paths {
            if ctx.cancelled() {
                res.cancelled = true;
                break;
            }
            trash::delete(p).map_err(|e| e.to_string())?;
            res.done.push(name.clone());
            ctx.advance(1, name);
        }
        Ok(res)
    })
    .await
    .map_err(|e| e.to_string())?
}
