// Modal dialogs for file operations: a yes/no confirm and a single-field prompt
// (rename / new folder). Keyboard-first — Enter confirms, Escape cancels — and
// the overlay swallows keydowns so global shortcuts don't fire underneath it.

function overlay(): HTMLElement {
  const o = document.createElement("div");
  o.className = "modal-overlay";
  return o;
}

interface ConfirmOpts {
  title: string;
  message: string;
  confirmLabel?: string;
  /** Style the confirm button as destructive (red). */
  danger?: boolean;
}

export function confirmDialog(opts: ConfirmOpts): Promise<boolean> {
  return new Promise((resolve) => {
    const o = overlay();
    const box = document.createElement("div");
    box.className = "modal";

    const title = document.createElement("div");
    title.className = "modal-title";
    title.textContent = opts.title;

    const msg = document.createElement("div");
    msg.className = "modal-msg";
    msg.textContent = opts.message;

    const row = document.createElement("div");
    row.className = "modal-actions";
    const cancel = document.createElement("button");
    cancel.className = "modal-btn";
    cancel.textContent = "Cancel";
    const ok = document.createElement("button");
    ok.className = "modal-btn primary" + (opts.danger ? " danger" : "");
    ok.textContent = opts.confirmLabel ?? "OK";
    row.append(cancel, ok);

    box.append(title, msg, row);
    o.append(box);
    document.body.append(o);

    const close = (result: boolean) => {
      o.remove();
      resolve(result);
    };
    cancel.addEventListener("click", () => close(false));
    ok.addEventListener("click", () => close(true));
    o.addEventListener("mousedown", (e) => {
      if (e.target === o) close(false);
    });
    o.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") close(false);
      else if (e.key === "Enter") close(true);
    });
    o.tabIndex = -1;
    ok.focus();
  });
}

/** The network protocols the connect dialog can build a path for. Each knows
    how to assemble its URL; nothing else in the dialog is protocol-aware. */
const PROTOCOLS = [
  {
    id: "smb",
    label: "SMB",
    blurb: "Windows / NAS file sharing",
    // A share is required to browse; smb://host alone lists the server's shares.
    pathLabel: "Share and folder",
    pathHint: "media/photos",
    usesPort: false,
  },
  {
    id: "sftp",
    label: "SFTP",
    blurb: "Files over SSH (ssh:// works too)",
    pathLabel: "Folder",
    pathHint: "/home/you  — blank for your login directory",
    usesPort: true,
  },
] as const;

interface ConnectOpts {
  /** Recent remote paths, newest first — the fastest way back to a server. */
  recents: string[];
}

/** Build a network path (smb:// or sftp://). Resolves to the path, or null on
    cancel. It only ever RETURNS a path — connecting is the caller's job, so
    every route into a server goes through the same navigate(). */
export function connectDialog(opts: ConnectOpts): Promise<string | null> {
  return new Promise((resolve) => {
    const o = overlay();
    const box = document.createElement("div");
    box.className = "modal modal-connect";

    const title = document.createElement("div");
    title.className = "modal-title";
    title.textContent = "Connect to a server";
    box.append(title);

    // Protocol picker.
    let proto: (typeof PROTOCOLS)[number] = PROTOCOLS[0];
    const seg = document.createElement("div");
    seg.className = "seg";
    const segBtns = new Map<string, HTMLButtonElement>();
    for (const p of PROTOCOLS) {
      const b = document.createElement("button");
      b.textContent = p.label;
      b.title = p.blurb;
      b.addEventListener("click", () => {
        proto = p;
        sync();
      });
      segBtns.set(p.id, b);
      seg.append(b);
    }
    box.append(seg);

    const blurb = document.createElement("div");
    blurb.className = "modal-msg";
    box.append(blurb);

    const field = (label: string, placeholder = "") => {
      const wrap = document.createElement("label");
      wrap.className = "connect-field";
      const cap = document.createElement("span");
      cap.textContent = label;
      const input = document.createElement("input");
      input.className = "modal-input";
      input.spellcheck = false;
      input.autocomplete = "off";
      input.placeholder = placeholder;
      input.addEventListener("input", () => {
        err.textContent = "";
        input.classList.remove("bad");
        syncPreview();
      });
      wrap.append(cap, input);
      box.append(wrap);
      return { wrap, input, cap };
    };

    const host = field("Server", "nas  ·  192.168.1.10  ·  example.com");
    const user = field("User name (optional)");
    const port = field("Port (optional)", "22");
    const path = field("Folder");

    // What the dialog will hand back — shown live, so there's no mystery about
    // what "Connect" is going to do.
    const preview = document.createElement("div");
    preview.className = "connect-preview";
    box.append(preview);

    const err = document.createElement("div");
    err.className = "modal-err";
    box.append(err);

    // Recents: one click reconnects, which is the common case.
    if (opts.recents.length) {
      const head = document.createElement("div");
      head.className = "connect-recents-head";
      head.textContent = "Recent";
      box.append(head);
      const list = document.createElement("div");
      list.className = "connect-recents";
      for (const r of opts.recents.slice(0, 6)) {
        const item = document.createElement("button");
        item.className = "connect-recent";
        item.textContent = r;
        item.title = r;
        item.addEventListener("click", () => close(r));
        list.append(item);
      }
      box.append(list);
    }

    const row = document.createElement("div");
    row.className = "modal-actions";
    const cancel = document.createElement("button");
    cancel.className = "modal-btn";
    cancel.textContent = "Cancel";
    const ok = document.createElement("button");
    ok.className = "modal-btn primary";
    ok.textContent = "Connect";
    row.append(cancel, ok);
    box.append(row);
    o.append(box);
    document.body.append(o);

    /** Assemble the URL from the fields. Empty host ⇒ null (nothing to build). */
    const build = (): string | null => {
      const h = host.input.value.trim().replace(/^\/+|\/+$/g, "");
      if (!h) return null;
      const u = user.input.value.trim();
      const p = path.input.value.trim().replace(/^\/+/, "");
      const authority = (u ? `${u}@` : "") + h;
      if (proto.id === "smb") {
        return `smb://${authority}${p ? `/${p}` : ""}`;
      }
      const portNum = port.input.value.trim();
      // An SFTP path is absolute on the remote; blank means "login directory".
      return `sftp://${authority}${portNum ? `:${portNum}` : ""}${p ? `/${p}` : ""}`;
    };

    const syncPreview = () => {
      const built = build();
      // Before a server is typed there's no URL to show, but a blank (or worse,
      // "…") box explains nothing. Show the scheme you're about to build in —
      // it's the true prefix of the result, and it names the protocol.
      preview.textContent = built ?? `${proto.id}://`;
      preview.classList.toggle("partial", !built);
    };

    function sync(): void {
      for (const [id, b] of segBtns) b.classList.toggle("on", id === proto.id);
      blurb.textContent = proto.blurb;
      port.wrap.style.display = proto.usesPort ? "" : "none";
      path.cap.textContent = proto.pathLabel;
      path.input.placeholder = proto.pathHint;
      syncPreview();
    }

    const close = (result: string | null) => {
      o.remove();
      resolve(result);
    };
    const submit = () => {
      const built = build();
      if (!built) {
        err.textContent = "A server name is required";
        host.input.classList.add("bad");
        host.input.focus();
        return;
      }
      close(built);
    };
    cancel.addEventListener("click", () => close(null));
    ok.addEventListener("click", submit);
    o.addEventListener("mousedown", (e) => {
      if (e.target === o) close(null);
    });
    o.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") close(null);
      else if (e.key === "Enter") submit();
    });

    sync();
    host.input.focus();
  });
}

interface CredentialOpts {
  title: string;
  /** Extra line under the title — which server, or why the last attempt failed. */
  message?: string;
  /** Pre-filled user name (from a smb://user@host path, or the last attempt). */
  user?: string;
}

/** Two-field sign-in dialog (SMB servers): user name + masked password.
    Resolves null on cancel. The password goes straight to the sign-in call —
    nothing here stores it. */
export function credentialsDialog(
  opts: CredentialOpts
): Promise<{ user: string; password: string } | null> {
  return new Promise((resolve) => {
    const o = overlay();
    const box = document.createElement("div");
    box.className = "modal";

    const title = document.createElement("div");
    title.className = "modal-title";
    title.textContent = opts.title;
    box.append(title);

    if (opts.message) {
      const msg = document.createElement("div");
      msg.className = "modal-msg";
      msg.textContent = opts.message;
      box.append(msg);
    }

    const userInput = document.createElement("input");
    userInput.className = "modal-input";
    userInput.placeholder = "User name";
    userInput.value = opts.user ?? "";
    const passInput = document.createElement("input");
    passInput.className = "modal-input";
    passInput.type = "password";
    passInput.placeholder = "Password";

    const err = document.createElement("div");
    err.className = "modal-err";

    const row = document.createElement("div");
    row.className = "modal-actions";
    const cancel = document.createElement("button");
    cancel.className = "modal-btn";
    cancel.textContent = "Cancel";
    const ok = document.createElement("button");
    ok.className = "modal-btn primary";
    ok.textContent = "Sign in";
    row.append(cancel, ok);
    box.append(userInput, passInput, err, row);
    o.append(box);
    document.body.append(o);

    const close = (result: { user: string; password: string } | null) => {
      o.remove();
      resolve(result);
    };
    const submit = () => {
      const user = userInput.value.trim();
      if (!user) {
        err.textContent = "A user name is required";
        userInput.classList.add("bad");
        return;
      }
      close({ user, password: passInput.value });
    };
    cancel.addEventListener("click", () => close(null));
    ok.addEventListener("click", submit);
    userInput.addEventListener("input", () => {
      err.textContent = "";
      userInput.classList.remove("bad");
    });
    o.addEventListener("mousedown", (e) => {
      if (e.target === o) close(null);
    });
    o.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") close(null);
      else if (e.key === "Enter") submit();
    });

    (opts.user ? passInput : userInput).focus();
  });
}

interface PromptOpts {
  title: string;
  value?: string;
  placeholder?: string;
  confirmLabel?: string;
  /** Pre-select the name without its extension (Finder-style rename). */
  selectStem?: boolean;
  /** Mask the input (archive passwords). */
  password?: boolean;
  /** Extra line under the title, e.g. which archive is being unlocked. */
  message?: string;
  /** Return an error string to block confirmation, or null when valid. */
  validate?: (value: string) => string | null;
}

export function promptDialog(opts: PromptOpts): Promise<string | null> {
  return new Promise((resolve) => {
    const o = overlay();
    const box = document.createElement("div");
    box.className = "modal";

    const title = document.createElement("div");
    title.className = "modal-title";
    title.textContent = opts.title;

    const input = document.createElement("input");
    input.className = "modal-input";
    input.type = opts.password ? "password" : "text";
    input.value = opts.value ?? "";
    if (opts.placeholder) input.placeholder = opts.placeholder;

    const err = document.createElement("div");
    err.className = "modal-err";

    const row = document.createElement("div");
    row.className = "modal-actions";
    const cancel = document.createElement("button");
    cancel.className = "modal-btn";
    cancel.textContent = "Cancel";
    const ok = document.createElement("button");
    ok.className = "modal-btn primary";
    ok.textContent = opts.confirmLabel ?? "OK";
    row.append(cancel, ok);

    if (opts.message) {
      const msg = document.createElement("div");
      msg.className = "modal-msg";
      msg.textContent = opts.message;
      box.append(title, msg, input, err, row);
    } else {
      box.append(title, input, err, row);
    }
    o.append(box);
    document.body.append(o);

    const close = (result: string | null) => {
      o.remove();
      resolve(result);
    };
    const submit = () => {
      const v = input.value;
      const msg = opts.validate?.(v) ?? null;
      if (msg) {
        err.textContent = msg;
        input.classList.add("bad");
        return;
      }
      close(v);
    };
    cancel.addEventListener("click", () => close(null));
    ok.addEventListener("click", submit);
    input.addEventListener("input", () => {
      err.textContent = "";
      input.classList.remove("bad");
    });
    o.addEventListener("mousedown", (e) => {
      if (e.target === o) close(null);
    });
    o.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") close(null);
      else if (e.key === "Enter") submit();
    });

    input.focus();
    // Finder-style: select the stem (name without extension) for a quick retype.
    const val = input.value;
    const dot = val.lastIndexOf(".");
    if (opts.selectStem && dot > 0) input.setSelectionRange(0, dot);
    else input.select();
  });
}
