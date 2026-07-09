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

export function fmtDate(ms: number | null): string {
  if (ms == null) return "";
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, "0");
  const time = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const DAY = 86400000;
  if (ms >= startOfToday && ms < startOfToday + DAY) return `Today at ${time}`;
  if (ms >= startOfToday - DAY && ms < startOfToday) return `Yesterday at ${time}`;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${time}`;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
