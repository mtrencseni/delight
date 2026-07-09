//! App state persistence: a single JSON file in the app's own config dir.
//! The schema lives in the frontend; Rust stores it opaquely. Delight never
//! writes anywhere else.

use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

fn state_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

#[tauri::command]
pub fn load_state(app: tauri::AppHandle) -> Result<Value, String> {
    let p = state_path(&app)?;
    match fs::read_to_string(&p) {
        Ok(s) => Ok(serde_json::from_str(&s).unwrap_or(Value::Null)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn save_state(app: tauri::AppHandle, state: Value) -> Result<(), String> {
    let p = state_path(&app)?;
    let bytes = serde_json::to_vec_pretty(&state).map_err(|e| e.to_string())?;
    // Write-then-rename so a crash mid-write can't corrupt the file.
    let tmp = p.with_extension("json.tmp");
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &p).map_err(|e| e.to_string())
}
