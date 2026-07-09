let el: HTMLElement | null = null;
let timer = 0;

export function toast(msg: string): void {
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    document.body.append(el);
  }
  el.textContent = msg;
  // Restart the transition even when already visible.
  el.classList.remove("show");
  void el.offsetWidth;
  el.classList.add("show");
  clearTimeout(timer);
  timer = window.setTimeout(() => el?.classList.remove("show"), 900);
}
