import { archiveSplit, isArchiveName, MARK, NEEDS_PASSWORD } from "./archive";

// In-browser mock of the Rust commands, used only when running outside Tauri
// (plain `vite dev` in a browser). Lets the UI be developed and tested without
// the native shell. Mimics a macOS-like tree, including a 10k-entry dir, a
// permission-denied dir, symlinks and dotfiles.

interface MNode {
  dir?: Record<string, MNode>;
  size?: number;
  mtime: number;
  link?: string;
  denied?: boolean;
}

const NOW = Date.now();
const day = 86400000;

function d(children: Record<string, MNode>, ageDays = 10): MNode {
  return { dir: children, mtime: NOW - ageDays * day };
}
function f(size: number, ageDays = 5): MNode {
  return { size, mtime: NOW - ageDays * day };
}

const big: Record<string, MNode> = {};
for (let i = 0; i < 10000; i++) {
  big[`entry-${String(i).padStart(5, "0")}.dat`] = f(((i * 7919) % 5000000) + 128, i % 900);
}

const root: MNode = d({
  Applications: d({
    "Delight.app": d({ Contents: d({ "Info.plist": f(1024, 30), MacOS: d({ delight: f(4200000, 30) }) }) }),
    "Buffers.app": d({ Contents: d({ "Info.plist": f(1024, 30) }) }),
    "Safari.app": d({ Contents: d({ "Info.plist": f(2048, 120) }) }),
    Utilities: d({ "Terminal.app": d({}) }),
  }),
  System: d({ Library: d({}) }),
  tmp: d({}),
  Users: d({
    demo: d({
      Documents: d({
        "report-2026.pdf": f(1284034, 3),
        "notes.txt": f(2048, 1),
        "budget.xlsx": f(48211, 40),
        Archive: d({ "old.tar.gz": f(90210345, 400) }, 300),
      }),
      Downloads: d({
        "installer.dmg": f(224034011, 2),
        "photo.jpg": f(3902114, 9),
        "music.mp3": f(8203411, 30),
        "clip.mp4": f(52034110, 4),
        "backup.zip": f(9204411, 15),
        "secret.zip": f(4096, 2),
        "app.py": f(4102, 1),
        "setup.sh": f(1204, 6),
      }),
      Pictures: d({ "wallpaper.png": f(2450233, 60) }),
      Projects: d({
        delight: d({
          "README.md": f(1204, 0),
          src: d({ "main.ts": f(9204, 0) }),
        }),
      }),
      big: d(big, 1),
      Dropbox: d({ "shared.txt": f(1024, 2), Camera: d({}) }, 1),
      locked: { dir: {}, denied: true, mtime: NOW - 99 * day },
      ".config": d({ "settings.toml": f(512, 12) }),
      ".ssh": d({ id_ed25519: f(411, 200), "id_ed25519.pub": f(98, 200) }),
      ".zshrc": f(1834, 20),
      ".gitconfig": f(310, 90),
      "todo.txt": f(842, 0),
      "server.log": f(48000, 1),
      "scratch.rst": f(900, 1),
      "blob.bin": f(4096, 1),
      "archive.tar.gz": f(120423440, 200),
      "link-to-docs": { link: "/Users/demo/Documents", mtime: NOW - day },
      "broken-link": { link: "/Users/demo/missing", mtime: NOW - day },
    }),
  }),
});

const SEP = "/";
const HOME = "/Users/demo";

function segments(path: string): string[] {
  const out: string[] = [];
  for (const s of path.split(SEP)) {
    if (!s || s === ".") continue;
    if (s === "..") out.pop();
    else out.push(s);
  }
  return out;
}

function lookup(segs: string[], depth = 0): MNode | null {
  if (depth > 8) return null;
  let node = root;
  for (let i = 0; i < segs.length; i++) {
    if (node.link) {
      const target = lookup(segments(node.link), depth + 1);
      if (!target) return null;
      node = target;
    }
    if (!node.dir) return null;
    const next = node.dir[segs[i]];
    if (!next) return null;
    node = next;
  }
  return node;
}

function resolveLink(node: MNode, depth = 0): MNode | null {
  if (!node.link) return node;
  if (depth > 8) return null;
  const t = lookup(segments(node.link), depth);
  return t ? resolveLink(t, depth + 1) : null;
}

/** The `.dir` record of the folder at `path` (mutable), or null. */
function dirRecord(path: string): Record<string, MNode> | null {
  const node = lookup(segments(path));
  const resolved = node ? resolveLink(node) : null;
  return resolved?.dir ?? null;
}

function cloneNode(n: MNode): MNode {
  const c: MNode = { mtime: NOW };
  if (n.dir) c.dir = Object.fromEntries(Object.entries(n.dir).map(([k, v]) => [k, cloneNode(v)]));
  else c.size = n.size ?? 0;
  if (n.link) c.link = n.link;
  return c;
}

function dedupName(rec: Record<string, MNode>, name: string): string {
  const i = name.lastIndexOf(".");
  const [stem, ext] = i > 0 ? [name.slice(0, i), name.slice(i)] : [name, ""];
  let c = `${stem} copy${ext}`;
  let n = 2;
  while (rec[c]) c = `${stem} copy ${n++}${ext}`;
  return c;
}

function splitExt(name: string, isDir: boolean): { stem: string; ext: string | null } {
  if (isDir) return { stem: name, ext: null };
  const i = name.lastIndexOf(".");
  if (i <= 0) return { stem: name, ext: null };
  return { stem: name.slice(0, i), ext: name.slice(i + 1) };
}

function listDir(pathIn: string, child?: string | null) {
  let raw = pathIn.trim();
  if (raw === "~") raw = HOME;
  else if (raw.startsWith("~" + SEP)) raw = HOME + raw.slice(1);

  // Archive browsing: serve the synthetic contents so the UI can be exercised
  // without a zip decoder in the browser.
  const split = archiveSplit(raw);
  if (split) return listArchive(split[0], child ? `${split[1]}/${child}` : split[1]);
  if (child && isArchiveName(child)) return listArchive(raw === SEP ? SEP + child : raw + SEP + child, "");

  const segs = segments(raw);
  if (child) segs.push(child);
  const node = lookup(segs);
  if (!node) throw "No such folder";
  const target = resolveLink(node);
  if (!target) throw "No such folder";
  if (target.denied) throw "Permission denied";
  if (!target.dir) throw "Not a folder";

  const entries = Object.entries(target.dir).map(([name, n]) => {
    const isSymlink = !!n.link;
    const eff = resolveLink(n) ?? n;
    const isDir = !!eff.dir && !eff.denied ? true : !!eff.dir;
    const { stem, ext } = splitExt(name, isDir);
    return {
      name,
      stem,
      ext,
      isDir,
      isSymlink,
      size: isDir ? 0 : eff.size ?? 0,
      modifiedMs: n.mtime,
      createdMs: n.mtime - 12 * day,
      permissions: isSymlink ? "lrwxr-xr-x" : isDir ? "drwxr-xr-x" : "-rw-r--r--",
      hidden: name.startsWith("."),
    };
  });

  const path = SEP + segs.join(SEP);
  return {
    path: segs.length ? path : SEP,
    name: segs.length ? segs[segs.length - 1] : SEP,
    parent: segs.length ? (segs.length === 1 ? SEP : SEP + segs.slice(0, -1).join(SEP)) : null,
    entries,
  };
}

// Contents served for any archive entered in the mock. `null` marks a directory;
// "src/deep" is deliberately absent so the synthesized-parent path gets exercised
// the same way the Rust side synthesizes missing zip directory entries.
const ARCHIVE_CONTENT: Record<string, number | null> = {
  "readme.txt": 240,
  LICENSE: 1070,
  src: null,
  "src/main.ts": 3400,
  "src/util.ts": 1200,
  "src/deep/notes.md": 800,
};

// Any archive whose name contains "secret" behaves like an encrypted one: it
// lists fine (names are in the clear) but reads fail until a password is set.
// Lets the password prompt + retry be exercised in the browser harness.
const mockPasswords = new Set<string>();

function isLockedArchive(archivePath: string): boolean {
  return /secret/i.test(archivePath) && !mockPasswords.has(archivePath);
}

function archiveDirs(): Set<string> {
  const dirs = new Set<string>();
  for (const [p, size] of Object.entries(ARCHIVE_CONTENT)) {
    if (size === null) dirs.add(p);
    for (let i = p.indexOf("/"); i >= 0; i = p.indexOf("/", i + 1)) dirs.add(p.slice(0, i));
  }
  return dirs;
}

function listArchive(archivePath: string, inner: string) {
  const dir = inner.split("/").filter((s) => s && s !== ".").join("/");
  const dirs = archiveDirs();
  const seen = new Set<string>();
  const entries = [];
  for (const [p, size] of Object.entries(ARCHIVE_CONTENT)) {
    // Walk each member's ancestors so synthesized directories show up too.
    for (const cand of [p, ...[...dirs].filter((d) => p.startsWith(d + "/"))]) {
      const parent = cand.includes("/") ? cand.slice(0, cand.lastIndexOf("/")) : "";
      if (parent !== dir || seen.has(cand)) continue;
      seen.add(cand);
      const name = cand.slice(cand.lastIndexOf("/") + 1);
      const isDir = dirs.has(cand);
      const { stem, ext } = splitExt(name, isDir);
      entries.push({
        name,
        stem,
        ext,
        isDir,
        isSymlink: false,
        size: isDir ? 0 : (ARCHIVE_CONTENT[cand] ?? 0),
        modifiedMs: NOW - 20 * day,
        createdMs: null,
        permissions: null,
        hidden: name.startsWith("."),
      });
    }
  }
  const parent = dir
    ? archivePath + MARK + (dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "")
    : archivePath.slice(0, archivePath.lastIndexOf(SEP)) || SEP;
  return {
    path: archivePath + MARK + dir,
    name: dir ? dir.slice(dir.lastIndexOf("/") + 1) : archivePath.slice(archivePath.lastIndexOf(SEP) + 1),
    parent,
    entries,
    readOnly: true,
  };
}

export async function mockInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  switch (cmd) {
    case "list_dir":
      return listDir(String(args?.path ?? SEP), args?.child as string | null) as T;
    case "home_dir":
      return HOME as T;
    case "file_icon":
      return null as T; // no system icons in the browser mock
    case "open_path":
      console.log("[mock] open_path", args?.dir, args?.name);
      return undefined as T;
    case "quicklook":
      console.log("[mock] quicklook idx", args?.index, (args?.items as any[])?.map((i) => i.name));
      return undefined as T;
    case "quicklook_close":
    case "toggle_devtools":
    case "close_devtools":
      return undefined as T;
    case "item_details": {
      const dir = String(args?.dir ?? "");
      const name = (args?.name as string | null) ?? null;
      try {
        const l = listDir(dir, name); // succeeds only for directories
        const kids = l.entries
          .filter((e) => !e.hidden)
          .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
        return {
          createdMs: NOW - 40 * day,
          owner: "demo",
          appName: null,
          appPath: null,
          dirCount: kids.length,
          children: kids.slice(0, 9).map((e) => ({
            name: e.name,
            isDir: e.isDir,
            isSymlink: e.isSymlink,
            ext: e.ext,
          })),
        } as T;
      } catch {
        return {
          createdMs: NOW - 40 * day,
          owner: "demo",
          appName: "Preview",
          appPath: "/System/Applications/Preview.app",
          dirCount: null,
          children: [],
        } as T;
      }
    }
    case "file_thumbnail": {
      const nm = String(args?.name ?? args?.dir);
      const ext = nm.split(".").pop()?.toLowerCase() ?? "";
      // QuickLook only renders certain types; return null otherwise so the app can
      // fall back to the code preview (or a plain icon) — like the real backend.
      const IMG = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "pdf", "svg", "icns", "ico", "dmg"];
      if (!IMG.includes(ext)) return null as T;
      const hue = (nm.length * 57) % 360;
      const s = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='6' fill='hsl(${hue} 55% 50%)'/><text x='32' y='42' font-size='30' text-anchor='middle' fill='white' font-family='sans-serif'>${nm.slice(0, 1).toUpperCase()}</text></svg>`;
      return ("data:image/svg+xml," + encodeURIComponent(s)) as T;
    }

    case "read_text_file": {
      const name = String(args?.name ?? "");
      const asplit = archiveSplit(String(args?.dir ?? ""));
      if (asplit && isLockedArchive(asplit[0])) throw NEEDS_PASSWORD;
      const ext = name.split(".").pop()?.toLowerCase() ?? "";
      const maxBytes = Number(args?.maxBytes) || 10 * 1024;
      const BINARY = ["png","jpg","jpeg","gif","webp","bmp","heic","pdf","zip","gz","tar","tgz","bin","exe","dll","so","dylib","o","a","class","jar","mp3","mp4","mov","wav","dmg","xlsx","docx","ico","icns"];
      if (BINARY.includes(ext)) return { text: "", truncated: false, binary: true } as T;
      const full = mockText(name, ext);
      const truncated = full.length > maxBytes;
      return { text: truncated ? full.slice(0, maxBytes) : full, truncated, binary: false } as T;
    }

    case "copy_entries":
    case "move_entries": {
      const isMove = cmd === "move_entries";
      const dest = String(args?.dest ?? "");
      const destRec = dirRecord(dest);
      const done: string[] = [];
      const skipped: string[] = [];
      if (destRec) {
        for (const it of (args?.items ?? []) as { dir: string; name: string }[]) {
          // Copy-out of an archive: synthesize the extracted file/folder.
          const asplit = archiveSplit(it.dir);
          if (asplit) {
            if (isLockedArchive(asplit[0])) throw NEEDS_PASSWORD;
            if (isMove) { skipped.push(it.name); continue; }
            const root = [asplit[1], it.name].filter(Boolean).join("/");
            const dirs = archiveDirs();
            destRec[it.name] = dirs.has(root) ? d({}, 20) : f(ARCHIVE_CONTENT[root] ?? 0, 20);
            done.push(it.name);
            continue;
          }
          const srcRec = dirRecord(it.dir);
          if (!srcRec || !srcRec[it.name]) continue;
          const sameDir = it.dir === dest;
          let targetName = it.name;
          if (sameDir) {
            if (isMove) { skipped.push(it.name); continue; }
            targetName = dedupName(destRec, it.name);
          } else if (destRec[it.name] && !args?.overwrite) {
            skipped.push(it.name);
            continue;
          }
          destRec[targetName] = isMove && !sameDir ? srcRec[it.name] : cloneNode(srcRec[it.name]);
          if (isMove && !sameDir) delete srcRec[it.name];
          done.push(it.name);
        }
      }
      return { done, skipped, cancelled: false } as T;
    }
    case "cancel_op":
      return undefined as T;
    case "create_archive": {
      const destRec = dirRecord(String(args?.dest ?? ""));
      const items = (args?.items ?? []) as { dir: string; name: string }[];
      if (!destRec) throw "Destination is not a folder";
      if (!items.length) throw "Nothing to pack";
      // Same dedupe rule as the backend: name.zip, name-1.zip, …
      const stem = String(args?.name ?? "archive");
      let created = `${stem}.zip`;
      for (let i = 1; destRec[created]; i++) created = `${stem}-${i}.zip`;
      let bytes = 0;
      const done: string[] = [];
      for (const it of items) {
        const rec = dirRecord(it.dir);
        const node = rec?.[it.name];
        if (!node) continue;
        bytes += node.size ?? 1024;
        done.push(it.name);
      }
      destRec[created] = f(Math.max(1, Math.round(bytes / 2)), 0);
      return { done, skipped: [], cancelled: false, created } as T;
    }
    // The real backend is authoritative here; the mock just echoes the frontend
    // defaults so setArchiveFormats is exercised on the same code path.
    case "archive_formats":
      return { zipExts: [], suffixes: [] } as T;
    case "set_archive_password":
      // Mirror the backend: only a working password is accepted/stored.
      if (String(args?.password ?? "") !== "hunter2") throw "Wrong password";
      mockPasswords.add(String(args?.path ?? ""));
      return undefined as T;
    case "rename_entry": {
      const rec = dirRecord(String(args?.dir ?? ""));
      const name = String(args?.name ?? "");
      const t = String(args?.newName ?? "").trim();
      if (!rec || !rec[name]) throw "No longer exists";
      if (t !== name && rec[t]) throw `“${t}” already exists`;
      if (t && t !== name) {
        rec[t] = rec[name];
        delete rec[name];
      }
      return undefined as T;
    }
    case "create_folder": {
      const rec = dirRecord(String(args?.dir ?? ""));
      const t = String(args?.name ?? "").trim();
      if (!rec) throw "No such folder";
      if (rec[t]) throw `“${t}” already exists`;
      rec[t] = d({}, 0);
      return undefined as T;
    }
    case "trash_entries": {
      const done: string[] = [];
      for (const it of (args?.items ?? []) as { dir: string; name: string }[]) {
        const rec = dirRecord(it.dir);
        if (rec && rec[it.name]) {
          delete rec[it.name];
          done.push(it.name);
        }
      }
      return { done, skipped: [], cancelled: false } as T;
    }

    case "dir_signature": {
      const rec = dirRecord(String(args?.path ?? ""));
      if (!rec) return null as T;
      let acc = 0;
      let count = 0;
      for (const [name, node] of Object.entries(rec)) {
        count++;
        let h = 0;
        for (const c of name) h = (h * 131 + c.charCodeAt(0)) >>> 0;
        h = (h ^ (node.size ?? 0)) >>> 0;
        h = (h ^ (node.mtime & 0xffffffff)) >>> 0;
        acc = (acc + h) >>> 0;
      }
      return ((acc + count * 2654435761) >>> 0) as T;
    }

    case "fs_roots":
      // Two entries so the drive picker's list + keyboard nav can be exercised in
      // the browser harness (the real backend enumerates actual drives).
      return [
        { name: SEP, path: SEP },
        { name: "C:", path: "C:\\" },
        { name: "D:", path: "D:\\" },
      ] as T;
    case "dropbox_dir":
      return (HOME + "/Dropbox") as T;
    case "disk_space":
      // Fake a 512 GB volume with 137 GB free for the drive-usage readouts.
      return { total: 512 * 1e9, free: 137 * 1e9 } as T;
    case "dir_size": {
      // Fake a deterministic non-zero size so the Space-on-folder flow is testable.
      const p = String(args?.path ?? "");
      return (98_765_432 + p.length * 1_000_000) as T;
    }
    case "load_state": {
      const raw = localStorage.getItem("delight-state");
      return (raw ? JSON.parse(raw) : null) as T;
    }
    case "save_state":
      localStorage.setItem("delight-state", JSON.stringify(args?.state ?? null));
      return undefined as T;
    default:
      throw `unknown command ${cmd}`;
  }
}

/** Sample file contents for the browser mock, so the code preview has something
    syntax-highlightable to render per extension. */
function mockText(path: string, ext: string): string {
  const name = path.split("/").pop() ?? "file";
  switch (ext) {
    case "py":
      return `#!/usr/bin/env python3\n"""${name} — demo module."""\n\nimport sys\nfrom dataclasses import dataclass\n\n\n@dataclass\nclass Point:\n    x: float\n    y: float\n\n    def dist(self, other: "Point") -> float:\n        return ((self.x - other.x) ** 2 + (self.y - other.y) ** 2) ** 0.5\n\n\ndef main() -> int:\n    a, b = Point(0, 0), Point(3, 4)\n    print(f"distance = {a.dist(b):.2f}")  # 5.00\n    return 0\n\n\nif __name__ == "__main__":\n    sys.exit(main())\n`;
    case "sh":
      return `#!/usr/bin/env bash\nset -euo pipefail\n\n# ${name} — build helper\nROOT="$(cd "$(dirname "$0")" && pwd)"\n\nfor dir in "$ROOT"/src/*; do\n  if [[ -d "$dir" ]]; then\n    echo "building $(basename "$dir")..."\n    make -C "$dir" all\n  fi\ndone\n\necho "done."\n`;
    case "md":
    case "markdown":
      return `# ${name}\n\nA **read-only** preview rendered with _CodeMirror 6_ — the same engine\n[Buffers](https://example.com) uses.\n\n## Features\n\n- Line numbers and a minimap\n- Syntax highlighting\n- Selection, copy, and find (⌘F)\n\n> You can't edit here — this is a viewer.\n\n\`\`\`js\nconst answer = 42;\n\`\`\`\n`;
    case "json":
      return `{\n  "name": "${name}",\n  "version": "1.0.0",\n  "private": true,\n  "keywords": ["demo", "preview"],\n  "count": 3,\n  "nested": { "enabled": true, "ratio": 0.75 }\n}\n`;
    case "ts":
    case "tsx":
      return `// ${name}\nexport interface Point {\n  x: number;\n  y: number;\n}\n\nexport function dist(a: Point, b: Point): number {\n  return Math.hypot(a.x - b.x, a.y - b.y);\n}\n\nconst origin: Point = { x: 0, y: 0 };\nconsole.log(dist(origin, { x: 3, y: 4 })); // 5\n`;
    case "log": {
      const lines = [];
      for (let i = 1; i <= 800; i++) {
        const lvl = ["INFO", "WARN", "DEBUG", "ERROR"][i % 4];
        lines.push(`2026-07-14 10:${String(i % 60).padStart(2, "0")}:00 [${lvl}] request ${i} handled in ${i % 200}ms — GET /api/items/${i}`);
      }
      return lines.join("\n") + "\n";
    }
    case "tex":
      return `\\documentclass{article}\n\\usepackage{amsmath}\n\n\\title{${name}}\n\\begin{document}\n\\maketitle\n\nThe Gaussian integral:\n\\begin{equation}\n  \\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}.\n\\end{equation}\n\n\\end{document}\n`;
    default: {
      const lines = [];
      lines.push(`${name}`);
      lines.push("");
      lines.push("This is a plain-text preview rendered in a read-only CodeMirror view.");
      lines.push("It supports selection, copy, scrolling, find (Cmd-F), and a minimap.");
      lines.push("");
      for (let i = 1; i <= 40; i++) lines.push(`Line ${i}: the quick brown fox jumps over the lazy dog.`);
      return lines.join("\n") + "\n";
    }
  }
}
