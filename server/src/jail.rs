//! The one place a path from the browser becomes a path this process will touch.
//!
//! The desktop app never needed this: the filesystem it browsed belonged to the
//! person at the keyboard, and the OS's own permissions were the boundary. On a
//! server the boundary has to be ours, because the process runs as a user with
//! far more reach than the URL should grant — so every path arriving over HTTP
//! is resolved and checked against a configured set of roots before anything
//! reads it, writes it, or even stats it.
//!
//! Three rules make it hold:
//!
//! 1. **Symlinks are resolved before the check.** A link inside a root pointing
//!    at `/etc` is otherwise a door straight through it. Anything that exists is
//!    canonicalized; for a path that doesn't exist yet (an upload target, a new
//!    folder) the deepest existing ancestor is canonicalized and the remainder —
//!    which by then can contain no `..` — is appended to it.
//! 2. **`..` never survives lexically.** A path containing `..` must canonicalize
//!    in full, which means it must exist. Resolving `..` by string surgery before
//!    symlinks are resolved is how these checks are usually defeated.
//! 3. **The archive marker is split first, and only the real half is checked.**
//!    `…/photos.zip!../../etc/passwd` addresses a member *inside* the zip; the
//!    part left of `!` is the only thing that reaches the filesystem, and
//!    `archive.rs` already normalizes member paths at index time. Checking the
//!    raw string instead would either reject legitimate members or — worse —
//!    accept an archive path that lives outside the roots.
//!
//! SFTP URLs pass through untouched: they address a different host entirely, so
//! the local roots have nothing to say about them.

use delight_core::archive::Loc;
use delight_core::sftp;
use std::path::{Component, Path, PathBuf};

/// The directories this server is willing to expose.
#[derive(Clone, Debug)]
pub struct Roots(Vec<PathBuf>);

impl Roots {
    /// Canonicalize the configured roots once, at startup. A root that doesn't
    /// exist is a configuration error worth failing loudly on: silently dropping
    /// it would leave a server that runs but serves nothing, or — if it was one
    /// of several — quietly narrower than intended.
    pub fn new(paths: Vec<PathBuf>) -> Result<Self, String> {
        if paths.is_empty() {
            return Err("no roots configured".into());
        }
        let mut out = Vec::new();
        for p in paths {
            let c = std::fs::canonicalize(&p)
                .map_err(|e| format!("root {}: {e}", p.display()))?;
            if !c.is_dir() {
                return Err(format!("root {} is not a directory", p.display()));
            }
            out.push(c);
        }
        Ok(Roots(out))
    }

    pub fn list(&self) -> &[PathBuf] {
        &self.0
    }

    /// Check a path as the UI spells it, and return the form the core expects.
    /// Every handler calls this before passing anything into `delight_core`.
    pub fn check(&self, raw: &str) -> Result<String, String> {
        if raw.is_empty() {
            return Err("empty path".into());
        }
        // A different host's filesystem; our roots don't describe it.
        if sftp::is_sftp(raw) {
            return Ok(raw.to_string());
        }
        match Loc::parse(raw) {
            Loc::Local(p) => Ok(self.local(&p)?.to_string_lossy().into_owned()),
            Loc::Archive { archive, inner } => {
                let archive = self.local(&archive)?;
                Ok(Loc::Archive { archive, inner }.to_path_string())
            }
        }
    }

    /// Check a `(dir, name)` pair — the shape most core calls take — and return
    /// the checked directory. The name is validated rather than resolved: these
    /// calls join it onto the directory themselves, so a name carrying a
    /// separator would walk straight back out of a directory we just approved.
    pub fn check_pair(&self, dir: &str, name: Option<&str>) -> Result<String, String> {
        if let Some(n) = name {
            check_name(n)?;
        }
        self.check(dir)
    }

    fn local(&self, p: &Path) -> Result<PathBuf, String> {
        if !p.is_absolute() {
            return Err(format!("{} is not an absolute path", p.display()));
        }
        let resolved = resolve(p)?;
        if self.0.iter().any(|r| resolved.starts_with(r)) {
            Ok(resolved)
        } else {
            // Deliberately vague: whether a path outside the roots exists is
            // itself information this answer shouldn't leak.
            Err(format!("{} is outside the served roots", p.display()))
        }
    }
}

/// One path component, as the UI names a file inside a directory. Must be a
/// plain name: no separators, no `.`/`..`, no NUL.
pub fn check_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name == "." || name == ".." {
        return Err(format!("{name:?} is not a file name"));
    }
    if name.contains('/') || name.contains('\\') || name.contains('\0') {
        return Err(format!("{name:?} is not a file name"));
    }
    Ok(())
}

/// Resolve symlinks as far as the path exists, without letting `..` escape.
fn resolve(p: &Path) -> Result<PathBuf, String> {
    // `..` cannot be resolved lexically without lying about symlinks, so a path
    // that uses it has to exist in full and be canonicalized by the OS.
    if p.components().any(|c| c == Component::ParentDir) {
        return std::fs::canonicalize(p).map_err(|e| format!("{}: {e}", p.display()));
    }
    // Walk up to the deepest ancestor that exists, canonicalize that, and put
    // the (symlink-free, `..`-free) remainder back on.
    let mut tail: Vec<&std::ffi::OsStr> = Vec::new();
    let mut cur = p;
    loop {
        if let Ok(base) = std::fs::canonicalize(cur) {
            let mut out = base;
            for part in tail.iter().rev() {
                out.push(part);
            }
            return Ok(out);
        }
        match (cur.file_name(), cur.parent()) {
            (Some(name), Some(parent)) => {
                tail.push(name);
                cur = parent;
            }
            // Ran out of path without finding anything real: the root itself is
            // missing, which is not a case any live configuration produces.
            _ => return Err(format!("{}: no such path", p.display())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn sandbox(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("delight-jail-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("inside")).unwrap();
        fs::write(dir.join("inside/file.txt"), b"hi").unwrap();
        dir
    }

    fn roots_of(dir: &Path) -> Roots {
        Roots::new(vec![dir.join("inside")]).unwrap()
    }

    #[test]
    fn accepts_paths_under_a_root() {
        let dir = sandbox("accept");
        let r = roots_of(&dir);
        assert!(r.check(&dir.join("inside/file.txt").to_string_lossy()).is_ok());
        assert!(r.check(&dir.join("inside").to_string_lossy()).is_ok());
    }

    #[test]
    fn rejects_paths_outside_every_root() {
        let dir = sandbox("outside");
        let r = roots_of(&dir);
        assert!(r.check("/etc/passwd").is_err());
        assert!(r.check(&dir.to_string_lossy()).is_err(), "the root's parent is out");
    }

    #[test]
    fn rejects_dotdot_that_climbs_out() {
        let dir = sandbox("dotdot");
        let r = roots_of(&dir);
        let escape = dir.join("inside/../inside/../../etc");
        assert!(r.check(&escape.to_string_lossy()).is_err());
    }

    #[test]
    fn dotdot_that_stays_inside_is_fine() {
        let dir = sandbox("dotdot-ok");
        let r = roots_of(&dir);
        let round_trip = dir.join("inside/../inside/file.txt");
        assert!(r.check(&round_trip.to_string_lossy()).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn follows_symlinks_before_deciding() {
        let dir = sandbox("symlink");
        std::os::unix::fs::symlink("/etc", dir.join("inside/escape")).unwrap();
        let r = roots_of(&dir);
        assert!(
            r.check(&dir.join("inside/escape/passwd").to_string_lossy()).is_err(),
            "a symlink out of a root must not be a way out of it"
        );
    }

    #[test]
    fn allows_a_destination_that_does_not_exist_yet() {
        let dir = sandbox("dest");
        let r = roots_of(&dir);
        let target = dir.join("inside/new/deeper/upload.bin");
        assert!(r.check(&target.to_string_lossy()).is_ok());
        let outside = dir.join("elsewhere/upload.bin");
        assert!(r.check(&outside.to_string_lossy()).is_err());
    }

    #[test]
    fn checks_the_archive_not_the_member() {
        let dir = sandbox("archive");
        fs::write(dir.join("inside/photos.zip"), b"PK").unwrap();
        let r = roots_of(&dir);
        // The member path is the archive's business, and archive.rs normalizes
        // it at index time — what matters here is that the zip itself is inside.
        let inner = format!("{}!../../etc/passwd", dir.join("inside/photos.zip").display());
        assert!(r.check(&inner).is_ok());
        // ...and that an archive OUTSIDE the roots is refused, member or not.
        fs::write(dir.join("outside.zip"), b"PK").unwrap();
        let out = format!("{}!a.txt", dir.join("outside.zip").display());
        assert!(r.check(&out).is_err());
    }

    #[test]
    fn rejects_relative_and_empty() {
        let dir = sandbox("relative");
        let r = roots_of(&dir);
        assert!(r.check("").is_err());
        assert!(r.check("inside/file.txt").is_err());
    }

    #[test]
    fn a_name_is_one_component() {
        assert!(check_name("notes.txt").is_ok());
        assert!(check_name("a b!c").is_ok());
        for bad in ["", ".", "..", "../etc", "a/b", "a\\b", "a\0b"] {
            assert!(check_name(bad).is_err(), "{bad:?} should be refused");
        }
    }

    #[test]
    fn check_pair_refuses_a_name_that_escapes() {
        let dir = sandbox("pair");
        let r = roots_of(&dir);
        let inside = dir.join("inside").to_string_lossy().into_owned();
        assert!(r.check_pair(&inside, Some("file.txt")).is_ok());
        assert!(r.check_pair(&inside, Some("../../etc/passwd")).is_err());
    }

    #[test]
    fn sftp_urls_pass_through() {
        let dir = sandbox("sftp");
        let r = roots_of(&dir);
        assert_eq!(r.check("sftp://user@host/srv/x").unwrap(), "sftp://user@host/srv/x");
    }
}
