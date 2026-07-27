// Archive browsing, frontend side. Paths carry the archive boundary inline as
// `C:\x\foo.zip!sub/file.txt` (see src-tauri/src/archive.rs); the marker is an
// implementation detail, so everything user-facing goes through displayPath().

/** Single extensions browsable as a zip container. Keep in sync with ZIP_EXTS in
    src-tauri/src/archive.rs — the family is broad because .docx/.apk/.jar and
    friends are all zip containers. */
const ZIP_EXTS = new Set([
  "zip", "jar", "war", "ear", "apk", "ipa", "xpi", "crx", "vsix", "whl", "nupkg",
  "epub", "docx", "xlsx", "pptx", "odt", "ods", "odp",
]);

/** Multi-part suffixes (tar containers and bare compressors), longest first so
    `.tar.gz` wins over `.gz`. Keep in sync with SUFFIXES in archive.rs. */
const SUFFIXES = [
  ".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst",
  ".tgz", ".tbz", ".tbz2", ".txz", ".tzst",
  ".tar", ".gz", ".bz2", ".xz", ".zst",
];

/** The archive/inner-path boundary marker. */
export const MARK = "!";

export function isArchiveName(name: string): boolean {
  const n = name.toLowerCase();
  const i = n.lastIndexOf(".");
  if (i > 0 && ZIP_EXTS.has(n.slice(i + 1))) return true;
  return SUFFIXES.some((s) => n.endsWith(s));
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
