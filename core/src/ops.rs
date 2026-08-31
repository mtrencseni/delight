// File operations â€” the only commands that MUTATE the user's files (copy, move,
// rename, new folder, trash). Everything else in the app is read-only. Each
// command validates its inputs and refuses unsafe requests (e.g. moving a folder
// into itself); deletes go to the Trash (recoverable), never a hard unlink.
//
// Copy / move / trash report progress to the UI via the "op-progress" event and
// can be stopped mid-flight (cancel_op) â€” the frontend shows a progress dialog
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
use crate::env::Sink;

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

/// smb:// dirs become their OS-native form before any op touches them; local
/// paths pass through untouched. Every mutating command calls this on entry.
fn localize_items(items: Vec<Item>) -> Vec<Item> {
    items
        .into_iter()
        .map(|mut it| {
            it.dir = crate::smb::localize(&it.dir);
            it
        })
        .collect()
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
    /// For pack: the archive that was created, so the UI can put the cursor on it.
    #[serde(skip_serializing_if = "Option::is_none")]
    created: Option<String>,
}

// ---- progress + cancellation -------------------------------------------------

/// Live operations' cancel flags, keyed by the id the UI generates per op.
fn cancels() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static C: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Ask a running operation to stop at the next file boundary.
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
    /// "bytes" (copy/move) or "items" (trash) â€” how the UI formats done/total.
    unit: &'static str,
}

/// Emits throttled "op-progress" events and carries the cancel flag. Registers the
/// op in `cancels()` on creation and removes it on drop.
pub(crate) struct Ctx {
    app: Sink,
    id: String,
    unit: &'static str,
    total: u64,
    done: u64,
    last: Instant,
    cancel: Arc<AtomicBool>,
}

impl Ctx {
    fn new(app: Sink, id: String, unit: &'static str, total: u64) -> Self {
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

    pub(crate) fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    pub(crate) fn advance(&mut self, by: u64, current: &str) {
        self.done = (self.done + by).min(self.total);
        self.emit(current, false);
    }

    fn emit(&mut self, current: &str, force: bool) {
        // Throttle to ~20 fps so a tree of tiny files doesn't flood the webview.
        if !force && self.last.elapsed().as_millis() < 50 {
            return;
        }
        self.last = Instant::now();
        self.app.emit(
            "op-progress",
            serde_json::to_value(Progress {
                id: self.id.clone(),
                done: self.done,
                total: self.total,
                current: current.to_string(),
                    unit: self.unit,
            })
            .unwrap_or_default(),
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
        return Err("Name canâ€™t be empty".into());
    }
    if n == "." || n == ".." {
        return Err("That name is reserved".into());
    }
    if n.contains('/') || n.contains('\0') {
        return Err("Name canâ€™t contain â€œ/â€".into());
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
        _ => return Ok(()), // can't resolve â†’ let the copy attempt surface any error
    };
    if dest_c == src_c || dest_c.starts_with(&src_c) {
        return Err(format!("Canâ€™t put â€œ{name}â€ inside itself"));
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

pub async fn copy_entries(
    app: Sink,
    id: String,
    items: Vec<Item>,
    dest: String,
    overwrite: bool,
) -> Result<OpResult, String> {
    run_op(app, id, items, dest, overwrite, false).await
}

pub async fn move_entries(
    app: Sink,
    id: String,
    items: Vec<Item>,
    dest: String,
    overwrite: bool,
) -> Result<OpResult, String> {
    run_op(app, id, items, dest, overwrite, true).await
}

/// Sentinel a sink returns to unwind out of a single-pass extraction on cancel.
pub(crate) const CANCELLED: &str = "\u{0}cancelled";

/// Copy-out from an archive â€” the only way bytes ever leave one. Every wanted
/// member is streamed straight to its destination in a single pass over the
/// archive; nothing is staged in a temp file.
fn extract_op(
    app: Sink,
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
        // impossible; re-check anyway â€” this is the one place we write.
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

        // Directories first â€” including empty ones, which have no files to imply
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
    #[cfg(unix)]
    {
        let _ = fs::remove_file(out);
        std::os::unix::fs::symlink(target, out).is_ok()
    }
    #[cfg(windows)]
    {
        // No symlink privilege in the general case: copy the target's contents
        // when it's something we just extracted, otherwise report it as skipped.
        let resolved = out
            .parent()
            .map(|p| p.join(target))
            .unwrap_or_else(|| PathBuf::from(target));
        if resolved.is_file() {
            return fs::copy(&resolved, out).is_ok();
        }
        false
    }
}

async fn run_op(
    app: Sink,
    id: String,
    items: Vec<Item>,
    dest: String,
    overwrite: bool,
    is_move: bool,
) -> Result<OpResult, String> {
    // Remote source: an async protocol conversation, so it can't run on a
    // spawn_blocking thread like the local paths below.
    if items.first().is_some_and(|it| crate::sftp::is_sftp(&it.dir)) {
        if is_move {
            return Err("Canâ€™t move off a remote host yet â€” copy it instead".into());
        }
        return download_op(app, id, items, dest, overwrite).await;
    }
    if crate::sftp::is_sftp(&dest) {
        return Err("Copying TO a remote host isnâ€™t supported yet".into());
    }
    tokio::task::spawn_blocking(move || {
        let dest = crate::smb::localize(&dest);
        let items = localize_items(items);
        // Archives are strictly read-only: never a destination, and copy-out only.
        if Loc::parse(&dest).is_archive() {
            return Err("Canâ€™t write into an archive".into());
        }
        if items.first().is_some_and(|it| Loc::parse(&it.dir).is_archive()) {
            if is_move {
                return Err("Canâ€™t move out of an archive â€” copy it instead".into());
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

            // Within the same folder: a move is a no-op; a copy makes a "â€¦ copy".
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

/// Copy from a remote host to a local folder (F5 with a remote source pane).
/// Mirrors extract_op's shape: plan the tree first so the progress total is
/// real, then stream each file, checking the cancel flag at chunk boundaries.
async fn download_op(
    app: Sink,
    id: String,
    items: Vec<Item>,
    dest: String,
    overwrite: bool,
) -> Result<OpResult, String> {
    let dest_dir = PathBuf::from(&dest);
    if !dest_dir.is_dir() {
        return Err("Destination is not a folder".into());
    }
    // Walk the remote tree once for the byte total (and to create directories
    // in the right order). Costs a READDIR per remote directory, which is what
    // makes the progress bar honest rather than a spinner.
    let mut files: Vec<(String, PathBuf, u64)> = Vec::new(); // (remote, local, size)
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut res = OpResult::default();
    for it in &items {
        // Unreadable items and symlinks come back as skips rather than
        // aborting the copy â€” one locked-down subdirectory shouldn't cost the
        // user the other 500 files.
        crate::sftp::plan(&it.dir, &it.name, &dest_dir, &mut files, &mut dirs, &mut res.skipped)
            .await?;
    }
    let total: u64 = files.iter().map(|(_, _, n)| *n).sum();

    let mut ctx = Ctx::new(app, id, "bytes", total);
    for d in &dirs {
        let _ = std::fs::create_dir_all(d);
    }
    for (remote, local, size) in files {
        if ctx.cancelled() {
            res.cancelled = true;
            break;
        }
        let name = local
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        if local.exists() && !overwrite {
            res.skipped.push(name);
            ctx.advance(size, "");
            continue;
        }
        match crate::sftp::download(&remote, &local, &mut ctx).await {
            Ok(()) => res.done.push(name),
            Err(e) if e == CANCELLED => {
                // Half a file is worse than none â€” the partial write goes.
                let _ = std::fs::remove_file(&local);
                res.cancelled = true;
                break;
            }
            Err(_) => res.skipped.push(name),
        }
    }
    Ok(res)
}

pub async fn rename_entry(dir: String, name: String, new_name: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let dir = crate::smb::localize(&dir);
        if Loc::parse(&dir).is_archive() {
            return Err("Canâ€™t rename inside an archive".into());
        }
        valid_name(&new_name)?;
        let target = new_name.trim();
        if target == name {
            return Ok(());
        }
        let d = Path::new(&dir);
        let dst = d.join(target);
        if dst.symlink_metadata().is_ok() {
            return Err(format!("â€œ{target}â€ already exists"));
        }
        fs::rename(d.join(&name), &dst).map_err(|e| friendly(&e))?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn create_folder(dir: String, name: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let dir = crate::smb::localize(&dir);
        if Loc::parse(&dir).is_archive() {
            return Err("Canâ€™t create a folder inside an archive".into());
        }
        valid_name(&name)?;
        let target = Path::new(&dir).join(name.trim());
        if target.symlink_metadata().is_ok() {
            return Err(format!("â€œ{}â€ already exists", name.trim()));
        }
        fs::create_dir(&target).map_err(|e| friendly(&e))?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---- pack --------------------------------------------------------------------

/// "name.zip", then "name-1.zip", "name-2.zip"â€¦ â€” matches how unpack names the
/// folder it creates, so both operations dedupe the same way.
fn unique_path(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let mut p = dir.join(format!("{stem}{ext}"));
    let mut n = 1;
    while p.exists() {
        p = dir.join(format!("{stem}-{n}{ext}"));
        n += 1;
    }
    p
}

/// Civil date from days since the Unix epoch (inverse of `days_from_civil`) â€”
/// zip stores wall-clock date/time fields, not an epoch offset.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn zip_time(modified: Option<std::time::SystemTime>) -> Option<zip::DateTime> {
    let secs = modified?.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs() as i64;
    let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    let (y, m, d) = civil_from_days(days);
    zip::DateTime::from_date_and_time(
        u16::try_from(y).ok()?,
        m as u8,
        d as u8,
        (rem / 3600) as u8,
        ((rem % 3600) / 60) as u8,
        (rem % 60) as u8,
    )
    .ok()
}

fn entry_options(meta: &fs::Metadata) -> zip::write::SimpleFileOptions {
    let mut o = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        // Zip64 only when needed, so ordinary archives stay maximally compatible.
        .large_file(meta.len() > u32::MAX as u64);
    if let Some(t) = zip_time(meta.modified().ok()) {
        o = o.last_modified_time(t);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        o = o.unix_permissions(meta.permissions().mode());
    }
    #[cfg(windows)]
    {
        // Carry the one bit Windows has, so a round-trip preserves read-only.
        o = o.unix_permissions(if meta.permissions().readonly() { 0o444 } else { 0o644 });
    }
    o
}

/// What the pack walk needs from the progress context. Keeping it behind a trait
/// lets tests exercise the same code without a Tauri Sink.
/// What a long transfer reports to. Public because it appears in the signature
/// of `sftp::download`, which callers outside this crate use.
pub trait ProgressSink {
    fn cancelled(&self) -> bool;
    fn advance(&mut self, by: u64, current: &str);
}

impl ProgressSink for Ctx {
    fn cancelled(&self) -> bool {
        Ctx::cancelled(self)
    }
    fn advance(&mut self, by: u64, current: &str) {
        Ctx::advance(self, by, current)
    }
}

/// Add one file's bytes under `rel`, reporting progress and honoring cancel.
fn pack_file<W: std::io::Write + std::io::Seek>(
    zw: &mut zip::ZipWriter<W>,
    src: &Path,
    rel: &str,
    ctx: &mut dyn ProgressSink,
) -> Result<(), String> {
    use std::io::{Read, Write};
    let meta = fs::metadata(src).map_err(|e| friendly(&e))?;
    zw.start_file(rel, entry_options(&meta)).map_err(|e| e.to_string())?;
    let mut f = fs::File::open(src).map_err(|e| friendly(&e))?;
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        if ctx.cancelled() {
            return Err(CANCELLED.to_string());
        }
        let n = f.read(&mut buf).map_err(|e| friendly(&e))?;
        if n == 0 {
            return Ok(());
        }
        zw.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        ctx.advance(n as u64, rel);
    }
}

/// Recursively add a directory. Empty ones still get an entry of their own, or
/// they'd be lost â€” the same trap that bit extraction.
fn pack_dir<W: std::io::Write + std::io::Seek>(
    zw: &mut zip::ZipWriter<W>,
    src: &Path,
    rel: &str,
    ctx: &mut dyn ProgressSink,
) -> Result<(), String> {
    let meta = fs::metadata(src).map_err(|e| friendly(&e))?;
    zw.add_directory(rel, entry_options(&meta)).map_err(|e| e.to_string())?;
    let rd = fs::read_dir(src).map_err(|e| friendly(&e))?;
    for de in rd.flatten() {
        if ctx.cancelled() {
            return Err(CANCELLED.to_string());
        }
        let name = de.file_name().to_string_lossy().into_owned();
        let child_rel = format!("{rel}/{name}");
        // Symlinks are followed, matching what GUI packers do.
        let Ok(m) = fs::metadata(de.path()) else { continue };
        if m.is_dir() {
            pack_dir(zw, &de.path(), &child_rel, ctx)?;
        } else if m.is_file() {
            pack_file(zw, &de.path(), &child_rel, ctx)?;
        }
    }
    Ok(())
}

/// Alt+F5: pack the selection into a new zip in `dest`. Written to a ".part"
/// file and renamed at the end, so a cancelled or failed pack never leaves an
/// archive that looks complete.
pub async fn create_archive(
    app: Sink,
    id: String,
    items: Vec<Item>,
    dest: String,
    name: String,
) -> Result<OpResult, String> {
    tokio::task::spawn_blocking(move || {
        let dest = crate::smb::localize(&dest);
        let items = localize_items(items);
        if Loc::parse(&dest).is_archive() || items.iter().any(|it| Loc::parse(&it.dir).is_archive()) {
            return Err("Canâ€™t pack into or out of an archive".into());
        }
        let dest_dir = Path::new(&dest);
        if !dest_dir.is_dir() {
            return Err("Destination is not a folder".into());
        }
        if items.is_empty() {
            return Err("Nothing to pack".into());
        }
        let stem = name.trim().trim_end_matches(".zip");
        valid_name(stem)?;
        let target = unique_path(dest_dir, stem, ".zip");
        let tmp = target.with_extension("zip.part");

        let total: u64 = items.iter().map(|it| tree_size(&it.path())).sum();
        let mut ctx = Ctx::new(app, id, "bytes", total);
        let mut res = OpResult::default();

        let outcome = (|| -> Result<(), String> {
            let file = fs::File::create(&tmp).map_err(|e| friendly(&e))?;
            let mut zw = zip::ZipWriter::new(std::io::BufWriter::new(file));
            for it in &items {
                let src = it.path();
                let Ok(meta) = fs::metadata(&src) else { continue }; // vanished
                if meta.is_dir() {
                    pack_dir(&mut zw, &src, &it.name, &mut ctx)?;
                } else {
                    pack_file(&mut zw, &src, &it.name, &mut ctx)?;
                }
                res.done.push(it.name.clone());
            }
            zw.finish().map_err(|e| e.to_string())?;
            Ok(())
        })();

        match outcome {
            Ok(()) => {
                fs::rename(&tmp, &target).map_err(|e| friendly(&e))?;
                res.created = target.file_name().map(|n| n.to_string_lossy().into_owned());
            }
            Err(e) if e == CANCELLED => {
                let _ = fs::remove_file(&tmp); // no half-written archive left behind
                res.cancelled = true;
                res.done.clear();
            }
            Err(e) => {
                let _ = fs::remove_file(&tmp);
                return Err(e);
            }
        }
        Ok(res)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod pack_tests {
    use super::*;

    #[test]
    fn dedupes_like_unpack_does() {
        let dir = std::env::temp_dir().join("delight-pack-dedupe");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        assert_eq!(unique_path(&dir, "aaa", ".zip"), dir.join("aaa.zip"));
        fs::write(dir.join("aaa.zip"), b"x").unwrap();
        assert_eq!(unique_path(&dir, "aaa", ".zip"), dir.join("aaa-1.zip"));
        fs::write(dir.join("aaa-1.zip"), b"x").unwrap();
        assert_eq!(unique_path(&dir, "aaa", ".zip"), dir.join("aaa-2.zip"));
        // Same rule with no extension, which is how unpack names its folder.
        assert_eq!(unique_path(&dir, "bbb", ""), dir.join("bbb"));
        let _ = fs::remove_dir_all(&dir);
    }

    /// Round-trip: the archive we write must be readable by our own reader, keep
    /// empty directories, and preserve timestamps.
    #[test]
    fn packs_a_tree_that_reads_back() {
        use crate::archive;
        let root = std::env::temp_dir().join("delight-pack-src");
        let out = std::env::temp_dir().join("delight-pack-out");
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&out);
        fs::create_dir_all(root.join("box/sub/deep")).unwrap();
        fs::create_dir_all(root.join("box/emptydir")).unwrap();
        fs::create_dir_all(&out).unwrap();
        fs::write(root.join("box/readme.txt"), b"hello").unwrap();
        fs::write(root.join("box/sub/deep/b.txt"), b"bbbbbb").unwrap();
        fs::write(root.join("loose.txt"), b"loose").unwrap();
        let stamp = filetime::FileTime::from_unix_time(1_614_834_368, 0);
        filetime::set_file_mtime(root.join("box/readme.txt"), stamp).unwrap();

        // Drive the same walk the command uses, without needing an Sink.
        let target = unique_path(&out, "bundle", ".zip");
        {
            let f = fs::File::create(&target).unwrap();
            let mut zw = zip::ZipWriter::new(std::io::BufWriter::new(f));
            struct NoProgress;
            impl ProgressSink for NoProgress {
                fn cancelled(&self) -> bool {
                    false
                }
                fn advance(&mut self, _: u64, _: &str) {}
            }
            let mut ctx = NoProgress;
            pack_dir(&mut zw, &root.join("box"), "box", &mut ctx).unwrap();
            pack_file(&mut zw, &root.join("loose.txt"), "loose.txt", &mut ctx).unwrap();
            zw.finish().unwrap();
        }

        let ix = archive::index_for(&target).unwrap();
        let mut paths: Vec<&str> = ix.members.iter().map(|m| m.path.as_str()).collect();
        paths.sort();
        assert_eq!(
            paths,
            vec![
                "box",
                "box/emptydir",
                "box/readme.txt",
                "box/sub",
                "box/sub/deep",
                "box/sub/deep/b.txt",
                "loose.txt",
            ],
            "empty directories must survive packing"
        );
        let readme = ix.members.iter().find(|m| m.path == "box/readme.txt").unwrap();
        assert_eq!(readme.size, 5);
        assert_eq!(readme.modified_ms, Some(1_614_834_368_000), "mtime must round-trip");

        let (bytes, _) = archive::read_member(&target, "box/sub/deep/b.txt", 4096).unwrap();
        assert_eq!(bytes, b"bbbbbb");

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&out);
    }
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

pub async fn trash_entries(app: Sink, id: String, items: Vec<Item>) -> Result<OpResult, String> {
    tokio::task::spawn_blocking(move || {
        let items = localize_items(items);
        if items.first().is_some_and(|it| Loc::parse(&it.dir).is_archive()) {
            return Err("Canâ€™t delete inside an archive".into());
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
