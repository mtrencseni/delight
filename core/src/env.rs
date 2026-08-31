//! What the core needs from whoever is hosting it.
//!
//! The core does the filesystem work; it does not know whether a desktop window
//! or an HTTP server asked. Two things have to come from the host, because both
//! genuinely differ:
//!
//!   * **Well-known directories.** Tauri answers these from the OS's own APIs —
//!     the Desktop folder is localized, and Windows lets OneDrive redirect it,
//!     so `<home>/Desktop` is often simply the wrong place. The server has no
//!     such API and answers from the process's environment.
//!   * **Progress.** A long copy reports as it goes. The desktop pushes those
//!     through Tauri's event system to its own webview; the server broadcasts
//!     them over SSE to whichever browsers are listening.

use std::path::PathBuf;
use std::sync::Arc;

/// The host's answers for the directories the UI can jump to. Every field is
/// optional: a headless server may have no Desktop, and asking is not an error.
#[derive(Clone, Debug, Default)]
pub struct Env {
    pub home: Option<PathBuf>,
    pub desktop: Option<PathBuf>,
    /// Where this host keeps its own state file. Never inside the roots the
    /// user browses.
    pub config: Option<PathBuf>,
}

impl Env {
    /// The environment's own idea of the user, used by the server and by tests.
    /// `dirs`-free on purpose: HOME on unix, USERPROFILE on Windows, which is
    /// exactly what a service account has.
    pub fn from_process() -> Self {
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(PathBuf::from);
        Env {
            desktop: home.as_ref().map(|h| h.join("Desktop")).filter(|d| d.is_dir()),
            home,
            config: None,
        }
    }
}

/// Progress out of a long operation, addressed by the operation id the caller
/// minted. Implementations must not block: this is called from inside the copy
/// loop, up to ~20 times a second.
pub trait Emitter: Send + Sync + 'static {
    fn emit(&self, event: &str, payload: serde_json::Value);
}

/// Where progress goes. Cloneable and cheap, because every operation carries one.
pub type Sink = Arc<dyn Emitter>;

/// An emitter that drops everything — tests, and any caller that doesn't care.
pub struct Silent;

impl Emitter for Silent {
    fn emit(&self, _event: &str, _payload: serde_json::Value) {}
}

/// A [`Sink`] that discards progress.
pub fn silent() -> Sink {
    Arc::new(Silent)
}
