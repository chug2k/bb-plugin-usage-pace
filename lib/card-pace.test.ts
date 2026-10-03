// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decorateFailure,
  describeFailures,
  hideTabs,
  parseFailures,
  matchRow,
  mountCardPace,
  parseCardSettings,
  parseCardUsage,
  type CardProvider,
} from "./card-pace";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-09-24T06:20:00Z");
const at = (hoursFromNow: number) => new Date(NOW + hoursFromNow * HOUR).toISOString();

/** The provider-usage RPC result, trimmed from a real response. */
function cardResponse(weeklyUsed = 42) {
  return {
    ok: true,
    result: {
      machines: [
        {
          id: "host_1",
          displayName: "MacBook Pro (7)",
          status: "connected",
          providers: [
            { displayName: "Codex", usage: { status: "not_installed" } },
            {
              displayName: "Claude Code",
              usage: {
                status: "ok",
                accountEmail: "me@example.com",
                planLabel: "Team (5x)",
                windows: [
                  { label: "Five-hour limit", usedPercent: 32, resetsAt: at(4), cost: null },
                  { label: "Weekly limit", usedPercent: weeklyUsed, resetsAt: at(122), cost: null },
                  { label: "Weekly · Fable", usedPercent: 7, resetsAt: at(122), cost: null },
                ],
              },
            },
            { displayName: "opencode", usage: null },
          ],
          error: null,
        },
      ],
    },
  };
}

describe("parseCardUsage", () => {
  it("keeps providers with usage and drops the others", () => {
    const parsed = parseCardUsage(cardResponse());
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.provider).toBe("Claude Code");
    expect(parsed[0]!.machine).toBe("MacBook Pro (7)");
    expect(parsed[0]!.windows.map((window) => window.label)).toEqual([
      "Five-hour limit",
      "Weekly limit",
      "Weekly · Fable",
    ]);
  });

  it("returns an empty list for an error or an unknown shape", () => {
    expect(parseCardUsage({ ok: false, error: {} })).toEqual([]);
    expect(parseCardUsage(null)).toEqual([]);
    expect(parseCardUsage({ ok: true, result: { machines: "x" } })).toEqual([]);
  });
});

describe("matchRow", () => {
  const providers: CardProvider[] = [
    ...parseCardUsage(cardResponse()),
    { ...parseCardUsage(cardResponse(90))[0]!, machine: "Studio" },
  ];

  it("matches every row the card shows", () => {
    for (const [aria, length] of [
      ["Five-hour limit: 32% used. Resets in 3 hr 57 min", 5],
      ["Weekly limit: 42% used. Resets Tue 3:59 PM", 168],
      ["Weekly · Fable: 7% used. Resets Tue 3:59 PM", 168],
    ] as const) {
      const match = matchRow(providers, "Claude Code", "MacBook Pro (7)", aria, NOW);
      expect(match?.pace.windowMs).toBe(length * HOUR);
    }
  });

  it("uses the percent the row shows, not the fetched one", () => {
    const match = matchRow(providers, "Claude Code", "MacBook Pro (7)", "Weekly limit: 44% used. x", NOW)!;
    expect(match.usedPercent).toBe(44);
    expect(match.pace.projectedPercent).toBeCloseTo(44 / (46 / 168));
  });

  it("picks the machine by name, and falls back when no machine matches", () => {
    expect(matchRow(providers, "Claude Code", "Studio", "Weekly limit: 90% used. x", NOW)!.usedPercent).toBe(90);
    expect(matchRow(providers, "Claude Code", "Renamed Mac", "Weekly limit: 42% used. x", NOW)).not.toBeNull();
  });

  it("returns null for another provider or an unknown label", () => {
    expect(matchRow(providers, "Codex", null, "Weekly limit: 42% used. x", NOW)).toBeNull();
    expect(matchRow(providers, "Claude Code", null, "Credits: 42% used. x", NOW)).toBeNull();
  });

  it("matches rows on the All accounts tab against any provider", () => {
    for (const tab of ["All accounts", "All", "all accounts"]) {
      const match = matchRow(providers, tab, "MacBook Pro (7)", "Weekly limit: 42% used. x", NOW);
      expect(match).not.toBeNull();
      expect(match?.pace.windowMs).toBe(168 * HOUR);
    }
  });

  it("tells providers apart on the All tab by the percent the row shows", () => {
    const both: CardProvider[] = [
      ...parseCardUsage(cardResponse(85)),
      {
        provider: "Grok Build (usage)",
        machine: "MacBook Pro (7)",
        windows: [
          { label: "Weekly limit", usedPercent: 2, resetsAt: at(200) },
        ],
      },
    ];
    const claudeRow = matchRow(both, "All accounts", "MacBook Pro (7)", "Weekly limit: 85% used. x", NOW)!;
    const grokRow = matchRow(both, "All accounts", "MacBook Pro (7)", "Weekly limit: 2% used. x", NOW)!;
    expect(claudeRow).not.toBeNull();
    expect(grokRow).not.toBeNull();
    // Grok's window resets later: its pace window differs from Claude's.
    expect(grokRow.pace.resetsAtMs).not.toBe(claudeRow.pace.resetsAtMs);
  });
});

/** The markup bb's provider-usage card renders for one provider. */
function renderCard(rows: { label: string; used: number }[]) {
  document.body.innerHTML = `
    <div class="flex max-h-80 flex-col">
      <div data-provider-usage-header="">
        <div role="tablist">
          <button role="tab" aria-label="Claude Code" aria-selected="true"></button>
          <button role="tab" aria-label="Codex" aria-selected="false"></button>
        </div>
        <button type="button" aria-expanded="false" aria-label="Usage machine: MacBook Pro (7)"><span>MacBook Pro (7)</span></button>
      </div>
      <div class="grid">
        ${rows
          .map(
            ({ label, used }) => `
          <button type="button" aria-expanded="false" title="${label} · Resets Tue 3:59 PM" aria-label="${label}: ${used}% used. Resets Tue 3:59 PM">
            <span class="grid">
              <span>${label}</span>
              <span class="bar"><span class="fill" style="width:${used}%"></span></span>
              <span>${used}%</span>
              <span>5d 2h</span>
            </span>
          </button>`,
          )
          .join("")}
      </div>
    </div>`;
}

describe("mountCardPace", () => {
  let controller: AbortController;
  let unmount: (() => void) | undefined;
  let fetchMock: ReturnType<typeof vi.fn>;
  let hidden: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    fetchMock = vi.fn(async (url: string) =>
      new Response(
        JSON.stringify(
          url.includes("getCardSettings") ? { ok: true, result: { hiddenProviders: hidden } } : cardResponse(),
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    controller = new AbortController();
  });

  afterEach(() => {
    hidden = [];
    unmount?.();
    unmount = undefined;
    controller.abort();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  /** First frame starts the fetch; the next frame after it decorates. */
  const settle = async () => {
    await frame();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    await frame();
  };
  const mount = async (rows: { label: string; used: number }[]) => {
    renderCard(rows);
    unmount = mountCardPace({ signal: controller.signal });
    await settle();
    return [...document.querySelectorAll<HTMLElement>(".grid > button[aria-expanded]")];
  };
  const hover = (row: Element) =>
    row.firstElementChild!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  const leave = (row: Element, to: Element | null) =>
    row.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: to }));
  const detail = (row: Element) => row.querySelector<HTMLElement>(":scope > [data-usage-pace-detail]");

  it("reads the card's own RPC", async () => {
    await mount([{ label: "Weekly limit", used: 42 }]);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/v1/plugins/bb--provider-usage/rpc/getUsage");
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
      force: false,
      machineIds: null,
      providerId: null,
      maxAgeMs: 300_000,
    });
  });

  it("adds an even-pace tick to every row", async () => {
    const rows = await mount([
      { label: "Five-hour limit", used: 32 },
      { label: "Weekly limit", used: 42 },
      { label: "Weekly · Fable", used: 7 },
    ]);
    for (const row of rows) {
      expect(row.querySelector(".bar > [data-usage-pace-tick]")).not.toBeNull();
      expect(detail(row)).toBeNull();
    }
    const tick = rows[1]!.querySelector<HTMLElement>("[data-usage-pace-tick]")!;
    expect(Number.parseFloat(tick.style.left)).toBeCloseTo((46 / 168) * 100, 1);
    expect(rows[1]!.querySelector<HTMLElement>(".bar")!.style.position).toBe("relative");
  });

  it("marks the part of the bar ahead of pace red, and the part under pace faint", async () => {
    await mount([
      { label: "Weekly limit", used: 42 },
      { label: "Weekly · Fable", used: 7 },
    ]);
    const even = (46 / 168) * 100;
    const [weekly, fable] = [...document.querySelectorAll<HTMLElement>("[data-usage-pace-band]")];
    expect(weekly!.getAttribute("data-usage-pace-band")).toBe("ahead");
    expect(Number.parseFloat(weekly!.style.left)).toBeCloseTo(even, 1);
    expect(Number.parseFloat(weekly!.style.width)).toBeCloseTo(42 - even, 1);
    expect(fable!.getAttribute("data-usage-pace-band")).toBe("under");
    expect(Number.parseFloat(fable!.style.left)).toBeCloseTo(7, 1);
    expect(Number.parseFloat(fable!.style.width)).toBeCloseTo(even - 7, 1);
  });

  it("shows the delta inside the row, under the dates, on hover", async () => {
    const [weekly] = await mount([{ label: "Weekly limit", used: 42 }]);
    hover(weekly!);
    const line = detail(weekly!)!;
    expect(line).not.toBeNull();
    expect(line.previousElementSibling).toBe(weekly!.firstElementChild);
    expect(getComputedStyle(line).textAlign).toBe("right");
    expect(line.textContent).toMatch(/^15% ahead of pace \(1d 0h\)\nruns out .+ · 2d 10h without quota$/u);
    leave(weekly!, document.body);
    expect(detail(weekly!)).toBeNull();
  });

  it("keeps the row open over the gap between rows, and switches on the next row", async () => {
    const [weekly, fable] = await mount([
      { label: "Weekly limit", used: 42 },
      { label: "Weekly · Fable", used: 7 },
    ]);
    hover(weekly!);
    leave(weekly!, weekly!.parentElement);
    expect(detail(weekly!)).not.toBeNull();
    hover(fable!);
    expect(detail(weekly!)).toBeNull();
    expect(detail(fable!)!.textContent).toMatch(/under pace/u);
  });

  it("stays open while the pointer is over its own delta line", async () => {
    const [weekly] = await mount([{ label: "Weekly limit", used: 42 }]);
    hover(weekly!);
    const line = detail(weekly!)!;
    leave(weekly!.firstElementChild!, line);
    line.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(detail(weekly!)).toBe(line);
  });

  it("holds back the native title while open, and puts it back", async () => {
    const [weekly] = await mount([{ label: "Weekly limit", used: 42 }]);
    hover(weekly!);
    expect(weekly!.hasAttribute("title")).toBe(false);
    leave(weekly!, document.body);
    expect(weekly!.getAttribute("title")).toBe("Weekly limit · Resets Tue 3:59 PM");
  });

  it("does nothing on hover where the pointer cannot hover", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query }));
    const [weekly] = await mount([{ label: "Weekly limit", used: 42 }]);
    hover(weekly!);
    expect(detail(weekly!)).toBeNull();
    expect(weekly!.hasAttribute("title")).toBe(true);
  });

  it("does nothing on hover over the machine menu in the header", async () => {
    await mount([{ label: "Weekly limit", used: 42 }]);
    const menu = document.querySelector("[data-provider-usage-header] button[aria-expanded]")!;
    hover(menu);
    expect(document.querySelector("[data-usage-pace-detail]")).toBeNull();
  });

  it("puts the delta under bb's reset line when the row is tapped open", async () => {
    const [row] = await mount([{ label: "Weekly limit", used: 42 }]);

    // What bb does on a tap: aria-expanded, then its own reset line at the end.
    row!.setAttribute("aria-expanded", "true");
    const reset = document.createElement("span");
    reset.textContent = "Resets Tue 3:59 PM";
    row!.appendChild(reset);
    await frame();

    const line = row!.lastElementChild as HTMLElement;
    expect(line.hasAttribute("data-usage-pace-detail")).toBe(true);
    expect(line.previousElementSibling).toBe(reset);
    expect(getComputedStyle(line).textAlign).toBe("right");
    expect(line.textContent).toMatch(/^15% ahead of pace/u);
    // bb's own reset line repeats the row's reset time: it is hidden.
    expect(getComputedStyle(reset).display).toBe("none");
    expect(getComputedStyle(row!.firstElementChild!).display).not.toBe("none");

    // What bb does on the second tap.
    row!.setAttribute("aria-expanded", "false");
    reset.remove();
    await frame();
    expect(detail(row!)).toBeNull();
  });

  it("hides the provider tabs named in the settings", async () => {
    hidden = ["codex"];
    await mount([{ label: "Weekly limit", used: 42 }]);
    const codex = document.querySelector<HTMLElement>('[role="tab"][aria-label="Codex"]')!;
    expect(codex.hasAttribute("data-usage-pace-hidden")).toBe(true);
    expect(getComputedStyle(codex).display).toBe("none");
    const claude = document.querySelector<HTMLElement>('[role="tab"][aria-label="Claude Code"]')!;
    expect(getComputedStyle(claude).display).not.toBe("none");
  });

  it("names the failed provider under bb's failure message, and hides it on dismiss", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      new Response(
        JSON.stringify(
          url.includes("usage-pace/rpc/getUsage")
            ? {
                ok: true,
                result: {
                  providers: [
                    { displayName: "Claude Code", hostName: "MacBook Pro (7)", status: "error", message: "Token expired." },
                  ],
                },
              }
            : url.includes("getCardSettings")
              ? { ok: true, result: { hiddenProviders: [] } }
              : cardResponse(),
        ),
      ),
    );
    renderCard([{ label: "Weekly limit", used: 42 }]);
    const status = document.createElement("div");
    status.setAttribute("role", "status");
    status.innerHTML = "<svg></svg><span>Couldn\u2019t refresh usage. Showing the last available update.</span>";
    document.querySelector("[data-provider-usage-header]")!.after(status);
    localStorage.clear();
    unmount = mountCardPace({ signal: controller.signal });
    await settle();
    expect(status.querySelector("[data-usage-pace-failure]")!.textContent).toBe("Claude Code: Token expired.");
    expect(getComputedStyle(status).display).not.toBe("none");
    status.querySelector<HTMLButtonElement>("[data-usage-pace-dismiss]")!.click();
    expect(getComputedStyle(status).display).toBe("none");
  });

  it("does not add anything twice when the card changes", async () => {
    const [weekly] = await mount([{ label: "Weekly limit", used: 42 }]);
    hover(weekly!);
    document.querySelector(".fill")!.setAttribute("style", "width:43%");
    document.body.appendChild(document.createElement("div"));
    await frame();
    expect(document.querySelectorAll("[data-usage-pace-tick]")).toHaveLength(1);
    expect(document.querySelectorAll("[data-usage-pace-detail]")).toHaveLength(1);
  });

  it("shows hidden tabs again on unmount", async () => {
    hidden = ["codex"];
    await mount([{ label: "Weekly limit", used: 42 }]);
    unmount!();
    unmount = undefined;
    expect(document.querySelectorAll("[data-usage-pace-hidden]")).toHaveLength(0);
  });

  it("removes its nodes and style, and puts the title back, on unmount", async () => {
    const [weekly] = await mount([{ label: "Weekly limit", used: 42 }]);
    hover(weekly!);
    unmount!();
    unmount = undefined;
    expect(
      document.querySelectorAll("[data-usage-pace-tick], [data-usage-pace-band], [data-usage-pace-detail]"),
    ).toHaveLength(0);
    expect(document.getElementById("usage-pace-card-style")).toBeNull();
    expect(weekly!.getAttribute("title")).toBe("Weekly limit · Resets Tue 3:59 PM");
  });
});

describe("hideTabs", () => {
  function tabs(selected: string) {
    document.body.innerHTML = `<div data-provider-usage-header>${["Claude Code", "Cursor", "opencode"]
      .map((name) => `<button role="tab" aria-label="${name}" aria-selected="${name === selected}"></button>`)
      .join("")}</div>`;
    const header = document.querySelector("[data-provider-usage-header]")!;
    // What bb does when a tab is clicked.
    for (const tab of header.querySelectorAll("[role=tab]")) {
      tab.addEventListener("click", () => {
        for (const other of header.querySelectorAll("[role=tab]")) other.setAttribute("aria-selected", String(other === tab));
      });
    }
    return header;
  }
  const selectedName = (header: Element) =>
    header.querySelector('[aria-selected="true"]')?.getAttribute("aria-label");

  it("matches names without regard to case", () => {
    const header = tabs("Claude Code");
    hideTabs(header, parseCardSettings({ ok: true, result: { hiddenProviders: ["CURSOR"] } }));
    expect(header.querySelector('[aria-label="Cursor"]')!.hasAttribute("data-usage-pace-hidden")).toBe(true);
    expect(selectedName(header)).toBe("Claude Code");
  });

  it("selects the first visible tab when the selected tab is hidden", () => {
    const header = tabs("Cursor");
    hideTabs(header, ["cursor"]);
    expect(selectedName(header)).toBe("Claude Code");
  });

  it("shows a tab again when its name leaves the list", () => {
    const header = tabs("Claude Code");
    hideTabs(header, ["cursor"]);
    hideTabs(header, []);
    expect(header.querySelectorAll("[data-usage-pace-hidden]")).toHaveLength(0);
  });

  it("reads an empty list from an error or an unknown shape", () => {
    expect(parseCardSettings({ ok: false })).toEqual([]);
    expect(parseCardSettings(null)).toEqual([]);
  });
});

describe("failure notice", () => {
  const REFRESH_FAILED = "Couldn\u2019t refresh usage. Showing the last available update.";
  const opencode = { provider: "opencode", machine: "MacBook Pro (7)", message: "OpenCode Go usage access was denied." };

  /** bb's card with its status message; `selected` is the open tab. */
  function card(message: string, selected = "opencode", tabs = ["Claude Code", "opencode", "Grok Build (usage)"]) {
    document.body.innerHTML = `
      <div class="card">
        <div data-provider-usage-header>
          ${tabs
            .map((name) => `<button role="tab" aria-label="${name}" aria-selected="${name === selected}"></button>`)
            .join("")}
          <button type="button" aria-expanded="false" aria-label="Usage machine: MacBook Pro (7)"></button>
        </div>
        <div role="status"><svg class="icon"></svg><span class="text">${message}</span></div>
      </div>`;
    return document.querySelector("[data-provider-usage-header]")!;
  }
  const status = () => document.querySelector<HTMLElement>('[role="status"]')!;
  const line = () => status().querySelector("[data-usage-pace-failure]");
  const button = () => status().querySelector<HTMLButtonElement>("[data-usage-pace-dismiss]");
  function memory() {
    const items = new Map<string, string>();
    return { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v) };
  }

  it("reads the providers with status error from this plugin's snapshot", () => {
    expect(
      parseFailures({
        ok: true,
        result: {
          providers: [
            { displayName: "Claude Code", hostName: "MacBook Pro (7)", status: "ok", message: null },
            { displayName: "opencode", hostName: "MacBook Pro (7)", status: "error", message: "OpenCode Go usage access was denied." },
            { displayName: "Cursor", hostName: "MacBook Pro (7)", status: "not_installed", message: null },
          ],
        },
      }),
    ).toEqual([opencode]);
    expect(parseFailures({ ok: false })).toEqual([]);
  });

  it("names each failed provider, or says that it is not known", () => {
    expect(describeFailures([opencode, { ...opencode, provider: "Grok", message: null }])).toBe(
      "opencode: OpenCode Go usage access was denied.\nGrok failed.",
    );
    expect(describeFailures([])).toBe("The provider that failed is not known.");
  });

  it("adds the failed provider and a dismiss button after bb's text", () => {
    const header = card(REFRESH_FAILED);
    decorateFailure(header, [opencode], "MacBook Pro (7)", memory());
    const children = [...status().children];
    expect(children.map((c) => c.tagName.toLowerCase())).toEqual(["svg", "span", "span", "button"]);
    expect(status().querySelector(".text")!.textContent).toBe(REFRESH_FAILED);
    expect(line()!.textContent).toBe("opencode: OpenCode Go usage access was denied.");
    expect(button()!.getAttribute("aria-label")).toBe("Dismiss this message");
  });

  it("hides the message on a tab whose provider did not fail", () => {
    const header = card(REFRESH_FAILED, "Claude Code");
    decorateFailure(header, [opencode], "MacBook Pro (7)", memory());
    expect(status().hasAttribute("data-usage-pace-other-tab")).toBe(true);
  });

  it("keeps the message, naming every failure, on the All accounts tab", () => {
    const tabs = ["All accounts", "Claude Code", "opencode", "Grok Build (usage)"];
    const header = card(REFRESH_FAILED, "All accounts", tabs);
    decorateFailure(header, [opencode], "MacBook Pro (7)", memory());
    expect(status().hasAttribute("data-usage-pace-other-tab")).toBe(false);
    expect(line()!.textContent).toBe("opencode: OpenCode Go usage access was denied.");
  });

  it("shows the message, with that provider's error only, on the failed provider's tab", () => {
    const grok = { ...opencode, provider: "Grok Build (usage)", message: "timed out" };
    const header = card(REFRESH_FAILED, "opencode");
    decorateFailure(header, [opencode, grok], "MacBook Pro (7)", memory());
    expect(status().hasAttribute("data-usage-pace-other-tab")).toBe(false);
    expect(line()!.textContent).toBe("opencode: OpenCode Go usage access was denied.");
  });

  it("puts a dot on each failed provider's tab", () => {
    const header = card(REFRESH_FAILED, "Claude Code");
    decorateFailure(header, [opencode], "MacBook Pro (7)", memory());
    const dotted = [...header.querySelectorAll("[data-usage-pace-failed-tab]")].map((t) => t.getAttribute("aria-label"));
    expect(dotted).toEqual(["opencode"]);
  });

  it("removes the dot when the provider no longer fails", () => {
    const header = card(REFRESH_FAILED, "Claude Code");
    decorateFailure(header, [opencode], "MacBook Pro (7)", memory());
    decorateFailure(header, [], "MacBook Pro (7)", memory());
    expect(header.querySelectorAll("[data-usage-pace-failed-tab]")).toHaveLength(0);
  });

  it("shows the message on every tab when no failed provider is known", () => {
    const header = card(REFRESH_FAILED, "Claude Code");
    decorateFailure(header, [], "MacBook Pro (7)", memory());
    expect(status().hasAttribute("data-usage-pace-other-tab")).toBe(false);
    expect(line()!.textContent).toBe("The provider that failed is not known.");
  });

  it("shows only the failures of the card's machine", () => {
    const header = card(REFRESH_FAILED);
    decorateFailure(header, [{ ...opencode, machine: "Studio" }], "MacBook Pro (7)", memory());
    expect(line()!.textContent).toBe("The provider that failed is not known.");
    expect(header.querySelectorAll("[data-usage-pace-failed-tab]")).toHaveLength(0);
  });

  it("hides the message on dismiss, and keeps it hidden for the same failure", () => {
    const storage = memory();
    const header = card(REFRESH_FAILED);
    decorateFailure(header, [opencode], "MacBook Pro (7)", storage);
    button()!.click();
    // mountCardPace's stylesheet hides a status with this attribute.
    expect(status().hasAttribute("data-usage-pace-dismissed")).toBe(true);

    // bb renders the card again.
    const again = card(REFRESH_FAILED);
    decorateFailure(again, [opencode], "MacBook Pro (7)", storage);
    expect(status().hasAttribute("data-usage-pace-dismissed")).toBe(true);
  });

  it("shows the message again when a different provider fails", () => {
    const storage = memory();
    const header = card(REFRESH_FAILED);
    decorateFailure(header, [opencode], "MacBook Pro (7)", storage);
    button()!.click();
    decorateFailure(header, [{ ...opencode, message: "timed out" }], "MacBook Pro (7)", storage);
    expect(status().hasAttribute("data-usage-pace-dismissed")).toBe(false);
    expect(line()!.textContent).toBe("opencode: timed out");
  });

  it("leaves other status messages alone", () => {
    const header = card("Loading usage\u2026");
    decorateFailure(header, [opencode], "MacBook Pro (7)", memory());
    expect(line()).toBeNull();
    expect(button()).toBeNull();
  });

  it("matches bb's shorter refresh text without the word usage", () => {
    const header = card("Couldn\u2019t refresh. Showing last update.");
    decorateFailure(header, [opencode], "MacBook Pro (7)", memory());
    expect(line()!.textContent).toBe("opencode: OpenCode Go usage access was denied.");
  });

  it("removes its additions when bb's message is no longer a failure", () => {
    const header = card(REFRESH_FAILED);
    decorateFailure(header, [opencode], "MacBook Pro (7)", memory());
    status().querySelector(".text")!.textContent = "No usage limits reported for this plan.";
    decorateFailure(header, [opencode], "MacBook Pro (7)", memory());
    expect(line()).toBeNull();
    expect(button()).toBeNull();
    expect(status().hasAttribute("data-usage-pace-failed")).toBe(false);
  });

  it("does not move its elements again when they are already last", () => {
    const header = card(REFRESH_FAILED);
    decorateFailure(header, [opencode], "MacBook Pro (7)", memory());
    const watch = new MutationObserver(() => {});
    watch.observe(status(), { childList: true, subtree: true, characterData: true });
    decorateFailure(header, [opencode], "MacBook Pro (7)", memory());
    expect(watch.takeRecords()).toHaveLength(0);
    watch.disconnect();
  });
});
