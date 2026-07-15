// Platform detection. Keep this dependency-free — commands.ts imports it, and it
// must work in the browser mock as well as under Tauri.

const ua = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData;
const plat = ua?.platform ?? navigator.platform ?? "";

/** True on macOS. Drives the modifier key (⌘ vs Ctrl), the traffic-light inset
 *  in the integrated titlebar, and the shortcut labels. */
export const isMac = /mac/i.test(plat);

/** The primary shortcut modifier: ⌘ on macOS, Ctrl everywhere else. */
export const MOD = isMac ? "Meta" : "Ctrl";
