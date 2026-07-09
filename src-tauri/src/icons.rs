//! System file icons: pull the OS-registered icon for a path and hand it to the
//! webview as a PNG data URI. macOS uses NSWorkspace (the same icons Finder
//! shows); other platforms return None for now (v0.2: Windows SHGetFileInfo,
//! Linux freedesktop icon themes).

use base64::Engine;
use std::path::PathBuf;

#[tauri::command]
pub async fn file_icon(
    dir: String,
    name: Option<String>,
    size: u32,
) -> Result<Option<String>, String> {
    let mut p = PathBuf::from(dir);
    if let Some(n) = name {
        p.push(n);
    }
    // Icon lookup can touch disk; keep it off the UI/runtime thread.
    tauri::async_runtime::spawn_blocking(move || icon_data_uri(&p, size))
        .await
        .map_err(|e| e.to_string())
}

fn to_data_uri(png: &[u8]) -> String {
    let b64 = base64::engine::general_purpose::STANDARD.encode(png);
    format!("data:image/png;base64,{b64}")
}

#[cfg(target_os = "macos")]
fn icon_data_uri(path: &PathBuf, size: u32) -> Option<String> {
    use objc2::AnyThread;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSWorkspace};
    use objc2_foundation::{NSDictionary, NSString};

    let path_str = path.to_string_lossy();
    // The workspace icon's own reps are private (non-bitmap) types, so render it
    // to PNG via a bitmap rep — that yields the full-resolution master (~1024px).
    let master_png: Vec<u8> = unsafe {
        let workspace = NSWorkspace::sharedWorkspace();
        let ns_path = NSString::from_str(&path_str);
        let image = workspace.iconForFile(&ns_path);
        let tiff = image.TIFFRepresentation()?;
        let rep = NSBitmapImageRep::initWithData(NSBitmapImageRep::alloc(), &tiff)?;
        let props = NSDictionary::new();
        let data = rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &props)?;
        data.to_vec()
    };
    // Downscale to the display size so the data URI stays small; still crisp far
    // past our zoom range. Resize preserves aspect (icons are square).
    let img = image::load_from_memory(&master_png).ok()?;
    let scaled = img.resize(size, size, image::imageops::FilterType::Lanczos3);
    let mut out = Vec::new();
    scaled
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .ok()?;
    Some(to_data_uri(&out))
}

#[cfg(not(target_os = "macos"))]
fn icon_data_uri(_path: &PathBuf, _size: u32) -> Option<String> {
    None
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn fetches_a_real_icon() {
        // A path that always exists on macOS with a distinctive icon.
        let uri = icon_data_uri(&PathBuf::from("/System/Applications/Utilities"), 128)
            .expect("expected an icon data URI");
        assert!(uri.starts_with("data:image/png;base64,"));
        let b64 = uri.strip_prefix("data:image/png;base64,").unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .expect("valid base64");
        // PNG magic number.
        assert_eq!(&bytes[..8], &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
        // IHDR width/height live at bytes 16..24 (big-endian).
        let w = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
        let h = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
        eprintln!("icon png: {} bytes, {w}x{h}", bytes.len());
        assert!(w >= 32 && h >= 32, "icon unexpectedly small: {w}x{h}");
    }
}
