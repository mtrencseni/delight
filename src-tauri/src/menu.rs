//! Custom app menu — macOS only.
//!
//! On macOS the menu lives in the global menu bar (its own row at the top of the
//! screen), so it doesn't intrude on Delight's window. The default Tauri menu
//! binds Cmd+W to "Close Window" and Cmd+T is reserved for tabs — Delight
//! handles both in the webview, so we install a minimal menu without conflicting
//! key equivalents, and rely on the Edit submenu for the native ⌘C/X/V/Z roles.
//!
//! On Windows/Linux a menu bar is a strip *inside* the window painted by the OS
//! in system colors — it can't be themed to match Delight's own design and it
//! would clash with the integrated tab-bar titlebar. So there is no native menu
//! off macOS: the webview keeps every shortcut (WebView2/WebKitGTK handle the
//! native clipboard combos in text fields), and `install` is a no-op.

#[cfg(target_os = "macos")]
pub fn install<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    use tauri::menu::{AboutMetadata, MenuBuilder, SubmenuBuilder};

    let app_menu = SubmenuBuilder::new(app, "Delight")
        .about(Some(AboutMetadata::default()))
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .fullscreen()
        .build()?;
    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &edit, &window])
        .build()?;
    app.set_menu(menu)?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn install<R: tauri::Runtime>(_app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    Ok(())
}
