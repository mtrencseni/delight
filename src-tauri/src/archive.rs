//! Read-only archive browsing: an archive is entered like a folder and listed
//! from an in-memory index. Nothing is ever written into an archive, and nothing
//! is ever extracted to a temp file — the only way bytes leave an archive is an
//! explicit copy-out (F5), which streams straight to the destination.
//!
//! Paths carry the archive boundary inline: `C:\x\foo.zip!sub/file.txt`. The
//! marker is stored, never displayed (the UI shows `C:\x\foo.zip\sub\file.txt`);
//! inner paths always use `/`, whatever the host separator is. Archives don't
//! nest, so there is at most one marker in a path.
//!
//! Pure Rust throughout: the `zip` crate with only the `deflate` feature, which
//! decodes via flate2/miniz_oxide. No C toolchain, no system libraries.

use crate::fs_cmds::{Entry, Listing};
use std::collections::HashMap;
use std::fs::File;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::UNIX_EPOCH;

/// The boundary marker between an archive's path and a path inside it.
pub const MARK: char = '!';

/// Extensions browsable as a zip container. Deliberately broad: `.docx`, `.apk`,
/// `.jar` and friends are all zip, so they come for free. Keep in sync with
/// ARCHIVE_EXTS in the frontend (src/archive.ts).
const ZIP_EXTS: &[&str] = &[
    "zip", "jar", "war", "ear", "apk", "ipa", "xpi", "crx", "vsix", "whl", "nupkg", "epub", "docx",
    "xlsx", "pptx", "odt", "ods", "odp",
];

/// A single-stream compressor. `Plain` means the container isn't compressed.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Codec {
    Plain,
    Gzip,
    Bzip2,
    Xz,
    Zstd,
}

/// What kind of container an archive is. `Single` is a bare compressor such as
/// `notes.txt.gz` — not a container at all, so it's shown as one member.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Format {
    Zip,
    SevenZ,
    Tar(Codec),
    Single(Codec),
}

/// Matched longest-first, so `.tar.gz` is a compressed tar rather than a bare gzip.
const SUFFIXES: &[(&str, Format)] = &[
    (".7z", Format::SevenZ),
    (".tar.gz", Format::Tar(Codec::Gzip)),
    (".tar.bz2", Format::Tar(Codec::Bzip2)),
    (".tar.xz", Format::Tar(Codec::Xz)),
    (".tar.zst", Format::Tar(Codec::Zstd)),
    (".tgz", Format::Tar(Codec::Gzip)),
    (".tbz", Format::Tar(Codec::Bzip2)),
    (".tbz2", Format::Tar(Codec::Bzip2)),
    (".txz", Format::Tar(Codec::Xz)),
    (".tzst", Format::Tar(Codec::Zstd)),
    (".tar", Format::Tar(Codec::Plain)),
    (".gz", Format::Single(Codec::Gzip)),
    (".bz2", Format::Single(Codec::Bzip2)),
    (".xz", Format::Single(Codec::Xz)),
    (".zst", Format::Single(Codec::Zstd)),
];

fn format_of(name: &str) -> Option<Format> {
    let n = name.to_ascii_lowercase();
    if let Some((_, ext)) = n.rsplit_once('.') {
        if ZIP_EXTS.contains(&ext) {
            return Some(Format::Zip);
        }
    }
    SUFFIXES.iter().find(|(s, _)| n.ends_with(s)).map(|(_, f)| *f)
}

/// True if `name` ends in an extension we can browse as an archive.
pub fn is_archive_name(name: &str) -> bool {
    format_of(name).is_some()
}

fn format_for(archive: &Path) -> Result<Format, String> {
    let name = archive.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    format_of(&name).ok_or_else(|| "Not a supported archive".to_string())
}

/// The recognized formats, handed to the frontend at startup so the two sides
/// can't drift — this list is the single source of truth for what's enterable.
/// (The frontend ships the same defaults so the browser mock still works.)
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Formats {
    zip_exts: Vec<String>,
    suffixes: Vec<String>,
}

#[tauri::command]
pub fn archive_formats() -> Formats {
    Formats {
        zip_exts: ZIP_EXTS.iter().map(|s| s.to_string()).collect(),
        suffixes: SUFFIXES.iter().map(|(s, _)| s.to_string()).collect(),
    }
}

/// Normalize an inner (in-archive) path: `/`-separated, no leading or trailing
/// slash, no empty or `.` components, and `..` popped. Traversal can't escape the
/// archive root, so a hostile member name is neutralized here rather than at use.
pub fn normalize_inner(s: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for part in s.split(['/', '\\']) {
        match part {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            p => out.push(p),
        }
    }
    out.join("/")
}

/// A filesystem location: either an ordinary path, or a path inside an archive.
#[derive(Debug, Clone, PartialEq)]
pub enum Loc {
    Local(PathBuf),
    Archive { archive: PathBuf, inner: String },
}

impl Loc {
    /// Split a UI path at its archive boundary. A bare `!` is not enough — the
    /// text before it must also look like an archive — so ordinary paths that
    /// happen to contain `!` (`C:\my!stuff`) stay local.
    pub fn parse(s: &str) -> Loc {
        for (i, c) in s.char_indices() {
            if c == MARK && is_archive_name(&s[..i]) {
                return Loc::Archive {
                    archive: PathBuf::from(&s[..i]),
                    inner: normalize_inner(&s[i + MARK.len_utf8()..]),
                };
            }
        }
        Loc::Local(PathBuf::from(s))
    }

    /// The canonical string form handed back to the UI.
    pub fn to_path_string(&self) -> String {
        match self {
            Loc::Local(p) => p.to_string_lossy().into_owned(),
            Loc::Archive { archive, inner } => {
                format!("{}{}{}", archive.to_string_lossy(), MARK, inner)
            }
        }
    }

    pub fn is_archive(&self) -> bool {
        matches!(self, Loc::Archive { .. })
    }
}

/// One member of an archive (real, or a directory synthesized from member paths).
#[derive(Clone)]
pub struct Member {
    /// Full inner path, `/`-separated, normalized.
    pub path: String,
    pub name: String,
    /// Inner path of the containing directory ("" at the archive root).
    pub parent: String,
    pub is_dir: bool,
    /// Uncompressed size (0 for directories).
    pub size: u64,
    pub modified_ms: Option<i64>,
    /// A tar symlink/hardlink entry: it carries no data, only a target.
    pub is_link: bool,
    /// Where a link points (archive-relative for hardlinks, arbitrary for symlinks).
    pub link_target: Option<String>,
    /// Unix mode bits, when the format records them — restored on copy-out.
    pub mode: Option<u32>,
    /// True when reading this member needs a password.
    pub encrypted: bool,
}

pub struct Index {
    pub members: Vec<Member>,
}

impl Index {
    /// Direct children of the given inner directory.
    pub fn children(&self, dir: &str) -> Vec<&Member> {
        self.members.iter().filter(|m| m.parent == dir).collect()
    }

    /// True if `dir` is the root or names a directory we know about.
    pub fn has_dir(&self, dir: &str) -> bool {
        dir.is_empty() || self.members.iter().any(|m| m.is_dir && m.path == dir)
    }

    /// Every file at or under `inner` (which may itself name a single file).
    pub fn files_under(&self, inner: &str) -> Vec<&Member> {
        let prefix = format!("{inner}/");
        self.members
            .iter()
            .filter(|m| !m.is_dir && (m.path == inner || inner.is_empty() || m.path.starts_with(&prefix)))
            .collect()
    }

    /// Total uncompressed bytes at or under `inner`.
    pub fn size_under(&self, inner: &str) -> u64 {
        self.files_under(inner).iter().map(|m| m.size).sum()
    }

    /// Directories at or under `inner` — copy-out recreates these explicitly so
    /// an empty folder inside the archive still appears at the destination.
    pub fn dirs_under(&self, inner: &str) -> Vec<&Member> {
        let prefix = format!("{inner}/");
        self.members
            .iter()
            .filter(|m| m.is_dir && (m.path == inner || inner.is_empty() || m.path.starts_with(&prefix)))
            .collect()
    }
}

// ---- passwords ---------------------------------------------------------------

/// Sentinel error meaning "this archive is encrypted and I don't have a working
/// password". The frontend recognizes it, prompts, and retries.
pub const NEEDS_PASSWORD: &str = "__password_required";

/// Passwords the user has supplied this session, per archive. Memory only —
/// never persisted, and gone when the app exits.
fn passwords() -> &'static Mutex<HashMap<PathBuf, String>> {
    static P: OnceLock<Mutex<HashMap<PathBuf, String>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(HashMap::new()))
}

fn password_for(archive: &Path) -> Option<String> {
    passwords().lock().ok()?.get(archive).cloned()
}

fn forget_password(archive: &Path) {
    if let Ok(mut p) = passwords().lock() {
        p.remove(archive);
    }
}

/// Does `password` actually decrypt this archive? Checked before storing, so a
/// wrong guess is never cached — otherwise every later read would fail as "wrong
/// password" and the user would never be asked again.
fn password_works(archive: &Path, password: &str) -> bool {
    let mut probe = [0u8; 64];
    match format_for(archive) {
        Ok(Format::Zip) => {
            let Ok(file) = File::open(archive) else { return false };
            let Ok(mut za) = zip::ZipArchive::new(file) else { return false };
            // The first encrypted member is enough to tell.
            let mut idx = None;
            for i in 0..za.len() {
                if let Ok(f) = za.by_index_raw(i) {
                    if !f.is_dir() && f.encrypted() {
                        idx = Some(i);
                        break;
                    }
                }
            }
            let Some(i) = idx else { return true }; // nothing encrypted to check
            // Bound to a local so the borrow of `za` ends with this statement.
            let ok = match za.by_index_decrypt(i, password.as_bytes()) {
                // AES carries a password verifier, so a bad guess fails here; for
                // legacy ZipCrypto it's the read that catches it.
                Ok(mut f) => f.read(&mut probe).is_ok(),
                Err(_) => false,
            };
            ok
        }
        Ok(Format::SevenZ) => {
            let Ok(mut file) = File::open(archive) else { return false };
            let Ok(len) = file.metadata().map(|m| m.len()) else { return false };
            let pw = sevenz_rust::Password::from(password);
            if sevenz_rust::Archive::read(&mut file, len, pw.as_slice()).is_err() {
                return false;
            }
            // Headers can be readable while the data is still encrypted, so
            // actually decode the first file.
            match sevenz_rust::SevenZReader::open(archive, sevenz_rust::Password::from(password)) {
                Ok(mut r) => {
                    let mut ok = true;
                    let _ = r.for_each_entries(|e, reader| {
                        if e.is_directory() {
                            return Ok(true);
                        }
                        ok = reader.read(&mut probe).is_ok();
                        Ok(false) // one entry is enough
                    });
                    ok
                }
                Err(_) => false,
            }
        }
        _ => true, // formats we don't decrypt
    }
}

/// Remember a password for `path`, but only after checking it works. Errors when
/// it doesn't, so the UI asks again instead of caching a dud.
#[tauri::command]
pub fn set_archive_password(path: String, password: String) -> Result<(), String> {
    let archive = match Loc::parse(&path) {
        Loc::Archive { archive, .. } => archive,
        Loc::Local(p) => p,
    };
    if !password_works(&archive, &password) {
        return Err("Wrong password".into());
    }
    if let Ok(mut p) = passwords().lock() {
        p.insert(archive.clone(), password);
    }
    // The cached index may be the failed/partial one; force a rebuild.
    if let Ok(mut c) = cache().lock() {
        c.retain(|(k, _)| k.0 != archive);
    }
    Ok(())
}

// ---- index cache -------------------------------------------------------------
//
// Metadata only — never file bytes — so this is small and dies with the process.
// Keyed by the archive's identity (path + mtime + size): touch the archive on
// disk and the next lookup rebuilds. Small enough that a linear LRU is plenty.

const CACHE_MAX: usize = 8;

type CacheKey = (PathBuf, u64, u64); // path, mtime ms, size

fn cache() -> &'static Mutex<Vec<(CacheKey, Arc<Index>)>> {
    static C: OnceLock<Mutex<Vec<(CacheKey, Arc<Index>)>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(Vec::new()))
}

/// Identity of the archive file, used both as the cache key and as the value
/// `dir_signature` reports for anything inside it.
pub fn stamp(archive: &Path) -> Result<(u64, u64), String> {
    let meta = std::fs::metadata(archive).map_err(|_| "Archive is unreadable".to_string())?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok((mtime, meta.len()))
}

/// The index for `archive`, built on first use and reused until the file changes.
pub fn index_for(archive: &Path) -> Result<Arc<Index>, String> {
    let (mtime, size) = stamp(archive)?;
    let key: CacheKey = (archive.to_path_buf(), mtime, size);

    if let Ok(mut c) = cache().lock() {
        if let Some(pos) = c.iter().position(|(k, _)| *k == key) {
            let hit = c.remove(pos);
            let index = hit.1.clone();
            c.insert(0, hit);
            return Ok(index);
        }
    }

    let index = Arc::new(build_index(archive)?);
    if let Ok(mut c) = cache().lock() {
        c.retain(|(k, _)| k.0 != key.0); // drop any stale generation of this file
        c.insert(0, (key, index.clone()));
        c.truncate(CACHE_MAX);
    }
    Ok(index)
}

// ---- decoders ----------------------------------------------------------------

/// A decompressed byte stream for the whole archive. Every decoder here streams,
/// so even a multi-gigabyte `.tar.gz` is never held in memory.
fn decoded(path: &Path, codec: Codec) -> Result<Box<dyn Read>, String> {
    if codec == Codec::Xz {
        return Ok(Box::new(xz_stream(path)));
    }
    let file = File::open(path).map_err(|_| "Can’t open archive".to_string())?;
    Ok(match codec {
        Codec::Plain => Box::new(file),
        Codec::Gzip => Box::new(flate2::read::GzDecoder::new(file)),
        Codec::Bzip2 => Box::new(bzip2_rs::DecoderReader::new(file)),
        Codec::Zstd => Box::new(
            ruzstd::StreamingDecoder::new(file).map_err(|e| format!("Bad zstd stream: {e}"))?,
        ),
        Codec::Xz => unreachable!("handled above"),
    })
}

// lzma-rs only exposes a Write-side API, so xz decompression runs on a worker
// thread and its output is piped back through a *bounded* channel. Bounded gives
// backpressure (memory stays flat), and dropping the reader breaks the pipe, which
// ends the worker — so an abandoned listing doesn't leak a thread.

struct ChanReader {
    rx: std::sync::mpsc::Receiver<io::Result<Vec<u8>>>,
    cur: Vec<u8>,
    pos: usize,
}

impl Read for ChanReader {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        while self.pos >= self.cur.len() {
            match self.rx.recv() {
                Ok(Ok(chunk)) => {
                    self.cur = chunk;
                    self.pos = 0;
                }
                Ok(Err(e)) => return Err(e),
                Err(_) => return Ok(0), // worker finished: clean EOF
            }
        }
        let n = (self.cur.len() - self.pos).min(out.len());
        out[..n].copy_from_slice(&self.cur[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

struct ChanWriter(std::sync::mpsc::SyncSender<io::Result<Vec<u8>>>);

impl io::Write for ChanWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0
            .send(Ok(buf.to_vec()))
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "reader dropped"))?;
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn xz_stream(path: &Path) -> ChanReader {
    let (tx, rx) = std::sync::mpsc::sync_channel::<io::Result<Vec<u8>>>(8);
    let p = path.to_path_buf();
    std::thread::spawn(move || {
        let err_tx = tx.clone();
        let result = (move || -> io::Result<()> {
            let f = File::open(&p)?;
            let mut input = io::BufReader::new(f);
            let mut out = ChanWriter(tx);
            lzma_rs::xz_decompress(&mut input, &mut out)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))
        })();
        if let Err(e) = result {
            let _ = err_tx.send(Err(e));
        }
    });
    ChanReader { rx, cur: Vec::new(), pos: 0 }
}

/// Read at most `cap` bytes, plus one extra so the caller can tell "exactly cap"
/// from "there's more".
fn take_capped(r: &mut dyn Read, cap: usize) -> Result<(Vec<u8>, bool), String> {
    let mut buf = Vec::new();
    r.take(cap as u64 + 1).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    let truncated = buf.len() > cap;
    if truncated {
        buf.truncate(cap);
    }
    Ok((buf, truncated))
}

// ---- index construction ------------------------------------------------------

fn member_of(path: String, is_dir: bool, size: u64, modified_ms: Option<i64>) -> Member {
    Member {
        name: path.rsplit('/').next().unwrap_or(&path).to_string(),
        parent: path.rsplit_once('/').map(|(p, _)| p.to_string()).unwrap_or_default(),
        is_dir,
        size: if is_dir { 0 } else { size },
        modified_ms,
        is_link: false,
        link_target: None,
        mode: None,
        encrypted: false,
        path,
    }
}

/// Not every archive stores explicit directory entries (tar frequently doesn't),
/// so synthesize the ones implied by member paths — otherwise the tree has holes.
fn finish_index(mut by_path: HashMap<String, Member>) -> Index {
    let known: Vec<String> = by_path.keys().cloned().collect();
    for p in known {
        let mut cur = p.as_str();
        while let Some((parent, _)) = cur.rsplit_once('/') {
            if parent.is_empty() || by_path.contains_key(parent) {
                break;
            }
            by_path.insert(parent.to_string(), member_of(parent.to_string(), true, 0, None));
            cur = parent;
        }
    }
    Index { members: by_path.into_values().collect() }
}

fn build_index(archive: &Path) -> Result<Index, String> {
    match format_for(archive)? {
        Format::Zip => build_zip(archive),
        Format::SevenZ => build_7z(archive),
        Format::Tar(c) => build_tar(archive, c),
        Format::Single(c) => build_single(archive, c),
    }
}

// ---- 7z ----------------------------------------------------------------------

/// 7z stores its file table separately from the data, so listing only reads the
/// header — no decompression. When the header itself is encrypted, even that
/// needs the password, which is why this can return NEEDS_PASSWORD.
fn sevenz_password(archive: &Path) -> sevenz_rust::Password {
    sevenz_rust::Password::from(password_for(archive).unwrap_or_default().as_str())
}

fn friendly_7z(e: &sevenz_rust::Error, archive: &Path) -> String {
    let msg = e.to_string();
    let looks_encrypted = matches!(e, sevenz_rust::Error::PasswordRequired)
        || msg.to_lowercase().contains("password")
        || (msg.to_lowercase().contains("checksum") && password_for(archive).is_none());
    if looks_encrypted {
        return NEEDS_PASSWORD.into();
    }
    // A wrong password usually surfaces as a corrupt-data error.
    if password_for(archive).is_some() && msg.to_lowercase().contains("maybe wrong password") {
        return "Wrong password".into();
    }
    format!("Can’t read 7z archive: {msg}")
}

fn build_7z(archive: &Path) -> Result<Index, String> {
    let mut file = File::open(archive).map_err(|_| "Can’t open archive".to_string())?;
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    let pw = sevenz_password(archive);
    let arch = sevenz_rust::Archive::read(&mut file, len, pw.as_slice())
        .map_err(|e| friendly_7z(&e, archive))?;

    let mut by_path: HashMap<String, Member> = HashMap::new();
    for f in &arch.files {
        let path = normalize_inner(&f.name);
        if path.is_empty() {
            continue;
        }
        let mut m = member_of(path, f.is_directory, f.size, sevenz_time_ms(f));
        m.encrypted = !f.has_stream && !f.is_directory;
        by_path.insert(m.path.clone(), m);
    }
    Ok(finish_index(by_path))
}

/// 7z timestamps are Windows FILETIME (100 ns ticks since 1601).
fn sevenz_time_ms(f: &sevenz_rust::SevenZArchiveEntry) -> Option<i64> {
    if !f.has_last_modified_date {
        return None;
    }
    const TICKS_PER_MS: i64 = 10_000;
    const EPOCH_DIFF_MS: i64 = 11_644_473_600_000; // 1601-01-01 -> 1970-01-01
    let ticks: u64 = f.last_modified_date.into();
    Some(ticks as i64 / TICKS_PER_MS - EPOCH_DIFF_MS)
}

/// Walk a 7z once, handing every wanted member to `sink`.
fn sevenz_walk(
    archive: &Path,
    mut want: impl FnMut(&str) -> bool,
    mut sink: impl FnMut(&str, &mut dyn Read) -> Result<(), String>,
) -> Result<(), String> {
    let mut r = sevenz_rust::SevenZReader::open(archive, sevenz_password(archive))
        .map_err(|e| friendly_7z(&e, archive))?;
    // The sink's error has to survive the crate's own error type, so it rides
    // out in a captured slot rather than through for_each_entries.
    let mut failed: Option<String> = None;
    let res = r.for_each_entries(|entry, reader| {
        if entry.is_directory() {
            return Ok(true);
        }
        let path = normalize_inner(entry.name());
        if !want(&path) {
            return Ok(true);
        }
        match sink(&path, reader) {
            Ok(()) => Ok(true),
            Err(e) => {
                failed = Some(e);
                Ok(false) // stop the walk
            }
        }
    });
    if let Some(e) = failed {
        return Err(e);
    }
    res.map(|_| ()).map_err(|e| friendly_7z(&e, archive))
}

// ---- tar ---------------------------------------------------------------------

fn build_tar(archive: &Path, codec: Codec) -> Result<Index, String> {
    let mut ar = tar::Archive::new(decoded(archive, codec)?);
    let mut by_path: HashMap<String, Member> = HashMap::new();
    for entry in ar.entries().map_err(|e| format!("Not a readable tar: {e}"))? {
        let Ok(entry) = entry else { break }; // truncated stream: keep what we have
        let Ok(p) = entry.path() else { continue };
        let path = normalize_inner(&p.to_string_lossy());
        if path.is_empty() {
            continue;
        }
        let h = entry.header();
        let is_dir = h.entry_type().is_dir() || p.to_string_lossy().ends_with('/');
        let modified_ms = h.mtime().ok().map(|s| s as i64 * 1000);
        let mut m = member_of(path, is_dir, h.size().unwrap_or(0), modified_ms);
        m.mode = h.mode().ok();
        // Symlinks and hardlinks carry no data — only a target — so they need
        // recreating rather than copying, or they'd land as empty files.
        let et = h.entry_type();
        if et.is_symlink() || et.is_hard_link() {
            m.is_link = true;
            m.link_target = entry
                .link_name()
                .ok()
                .flatten()
                .map(|l| l.to_string_lossy().into_owned());
        }
        by_path.insert(m.path.clone(), m);
    }
    Ok(finish_index(by_path))
}

/// Walk a tar once, handing every wanted member to `sink` in stream order.
fn tar_walk(
    archive: &Path,
    codec: Codec,
    mut want: impl FnMut(&str) -> bool,
    mut sink: impl FnMut(&str, &mut dyn Read) -> Result<(), String>,
) -> Result<(), String> {
    let mut ar = tar::Archive::new(decoded(archive, codec)?);
    for entry in ar.entries().map_err(|e| format!("Not a readable tar: {e}"))? {
        let Ok(mut entry) = entry else { break };
        if entry.header().entry_type().is_dir() {
            continue;
        }
        let Ok(p) = entry.path() else { continue };
        let path = normalize_inner(&p.to_string_lossy());
        if !want(&path) {
            continue;
        }
        sink(&path, &mut entry)?;
    }
    Ok(())
}

// ---- bare compressors --------------------------------------------------------

/// `notes.txt.gz` presents a single member named `notes.txt`.
fn single_member_name(archive: &Path) -> String {
    let name = archive.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    match name.rsplit_once('.') {
        Some((stem, _)) if !stem.is_empty() => stem.to_string(),
        _ => name,
    }
}

/// Uncompressed size of a bare compressor's single stream. gzip records it in the
/// trailer (mod 2^32, so a >4 GiB member reports low); the others have no length
/// field, so the stream is measured once and the answer cached with the index.
fn single_size(archive: &Path, codec: Codec) -> Result<u64, String> {
    if codec == Codec::Gzip {
        if let Some(n) = gzip_isize(archive) {
            return Ok(n);
        }
    }
    let mut r = decoded(archive, codec)?;
    let mut buf = vec![0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let n = r.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            return Ok(total);
        }
        total += n as u64;
    }
}

fn gzip_isize(archive: &Path) -> Option<u64> {
    use std::io::{Seek, SeekFrom};
    let mut f = File::open(archive).ok()?;
    if f.metadata().ok()?.len() < 18 {
        return None; // smaller than a header + trailer: not worth trusting
    }
    f.seek(SeekFrom::End(-4)).ok()?;
    let mut b = [0u8; 4];
    f.read_exact(&mut b).ok()?;
    Some(u32::from_le_bytes(b) as u64)
}

fn build_single(archive: &Path, codec: Codec) -> Result<Index, String> {
    let modified_ms = std::fs::metadata(archive)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64);
    let member = member_of(single_member_name(archive), false, single_size(archive, codec)?, modified_ms);
    Ok(Index { members: vec![member] })
}

// ---- zip ---------------------------------------------------------------------

/// Days since the Unix epoch for a civil date (Howard Hinnant's algorithm) —
/// avoids pulling in a date crate just to render zip timestamps.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// Zip stores wall-clock local time with no zone, so this reads it as UTC — the
/// displayed time can be off by the archive author's offset. Nothing depends on
/// it beyond the Modified column.
fn zip_time_ms(dt: Option<zip::DateTime>) -> Option<i64> {
    let dt = dt?;
    let days = days_from_civil(dt.year() as i64, dt.month() as i64, dt.day() as i64);
    let secs = days * 86400 + dt.hour() as i64 * 3600 + dt.minute() as i64 * 60 + dt.second() as i64;
    Some(secs * 1000)
}

fn build_zip(archive: &Path) -> Result<Index, String> {
    let file = File::open(archive).map_err(|_| "Can’t open archive".to_string())?;
    let mut za = zip::ZipArchive::new(file).map_err(|e| friendly_zip(&e))?;

    let mut by_path: HashMap<String, Member> = HashMap::new();
    for i in 0..za.len() {
        // Raw: metadata comes from the central directory, so encrypted members
        // still list (only their *contents* need the password).
        let Ok(f) = za.by_index_raw(i) else { continue };
        // mangled_name/normalize_inner both neutralize traversal; we keep the
        // normalized form as the member's identity everywhere downstream.
        let path = normalize_inner(f.name());
        if path.is_empty() {
            continue;
        }
        let mut member = member_of(path, f.is_dir(), f.size(), zip_time_ms(f.last_modified()));
        member.mode = f.unix_mode();
        member.encrypted = f.encrypted();
        by_path.insert(member.path.clone(), member);
    }
    Ok(finish_index(by_path))
}

fn friendly_zip(e: &zip::result::ZipError) -> String {
    use zip::result::ZipError;
    match e {
        ZipError::FileNotFound => "Not found in the archive".into(),
        ZipError::InvalidArchive(_) => "Not a readable archive".into(),
        ZipError::UnsupportedArchive(ZipError::PASSWORD_REQUIRED) => NEEDS_PASSWORD.into(),
        ZipError::UnsupportedArchive(m) => format!("Unsupported archive: {m}"),
        ZipError::InvalidPassword => "Wrong password".into(),
        _ => e.to_string(),
    }
}

/// Same as `friendly_zip`, but maps "this entry is encrypted" to the sentinel so
/// the UI knows to ask for a password rather than just reporting a failure.
fn zip_read_err(e: &zip::result::ZipError) -> String {
    friendly_zip(e)
}

/// A read that used a stored password failed. Passwords are verified before
/// being stored, so this means the archive changed underneath us — drop it and
/// ask again rather than failing forever with a password we can't clear.
fn zip_decrypt_err(archive: &Path, e: &zip::result::ZipError) -> String {
    if matches!(e, zip::result::ZipError::InvalidPassword) {
        forget_password(archive);
        return NEEDS_PASSWORD.into();
    }
    friendly_zip(e)
}

// ---- listing -----------------------------------------------------------------

fn entry_for(m: &Member) -> Entry {
    let as_path = Path::new(&m.name);
    let (stem, ext) = if m.is_dir {
        (m.name.clone(), None)
    } else {
        (
            as_path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| m.name.clone()),
            as_path.extension().map(|e| e.to_string_lossy().into_owned()),
        )
    };
    Entry {
        name: m.name.clone(),
        stem,
        ext,
        is_dir: m.is_dir,
        is_symlink: false,
        size: m.size,
        modified_ms: m.modified_ms,
        // Archives carry no creation time or permission bits we can map, and
        // "hidden" is only the dotfile convention.
        created_ms: None,
        permissions: None,
        hidden: m.name.starts_with('.'),
    }
}

/// List a directory inside an archive. `inner` is "" at the archive root.
pub fn list(archive: &Path, inner: &str) -> Result<Listing, String> {
    let index = index_for(archive)?;
    if !index.has_dir(inner) {
        return Err("No such folder in the archive".into());
    }
    let entries: Vec<Entry> = index.children(inner).into_iter().map(entry_for).collect();

    // Leaving the archive root goes back to the folder holding the archive, so
    // ".." walks out of an archive exactly like it walks up a directory.
    let parent = if inner.is_empty() {
        archive.parent().map(|p| p.to_string_lossy().into_owned())
    } else {
        let up = inner.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
        Some(
            Loc::Archive {
                archive: archive.to_path_buf(),
                inner: up.to_string(),
            }
            .to_path_string(),
        )
    };
    let name = if inner.is_empty() {
        archive.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
    } else {
        inner.rsplit('/').next().unwrap_or(inner).to_string()
    };

    Ok(Listing {
        path: Loc::Archive {
            archive: archive.to_path_buf(),
            inner: inner.to_string(),
        }
        .to_path_string(),
        name,
        parent,
        entries,
        read_only: true,
    })
}

/// Read one member into memory, capped at `max_bytes` (+1 so the caller can tell
/// "exactly max" from "there's more"). Used by the read-only code preview.
pub fn read_member(archive: &Path, inner: &str, max_bytes: usize) -> Result<(Vec<u8>, bool), String> {
    let cap = max_bytes.max(1);
    match format_for(archive)? {
        Format::Zip => {
            let file = File::open(archive).map_err(|_| "Can’t open archive".to_string())?;
            let mut za = zip::ZipArchive::new(file).map_err(|e| friendly_zip(&e))?;
            match password_for(archive) {
                Some(pw) => {
                    let mut f = za
                        .by_name_decrypt(inner, pw.as_bytes())
                        .map_err(|e| zip_decrypt_err(archive, &e))?;
                    take_capped(&mut f, cap)
                }
                None => {
                    let mut f = za.by_name(inner).map_err(|e| zip_read_err(&e))?;
                    take_capped(&mut f, cap)
                }
            }
        }
        Format::SevenZ => {
            let found = std::cell::RefCell::new(None);
            sevenz_walk(
                archive,
                |p| found.borrow().is_none() && p == inner,
                |_, r| {
                    *found.borrow_mut() = Some(take_capped(r, cap)?);
                    Ok(())
                },
            )?;
            found.into_inner().ok_or_else(|| "Not found in the archive".to_string())
        }
        // Streaming formats can't seek to a member, so the stream is walked until
        // the wanted one shows up, then abandoned.
        Format::Tar(c) => {
            // Shared between both closures, so it can't be a plain local.
            let found = std::cell::RefCell::new(None);
            tar_walk(
                archive,
                c,
                |p| found.borrow().is_none() && p == inner,
                |_, r| {
                    *found.borrow_mut() = Some(take_capped(r, cap)?);
                    Ok(())
                },
            )?;
            found.into_inner().ok_or_else(|| "Not found in the archive".to_string())
        }
        Format::Single(c) => {
            if inner != single_member_name(archive) {
                return Err("Not found in the archive".into());
            }
            take_capped(&mut *decoded(archive, c)?, cap)
        }
    }
}

/// Stream the named members out of the archive in a **single pass**, handing each
/// one to `sink` as `(inner path, reader)`. One pass matters for the streaming
/// formats coming in M2 (a `.tar.gz` can't seek), and costs nothing for zip.
///
/// `sink` returning Err aborts the walk — that's how cancellation surfaces.
pub fn extract_members(
    archive: &Path,
    wanted: &[String],
    mut sink: impl FnMut(&str, &mut dyn Read) -> Result<(), String>,
) -> Result<(), String> {
    match format_for(archive)? {
        Format::Zip => {
            let file = File::open(archive).map_err(|_| "Can’t open archive".to_string())?;
            let mut za = zip::ZipArchive::new(file).map_err(|e| friendly_zip(&e))?;
            let pw = password_for(archive);
            for i in 0..za.len() {
                // Names come from the central directory, so this is cheap and
                // doesn't need the password.
                let path = match za.by_index_raw(i) {
                    Ok(f) if !f.is_dir() => normalize_inner(f.name()),
                    _ => continue,
                };
                if !wanted.iter().any(|w| *w == path) {
                    continue;
                }
                match &pw {
                    Some(p) => {
                        let mut f = za.by_index_decrypt(i, p.as_bytes()).map_err(|e| zip_decrypt_err(archive, &e))?;
                        sink(&path, &mut f)?;
                    }
                    None => {
                        let mut f = za.by_index(i).map_err(|e| zip_read_err(&e))?;
                        sink(&path, &mut f)?;
                    }
                }
            }
            Ok(())
        }
        Format::SevenZ => sevenz_walk(archive, |p| wanted.iter().any(|w| w == p), sink),
        // One pass for the whole selection: a .tar.gz is decompressed once no
        // matter how many members were picked.
        Format::Tar(c) => tar_walk(archive, c, |p| wanted.iter().any(|w| w == p), sink),
        Format::Single(c) => {
            let name = single_member_name(archive);
            if !wanted.iter().any(|w| *w == name) {
                return Ok(());
            }
            sink(&name, &mut *decoded(archive, c)?)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    /// Build a small zip on disk: a nested tree plus a member whose name tries to
    /// climb out of the archive.
    fn fixture(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("delight-archive-test-{tag}.zip"));
        let f = File::create(&p).unwrap();
        let mut w = zip::ZipWriter::new(f);
        let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        w.start_file("readme.txt", opts).unwrap();
        w.write_all(b"hello").unwrap();
        w.add_directory("sub", opts).unwrap();
        w.start_file("sub/a.txt", opts).unwrap();
        w.write_all(b"aaaa").unwrap();
        // No explicit "sub/deep" entry — it must be synthesized from this member.
        w.start_file("sub/deep/b.txt", opts).unwrap();
        w.write_all(b"bbbbbb").unwrap();
        w.start_file("../escape.txt", opts).unwrap();
        w.write_all(b"nope").unwrap();
        w.finish().unwrap();
        p
    }

    #[test]
    fn parses_the_archive_boundary() {
        let l = Loc::parse(r"C:\x\foo.zip!sub/a.txt");
        assert_eq!(
            l,
            Loc::Archive { archive: PathBuf::from(r"C:\x\foo.zip"), inner: "sub/a.txt".into() }
        );
        // A bare "!" in an ordinary path is not a boundary.
        assert_eq!(Loc::parse(r"C:\my!stuff\x"), Loc::Local(PathBuf::from(r"C:\my!stuff\x")));
        // Archive root: marker present, nothing after it.
        assert!(matches!(Loc::parse(r"C:\x\foo.zip!"), Loc::Archive { inner, .. } if inner.is_empty()));
        // Round-trips through the string form.
        let s = r"C:\x\foo.zip!sub";
        assert_eq!(Loc::parse(s).to_path_string(), s);
    }

    #[test]
    fn traversal_is_neutralized() {
        assert_eq!(normalize_inner("../../etc/passwd"), "etc/passwd");
        assert_eq!(normalize_inner(r"sub\..\..\..\x"), "x");
        assert_eq!(normalize_inner("/abs/path/"), "abs/path");
        assert_eq!(normalize_inner("a/./b//c"), "a/b/c");
    }

    #[test]
    fn lists_root_and_synthesizes_missing_dirs() {
        let p = fixture("list");
        let root = list(&p, "").unwrap();
        let mut names: Vec<&str> = root.entries.iter().map(|e| e.name.as_str()).collect();
        names.sort();
        // "escape.txt" landed at the root (its "../" was stripped), and "sub" is here.
        assert_eq!(names, vec!["escape.txt", "readme.txt", "sub"]);
        assert!(root.read_only);
        assert_eq!(root.parent.as_deref(), p.parent().map(|q| q.to_str().unwrap()));

        // "sub/deep" has no entry of its own in the zip; it must still be listed.
        let sub = list(&p, "sub").unwrap();
        let mut subnames: Vec<&str> = sub.entries.iter().map(|e| e.name.as_str()).collect();
        subnames.sort();
        assert_eq!(subnames, vec!["a.txt", "deep"]);
        assert!(sub.entries.iter().find(|e| e.name == "deep").unwrap().is_dir);

        let deep = list(&p, "sub/deep").unwrap();
        assert_eq!(deep.entries.len(), 1);
        assert_eq!(deep.entries[0].size, 6);
        // Walking up from a subdirectory stays inside the archive.
        assert_eq!(deep.parent.as_deref(), Some(format!("{}!sub", p.to_string_lossy()).as_str()));
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn sizes_and_reads_members() {
        let p = fixture("read");
        let index = index_for(&p).unwrap();
        assert_eq!(index.size_under("sub"), 10); // 4 + 6
        assert_eq!(index.size_under(""), 19); // + hello(5) + nope(4)

        let (bytes, truncated) = read_member(&p, "sub/a.txt", 1024).unwrap();
        assert_eq!(bytes, b"aaaa");
        assert!(!truncated);

        let (short, truncated) = read_member(&p, "sub/deep/b.txt", 2).unwrap();
        assert_eq!(short, b"bb");
        assert!(truncated);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn extracts_requested_members_in_one_pass() {
        let p = fixture("extract");
        let wanted = vec!["sub/a.txt".to_string(), "sub/deep/b.txt".to_string()];
        let mut got: Vec<(String, usize)> = Vec::new();
        let mut passes = 0;
        extract_members(&p, &wanted, |name, r| {
            passes += 1;
            let mut buf = Vec::new();
            r.read_to_end(&mut buf).unwrap();
            got.push((name.to_string(), buf.len()));
            Ok(())
        })
        .unwrap();
        got.sort();
        assert_eq!(got, vec![("sub/a.txt".to_string(), 4), ("sub/deep/b.txt".to_string(), 6)]);
        assert_eq!(passes, 2, "only the requested members should be visited");

        // A sink that fails aborts the walk (this is how cancel surfaces).
        let err = extract_members(&p, &wanted, |_, _| Err("cancelled".to_string()));
        assert_eq!(err.unwrap_err(), "cancelled");
        let _ = std::fs::remove_file(&p);
    }

    /// Real-world zips are Deflated, not Stored — this is the path that proves the
    /// pure-Rust decoder (flate2/miniz_oxide) actually works end to end.
    #[test]
    fn reads_deflated_members() {
        let p = std::env::temp_dir().join("delight-archive-test-deflate.zip");
        let body: String = "the quick brown fox ".repeat(500); // compresses well
        {
            let f = File::create(&p).unwrap();
            let mut w = zip::ZipWriter::new(f);
            w.start_file(
                "big.txt",
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated),
            )
            .unwrap();
            w.write_all(body.as_bytes()).unwrap();
            w.finish().unwrap();
        }
        // Stored would make the archive at least as large as the payload.
        assert!(std::fs::metadata(&p).unwrap().len() < body.len() as u64 / 2);

        let index = index_for(&p).unwrap();
        assert_eq!(index.members.len(), 1);
        assert_eq!(index.members[0].size, body.len() as u64);

        let (bytes, truncated) = read_member(&p, "big.txt", 1 << 20).unwrap();
        assert!(!truncated);
        assert_eq!(bytes, body.as_bytes(), "deflate must round-trip exactly");

        let mut extracted = Vec::new();
        extract_members(&p, &["big.txt".to_string()], |_, r| {
            r.read_to_end(&mut extracted).unwrap();
            Ok(())
        })
        .unwrap();
        assert_eq!(extracted, body.as_bytes());
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn detects_formats_longest_suffix_first() {
        assert_eq!(format_of("x.tar.gz"), Some(Format::Tar(Codec::Gzip)));
        assert_eq!(format_of("x.tgz"), Some(Format::Tar(Codec::Gzip)));
        assert_eq!(format_of("x.tar.zst"), Some(Format::Tar(Codec::Zstd)));
        assert_eq!(format_of("x.tar"), Some(Format::Tar(Codec::Plain)));
        // A bare compressor is NOT a tar — this is the pairing that's easy to
        // get backwards.
        assert_eq!(format_of("notes.txt.gz"), Some(Format::Single(Codec::Gzip)));
        assert_eq!(format_of("dump.xz"), Some(Format::Single(Codec::Xz)));
        assert_eq!(format_of("A.TAR.GZ"), Some(Format::Tar(Codec::Gzip))); // case-insensitive
        assert_eq!(format_of("book.epub"), Some(Format::Zip));
        assert_eq!(format_of("notes.txt"), None);
    }

    /// Build a tar (optionally compressed) with the same shape as the zip fixture.
    fn tar_fixture(tag: &str, ext: &str, codec: Codec) -> PathBuf {
        let mut buf = Vec::new();
        {
            let mut w = tar::Builder::new(&mut buf);
            let add = |w: &mut tar::Builder<&mut Vec<u8>>, name: &str, body: &[u8]| {
                let mut h = tar::Header::new_gnu();
                h.set_size(body.len() as u64);
                h.set_mode(0o644);
                h.set_mtime(1_700_000_000);
                h.set_cksum();
                w.append_data(&mut h, name, body).unwrap();
            };
            add(&mut w, "readme.txt", b"hello");
            // No explicit "sub" or "sub/deep" entries — both must be synthesized.
            add(&mut w, "sub/a.txt", b"aaaa");
            add(&mut w, "sub/deep/b.txt", b"bbbbbb");
            w.finish().unwrap();
        }
        let bytes = match codec {
            Codec::Plain => buf,
            Codec::Gzip => {
                use std::io::Write;
                let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
                e.write_all(&buf).unwrap();
                e.finish().unwrap()
            }
            _ => unreachable!("fixture only builds plain/gzip"),
        };
        let p = std::env::temp_dir().join(format!("delight-archive-test-{tag}{ext}"));
        std::fs::write(&p, bytes).unwrap();
        p
    }

    #[test]
    fn browses_tar_and_tar_gz() {
        for (tag, ext, codec) in [("plain", ".tar", Codec::Plain), ("gz", ".tar.gz", Codec::Gzip)] {
            let p = tar_fixture(tag, ext, codec);
            let root = list(&p, "").unwrap();
            let mut names: Vec<&str> = root.entries.iter().map(|e| e.name.as_str()).collect();
            names.sort();
            assert_eq!(names, vec!["readme.txt", "sub"], "root of {ext}");
            assert!(root.read_only);

            // tar stores no directory entries here; both levels are synthesized.
            let sub = list(&p, "sub").unwrap();
            let mut s: Vec<&str> = sub.entries.iter().map(|e| e.name.as_str()).collect();
            s.sort();
            assert_eq!(s, vec!["a.txt", "deep"], "sub of {ext}");
            assert_eq!(list(&p, "sub/deep").unwrap().entries[0].size, 6);

            let (bytes, _) = read_member(&p, "sub/deep/b.txt", 1024).unwrap();
            assert_eq!(bytes, b"bbbbbb", "member read from {ext}");
            assert_eq!(index_for(&p).unwrap().size_under("sub"), 10);
            let _ = std::fs::remove_file(&p);
        }
    }

    /// The property that makes browsing a .tar.gz viable: extracting N members
    /// decompresses the stream once, not N times.
    #[test]
    fn tar_gz_extracts_everything_in_one_decompression() {
        let p = tar_fixture("onepass", ".tar.gz", Codec::Gzip);
        let wanted = vec!["readme.txt".to_string(), "sub/deep/b.txt".to_string()];
        let mut seen: Vec<(String, usize)> = Vec::new();
        extract_members(&p, &wanted, |name, r| {
            let mut b = Vec::new();
            r.read_to_end(&mut b).unwrap();
            seen.push((name.to_string(), b.len()));
            Ok(())
        })
        .unwrap();
        // Stream order, and each member visited exactly once.
        assert_eq!(seen, vec![("readme.txt".to_string(), 5), ("sub/deep/b.txt".to_string(), 6)]);

        // A failing sink still aborts the walk (cancellation path).
        assert_eq!(
            extract_members(&p, &wanted, |_, _| Err("cancelled".into())).unwrap_err(),
            "cancelled"
        );
        let _ = std::fs::remove_file(&p);
    }

    /// A bare compressor isn't a container: it shows one member, named by dropping
    /// the compression suffix.
    #[test]
    fn bare_gzip_presents_one_member() {
        use std::io::Write;
        let body = "single stream payload\n".repeat(100);
        let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        e.write_all(body.as_bytes()).unwrap();
        // Own directory, so the file is literally "notes.txt.gz" and the derived
        // member name isn't skewed by a fixture prefix.
        let dir = std::env::temp_dir().join("delight-archive-test-bare");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("notes.txt.gz");
        std::fs::write(&p, e.finish().unwrap()).unwrap();

        let root = list(&p, "").unwrap();
        assert_eq!(root.entries.len(), 1);
        assert_eq!(root.entries[0].name, "notes.txt");
        assert!(!root.entries[0].is_dir);
        // Size comes from the gzip trailer, so it's exact without decompressing.
        assert_eq!(root.entries[0].size, body.len() as u64);

        let (bytes, _) = read_member(&p, "notes.txt", 1 << 20).unwrap();
        assert_eq!(bytes, body.as_bytes());

        let mut out = Vec::new();
        extract_members(&p, &["notes.txt".to_string()], |n, r| {
            assert_eq!(n, "notes.txt");
            r.read_to_end(&mut out).unwrap();
            Ok(())
        })
        .unwrap();
        assert_eq!(out, body.as_bytes());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A minimal zstd frame carrying `payload` as a single raw (stored) block.
    /// Our zstd crate decodes only, so a real encoder isn't available — this
    /// hand-built frame is enough to prove the decoder is wired up correctly.
    fn zstd_frame(payload: &[u8]) -> Vec<u8> {
        let mut v = vec![0x28, 0xB5, 0x2F, 0xFD]; // magic
        v.push(0x20); // frame header: single segment, content size follows as u8
        v.push(payload.len() as u8);
        // Block header: 3 little-endian bits -> last=1, type=Raw(0), size<<3.
        let h = 1u32 | (0u32 << 1) | ((payload.len() as u32) << 3);
        v.extend_from_slice(&h.to_le_bytes()[..3]);
        v.extend_from_slice(payload);
        v
    }

    #[test]
    fn bare_zstd_decodes() {
        let body = b"zstd single stream";
        let dir = std::env::temp_dir().join("delight-archive-test-zstd");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("payload.txt.zst");
        std::fs::write(&p, zstd_frame(body)).unwrap();

        let root = list(&p, "").unwrap();
        assert_eq!(root.entries.len(), 1);
        assert_eq!(root.entries[0].name, "payload.txt");
        // zstd has no length field we read cheaply, so this came from measuring
        // the decoded stream — which also proves the decoder ran.
        assert_eq!(root.entries[0].size, body.len() as u64);

        let (bytes, _) = read_member(&p, "payload.txt", 4096).unwrap();
        assert_eq!(bytes, body);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn detects_7z_and_reads_it() {
        // sevenz-rust can write, so this fixture is a genuine 7z container.
        assert_eq!(format_of("bundle.7z"), Some(Format::SevenZ));
        let dir = std::env::temp_dir().join("delight-archive-test-7zsrc");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub/deep")).unwrap();
        std::fs::write(dir.join("readme.txt"), b"hello").unwrap();
        std::fs::write(dir.join("sub/a.txt"), b"aaaa").unwrap();
        std::fs::write(dir.join("sub/deep/b.txt"), b"bbbbbb").unwrap();
        let p = std::env::temp_dir().join("delight-archive-test.7z");
        let _ = std::fs::remove_file(&p);
        sevenz_rust::compress_to_path(&dir, &p).unwrap();

        let root = list(&p, "").unwrap();
        let mut names: Vec<&str> = root.entries.iter().map(|e| e.name.as_str()).collect();
        names.sort();
        assert_eq!(names, vec!["readme.txt", "sub"]);
        assert!(root.read_only);

        let sub = list(&p, "sub").unwrap();
        let mut s: Vec<&str> = sub.entries.iter().map(|e| e.name.as_str()).collect();
        s.sort();
        assert_eq!(s, vec!["a.txt", "deep"]);

        let (bytes, _) = read_member(&p, "sub/deep/b.txt", 4096).unwrap();
        assert_eq!(bytes, b"bbbbbb");
        assert_eq!(index_for(&p).unwrap().size_under("sub"), 10);

        // Extraction visits each requested member once.
        let mut seen: Vec<(String, usize)> = Vec::new();
        extract_members(&p, &["readme.txt".into(), "sub/a.txt".into()], |n, r| {
            let mut b = Vec::new();
            r.read_to_end(&mut b).unwrap();
            seen.push((n.to_string(), b.len()));
            Ok(())
        })
        .unwrap();
        seen.sort();
        assert_eq!(seen, vec![("readme.txt".to_string(), 5), ("sub/a.txt".to_string(), 4)]);

        let _ = std::fs::remove_file(&p);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Empty directories have no files to imply them, so copy-out has to learn
    /// about them from the index or they vanish.
    #[test]
    fn index_reports_empty_directories() {
        let p = std::env::temp_dir().join("delight-archive-test-emptydir.zip");
        {
            let f = File::create(&p).unwrap();
            let mut w = zip::ZipWriter::new(f);
            let opts = SimpleFileOptions::default();
            w.add_directory("empty", opts).unwrap();
            w.add_directory("holder/alsoempty", opts).unwrap();
            w.start_file("holder/x.txt", opts).unwrap();
            w.write_all(b"x").unwrap();
            w.finish().unwrap();
        }
        let ix = index_for(&p).unwrap();
        let mut dirs: Vec<&str> = ix.dirs_under("").iter().map(|m| m.path.as_str()).collect();
        dirs.sort();
        assert_eq!(dirs, vec!["empty", "holder", "holder/alsoempty"]);
        // No files under "empty" — only dirs_under knows it exists.
        assert!(ix.files_under("empty").is_empty());
        let _ = std::fs::remove_file(&p);
    }

    /// Timestamps and mode bits are captured so copy-out can put them back.
    #[test]
    fn captures_mode_and_mtime() {
        let p = std::env::temp_dir().join("delight-archive-test-meta.zip");
        {
            let f = File::create(&p).unwrap();
            let mut w = zip::ZipWriter::new(f);
            let opts = SimpleFileOptions::default()
                .unix_permissions(0o640)
                .last_modified_time(zip::DateTime::from_date_and_time(2021, 3, 4, 5, 6, 8).unwrap());
            w.start_file("stamped.txt", opts).unwrap();
            w.write_all(b"x").unwrap();
            w.finish().unwrap();
        }
        let ix = index_for(&p).unwrap();
        let m = ix.members.iter().find(|m| m.path == "stamped.txt").unwrap();
        assert_eq!(m.mode.map(|x| x & 0o777), Some(0o640));
        // 2021-03-04T05:06:08Z
        assert_eq!(m.modified_ms, Some(1_614_834_368_000));
        assert!(!m.encrypted);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn tar_links_are_flagged_not_treated_as_empty_files() {
        let mut buf = Vec::new();
        {
            let mut w = tar::Builder::new(&mut buf);
            let mut h = tar::Header::new_gnu();
            h.set_size(5);
            h.set_mode(0o644);
            h.set_cksum();
            w.append_data(&mut h, "real.txt", &b"hello"[..]).unwrap();

            let mut lh = tar::Header::new_gnu();
            lh.set_size(0);
            lh.set_entry_type(tar::EntryType::Symlink);
            lh.set_mode(0o777);
            w.append_link(&mut lh, "link.txt", "real.txt").unwrap();
            w.finish().unwrap();
        }
        let p = std::env::temp_dir().join("delight-archive-test-links.tar");
        std::fs::write(&p, buf).unwrap();

        let ix = index_for(&p).unwrap();
        let link = ix.members.iter().find(|m| m.path == "link.txt").unwrap();
        assert!(link.is_link, "symlink entry must be flagged");
        assert_eq!(link.link_target.as_deref(), Some("real.txt"));
        let real = ix.members.iter().find(|m| m.path == "real.txt").unwrap();
        assert!(!real.is_link);
        let _ = std::fs::remove_file(&p);
    }

    /// An encrypted zip still lists (names live in the clear central directory);
    /// only reading needs the password, which is why the prompt can arrive after
    /// the user is already browsing.
    #[test]
    fn encrypted_zip_reports_then_reads_with_a_password() {
        let p = std::env::temp_dir().join("delight-archive-test-encrypted.zip");
        {
            let f = File::create(&p).unwrap();
            let mut w = zip::ZipWriter::new(f);
            let opts = SimpleFileOptions::default()
                .with_aes_encryption(zip::AesMode::Aes256, "hunter2");
            w.start_file("secret.txt", opts).unwrap();
            w.write_all(b"classified").unwrap();
            w.finish().unwrap();
        }

        let root = list(&p, "").unwrap();
        assert_eq!(root.entries.len(), 1);
        assert_eq!(root.entries[0].name, "secret.txt");
        assert!(
            index_for(&p).unwrap().members[0].encrypted,
            "the index should know the member is encrypted"
        );

        // No password yet: the caller gets the sentinel, not a raw zip error.
        assert_eq!(read_member(&p, "secret.txt", 4096).unwrap_err(), NEEDS_PASSWORD);

        // A wrong password is rejected and NOT cached — otherwise every later
        // read would fail as "wrong password" with no way to be asked again.
        assert_eq!(
            set_archive_password(p.to_string_lossy().into_owned(), "wrong".into()),
            Err("Wrong password".to_string())
        );
        assert_eq!(
            read_member(&p, "secret.txt", 4096).unwrap_err(),
            NEEDS_PASSWORD,
            "after a wrong guess the archive must still ask, not stay stuck"
        );

        set_archive_password(p.to_string_lossy().into_owned(), "hunter2".into()).unwrap();
        let (bytes, _) = read_member(&p, "secret.txt", 4096).unwrap();
        assert_eq!(bytes, b"classified");

        // And copy-out works through the same password.
        let mut out = Vec::new();
        extract_members(&p, &["secret.txt".to_string()], |_, r| {
            r.read_to_end(&mut out).unwrap();
            Ok(())
        })
        .unwrap();
        assert_eq!(out, b"classified");
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn index_is_cached_until_the_archive_changes() {
        let p = fixture("cache");
        let a = index_for(&p).unwrap();
        let b = index_for(&p).unwrap();
        assert!(Arc::ptr_eq(&a, &b), "second lookup should hit the cache");

        // Rewriting the archive changes its stamp, so the next lookup rebuilds.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        let f = File::create(&p).unwrap();
        let mut w = zip::ZipWriter::new(f);
        w.start_file("only.txt", SimpleFileOptions::default()).unwrap();
        w.write_all(b"x").unwrap();
        w.finish().unwrap();

        let c = index_for(&p).unwrap();
        assert!(!Arc::ptr_eq(&a, &c), "changed archive must rebuild");
        assert_eq!(c.members.len(), 1);
        let _ = std::fs::remove_file(&p);
    }
}

