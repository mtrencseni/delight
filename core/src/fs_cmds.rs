use crate::archive::{self, Loc};
use crate::sftp;
use crate::smb;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use crate::env::Env;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub(crate) name: String,
    pub(crate) stem: String,
    pub(crate) ext: Option<String>,
    pub(crate) is_dir: bool,
    pub(crate) is_symlink: bool,
    pub(crate) size: u64,
    pub(crate) modified_ms: Option<i64>,
    pub(crate) created_ms: Option<i64>,
    pub(crate) permissions: Option<String>,
    pub(crate) hidden: bool,
}

/// `ls -l`-style type + rwx string, e.g. "drwxr-xr-x" or "-rw-r--r--".
pub fn perm_string(meta: &std::fs::Metadata, is_symlink: bool) -> Option<String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = meta.permissions().mode();
        let t = if is_symlink {
            'l'
        } else if meta.is_dir() {
            'd'
        } else {
            '-'
        };
        let bit = |shift: u32, ch: char| if mode & (1 << shift) != 0 { ch } else { '-' };
        let s: String = [
            t,
            bit(8, 'r'), bit(7, 'w'), bit(6, 'x'),
            bit(5, 'r'), bit(4, 'w'), bit(3, 'x'),
            bit(2, 'r'), bit(1, 'w'), bit(0, 'x'),
        ]
        .iter()
        .collect();
        Some(s)
    }
    #[cfg(not(unix))]
    {
        let _ = (meta, is_symlink);
        None
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub(crate) path: String,
    pub(crate) name: String,
    pub(crate) parent: Option<String>,
    pub(crate) entries: Vec<Entry>,
    /// True inside an archive: the UI greys out rename/move/delete/new-folder and
    /// only offers copy-out.
    pub(crate) read_only: bool,
}

fn friendly_io(e: &std::io::Error) -> String {
    use std::io::ErrorKind;
    match e.kind() {
        ErrorKind::PermissionDenied => "Permission denied".into(),
        ErrorKind::NotFound => "No such folder".into(),
        ErrorKind::NotADirectory => "Not a folder".into(),
        _ => e.to_string(),
    }
}

fn expand_home(input: &str, home: Option<&PathBuf>) -> PathBuf {
    if let (Some(home), Some(rest)) = (home, input.strip_prefix('~')) {
        if rest.is_empty() {
            return home.clone();
        }
        let rest = rest.trim_start_matches(std::path::MAIN_SEPARATOR);
        if rest.len() < input.len() - 1 {
            return home.join(rest);
        }
    }
    PathBuf::from(input)
}

/// Whether an entry should be treated as hidden (folded away unless "show hidden"
/// is on). Unix: dotfiles. Windows: the HIDDEN or SYSTEM file attribute — which is
/// how Windows actually marks `$Recycle.Bin`, `System Volume Information`,
/// `pagefile.sys`, `desktop.ini`, … (dotfiles are still honored too, for tools
/// that create them). `meta` is the entry's own metadata (symlinks not followed).
#[cfg(windows)]
fn is_hidden(name: &str, meta: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;
    name.starts_with('.') || meta.file_attributes() & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM) != 0
}

#[cfg(not(windows))]
fn is_hidden(name: &str, _meta: &std::fs::Metadata) -> bool {
    name.starts_with('.')
}

fn read_listing(path: String, child: Option<String>, home: Option<PathBuf>) -> Result<Listing, String> {
    let mut p = expand_home(path.trim(), home.as_ref());
    if let Some(c) = child {
        p.push(c);
    }
    // dunce::canonicalize == fs::canonicalize but strips Windows' \\?\ verbatim
    // prefix (no-op on Unix), so the path we hand back to the UI is the ordinary
    // C:\… form users expect — and every downstream join/compare stays uniform.
    let p = dunce::canonicalize(&p).map_err(|e| friendly_io(&e))?;
    let rd = fs::read_dir(&p).map_err(|e| friendly_io(&e))?;

    let mut entries = Vec::new();
    for de in rd.flatten() {
        let name = de.file_name().to_string_lossy().into_owned();
        // DirEntry::metadata does not follow symlinks.
        let Ok(smeta) = de.metadata() else { continue };
        let is_symlink = smeta.file_type().is_symlink();
        // For symlinks, follow to the target for dir-ness/size; fall back to the
        // link's own metadata when the target is unresolvable.
        let fmeta = if is_symlink { fs::metadata(de.path()).ok() } else { None };
        let meta = fmeta.as_ref().unwrap_or(&smeta);
        let is_dir = meta.is_dir();
        let size = if is_dir { 0 } else { meta.len() };
        let to_ms = |t: std::time::SystemTime| t.duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as i64);
        let modified_ms = meta.modified().ok().and_then(to_ms);
        let created_ms = meta.created().ok().and_then(to_ms);
        // Permissions reflect the link's own bits (matches `ls -l` on symlinks).
        let permissions = perm_string(&smeta, is_symlink);
        let as_path = Path::new(&name);
        let (stem, ext) = if is_dir {
            (name.clone(), None)
        } else {
            (
                as_path
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_else(|| name.clone()),
                as_path.extension().map(|e| e.to_string_lossy().into_owned()),
            )
        };
        let hidden = is_hidden(&name, &smeta);
        entries.push(Entry {
            name,
            stem,
            ext,
            is_dir,
            is_symlink,
            size,
            modified_ms,
            created_ms,
            permissions,
            hidden,
        });
    }

    let parent = p.parent().map(|q| q.to_string_lossy().into_owned());
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| p.to_string_lossy().into_owned());
    Ok(Listing {
        path: p.to_string_lossy().into_owned(),
        name,
        parent,
        entries,
        read_only: false,
    })
}

/// Resolve `path` (+ optional `child`) to a location, entering an archive when
/// the child is one — that's what makes ⌘/Ctrl+Enter on a `.zip` descend into it.
fn resolve(path: &str, child: Option<String>) -> Loc {
    match (Loc::parse(path), child) {
        // Inside an archive, a child is just another inner path component.
        (Loc::Archive { archive, inner }, child) => {
            let inner = match child {
                Some(c) => archive::normalize_inner(&format!("{inner}/{c}")),
                None => inner,
            };
            Loc::Archive { archive, inner }
        }
        // On disk: descending into an archive *file* crosses the boundary. A
        // directory that merely ends in ".zip" is still just a directory.
        (Loc::Local(p), Some(c)) if archive::is_archive_name(&c) && p.join(&c).is_file() => {
            Loc::Archive { archive: p.join(c), inner: String::new() }
        }
        (Loc::Local(p), Some(c)) => Loc::Local(p.join(c)),
        (Loc::Local(p), None) => Loc::Local(p),
    }
}

pub async fn list_dir(
    env: &Env,
    path: String,
    child: Option<String>,
) -> Result<Listing, String> {
    // SFTP is genuinely async (a protocol conversation, not a blocking syscall),
    // so it runs on the async runtime rather than a spawn_blocking thread.
    if sftp::is_sftp(&path) {
        return sftp::list(&path, child.as_deref()).await;
    }
    let home = env.home.clone();
    tokio::task::spawn_blocking(move || {
        if smb::is_smb(&path) {
            return smb_list(&path, child, home);
        }
        match resolve(&path, child.clone()) {
            Loc::Archive { archive, inner } if archive.is_file() => archive::list(&archive, &inner),
            // A path that looks archive-ish but isn't a file (e.g. a folder literally
            // named "foo.zip") browses as an ordinary directory.
            Loc::Archive { archive, inner } => {
                let joined = archive.join(inner.replace('/', std::path::MAIN_SEPARATOR_STR));
                read_listing(joined.to_string_lossy().into_owned(), None, home)
            }
            Loc::Local(_) => read_listing(path, child, home),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// List an smb:// location. Host level enumerates the server's shares; below
/// that it's the ordinary listing over the OS-native path (a UNC path on
/// Windows, a mount point on macOS), with every path in the result rewritten
/// back to canonical smb:// form — the UI never sees either. Archives inside
/// shares compose: the translated path goes through the same resolve() as
/// everything else.
///
/// One body for both platforms: everything that differs is behind
/// `smb::localize_checked` / `delocalize` / `list_shares`.
#[cfg(any(windows, target_os = "macos"))]
fn smb_list(path: &str, child: Option<String>, home: Option<PathBuf>) -> Result<Listing, String> {
    let Some(url) = smb::SmbUrl::parse(path) else {
        return Err("Not a valid smb:// path".into());
    };
    if url.rest.is_empty() && child.is_none() {
        let entries = smb::list_shares(&url)?;
        return Ok(Listing {
            path: url.host_canonical(),
            name: url.host.clone(),
            parent: None,
            entries,
            read_only: false,
        });
    }
    // Entering a share from the host listing: fold it into the URL. A share is
    // always a directory, so there's no archive-descent case to preserve — and
    // it means the translation layer is always handed a path that names its
    // share, which is what macOS needs in order to know what to mount.
    let (url, child) = match (url.rest.is_empty(), child) {
        (true, Some(c)) => (
            smb::SmbUrl::parse(&format!("{}/{}", url.host_canonical(), c))
                .ok_or("Not a valid smb:// path")?,
            None,
        ),
        (_, child) => (url, child),
    };
    // The one call allowed to have side effects: on macOS this mounts the share
    // if it isn't mounted yet. It can also fail with the auth sentinel, which
    // is why it runs before the listing rather than inside it.
    let native = smb::localize_checked(&url.canonical())?;
    let mut l = match resolve(&native, child.clone()) {
        Loc::Archive { archive, inner } if archive.is_file() => archive::list(&archive, &inner),
        Loc::Archive { archive, inner } => {
            let joined = archive.join(inner.replace('/', std::path::MAIN_SEPARATOR_STR));
            read_listing(joined.to_string_lossy().into_owned(), None, home)
        }
        Loc::Local(_) => read_listing(native, child, home),
    }
    .map_err(|e| {
        if smb::is_auth_error(&e) {
            smb::AUTH_NEEDED.to_string()
        } else {
            e
        }
    })?;

    l.path = smb::delocalize(&l.path, &url);
    l.parent = l.parent.as_deref().map(|p| smb::delocalize(p, &url));
    // Above a share root the native parent leaves the SMB tree altogether:
    // Windows reports None (the UNC prefix owns \\host\share), macOS reports
    // /Volumes, the directory the mount happens to live in. Neither is
    // something the UI may see — the real parent is the server's share list.
    let host_canon = url.host_canonical();
    if !l.parent.as_deref().is_some_and(smb::is_smb) {
        l.parent = Some(host_canon.clone());
    }
    // Name: last canonical segment — splitting on the archive marker too, so
    // inside an archive the innermost folder (not "x.zip!docs") is the name.
    l.name = match l.path.strip_prefix(&format!("{host_canon}/")) {
        Some(rest) => rest
            .rsplit(['/', '!'])
            .find(|s| !s.is_empty())
            .unwrap_or(&url.host)
            .to_string(),
        None => url.host.clone(),
    };
    Ok(l)
}

#[cfg(not(any(windows, target_os = "macos")))]
fn smb_list(_path: &str, _child: Option<String>, _home: Option<PathBuf>) -> Result<Listing, String> {
    Err(smb::NOT_SUPPORTED.into())
}

pub fn home_dir(env: &Env) -> Result<String, String> {
    env.home
        .as_ref()
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| "no home directory".to_string())
}

/// The user's Desktop. Asked of the OS rather than joined onto the home
/// directory: the folder is localized, and Windows lets it be redirected —
/// OneDrive does exactly that by default — so `<home>/Desktop` is often simply
/// the wrong place, or no place at all.
pub fn desktop_dir(env: &Env) -> Result<String, String> {
    env.desktop
        .as_ref()
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| "no desktop directory".to_string())
}

/// A directory's modified time in epoch millis. Bumps whenever an entry is
/// added or removed (used by the frontend to auto-refresh a pane when its
/// folder changes on disk). Read-only stat; None if the dir is gone/unreadable.
pub fn dir_mtime(path: String) -> Option<u64> {
    let path = smb::localize(&path);
    // Inside an archive the archive file's own mtime is the answer: its contents
    // can't change without the file changing.
    let target = match Loc::parse(&path) {
        Loc::Archive { archive, .. } => archive,
        Loc::Local(p) => p,
    };
    std::fs::metadata(&target)
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

/// The same idea as [`dir_signature`], for ONE file: size and modified time,
/// folded together. The preview polls this so an editor saving over the file
/// being previewed refreshes it, rather than leaving yesterday's text on screen
/// looking current.
///
/// A member inside an archive is stamped by its archive, since the archive is
/// what would have to change for the member to. Remote paths opt out for the
/// same reason directory polling does: a poll every 1.5 s over SFTP is chatty
/// for a question that navigation already answers.
pub fn file_signature(path: String) -> Option<u64> {
    if sftp::is_sftp(&path) {
        return None;
    }
    let path = smb::localize(&path);
    let (a, b) = match Loc::parse(&path) {
        Loc::Archive { archive, .. } => archive::stamp(&archive).ok()?,
        Loc::Local(p) => {
            let m = fs::metadata(&p).ok()?;
            let mtime = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            (mtime, m.len())
        }
    };
    let mut h: u64 = 0xcbf29ce484222325;
    for v in [a, b] {
        h ^= v;
        h = h.wrapping_mul(0x100000001b3);
    }
    Some(h)
}

/// An order-independent hash of the directory's entries folding in each one's
/// name, size, modified time and permissions. Unlike the folder's own mtime
/// (which only bumps on add/remove/rename), this also changes when an existing
/// file's content/size or permissions change — so the auto-refresh watcher can
/// notice in-place edits. Read-only; None if the dir is gone/unreadable.
pub fn dir_signature(path: String) -> Option<u64> {
    // Remote: polling a listing every 1.5 s would be chatty over the network
    // (the frontend also skips these paths); navigation refreshes instead.
    if sftp::is_sftp(&path) {
        return None;
    }
    let path = smb::localize(&path);
    // An archive's contents are immutable while the file is unchanged, so the
    // watcher's poll costs a single stat here instead of stat-ing every entry.
    if let Loc::Archive { archive, inner } = Loc::parse(&path) {
        let (mtime, size) = archive::stamp(&archive).ok()?;
        let mut h: u64 = 0xcbf29ce484222325;
        for v in [mtime, size] {
            h ^= v;
            h = h.wrapping_mul(0x100000001b3);
        }
        for b in inner.bytes() {
            h ^= b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
        return Some(h);
    }
    let rd = fs::read_dir(&path).ok()?;
    let mut acc: u64 = 0;
    let mut count: u64 = 0;
    for entry in rd.flatten() {
        count = count.wrapping_add(1);
        // FNV-1a over this entry's identity + changeable fields.
        let mut h: u64 = 0xcbf29ce484222325;
        let mut fold = |v: u64| {
            h ^= v;
            h = h.wrapping_mul(0x100000001b3);
        };
        for b in entry.file_name().to_string_lossy().bytes() {
            fold(b as u64);
        }
        // DirEntry::metadata does not follow symlinks (lstat-like).
        if let Ok(m) = entry.metadata() {
            fold(m.len());
            let mtime = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            fold(mtime);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fold(m.permissions().mode() as u64);
            }
            #[cfg(not(unix))]
            {
                fold(m.permissions().readonly() as u64);
            }
        }
        acc = acc.wrapping_add(h); // order-independent across entries
    }
    Some(acc.wrapping_add(count.wrapping_mul(0x9e3779b97f4a7c15)))
}

/// Result of reading a text file for the code preview.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    text: String,
    /// True if the file was longer than `max_bytes` and got cut off.
    truncated: bool,
    /// True if the bytes didn't look like UTF-8 text (caller shows the plain preview).
    binary: bool,
}

/// Read a text file for the read-only code preview (never mutates anything).
/// Reads at most `max_bytes` so a huge/binary file can't stall the UI, and
/// reports back whether it truncated or the content looked binary.
pub async fn read_text_file(dir: String, name: String, max_bytes: usize) -> Result<TextFile, String> {
    if sftp::is_sftp(&dir) {
        let cap = max_bytes.max(1);
        let (buf, truncated) = sftp::read_file(&dir, &name, cap).await?;
        return Ok(text_file(buf, truncated, cap));
    }
    tokio::task::spawn_blocking(move || {
        use std::io::Read;
        let dir = smb::localize(&dir);
        let cap = max_bytes.max(1);
        // Inside an archive the member is decompressed straight into memory —
        // the preview works without ever writing a temp file.
        let (buf, truncated) = match Loc::parse(&dir) {
            Loc::Archive { archive, inner } => {
                let member = archive::normalize_inner(&format!("{inner}/{name}"));
                archive::read_member(&archive, &member, cap)?
            }
            Loc::Local(d) => {
                let path = d.join(&name);
                let file = fs::File::open(&path).map_err(|e| friendly_io(&e))?;
                let len = file.metadata().map(|m| m.len()).unwrap_or(0);
                let mut buf = Vec::with_capacity(cap.min(len as usize + 1).max(1));
                // +1 byte over the cap so we can tell "exactly max" from "longer".
                file.take(cap as u64 + 1)
                    .read_to_end(&mut buf)
                    .map_err(|e| friendly_io(&e))?;
                let truncated = buf.len() > cap;
                (buf, truncated)
            }
        };
        Ok(text_file(buf, truncated, cap))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Decide what the preview shows for some bytes: text, truncated text, or
/// "binary" (the caller then falls back to a thumbnail/icon). Shared by the
/// local, in-archive and remote readers so all three behave identically.
fn text_file(mut buf: Vec<u8>, truncated: bool, cap: usize) -> TextFile {
    let truncated = truncated || buf.len() > cap;
    if buf.len() > cap {
        buf.truncate(cap);
    }
    // A NUL byte in the sniffed prefix is the classic "this is binary" tell.
    if buf.contains(&0) {
        return TextFile { text: String::new(), truncated, binary: true };
    }
    match String::from_utf8(buf) {
        Ok(text) => TextFile { text, truncated, binary: false },
        // Lossy-decode invalid UTF-8 (e.g. latin-1) rather than fail outright,
        // but flag it so the caller can fall back to the plain preview.
        Err(e) => TextFile {
            text: String::from_utf8_lossy(e.as_bytes()).into_owned(),
            truncated,
            binary: true,
        },
    }
}

/// A file's bytes, base64'd for the IPC hop (a JSON array of numbers would be
/// ~6x larger). Powers the PDF preview for files with no local path.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryFile {
    data: String,
    /// The file was longer than the cap — the caller must NOT render this,
    /// since a truncated PDF is a corrupt one.
    truncated: bool,
}

/// Read a whole (small) file for embedding in the webview. Used where there is
/// no local path to hand the asset protocol: inside archives and over SFTP.
/// Capped, and honest about hitting the cap.
pub async fn read_file_bytes(dir: String, name: String, max_bytes: usize) -> Result<BinaryFile, String> {
    use base64::Engine;
    let cap = max_bytes.max(1);
    let (buf, truncated) = if sftp::is_sftp(&dir) {
        sftp::read_file(&dir, &name, cap).await?
    } else {
        tokio::task::spawn_blocking(move || {
            use std::io::Read;
            let dir = smb::localize(&dir);
            match Loc::parse(&dir) {
                Loc::Archive { archive, inner } => {
                    let member = archive::normalize_inner(&format!("{inner}/{name}"));
                    archive::read_member(&archive, &member, cap)
                }
                Loc::Local(d) => {
                    let file = fs::File::open(d.join(&name)).map_err(|e| friendly_io(&e))?;
                    let mut buf = Vec::new();
                    // +1 over the cap so "exactly cap" and "longer" are distinct.
                    file.take(cap as u64 + 1)
                        .read_to_end(&mut buf)
                        .map_err(|e| friendly_io(&e))?;
                    let truncated = buf.len() > cap;
                    Ok((buf, truncated))
                }
            }
        })
        .await
        .map_err(|e| e.to_string())??
    };
    if truncated {
        return Ok(BinaryFile { data: String::new(), truncated: true });
    }
    Ok(BinaryFile {
        data: base64::engine::general_purpose::STANDARD.encode(&buf),
        truncated: false,
    })
}

/// The OS-native form of a path, for the places that need a real filesystem
/// path rather than Delight's portable one — today just the asset protocol,
/// which serves the PDF preview. smb:// becomes a UNC path; everything else
/// passes through unchanged.
pub fn native_path(path: String) -> String {
    smb::localize(&path)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskSpace {
    total: u64,
    free: u64,
}

/// Total + free bytes on the volume that holds `path`. Used to show disk usage in
/// the path bar at a drive root and beside a drive-root favorite. None if the
/// path can't be queried.
pub async fn disk_space(path: String) -> Option<DiskSpace> {
    if sftp::is_sftp(&path) {
        return None; // no statvfs in base SFTP; the readout just hides
    }
    tokio::task::spawn_blocking(move || {
        let path = smb::localize(&path);
        // Meaningless inside an archive — the UI already handles None.
        if Loc::parse(&path).is_archive() {
            return None;
        }
        let p = Path::new(&path);
        Some(DiskSpace {
            total: fs2::total_space(p).ok()?,
            // "available" = free to *this* user (respects quotas); the right number
            // to show as "free". free_space() can be larger on quota'd volumes.
            free: fs2::available_space(p).ok()?,
        })
    })
    .await
    .ok()
    .flatten()
}

/// Recursively sum the sizes of every regular file under `dir` (Space on a folder
/// → its total size in the Size column). Symlinks are not followed, so cycles
/// can't trap the walk. Runs off the UI thread; can be slow for large trees.
pub async fn dir_size(path: String) -> u64 {
    // A recursive size walk over SFTP is a round trip per directory; not worth
    // it for a column value. Remote folders show no total in v1.
    if sftp::is_sftp(&path) {
        return 0;
    }
    let path = smb::localize(&path);
    tokio::task::spawn_blocking(move || match Loc::parse(&path) {
        // Free from the index — no walk, no decompression.
        Loc::Archive { archive, inner } => archive::index_for(&archive)
            .map(|ix| ix.size_under(&inner))
            .unwrap_or(0),
        Loc::Local(p) => walk_size(&p),
    })
    .await
    .unwrap_or(0)
}

fn walk_size(dir: &Path) -> u64 {
    let mut total = 0u64;
    let Ok(rd) = fs::read_dir(dir) else {
        return 0;
    };
    for de in rd.flatten() {
        // DirEntry::metadata does NOT follow symlinks, so a symlinked dir reports
        // as neither file nor dir here and is skipped — no cycles, no double count.
        let Ok(meta) = de.metadata() else { continue };
        if meta.is_dir() {
            total = total.saturating_add(walk_size(&de.path()));
        } else if meta.is_file() {
            total = total.saturating_add(meta.len());
        }
    }
    total
}

/// End-to-end SMB listing against a REAL server. Environment-dependent, so
/// it's #[ignore]d — run with `cargo test smb -- --ignored --nocapture`.
///
/// It exists because unit-testing the translation alone did NOT catch the real
/// bugs. On Windows, `dunce::canonicalize` only simplifies verbatim DISK paths,
/// so a share came back as `\\?\UNC\host\share` and leaked into the path bar.
/// On macOS the equivalent trap is the mount point: the share you asked for is
/// not necessarily the directory you got (`/Volumes/torrents-1`), and the
/// parent of a mount root is `/Volumes`, which must never reach the UI either.
/// Only a listing of a real share exercises any of that.
///
/// Point it somewhere with `DELIGHT_SMB_TEST`:
///
///   DELIGHT_SMB_TEST=smb://server/share   # straight to a share
///   DELIGHT_SMB_TEST=smb://server         # also exercises share enumeration
///
/// Windows defaults to `smb://localhost`, whose admin shares every stock
/// install has.
#[cfg(all(test, any(windows, target_os = "macos")))]
mod smb_e2e_tests {
    use super::smb_list;
    use crate::smb;

    fn target() -> Option<String> {
        match std::env::var("DELIGHT_SMB_TEST") {
            Ok(t) if !t.trim().is_empty() => Some(t.trim().to_string()),
            _ if cfg!(windows) => Some("smb://localhost".into()),
            _ => {
                eprintln!("DELIGHT_SMB_TEST not set — skipping the live-server test");
                None
            }
        }
    }

    /// The share to work in: either the one named in the target, or — when the
    /// target is a bare host — the first visible one the server admits to,
    /// which also proves enumeration works.
    fn share_root() -> Option<crate::fs_cmds::Listing> {
        let t = target()?;
        let url = smb::SmbUrl::parse(&t).expect("DELIGHT_SMB_TEST must be an smb:// URL");
        if !url.rest.is_empty() {
            return Some(smb_list(&t, None, None).expect("listing the configured share"));
        }
        let host = smb_list(&t, None, None).unwrap_or_else(|e| {
            panic!("host-level listing of {t} failed: {e}\n(a server that wants credentials \
                    reports {}, which the app answers with its sign-in dialog — point \
                    DELIGHT_SMB_TEST straight at a share instead)", smb::AUTH_NEEDED)
        });
        assert_eq!(host.path, url.host_canonical(), "host listing keeps its own path");
        assert!(host.parent.is_none(), "a server has no parent");
        assert!(
            host.entries.iter().all(|e| e.is_dir),
            "every share lists as a directory"
        );
        let share = host.entries.iter().find(|e| !e.hidden)?;
        // Entering it as a child (clicking the row) must land exactly where
        // typing the full path does.
        let by_child = smb_list(&t, Some(share.name.clone()), None).expect("child entry");
        let by_path = smb_list(&format!("{}/{}", host.path, share.name), None, None)
            .expect("full path");
        assert_eq!(by_child.path, by_path.path);
        assert_eq!(by_child.parent, by_path.parent);
        Some(by_path)
    }

    /// The invariant the UI depends on: no listing, at any depth, ever hands
    /// back a native path.
    fn assert_portable(l: &crate::fs_cmds::Listing) {
        for p in [Some(&l.path), l.parent.as_ref()].into_iter().flatten() {
            assert!(p.starts_with("smb://"), "not a portable path: {p}");
            assert!(!p.contains('\\'), "UNC/backslashes leaked: {p}");
            assert!(!p.contains("/Volumes/"), "a mount point leaked: {p}");
        }
    }

    #[test]
    #[ignore]
    fn share_listings_stay_in_smb_form() {
        let Some(root) = share_root() else { return };
        eprintln!("share root = {} ({} entries)", root.path, root.entries.len());
        assert_portable(&root);
        let url = smb::SmbUrl::parse(&root.path).unwrap();
        // The share root's parent is the server's share list — std::path can't
        // get there on either platform (Windows stops at the UNC prefix, macOS
        // walks out to /Volumes), so this is entirely our doing.
        assert_eq!(root.parent.as_deref(), Some(url.host_canonical().as_str()));
        assert_eq!(root.name, url.rest, "the share names the listing");

        // One level deeper — the shape that leaked \\?\UNC\… on Windows, and
        // where a mount point would leak on macOS.
        let Some(sub) = root.entries.iter().find(|e| e.is_dir && !e.hidden) else {
            eprintln!("no subfolder in {} — skipping the deep check", root.path);
            return;
        };
        let deep = smb_list(&root.path, Some(sub.name.clone()), None).expect("subfolder listing");
        eprintln!("subfolder = {}", deep.path);
        assert_portable(&deep);
        assert_eq!(deep.path, format!("{}/{}", root.path, sub.name));
        assert_eq!(deep.parent.as_deref(), Some(root.path.as_str()));
        assert_eq!(deep.name, sub.name);

        // And back up the way the UI goes up, all the way to the server.
        let up = smb_list(deep.parent.as_deref().unwrap(), None, None).expect("up one");
        assert_eq!(up.path, root.path);
        match smb_list(up.parent.as_deref().unwrap(), None, None) {
            Ok(server) => assert_eq!(server.path, url.host_canonical()),
            // A server that wants credentials to enumerate is a sign-in prompt,
            // not a broken parent link.
            Err(e) => assert!(
                smb::is_auth_error(&e),
                "the share root's parent should list the server, or ask to sign in; got: {e}"
            ),
        }
    }

    /// macOS only: the mount is the whole ballgame. Listing a share must mount
    /// it, the mount point must be the one the KERNEL reports (not a guess at
    /// /Volumes/<share>), and translation must be an exact round trip over it.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore]
    fn listing_a_share_mounts_it_where_the_kernel_says() {
        let Some(root) = share_root() else { return };
        let url = smb::SmbUrl::parse(&root.path).unwrap();

        // Listing it mounted it: the translated path is now a real directory.
        let native = smb::localize(&root.path);
        eprintln!("{} → {}", root.path, native);
        assert!(native.starts_with('/'), "a mount point is absolute: {native}");
        assert_ne!(native, root.path, "an unmounted share translates to itself");
        assert!(std::path::Path::new(&native).is_dir(), "{native} should exist");

        // It is the kernel's answer, not /Volumes/<share> assumed.
        let from_mount_table = std::process::Command::new("/sbin/mount")
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
            .unwrap_or_default();
        assert!(
            from_mount_table
                .lines()
                .any(|l| l.contains(&format!(" on {native} ")) && l.contains("smbfs")),
            "{native} should appear in the mount table as smbfs:\n{from_mount_table}"
        );

        // Round trip, including the two ends that bite: the mount root itself,
        // and /Volumes (the native parent, which must NOT map back into the tree).
        assert_eq!(smb::delocalize(&native, &url), root.path);
        assert_eq!(smb::delocalize("/Volumes", &url), "/Volumes");
        let child = format!("{native}/some-file.txt");
        assert_eq!(
            smb::delocalize(&child, &url),
            format!("{}/some-file.txt", root.path)
        );
        assert_eq!(smb::localize(&format!("{}/some-file.txt", root.path)), child);

        // A sibling mount point that merely starts with the same characters —
        // /Volumes/data-1 vs /Volumes/data — must not be swallowed.
        assert_eq!(
            smb::delocalize(&format!("{native}-1/x"), &url),
            format!("{native}-1/x"),
            "a longer sibling mount point is not inside this one"
        );
    }

    /// A server that wants credentials must ask, not fail. This is the whole
    /// reason the sentinel exists: the frontend turns it into the sign-in
    /// dialog and retries, and anything else would be a dead end.
    #[test]
    #[ignore]
    fn an_unauthenticated_server_asks_for_credentials() {
        let Some(t) = target() else { return };
        let url = smb::SmbUrl::parse(&t).unwrap();
        match smb_list(&url.host_canonical(), None, None) {
            Ok(l) => eprintln!(
                "{} enumerates without credentials ({} shares) — nothing to assert",
                url.host, l.entries.len()
            ),
            Err(e) => {
                eprintln!("{} → {e}", url.host_canonical());
                assert!(
                    smb::is_auth_error(&e),
                    "a server that won't enumerate should ask for credentials, not fail with: {e}"
                );
            }
        }
    }
}

#[cfg(all(test, windows))]
mod hidden_tests {
    use super::is_hidden;

    // ProgramData carries the HIDDEN+SYSTEM attributes on every stock Windows;
    // the Windows dir does not. Confirms is_hidden reads the attribute, not a name.
    #[test]
    fn honors_windows_hidden_attribute() {
        let hidden = std::fs::symlink_metadata(r"C:\ProgramData").unwrap();
        assert!(is_hidden("ProgramData", &hidden), "ProgramData should read hidden");
        let visible = std::fs::symlink_metadata(r"C:\Windows").unwrap();
        assert!(!is_hidden("Windows", &visible), "Windows should not read hidden");
    }
}
