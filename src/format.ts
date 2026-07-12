export function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

const THIRTY_MIN = 30 * 60 * 1000;

/** Modified within the last 30 minutes (the "Just now" tier). */
function isJustNow(ms: number): boolean {
  const dt = Date.now() - ms;
  return dt >= 0 && dt < THIRTY_MIN;
}

export function fmtDate(ms: number | null): string {
  if (ms == null) return "";
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, "0");
  const time = `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (isJustNow(ms)) return `Now at ${time}`;
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const DAY = 86400000;
  if (ms >= startOfToday && ms < startOfToday + DAY) return `Today at ${time}`;
  if (ms >= startOfToday - DAY && ms < startOfToday) return `Yesterday at ${time}`;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} at ${time}`;
}

/** Compact date for the narrow chip tiles: "Today", "Yesterday", "May 30",
    or "May 30, 2026" when the year differs from now. */
export function fmtDateCompact(ms: number | null): string {
  if (ms == null) return "—";
  const d = new Date(ms);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const DAY = 86400000;
  if (ms >= startOfToday && ms < startOfToday + DAY) return "Today";
  if (ms >= startOfToday - DAY && ms < startOfToday) return "Yesterday";
  const opts: Intl.DateTimeFormatOptions =
    d.getFullYear() === now.getFullYear()
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" };
  return d.toLocaleDateString(undefined, opts);
}

export function recency(ms: number | null): "justnow" | "today" | "yesterday" | null {
  if (ms == null) return null;
  if (isJustNow(ms)) return "justnow";
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const DAY = 86400000;
  if (ms >= start && ms < start + DAY) return "today";
  if (ms >= start - DAY && ms < start) return "yesterday";
  return null;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
