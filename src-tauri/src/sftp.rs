//! SFTP browsing and transfers, over the SYSTEM ssh binary.
//!
//! `ssh -s user@host sftp` asks the server to start its sftp subsystem and
//! wires that channel to the child's stdin/stdout; we speak the SFTP protocol
//! over that pipe (openssh-sftp-client). SFTP is not a standalone protocol —
//! it always runs inside an SSH channel — so this is the same protocol any
//! sftp client speaks; the only question is who implements the SSH layer
//! underneath, and here that's OpenSSH. That buys the whole ecosystem for
//! free: ~/.ssh/config aliases, agent keys, known_hosts, ProxyJump — and it
//! keeps host-key verification (which is what stands between the user and a
//! man-in-the-middle) inside the most audited implementation of it there is.
//!
//! The UI speaks one portable form: `sftp://[user@]host[:port]/abs/path`.
//! `ssh://` is accepted as an alias and canonicalized to `sftp://`.
//!
//! v1 scope: browsing, preview reads, and copying in/out. Mutations
//! (rename/mkdir/delete) are deliberately not wired up yet.

use crate::fs_cmds::{Entry, Listing};
use futures_util::StreamExt;
use openssh_sftp_client::{Sftp, SftpOptions};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

/// Schemes that mean "SFTP over SSH". `ssh://` is an alias — same thing.
const SCHEMES: [&str; 2] = ["sftp://", "ssh://"];

pub fn is_sftp(path: &str) -> bool {
    SCHEMES
        .iter()
        .any(|s| path.len() >= s.len() && path[..s.len()].eq_ignore_ascii_case(s))
}

/// A parsed sftp:// location. `path` is the absolute path on the remote host
/// ("" means "wherever the server puts us", i.e. the login directory).
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct SftpUrl {
    pub user: Option<String>,
    pub host: String,
    pub port: Option<u16>,
    pub path: String,
}

impl SftpUrl {
    pub fn parse(s: &str) -> Option<SftpUrl> {
        let scheme = SCHEMES
            .iter()
            .find(|sc| s.len() >= sc.len() && s[..sc.len()].eq_ignore_ascii_case(sc))?;
        let body = &s[scheme.len()..];
        let (authority, path) = match body.find('/') {
            Some(i) => (&body[..i], &body[i..]),
            None => (body, ""),
        };
        // Last '@' splits credentials from host: "user@domain@host" is legal.
        let (user, hostport) = match authority.rfind('@') {
            Some(i) => (Some(authority[..i].to_string()), &authority[i + 1..]),
            None => (None, authority),
        };
        // A password can't be carried here: OpenSSH takes no password on the
        // command line, by design. Anything after ':' in the user part is
        // dropped rather than quietly ignored downstream.
        let user = user.map(|u| u.split(':').next().unwrap_or("").to_string()).filter(|u| !u.is_empty());
        // host[:port] — but not an IPv6 literal, which we keep whole in [].
        let (host, port) = if hostport.starts_with('[') {
            match hostport.find(']') {
                Some(i) => {
                    let h = hostport[..=i].to_string();
                    let p = hostport[i + 1..].strip_prefix(':').and_then(|p| p.parse().ok());
                    (h, p)
                }
                None => (hostport.to_string(), None),
            }
        } else {
            match hostport.rfind(':') {
                Some(i) => match hostport[i + 1..].parse::<u16>() {
                    Ok(p) => (hostport[..i].to_string(), Some(p)),
                    Err(_) => (hostport.to_string(), None),
                },
                None => (hostport.to_string(), None),
            }
        };
        if host.is_empty() {
            return None;
        }
        Some(SftpUrl {
            user,
            host,
            port,
            path: normalize_remote(path),
        })
    }

    /// Everything but the path — the connection's identity (and pool key).
    pub fn authority(&self) -> String {
        let mut s = String::from("sftp://");
        if let Some(u) = &self.user {
            s.push_str(u);
            s.push('@');
        }
        s.push_str(&self.host);
        if let Some(p) = self.port {
            s.push(':');
            s.push_str(&p.to_string());
        }
        s
    }

    /// The canonical string the UI shows and stores.
    pub fn canonical(&self) -> String {
        format!("{}{}", self.authority(), self.path)
    }

    /// The same location at a different remote path.
    pub fn with_path(&self, path: &str) -> SftpUrl {
        SftpUrl {
            path: normalize_remote(path),
            ..self.clone()
        }
    }

    /// The parent location, or None at the remote root.
    fn parent(&self) -> Option<SftpUrl> {
        let p = self.path.trim_end_matches('/');
        if p.is_empty() {
            return None;
        }
        let cut = p.rfind('/')?;
        Some(self.with_path(if cut == 0 { "/" } else { &p[..cut] }))
    }

    fn base_name(&self) -> String {
        let p = self.path.trim_end_matches('/');
        match p.rsplit('/').find(|s| !s.is_empty()) {
            Some(n) => n.to_string(),
            None => self.host.clone(),
        }
    }
}

/// Remote paths are POSIX: '/'-separated, collapse repeats, drop '.', pop '..',
/// keep a single leading '/'. "" stays "" (meaning the login directory).
fn normalize_remote(p: &str) -> String {
    if p.is_empty() {
        return String::new();
    }
    let mut out: Vec<&str> = Vec::new();
    for seg in p.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            s => out.push(s),
        }
    }
    format!("/{}", out.join("/"))
}

// ---- connections --------------------------------------------------------------
//
// One ssh process per authority, reused by every pane and tab (the archive index
// cache is the precedent). Kept for the app's lifetime; kill_on_drop means a
// closed app never leaves an ssh behind.

struct Conn {
    sftp: Sftp,
    /// Kept so the process lives as long as the session — and dies with it.
    _child: Child,
}

fn pool() -> &'static Mutex<HashMap<String, Arc<Conn>>> {
    static POOL: std::sync::OnceLock<Mutex<HashMap<String, Arc<Conn>>>> = std::sync::OnceLock::new();
    POOL.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Human-readable advice for the ways a batch-mode ssh typically fails. The
/// raw stderr is kept — it's usually the most informative part — with a hint
/// appended for the two cases a GUI can't resolve on its own.
fn ssh_error(stderr: &str) -> String {
    let s = stderr.trim();
    let lower = s.to_lowercase();
    if lower.contains("host key verification failed") || lower.contains("authenticity of host") {
        return format!(
            "{s}\n\nRun `ssh {}` once in a terminal to check and accept the host key.",
            "<host>"
        );
    }
    if lower.contains("permission denied") || lower.contains("no supported authentication") {
        return format!(
            "{s}\n\nDelight runs ssh in batch mode, so it can't prompt: load your key into \
             ssh-agent (or configure a passwordless key for this host) and try again."
        );
    }
    if s.is_empty() {
        "ssh exited without a message".into()
    } else {
        s.to_string()
    }
}

async fn connect(url: &SftpUrl) -> Result<Arc<Conn>, String> {
    let mut cmd = Command::new("ssh");
    // BatchMode: never block on an interactive prompt — a GUI has no TTY, so a
    // hang would be indistinguishable from a dead connection. Failures come
    // back as text we can show. (An SSH_ASKPASS helper that routes prompts to
    // Delight's own dialog is the planned follow-up.)
    cmd.arg("-o").arg("BatchMode=yes");
    cmd.arg("-o").arg("ConnectTimeout=10");
    if let Some(p) = url.port {
        cmd.arg("-p").arg(p.to_string());
    }
    let target = match &url.user {
        Some(u) => format!("{u}@{}", url.host),
        None => url.host.clone(),
    };
    // -s <host> sftp: run the "sftp" subsystem rather than a shell command.
    cmd.arg("-s").arg(&target).arg("sftp");
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.kill_on_drop(true);
    // Windows: a GUI app spawning a console program flashes a console window.
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => {
                "The ssh command wasn't found. On Windows install the OpenSSH client \
                 (Settings → Apps → Optional features)."
                    .to_string()
            }
            _ => format!("Couldn't start ssh: {e}"),
        })?;
    let stdin = child.stdin.take().ok_or("ssh gave no stdin")?;
    let stdout = child.stdout.take().ok_or("ssh gave no stdout")?;
    let stderr = child.stderr.take();

    match Sftp::new(stdin, stdout, SftpOptions::default()).await {
        Ok(sftp) => Ok(Arc::new(Conn { sftp, _child: child })),
        Err(e) => {
            // ssh has usually already exited (auth/host-key failure); its
            // stderr says why far better than the protocol error does.
            let mut msg = String::new();
            if let Some(mut err) = stderr {
                use tokio::io::AsyncReadExt;
                let read = tokio::time::timeout(
                    std::time::Duration::from_millis(1500),
                    err.read_to_string(&mut msg),
                )
                .await;
                let _ = read;
            }
            let msg = msg.replace("<host>", &url.host);
            if msg.trim().is_empty() {
                Err(format!("SFTP handshake failed: {e}"))
            } else {
                Err(ssh_error(&msg).replace("<host>", &target))
            }
        }
    }
}

async fn conn_for(url: &SftpUrl) -> Result<Arc<Conn>, String> {
    let key = url.authority();
    if let Some(c) = pool().lock().await.get(&key) {
        return Ok(c.clone());
    }
    // Not held across the connect: a slow handshake must not block other panes.
    let conn = connect(url).await?;
    let mut guard = pool().lock().await;
    // Another task may have won the race; keep whichever landed first so the
    // pool never holds two sessions to the same authority.
    Ok(guard.entry(key).or_insert(conn).clone())
}

/// Drop a session (used when it turns out to be dead, so the next call redials).
async fn forget(url: &SftpUrl) {
    pool().lock().await.remove(&url.authority());
}

/// Does this error mean "the session is gone" rather than "that operation
/// failed"? A pooled session can die under us — server restart, laptop sleep,
/// idle timeout — and the crate reports the death of its background reader
/// rather than a socket error, so match that too.
fn is_disconnect(e: &str) -> bool {
    let l = e.to_lowercase();
    l.contains("broken pipe")
        || l.contains("connection reset")
        || l.contains("unexpectedeof")
        || l.contains("channel closed")
        || l.contains("early eof")
        || l.contains("background task failed")
        || l.contains("read/flush task failed")
}

/// Every remote entry point funnels through here: run the operation, and if it
/// failed only because the pooled session was dead, drop that session and try
/// once. `$op` is re-evaluated on the retry, so it must be a call expression
/// (a fresh future), not a stored one.
macro_rules! redial {
    ($url:expr, $op:expr) => {
        match $op.await {
            Err(e) if is_disconnect(&e) => {
                forget($url).await;
                $op.await
            }
            other => other,
        }
    };
}

// ---- listing ------------------------------------------------------------------

/// `ls -l`-style permission string from the remote's mode bits.
fn perm_string(md: &openssh_sftp_client::metadata::MetaData, is_dir: bool, is_link: bool) -> Option<String> {
    let p = md.permissions()?;
    let t = if is_link {
        'l'
    } else if is_dir {
        'd'
    } else {
        '-'
    };
    let bit = |on: bool, ch: char| if on { ch } else { '-' };
    Some(
        [
            t,
            bit(p.read_by_owner(), 'r'), bit(p.write_by_owner(), 'w'), bit(p.execute_by_owner(), 'x'),
            bit(p.read_by_group(), 'r'), bit(p.write_by_group(), 'w'), bit(p.execute_by_group(), 'x'),
            bit(p.read_by_other(), 'r'), bit(p.write_by_other(), 'w'), bit(p.execute_by_other(), 'x'),
        ]
        .iter()
        .collect(),
    )
}

fn split_ext(name: &str, is_dir: bool) -> (String, Option<String>) {
    if is_dir {
        return (name.to_string(), None);
    }
    match name.rfind('.') {
        Some(i) if i > 0 => (name[..i].to_string(), Some(name[i + 1..].to_string())),
        _ => (name.to_string(), None),
    }
}

/// List a remote directory, optionally descending into `child` first. An empty
/// path means the login directory, resolved to its real absolute path so the
/// pane shows where it actually is.
pub async fn list(path: &str, child: Option<&str>) -> Result<Listing, String> {
    let url = SftpUrl::parse(path).ok_or("Not a valid sftp:// path")?;
    redial!(&url, list_once(&url, child))
}


async fn list_once(url: &SftpUrl, child: Option<&str>) -> Result<Listing, String> {
    let conn = conn_for(url).await?;
    // Empty path = the login directory; resolve it so the path bar is honest
    // (and so a child is joined onto where we actually are, not onto "/").
    let url = if url.path.is_empty() {
        let mut fs = conn.sftp.fs();
        let home = fs
            .canonicalize(".")
            .await
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .into_owned();
        url.with_path(&home)
    } else {
        url.clone()
    };
    let url = match child {
        Some(c) => url.with_path(&format!("{}/{}", url.path.trim_end_matches('/'), c)),
        None => url,
    };

    let mut fs_dir = conn.sftp.fs();
    let dir = fs_dir
        .open_dir(&url.path)
        .await
        .map_err(|e| friendly(&e.to_string()))?;
    // ReadDir is a !Unpin Stream (it holds a cancellation token), so pin it.
    let mut stream = Box::pin(dir.read_dir());
    let mut entries = Vec::new();
    let mut links: Vec<usize> = Vec::new();
    while let Some(item) = stream.next().await {
        let de = item.map_err(|e| friendly(&e.to_string()))?;
        let name = de.filename().to_string_lossy().into_owned();
        if name == "." || name == ".." {
            continue; // Delight synthesizes its own ".." row
        }
        let ft = de.file_type();
        let is_symlink = ft.map(|t| t.is_symlink()).unwrap_or(false);
        let is_dir = ft.map(|t| t.is_dir()).unwrap_or(false);
        let md = de.metadata();
        let (stem, ext) = split_ext(&name, is_dir);
        if is_symlink {
            links.push(entries.len());
        }
        entries.push(Entry {
            hidden: name.starts_with('.'),
            name,
            stem,
            ext,
            is_dir,
            is_symlink,
            size: if is_dir { 0 } else { md.len().unwrap_or(0) },
            modified_ms: md
                .modified()
                .and_then(|t| t.as_system_time().duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64),
            // SFTP carries no creation time (the protocol has no such attribute).
            created_ms: None,
            permissions: perm_string(&md, is_dir, is_symlink),
        });
    }

    // READDIR reports the LINK's own attributes, so a symlink to a directory
    // would look like a file and Enter would try to "open" it. Resolve just the
    // links (usually a handful) so navigation behaves.
    for i in links {
        let target = format!("{}/{}", url.path.trim_end_matches('/'), entries[i].name);
        let mut fs = conn.sftp.fs();
        if let Ok(md) = fs.metadata(&target).await {
            if md.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                entries[i].is_dir = true;
                entries[i].size = 0;
                entries[i].ext = None;
                entries[i].stem = entries[i].name.clone();
            }
        }
    }

    Ok(Listing {
        path: url.canonical(),
        name: url.base_name(),
        parent: url.parent().map(|p| p.canonical()),
        entries,
        // v1 is browse + copy-out only; the UI greys out rename/delete/new-folder.
        read_only: true,
    })
}

fn friendly(e: &str) -> String {
    let l = e.to_lowercase();
    if l.contains("no such file") {
        "No such folder".into()
    } else if l.contains("permission denied") {
        "Permission denied".into()
    } else {
        e.to_string()
    }
}

// ---- reads --------------------------------------------------------------------

/// Read at most `cap` bytes of a remote file (the code preview). Returns the
/// bytes and whether more remained — the same contract as the local and
/// in-archive readers, so nothing downstream needs to know where it came from.
pub async fn read_file(path: &str, name: &str, cap: usize) -> Result<(Vec<u8>, bool), String> {
    let url = SftpUrl::parse(path).ok_or("Not a valid sftp:// path")?;
    redial!(&url, read_file_once(&url, name, cap))
}

async fn read_file_once(url: &SftpUrl, name: &str, cap: usize) -> Result<(Vec<u8>, bool), String> {
    let target = format!("{}/{}", url.path.trim_end_matches('/'), name);
    let conn = conn_for(url).await?;
    let mut file = conn
        .sftp
        .open(&target)
        .await
        .map_err(|e| friendly(&e.to_string()))?;
    // +1 over the cap so "exactly cap" is distinguishable from "longer".
    let want = cap.saturating_add(1);
    let mut buf = Vec::with_capacity(want.min(64 * 1024));
    while buf.len() < want {
        let chunk = file
            .read(
                (want - buf.len()) as u32,
                bytes::BytesMut::with_capacity(want - buf.len()),
            )
            .await
            .map_err(|e| friendly(&e.to_string()))?;
        match chunk {
            Some(b) if !b.is_empty() => buf.extend_from_slice(&b),
            _ => break,
        }
    }
    let truncated = buf.len() > cap;
    buf.truncate(cap);
    Ok((buf, truncated))
}

// ---- copy out -----------------------------------------------------------------

/// Walk a remote item into a flat plan: every file to fetch (with its size, so
/// the progress total is real) and every directory to create first. Iterative
/// rather than recursive — async recursion needs boxing, and a work stack reads
/// more plainly anyway. Symlinks are not followed: a link that points outside
/// the copied tree would silently drag in unrelated data.
pub async fn plan(
    dir: &str,
    name: &str,
    dest: &std::path::Path,
    files: &mut Vec<(String, std::path::PathBuf, u64)>,
    dirs: &mut Vec<std::path::PathBuf>,
    skipped: &mut Vec<String>,
) -> Result<(), String> {
    let url = SftpUrl::parse(dir).ok_or("Not a valid sftp:// path")?;
    // A partial walk must not leave half a plan behind on the retry.
    let (files_len, dirs_len, skipped_len) = (files.len(), dirs.len(), skipped.len());
    match plan_once(&url, name, dest, files, dirs, skipped).await {
        Err(e) if is_disconnect(&e) => {
            forget(&url).await;
            files.truncate(files_len);
            dirs.truncate(dirs_len);
            skipped.truncate(skipped_len);
            plan_once(&url, name, dest, files, dirs, skipped).await
        }
        other => other,
    }
}

async fn plan_once(
    url: &SftpUrl,
    name: &str,
    dest: &std::path::Path,
    files: &mut Vec<(String, std::path::PathBuf, u64)>,
    dirs: &mut Vec<std::path::PathBuf>,
    skipped: &mut Vec<String>,
) -> Result<(), String> {
    let conn = conn_for(url).await?;
    let start = format!("{}/{}", url.path.trim_end_matches('/'), name);
    // Attributes ride along from the READDIR that discovered the entry, so only
    // the root item needs its own stat. (Statting every entry separately turned
    // a walk of /etc into 77 seconds of round trips.)
    type Attrs = (bool, bool, u64); // (is_dir, is_symlink, size)
    let mut stack: Vec<(String, std::path::PathBuf, Option<Attrs>)> =
        vec![(start, dest.join(name), None)];

    while let Some((remote, local, known)) = stack.pop() {
        let base = || remote.rsplit('/').next().unwrap_or(&remote).to_string();
        let (is_dir, is_link, size) = match known {
            Some(a) => a,
            None => {
                let mut fs = conn.sftp.fs();
                match fs.symlink_metadata(&remote).await {
                    Ok(md) => {
                        let ft = md.file_type();
                        (
                            ft.map(|t| t.is_dir()).unwrap_or(false),
                            ft.map(|t| t.is_symlink()).unwrap_or(false),
                            md.len().unwrap_or(0),
                        )
                    }
                    Err(e) => {
                        let msg = e.to_string();
                        // A dead session is fatal (the caller redials); anything
                        // else is one unreadable item, not a failed operation.
                        if is_disconnect(&msg) {
                            return Err(msg);
                        }
                        skipped.push(base());
                        continue;
                    }
                }
            }
        };
        // Links aren't followed: a link out of the tree would drag in unrelated
        // data, and a link back into it would loop. Reported, never silent.
        if is_link {
            skipped.push(base());
            continue;
        }
        if !is_dir {
            files.push((url.with_path(&remote).canonical(), local, size));
            continue;
        }
        dirs.push(local.clone());
        let dir = match conn.sftp.fs().open_dir(&remote).await {
            Ok(d) => d,
            Err(e) => {
                let msg = e.to_string();
                if is_disconnect(&msg) {
                    return Err(msg);
                }
                // One unreadable subdirectory (/etc/ssl/private and friends)
                // must not abort the whole copy — record it and carry on.
                skipped.push(base());
                continue;
            }
        };
        let mut stream = Box::pin(dir.read_dir());
        while let Some(item) = stream.next().await {
            let de = match item {
                Ok(de) => de,
                Err(e) => {
                    let msg = e.to_string();
                    if is_disconnect(&msg) {
                        return Err(msg);
                    }
                    skipped.push(base());
                    break;
                }
            };
            let n = de.filename().to_string_lossy().into_owned();
            if n == "." || n == ".." {
                continue;
            }
            let ft = de.file_type();
            let md = de.metadata();
            stack.push((
                format!("{}/{}", remote.trim_end_matches('/'), n),
                local.join(&n),
                Some((
                    ft.map(|t| t.is_dir()).unwrap_or(false),
                    ft.map(|t| t.is_symlink()).unwrap_or(false),
                    md.len().unwrap_or(0),
                )),
            ));
        }
    }
    Ok(())
}

/// Stream one remote file to a local path, reporting progress and honoring
/// cancellation at chunk boundaries (so a big file can be stopped promptly,
/// not only between files).
pub async fn download(
    remote: &str,
    local: &std::path::Path,
    // + Send so the command's future stays Send (Tauri spawns it on the runtime).
    ctx: &mut (dyn crate::ops::ProgressSink + Send),
) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    const CHUNK: usize = 64 * 1024;

    let url = SftpUrl::parse(remote).ok_or("Not a valid sftp:// path")?;
    let conn = conn_for(&url).await?;
    let mut file = conn
        .sftp
        .open(&url.path)
        .await
        .map_err(|e| friendly(&e.to_string()))?;
    let mut out = tokio::fs::File::create(local)
        .await
        .map_err(|e| e.to_string())?;
    let label = local
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    loop {
        if ctx.cancelled() {
            return Err(crate::ops::CANCELLED.to_string());
        }
        let chunk = file
            .read(CHUNK as u32, bytes::BytesMut::with_capacity(CHUNK))
            .await
            .map_err(|e| friendly(&e.to_string()))?;
        match chunk {
            Some(b) if !b.is_empty() => {
                out.write_all(&b).await.map_err(|e| e.to_string())?;
                ctx.advance(b.len() as u64, &label);
            }
            _ => break,
        }
    }
    out.flush().await.map_err(|e| e.to_string())?;
    Ok(())
}

/// The pieces of the chips-view detail card that a remote host can answer.
/// SFTP has no creation time and no notion of a default app, and it reports
/// owners numerically, so those stay empty rather than being faked.
pub struct RemoteInfo {
    pub permissions: Option<String>,
    pub dir_count: Option<u64>,
    /// (name, is_dir, is_symlink) for the first few children of a directory.
    pub children: Vec<(String, bool, bool)>,
}

pub async fn info(dir: &str, name: Option<&str>, max_children: usize) -> Result<RemoteInfo, String> {
    let url = SftpUrl::parse(dir).ok_or("Not a valid sftp:// path")?;
    redial!(&url, info_once(&url, name, max_children))
}

async fn info_once(url: &SftpUrl, name: Option<&str>, max_children: usize) -> Result<RemoteInfo, String> {
    let target = match name {
        Some(n) => url.with_path(&format!("{}/{}", url.path.trim_end_matches('/'), n)),
        None => url.clone(),
    };
    let conn = conn_for(&url).await?;
    let mut fs = conn.sftp.fs();
    let md = fs
        .metadata(&target.path)
        .await
        .map_err(|e| friendly(&e.to_string()))?;
    let is_dir = md.file_type().map(|t| t.is_dir()).unwrap_or(false);
    let mut out = RemoteInfo {
        permissions: perm_string(&md, is_dir, false),
        dir_count: None,
        children: Vec::new(),
    };
    if is_dir {
        // One extra READDIR for the card's child preview; cheap next to the
        // round trip we already paid, and only for the selected item.
        if let Ok(d) = conn.sftp.fs().open_dir(&target.path).await {
            let mut stream = Box::pin(d.read_dir());
            let mut count = 0u64;
            while let Some(Ok(de)) = stream.next().await {
                let n = de.filename().to_string_lossy().into_owned();
                if n == "." || n == ".." {
                    continue;
                }
                count += 1;
                if out.children.len() < max_children {
                    let ft = de.file_type();
                    out.children.push((
                        n,
                        ft.map(|t| t.is_dir()).unwrap_or(false),
                        ft.map(|t| t.is_symlink()).unwrap_or(false),
                    ));
                }
            }
            out.dir_count = Some(count);
        }
    }
    Ok(out)
}

/// Total size of a remote file (for the details panel / progress totals).
pub async fn size_of(path: &str, name: Option<&str>) -> Result<u64, String> {
    let url = SftpUrl::parse(path).ok_or("Not a valid sftp:// path")?;
    redial!(&url, size_of_once(&url, name))
}

async fn size_of_once(url: &SftpUrl, name: Option<&str>) -> Result<u64, String> {
    let target = match name {
        Some(n) => format!("{}/{}", url.path.trim_end_matches('/'), n),
        None => url.path.clone(),
    };
    let conn = conn_for(&url).await?;
    let mut fs = conn.sftp.fs();
    let md = fs.metadata(&target).await.map_err(|e| friendly(&e.to_string()))?;
    Ok(md.len().unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_both_schemes_to_one_canonical_form() {
        for s in ["sftp://nas/srv/media", "ssh://nas/srv/media", "SFTP://nas/srv/media"] {
            let u = SftpUrl::parse(s).unwrap();
            assert_eq!(u.host, "nas");
            assert_eq!(u.path, "/srv/media");
            // ssh:// is an alias — it canonicalizes to sftp://.
            assert_eq!(u.canonical(), "sftp://nas/srv/media");
        }
        assert!(is_sftp("ssh://x") && is_sftp("sftp://x") && !is_sftp("C:\\ssh://x"));
    }

    #[test]
    fn user_port_and_ipv6() {
        let u = SftpUrl::parse("sftp://marton@nas:2222/home/marton").unwrap();
        assert_eq!(u.user.as_deref(), Some("marton"));
        assert_eq!(u.port, Some(2222));
        assert_eq!(u.canonical(), "sftp://marton@nas:2222/home/marton");

        let u = SftpUrl::parse("sftp://[fe80::1]:22/x").unwrap();
        assert_eq!(u.host, "[fe80::1]");
        assert_eq!(u.port, Some(22));

        // A ':' that isn't a port must not be eaten as one.
        let u = SftpUrl::parse("sftp://nas/x").unwrap();
        assert_eq!(u.port, None);
    }

    #[test]
    fn passwords_are_refused_not_carried() {
        // OpenSSH takes no password on the command line; dropping it here means
        // it can never reach a process argument list or the path bar.
        let u = SftpUrl::parse("sftp://marton:hunter2@nas/x").unwrap();
        assert_eq!(u.user.as_deref(), Some("marton"));
        assert_eq!(u.canonical(), "sftp://marton@nas/x");
    }

    #[test]
    fn remote_paths_normalize_posix_style() {
        assert_eq!(normalize_remote("/a//b/./c"), "/a/b/c");
        assert_eq!(normalize_remote("/a/b/../c"), "/a/c");
        assert_eq!(normalize_remote("/"), "/");
        assert_eq!(normalize_remote(""), "");
        // No path at all = the login directory, resolved at list time.
        assert_eq!(SftpUrl::parse("sftp://nas").unwrap().path, "");
        assert_eq!(SftpUrl::parse("sftp://nas/").unwrap().path, "/");
    }

    #[test]
    fn parent_walks_to_the_root_then_stops() {
        let u = SftpUrl::parse("sftp://nas/a/b/c").unwrap();
        let p = u.parent().unwrap();
        assert_eq!(p.canonical(), "sftp://nas/a/b");
        let p = p.parent().unwrap();
        assert_eq!(p.canonical(), "sftp://nas/a");
        let p = p.parent().unwrap();
        assert_eq!(p.canonical(), "sftp://nas/");
        assert!(p.parent().is_none(), "root has no parent");
    }

    #[test]
    fn base_name_is_the_last_segment() {
        assert_eq!(SftpUrl::parse("sftp://nas/a/b").unwrap().base_name(), "b");
        assert_eq!(SftpUrl::parse("sftp://nas/").unwrap().base_name(), "nas");
    }

    /// The real thing: a live SFTP session over the system ssh binary. Needs a
    /// host reachable with key auth (no passphrase prompt), so it's #[ignore]d
    /// and reads its target from the environment. Read-only — it lists and
    /// reads, never writes:
    ///
    ///   $env:DELIGHT_SFTP_TEST = "sftp://user@host"
    ///   cargo test sftp -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn live_host_lists_and_reads() {
        let Ok(target) = std::env::var("DELIGHT_SFTP_TEST") else {
            eprintln!("DELIGHT_SFTP_TEST not set — skipping the live-host test");
            return;
        };

        // Bare authority = the login directory, resolved to a real absolute path.
        let home = list(&target, None).await.expect("listing the login directory");
        assert!(home.path.starts_with("sftp://"), "canonical path: {}", home.path);
        assert!(!home.path.contains('\\'), "no backslashes: {}", home.path);
        assert!(home.read_only, "v1 is browse + copy-out only");
        assert!(
            home.path.len() > target.len(),
            "the login dir should resolve to an absolute path, got {}",
            home.path
        );
        assert!(home.parent.is_some(), "home has a parent");
        eprintln!("home = {} ({} entries)", home.path, home.entries.len());

        // The root is a directory on every unix host, and it has no parent.
        let root = list(&format!("{target}/"), None).await.expect("listing /");
        assert!(root.parent.is_none(), "root has no parent");
        assert!(
            root.entries.iter().any(|e| e.name == "etc" && e.is_dir),
            "/etc should be listed as a directory"
        );

        // A file every unix host has, read through the preview path.
        let (bytes, truncated) = read_file(&format!("{target}//etc"), "hostname", 4096)
            .await
            .expect("reading /etc/hostname");
        let text = String::from_utf8_lossy(&bytes);
        assert!(!text.trim().is_empty(), "/etc/hostname should have content");
        assert!(!truncated, "/etc/hostname is smaller than the cap");
        eprintln!("/etc/hostname = {:?}", text.trim());

        // The cap really caps: 1 byte of a file that's longer than 1 byte.
        let (small, truncated) = read_file(&format!("{target}//etc"), "hostname", 1)
            .await
            .expect("capped read");
        assert_eq!(small.len(), 1, "read must honor the cap");
        assert!(truncated, "and report that more remained");

        // Metadata for the progress totals.
        let size = size_of(&format!("{target}//etc"), Some("hostname"))
            .await
            .expect("stat /etc/hostname");
        assert!(size > 0);

        // The session is pooled: a second call reuses it (and is fast).
        let again = list(&target, None).await.expect("second listing reuses the session");
        assert_eq!(again.path, home.path);

        // Descending by child name (what Enter on a row does) must land on the
        // same place as typing the full path.
        let by_child = list(&format!("{target}/"), Some("etc")).await.expect("child descent");
        assert_eq!(by_child.path, format!("{target}/etc"));
    }

    /// Copy-out planning against a live host: the plan must enumerate a real
    /// tree with real sizes (that's what makes the progress bar honest).
    /// Read-only — plans, never writes. Same env var and --ignored as above.
    #[tokio::test]
    #[ignore]
    async fn live_host_plans_a_copy_out() {
        let Ok(target) = std::env::var("DELIGHT_SFTP_TEST") else {
            eprintln!("DELIGHT_SFTP_TEST not set — skipping");
            return;
        };
        let dest = std::path::Path::new("/tmp/delight-plan-test");
        let mut files = Vec::new();
        let mut dirs = Vec::new();
        let mut skipped = Vec::new();

        // A single file.
        plan(&format!("{target}//etc"), "hostname", dest, &mut files, &mut dirs, &mut skipped)
            .await
            .expect("planning one file");
        assert_eq!(files.len(), 1, "one file planned");
        assert!(dirs.is_empty(), "a file plans no directories");
        let (remote, local, size) = &files[0];
        assert!(remote.starts_with("sftp://"), "remote stays canonical: {remote}");
        assert!(remote.ends_with("/etc/hostname"));
        assert_eq!(local, &dest.join("hostname"));
        assert!(*size > 0, "size comes from the remote stat");

        // A whole tree — /etc deliberately, because parts of it are unreadable
        // to a normal user and a permission error must NOT abort the plan.
        files.clear();
        dirs.clear();
        skipped.clear();
        let started = std::time::Instant::now();
        plan(&format!("{target}/"), "etc", dest, &mut files, &mut dirs, &mut skipped)
            .await
            .expect("an unreadable subdirectory must not fail the whole plan");
        assert!(dirs.contains(&dest.join("etc")), "the root dir is planned");
        assert!(files.len() > 5, "/etc has many files, got {}", files.len());
        assert!(
            files.iter().all(|(r, l, _)| r.starts_with("sftp://") && l.starts_with(dest)),
            "every planned pair is (canonical remote, local under dest)"
        );
        assert!(
            files.iter().any(|(_, _, n)| *n > 0),
            "sizes must come from the listing, not be zero-filled"
        );
        eprintln!(
            "planned {} files / {} dirs / {} skipped under /etc in {:?}",
            files.len(),
            dirs.len(),
            skipped.len(),
            started.elapsed()
        );
    }

    /// A real binary file over SFTP, whole: this is what the PDF preview does
    /// (read the bytes, hand the webview a blob — no temp file). Binary safety
    /// is the point: the earlier text path would have mangled it.
    #[tokio::test]
    #[ignore]
    async fn live_host_reads_a_binary_file_whole() {
        let Ok(target) = std::env::var("DELIGHT_SFTP_TEST") else {
            eprintln!("DELIGHT_SFTP_TEST not set — skipping");
            return;
        };
        let dir = format!("{target}//usr/share/texlive/texmf-dist/tex/xelatex/langsci");
        let (bytes, truncated) = read_file(&dir, "tbls-book.pdf", 64 * 1024 * 1024)
            .await
            .expect("reading a PDF");
        assert!(!truncated, "should fit well under the cap");
        assert!(bytes.starts_with(b"%PDF"), "a real PDF header survives the trip");
        assert!(
            bytes.windows(5).any(|w| w == b"%%EOF"),
            "and the trailer — i.e. the whole file, not a prefix"
        );
        eprintln!("read {} bytes of PDF", bytes.len());

        // Over-cap must report truncation so the UI refuses rather than
        // rendering a corrupt document.
        let (_, truncated) = read_file(&dir, "tbls-book.pdf", 64).await.expect("capped read");
        assert!(truncated, "a cap smaller than the file must report truncation");
    }

    /// Counts bytes and can be told to stop, so download() is testable without
    /// an AppHandle (the real sink is Ctx, which emits to the webview).
    struct CountingSink {
        bytes: u64,
        stop_after: Option<u64>,
    }
    impl crate::ops::ProgressSink for CountingSink {
        fn cancelled(&self) -> bool {
            self.stop_after.is_some_and(|n| self.bytes >= n)
        }
        fn advance(&mut self, by: u64, _current: &str) {
            self.bytes += by;
        }
    }

    /// The actual transfer: fetch a real file to a temp path and check the
    /// bytes, the progress accounting, and that cancellation stops it.
    #[tokio::test]
    #[ignore]
    async fn live_host_downloads_a_file() {
        let Ok(target) = std::env::var("DELIGHT_SFTP_TEST") else {
            eprintln!("DELIGHT_SFTP_TEST not set — skipping");
            return;
        };
        let remote = format!("{target}//etc/hostname");
        let out = std::env::temp_dir().join("delight-sftp-download-test");
        let _ = std::fs::remove_file(&out);

        let mut sink = CountingSink { bytes: 0, stop_after: None };
        download(&remote, &out, &mut sink).await.expect("download");

        let got = std::fs::read(&out).expect("the file landed locally");
        assert!(!got.is_empty(), "downloaded content is non-empty");
        assert_eq!(
            sink.bytes,
            got.len() as u64,
            "progress must account for exactly the bytes written"
        );
        // Same content the preview path reads — two different code paths, one truth.
        let (via_preview, _) = read_file(&format!("{target}//etc"), "hostname", 4096)
            .await
            .expect("preview read");
        assert_eq!(got, via_preview, "download and preview agree byte for byte");
        eprintln!("downloaded {} bytes to {}", got.len(), out.display());

        // Cancellation: a sink that stops immediately must abort the transfer
        // with the sentinel the op layer looks for, on a file big enough to
        // span several chunks.
        let mut stopper = CountingSink { bytes: 0, stop_after: Some(0) };
        let big = format!("{target}//etc/services");
        let err = download(&big, &out, &mut stopper).await.unwrap_err();
        assert_eq!(err, crate::ops::CANCELLED, "cancel returns the sentinel");

        let _ = std::fs::remove_file(&out);
    }
}
