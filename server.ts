// bb-plugin-usage-pace — backend entry. Forked from Usage Bar by Dmitrii
// Kapustin (MIT).
//
// Reads agent-provider usage limits (weekly windows and friends) through
// bb.sdk.system.usageLimits, caches them per host, and exposes them to the
// frontend over RPC and to shells/agents via `bb usage-pace`. Pace is not
// cached: it depends on the current time, so each reader computes it.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { describePace, paceForWindows } from "./lib/pace";
import { createTokenTotals } from "./lib/token-totals";

const windowSchema = z.object({
  label: z.string(),
  usedPercent: z.number(),
  resetsAt: z.string().nullable(),
  /** True when the label looks like a 7-day / weekly window. */
  weekly: z.boolean(),
});
export type UsageWindow = z.infer<typeof windowSchema>;

const providerSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  hostId: z.string(),
  hostName: z.string(),
  logoUrl: z.string().nullable(),
  icon: z.object({ glyph: z.string() }).nullable(),
  iconTint: z.object({ light: z.string(), dark: z.string() }).nullable(),
  status: z.enum(["ok", "not_installed", "unauthenticated", "expired", "error"]),
  message: z.string().nullable(),
  accountEmail: z.string().nullable(),
  planLabel: z.string().nullable(),
  windows: z.array(windowSchema),
});
export type UsageProvider = z.infer<typeof providerSchema>;

const snapshotSchema = z.object({
  providers: z.array(providerSchema),
  fetchedAt: z.string(),
  error: z.string().nullable(),
  /** The `showStrip` setting, sent with the snapshot so the app can read it. */
  showStrip: z.boolean().optional(),
});
export type UsageSnapshot = z.infer<typeof snapshotSchema>;

export const rpcContract = defineRpcContract({
  getTokens: {
    input: z.object({ timeZone: z.string().max(100), force: z.boolean().optional() }),
    output: z.object({ day: z.number(), month: z.number(), timeZone: z.string(), fetchedAt: z.string().nullable(), error: z.string().nullable() }),
  },
  getUsage: {
    input: z.object({ force: z.boolean().optional() }).nullable(),
    output: snapshotSchema,
  },
});

const WEEKLY_PATTERN = /(week|7\s*[-‑]?\s*day|7d\b|weekly)/iu;

export function isWeeklyLabel(label: string): boolean {
  return WEEKLY_PATTERN.test(label);
}

type Host = Awaited<ReturnType<BbPluginApi["sdk"]["hosts"]["list"]>>[number];
type Provider = Awaited<
  ReturnType<BbPluginApi["sdk"]["providers"]["list"]>
>[number];
type UsageResponse = Awaited<
  ReturnType<BbPluginApi["sdk"]["system"]["usageLimits"]>
>;

function normalizeProvider(
  host: Host,
  provider: Provider,
  usage: UsageResponse[string] | undefined,
): UsageProvider {
  const tint = provider.strings?.iconTint;
  const base = {
    id: provider.id,
    displayName: provider.displayName,
    hostId: host.id,
    hostName: host.name,
    logoUrl: provider.logoUrl ?? null,
    icon: provider.icon?.glyph ? { glyph: provider.icon.glyph } : null,
    iconTint: tint ? { light: tint.light, dark: tint.dark } : null,
    accountEmail: null,
    planLabel: null,
    message: null,
    windows: [] as UsageWindow[],
  };
  if (usage === undefined) {
    return { ...base, status: "error", message: "No usage reported." };
  }
  switch (usage.status) {
    case "ok":
      return {
        ...base,
        status: "ok",
        accountEmail: usage.accountEmail,
        planLabel: usage.planLabel,
        windows: usage.windows.map((window) => ({
          label: window.label,
          usedPercent: Math.max(0, Math.min(100, window.usedPercent)),
          resetsAt: window.resetsAt,
          weekly: isWeeklyLabel(window.label),
        })),
      };
    case "error":
      return { ...base, status: "error", message: usage.message };
    default:
      return { ...base, status: usage.status };
  }
}

export default async function plugin(bb: BbPluginApi) {
  const getTokens = createTokenTotals(bb);
  const settings = bb.settings.define({
    cacheMinutes: {
      type: "number",
      label: "Cache usage for (minutes)",
      default: 5,
    },
    showStrip: {
      type: "boolean",
      label: "Also show the Usage Pace strip above the sidebar footer",
      default: false,
    },
  });
  let cacheMs = 5 * 60_000;
  let showStrip = false;
  const applySettings = async () => {
    const values = await settings.get();
    cacheMs = Math.max(0.5, Number(values.cacheMinutes) || 5) * 60_000;
    showStrip = values.showStrip === true;
  };
  await applySettings();
  settings.onChange?.(() => {
    void applySettings().then(() => {
      bb.realtime.publish("usage-changed", { fetchedAt: new Date().toISOString() });
    });
  });

  let cached: { at: number; snapshot: UsageSnapshot; dirty: boolean } | null =
    null;
  let pending: Promise<UsageSnapshot> | null = null;

  async function loadSnapshot(): Promise<UsageSnapshot> {
    const providers: UsageProvider[] = [];
    let error: string | null = null;
    let hosts: Host[] = [];
    try {
      hosts = await bb.sdk.hosts.list();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    await Promise.all(
      hosts.map(async (host) => {
        if (host.status === "disconnected") return;
        try {
          const [list, usage] = await Promise.all([
            bb.sdk.providers.list({ hostId: host.id, capability: "usage" }),
            bb.sdk.system.usageLimits({ hostId: host.id }),
          ]);
          for (const provider of list) {
            providers.push(normalizeProvider(host, provider, usage[provider.id]));
          }
        } catch (cause) {
          error ??= `${host.name}: ${
            cause instanceof Error ? cause.message : String(cause)
          }`;
        }
      }),
    );
    providers.sort((a, b) => a.displayName.localeCompare(b.displayName));
    return { providers, fetchedAt: new Date().toISOString(), error };
  }

  async function getUsage(force: boolean): Promise<UsageSnapshot> {
    const maxAge = cached?.dirty ? Math.min(cacheMs, 60_000) : cacheMs;
    if (!force && cached !== null && Date.now() - cached.at < maxAge) {
      return cached.snapshot;
    }
    if (pending !== null) return pending;
    pending = loadSnapshot()
      .then((snapshot) => {
        cached = { at: Date.now(), snapshot, dirty: false };
        bb.realtime.publish("usage-changed", { fetchedAt: snapshot.fetchedAt });
        return snapshot;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  }

  const markDirty = () => {
    if (cached !== null) cached.dirty = true;
  };
  bb.events.on("thread.idle", markDirty);
  bb.events.on("thread.failed", markDirty);

  bb.rpc.register(rpcContract, {
    getTokens: (input) => getTokens(input.timeZone, input.force),
    getUsage: async (input) => ({
      ...(await getUsage(input?.force === true)),
      showStrip,
    }),
  });

  function formatReset(resetsAt: string | null): string {
    if (resetsAt === null) return "";
    const ms = new Date(resetsAt).getTime() - Date.now();
    if (!Number.isFinite(ms) || ms <= 0) return "resets now";
    const hours = Math.floor(ms / 3_600_000);
    const days = Math.floor(hours / 24);
    const rest = hours % 24;
    const minutes = Math.floor((ms % 3_600_000) / 60_000);
    if (days > 0) return `resets in ${days}d ${rest}h`;
    if (hours > 0) return `resets in ${hours}h ${minutes}m`;
    return `resets in ${minutes}m`;
  }

  function formatSnapshot(snapshot: UsageSnapshot, weeklyOnly: boolean): string {
    const lines: string[] = [];
    for (const provider of snapshot.providers) {
      if (provider.status !== "ok") {
        lines.push(
          `${provider.displayName} (${provider.hostName}): ${provider.status}${
            provider.message ? ` — ${provider.message}` : ""
          }`,
        );
        continue;
      }
      // Pace needs every window: a window can take its length from a sibling.
      const paces = paceForWindows(provider.windows);
      const shown = provider.windows
        .map((window, index) => ({ window, pace: paces[index]! }))
        .filter(({ window }) => !weeklyOnly || window.weekly);
      if (shown.length === 0) continue;
      lines.push(
        `${provider.displayName}${provider.planLabel ? ` · ${provider.planLabel}` : ""} (${provider.hostName})`,
      );
      for (const { window, pace } of shown) {
        lines.push(
          `  ${window.label.padEnd(18)} ${String(Math.round(window.usedPercent)).padStart(3)}%  ${formatReset(window.resetsAt)}`,
        );
        const paceText = describePace(pace);
        if (paceText) lines.push(`  ${"".padEnd(18)} ${paceText}`);
      }
    }
    if (snapshot.error) lines.push(`warning: ${snapshot.error}`);
    return lines.length === 0 ? "No usage available." : lines.join("\n");
  }

  const usageText = [
    "Usage:",
    "  bb usage-pace [--all] [--force] [--json]",
    "",
    "  --tokens total tokens across BB for today and this month (JSON)",
    "  --all    show every window, not only weekly ones",
    "  --force  bypass the cache and query providers now",
    "  --json   machine-readable output; each window has a `pace` field",
  ].join("\n");

  bb.cli.register({
    name: "usage-pace",
    summary: "Show agent-provider usage limits and pace (weekly windows by default)",
    commands: [
      {
        name: "show",
        summary: "Print usage windows with pace",
        usage: "bb usage-pace [show] [--all] [--force] [--json]",
      },
    ],
    async run(argv) {
      if (argv.includes("--tokens")) {
        const snapshot = await getTokens(Intl.DateTimeFormat().resolvedOptions().timeZone, argv.includes("--force"));
        return { exitCode: snapshot.error ? 1 : 0, stdout: JSON.stringify(snapshot) };
      }
      const flags = new Set(argv.filter((arg) => arg.startsWith("--")));
      const positional = argv.filter((arg) => !arg.startsWith("--"));
      if (positional[0] === "help" || flags.has("--help")) {
        return { exitCode: 0, stdout: usageText };
      }
      if (positional.length > 0 && positional[0] !== "show") {
        return { exitCode: 1, stderr: usageText };
      }
      const snapshot = await getUsage(flags.has("--force"));
      if (flags.has("--json")) {
        const withPace = {
          ...snapshot,
          providers: snapshot.providers.map((provider) => {
            const paces = paceForWindows(provider.windows);
            return {
              ...provider,
              windows: provider.windows.map((window, index) => ({
                ...window,
                pace: paces[index]!,
              })),
            };
          }),
        };
        return { exitCode: 0, stdout: JSON.stringify(withPace) };
      }
      return {
        exitCode: 0,
        stdout: formatSnapshot(snapshot, !flags.has("--all")),
      };
    },
  });

  bb.onDispose(() => {
    cached = null;
  });
}
