mod actions;
mod details;
mod fs_cmds;
mod icons;
mod menu;
mod roots;
mod settings;

pub fn run() {
    tauri::Builder::default()
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
            settings::load_state,
            settings::save_state,
        ])
        .setup(|app| {
            menu::install(app.handle())?;
            actions::init(app.handle().clone());
            // macOS 13.3+ requires WKWebView.isInspectable = true for the Web
            // Inspector to open; Tauri only sets it in debug, so force it here.
            #[cfg(target_os = "macos")]
            {
                use tauri::Manager;
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
