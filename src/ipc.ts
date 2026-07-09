import { invoke as tauriInvoke } from "@tauri-apps/api/core";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

let mock: Promise<typeof import("./mock")> | null = null;

/** Invoke a Rust command; outside Tauri (plain browser dev) a mock FS answers. */
export function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri) return tauriInvoke<T>(cmd, args);
  mock ??= import("./mock");
  return mock.then((m) => m.mockInvoke<T>(cmd, args));
}

/** Subscribe to a backend event. No-op outside Tauri (the mock emits nothing). */
export function onEvent<T>(name: string, cb: (payload: T) => void): void {
  if (!isTauri) return;
  void import("@tauri-apps/api/event").then((m) =>
    m.listen<T>(name, (e) => cb(e.payload))
  );
}
