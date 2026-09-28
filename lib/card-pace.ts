// Adds pace to bb's built-in usage card (the provider-usage plugin's sidebar
// footer card). That card is another plugin's React tree, so this content
// script mostly adds nodes to it:
//   - an even-pace tick on each window's bar, and a band between the used
//     percent and that tick: red when ahead of pace, faint when under it;
//   - bb's "Couldn't refresh usage" message on the failed provider's tab
//     only, with that provider's error, a red dot on that tab, and a button
//     that dismisses the message. bb shows the message on every tab when
//     one provider on the machine fails, and does not say which one. The
//     failure comes from this plugin's own usage snapshot.
//   - provider tabs the user hid in the settings (bb lists some providers,
//     such as Cursor, on every machine, installed or not);
//   - the delta from even pace, as a line inside the row, under the dates.
//     It shows while the pointer is over the row (mouse only), and when bb
//     expands the row on tap, click or Enter (the touch path).
//
// Hover is not CSS `:hover`. The delta line makes the row taller and moves
// the rows below it, so `:hover` closed the row whenever the pointer was in a
// gap between rows, and the card jumped. Here the open row stays open while
// the pointer is anywhere in the list of rows, and changes only when the
// pointer enters another row. The one change to a React node: while a row is
// open by hover, its `title` is held back, so the browser does not show a
// second, native tooltip over the delta. It is put back when the row closes.
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
/** The delta line inside a row. */
const DETAIL_ATTR = "data-usage-pace-detail";
/** Where the `title` of a hover-open row waits until the row closes. */
const TITLE_ATTR = "data-usage-pace-title";
/** Hover only where a pointer can hover; touch uses bb's tap to expand. */
const HOVER_QUERY = "(hover: hover) and (pointer: fine)";
/** Marks a provider tab that the user hid; the style hides it. */
const HIDDEN_ATTR = "data-usage-pace-hidden";
const SETTINGS_RPC_URL = "/api/v1/plugins/usage-pace/rpc/getCardSettings";
const OWN_USAGE_RPC_URL = "/api/v1/plugins/usage-pace/rpc/getUsage";
/** On bb's status message when it is a refresh or load failure. */
const FAILED_ATTR = "data-usage-pace-failed";
/** The line that names the failed providers. */
const FAILURE_ATTR = "data-usage-pace-failure";
const DISMISS_ATTR = "data-usage-pace-dismiss";
const DISMISSED_ATTR = "data-usage-pace-dismissed";
/** On bb's failure message on a tab whose provider did not fail. */
const OTHER_TAB_ATTR = "data-usage-pace-other-tab";
/** On the tab of a provider that failed: a red dot. */
const FAILED_TAB_ATTR = "data-usage-pace-failed-tab";
/** localStorage key: the failure the user dismissed. */
const DISMISSED_KEY = "usage-pace:dismissed-failure";
/** bb's texts: "Couldn’t refresh usage. …" and "Couldn’t load usage." */
const FAILURE_MESSAGE = /couldn.t (refresh|load) usage/iu;
const STYLE_ID = "usage-pace-card-style";
const MACHINE_PREFIX = "Usage machine: ";
const CARD_RPC_URL = "/api/v1/plugins/provider-usage/rpc/getUsage";
const CARD_MAX_AGE_MS = 5 * 60_000;
const REFETCH_MS = 60_000;

const STYLE = `
[role="tab"][${HIDDEN_ATTR}] {
  display: none !important;
}
[role="status"][${FAILED_ATTR}] {
  position: relative;
  flex-wrap: wrap;
  row-gap: 0.25rem;
  padding-right: 1.75rem;
}
[role="status"][${DISMISSED_ATTR}],
[role="status"][${OTHER_TAB_ATTR}] {
  display: none !important;
}
[role="tab"][${FAILED_TAB_ATTR}]::after {
  content: "";
  position: absolute;
  right: 0.25rem;
  bottom: 0.45rem;
  width: 0.375rem;
  height: 0.375rem;
  border-radius: 9999px;
  background: var(--destructive, #dc2626);
  box-shadow: 0 0 0 2px var(--sidebar, #fff);
  pointer-events: none;
}
[${FAILURE_ATTR}] {
  flex-basis: 100%;
  padding-left: 1.25rem;
  white-space: pre-line;
}
[${DISMISS_ATTR}] {
  position: absolute;
  top: 0.3rem;
  right: 0.3rem;
  width: 1.25rem;
  height: 1.25rem;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 0.25rem;
  font-size: 0.9rem;
  line-height: 1;
  color: inherit;
  opacity: 0.7;
  cursor: pointer;
}
[${DISMISS_ATTR}]:hover {
  opacity: 1;
  background: var(--sidebar-accent, rgb(0 0 0 / 0.06));
}
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
/* bb's expanded line ("Resets in 3 hr 26 min") repeats the reset time the
   row already shows. Hide it while the delta is in the row. */
button:has(> [${DETAIL_ATTR}]) > :not(:first-child):not([${DETAIL_ATTR}]) {
  display: none;
}
[${DETAIL_ATTR}] {
  grid-column: 1 / -1;
  text-align: right;
  white-space: pre-line;
  line-height: 1.35;
  padding-top: 1px;
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

/** Reads this plugin's getCardSettings result: lowercase provider names. */
export function parseCardSettings(body: unknown): string[] {
  const list = (body as { result?: { hiddenProviders?: unknown } } | null)?.result?.hiddenProviders;
  return Array.isArray(list)
    ? list.filter((name): name is string => typeof name === "string").map((name) => name.toLowerCase())
    : [];
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

function holdTitle(row: HTMLElement) {
  const title = row.getAttribute("title");
  if (title === null) return;
  row.setAttribute(TITLE_ATTR, title);
  row.removeAttribute("title");
}

function restoreTitle(row: HTMLElement) {
  const title = row.getAttribute(TITLE_ATTR);
  if (title === null) return;
  row.removeAttribute(TITLE_ATTR);
  // React sets a new title when its value changes; keep that one.
  if (!row.hasAttribute("title")) row.setAttribute("title", title);
}

/** Returns true when the row was decorated. */
function decorateRow(
  row: HTMLElement,
  match: RowMatch | null,
  now: number,
  hovered: boolean,
): boolean {
  const grid = row.firstElementChild;
  // The bar is the second cell of the row grid: label, bar, percent, reset.
  const bar = grid?.children.item(1);
  let band = bar?.querySelector<HTMLElement>(`[${BAND_ATTR}]`) ?? null;
  let tick = bar?.querySelector<HTMLElement>(`[${TICK_ATTR}]`) ?? null;
  let detail = row.querySelector<HTMLElement>(`:scope > [${DETAIL_ATTR}]`);

  if (match === null || !(bar instanceof HTMLElement)) {
    band?.remove();
    tick?.remove();
    detail?.remove();
    return false;
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

  // bb expands the row on tap and adds its reset line as the last child.
  // The delta goes after it (the style hides bb's line); appendChild also
  // moves it back to the end if React adds its line later. It is always right-aligned, under the dates.
  const expanded = row.getAttribute("aria-expanded") === "true";
  if (expanded || hovered) {
    if (detail === null) {
      detail = document.createElement("span");
      detail.setAttribute(DETAIL_ATTR, "");
      detail.className = "text-2xs text-subtle-foreground tabular-nums";
    }
    if (row.lastElementChild !== detail) row.appendChild(detail);
    const [first, second] = describeDelta(match.pace, match.usedPercent, now);
    setText(detail, `${first}\n${second}`);
  } else {
    detail?.remove();
  }
  return true;
}

/** The window rows of one card, without the machine menu in its header. */
function cardRows(header: Element): HTMLElement[] {
  const card = header.parentElement;
  if (card === null) return [];
  return [...card.querySelectorAll<HTMLElement>("button[aria-expanded]")].filter(
    (row) => !header.contains(row),
  );
}

/**
 * Hides the provider tabs named in `hidden` (lowercase names). When the
 * selected tab is hidden, selects the first visible tab instead.
 */
/** A provider whose usage read failed, from this plugin's own snapshot. */
export interface ProviderFailure {
  provider: string;
  machine: string;
  message: string | null;
}

/** Reads this plugin's getUsage result: the providers with status "error". */
export function parseFailures(body: unknown): ProviderFailure[] {
  const providers = (body as { result?: { providers?: unknown } } | null)?.result?.providers;
  if (!Array.isArray(providers)) return [];
  return providers
    .filter((provider) => provider?.status === "error" && typeof provider.displayName === "string")
    .map((provider) => ({
      provider: provider.displayName as string,
      machine: typeof provider.hostName === "string" ? provider.hostName : "",
      message: typeof provider.message === "string" ? provider.message : null,
    }));
}

/** "opencode: OpenCode Go usage access was denied. …", one line each. */
export function describeFailures(failures: readonly ProviderFailure[]): string {
  if (failures.length === 0) return "The provider that failed is not known.";
  return failures
    .map((failure) => (failure.message ? `${failure.provider}: ${failure.message}` : `${failure.provider} failed.`))
    .join("\n");
}

const tabName = (tab: Element) => tab.getAttribute("aria-label")?.trim().toLowerCase() ?? "";

function toggleAttribute(element: Element, name: string, on: boolean) {
  if (on === element.hasAttribute(name)) return;
  if (on) element.setAttribute(name, "");
  else element.removeAttribute(name);
}

/**
 * Puts bb's failure message on the tab of the provider that failed only.
 *
 * bb shows the message on every tab of the machine. When this plugin knows
 * which providers failed, the message shows on their tabs, with their
 * errors, and is hidden on the other tabs, whose data is current; the
 * failed tabs get a red dot. When no failed provider is known, the message
 * shows on every tab, as bb shows it. The dismiss button hides the message
 * until the failure changes.
 */
export function decorateFailure(
  header: Element,
  failures: readonly ProviderFailure[],
  machine: string | null,
  storage: Pick<Storage, "getItem" | "setItem"> | null,
) {
  const here = failures.filter((failure) => machine === null || failure.machine === machine);
  const failed = new Set(here.map((failure) => failure.provider.trim().toLowerCase()));
  for (const tab of header.querySelectorAll('[role="tab"]')) {
    toggleAttribute(tab, FAILED_TAB_ATTR, failed.has(tabName(tab)));
  }

  const card = header.parentElement;
  const status = card?.querySelector<HTMLElement>('[role="status"]') ?? null;
  for (const other of card?.querySelectorAll<HTMLElement>(`[${FAILED_ATTR}]`) ?? []) {
    if (other !== status) clearFailure(other);
  }
  if (status === null) return;
  const text = [...status.childNodes]
    .filter((node) => !(node instanceof Element && (node.hasAttribute(FAILURE_ATTR) || node.hasAttribute(DISMISS_ATTR))))
    .map((node) => node.textContent ?? "")
    .join(" ");
  if (!FAILURE_MESSAGE.test(text)) {
    clearFailure(status);
    return;
  }

  const selectedTab = header.querySelector('[role="tab"][aria-selected="true"]');
  const selected = selectedTab === null ? null : tabName(selectedTab);
  const onFailedTab = selected !== null && failed.has(selected);
  // Known failures, none of them on this tab: this tab's data is current.
  toggleAttribute(status, OTHER_TAB_ATTR, failed.size > 0 && selected !== null && !onFailedTab);
  const shown = onFailedTab
    ? here.filter((failure) => failure.provider.trim().toLowerCase() === selected)
    : here;
  const detail = describeFailures(shown);
  // The key changes when another provider fails or the message changes.
  const key = `${machine ?? ""}|${text.trim()}|${detail}`;

  toggleAttribute(status, FAILED_ATTR, true);
  let line = status.querySelector<HTMLElement>(`:scope > [${FAILURE_ATTR}]`);
  if (line === null) {
    line = document.createElement("span");
    line.setAttribute(FAILURE_ATTR, "");
  }
  setText(line, detail);
  let button = status.querySelector<HTMLButtonElement>(`:scope > [${DISMISS_ATTR}]`);
  if (button === null) {
    button = document.createElement("button");
    button.type = "button";
    button.setAttribute(DISMISS_ATTR, "");
    button.setAttribute("aria-label", "Dismiss this message");
    button.title = "Dismiss until the failure changes";
    button.textContent = "×";
  }
  // After bb's icon and text: the line, then the button. append() moves
  // them back to the end if React added a child later.
  if (status.lastElementChild !== button || button.previousElementSibling !== line) {
    status.append(line, button);
  }
  // The handler reads the key from the button, so it stays current.
  button.dataset.key = key;
  button.onclick = (event) => {
    event.stopPropagation();
    storage?.setItem(DISMISSED_KEY, button!.dataset.key ?? "");
    status.setAttribute(DISMISSED_ATTR, "");
  };
  toggleAttribute(status, DISMISSED_ATTR, storage?.getItem(DISMISSED_KEY) === key);
}

function clearFailure(status: HTMLElement) {
  status.querySelector(`:scope > [${FAILURE_ATTR}]`)?.remove();
  status.querySelector(`:scope > [${DISMISS_ATTR}]`)?.remove();
  for (const name of [FAILED_ATTR, DISMISSED_ATTR, OTHER_TAB_ATTR]) toggleAttribute(status, name, false);
}

function cardMachine(header: Element): string | null {
  const label = header.querySelector(`[aria-label^="${MACHINE_PREFIX}"]`)?.getAttribute("aria-label");
  return label?.slice(MACHINE_PREFIX.length) ?? null;
}

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function hideTabs(header: Element, hidden: readonly string[]) {
  const tabs = [...header.querySelectorAll<HTMLElement>('[role="tab"]')];
  for (const tab of tabs) {
    const name = tab.getAttribute("aria-label")?.trim().toLowerCase() ?? "";
    const hide = hidden.includes(name);
    if (hide !== tab.hasAttribute(HIDDEN_ATTR)) {
      if (hide) tab.setAttribute(HIDDEN_ATTR, "");
      else tab.removeAttribute(HIDDEN_ATTR);
    }
  }
  const selected = tabs.find((tab) => tab.getAttribute("aria-selected") === "true");
  if (selected?.hasAttribute(HIDDEN_ATTR)) {
    tabs.find((tab) => !tab.hasAttribute(HIDDEN_ATTR))?.click();
  }
}

function decorateCard(
  header: Element,
  providers: readonly CardProvider[],
  now: number,
  hovered: HTMLElement | null,
  decorated: WeakSet<HTMLElement>,
) {
  const provider =
    header
      .querySelector('[role="tab"][aria-selected="true"]')
      ?.getAttribute("aria-label") ?? null;
  const machineLabel =
    header.querySelector(`[aria-label^="${MACHINE_PREFIX}"]`)?.getAttribute("aria-label") ??
    null;
  const machine = machineLabel?.slice(MACHINE_PREFIX.length) ?? null;
  for (const row of cardRows(header)) {
    const label = row.getAttribute("aria-label");
    if (label === null) continue;
    const match = matchRow(providers, provider, machine, label, now);
    if (decorateRow(row, match, now, row === hovered)) decorated.add(row);
    else decorated.delete(row);
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
  let hiddenProviders: string[] = [];
  let failures: ProviderFailure[] = [];
  let fetchedAt = 0;
  let fetching = false;
  const decorated = new WeakSet<HTMLElement>();
  let hovered: HTMLElement | null = null;

  const run = () => {
    if (signal.aborted) return;
    if (hovered !== null && !hovered.isConnected) hovered = null;
    const headers = document.querySelectorAll(HEADER_SELECTOR);
    if (headers.length === 0) return;
    const now = Date.now();
    if (now - fetchedAt > REFETCH_MS) void load();
    for (const header of headers) {
      hideTabs(header, hiddenProviders);
      decorateFailure(header, failures, cardMachine(header), safeStorage());
      decorateCard(header, providers, now, hovered, decorated);
    }
    // React puts a changed title back; hold it again.
    if (hovered !== null) holdTitle(hovered);
  };

  let frame: number | null = null;
  const schedule = () => {
    if (frame === null)
      frame = window.requestAnimationFrame(() => {
        frame = null;
        run();
      });
  };

  const setHovered = (row: HTMLElement | null) => {
    if (row === hovered) return;
    if (hovered !== null) restoreTitle(hovered);
    hovered = row;
    if (row !== null) holdTitle(row);
    // Now, not on the next frame: the layout must change before the next
    // pointer event is read against it.
    run();
  };

  const canHover = () => window.matchMedia?.(HOVER_QUERY).matches ?? true;
  const rowFrom = (target: EventTarget | null): HTMLElement | null => {
    if (!(target instanceof Element)) return null;
    const row = target.closest("button[aria-expanded]");
    return row instanceof HTMLElement && decorated.has(row) ? row : null;
  };
  const onOver = (event: MouseEvent) => {
    if (!canHover()) return;
    const row = rowFrom(event.target);
    // Over a gap between rows, `row` is null: keep the open row.
    if (row !== null) setHovered(row);
  };
  const onOut = (event: MouseEvent) => {
    if (hovered === null) return;
    // The hitbox is the whole list of rows, gaps included.
    const list = hovered.parentElement;
    const next = event.relatedTarget;
    if (!(next instanceof Node && list?.contains(next))) setHovered(null);
  };
  document.addEventListener("mouseover", onOver);
  document.addEventListener("mouseout", onOut);

  async function load() {
    if (fetching) return;
    fetching = true;
    fetchedAt = Date.now();
    const post = (url: string, body: unknown) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      }).then((response) => response.json());
    // Each read keeps its last value when it fails; the next run tries
    // again after REFETCH_MS.
    const [card, settings, own] = await Promise.allSettled([
      post(CARD_RPC_URL, { force: false, machineIds: null, providerId: null, maxAgeMs: CARD_MAX_AGE_MS }),
      post(SETTINGS_RPC_URL, {}),
      post(OWN_USAGE_RPC_URL, { force: false }),
    ]);
    try {
      if (card.status === "fulfilled") providers = parseCardUsage(card.value);
      if (settings.status === "fulfilled") hiddenProviders = parseCardSettings(settings.value);
      if (own.status === "fulfilled") failures = parseFailures(own.value);
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
    document.removeEventListener("mouseover", onOver);
    document.removeEventListener("mouseout", onOut);
    if (hovered !== null) restoreTitle(hovered);
    hovered = null;
    for (const node of document.querySelectorAll(
      `[${TICK_ATTR}], [${BAND_ATTR}], [${DETAIL_ATTR}]`,
    )) {
      node.remove();
    }
    for (const status of document.querySelectorAll<HTMLElement>(`[${FAILED_ATTR}]`)) {
      clearFailure(status);
    }
    for (const tab of document.querySelectorAll(`[${FAILED_TAB_ATTR}]`)) {
      tab.removeAttribute(FAILED_TAB_ATTR);
    }
    for (const tab of document.querySelectorAll(`[${HIDDEN_ATTR}]`)) {
      tab.removeAttribute(HIDDEN_ATTR);
    }
    document.getElementById(STYLE_ID)?.remove();
  };
}
