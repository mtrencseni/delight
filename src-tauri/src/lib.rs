mod actions;
mod details;
mod fs_cmds;
mod icons;
mod menu;
mod roots;
mod settings;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_drag::init())
        // Remembers window size/position across launches (see first-run sizing below).
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            fs_cmds::list_dir,
            fs_cmds::home_dir,
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
