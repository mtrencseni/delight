mod actions;
mod details;
mod fs_cmds;
mod icons;
mod menu;
mod ops;
mod roots;
mod settings;

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
            fs_cmds::list_dir,
            fs_cmds::home_dir,
            fs_cmds::dir_mtime,
            fs_cmds::dir_signature,
            fs_cmds::read_text_file,
            ops::copy_entries,
            ops::move_entries,
            ops::rename_entry,
            ops::create_folder,
            ops::trash_entries,
            icons::file_icon,
            details::item_details,
            details::file_thumbnail,
            actions::open_path,
            actions::quicklook,
            actions::quicklook_close,
            actions::toggle_devtools,
            actions::close_devtools,
            roots::fs_roots,
            roots::dropbox_dir,
            settings::load_state,
            settings::save_state,
            show_main_window,
        ])
        .setup(|app| {
            use tauri::Manager;
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
