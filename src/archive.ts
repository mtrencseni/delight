// Archive browsing, frontend side. Paths carry the archive boundary inline as
// `C:\x\foo.zip!sub/file.txt` (see src-tauri/src/archive.rs); the marker is an
// implementation detail, so everything user-facing goes through displayPath().

// The backend owns the real format list and hands it over at startup (see
// setArchiveFormats). These defaults only cover the window before that lands —
// and the browser mock, which has no backend. Keep them roughly in step with
// archive.rs, but the runtime values are what actually decide.
let zipExts = new Set([
  "zip", "jar", "war", "ear", "apk", "ipa", "xpi", "crx", "vsix", "whl", "nupkg",
  "epub", "docx", "xlsx", "pptx", "odt", "ods", "odp",
]);

/** Multi-part suffixes (tar containers and bare compressors), longest first so
    `.tar.gz` wins over `.gz`. */
let suffixes = [
  ".7z",
  ".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst",
  ".tgz", ".tbz", ".tbz2", ".txz", ".tzst",
  ".tar", ".gz", ".bz2", ".xz", ".zst",
];

/** Adopt the backend's authoritative format list, so adding a format in Rust
    can't leave the UI refusing to enter it. */
export function setArchiveFormats(f: { zipExts?: string[]; suffixes?: string[] }): void {
  if (f?.zipExts?.length) zipExts = new Set(f.zipExts.map((e) => e.toLowerCase()));
  if (f?.suffixes?.length) suffixes = f.suffixes.map((s) => s.toLowerCase());
}

/** The archive/inner-path boundary marker. */
export const MARK = "!";

export function isArchiveName(name: string): boolean {
  const n = name.toLowerCase();
  const i = n.lastIndexOf(".");
  if (i > 0 && zipExts.has(n.slice(i + 1))) return true;
  return suffixes.some((s) => n.endsWith(s));
}

/** True if `path` points inside an archive (mirrors Loc::parse in Rust: a bare
    "!" isn't a boundary unless the text before it looks like an archive). */
export function inArchive(path: string): boolean {
  return archiveSplit(path) !== null;
}

/** Split a path into [archive file, inner path], or null when it's an ordinary
    path. Archives don't nest, so the first qualifying marker wins. */
export function archiveSplit(path: string): [string, string] | null {
  for (let i = path.indexOf(MARK); i >= 0; i = path.indexOf(MARK, i + 1)) {
    if (isArchiveName(path.slice(0, i))) return [path.slice(0, i), path.slice(i + 1)];
  }
  return null;
}

/** The path as the user should see it: the marker becomes an ordinary separator,
    so `C:\x\foo.zip!sub\a.txt` reads as a plain path. The separator is taken from
    the archive's own path, so the result never mixes slash styles. */
export function displayPath(path: string): string {
  const split = archiveSplit(path);
  if (!split) return path;
  const [archive, inner] = split;
  const sep = archive.includes("\\") ? "\\" : "/";
  return inner ? archive + sep + inner.split("/").join(sep) : archive;
}

/** Backend sentinel meaning "encrypted, and I don't have a working password".
    Keep in sync with NEEDS_PASSWORD in src-tauri/src/archive.rs. */
export const NEEDS_PASSWORD = "__password_required";

export function needsPassword(err: unknown): boolean {
  return String(err).includes(NEEDS_PASSWORD);
}

/** The archive file a (path, child) pair refers to, or null when neither names
    one — used to key the password the user supplies. */
export function archiveFileFor(path: string, child?: string): string | null {
  const split = archiveSplit(path);
  if (split) return split[0];
  if (child && isArchiveName(child)) {
    const sep = path.includes("\\") ? "\\" : "/";
    return path.endsWith(sep) ? path + child : path + sep + child;
  }
  return null;
}

/** Archives the user dismissed the prompt for. Previews follow the cursor, so
    without this a declined prompt would reappear on every keystroke. Explicit
    actions (copy, navigate) pass force and ask again. */
const declined = new Set<string>();

/** Ask for an archive's password and hand it to the backend. Returns true when
    the caller should retry the operation. The password lives only in the
    backend's memory for this session — it's never written anywhere. */
export async function askArchivePassword(archiveFile: string, force = false): Promise<boolean> {
  if (!force && declined.has(archiveFile)) return false;
  const { promptDialog } = await import("./dialog");
  const { invoke } = await import("./ipc");
  const name = archiveFile.split(/[\\/]/).pop() || archiveFile;
  let message = `“${name}” is encrypted.`;
  // The backend rejects a password that doesn't actually decrypt, so a wrong
  // guess is never stored — keep asking until it works or the user gives up.
  for (;;) {
    const pw = await promptDialog({
      title: "Password required",
      message,
      placeholder: "Password",
      confirmLabel: "Unlock",
      password: true,
    });
    if (pw == null || pw === "") {
      declined.add(archiveFile);
      return false;
    }
    try {
      await invoke("set_archive_password", { path: archiveFile, password: pw });
      declined.delete(archiveFile);
      return true;
    } catch {
      message = `That password didn’t work for “${name}”. Try again.`;
    }
  }
}

/** Undo displayPath for a typed path: if a component names an archive and there's
    more after it, re-insert the marker so the backend sees the boundary. */
export function parseDisplayPath(input: string): string {
  if (archiveSplit(input)) return input; // already explicit
  const parts = input.split(/([\\/])/); // keep separators
  for (let i = 0; i < parts.length; i++) {
    if (!isArchiveName(parts[i])) continue;
    const head = parts.slice(0, i + 1).join("");
    const tail = parts
      .slice(i + 2) // skip the separator right after the archive
      .join("")
      .replace(/\\/g, "/");
    // Even with nothing after it, the marker is what makes the backend enter the
    // archive rather than try to list a file.
    return `${head}${MARK}${tail}`;
  }
  return input;
}
