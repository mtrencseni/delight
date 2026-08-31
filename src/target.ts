// Which shell the frontend is running in. A platform seam in the sense
// ARCHITECTURE.md means it: every "am I in Tauri or a browser" branch reads
// from here, so `grep isWeb src/` finds all of them.
//
//   tauri — the desktop app. IPC to Rust, native menu, real drag-out.
//   web   — served BY delight-server. The filesystem being browsed is the
//           SERVER's; commands go over HTTP, progress over SSE.
//   mock  — plain `pnpm dev`. mock.ts is an in-memory fake filesystem.
//
// The web build is chosen at BUILD time (`vite build --mode web`), never
// sniffed: a bundle opened from the wrong place must not decide it owns a
// server session, and `pnpm dev` must keep getting the mock.
//
// Keep this dependency-free — platform.ts is, and this sits beside it.

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Built by `vite build --mode web` and served by delight-server. */
export const isWeb = !isTauri && import.meta.env.MODE === "web";

/** Plain `pnpm dev`: mock.ts stands in for the whole backend. */
export const isMock = !isTauri && !isWeb;

/** Any browser — i.e. no Rust process of our own, and no OS integration. */
export const isBrowser = !isTauri;
