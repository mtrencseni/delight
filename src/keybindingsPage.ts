import {
  COMMANDS,
  COMMAND_GROUPS,
  comboFromEvent,
  comboLabel,
  MODIFIER_CODES,
  type CommandId,
} from "./commands";
import { icons } from "./icons";

export interface KeybindingsHooks {
  /** Current effective bindings: command id -> combo strings. */
  get(): Record<string, string[]>;
  /** Add a binding to a command, stealing it from any other command that has it. */
  add(id: CommandId, combo: string): void;
  /** Remove one binding from a command. */
  remove(id: CommandId, combo: string): void;
  /** The command currently bound to `combo`, if any (for the conflict hint). */
  owner(combo: string): CommandId | null;
  /** Restore every command to its default bindings. */
  reset(): void;
}

export interface KeybindingsPage {
  el: HTMLElement;
  /** Re-read state into the controls. */
  sync(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export function buildKeybindingsPage(hooks: KeybindingsHooks): KeybindingsPage {
  const root = el("div", "settings keybinds");
  const inner = el("div", "settings-inner");
  root.append(inner);

  const head = el("div", "kbhead");
  head.append(el("h1", "", "Keyboard shortcuts"));
  const reset = el("button", "kbreset", "Reset to defaults");
  reset.addEventListener("click", () => {
    hooks.reset();
    sync();
  });
  head.append(reset);
  inner.append(head);

  // Track the row currently recording so a second record cancels the first.
  let stopRecording: (() => void) | null = null;

  // Build one command row: label + its binding chips + a record button.
  const buildRow = (id: CommandId, label: string): HTMLElement => {
    const r = el("div", "setrow kbrow");
    r.dataset.cmd = id;
    const left = el("div", "setlabel");
    left.append(el("div", "setname", label));
    const combos = el("div", "kbcombos");
    r.append(left, combos);
    return r;
  };

  const rows = new Map<CommandId, HTMLElement>();
  for (const group of COMMAND_GROUPS) {
    const section = el("section", "setsection");
    section.append(el("h2", "", group));
    for (const cmd of COMMANDS.filter((c) => c.group === group)) {
      const row = buildRow(cmd.id, cmd.label);
      rows.set(cmd.id, row);
      section.append(row);
    }
    inner.append(section);
  }

  /** Render the chips + record button for one command from current state. */
  const paintRow = (id: CommandId): void => {
    const row = rows.get(id);
    if (!row) return;
    const combos = row.querySelector<HTMLElement>(".kbcombos")!;
    combos.replaceChildren();
    for (const combo of hooks.get()[id] ?? []) {
      const chip = el("span", "kbchip");
      chip.append(el("span", "kbchip-key", comboLabel(combo)));
      const x = el("button", "kbchip-x");
      x.innerHTML = icons.close;
      x.title = "Remove";
      x.addEventListener("click", () => {
        hooks.remove(id, combo);
        sync();
      });
      chip.append(x);
      combos.append(chip);
    }
    const rec = el("button", "kbadd", "＋");
    rec.title = "Record a shortcut";
    rec.addEventListener("click", () => startRecording(id, rec));
    combos.append(rec);
  };

  const startRecording = (id: CommandId, btn: HTMLButtonElement): void => {
    stopRecording?.(); // cancel any other in-flight recording
    btn.classList.add("recording");
    btn.textContent = "Press keys…";

    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.code === "Escape") {
        finish();
        return;
      }
      if (MODIFIER_CODES.has(e.code)) return; // wait for a real key
      const combo = comboFromEvent(e);
      finish();
      if (combo) {
        hooks.add(id, combo);
        sync();
      }
    };

    const finish = () => {
      window.removeEventListener("keydown", onKey, true);
      stopRecording = null;
      btn.classList.remove("recording");
      btn.textContent = "＋";
    };

    stopRecording = finish;
    // Capture phase so the app's global handler never sees the recorded keys.
    window.addEventListener("keydown", onKey, true);
  };

  function sync(): void {
    for (const cmd of COMMANDS) paintRow(cmd.id);
  }
  sync();

  return { el: root, sync };
}
