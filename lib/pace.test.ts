import { describe, expect, it } from "vitest";
import {
  describeDelta,
  describePace,
  formatBudget,
  formatDuration,
  formatMoment,
  formatRunsOut,
  paceFor,
  paceForWindows,
  windowDurationMs,
  windowLengths,
} from "./pace";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-09-24T06:20:00Z");
const at = (hoursFromNow: number) => new Date(NOW + hoursFromNow * HOUR).toISOString();

describe("windowDurationMs", () => {
  it.each([
    ["5h", 5 * HOUR],
    ["7d", 168 * HOUR],
    ["7d · Fable", 168 * HOUR],
    ["5-hour window", 5 * HOUR],
    ["Weekly", 168 * HOUR],
    ["Week (all models)", 168 * HOUR],
    ["Daily", 24 * HOUR],
    ["2 weeks", 336 * HOUR],
  ])("reads %s", (label, expected) => {
    expect(windowDurationMs(label)).toBe(expected);
  });

  it("returns null for a label without a length", () => {
    expect(windowDurationMs("Credits")).toBeNull();
    expect(windowDurationMs("Fable")).toBeNull();
  });

  it("reads a session as five hours", () => {
    expect(windowDurationMs("Current session")).toBe(5 * HOUR);
  });
});

describe("windowLengths", () => {
  // The labels Claude Code reports on a Max plan.
  const claude = [
    { label: "Current session", usedPercent: 25, resetsAt: "2026-09-24T10:59:59.770Z" },
    { label: "Weekly limit", usedPercent: 44, resetsAt: "2026-09-29T08:59:59.770Z" },
    { label: "Fable", usedPercent: 7, resetsAt: "2026-09-29T08:59:59.770Z" },
  ];

  it("gives a model window the length of the window with the same reset", () => {
    expect(windowLengths(claude)).toEqual([5 * HOUR, 168 * HOUR, 168 * HOUR]);
  });

  it("keeps null when no window resets at the same moment", () => {
    const lone = [{ label: "Fable", usedPercent: 7, resetsAt: "2026-09-29T08:59:59Z" }];
    expect(windowLengths(lone)).toEqual([null]);
    const noReset = [claude[1]!, { label: "Fable", usedPercent: 7, resetsAt: null }];
    expect(windowLengths(noReset)).toEqual([168 * HOUR, null]);
  });

  it("gives every window a pace", () => {
    const paces = paceForWindows(claude, NOW);
    expect(paces.every((pace) => pace !== null)).toBe(true);
    expect(paces[2]!.ratio).toBeCloseTo(7 / ((168 - 122.66) / 168) / 100, 2);
  });
});

describe("paceFor", () => {
  it("projects 42% used after 46 of 168 hours", () => {
    const pace = paceFor({ label: "7d", usedPercent: 42, resetsAt: at(122) }, NOW)!;
    expect(pace.elapsedFraction).toBeCloseTo(46 / 168);
    expect(pace.ratio).toBeCloseTo(1.534, 2);
    expect(pace.projectedPercent).toBeCloseTo(153.4, 1);
    expect((pace.runsOutAtMs! - NOW) / HOUR).toBeCloseTo((46 * 58) / 42);
    expect(pace.budgetPerHour * 24).toBeCloseTo((58 / 122) * 24);
    expect(pace.tone).toBe("critical");
  });

  it("does not run out when the rate is under even pace", () => {
    const pace = paceFor({ label: "7d", usedPercent: 20, resetsAt: at(84) }, NOW)!;
    expect(pace.ratio).toBeCloseTo(0.4);
    expect(pace.runsOutAtMs).toBeNull();
    expect(pace.tone).toBe("ok");
  });

  it("warns when the projection is close to the limit", () => {
    const pace = paceFor({ label: "7d", usedPercent: 45, resetsAt: at(84) }, NOW)!;
    expect(pace.projectedPercent).toBeCloseTo(90);
    expect(pace.tone).toBe("warning");
  });

  it("keeps the used-percent thresholds when the pace is fine", () => {
    const pace = paceFor({ label: "7d", usedPercent: 96, resetsAt: at(1) }, NOW)!;
    expect(pace.projectedPercent! <= 100).toBe(true);
    expect(pace.tone).toBe("critical");
  });

  it("does not judge the pace at the start of a window", () => {
    const pace = paceFor({ label: "7d", usedPercent: 3, resetsAt: at(165) }, NOW)!;
    expect(pace.ratio).toBeNull();
    expect(pace.projectedPercent).toBeNull();
    expect(pace.runsOutAtMs).toBeNull();
    expect(describePace(pace, NOW)).toMatch(/^too early to judge pace/);
  });

  it("reports a full window as already out", () => {
    const pace = paceFor({ label: "5h", usedPercent: 100, resetsAt: at(2) }, NOW)!;
    expect(pace.runsOutAtMs).toBe(NOW);
    expect(pace.budgetPerHour).toBe(0);
  });

  it("clamps a reset further away than the window length", () => {
    const pace = paceFor({ label: "5h", usedPercent: 10, resetsAt: at(9) }, NOW)!;
    expect(pace.elapsedFraction).toBe(0);
    expect(pace.ratio).toBeNull();
  });

  it("returns null without a length or a reset time", () => {
    expect(paceFor({ label: "Credits", usedPercent: 10, resetsAt: at(9) }, NOW)).toBeNull();
    expect(paceFor({ label: "7d", usedPercent: 10, resetsAt: null }, NOW)).toBeNull();
    expect(paceFor({ label: "7d", usedPercent: 10, resetsAt: "soon" }, NOW)).toBeNull();
  });
});

describe("formatting", () => {
  it("uses per-day budgets for long windows and per-hour for short ones", () => {
    const week = paceFor({ label: "7d", usedPercent: 42, resetsAt: at(122) }, NOW)!;
    expect(formatBudget(week)).toBe("11%/day");
    const session = paceFor({ label: "5h", usedPercent: 50, resetsAt: at(2) }, NOW)!;
    expect(formatBudget(session)).toBe("25%/h");
  });

  it("shows the weekday only when the moment is not today", () => {
    const tz = "Asia/Bangkok";
    expect(formatMoment(NOW + 2 * HOUR, NOW, tz)).toBe("15:20");
    expect(formatMoment(Date.parse("2026-09-26T21:52:00Z"), NOW, tz)).toBe("Sun 04:52");
  });

  it("describes the pace in one line", () => {
    const pace = paceFor({ label: "7d", usedPercent: 42, resetsAt: at(122) }, NOW)!;
    expect(describePace(pace, NOW, "Asia/Bangkok")).toBe(
      "runs out Sun 04:51, 2d 10h before reset · 1.5× pace · on track for 153% · budget 11%/day",
    );
  });

  it("leaves out the run-out part when the window lasts", () => {
    const pace = paceFor({ label: "7d", usedPercent: 20, resetsAt: at(84) }, NOW)!;
    expect(formatRunsOut(pace, NOW)).toBeNull();
    expect(describePace(pace, NOW)).toBe(
      "0.4× pace · on track for 40% · budget 23%/day",
    );
  });

  it("gives the long run-out date with the day and month", () => {
    const pace = paceFor({ label: "7d", usedPercent: 42, resetsAt: at(122) }, NOW)!;
    expect(formatRunsOut(pace, NOW, "Asia/Bangkok", true)).toBe("Sun 27 Sep, 04:51");
    const soon = paceFor({ label: "5h", usedPercent: 80, resetsAt: at(3) }, NOW)!;
    expect(formatRunsOut(soon, NOW, "Asia/Bangkok", true)).toBe("today, 13:50");
  });

  it("says now when the window is already full", () => {
    const pace = paceFor({ label: "5h", usedPercent: 100, resetsAt: at(2) }, NOW)!;
    expect(formatRunsOut(pace, NOW)).toBe("now");
    expect(formatDuration(pace.lockoutMs)).toBe("2h 0m");
  });

  it.each([
    [0, "0m"],
    [45 * 60_000, "45m"],
    [3 * HOUR + 12 * 60_000, "3h 12m"],
    [58.48 * HOUR, "2d 10h"],
  ])("formats %d ms as %s", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});

describe("describeDelta", () => {
  const TZ = "Asia/Bangkok";

  it("shows how far ahead of pace, and the time without quota", () => {
    const pace = paceFor({ label: "7d", usedPercent: 42, resetsAt: at(122) }, NOW)!;
    // 42 − 27.4 = 14.6 points; 14.6% of 168 h = 24.5 h.
    expect(describeDelta(pace, 42, NOW, TZ)).toEqual([
      "15% ahead of pace (1d 0h)",
      "runs out Sun 04:51 · 2d 10h without quota",
    ]);
  });

  it("shows how far under pace, and the budget that lasts", () => {
    const pace = paceFor({ label: "7d", usedPercent: 20, resetsAt: at(84) }, NOW)!;
    expect(describeDelta(pace, 20, NOW, TZ)).toEqual([
      "30% under pace (2d 2h)",
      "lasts to reset · budget 23%/day",
    ]);
  });

  it("says on pace inside one point", () => {
    const pace = paceFor({ label: "7d", usedPercent: 50.5, resetsAt: at(84) }, NOW)!;
    expect(describeDelta(pace, 50.5, NOW, TZ)[0]).toBe("on pace");
  });

  it("says too early at the start of a window", () => {
    const pace = paceFor({ label: "7d", usedPercent: 3, resetsAt: at(165) }, NOW)!;
    expect(describeDelta(pace, 3, NOW, TZ)[0]).toBe("too early to judge pace");
  });

  it("says out now when the window is full", () => {
    const pace = paceFor({ label: "5h", usedPercent: 100, resetsAt: at(2) }, NOW)!;
    expect(describeDelta(pace, 100, NOW, TZ)[1]).toBe("out now · 2h 0m without quota");
  });
});

describe("lockout", () => {
  it("is the time from running out to the reset", () => {
    const pace = paceFor({ label: "7d", usedPercent: 42, resetsAt: at(122) }, NOW)!;
    expect(pace.lockoutMs / HOUR).toBeCloseTo(122 - (46 * 58) / 42);
  });

  it("is zero when the window lasts", () => {
    const pace = paceFor({ label: "7d", usedPercent: 20, resetsAt: at(84) }, NOW)!;
    expect(pace.lockoutMs).toBe(0);
  });
});
