// From bb-plugin-grok-build-usage by MacHatter1 (MIT), moved to vitest.
import { describe, expect, it } from "vitest";
import { GROK_LAUNCH_SPEC, GROK_PROVIDER_ID } from "./grok-provider";
import { parseBillingUsage, parseSubscriptionTier } from "./grok-usage";
import { paceForWindows } from "./pace";

describe("Grok Build usage", () => {
  it("uses its own provider id, so it does not clash with grok-build-usage", () => {
    expect(GROK_PROVIDER_ID).toBe("usage-pace-grok");
  });

  it("exposes Grok's xhigh effort and forwards it to the CLI", () => {
    expect(GROK_LAUNCH_SPEC.reasoningCli.supportedLevels).toEqual(["low", "medium", "high", "xhigh"]);
    expect(GROK_LAUNCH_SPEC.reasoningCli.levelValues?.xhigh).toBe("xhigh");
  });

  it("parses the current subscription from Grok settings", () => {
    expect(parseSubscriptionTier({ subscription_tier_display: "SuperGrok Heavy" })).toBe("SuperGrok Heavy");
  });

  it("uses the settings subscription when billing omits the plan", () => {
    const usage = parseBillingUsage(
      { config: { creditUsagePercent: 3, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-09-08T00:00:00Z" } } },
      "user@example.com",
      "SuperGrok Heavy",
    );
    expect(usage.status === "ok" && usage.planLabel).toBe("SuperGrok Heavy");
  });

  it("parses the current weekly credits response", () => {
    const usage = parseBillingUsage(
      {
        config: { creditUsagePercent: 42.5, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-09-08T00:00:00Z" } },
        subscriptionTier: "SuperGrok Heavy",
      },
      "user@example.com",
    );
    expect(usage).toEqual({
      status: "ok",
      accountEmail: "user@example.com",
      planLabel: "SuperGrok Heavy",
      windows: [{ label: "Weekly credits", usedPercent: 43, resetsAt: "2026-09-08T00:00:00.000Z" }],
    });
  });

  it("derives usage from the legacy monthly counters", () => {
    const usage = parseBillingUsage(
      { config: { monthlyLimit: { val: 16_500 }, used: { val: 5_092 }, billingPeriodEnd: "2026-10-01T00:00:00Z" } },
      null,
    );
    expect(usage.status).toBe("ok");
    expect(usage.status === "ok" && usage.windows).toEqual([
      { label: "Monthly credits", usedPercent: 31, resetsAt: "2026-10-01T00:00:00.000Z" },
    ]);
  });

  it("rejects an invalid billing percentage", () => {
    expect(() => parseBillingUsage({ config: { creditUsagePercent: 101 } }, null)).toThrow(/invalid usage percentage/);
  });

  it("gives every window Grok reports a pace", () => {
    for (const config of [
      { creditUsagePercent: 42.5, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-09-08T00:00:00Z" } },
      { monthlyLimit: { val: 16_500 }, used: { val: 5_092 }, billingPeriodEnd: "2026-10-01T00:00:00Z" },
    ]) {
      const usage = parseBillingUsage({ config }, null);
      if (usage.status !== "ok") throw new Error("expected ok");
      const [pace] = paceForWindows(usage.windows, Date.parse("2026-09-05T00:00:00Z"));
      expect(pace).not.toBeNull();
    }
  });
});
