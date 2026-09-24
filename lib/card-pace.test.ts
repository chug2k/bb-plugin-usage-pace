// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { matchRow, mountCardPace, parseCardUsage, type CardProvider } from "./card-pace";

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

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    fetchMock = vi.fn(async () => new Response(JSON.stringify(cardResponse())));
    vi.stubGlobal("fetch", fetchMock);
    controller = new AbortController();
  });

  afterEach(() => {
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
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/v1/plugins/provider-usage/rpc/getUsage");
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
    expect(line.style.textAlign).toBe("right");
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
    expect(line.style.textAlign).toBe("left");
    expect(line.textContent).toMatch(/^15% ahead of pace/u);

    // What bb does on the second tap.
    row!.setAttribute("aria-expanded", "false");
    reset.remove();
    await frame();
    expect(detail(row!)).toBeNull();
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
