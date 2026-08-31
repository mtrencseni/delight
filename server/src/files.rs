//! The byte paths: previewing a file, downloading files, uploading them.
//!
//! Everything here is content rather than JSON, so it sits outside the RPC
//! dispatcher — but it goes through the same jail, and answers to the same two
//! credentials. `/api/file` is the one the preview leans on: pointing Chrome's
//! own PDF viewer and `<img>` at a URL, rather than shipping base64 through the
//! command channel, is what makes previewing a 40 MB PDF feel like nothing.

use crate::auth;
use crate::state::AppState;
use axum::body::Body;
use axum::extract::{Query, Request, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tower::ServiceExt;
use tower_http::services::ServeFile;

type St = State<Arc<AppState>>;

fn authed(st: &AppState, h: &HeaderMap) -> bool {
    let hdr = h.get("x-delight-token").and_then(|v| v.to_str().ok());
    auth::header_ok(&st.cfg.token, hdr)
        || auth::from_header(h.get(header::COOKIE).and_then(|v| v.to_str().ok()))
            .is_some_and(|c| auth::verify(&st.cfg.token, c))
}

fn bad(code: StatusCode, msg: impl Into<String>) -> Response {
    (code, msg.into()).into_response()
}


/// `download=1`, `last=true`, `?download` — a query string is text, and callers
/// (including a plain <a href>) spell booleans every one of those ways. Serde's
/// default bool deserializer accepts exactly two of them and 400s on the rest.
fn loose_bool<'de, D: serde::Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
    let v = <String as Deserialize>::deserialize(d)?;
    Ok(matches!(v.as_str(), "1" | "true" | "yes" | "on" | ""))
}

#[derive(Deserialize)]
pub struct FileQuery {
    /// Either a whole path, or dir+name — both spellings the frontend already
    /// uses. `v` is a cache-buster the preview bumps when the file changes.
    path: Option<String>,
    dir: Option<String>,
    name: Option<String>,
    #[serde(default, deserialize_with = "loose_bool")]
    download: bool,
    #[allow(dead_code)]
    v: Option<String>,
}

impl FileQuery {
    /// The checked, real path this query names.
    fn resolve(&self, st: &AppState) -> Result<PathBuf, String> {
        let raw = match (&self.path, &self.dir, &self.name) {
            (Some(p), _, _) => st.cfg.roots.check(p)?,
            (None, Some(d), Some(n)) => {
                let dir = st.cfg.roots.check_pair(d, Some(n))?;
                Path::new(&dir).join(n).to_string_lossy().into_owned()
            }
            _ => return Err("need path, or dir and name".into()),
        };
        let p = PathBuf::from(&raw);
        // Members inside an archive have no bytes on disk to stream; the preview
        // reads those through read_text_file / read_file_bytes instead.
        if raw.contains(delight_core::archive::MARK) {
            return Err("archive members are read through the command channel".into());
        }
        if !p.is_file() {
            return Err("not a file".into());
        }
        Ok(p)
    }
}

/// Stream one file. Range requests are honoured (ServeFile does it), which is
/// what lets Chrome's PDF viewer jump to page 400 of a big document without
/// pulling the whole thing.
pub async fn serve(State(st): St, req: Request) -> Response {
    if !authed(&st, req.headers()) {
        return bad(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    let q: FileQuery = match Query::try_from_uri(req.uri()) {
        Ok(Query(q)) => q,
        Err(e) => return bad(StatusCode::BAD_REQUEST, e.to_string()),
    };
    let path = match q.resolve(&st) {
        Ok(p) => p,
        Err(e) => return bad(StatusCode::FORBIDDEN, e),
    };
    let filename = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".into());

    let mut res = match ServeFile::new(&path).oneshot(req).await {
        Ok(r) => r.into_response(),
        Err(e) => return bad(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    // inline for the preview (the browser renders it), attachment for a download.
    // The filename is quoted and stripped of quotes/newlines so it can't forge
    // a second header field.
    let safe: String = filename.chars().filter(|c| !"\"\r\n".contains(*c)).collect();
    let disp = if q.download {
        format!("attachment; filename=\"{safe}\"")
    } else {
        format!("inline; filename=\"{safe}\"")
    };
    if let Ok(v) = header::HeaderValue::from_str(&disp) {
        res.headers_mut().insert(header::CONTENT_DISPOSITION, v);
    }
    // The preview re-requests with a new ?v= when the file changes, so the URL
    // itself is the cache key and this can be cached hard within a page load.
    res.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("private, max-age=0, must-revalidate"),
    );
    res
}

/// The web build's own static files, from an allowlisted prefix. Deliberately
/// unauthenticated: this is the application, not the data, and the login page
/// has to load for someone who has no session yet.
pub async fn asset(State(st): St, req: Request) -> Response {
    let rel = req.uri().path().trim_start_matches('/');
    if rel.contains("..") {
        return bad(StatusCode::NOT_FOUND, "not found");
    }
    let path = st.cfg.web_dir.join(rel);
    let long_lived = rel.starts_with("assets/");
    match ServeFile::new(&path).oneshot(req).await {
        Ok(r) => {
            let mut res = r.into_response();
            // Vite content-hashes everything under assets/, so those may be
            // cached forever; anything named by hand must not be.
            res.headers_mut().insert(
                header::CACHE_CONTROL,
                header::HeaderValue::from_static(if long_lived {
                    "public, max-age=31536000, immutable"
                } else {
                    "no-cache"
                }),
            );
            res
        }
        Err(_) => bad(StatusCode::NOT_FOUND, "not found"),
    }
}

// ---- multi-file download --------------------------------------------------------

#[derive(Deserialize)]
pub struct ZipQuery {
    /// Newline-separated absolute paths. Whole paths rather than a directory
    /// plus names because a selection can span folders — Delight's tree view
    /// expands subdirectories in place, so the marked rows are not necessarily
    /// siblings. Each one is jailed on its own, which is the same guarantee a
    /// shared parent would have given and covers more cases.
    ///
    /// A query string rather than a POST body so a plain <a href> can be aimed
    /// at it and the browser's own download machinery takes over.
    paths: String,
    #[serde(default)]
    filename: Option<String>,
}

/// Pack the selected items into a zip and send it.
///
/// The zip is built into a temp file first, rather than straight into the
/// response body. That is a deliberate second choice: `zip` seeks back to patch
/// each entry's local header after writing it, which a response body cannot do,
/// and the alternatives were buffering the whole archive in memory or
/// hand-rolling a streaming zip writer. A temp file costs disk and a pause
/// before the download starts; the other two cost RAM and correctness.
///
/// The file is removed as soon as it has been read, whether or not the download
/// completed — the handle stays open while streaming, so unlinking early is
/// safe on unix and the bytes keep flowing.
pub async fn zip(State(st): St, h: HeaderMap, Query(q): Query<ZipQuery>) -> Response {
    if !authed(&st, &h) {
        return bad(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    let raw: Vec<&str> = q.paths.split('\n').filter(|s| !s.is_empty()).collect();
    if raw.is_empty() {
        return bad(StatusCode::BAD_REQUEST, "nothing selected");
    }
    // Jail every path, then name each entry by its basename. Two selections
    // from different folders can share a name, so collisions get a numeric
    // suffix rather than one silently overwriting the other inside the zip.
    let mut picked: Vec<(PathBuf, String)> = Vec::new();
    let mut used: std::collections::HashSet<String> = std::collections::HashSet::new();
    for r in raw {
        let checked = match st.cfg.roots.check(r) {
            Ok(c) => PathBuf::from(c),
            Err(e) => return bad(StatusCode::FORBIDDEN, e),
        };
        let base = checked
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "item".into());
        let mut name = base.clone();
        let mut n = 1;
        while !used.insert(name.clone()) {
            let (stem, ext) = base.rsplit_once('.').unwrap_or((base.as_str(), ""));
            name = if ext.is_empty() {
                format!("{stem}-{n}")
            } else {
                format!("{stem}-{n}.{ext}")
            };
            n += 1;
        }
        picked.push((checked, name));
    }

    let tmp = std::env::temp_dir().join(format!(
        "delight-{}-{}.zip",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    let built = tokio::task::spawn_blocking({
        let tmp = tmp.clone();
        move || -> std::io::Result<()> {
            let mut zw = zip::ZipWriter::new(std::fs::File::create(&tmp)?);
            let opts: zip::write::FileOptions<()> = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            for (full, name) in picked {
                if full.is_dir() {
                    add_dir(&mut zw, &full, &name, opts)?;
                } else {
                    zw.start_file(&name, opts).ok();
                    let mut f = std::fs::File::open(&full)?;
                    std::io::copy(&mut f, &mut zw)?;
                }
            }
            zw.finish()?;
            Ok(())
        }
    })
    .await;
    if let Err(e) = built.map_err(|e| e.to_string()).and_then(|r| r.map_err(|e| e.to_string())) {
        let _ = std::fs::remove_file(&tmp);
        return bad(StatusCode::INTERNAL_SERVER_ERROR, e);
    }

    let file = match tokio::fs::File::open(&tmp).await {
        Ok(f) => f,
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            return bad(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
        }
    };
    // Unlink now: the open handle keeps the data alive until the stream ends,
    // so there is nothing left behind even if the browser hangs up mid-download.
    let _ = std::fs::remove_file(&tmp);

    let name = q.filename.unwrap_or_else(|| "delight.zip".into());
    let safe: String = name.chars().filter(|c| !"\"\r\n/\\".contains(*c)).collect();
    (
        [
            (header::CONTENT_TYPE, "application/zip".to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{safe}\""),
            ),
        ],
        Body::from_stream(tokio_util::io::ReaderStream::new(file)),
    )
        .into_response()
}

fn add_dir<W: std::io::Write + std::io::Seek>(
    zw: &mut zip::ZipWriter<W>,
    disk: &Path,
    rel: &str,
    opts: zip::write::FileOptions<()>,
) -> std::io::Result<()> {
    zw.add_directory(format!("{rel}/"), opts).ok();
    for entry in std::fs::read_dir(disk)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let child_rel = format!("{rel}/{name}");
        let path = entry.path();
        // symlink_metadata: a link is recorded as what it is, never followed —
        // otherwise a link back up the tree makes the zip infinite.
        let meta = std::fs::symlink_metadata(&path)?;
        if meta.is_dir() {
            add_dir(zw, &path, &child_rel, opts)?;
        } else if meta.is_file() {
            zw.start_file(&child_rel, opts).ok();
            let mut f = std::fs::File::open(&path)?;
            std::io::copy(&mut f, zw)?;
        }
    }
    Ok(())
}

// ---- upload -----------------------------------------------------------------------

#[derive(Deserialize)]
pub struct UploadQuery {
    dir: String,
    name: String,
    /// Byte offset this chunk starts at, so a big upload can resume instead of
    /// starting over.
    #[serde(default)]
    offset: u64,
    /// Set on the last chunk: the `.part` file is renamed into place.
    #[serde(default, deserialize_with = "loose_bool")]
    last: bool,
}

/// Append a chunk to `<dir>/<name>.part`, and on the final chunk rename it into
/// place. Writing to `.part` first is the same idiom `archive.rs` uses when
/// packing: an interrupted upload leaves something obviously unfinished rather
/// than a truncated file that looks whole.
pub async fn upload(State(st): St, h: HeaderMap, Query(q): Query<UploadQuery>, body: Body) -> Response {
    if !authed(&st, &h) {
        return bad(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    if st.cfg.read_only {
        return bad(StatusCode::FORBIDDEN, "this server is read-only");
    }
    if let Err(e) = crate::jail::check_name(&q.name) {
        return bad(StatusCode::FORBIDDEN, e);
    }
    let dir = match st.cfg.roots.check(&q.dir) {
        Ok(d) => PathBuf::from(d),
        Err(e) => return bad(StatusCode::FORBIDDEN, e),
    };
    let part = dir.join(format!("{}.part", q.name));
    let final_path = dir.join(&q.name);

    let bytes = match axum::body::to_bytes(body, 512 * 1024 * 1024).await {
        Ok(b) => b,
        Err(e) => return bad(StatusCode::BAD_REQUEST, e.to_string()),
    };
    let res = tokio::task::spawn_blocking(move || -> std::io::Result<u64> {
        use std::io::{Seek, SeekFrom, Write};
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .open(&part)?;
        f.seek(SeekFrom::Start(q.offset))?;
        f.write_all(&bytes)?;
        let end = q.offset + bytes.len() as u64;
        f.set_len(end)?;
        drop(f);
        if q.last {
            std::fs::rename(&part, &final_path)?;
        }
        Ok(end)
    })
    .await;

    match res {
        Ok(Ok(written)) => axum::Json(serde_json::json!({"ok": true, "bytes": written})).into_response(),
        Ok(Err(e)) => bad(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        Err(e) => bad(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}
