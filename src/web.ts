// The web build's backend: the same command surface Rust implements, spoken to
// delight-server over HTTP.
//
// Same-origin is what makes this cheap. The server that holds the files also
// served this page, so fetch() needs no CORS and no configured URL, and the
// browser attaches the session cookie by itself. The cookie is HttpOnly, so
// nothing here can read the credential it is using — which is the point.
//
// What the frontend calls `invoke` becomes one POST; what it calls `onEvent`
// becomes one EventSource. Nothing else in the app changes.

/** Set once a call comes back 401. main.ts acts on it at BOOT only (redirect to
    /login, nothing to lose yet); mid-session it surfaces as an ordinary error,
    because throwing a browser off a live pane to fix a background poll is the
    worse trade. */
export let authExpired = false;

async function post<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw "cannot reach the server";
  }
  if (res.status === 401) {
    authExpired = true;
    throw "not signed in — reload the page to sign in again";
  }
  if (!res.ok) {
    // The server reports failures as {error} with the same strings Tauri's
    // Result<_, String> produced, so the UI's error paths are unchanged.
    let detail = "";
    try {
      detail = ((await res.json()) as { error?: string }).error ?? "";
    } catch {
      /* a non-JSON error body says nothing useful */
    }
    throw detail || `HTTP ${res.status}`;
  }
  return (await res.json()) as T;
}

export function webInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return post<T>("/api/invoke", { cmd, args: args ?? {} });
}

/** One EventSource, shared by every subscriber, opened on first use. The server
    sends `{event, payload}` frames so this can fan out by name exactly the way
    Tauri's listen() does. */
let source: EventSource | null = null;
const listeners = new Map<string, ((payload: unknown) => void)[]>();

export function webOnEvent<T>(name: string, cb: (payload: T) => void): void {
  listeners.set(name, [...(listeners.get(name) ?? []), cb as (p: unknown) => void]);
  if (source) return;
  source = new EventSource("/api/events");
  source.onmessage = (e) => {
    try {
      const frame = JSON.parse(e.data) as { event: string; payload: unknown };
      for (const fn of listeners.get(frame.event) ?? []) fn(frame.payload);
    } catch {
      /* a frame we can't parse is a frame we can't route */
    }
  };
  // EventSource reconnects on its own; a progress stream that missed frames
  // heals on the next one, since each carries the current total.
}

/** Who the server is serving, or why it won't say. Called once at boot: only
    "unauth" justifies bouncing to /login — being offline must not. */
export async function whoami(): Promise<
  | { status: "ok"; roots: string[]; readOnly: boolean; hostname: string }
  | { status: "unauth" | "offline" }
> {
  try {
    const res = await fetch("/api/whoami");
    if (res.status === 401) {
      authExpired = true;
      return { status: "unauth" };
    }
    if (!res.ok) return { status: "offline" };
    const r = (await res.json()) as { roots: string[]; readOnly: boolean; hostname: string };
    return { status: "ok", roots: r.roots, readOnly: r.readOnly, hostname: r.hostname };
  } catch {
    return { status: "offline" };
  }
}

const q = encodeURIComponent;

/** A URL the browser can load a server-side file from directly — what the PDF
    preview and the image preview point at. `v` busts the cache when the file
    changes on disk (see the preview's signature poll). */
export function fileUrl(path: string, v?: number): string {
    return `/api/file?path=${q(path)}${v ? `&v=${v}` : ""}`;
}

/** Same file, as a download rather than something to render inline. */
export function downloadUrl(dir: string, name: string): string {
  return `/api/file?dir=${q(dir)}&name=${q(name)}&download=1`;
}

/** Several items, zipped into one download. Full paths, so a selection that
    spans folders (Delight expands subdirectories in place) works. */
export function zipUrl(paths: string[], filename: string): string {
  return `/api/zip?paths=${q(paths.join("\n"))}&filename=${q(filename)}`;
}

/** Send one file to the server, a chunk at a time so a big upload can report
    progress and resume rather than being one all-or-nothing request. */
export async function uploadFile(
  dir: string,
  file: File,
  onProgress?: (sent: number, total: number) => void,
  signal?: AbortSignal
): Promise<void> {
  const CHUNK = 8 * 1024 * 1024;
  let offset = 0;
  // A zero-byte file still needs one request, or nothing is created.
  do {
    const end = Math.min(offset + CHUNK, file.size);
    const last = end >= file.size;
    const res = await fetch(
      `/api/upload?dir=${q(dir)}&name=${q(file.name)}&offset=${offset}&last=${last}`,
      { method: "POST", body: file.slice(offset, end), signal }
    );
    if (!res.ok) throw (await res.text()) || `HTTP ${res.status}`;
    offset = end;
    onProgress?.(offset, file.size);
  } while (offset < file.size);
}
