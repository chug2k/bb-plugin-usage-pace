// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageProvider } from "../server";
import { matchRow, mountCardPace } from "./card-pace";
import { refreshUsage } from "./usage-store";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-09-24T06:20:00Z");
const at = (hoursFromNow: number) => new Date(NOW + hoursFromNow * HOUR).toISOString();

function claude(hostName: string, weeklyUsed = 42): UsageProvider {
  return {
    id: "claude-code",
    displayName: "Claude Code",
    hostId: `host-${hostName}`,
    hostName,
    logoUrl: null,
    icon: null,
    iconTint: null,
    status: "ok",
    message: null,
    accountEmail: "me@example.com",
    planLabel: "Max (5x)",
    windows: [
      { label: "Current session", usedPercent: 5, resetsAt: at(4), weekly: false },
      { label: "Weekly limit", usedPercent: weeklyUsed, resetsAt: at(122), weekly: true },
      { label: "Fable", usedPercent: 7, resetsAt: at(122), weekly: false },
    ],
  };
}

describe("matchRow", () => {
  const providers = [claude("MacBook Pro (7)"), claude("Studio", 90)];

  it("matches the row label on the selected provider and machine", () => {
    const match = matchRow(
      providers,
      "Claude Code",
      "MacBook Pro (7)",
      "Weekly limit: 42% used. Resets Tue 3:59 PM",
      NOW,
    )!;
    expect(match.usedPercent).toBe(42);
    expect(match.pace.elapsedFraction).toBeCloseTo(46 / 168);
  });

  it("uses the percent the card shows, not the cached one", () => {
    const match = matchRow(providers, "Claude Code", "MacBook Pro (7)", "Weekly limit: 44% used. x", NOW)!;
    expect(match.usedPercent).toBe(44);
    expect(match.pace.projectedPercent).toBeCloseTo(44 / (46 / 168));
  });

  it("picks the host by machine name", () => {
    const match = matchRow(providers, "Claude Code", "Studio", "Weekly limit: 90% used. x", NOW)!;
    expect(match.usedPercent).toBe(90);
  });

  it("falls back to any host when the machine name does not match", () => {
    expect(matchRow(providers, "Claude Code", "Renamed Mac", "Fable: 7% used. x", NOW)).not.toBeNull();
  });

  it("gives a model window the weekly length", () => {
    const match = matchRow(providers, "Claude Code", null, "Fable: 7% used. x", NOW)!;
    expect(match.pace.windowMs).toBe(168 * HOUR);
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
        <button aria-label="Usage machine: MacBook Pro (7)"></button>
      </div>
      <div class="grid">
        ${rows
          .map(
            ({ label, used }) => `
          <button type="button" aria-expanded="false" aria-label="${label}: ${used}% used. Resets Tue 3:59 PM">
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
  let unmount: () => void;

  beforeEach(async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            ok: true,
            result: { providers: [claude("MacBook Pro (7)")], fetchedAt: at(0), error: null },
          }),
        ),
      ),
    );
    await refreshUsage({ force: true });
    controller = new AbortController();
  });

  afterEach(() => {
    unmount?.();
    controller.abort();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

  it("adds an even-pace tick to each bar and a delta line under each row", async () => {
    renderCard([
      { label: "Weekly limit", used: 42 },
      { label: "Fable", used: 7 },
    ]);
    unmount = mountCardPace({ signal: controller.signal });
    await frame();

    const rows = document.querySelectorAll<HTMLElement>("button[aria-expanded]");
    const weekly = rows[0]!;
    const tick = weekly.querySelector<HTMLElement>(".bar > [data-usage-pace-tick]")!;
    expect(tick).not.toBeNull();
    expect(Number.parseFloat(tick.style.left)).toBeCloseTo((46 / 168) * 100, 1);
    expect(weekly.querySelector<HTMLElement>(".bar")!.style.position).toBe("relative");

    const delta = weekly.querySelector(":scope > [data-usage-pace-delta]")!;
    expect(delta.textContent).toMatch(/^15% ahead of pace \(1d 0h\)\nruns out .+ · 2d 10h without quota$/u);

    expect(rows[1]!.querySelector("[data-usage-pace-delta]")!.textContent).toMatch(/under pace/u);
  });

  it("puts the delta after the row grid, so React's own children keep their order", async () => {
    renderCard([{ label: "Weekly limit", used: 42 }]);
    unmount = mountCardPace({ signal: controller.signal });
    await frame();
    const row = document.querySelector("button[aria-expanded]")!;
    expect(row.children[0]!.className).toBe("grid");
    expect(row.children[1]!.hasAttribute("data-usage-pace-delta")).toBe(true);
  });

  it("does not add anything twice when the card changes", async () => {
    renderCard([{ label: "Weekly limit", used: 42 }]);
    unmount = mountCardPace({ signal: controller.signal });
    await frame();
    document.querySelector(".fill")!.setAttribute("style", "width:43%");
    document.body.appendChild(document.createElement("div"));
    await frame();
    expect(document.querySelectorAll("[data-usage-pace-tick]")).toHaveLength(1);
    expect(document.querySelectorAll("[data-usage-pace-delta]")).toHaveLength(1);
  });

  it("removes its nodes and style on unmount", async () => {
    renderCard([{ label: "Weekly limit", used: 42 }]);
    unmount = mountCardPace({ signal: controller.signal });
    await frame();
    unmount();
    expect(document.querySelectorAll("[data-usage-pace-tick], [data-usage-pace-delta]")).toHaveLength(0);
    expect(document.getElementById("usage-pace-card-style")).toBeNull();
  });
});
