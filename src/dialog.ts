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

interface PromptOpts {
  title: string;
  value?: string;
  placeholder?: string;
  confirmLabel?: string;
  /** Pre-select the name without its extension (Finder-style rename). */
  selectStem?: boolean;
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
    input.type = "text";
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

    box.append(title, input, err, row);
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
