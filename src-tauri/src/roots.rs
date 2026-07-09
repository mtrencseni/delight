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
    // v0.2: enumerate drive letters via GetLogicalDrives. Stub for now.
    vec![FsRoot {
        name: "C:".to_string(),
        path: format!("C:{}", std::path::MAIN_SEPARATOR),
    }]
}

#[tauri::command]
pub fn fs_roots() -> Vec<FsRoot> {
    native_roots()
}
