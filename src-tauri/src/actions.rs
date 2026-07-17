//! Read-only system actions: open a path with the OS default handler, and
//! Quick Look preview (macOS). These launch other processes but never modify
//! the filesystem themselves.

use std::path::PathBuf;
use std::process::Command;

fn join(dir: String, name: Option<String>) -> PathBuf {
    let mut p = PathBuf::from(dir);
    if let Some(n) = name {
        p.push(n);
    }
    p
}

/// Open with the system default app. On macOS `open` shows the "choose an
/// application" dialog when no default is registered.
#[tauri::command]
pub fn open_path(dir: String, name: Option<String>) -> Result<(), String> {
    let p = join(dir, name);
    open_native(&p)
}

/// Launch a specific editor executable with a file path (Delight's F4 → Buffers).
/// On macOS a `.app` bundle is launched via `open -a`; elsewhere the binary runs
/// directly with the path as its first argument.
#[tauri::command]
pub fn open_in_editor(exe: String, path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    if exe.ends_with(".app") {
        return Command::new("open")
            .args(["-a", &exe])
            .arg(&path)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string());
    }
    Command::new(&exe)
        .arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
fn open_native(p: &PathBuf) -> Result<(), String> {
    Command::new("open").arg(p).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(target_os = "windows")]
fn open_native(p: &PathBuf) -> Result<(), String> {
    // `start` needs an (empty) title argument first.
    Command::new("cmd")
        .args(["/C", "start", ""])
        .arg(p)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_native(p: &PathBuf) -> Result<(), String> {
    Command::new("xdg-open").arg(p).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[derive(serde::Deserialize)]
pub struct QlItem {
    dir: String,
    name: Option<String>,
}

// ---- in-process Quick Look (real Finder QLPreviewPanel) --------------------

#[cfg(target_os = "macos")]
mod ql {
    use std::ffi::CString;
    use std::os::raw::{c_char, c_int, c_long};
    use std::sync::OnceLock;
    use tauri::{AppHandle, Emitter};

    extern "C" {
        pub fn dl_ql_show(paths: *const *const c_char, count: c_int, index: c_int);
        pub fn dl_ql_close();
    }

    static APP: OnceLock<AppHandle> = OnceLock::new();

    pub fn init(app: AppHandle) {
        let _ = APP.set(app);
    }

    /// Called from the Objective-C side when the previewed item changes; relay
    /// it to the webview so the pane's cursor tracks the preview.
    #[no_mangle]
    pub extern "C" fn dl_ql_index_changed(index: c_long) {
        if let Some(app) = APP.get() {
            let _ = app.emit("ql-index", index as i64);
        }
    }

    /// Show the panel on the main thread; keeps the CStrings alive across the call.
    pub fn show(app: &AppHandle, paths: Vec<String>, index: i32) -> Result<(), String> {
        let cstrs: Vec<CString> = paths
            .into_iter()
            .filter_map(|p| CString::new(p).ok())
            .collect();
        app.run_on_main_thread(move || {
            let ptrs: Vec<*const c_char> = cstrs.iter().map(|c| c.as_ptr()).collect();
            unsafe { dl_ql_show(ptrs.as_ptr(), ptrs.len() as c_int, index) };
            drop(cstrs);
        })
        .map_err(|e| e.to_string())
    }

    pub fn close(app: &AppHandle) -> Result<(), String> {
        app.run_on_main_thread(|| unsafe { dl_ql_close() })
            .map_err(|e| e.to_string())
    }
}

#[cfg(target_os = "macos")]
pub fn init(app: tauri::AppHandle) {
    ql::init(app);
}

#[cfg(not(target_os = "macos"))]
pub fn init(_app: tauri::AppHandle) {}

/// Quick Look preview (macOS), Finder-style. `items` is the directory's entries
/// in order; `index` is the selected one. Arrowing in the panel moves through
/// them and reports back so Delight's cursor follows.
#[tauri::command]
pub fn quicklook(
    _app: tauri::AppHandle,
    items: Vec<QlItem>,
    index: usize,
) -> Result<(), String> {
    let paths: Vec<PathBuf> = items.into_iter().map(|it| join(it.dir, it.name)).collect();
    if paths.is_empty() {
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        let strs: Vec<String> = paths.iter().map(|p| p.to_string_lossy().into_owned()).collect();
        return ql::show(&_app, strs, index as i32);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (paths, index);
        Err("Quick Look is only available on macOS".into())
    }
}

/// Show/hide/toggle the WKWebView Web Inspector. wry's open_devtools is a no-op
/// in release, so on macOS we drive WKWebView's private `_inspector` directly
/// (the webview is made inspectable at startup).
#[cfg(target_os = "macos")]
fn inspector(app: &tauri::AppHandle, action: i32) {
    use objc2::runtime::AnyObject;
    use tauri::Manager;
    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    let _ = w.with_webview(move |wv| {
        let obj: *mut AnyObject = wv.inner().cast();
        unsafe {
            let _: () = objc2::msg_send![obj, setInspectable: true];
            let insp: *mut AnyObject = objc2::msg_send![obj, _inspector];
            if insp.is_null() {
                return;
            }
            let visible: bool = objc2::msg_send![insp, isVisible];
            // action: 0 = toggle, 1 = force close
            if visible || action == 1 {
                let _: () = objc2::msg_send![insp, close];
            } else {
                let _: () = objc2::msg_send![insp, show];
            }
        }
    });
}

/// Toggle the Web Inspector. The frontend gates this behind a setting.
#[tauri::command]
pub fn toggle_devtools(app: tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    inspector(&app, 0);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Close the Web Inspector (used when the setting is switched off).
#[tauri::command]
pub fn close_devtools(app: tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    inspector(&app, 1);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

#[tauri::command]
pub fn quicklook_close(_app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        return ql::close(&_app);
    }
    #[cfg(not(target_os = "macos"))]
    Ok(())
}
