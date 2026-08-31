//! The desktop host. The filesystem work lives in `delight-core`; this crate is
//! the window, the menu, and the thin layer that turns Tauri's IPC into calls on
//! that crate.
//!
//! The wrappers below look like boilerplate and are: `#[tauri::command]` has to
//! sit on a function this crate owns, and the two things the core needs from a
//! host — the well-known directories, and somewhere to send progress — are
//! supplied here from `AppHandle`. Writing them out beats making the core
//! depend on Tauri, which is what stopped the server from existing at all
//! (Tauri drags in GTK/WebKitGTK on Linux, and a headless box has no business
//! building a webview).

mod actions;
mod menu;
mod settings;

use delight_core::env::{Emitter, Env, Sink};
use delight_core::{archive, details, fs_cmds, icons, ops, roots, smb};
use std::sync::Arc;
use tauri::{AppHandle, Manager};

/// Progress, straight into the webview — the arrangement the core used to have
/// hard-coded.
struct TauriSink(AppHandle);

impl Emitter for TauriSink {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        use tauri::Emitter as _;
        let _ = self.0.emit(event, payload);
    }
}

fn sink(app: &AppHandle) -> Sink {
    Arc::new(TauriSink(app.clone()))
}

/// The OS's own answers, which is the reason this isn't derived from `$HOME`:
/// Desktop is localized, and Windows lets OneDrive redirect it.
fn env_of(app: &AppHandle) -> Env {
    let p = app.path();
    Env {
        home: p.home_dir().ok(),
        desktop: p.desktop_dir().ok(),
        config: p.app_config_dir().ok(),
    }
}

// ---- listing and navigation ---------------------------------------------------

#[tauri::command]
async fn list_dir(
    app: AppHandle,
    path: String,
    child: Option<String>,
) -> Result<fs_cmds::Listing, String> {
    fs_cmds::list_dir(&env_of(&app), path, child).await
}

#[tauri::command]
fn home_dir(app: AppHandle) -> Result<String, String> {
    fs_cmds::home_dir(&env_of(&app))
}

#[tauri::command]
fn desktop_dir(app: AppHandle) -> Result<String, String> {
    fs_cmds::desktop_dir(&env_of(&app))
}

#[tauri::command]
fn dir_mtime(path: String) -> Option<u64> {
    fs_cmds::dir_mtime(path)
}

#[tauri::command]
fn dir_signature(path: String) -> Option<u64> {
    fs_cmds::dir_signature(path)
}

#[tauri::command]
fn file_signature(path: String) -> Option<u64> {
    fs_cmds::file_signature(path)
}

#[tauri::command]
fn native_path(path: String) -> String {
    fs_cmds::native_path(path)
}

#[tauri::command]
async fn disk_space(path: String) -> Option<fs_cmds::DiskSpace> {
    fs_cmds::disk_space(path).await
}

#[tauri::command]
async fn dir_size(path: String) -> u64 {
    fs_cmds::dir_size(path).await
}

// ---- reading files --------------------------------------------------------------

#[tauri::command]
async fn read_text_file(
    dir: String,
    name: String,
    max_bytes: usize,
) -> Result<fs_cmds::TextFile, String> {
    fs_cmds::read_text_file(dir, name, max_bytes).await
}

#[tauri::command]
async fn read_file_bytes(
    dir: String,
    name: String,
    max_bytes: usize,
) -> Result<fs_cmds::BinaryFile, String> {
    fs_cmds::read_file_bytes(dir, name, max_bytes).await
}

#[tauri::command]
async fn item_details(dir: String, name: Option<String>) -> Result<details::Details, String> {
    details::item_details(dir, name).await
}

#[tauri::command]
async fn file_thumbnail(
    dir: String,
    name: Option<String>,
    size: u32,
) -> Result<Option<String>, String> {
    details::file_thumbnail(dir, name, size).await
}

#[tauri::command]
async fn file_icon(dir: String, name: Option<String>, size: u32) -> Result<Option<String>, String> {
    icons::file_icon(dir, name, size).await
}

// ---- archives ---------------------------------------------------------------------

#[tauri::command]
fn archive_formats() -> archive::Formats {
    archive::archive_formats()
}

#[tauri::command]
fn set_archive_password(path: String, password: String) -> Result<(), String> {
    archive::set_archive_password(path, password)
}

// ---- writing (ops.rs is the only module that mutates) ------------------------------

#[tauri::command]
async fn copy_entries(
    app: AppHandle,
    id: String,
    items: Vec<ops::Item>,
    dest: String,
    overwrite: bool,
) -> Result<ops::OpResult, String> {
    ops::copy_entries(sink(&app), id, items, dest, overwrite).await
}

#[tauri::command]
async fn move_entries(
    app: AppHandle,
    id: String,
    items: Vec<ops::Item>,
    dest: String,
    overwrite: bool,
) -> Result<ops::OpResult, String> {
    ops::move_entries(sink(&app), id, items, dest, overwrite).await
}

#[tauri::command]
async fn rename_entry(dir: String, name: String, new_name: String) -> Result<(), String> {
    ops::rename_entry(dir, name, new_name).await
}

#[tauri::command]
async fn create_folder(dir: String, name: String) -> Result<(), String> {
    ops::create_folder(dir, name).await
}

#[tauri::command]
async fn trash_entries(
    app: AppHandle,
    id: String,
    items: Vec<ops::Item>,
) -> Result<ops::OpResult, String> {
    ops::trash_entries(sink(&app), id, items).await
}

#[tauri::command]
async fn create_archive(
    app: AppHandle,
    id: String,
    items: Vec<ops::Item>,
    dest: String,
    name: String,
) -> Result<ops::OpResult, String> {
    ops::create_archive(sink(&app), id, items, dest, name).await
}

#[tauri::command]
fn cancel_op(id: String) {
    ops::cancel_op(id)
}

// ---- roots, network, state ----------------------------------------------------------

#[tauri::command]
fn fs_roots() -> Vec<roots::FsRoot> {
    roots::fs_roots()
}

#[tauri::command]
fn dropbox_dir(app: AppHandle) -> Option<String> {
    roots::dropbox_dir(&env_of(&app))
}

#[tauri::command]
async fn smb_login(host: String, user: String, password: String) -> Result<(), String> {
    smb::smb_login(host, user, password).await
}

/// The window starts hidden (`visible: false` in tauri.conf.json) and the
/// frontend calls this once it has fully rendered — otherwise the webview's
/// default white background flashes for the first few hundred ms while the page
/// loads. See the double-rAF `show_main_window` call at the end of main.ts init.
#[tauri::command]
fn show_main_window(window: tauri::WebviewWindow) {
    let _ = window.show();
    let _ = window.set_focus();
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_drag::init())
        // Remembers window size/position across launches (see first-run sizing
        // below). VISIBLE is excluded: restoring it would show the window during
        // setup, before the webview has painted — the exact white flash that
        // `visible: false` prevents. The frontend reveals the window itself.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        .difference(tauri_plugin_window_state::StateFlags::VISIBLE),
                )
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            list_dir,
            smb_login,
            home_dir,
            desktop_dir,
            dir_mtime,
            dir_signature,
            file_signature,
            read_text_file,
            read_file_bytes,
            native_path,
            disk_space,
            dir_size,
            copy_entries,
            move_entries,
            rename_entry,
            create_folder,
            trash_entries,
            cancel_op,
            create_archive,
            archive_formats,
            set_archive_password,
            file_icon,
            item_details,
            file_thumbnail,
            actions::open_path,
            actions::open_in_editor,
            actions::show_info,
            actions::quicklook,
            actions::quicklook_close,
            actions::toggle_devtools,
            actions::close_devtools,
            fs_roots,
            dropbox_dir,
            settings::load_state,
            settings::save_state,
            show_main_window,
        ])
        .setup(|app| {
            menu::install(app.handle())?;
            actions::init(app.handle().clone());

            // First launch (no saved window state yet): open at 80% of the
            // screen, centered. Later launches are restored by the plugin.
            let has_state = app
                .path()
                .app_config_dir()
                .map(|d| d.join(".window-state.json").exists())
                .unwrap_or(false);
            if !has_state {
                if let Some(win) = app.get_webview_window("main") {
                    let monitor = win.current_monitor().ok().flatten().or(win.primary_monitor().ok().flatten());
                    if let Some(m) = monitor {
                        let sz = m.size();
                        let scale = m.scale_factor();
                        let w = sz.width as f64 * 0.8 / scale;
                        let h = sz.height as f64 * 0.8 / scale;
                        let _ = win.set_size(tauri::LogicalSize::new(w, h));
                        let _ = win.center();
                    }
                }
            }

            // Failsafe for the hidden start: if the frontend dies before it can
            // call show_main_window (JS error, asset failure), reveal the window
            // anyway after a beat — a broken page beats an invisible app.
            if let Some(win) = app.get_webview_window("main") {
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    if !win.is_visible().unwrap_or(true) {
                        let _ = win.show();
                    }
                });
            }

            // macOS 13.3+ requires WKWebView.isInspectable = true for the Web
            // Inspector to open; Tauri only sets it in debug, so force it here.
            #[cfg(target_os = "macos")]
            {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.with_webview(|webview| {
                        let obj: *mut objc2::runtime::AnyObject = webview.inner().cast();
                        unsafe {
                            let _: () = objc2::msg_send![obj, setInspectable: true];
                        }
                    });
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Delight");
}
