// Makes the Grok usage provider a source for bb's usage card.
//
// A registered provider with `maintenance.usage` is not enough: bb's
// provider-usage card lists the plugins that serve the discoverable
// `provider-usage.v1` RPC contract, and shows the resources they list. Each
// provider plugin serves it for its own providers (provider-acp,
// provider-claude-code, provider-codex), so this plugin serves it for
// `usage-pace-grok`: one resource per connected host where the provider is
// listed. The numbers come from the provider bridge (host.ts) through
// `bb.sdk.system.usageLimits`.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { GROK_PROVIDER_ID } from "./grok-provider";

const CACHE_MS = 5 * 60_000;

const planSchema = z
  .strictObject({ id: z.string().min(1), multiplier: z.number().int().positive().nullable() })
  .nullable();

const windowSchema = z.strictObject({
  kind: z.enum(["five-hour", "daily", "weekly", "custom"]),
  id: z.string().min(1),
  label: z.string().min(1),
  usedPercent: z.number().min(0),
  resetsAt: z.string().nullable(),
  model: z.string().nullable(),
  cost: z
    .strictObject({ usedUsdCents: z.number().min(0), limitUsdCents: z.number().positive() })
    .nullable(),
});

const account = {
  plan: planSchema,
  accountEmail: z.string().nullable(),
  planLabel: z.string().nullable(),
};

const usageSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ok"), ...account, windows: z.array(windowSchema) }),
  z.strictObject({ status: z.literal("not_installed"), ...account }),
  z.strictObject({ status: z.literal("unauthenticated"), ...account }),
  z.strictObject({ status: z.literal("expired"), ...account }),
  z.strictObject({ status: z.literal("error"), ...account, message: z.string() }),
]);

const resourceSchema = z.strictObject({
  accountKey: z.string().min(1).nullable(),
  id: z.string().min(1),
  providerId: z.string().min(1),
  label: z.string().min(1),
  scope: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("shared") }),
    z.strictObject({ kind: z.literal("host"), hostId: z.string().min(1), hostName: z.string().min(1) }),
  ]),
});

const getResourceOutput = z.strictObject({
  accountKey: z.string().min(1).nullable(),
  observedAt: z.number().int().min(0).nullable(),
  usage: usageSchema,
});

export type SourceUsage = z.infer<typeof usageSchema>;
export type SourceResource = z.infer<typeof getResourceOutput>;

export const grokUsageSourceContract = defineRpcContract({
  "provider-usage.v1.listResources": {
    experimental_description:
      "Grok Build usage from Usage Pace, one resource per host. Reads local metadata only.",
    input: z.object({}),
    output: z.strictObject({ resources: z.array(resourceSchema) }),
  },
  "provider-usage.v1.getResource": {
    experimental_description:
      "Grok Build credit usage for one host. False permits a cached measurement.",
    input: z.object({ resourceId: z.string().min(1), refresh: z.boolean() }),
    output: getResourceOutput,
  },
});

const RESOURCE_PREFIX = "grok:";

type UsageLimits = Awaited<ReturnType<BbPluginApi["sdk"]["system"]["usageLimits"]>>;
type RawUsage = NonNullable<UsageLimits[string]>;

function windowKind(label: string): z.infer<typeof windowSchema>["kind"] {
  if (/\bweek(ly)?\b|\b7\s*d\b/iu.test(label)) return "weekly";
  if (/\bdaily\b|\b1\s*d\b/iu.test(label)) return "daily";
  if (/\bfive[- ]hour\b|\b5\s*h/iu.test(label)) return "five-hour";
  return "custom";
}

function windowId(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "") || "window";
}

/** The usage bb reports for a provider, in the provider-usage.v1 shape. */
export function toSourceUsage(raw: RawUsage | undefined): SourceUsage {
  const empty = { plan: null, accountEmail: null, planLabel: null };
  if (raw === undefined) return { status: "error", ...empty, message: "No usage reported." };
  switch (raw.status) {
    case "ok":
      return {
        status: "ok",
        plan: null,
        accountEmail: raw.accountEmail,
        planLabel: raw.planLabel,
        windows: raw.windows.map((window) => ({
          kind: windowKind(window.label),
          id: windowId(window.label),
          label: window.label,
          usedPercent: Math.max(0, window.usedPercent),
          resetsAt: window.resetsAt,
          model: null,
          cost:
            window.cost && window.cost.limitUsdCents > 0
              ? { usedUsdCents: Math.max(0, window.cost.usedUsdCents), limitUsdCents: window.cost.limitUsdCents }
              : null,
        })),
      };
    case "error":
      return { status: "error", ...empty, message: raw.message };
    default:
      return { status: raw.status, ...empty };
  }
}

export function createGrokUsageSource(
  bb: Pick<BbPluginApi, "sdk">,
  now: () => number = Date.now,
) {
  const cache = new Map<string, { at: number; value: SourceResource }>();
  const lastSuccess = new Map<string, number>();

  async function listResources() {
    const hosts = await bb.sdk.hosts.list();
    const resources: z.infer<typeof resourceSchema>[] = [];
    for (const host of hosts) {
      if (host.status === "disconnected") continue;
      // The provider has `experimental_visibility: "installed"`, so bb lists
      // it only on hosts where the grok command is installed.
      const listed = await bb.sdk.providers
        .list({ hostId: host.id, capability: "usage" })
        .then((providers) => providers.some((provider) => provider.id === GROK_PROVIDER_ID))
        .catch(() => false);
      if (!listed) continue;
      resources.push({
        accountKey: null,
        id: `${RESOURCE_PREFIX}${host.id}`,
        providerId: GROK_PROVIDER_ID,
        label: "Grok Build (usage)",
        scope: { kind: "host", hostId: host.id, hostName: host.name },
      });
    }
    return { resources };
  }

  async function getResource({ resourceId, refresh }: { resourceId: string; refresh: boolean }) {
    if (!resourceId.startsWith(RESOURCE_PREFIX)) throw new Error(`Unknown resource: ${resourceId}`);
    const hostId = resourceId.slice(RESOURCE_PREFIX.length);
    const cached = cache.get(resourceId);
    if (!refresh && cached !== undefined && now() - cached.at < CACHE_MS) return cached.value;

    let usage: SourceUsage;
    try {
      const limits = await bb.sdk.system.usageLimits({ hostId });
      usage = toSourceUsage(limits[GROK_PROVIDER_ID]);
    } catch (cause) {
      usage = {
        status: "error",
        plan: null,
        accountEmail: null,
        planLabel: null,
        message: cause instanceof Error ? cause.message : "Grok Build usage could not be read.",
      };
    }
    if (usage.status === "ok") lastSuccess.set(resourceId, now());
    const value: SourceResource = {
      accountKey: null,
      observedAt: lastSuccess.get(resourceId) ?? null,
      usage,
    };
    cache.set(resourceId, { at: now(), value });
    return value;
  }

  return {
    "provider-usage.v1.listResources": () => listResources(),
    "provider-usage.v1.getResource": getResource,
  };
}
