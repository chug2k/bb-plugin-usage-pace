// Adds pace to bb's built-in usage card (the provider-usage plugin's sidebar
// footer card). That card is another plugin's React tree, so this content
// script only adds nodes to it and never changes the nodes React renders:
//   - an even-pace tick on each window's bar;
//   - a delta line under each row, shown on hover or keyboard focus.
//
// The card has no plugin attribute. It is found from its header
// (`[data-provider-usage-header]`); each window row is a button whose
// aria-label starts with the window label ("Weekly limit: 44% used. …").
// The selected provider tab and the "Usage machine: …" button tell which
// provider and host the rows belong to. Pace data comes from this plugin's
// own usage store, which reads the same bb usage limits.
import type { UsageProvider } from "../server";
import { describeDelta, paceForWindows, type Pace } from "./pace";
import { getUsageState, subscribeUsage } from "./usage-store";

const HEADER_SELECTOR = "[data-provider-usage-header]";
const TICK_ATTR = "data-usage-pace-tick";
const DELTA_ATTR = "data-usage-pace-delta";
const STYLE_ID = "usage-pace-card-style";
const MACHINE_PREFIX = "Usage machine: ";

const STYLE = `
[${TICK_ATTR}] {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  margin-left: -1px;
  border-radius: 1px;
  background: var(--sidebar-foreground, currentColor);
  opacity: 0.8;
  pointer-events: none;
}
[${DELTA_ATTR}] {
  display: none;
  grid-column: 1 / -1;
  text-align: right;
  line-height: 1.35;
  padding-top: 1px;
}
button:hover > [${DELTA_ATTR}],
button:focus-visible > [${DELTA_ATTR}] {
  display: block;
}
`;

export interface RowMatch {
  pace: Pace;
  usedPercent: number;
}

/**
 * The pace for one card row. `provider` and `machine` are the names the
 * card shows; either can be null when the card does not show it.
 */
export function matchRow(
  providers: readonly UsageProvider[],
  provider: string | null,
  machine: string | null,
  ariaLabel: string,
  now = Date.now(),
): RowMatch | null {
  const ok = providers.filter(
    (candidate) =>
      candidate.status === "ok" &&
      (provider === null || candidate.displayName === provider),
  );
  const onMachine = ok.filter(
    (candidate) => machine === null || candidate.hostName === machine,
  );
  // A host name that differs from the card's machine name still matches.
  for (const candidate of onMachine.length > 0 ? onMachine : ok) {
    const index = candidate.windows.findIndex((window) =>
      ariaLabel.startsWith(`${window.label}: `),
    );
    if (index === -1) continue;
    // The card can be newer than this plugin's cached snapshot: use its percent.
    const shown = /: (\d+(?:\.\d+)?)% used/u.exec(ariaLabel);
    const windows = candidate.windows.map((window, j) =>
      j === index && shown ? { ...window, usedPercent: Number(shown[1]) } : window,
    );
    const pace = paceForWindows(windows, now)[index];
    if (pace == null) return null;
    return { pace, usedPercent: windows[index]!.usedPercent };
  }
  return null;
}

function setText(element: HTMLElement, text: string) {
  if (element.textContent !== text) element.textContent = text;
}

function decorateRow(row: HTMLElement, match: RowMatch | null, now: number) {
  const grid = row.firstElementChild;
  // The bar is the second cell of the row grid: label, bar, percent, reset.
  const bar = grid?.children.item(1);
  let tick = bar?.querySelector<HTMLElement>(`[${TICK_ATTR}]`) ?? null;
  let delta = row.querySelector<HTMLElement>(`:scope > [${DELTA_ATTR}]`);

  if (match === null || !(bar instanceof HTMLElement) || grid === null) {
    tick?.remove();
    delta?.remove();
    return;
  }

  if (bar.style.position !== "relative") bar.style.position = "relative";
  if (tick === null) {
    tick = document.createElement("span");
    tick.setAttribute(TICK_ATTR, "");
    tick.setAttribute("aria-hidden", "true");
    bar.appendChild(tick);
  }
  const left = `${(match.pace.elapsedFraction * 100).toFixed(2)}%`;
  if (tick.style.left !== left) tick.style.left = left;

  if (delta === null) {
    delta = document.createElement("span");
    delta.setAttribute(DELTA_ATTR, "");
    delta.className = "text-2xs text-subtle-foreground tabular-nums";
    grid.after(delta);
  }
  const [first, second] = describeDelta(match.pace, match.usedPercent, now);
  setText(delta, `${first}\n${second}`);
  if (delta.style.whiteSpace !== "pre-line") delta.style.whiteSpace = "pre-line";
}

function decorateCard(header: Element, providers: readonly UsageProvider[], now: number) {
  const card = header.parentElement;
  if (card === null) return;
  const provider =
    header
      .querySelector('[role="tab"][aria-selected="true"]')
      ?.getAttribute("aria-label") ?? null;
  const machineLabel =
    header.querySelector(`[aria-label^="${MACHINE_PREFIX}"]`)?.getAttribute("aria-label") ??
    null;
  const machine = machineLabel?.slice(MACHINE_PREFIX.length) ?? null;
  for (const row of card.querySelectorAll<HTMLElement>("button[aria-expanded]")) {
    const label = row.getAttribute("aria-label");
    if (label === null) continue;
    decorateRow(row, matchRow(providers, provider, machine, label, now), now);
  }
}

export function mountCardPace({ signal }: { signal: AbortSignal }) {
  if (document.getElementById(STYLE_ID) === null) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  let frame: number | null = null;
  const run = () => {
    frame = null;
    if (signal.aborted) return;
    const providers = getUsageState().data?.providers ?? [];
    const now = Date.now();
    for (const header of document.querySelectorAll(HEADER_SELECTOR)) {
      decorateCard(header, providers, now);
    }
  };
  const schedule = () => {
    if (frame === null) frame = window.requestAnimationFrame(run);
  };

  // Our own writes also trigger the observer; `run` writes only on change,
  // so the second pass is a no-op.
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true });
  const unsubscribe = subscribeUsage(schedule);
  const minute = window.setInterval(schedule, 60_000);
  schedule();

  return () => {
    observer.disconnect();
    unsubscribe();
    window.clearInterval(minute);
    if (frame !== null) window.cancelAnimationFrame(frame);
    for (const node of document.querySelectorAll(`[${TICK_ATTR}], [${DELTA_ATTR}]`)) {
      node.remove();
    }
    document.getElementById(STYLE_ID)?.remove();
  };
}
