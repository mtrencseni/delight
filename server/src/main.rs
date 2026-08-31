//! Delight Commander, as an HTTP service.
//!
//! The desktop app puts a webview in front of `delight-core`; this puts a
//! browser in front of the same crate, so the filesystem being managed is the
//! *server's*. Everything interesting is elsewhere:
//!
//!   config.rs  what the environment says
//!   jail.rs    the one place a path from the browser is checked
//!   auth.rs    the shared token, and the cookie a browser trades it for
//!   rpc.rs     the command dispatcher — its match is the allowlist
//!   files.rs   the byte paths: preview, download, upload
//!
//! Serving the built frontend from here is not a convenience: the page and the
//! API share an origin, so the frontend can fetch() without CORS and the browser
//! attaches the session cookie by itself.

mod auth;
mod config;
mod files;
mod jail;
mod rpc;
mod state;

use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{sse, Html, IntoResponse, Redirect, Response, Sse};
use axum::routing::{get, post};
use axum::{Form, Json, Router};
use futures_util::stream::Stream;
use serde_json::{json, Value};
use state::AppState;
use std::sync::Arc;

type St = State<Arc<AppState>>;

/// Does this request carry either credential? Called at the top of every
/// protected handler rather than hidden in a layer — with a filesystem behind
/// it, "which routes are open" should be readable in one screen.
fn authed(st: &AppState, h: &HeaderMap) -> bool {
    let hdr = h.get("x-delight-token").and_then(|v| v.to_str().ok());
    if auth::header_ok(&st.cfg.token, hdr) {
        return true;
    }
    let cookie = h.get(header::COOKIE).and_then(|v| v.to_str().ok());
    auth::from_header(cookie).is_some_and(|c| auth::verify(&st.cfg.token, c))
}

fn deny() -> Response {
    (StatusCode::UNAUTHORIZED, Json(json!({"error": "unauthorized"}))).into_response()
}

// ---- the app shell ------------------------------------------------------------

async fn index(State(st): St, h: HeaderMap) -> Response {
    if !authed(&st, &h) {
        return Redirect::to("/login").into_response();
    }
    match std::fs::read_to_string(st.cfg.web_dir.join("index.html")) {
        Ok(body) => ([(header::CACHE_CONTROL, "no-cache")], Html(body)).into_response(),
        Err(_) => (
            StatusCode::NOT_FOUND,
            "No web build here — run server/build-web.sh.\n",
        )
            .into_response(),
    }
}

const LOGIN_HTML: &str = include_str!("login.html");

fn login_page(error: Option<&str>) -> Response {
    let body = LOGIN_HTML.replace(
        "<!--ERROR-->",
        &error.map_or(String::new(), |e| format!(r#"<p class="err">{e}</p>"#)),
    );
    let code = if error.is_some() {
        StatusCode::UNAUTHORIZED
    } else {
        StatusCode::OK
    };
    (code, Html(body)).into_response()
}

async fn login_form(State(st): St, h: HeaderMap) -> Response {
    if authed(&st, &h) {
        return Redirect::to("/").into_response();
    }
    login_page(None)
}

#[derive(serde::Deserialize)]
struct LoginBody {
    token: String,
}

async fn login_submit(State(st): St, Form(body): Form<LoginBody>) -> Response {
    // The token is long and random, so this isn't a rate limiter — it just makes
    // an automated guessing loop pointless to start.
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    if !auth::constant_time_eq(body.token.trim().as_bytes(), st.cfg.token.as_bytes()) {
        return login_page(Some("That token doesn’t match.")).into_response();
    }
    let cookie = auth::set_cookie(&auth::issue(&st.cfg.token), !st.cfg.insecure_cookie);
    ([(header::SET_COOKIE, cookie)], Redirect::to("/")).into_response()
}

async fn logout(State(st): St) -> Response {
    let cookie = auth::clear_cookie(!st.cfg.insecure_cookie);
    ([(header::SET_COOKIE, cookie)], Redirect::to("/login")).into_response()
}

async fn ping() -> Json<Value> {
    Json(json!({"ok": true}))
}

async fn whoami(State(st): St, h: HeaderMap) -> Response {
    if !authed(&st, &h) {
        return deny();
    }
    Json(json!({
        "roots": st.cfg.roots.list().iter().map(|p| p.to_string_lossy()).collect::<Vec<_>>(),
        "readOnly": st.cfg.read_only,
        "hostname": st.cfg.hostname,
    }))
    .into_response()
}

// ---- the command channel --------------------------------------------------------

#[derive(serde::Deserialize)]
struct Invoke {
    cmd: String,
    #[serde(default)]
    args: Value,
}

async fn invoke(State(st): St, h: HeaderMap, Json(body): Json<Invoke>) -> Response {
    if !authed(&st, &h) {
        return deny();
    }
    match rpc::dispatch(st, &body.cmd, body.args).await {
        Ok(v) => Json(v).into_response(),
        // The frontend's error path expects a string, exactly as Tauri's
        // Result<_, String> arrives — so failures read identically in both hosts.
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))).into_response(),
    }
}

/// Progress, as Server-Sent Events. Only `op-progress` travels here; the
/// desktop's other event (`ql-index`, Quick Look) is macOS-only.
async fn events(
    State(st): St,
    h: HeaderMap,
) -> Result<Sse<impl Stream<Item = Result<sse::Event, std::convert::Infallible>>>, Response> {
    if !authed(&st, &h) {
        return Err(deny());
    }
    let mut rx = st.events.subscribe();
    let stream = async_stream::stream! {
        loop {
            match rx.recv().await {
                Ok(frame) => {
                    if let Ok(data) = serde_json::to_string(&frame) {
                        yield Ok(sse::Event::default().data(data));
                    }
                }
                // Lagged: the browser missed frames of a progress bar. The next
                // one carries the current total, so there is nothing to recover.
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            }
        }
    };
    Ok(Sse::new(stream).keep_alive(sse::KeepAlive::default()))
}

#[tokio::main]
async fn main() {
    let cfg = match config::Config::from_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[delight-server] {e}");
            std::process::exit(1);
        }
    };
    let port = cfg.port;
    println!(
        "[delight-server] roots: {}",
        cfg.roots
            .list()
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    );
    if cfg.read_only {
        println!("[delight-server] read-only mode: file operations are refused");
    }
    let st = Arc::new(AppState::new(cfg));

    let app = Router::new()
        .route("/", get(index))
        .route("/login", get(login_form).post(login_submit))
        .route("/logout", post(logout))
        .route("/ping", get(ping))
        .route("/api/whoami", get(whoami))
        .route("/api/invoke", post(invoke))
        .route("/api/events", get(events))
        .route("/api/file", get(files::serve))
        .route("/api/zip", get(files::zip))
        .route("/api/upload", post(files::upload))
        .route("/assets/*path", get(files::asset))
        .route("/fonts/*path", get(files::asset))
        // Root-level by convention (browsers ask for /favicon.ico unprompted),
        // so they get explicit routes rather than a prefix.
        .route("/favicon.ico", get(files::asset))
        .route("/favicon.png", get(files::asset))
        .route("/apple-touch-icon.png", get(files::asset))
        .with_state(st);

    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind");
    println!("[delight-server] listening on http://{addr}");
    axum::serve(listener, app).await.expect("serve");
}
