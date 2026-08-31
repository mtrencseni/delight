//! Delight's filesystem core: everything the app does that isn't a window.
//!
//! This crate was carved out of the Tauri app so a second host — the HTTP
//! server behind the web UI — could reuse it rather than reimplement it. The
//! split follows the line the app already had: the frontend asks, this answers,
//! and nothing here knows what a webview is.
//!
//! The read/write discipline from the Tauri days is unchanged and is the reason
//! this is worth having as one crate: **[`ops`] is the only module that
//! mutates the filesystem.** Everything else reads. A host that wants a
//! read-only deployment simply doesn't route to `ops`.
//!
//! What the host must supply is in [`env`]: the well-known directories, and
//! somewhere to send progress.

pub mod archive;
pub mod details;
pub mod env;
pub mod fs_cmds;
pub mod icons;
pub mod ops;
pub mod roots;
pub mod sftp;
pub mod smb;

pub use env::{silent, Emitter, Env, Sink};
