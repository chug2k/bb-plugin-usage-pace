import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { GROK_PROVIDER_ID } from "./grok-provider";
import { createGrokUsageSource, grokUsageSourceContract, toSourceUsage } from "./grok-usage-source";

const okUsage = {
  status: "ok" as const,
  accountEmail: "me@example.com",
  planLabel: "SuperGrok",
  windows: [{ label: "Weekly credits", usedPercent: 5, resetsAt: "2026-10-02T15:33:24.482Z" }],
};

function fakeBb(usage: unknown = okUsage) {
  const usageLimits = vi.fn(async () => ({ [GROK_PROVIDER_ID]: usage }));
  const bb = {
    sdk: {
      hosts: {
        list: vi.fn(async () => [
          { id: "host_a", name: "MacBook Pro (7)", status: "connected" },
          { id: "host_b", name: "Studio", status: "connected" },
          { id: "host_c", name: "Old Mac", status: "disconnected" },
        ]),
      },
      providers: {
        // Grok is installed on host_a only.
        list: vi.fn(async ({ hostId }: { hostId: string }) =>
          hostId === "host_a" ? [{ id: "claude-code" }, { id: GROK_PROVIDER_ID }] : [{ id: "claude-code" }],
        ),
      },
      system: { usageLimits },
    },
  };
  return { bb: bb as never, usageLimits };
}

type Handlers = ReturnType<typeof createGrokUsageSource>;
const LIST = "provider-usage.v1.listResources";
const GET = "provider-usage.v1.getResource";

/** Calls a handler the way bb does: input and output checked by the contract. */
function call(handlers: Handlers, method: typeof LIST, input: unknown): Promise<z.infer<typeof grokUsageSourceContract[typeof LIST]["output"]>>;
function call(handlers: Handlers, method: typeof GET, input: unknown): Promise<z.infer<typeof grokUsageSourceContract[typeof GET]["output"]>>;
async function call(handlers: Handlers, method: typeof LIST | typeof GET, input: unknown) {
  if (method === LIST) {
    grokUsageSourceContract[LIST].input.parse(input);
    return grokUsageSourceContract[LIST].output.parse(await handlers[LIST]());
  }
  const parsed = grokUsageSourceContract[GET].input.parse(input);
  return grokUsageSourceContract[GET].output.parse(await handlers[GET](parsed));
}

describe("Grok usage source", () => {
  it("lists one resource per connected host where Grok is installed", async () => {
    const { bb } = fakeBb();
    const out = await call(createGrokUsageSource(bb), "provider-usage.v1.listResources", {});
    expect(out.resources).toEqual([
      {
        accountKey: null,
        id: "grok:host_a",
        providerId: GROK_PROVIDER_ID,
        label: "Grok Build (usage)",
        scope: { kind: "host", hostId: "host_a", hostName: "MacBook Pro (7)" },
      },
    ]);
  });

  it("does not contact the provider to list resources", async () => {
    const { bb, usageLimits } = fakeBb();
    await call(createGrokUsageSource(bb), "provider-usage.v1.listResources", {});
    expect(usageLimits).not.toHaveBeenCalled();
  });

  it("returns the host's Grok usage in the provider-usage.v1 shape", async () => {
    const { bb, usageLimits } = fakeBb();
    const out = await call(createGrokUsageSource(bb, () => 1_000), "provider-usage.v1.getResource", {
      resourceId: "grok:host_a",
      refresh: false,
    });
    expect(usageLimits).toHaveBeenCalledWith({ hostId: "host_a" });
    expect(out).toEqual({
      accountKey: null,
      observedAt: 1_000,
      usage: {
        status: "ok",
        plan: null,
        accountEmail: "me@example.com",
        planLabel: "SuperGrok",
        windows: [
          {
            kind: "weekly",
            id: "weekly-credits",
            label: "Weekly credits",
            usedPercent: 5,
            resetsAt: "2026-10-02T15:33:24.482Z",
            model: null,
            cost: null,
          },
        ],
      },
    });
  });

  it("answers from its cache for five minutes unless asked to refresh", async () => {
    let now = 0;
    const { bb, usageLimits } = fakeBb();
    const handlers = createGrokUsageSource(bb, () => now);
    const input = { resourceId: "grok:host_a", refresh: false };
    await call(handlers, "provider-usage.v1.getResource", input);
    now = 60_000;
    await call(handlers, "provider-usage.v1.getResource", input);
    expect(usageLimits).toHaveBeenCalledTimes(1);
    await call(handlers, "provider-usage.v1.getResource", { ...input, refresh: true });
    expect(usageLimits).toHaveBeenCalledTimes(2);
    now = 60_000 + 5 * 60_000;
    await call(handlers, "provider-usage.v1.getResource", input);
    expect(usageLimits).toHaveBeenCalledTimes(3);
  });

  it("keeps the last success time when a later read fails", async () => {
    let now = 1_000;
    const { bb, usageLimits } = fakeBb();
    const handlers = createGrokUsageSource(bb, () => now);
    await call(handlers, "provider-usage.v1.getResource", { resourceId: "grok:host_a", refresh: true });
    usageLimits.mockRejectedValueOnce(new Error("host offline"));
    now = 2_000;
    const out = await call(handlers, "provider-usage.v1.getResource", { resourceId: "grok:host_a", refresh: true });
    expect(out.observedAt).toBe(1_000);
    expect(out.usage).toMatchObject({ status: "error", message: "host offline" });
  });

  it("reports sign-in states as usage states", async () => {
    for (const status of ["not_installed", "unauthenticated", "expired"] as const) {
      const { bb } = fakeBb({ status });
      const out = await call(createGrokUsageSource(bb), "provider-usage.v1.getResource", {
        resourceId: "grok:host_a",
        refresh: true,
      });
      expect(out.usage).toEqual({ status, plan: null, accountEmail: null, planLabel: null });
    }
  });

  it("rejects a resource it did not list", async () => {
    const { bb } = fakeBb();
    await expect(
      call(createGrokUsageSource(bb), "provider-usage.v1.getResource", { resourceId: "other", refresh: false }),
    ).rejects.toThrow(/Unknown resource/);
  });

  it("marks window kinds so the card can label them", () => {
    const kinds = (label: string) => {
      const usage = toSourceUsage({ ...okUsage, windows: [{ label, usedPercent: 1, resetsAt: null }] });
      return usage.status === "ok" ? usage.windows[0]!.kind : null;
    };
    expect(kinds("Weekly credits")).toBe("weekly");
    expect(kinds("Monthly credits")).toBe("custom");
    expect(kinds("Grok Build credits")).toBe("custom");
  });
});
