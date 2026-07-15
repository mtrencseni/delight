// File operations — the only commands that MUTATE the user's files (copy, move,
// rename, new folder, trash). Everything else in the app is read-only. Each
// command validates its inputs and refuses unsafe requests (e.g. moving a folder
// into itself); deletes go to the Trash (recoverable), never a hard unlink.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

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

/// What a copy/move actually did, so the UI can report skips.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OpResult {
    /// Names successfully copied/moved.
    done: Vec<String>,
    /// Names skipped because the destination already had one (overwrite = false).
    skipped: Vec<String>,
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

/// Copy a file, directory (recursively), or symlink from `src` to `dst`.
fn copy_recursive(src: &Path, dst: &Path) -> io::Result<()> {
    let meta = fs::symlink_metadata(src)?;
    let ft = meta.file_type();
    if ft.is_symlink() {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(fs::read_link(src)?, dst)?;
        }
        #[cfg(not(unix))]
        {
            // Best-effort on non-Unix: copy the link target's contents.
            if src.is_dir() {
                copy_dir_contents(src, dst)?;
            } else {
                fs::copy(src, dst)?;
            }
        }
        return Ok(());
    }
    if ft.is_dir() {
        copy_dir_contents(src, dst)?;
    } else {
        fs::copy(src, dst)?;
    }
    Ok(())
}

fn copy_dir_contents(src: &Path, dst: &Path) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        copy_recursive(&entry.path(), &dst.join(entry.file_name()))?;
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
    let (src_c, dest_c) = match (fs::canonicalize(src), fs::canonicalize(dest_dir)) {
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
    match (src.parent().map(fs::canonicalize), Some(fs::canonicalize(dest_dir))) {
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
pub async fn copy_entries(items: Vec<Item>, dest: String, overwrite: bool) -> Result<OpResult, String> {
    run_op(items, dest, overwrite, false).await
}

#[tauri::command]
pub async fn move_entries(items: Vec<Item>, dest: String, overwrite: bool) -> Result<OpResult, String> {
    run_op(items, dest, overwrite, true).await
}

async fn run_op(items: Vec<Item>, dest: String, overwrite: bool, is_move: bool) -> Result<OpResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dest_dir = Path::new(&dest);
        if !dest_dir.is_dir() {
            return Err("Destination is not a folder".into());
        }
        let mut res = OpResult::default();
        for it in &items {
            let src = it.path();
            if !src.symlink_metadata().is_ok() {
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
                if fs::rename(&src, &target).is_err() {
                    // Cross-device (e.g. different volume): copy then remove.
                    copy_recursive(&src, &target).map_err(|e| friendly(&e))?;
                    remove_any(&src).map_err(|e| friendly(&e))?;
                }
            } else {
                copy_recursive(&src, &target).map_err(|e| friendly(&e))?;
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

#[tauri::command]
pub async fn trash_entries(items: Vec<Item>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let paths: Vec<PathBuf> = items.iter().map(|it| it.path()).filter(|p| p.symlink_metadata().is_ok()).collect();
        if paths.is_empty() {
            return Ok(());
        }
        trash::delete_all(&paths).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
