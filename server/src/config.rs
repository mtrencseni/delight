//! Everything the server needs to know, read once from the environment.
//!
//! Same deployment shape as the Buffers server: a `.env` file sourced by
//! `run.sh`, no config format of its own, and a refusal to start rather than a
//! default that would come up open.

use crate::jail::Roots;
use delight_core::Env;
use std::path::PathBuf;

pub struct Config {
    /// The shared secret. A browser trades it once at /login for a cookie.
    pub token: String,
    pub roots: Roots,
    /// Refuse everything that mutates the filesystem — a way to deploy the
    /// browsing half while the write half is still settling.
    pub read_only: bool,
    pub port: u16,
    /// The built web UI (`pnpm build:web`, installed by build-web.sh).
    pub web_dir: PathBuf,
    /// Where the frontend's own state blob lives. Outside the served roots on
    /// purpose: the app's settings are not one of the user's files.
    pub state_path: PathBuf,
    /// Drop `Secure` from the session cookie. Only for local http testing.
    pub insecure_cookie: bool,
    /// Well-known directories, as the core asks for them.
    pub env: Env,
    /// This machine's name, shown in the browser tab so several servers open in
    /// several tabs stay tellable apart.
    pub hostname: String,
}

/// The host's name. No crate for this: the server is Linux-only (it is the web
/// backend), /proc is authoritative there, and the env var is a fallback for
/// the odd container that lacks it.
fn hostname() -> String {
    std::fs::read_to_string("/proc/sys/kernel/hostname")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("HOSTNAME").ok())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "server".into())
}

fn flag(name: &str) -> bool {
    std::env::var_os(name).is_some_and(|v| !v.is_empty() && v != "0")
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let token = std::env::var("DELIGHT_TOKEN").unwrap_or_default();
        if token.is_empty() {
            return Err("DELIGHT_TOKEN is not set — refusing to start unauthenticated".into());
        }
        let env = Env::from_process();

        // Default: the home directory of whoever is running the server. It is
        // the least surprising answer, and it is not "/" — a file manager on a
        // public hostname should have to be told to serve the whole disk.
        let roots = match std::env::var("DELIGHT_ROOTS") {
            Ok(spec) if !spec.trim().is_empty() => spec
                .split(':')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(PathBuf::from)
                .collect(),
            _ => vec![env
                .home
                .clone()
                .ok_or("no home directory, and DELIGHT_ROOTS is not set")?],
        };
        let roots = Roots::new(roots)?;

        let here = std::env::current_dir().map_err(|e| e.to_string())?;
        Ok(Config {
            token,
            roots,
            read_only: flag("DELIGHT_READ_ONLY"),
            port: std::env::var("PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(8070),
            web_dir: std::env::var_os("DELIGHT_WEB_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| here.join("web")),
            state_path: std::env::var_os("DELIGHT_STATE")
                .map(PathBuf::from)
                .unwrap_or_else(|| here.join("state.json")),
            insecure_cookie: flag("DELIGHT_INSECURE_COOKIE"),
            env,
            hostname: hostname(),
        })
    }
}
