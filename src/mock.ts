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
  Applications: d({ "Delight.app": d({}) }),
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
      locked: { dir: {}, denied: true, mtime: NOW - 99 * day },
      ".config": d({ "settings.toml": f(512, 12) }),
      ".ssh": d({ id_ed25519: f(411, 200), "id_ed25519.pub": f(98, 200) }),
      ".zshrc": f(1834, 20),
      ".gitconfig": f(310, 90),
      "todo.txt": f(842, 0),
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
      return undefined as T;

    case "fs_roots":
      return [{ name: SEP, path: SEP }] as T;
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
