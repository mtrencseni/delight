import { convertFileSrc, invoke as tauriInvoke } from "@tauri-apps/api/core";
import { isTauri, isWeb } from "./target";

export { isTauri };

/** Turn a path into a URL the page can load directly — used to embed PDFs in
 *  the preview via the browser's own PDF viewer, and to show images without
 *  routing their bytes through the command channel.
 *
 *  Under Tauri that's the asset protocol; in the web build it's the server's
 *  /api/file, which honours Range requests — so Chrome's PDF viewer can jump
 *  to page 400 of a big document without pulling the whole thing first. */
export function assetUrl(path: string, version?: number): string {
  if (isWeb) {
    // Imported lazily everywhere else in this file; here the URL is needed
    // synchronously, and the shape is trivial enough to spell out.
    const v = version ? `&v=${version}` : "";
    return `/api/file?path=${encodeURIComponent(path)}${v}`;
  }
  return convertFileSrc(path);
}

let mock: Promise<typeof import("./mock")> | null = null;
let web: Promise<typeof import("./web")> | null = null;

/** Invoke a backend command. Three backends answer one surface: Rust over IPC
 *  under Tauri, delight-server over HTTP in the web build, and an in-memory
 *  fake filesystem in plain `pnpm dev`. */
export function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri) return tauriInvoke<T>(cmd, args);
  if (isWeb) {
    web ??= import("./web");
    return web.then((m) => m.webInvoke<T>(cmd, args));
  }
  mock ??= import("./mock");
  return mock.then((m) => m.mockInvoke<T>(cmd, args));
}

/** Subscribe to a backend event. Tauri's event system, the server's SSE stream,
 *  or nothing at all (the mock emits none). */
export function onEvent<T>(name: string, cb: (payload: T) => void): void {
  if (isTauri) {
    void import("@tauri-apps/api/event").then((m) =>
      m.listen<T>(name, (e) => cb(e.payload))
    );
    return;
  }
  if (isWeb) {
    web ??= import("./web");
    void web.then((m) => m.webOnEvent<T>(name, cb));
  }
}
