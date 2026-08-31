//! Process-wide state: the config, the progress fan-out, and the frontend's
//! own settings blob.

use crate::config::Config;
use delight_core::{Emitter, Sink};
use serde_json::Value;
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;

/// One frame on the event stream, shaped like Tauri's `(event, payload)` so the
/// frontend's `onEvent(name, cb)` needs no second concept.
#[derive(Clone, serde::Serialize)]
pub struct Frame {
    pub event: String,
    pub payload: Value,
}

/// Sends progress to every browser currently watching. Lossy on purpose: the
/// channel has a bounded backlog, and a listener that falls behind should skip
/// to the current percentage rather than replay a copy that already finished.
struct Broadcast(broadcast::Sender<Frame>);

impl Emitter for Broadcast {
    fn emit(&self, event: &str, payload: Value) {
        // An error here means nobody is listening, which is normal.
        let _ = self.0.send(Frame {
            event: event.to_string(),
            payload,
        });
    }
}

pub struct AppState {
    pub cfg: Config,
    pub events: broadcast::Sender<Frame>,
    /// Serializes the read-modify-write of the settings file.
    state_lock: Mutex<()>,
}

impl AppState {
    pub fn new(cfg: Config) -> Self {
        let (events, _) = broadcast::channel(256);
        AppState {
            cfg,
            events,
            state_lock: Mutex::new(()),
        }
    }

    /// Where a long operation reports to.
    pub fn sink(&self) -> Sink {
        Arc::new(Broadcast(self.events.clone()))
    }

    /// The frontend's state blob. Unreadable or corrupt reads as "no state" —
    /// the app then comes up on its defaults, which beats refusing to start.
    pub fn load_state(&self) -> Value {
        let _g = self.state_lock.lock().unwrap();
        std::fs::read_to_string(&self.cfg.state_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(Value::Null)
    }

    /// Write-then-rename, so a crash mid-write can't leave a truncated file —
    /// the same rule the desktop's settings.rs follows.
    pub fn save_state(&self, v: Value) -> Result<(), String> {
        let _g = self.state_lock.lock().unwrap();
        let path = &self.cfg.state_path;
        let tmp = path.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(&v).map_err(|e| e.to_string())?;
        std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, path).map_err(|e| e.to_string())
    }
}
