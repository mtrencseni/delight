//! The command dispatcher: one HTTP endpoint standing in for Tauri's IPC.
//!
//! The frontend already speaks a single verb — `invoke(cmd, args)` — so the web
//! target sends exactly that and this translates it into a call on
//! `delight_core`. Two rules shape the code below and are worth keeping:
//!
//! * **The match IS the allowlist.** There is no reflection, no registry, no
//!   name-to-function map that could pick up something unintended. A command
//!   that isn't spelled out here does not exist over HTTP — which is how the
//!   desktop-only ones (`open_path`, `quicklook`, devtools) stay unreachable
//!   rather than merely unused.
//! * **Every path argument goes through the jail, at the call site.** Not in a
//!   middleware that has to guess which fields are paths: right here, where it
//!   is visible that `dir` was checked and `name` was validated.

use crate::state::AppState;
use delight_core::env::Env;
use delight_core::{archive, details, fs_cmds, icons, ops, roots, smb};
use serde_json::{json, Value};
use std::sync::Arc;

/// Anything that changes the filesystem. Kept as one list so a read-only
/// deployment is a single check rather than a rule to remember per command.
const WRITES: &[&str] = &[
    "copy_entries",
    "move_entries",
    "rename_entry",
    "create_folder",
    "trash_entries",
    "create_archive",
];

fn s(a: &Value, k: &str) -> Result<String, String> {
    a.get(k)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| format!("missing string argument {k:?}"))
}

fn opt(a: &Value, k: &str) -> Option<String> {
    a.get(k).and_then(Value::as_str).map(str::to_owned)
}

fn num(a: &Value, k: &str, default: u64) -> u64 {
    a.get(k).and_then(Value::as_u64).unwrap_or(default)
}

fn flag(a: &Value, k: &str) -> bool {
    a.get(k).and_then(Value::as_bool).unwrap_or(false)
}

/// The `[{dir, name}]` list the file operations take, with every directory
/// jailed and every name checked.
fn items(st: &AppState, a: &Value) -> Result<Vec<ops::Item>, String> {
    let raw = a
        .get("items")
        .and_then(Value::as_array)
        .ok_or("missing items")?;
    raw.iter()
        .map(|it| {
            let dir = s(it, "dir")?;
            let name = s(it, "name")?;
            Ok(ops::Item {
                dir: st.cfg.roots.check_pair(&dir, Some(&name))?,
                name,
            })
        })
        .collect()
}

fn ok<T: serde::Serialize>(v: T) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

pub async fn dispatch(st: Arc<AppState>, cmd: &str, a: Value) -> Result<Value, String> {
    if st.cfg.read_only && WRITES.contains(&cmd) {
        return Err("this server is read-only".into());
    }
    let env: &Env = &st.cfg.env;
    let roots = &st.cfg.roots;

    match cmd {
        // ---- listing and navigation ------------------------------------------
        "list_dir" => {
            let path = roots.check(&s(&a, "path")?)?;
            let child = opt(&a, "child");
            if let Some(c) = child.as_deref() {
                crate::jail::check_name(c)?;
            }
            ok(fs_cmds::list_dir(env, path, child).await?)
        }
        "dir_mtime" => ok(fs_cmds::dir_mtime(roots.check(&s(&a, "path")?)?)),
        "dir_signature" => ok(fs_cmds::dir_signature(roots.check(&s(&a, "path")?)?)),
        "file_signature" => ok(fs_cmds::file_signature(roots.check(&s(&a, "path")?)?)),
        "dir_size" => ok(fs_cmds::dir_size(roots.check(&s(&a, "path")?)?).await),
        "disk_space" => ok(fs_cmds::disk_space(roots.check(&s(&a, "path")?)?).await),
        "native_path" => ok(fs_cmds::native_path(roots.check(&s(&a, "path")?)?)),

        // ---- well-known places ------------------------------------------------
        // Answered from the served roots, not the process's real home: pointing
        // the UI at a directory it is then refused access to is a worse answer
        // than pointing it at the first thing it can actually open.
        "home_dir" => {
            let first = roots
                .list()
                .first()
                .ok_or("no roots configured")?
                .to_string_lossy()
                .into_owned();
            let home = fs_cmds::home_dir(env).unwrap_or_default();
            ok(if !home.is_empty() && roots.check(&home).is_ok() {
                home
            } else {
                first
            })
        }
        "desktop_dir" => {
            let d = fs_cmds::desktop_dir(env)?;
            roots.check(&d).map(Value::from)
        }
        "fs_roots" => ok(roots
            .list()
            .iter()
            .map(|p| {
                json!({
                    "path": p.to_string_lossy(),
                    "name": p.file_name().map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_else(|| p.to_string_lossy().into_owned()),
                })
            })
            .collect::<Vec<_>>()),
        "dropbox_dir" => ok(roots::dropbox_dir(env).filter(|d| roots.check(d).is_ok())),

        // ---- reading files -----------------------------------------------------
        "read_text_file" => {
            let name = s(&a, "name")?;
            let dir = roots.check_pair(&s(&a, "dir")?, Some(&name))?;
            ok(fs_cmds::read_text_file(dir, name, num(&a, "maxBytes", 65536) as usize).await?)
        }
        "read_file_bytes" => {
            let name = s(&a, "name")?;
            let dir = roots.check_pair(&s(&a, "dir")?, Some(&name))?;
            ok(fs_cmds::read_file_bytes(dir, name, num(&a, "maxBytes", 1 << 20) as usize).await?)
        }
        "item_details" => {
            let name = opt(&a, "name");
            let dir = roots.check_pair(&s(&a, "dir")?, name.as_deref())?;
            ok(details::item_details(dir, name).await?)
        }
        "file_thumbnail" => {
            let name = opt(&a, "name");
            let dir = roots.check_pair(&s(&a, "dir")?, name.as_deref())?;
            ok(details::file_thumbnail(dir, name, num(&a, "size", 256) as u32).await?)
        }
        "file_icon" => {
            let name = opt(&a, "name");
            let dir = roots.check_pair(&s(&a, "dir")?, name.as_deref())?;
            ok(icons::file_icon(dir, name, num(&a, "size", 32) as u32).await?)
        }

        // ---- archives -----------------------------------------------------------
        "archive_formats" => ok(archive::archive_formats()),
        "set_archive_password" => {
            archive::set_archive_password(roots.check(&s(&a, "path")?)?, s(&a, "password")?)?;
            Ok(Value::Null)
        }

        // ---- writing (ops.rs is the only module that mutates) --------------------
        "copy_entries" | "move_entries" => {
            let its = items(&st, &a)?;
            let dest = roots.check(&s(&a, "dest")?)?;
            let id = s(&a, "id")?;
            let over = flag(&a, "overwrite");
            let sink = st.sink();
            ok(if cmd == "copy_entries" {
                ops::copy_entries(sink, id, its, dest, over).await?
            } else {
                ops::move_entries(sink, id, its, dest, over).await?
            })
        }
        "rename_entry" => {
            let name = s(&a, "name")?;
            let new_name = s(&a, "newName")?;
            crate::jail::check_name(&new_name)?;
            let dir = roots.check_pair(&s(&a, "dir")?, Some(&name))?;
            ops::rename_entry(dir, name, new_name).await?;
            Ok(Value::Null)
        }
        "create_folder" => {
            let name = s(&a, "name")?;
            let dir = roots.check_pair(&s(&a, "dir")?, Some(&name))?;
            ops::create_folder(dir, name).await?;
            Ok(Value::Null)
        }
        "trash_entries" => {
            let its = items(&st, &a)?;
            ok(ops::trash_entries(st.sink(), s(&a, "id")?, its).await?)
        }
        "create_archive" => {
            let its = items(&st, &a)?;
            let dest = roots.check(&s(&a, "dest")?)?;
            let name = s(&a, "name")?;
            crate::jail::check_name(&name)?;
            ok(ops::create_archive(st.sink(), s(&a, "id")?, its, dest, name).await?)
        }
        // Not a write: it flips a flag an in-flight operation polls.
        "cancel_op" => {
            ops::cancel_op(s(&a, "id")?);
            Ok(Value::Null)
        }

        // ---- reaching further out ------------------------------------------------
        // The jail has nothing to say about another host, but SMB has no Linux
        // implementation, so this reports that rather than pretending.
        "smb_login" => {
            smb::smb_login(s(&a, "host")?, s(&a, "user")?, s(&a, "password")?).await?;
            Ok(Value::Null)
        }

        // ---- the frontend's own state --------------------------------------------
        "load_state" => Ok(st.load_state()),
        "save_state" => {
            st.save_state(a.get("state").cloned().unwrap_or(Value::Null))?;
            Ok(Value::Null)
        }

        // Everything else — open_path, quicklook, devtools, show_main_window —
        // means "on this machine", which is a headless server. The frontend
        // hides those commands in the web build; this is the backstop.
        _ => Err(format!("{cmd} is not available in the web build")),
    }
}
