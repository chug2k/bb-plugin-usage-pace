// Pace: is the current burn rate going to last until the window resets?
//
// Providers report only `usedPercent` and `resetsAt`. The window length comes
// from the label ("5h", "7d · Fable", "Weekly", "5-hour window"), so the
// start of the window is `resetsAt - length`. Everything else is a
// straight-line projection from the start of the window to now.

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Before this share of the window has passed, the rate is mostly noise. */
export const MIN_ELAPSED_FRACTION = 0.05;

export type Tone = "ok" | "warning" | "critical";

export interface PaceInput {
  label: string;
  usedPercent: number;
  resetsAt: string | null;
}

export interface Pace {
  windowMs: number;
  resetsAtMs: number;
  /** Share of the window that has passed, 0..1. */
  elapsedFraction: number;
  /** Used percent ÷ even-pace percent. 1 = on pace. Null while too early. */
  ratio: number | null;
  /** Used percent at the reset if the rate stays the same. Null while too early. */
  projectedPercent: number | null;
  /** When usage reaches 100% at this rate, if that is before the reset. */
  runsOutAtMs: number | null;
  /** Time with no quota: from running out to the reset. 0 when it lasts. */
  lockoutMs: number;
  /** Percent per hour that lasts exactly until the reset. */
  budgetPerHour: number;
  tone: Tone;
}

const UNIT_MS: Record<string, number> = {
  h: HOUR_MS,
  hr: HOUR_MS,
  hrs: HOUR_MS,
  hour: HOUR_MS,
  hours: HOUR_MS,
  d: DAY_MS,
  day: DAY_MS,
  days: DAY_MS,
  w: 7 * DAY_MS,
  wk: 7 * DAY_MS,
  week: 7 * DAY_MS,
  weeks: 7 * DAY_MS,
};

const DURATION_PATTERN =
  /(\d+(?:\.\d+)?)\s*[-‑]?\s*(hours?|hrs?|h|days?|d|weeks?|wk|w)\b/iu;

/** Window length from a provider label, or null when the label has none. */
export function windowDurationMs(label: string): number | null {
  const match = DURATION_PATTERN.exec(label);
  if (match !== null) {
    const unit = UNIT_MS[match[2]!.toLowerCase()];
    const amount = Number(match[1]);
    if (unit !== undefined && amount > 0) return amount * unit;
  }
  if (/\bweek(ly)?\b/iu.test(label)) return 7 * DAY_MS;
  if (/\bdaily\b/iu.test(label)) return DAY_MS;
  // Claude Code and Codex both call their five-hour window a "session".
  if (/\bsession\b/iu.test(label)) return 5 * HOUR_MS;
  return null;
}

/** Two windows that reset within this interval share one length. */
const SAME_RESET_MS = HOUR_MS;

/**
 * Window lengths for all windows of one provider. A window whose label has
 * no length ("Fable") takes the length of a window that resets at the same
 * moment ("Weekly limit").
 */
export function windowLengths(windows: readonly PaceInput[]): (number | null)[] {
  const fromLabels = windows.map((window) => windowDurationMs(window.label));
  const resets = windows.map((window) =>
    window.resetsAt === null ? Number.NaN : new Date(window.resetsAt).getTime(),
  );
  return fromLabels.map((length, index) => {
    if (length !== null || !Number.isFinite(resets[index]!)) return length;
    const sibling = fromLabels.findIndex(
      (other, j) =>
        other !== null && Math.abs(resets[j]! - resets[index]!) < SAME_RESET_MS,
    );
    return sibling === -1 ? null : fromLabels[sibling]!;
  });
}

/** Pace for all windows of one provider, in the same order. */
export function paceForWindows(
  windows: readonly PaceInput[],
  now = Date.now(),
): (Pace | null)[] {
  const lengths = windowLengths(windows);
  return windows.map((window, index) => paceFor(window, now, lengths[index]!));
}

function worse(a: Tone, b: Tone): Tone {
  const rank: Record<Tone, number> = { ok: 0, warning: 1, critical: 2 };
  return rank[a] >= rank[b] ? a : b;
}

/** Tone from the used percent alone: the thresholds Usage Bar used. */
export function toneForUsed(percent: number): Tone {
  if (percent >= 95) return "critical";
  if (percent >= 80) return "warning";
  return "ok";
}

export function toneForProjection(projected: number | null): Tone {
  if (projected === null) return "ok";
  if (projected > 100) return "critical";
  if (projected > 85) return "warning";
  return "ok";
}

export function paceFor(
  window: PaceInput,
  now = Date.now(),
  windowMs = windowDurationMs(window.label),
): Pace | null {
  if (windowMs === null || window.resetsAt === null) return null;
  const resetsAtMs = new Date(window.resetsAt).getTime();
  if (!Number.isFinite(resetsAtMs)) return null;

  const used = Math.max(0, Math.min(100, window.usedPercent));
  const remainingMs = Math.max(0, Math.min(windowMs, resetsAtMs - now));
  const elapsedMs = windowMs - remainingMs;
  const elapsedFraction = elapsedMs / windowMs;
  const early = elapsedFraction < MIN_ELAPSED_FRACTION;

  const ratio = early ? null : used / (elapsedFraction * 100);
  const projectedPercent = early ? null : used / elapsedFraction;

  let runsOutAtMs: number | null = null;
  if (used >= 100) {
    runsOutAtMs = now;
  } else if (!early && used > 0) {
    const atMs = now + (elapsedMs * (100 - used)) / used;
    if (atMs < resetsAtMs) runsOutAtMs = atMs;
  }

  const budgetPerHour =
    remainingMs > 0 ? ((100 - used) * HOUR_MS) / remainingMs : 0;

  return {
    windowMs,
    resetsAtMs,
    elapsedFraction,
    ratio,
    projectedPercent,
    runsOutAtMs,
    lockoutMs: runsOutAtMs === null ? 0 : Math.max(0, resetsAtMs - runsOutAtMs),
    budgetPerHour,
    tone: worse(toneForUsed(used), toneForProjection(projectedPercent)),
  };
}

/** The two largest units: "2d 9h", "3h 12m", "45m". */
export function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** "1.5×". */
export function formatRatio(ratio: number): string {
  return `${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}×`;
}

/** "11%/day" for windows of two days or more, else "4.2%/h". */
export function formatBudget(pace: Pace): string {
  if (pace.windowMs >= 2 * DAY_MS) {
    const perDay = pace.budgetPerHour * 24;
    return `${perDay >= 10 ? Math.round(perDay) : perDay.toFixed(1)}%/day`;
  }
  const perHour = pace.budgetPerHour;
  return `${perHour >= 10 ? Math.round(perHour) : perHour.toFixed(1)}%/h`;
}

/**
 * "Sun 05:00" in the local time zone; only "05:00" when it is today.
 * The long form adds the date: "Sun 27 Sep, 05:00" or "today, 05:00".
 */
export function formatMoment(
  atMs: number,
  now = Date.now(),
  timeZone?: string,
  long = false,
): string {
  const day = (ms: number) =>
    new Intl.DateTimeFormat("en-CA", { timeZone, dateStyle: "short" }).format(ms);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
  }).format(atMs);
  const today = day(atMs) === day(now);
  if (!long) {
    if (today) return time;
    const weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(atMs);
    return `${weekday} ${time}`;
  }
  if (today) return `today, ${time}`;
  const part = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-US", { timeZone, ...options }).format(atMs);
  const date = `${part({ weekday: "short" })} ${part({ day: "numeric" })} ${part({ month: "short" })}`;
  return `${date}, ${time}`;
}

/**
 * The estimated moment the window runs out at the current rate: "Sat 23:59",
 * or "now" when it is already full. Null when the window lasts to the reset.
 */
export function formatRunsOut(
  pace: Pace | null,
  now = Date.now(),
  timeZone?: string,
  long = false,
): string | null {
  if (pace === null || pace.runsOutAtMs === null) return null;
  if (pace.runsOutAtMs <= now) return "now";
  return formatMoment(pace.runsOutAtMs, now, timeZone, long);
}

/** Pace details without the run-out moment: "1.6× pace · on track for 162% · budget 11%/day". */
export function describeRate(pace: Pace | null): string {
  if (pace === null) return "";
  const budget = `budget ${formatBudget(pace)}`;
  if (pace.ratio === null || pace.projectedPercent === null) {
    return `too early to judge pace · ${budget}`;
  }
  return [
    `${formatRatio(pace.ratio)} pace`,
    `on track for ${Math.round(pace.projectedPercent)}%`,
    budget,
  ].join(" · ");
}

/** Below this many percentage points from even pace, the window is on pace. */
const ON_PACE_POINTS = 1;

/**
 * The difference from even pace, and what it costs. Two lines:
 *   "17% ahead of pace (1d 4h)"
 *   "runs out Sun 00:03 · 2d 15h without quota"
 */
export function describeDelta(
  pace: Pace,
  usedPercent: number,
  now = Date.now(),
  timeZone?: string,
): [string, string] {
  if (pace.ratio === null) {
    return ["too early to judge pace", `budget ${formatBudget(pace)}`];
  }
  const points = usedPercent - pace.elapsedFraction * 100;
  const ahead = formatDuration((Math.abs(points) / 100) * pace.windowMs);
  const first =
    Math.abs(points) < ON_PACE_POINTS
      ? "on pace"
      : points > 0
        ? `${Math.round(points)}% ahead of pace (${ahead})`
        : `${Math.round(-points)}% under pace (${ahead})`;
  const runsOut = formatRunsOut(pace, now, timeZone);
  const second =
    runsOut === null
      ? `lasts to reset · budget ${formatBudget(pace)}`
      : runsOut === "now"
        ? `out now · ${formatDuration(pace.lockoutMs)} without quota`
        : `runs out ${runsOut} · ${formatDuration(pace.lockoutMs)} without quota`;
  return [first, second];
}

/** One line for tooltips and the CLI. */
export function describePace(pace: Pace | null, now = Date.now(), timeZone?: string): string {
  const rate = describeRate(pace);
  const runsOut = formatRunsOut(pace, now, timeZone);
  if (pace === null || runsOut === null) return rate;
  const lockout = `${formatDuration(pace.lockoutMs)} before reset`;
  return `runs out ${runsOut}, ${lockout} · ${rate}`;
}
