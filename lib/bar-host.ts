// Keeps an empty container as the first child of the sidebar footer (above
// the icon row) and publishes it to the store; the app overlay portals the
// one-line bar into it. Also runs the usage refresh loop.
//
// Layout cost: DOM mutations only trigger cheap structural work (find the
// footer, re-insert the container, read the collapsed attribute). The
// footer's width comes from a ResizeObserver on the footer itself, which
// reports after layout, so no mutation forces a synchronous layout flush.
import { refreshUsage, setBarHost } from "./usage-store";

const REFRESH_MS = 5 * 60_000;
export const BAR_HOST_ID = "usage-pace-bar-host";
const FOOTER_SELECTOR = 'div[data-sidebar="footer"]';
/** Narrower than this, the footer is the collapsed icon rail: hide the bar. */
const MIN_FOOTER_WIDTH = 120;

function borderBoxWidth(entry: ResizeObserverEntry): number {
  const box = entry.borderBoxSize?.[0];
  return box !== undefined
    ? box.inlineSize
    : entry.target.getBoundingClientRect().width;
}

export function mountBarHost({ signal }: { signal: AbortSignal }) {
  const host = document.createElement("div");
  host.id = BAR_HOST_ID;
  host.style.minWidth = "0";

  let footer: Element | null = null;
  // Unknown until the footer's first resize notification, which arrives
  // after layout and before paint.
  let narrow = false;

  const render = () => {
    if (footer === null) return;
    const collapsed =
      narrow || footer.closest('[data-state="collapsed"]') !== null;
    const display = collapsed ? "none" : "block";
    if (host.style.display !== display) host.style.display = display;
  };

  const resize = new ResizeObserver((entries) => {
    if (signal.aborted) return;
    let changed = false;
    for (const entry of entries) {
      if (entry.target !== footer) continue;
      narrow = borderBoxWidth(entry) < MIN_FOOTER_WIDTH;
      changed = true;
    }
    if (changed) render();
  });

  const attach = () => {
    if (signal.aborted) return;
    const next = document.querySelector(FOOTER_SELECTOR);
    if (next !== footer) {
      if (footer !== null) resize.unobserve(footer);
      footer = next;
      narrow = false;
      if (footer !== null) resize.observe(footer);
    }
    if (footer === null) {
      host.remove();
      setBarHost(null);
      return;
    }
    render();
    if (host.parentElement !== footer || footer.firstChild !== host) {
      footer.insertBefore(host, footer.firstChild);
    }
    setBarHost(host);
  };
  attach();
  const observer = new MutationObserver(attach);
  observer.observe(document.body, { childList: true, subtree: true });

  let timer: number | null = null;
  const schedule = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    if (signal.aborted || document.visibilityState !== "visible") return;
    timer = window.setTimeout(() => {
      void refreshUsage({ signal });
      schedule();
    }, REFRESH_MS);
  };
  const onVisibility = () => {
    if (document.visibilityState === "visible") void refreshUsage({ signal });
    schedule();
  };
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("focus", onVisibility);
  void refreshUsage({ signal });
  schedule();

  return () => {
    observer.disconnect();
    resize.disconnect();
    footer = null;
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("focus", onVisibility);
    if (timer !== null) window.clearTimeout(timer);
    setBarHost(null);
    host.remove();
  };
}
