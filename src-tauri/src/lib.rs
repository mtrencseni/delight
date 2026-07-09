mod actions;
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
            actions::open_path,
            actions::quicklook,
            actions::quicklook_close,
            roots::fs_roots,
            settings::load_state,
            settings::save_state,
        ])
        .setup(|app| {
            menu::install(app.handle())?;
            actions::init(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Delight");
}
