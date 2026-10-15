//! Rich per-item info for the chips view: created time, owner, default app,
//! folder count + first children, and a QuickLook content thumbnail. Fetched
//! only for the one selected item, so it never touches the listing hot path.

use crate::icons::to_data_uri;
use crate::archive::{self, Loc};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChildEntry {
    name: String,
    is_dir: bool,
    is_symlink: bool,
    ext: Option<String>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Details {
    created_ms: Option<i64>,
    owner: Option<String>,
    permissions: Option<String>,
    app_name: Option<String>,
    app_path: Option<String>,
    dir_count: Option<u64>,
    children: Vec<ChildEntry>,
}

fn join(dir: String, name: Option<String>) -> PathBuf {
    let mut p = PathBuf::from(dir);
    if let Some(n) = name {
        p.push(n);
    }
    p
}

fn split_ext(name: &str, is_dir: bool) -> Option<String> {
    if is_dir {
        return None;
    }
    Path::new(name)
        .extension()
        .map(|e| e.to_string_lossy().into_owned())
}

pub async fn item_details(dir: String, name: Option<String>) -> Result<Details, String> {
    // Remote: what SFTP can answer (permissions, child preview). Creation time,
    // owner names and "opens with" have no remote equivalent and stay empty.
    if crate::sftp::is_sftp(&dir) {
        let info = crate::sftp::info(&dir, name.as_deref(), 9).await?;
        return Ok(Details {
            permissions: info.permissions,
            dir_count: info.dir_count,
            children: info
                .children
                .into_iter()
                .map(|(n, is_dir, is_symlink)| ChildEntry {
                    ext: split_ext(&n, is_dir),
                    name: n,
                    is_dir,
                    is_symlink,
                })
                .collect(),
            ..Default::default()
        });
    }
    let dir = crate::smb::localize(&dir);
    // Inside an archive there is nothing on disk to stat, so the same details are
    // assembled from the index instead.
    if let Loc::Archive { archive, inner } = Loc::parse(&dir) {
        let inner = match &name {
            Some(n) => archive::normalize_inner(&format!("{inner}/{n}")),
            None => inner,
        };
        return tokio::task::spawn_blocking(move || archive_details(&archive, &inner))
            .await
            .map_err(|e| e.to_string());
    }
    let p = join(dir, name);
    tokio::task::spawn_blocking(move || gather(&p))
        .await
        .map_err(|e| e.to_string())
}

/// `ls -l`-style string from raw mode bits (archives give us a number, not a
/// Metadata, so `fs_cmds::perm_string` doesn't apply).
fn mode_string(mode: u32, is_dir: bool, is_link: bool) -> String {
    let t = if is_link {
        'l'
    } else if is_dir {
        'd'
    } else {
        '-'
    };
    let bit = |shift: u32, ch: char| if mode & (1 << shift) != 0 { ch } else { '-' };
    [
        t,
        bit(8, 'r'), bit(7, 'w'), bit(6, 'x'),
        bit(5, 'r'), bit(4, 'w'), bit(3, 'x'),
        bit(2, 'r'), bit(1, 'w'), bit(0, 'x'),
    ]
    .iter()
    .collect()
}

/// Details for something inside an archive. Mirrors `gather`'s shape (dirs-first
/// children, capped at 9) so the chips view looks the same either side of the
/// boundary. Creation time, owner and default-app don't exist here.
fn archive_details(archive: &Path, inner: &str) -> Details {
    let mut d = Details::default();
    let Ok(index) = archive::index_for(archive) else {
        return d;
    };
    let me = index.members.iter().find(|m| m.path == inner);
    if let Some(m) = me {
        d.permissions = m.mode.map(|mode| mode_string(mode, m.is_dir, m.is_link));
    }
    // The archive root is a directory even though it has no member of its own.
    let is_dir = me.map(|m| m.is_dir).unwrap_or_else(|| inner.is_empty());
    if !is_dir {
        return d;
    }
    let mut all: Vec<ChildEntry> = index
        .children(inner)
        .into_iter()
        .filter(|m| !m.name.starts_with('.'))
        .map(|m| ChildEntry {
            name: m.name.clone(),
            is_dir: m.is_dir,
            is_symlink: m.is_link,
            ext: split_ext(&m.name, m.is_dir),
        })
        .collect();
    all.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    d.dir_count = Some(all.len() as u64);
    all.truncate(9);
    d.children = all;
    d
}

fn gather(p: &PathBuf) -> Details {
    let mut d = Details::default();
    let Ok(meta) = std::fs::metadata(p) else {
        return d;
    };
    d.created_ms = meta
        .created()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|x| x.as_millis() as i64);

    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        d.owner = uzers::get_user_by_uid(meta.uid())
            .map(|u| u.name().to_string_lossy().into_owned());
    }

    // Permission bits from the link's own metadata (matches the listing).
    if let Ok(lmeta) = std::fs::symlink_metadata(p) {
        let is_symlink = lmeta.file_type().is_symlink();
        d.permissions = crate::fs_cmds::perm_string(&lmeta, is_symlink);
    }

    if meta.is_dir() {
        if let Ok(rd) = std::fs::read_dir(p) {
            // Collect non-hidden entries, dirs-first by name (matches the pane).
            let mut all: Vec<ChildEntry> = rd
                .flatten()
                .filter_map(|de| {
                    let name = de.file_name().to_string_lossy().into_owned();
                    if name.starts_with('.') {
                        return None;
                    }
                    let ft = de.file_type().ok()?;
                    let is_symlink = ft.is_symlink();
                    let is_dir = if is_symlink {
                        std::fs::metadata(de.path()).map(|m| m.is_dir()).unwrap_or(false)
                    } else {
                        ft.is_dir()
                    };
                    let ext = split_ext(&name, is_dir);
                    Some(ChildEntry { name, is_dir, is_symlink, ext })
                })
                .collect();
            all.sort_by(|a, b| match (a.is_dir, b.is_dir) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
            });
            d.dir_count = Some(all.len() as u64);
            all.truncate(9);
            d.children = all;
        }
    } else {
        #[cfg(target_os = "macos")]
        if let Some((n, path)) = default_app(p) {
            d.app_name = Some(n);
            d.app_path = Some(path);
        }
    }
    d
}

/// The app macOS would use to open this file: (display name, bundle path).
#[cfg(target_os = "macos")]
fn default_app(p: &Path) -> Option<(String, String)> {
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSString, NSURL};
    let ws = NSWorkspace::sharedWorkspace();
    let url = NSURL::fileURLWithPath(&NSString::from_str(&p.to_string_lossy()));
    let app_url = ws.URLForApplicationToOpenURL(&url)?;
    let path = app_url.path()?.to_string();
    let name = Path::new(&path)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.clone());
    Some((name, path))
}

/// QuickLook content thumbnail (macOS) as a PNG data URI, or None.
pub async fn file_thumbnail(
    dir: String,
    name: Option<String>,
    size: u32,
) -> Result<Option<String>, String> {
    let p = join(crate::smb::localize(&dir), name);
    tokio::task::spawn_blocking(move || thumbnail(&p, size))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
fn thumbnail(p: &Path, size: u32) -> Option<String> {
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);

    let out = std::env::temp_dir().join(format!(
        "dl_thumb_{}_{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&out).ok()?;
    let ok = Command::new("qlmanage")
        .arg("-t")
        .arg("-s")
        .arg(size.to_string())
        .arg("-o")
        .arg(&out)
        .arg(p)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    let result = if ok {
        std::fs::read_dir(&out)
            .ok()
            .and_then(|rd| {
                rd.flatten()
                    .map(|e| e.path())
                    .find(|pp| pp.extension().map(|e| e == "png").unwrap_or(false))
            })
            .and_then(|png| std::fs::read(&png).ok())
            .map(|bytes| to_data_uri(&bytes))
    } else {
        None
    };
    std::fs::remove_dir_all(&out).ok();
    result
}

// Windows: pull a thumbnail (images/video/PDF/office) or the file's high-res
// shell icon via IShellItemImageFactory — the same source Explorer uses. Runs on
// a spawn_blocking thread (see file_thumbnail), so it inits COM per call.
#[cfg(target_os = "windows")]
fn thumbnail(p: &Path, size: u32) -> Option<String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::SIZE;
    use windows::Win32::Graphics::Gdi::{DeleteObject, HBITMAP};
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::{
        IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_RESIZETOFIT,
    };

    let wide: Vec<u16> = p.as_os_str().encode_wide().chain(std::iter::once(0)).collect();

    unsafe {
        // Shell thumbnail handlers expect an STA; RPC_E_CHANGED_MODE (thread was
        // already initialized in another mode) is harmless — GetImage still works.
        let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let inited = hr.is_ok();

        let bytes = (|| {
            let factory: IShellItemImageFactory =
                SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None).ok()?;
            let hbitmap: HBITMAP = factory
                .GetImage(SIZE { cx: size as i32, cy: size as i32 }, SIIGBF_RESIZETOFIT)
                .ok()?;
            let png = hbitmap_to_png(hbitmap);
            let _ = DeleteObject(hbitmap);
            png
        })();

        if inited {
            CoUninitialize();
        }
        bytes.map(|b| to_data_uri(&b))
    }
}

/// Copy an HBITMAP's pixels out as a top-down 32bpp buffer and encode PNG.
#[cfg(target_os = "windows")]
unsafe fn hbitmap_to_png(hbitmap: windows::Win32::Graphics::Gdi::HBITMAP) -> Option<Vec<u8>> {
    use windows::Win32::Graphics::Gdi::{
        GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER,
        DIB_RGB_COLORS,
    };

    let mut bm = BITMAP::default();
    let got = GetObjectW(
        hbitmap,
        std::mem::size_of::<BITMAP>() as i32,
        Some(&mut bm as *mut _ as *mut _),
    );
    if got == 0 || bm.bmWidth <= 0 || bm.bmHeight <= 0 {
        return None;
    }
    let (w, h) = (bm.bmWidth as u32, bm.bmHeight as u32);

    let mut info = BITMAPINFO::default();
    info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    info.bmiHeader.biWidth = w as i32;
    info.bmiHeader.biHeight = -(h as i32); // negative height → top-down rows
    info.bmiHeader.biPlanes = 1;
    info.bmiHeader.biBitCount = 32;
    info.bmiHeader.biCompression = 0; // BI_RGB (uncompressed)

    let mut buf = vec![0u8; (w * h * 4) as usize];
    let hdc = GetDC(None);
    let lines = GetDIBits(
        hdc,
        hbitmap,
        0,
        h,
        Some(buf.as_mut_ptr() as *mut _),
        &mut info,
        DIB_RGB_COLORS,
    );
    ReleaseDC(None, hdc);
    if lines == 0 {
        return None;
    }

    // Windows hands back BGRA; PNG wants RGBA.
    for px in buf.chunks_exact_mut(4) {
        px.swap(0, 2);
    }
    let img = image::RgbaImage::from_raw(w, h, buf)?;
    let mut out = Vec::new();
    image::DynamicImage::ImageRgba8(img)
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .ok()?;
    Some(out)
}

#[cfg(all(test, target_os = "windows"))]
mod win_thumb_tests {
    use std::path::PathBuf;

    // Regression guard for the Shell thumbnail path, run through the app's exact
    // threading (spawn_blocking on the tokio pool). explorer.exe is always present
    // and always yields at least its shell icon → a PNG data URI.
    #[test]
    fn shell_thumbnail_produces_png_data_uri() {
        let p = PathBuf::from(r"C:\Windows\explorer.exe");
        if !p.exists() {
            return;
        }
        let uri = tokio::runtime::Runtime::new().unwrap().block_on(async move {
            tokio::task::spawn_blocking(move || super::thumbnail(&p, 256))
                .await
                .unwrap()
        });
        assert!(
            uri.as_deref()
                .is_some_and(|s| s.starts_with("data:image/png;base64,")),
            "expected a PNG data URI, got {uri:?}"
        );
    }
}

// Linux: the freedesktop thumbnail cache — whatever GNOME Files, Dolphin or
// Thunar already rendered for this file, found under the spec's key (md5 of the
// file URI). Read-only like the other two platforms: Delight never renders or
// writes thumbnails, so a file no other app has shown yet simply has none.
// ponytail: the cache's Thumb::MTime isn't checked, so an edited file can show
// its old thumbnail until the desktop refreshes it.
#[cfg(target_os = "linux")]
fn thumbnail(p: &Path, size: u32) -> Option<String> {
    use md5::{Digest, Md5};
    let hash = format!("{:x}", Md5::digest(file_uri(p).as_bytes()));
    let cache = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")))?
        .join("thumbnails");
    // Smallest cached size that still covers the request, else the biggest there is.
    const DIRS: [(&str, u32); 4] =
        [("normal", 128), ("large", 256), ("x-large", 512), ("xx-large", 1024)];
    let order = DIRS
        .iter()
        .filter(|d| d.1 >= size)
        .chain(DIRS.iter().rev().filter(|d| d.1 < size));
    for (dir, _) in order {
        if let Ok(png) = std::fs::read(cache.join(dir).join(format!("{hash}.png"))) {
            return Some(to_data_uri(&png));
        }
    }
    None
}

/// The `file://` URI as g_filename_to_uri spells it — RFC 2396 unreserved
/// characters and `/` kept, every other byte percent-encoded — because that
/// exact string is what the thumbnail cache hashes.
#[cfg(target_os = "linux")]
fn file_uri(p: &Path) -> String {
    use std::os::unix::ffi::OsStrExt;
    let mut s = String::from("file://");
    for &b in p.as_os_str().as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*'
            | b'\'' | b'(' | b')' | b'/' => s.push(b as char),
            _ => s.push_str(&format!("%{b:02X}")),
        }
    }
    s
}

#[cfg(all(test, target_os = "linux"))]
mod linux_tests {
    #[test]
    fn file_uri_matches_glib() {
        // g_filename_to_uri("/home/me/My Photos/ünï.jpg")
        assert_eq!(
            super::file_uri(std::path::Path::new("/home/me/My Photos/ünï.jpg")),
            "file:///home/me/My%20Photos/%C3%BCn%C3%AF.jpg"
        );
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn thumbnail(_p: &Path, _size: u32) -> Option<String> {
    None
}
