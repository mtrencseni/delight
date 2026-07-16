import type { Location } from "./types";
import { icons } from "./icons";
import { baseName, displaySep, driveLetter, humanSize, isDriveRoot } from "./format";
import { state } from "./state";
import { invoke } from "./ipc";
import { cachedIconForPath, fetchIconForPath } from "./sysicons";

/** The single-pane mode's fixed left sidebar: the Favorites list, navigating the
    main pane. Drag to reorder, hover to remove, "Add current" to bookmark. */
export interface FavSidebarHost {
  locations(): Location[];
  /** The main pane's current directory (for the current-item highlight + "Add"). */
  currentPath(): string | null;
  navigate(path: string): void;
  addLocation(path: string, name: string): void;
  removeLocation(path: string): void;
  moveLocation(from: number, to: number): void;
  sysIcons(): boolean;
}

const el = (cls: string) => {
  const e = document.createElement("div");
  e.className = cls;
  return e;
};

export class FavSidebar {
  el = el("favsidebar");

  constructor(private host: FavSidebarHost) {
    this.render();
  }

  render(): void {
    const head = el("favhead");
    head.textContent = "Favorites";

    const list = el("favlist");
    const sys = this.host.sysIcons();
    const cur = this.host.currentPath();
    this.host.locations().forEach((loc, index) => {
      const item = el("locitem favitem" + (loc.path === cur ? " current" : ""));
      item.dataset.index = String(index);

      const grip = el("locgrip");
      grip.innerHTML = icons.grip;
      grip.title = "Drag to reorder";
      grip.addEventListener("click", (e) => e.stopPropagation());
      grip.addEventListener("mousedown", (e) => this.startDrag(e, item, index));

      const ic = el("ficon locicon");
      if (sys) {
        const c = cachedIconForPath(loc.path);
        if (c) this.setImg(ic, c);
        else {
          ic.innerHTML = icons.folder;
          void fetchIconForPath(loc.path).then((uri) => uri && ic.isConnected && this.setImg(ic, uri));
        }
      } else {
        ic.innerHTML = icons.folder;
      }
      // Badge the folder with its drive letter (Windows): `d:\xyz\abc` → "abc"
      // with a "D"; a drive root `c:\` → "\" with a "C" on the icon.
      const dl = driveLetter(loc.path);
      if (dl) ic.dataset.drive = dl;

      const label = document.createElement("span");
      label.className = "locname";
      const root = isDriveRoot(loc.path);
      label.textContent = root ? displaySep(state.settings.pathSep) : loc.name;
      label.title = loc.path;
      // For a drive root, show its free space beside the separator — smaller + gray.
      if (root) {
        void invoke<{ total: number; free: number } | null>("disk_space", { path: loc.path })
          .then((d) => {
            if (!d || !label.isConnected) return;
            label.textContent = displaySep(state.settings.pathSep);
            const free = document.createElement("span");
            free.className = "locfree";
            free.textContent = `(${humanSize(d.free)} free)`;
            label.append(free);
          })
          .catch(() => {});
      }

      const rm = document.createElement("button");
      rm.className = "locrm";
      rm.innerHTML = icons.close;
      rm.title = "Remove";
      rm.addEventListener("click", (e) => {
        e.stopPropagation();
        this.host.removeLocation(loc.path);
      });

      item.append(grip, ic, label, rm);
      item.addEventListener("click", () => this.host.navigate(loc.path));
      list.append(item);
    });

    const add = el("locadd favadd");
    add.innerHTML = `${icons.plus}<span>Add current</span>`;
    add.addEventListener("click", () => {
      const path = this.host.currentPath();
      if (!path) return;
      this.host.addLocation(path, baseName(path));
    });

    this.el.replaceChildren(head, list, add);
  }

  private setImg(ic: HTMLElement, uri: string): void {
    const img = new Image();
    img.alt = "";
    img.src = uri;
    ic.classList.add("sys");
    ic.replaceChildren(img);
  }

  /** Drag a favorite by its grip to reorder the (global) favorites list. */
  private startDrag(e: MouseEvent, item: HTMLElement, from: number): void {
    e.preventDefault();
    e.stopPropagation();
    const list = item.parentElement;
    if (!list) return;
    const items = () => [...list.querySelectorAll<HTMLElement>(".favitem")];
    const startY = e.clientY;
    let dragging = false;

    const onMove = (ev: MouseEvent) => {
      if (!dragging) {
        if (Math.abs(ev.clientY - startY) < 4) return;
        dragging = true;
        item.classList.add("dragging");
        document.body.classList.add("fav-dragging");
      }
      const sibs = items().filter((s) => s !== item);
      let ref: HTMLElement | null = null;
      for (const s of sibs) {
        const r = s.getBoundingClientRect();
        if (ev.clientY < r.top + r.height / 2) {
          ref = s;
          break;
        }
      }
      list.insertBefore(item, ref);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("fav-dragging");
      if (!dragging) return;
      const to = items().indexOf(item);
      if (to >= 0 && to !== from) this.host.moveLocation(from, to);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }
}
