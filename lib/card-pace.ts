// Adds pace to bb's built-in usage card (the provider-usage plugin's sidebar
// footer card). That card is another plugin's React tree, so this content
// script only adds nodes to it and never changes the nodes React renders:
//   - an even-pace tick on each window's bar, and a band between the used
//     percent and that tick: red when ahead of pace, faint when under it;
//   - a delta line under each row, shown on hover or keyboard focus.
//
// The card has no plugin attribute. It is found from its header
// (`[data-provider-usage-header]`); each window row is a button whose
// aria-label starts with the window label ("Weekly limit: 44% used. …").
// The selected provider tab and the "Usage machine: …" button tell which
// provider and machine the rows belong to.
//
// The data comes from the card's own RPC, so labels and numbers are the ones
// the card shows. `maxAgeMs` lets that plugin answer from its cache.
import { describeDelta, paceForWindows, type Pace, type PaceInput } from "./pace";

const HEADER_SELECTOR = "[data-provider-usage-header]";
const TICK_ATTR = "data-usage-pace-tick";
/** The part of the bar between the used percent and even pace. */
const BAND_ATTR = "data-usage-pace-band";
const DELTA_ATTR = "data-usage-pace-delta";
const STYLE_ID = "usage-pace-card-style";
const MACHINE_PREFIX = "Usage machine: ";
const CARD_RPC_URL = "/api/v1/plugins/provider-usage/rpc/getUsage";
const CARD_MAX_AGE_MS = 5 * 60_000;
const REFETCH_MS = 60_000;

const STYLE = `
[${TICK_ATTR}] {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  margin-left: -1px;
  border-radius: 1px;
  background: var(--sidebar-foreground, currentColor);
  /* An edge in the card colour keeps the tick visible on the fill too. */
  box-shadow: 0 0 0 1px var(--sidebar, #fff);
  pointer-events: none;
}
[${BAND_ATTR}] {
  position: absolute;
  top: 0;
  bottom: 0;
  pointer-events: none;
}
[${BAND_ATTR}="ahead"] {
  background: var(--destructive, #dc2626);
}
[${BAND_ATTR}="under"] {
  background: var(--sidebar-foreground, currentColor);
  opacity: 0.15;
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

/** One provider on one machine, with the names the card shows. */
export interface CardProvider {
  machine: string;
  provider: string;
  windows: PaceInput[];
}

/** Reads the provider-usage RPC result; unknown shapes give an empty list. */
export function parseCardUsage(body: unknown): CardProvider[] {
  const out: CardProvider[] = [];
  const result = (body as { ok?: boolean; result?: unknown } | null)?.result;
  const machines = (result as { machines?: unknown } | undefined)?.machines;
  if (!Array.isArray(machines)) return out;
  for (const machine of machines) {
    if (typeof machine?.displayName !== "string" || !Array.isArray(machine.providers)) continue;
    for (const provider of machine.providers) {
      const usage = provider?.usage;
      if (typeof provider?.displayName !== "string" || usage?.status !== "ok") continue;
      if (!Array.isArray(usage.windows)) continue;
      out.push({
        machine: machine.displayName,
        provider: provider.displayName,
        windows: usage.windows.filter(
          (window: unknown): window is PaceInput =>
            typeof (window as PaceInput)?.label === "string" &&
            typeof (window as PaceInput)?.usedPercent === "number",
        ),
      });
    }
  }
  return out;
}

export interface RowMatch {
  pace: Pace;
  usedPercent: number;
}

/**
 * The pace for one card row. `provider` and `machine` are the names the
 * card shows; either can be null when the card does not show it.
 */
export function matchRow(
  providers: readonly CardProvider[],
  provider: string | null,
  machine: string | null,
  ariaLabel: string,
  now = Date.now(),
): RowMatch | null {
  const named = providers.filter(
    (candidate) => provider === null || candidate.provider === provider,
  );
  const onMachine = named.filter(
    (candidate) => machine === null || candidate.machine === machine,
  );
  for (const candidate of onMachine.length > 0 ? onMachine : named) {
    const index = candidate.windows.findIndex((window) =>
      ariaLabel.startsWith(`${window.label}: `),
    );
    if (index === -1) continue;
    // The row can be newer than the last fetch: use the percent it shows.
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
  let band = bar?.querySelector<HTMLElement>(`[${BAND_ATTR}]`) ?? null;
  let tick = bar?.querySelector<HTMLElement>(`[${TICK_ATTR}]`) ?? null;
  let delta = row.querySelector<HTMLElement>(`:scope > [${DELTA_ATTR}]`);

  if (match === null || !(bar instanceof HTMLElement) || grid === null) {
    band?.remove();
    tick?.remove();
    delta?.remove();
    return;
  }

  if (bar.style.position !== "relative") bar.style.position = "relative";
  const even = match.pace.elapsedFraction * 100;
  const used = Math.max(0, Math.min(100, match.usedPercent));

  if (band === null) {
    band = document.createElement("span");
    band.setAttribute("aria-hidden", "true");
    bar.appendChild(band);
  }
  const kind = used > even ? "ahead" : "under";
  if (band.getAttribute(BAND_ATTR) !== kind) band.setAttribute(BAND_ATTR, kind);
  const bandLeft = `${Math.min(used, even).toFixed(2)}%`;
  const bandWidth = `${Math.abs(used - even).toFixed(2)}%`;
  if (band.style.left !== bandLeft) band.style.left = bandLeft;
  if (band.style.width !== bandWidth) band.style.width = bandWidth;

  if (tick === null) {
    tick = document.createElement("span");
    tick.setAttribute(TICK_ATTR, "");
    tick.setAttribute("aria-hidden", "true");
    bar.appendChild(tick);
  }
  const left = `${even.toFixed(2)}%`;
  if (tick.style.left !== left) tick.style.left = left;

  if (delta === null) {
    delta = document.createElement("span");
    delta.setAttribute(DELTA_ATTR, "");
    delta.className = "text-2xs text-subtle-foreground tabular-nums";
    delta.style.whiteSpace = "pre-line";
    grid.after(delta);
  }
  const [first, second] = describeDelta(match.pace, match.usedPercent, now);
  setText(delta, `${first}\n${second}`);
}

function decorateCard(header: Element, providers: readonly CardProvider[], now: number) {
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
    // The machine menu in the header is also a button with aria-expanded.
    if (header.contains(row)) continue;
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

  let providers: CardProvider[] = [];
  let fetchedAt = 0;
  let fetching = false;

  let frame: number | null = null;
  const run = () => {
    frame = null;
    if (signal.aborted) return;
    const headers = document.querySelectorAll(HEADER_SELECTOR);
    if (headers.length === 0) return;
    const now = Date.now();
    if (now - fetchedAt > REFETCH_MS) void load();
    for (const header of headers) decorateCard(header, providers, now);
  };
  const schedule = () => {
    if (frame === null) frame = window.requestAnimationFrame(run);
  };

  async function load() {
    if (fetching) return;
    fetching = true;
    fetchedAt = Date.now();
    try {
      const response = await fetch(CARD_RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          force: false,
          machineIds: null,
          providerId: null,
          maxAgeMs: CARD_MAX_AGE_MS,
        }),
        signal,
      });
      providers = parseCardUsage(await response.json());
    } catch {
      // Keep the last data; the next run tries again after REFETCH_MS.
    } finally {
      fetching = false;
      schedule();
    }
  }

  // Our own writes also trigger the observer; `run` writes only on change,
  // so the second pass is a no-op.
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true });
  const minute = window.setInterval(schedule, REFETCH_MS);
  schedule();

  return () => {
    observer.disconnect();
    window.clearInterval(minute);
    if (frame !== null) window.cancelAnimationFrame(frame);
    for (const node of document.querySelectorAll(
      `[${TICK_ATTR}], [${BAND_ATTR}], [${DELTA_ATTR}]`,
    )) {
      node.remove();
    }
    document.getElementById(STYLE_ID)?.remove();
  };
}
