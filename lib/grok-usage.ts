// Grok Build usage: reads the Grok CLI login and asks xAI's billing service
// for the credit window. From bb-plugin-grok-build-usage by MacHatter1 (MIT),
// https://github.com/MacHatter1/bb-plugin-grok-build-usage, unchanged.

import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { promisify } from "node:util";

import type {
  ProviderHealthResult,
  ProviderUsageResult,
} from "@get-bb/plugin-sdk/provider-bridge";

const execFile = promisify(execFileCallback);
const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const SETTINGS_URL = "https://cli-chat-proxy.grok.com/v1/settings";
const LOGIN_COMMAND = "grok login";
const TOKEN_AUTH_HEADER = "xai-grok-cli";
const CLIENT_MODE = "cli";

type JsonRecord = Record<string, unknown>;
type ProviderHealth = Extract<ProviderHealthResult, { supported: true }>["health"];
type ProviderUsage = Extract<ProviderUsageResult, { supported: true }>["usage"];
type GrokCredential = {
  token: string;
  userId: string;
  email: string | null;
  expiresAt: number | null;
};

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function property(record: JsonRecord, ...names: string[]): unknown {
  for (const name of names) {
    if (name in record) return record[name];
  }
  return undefined;
}

function expiryMilliseconds(value: unknown): number | null {
  const number = numberValue(value);
  if (number !== null) return number < 1_000_000_000_000 ? number * 1000 : number;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

async function readCredential(): Promise<GrokCredential | null> {
  let parsed: JsonRecord | null;
  try {
    parsed = asRecord(JSON.parse(await readFile(`${homedir()}/.grok/auth.json`, "utf8")));
  } catch {
    return null;
  }
  if (parsed === null) return null;

  const candidates = Object.entries(parsed)
    .filter(([identity, value]) => identity.includes("auth.x.ai") && asRecord(value) !== null)
    .map(([, value]) => asRecord(value)!)
    .map((entry) => {
      const token = stringValue(property(entry, "key", "access_token"));
      const userId = stringValue(property(entry, "user_id", "userId"));
      if (token === null || userId === null) return null;
      return {
        token,
        userId,
        email: stringValue(property(entry, "email")),
        expiresAt: expiryMilliseconds(property(entry, "expires_at", "expiresAt")),
      } satisfies GrokCredential;
    })
    .filter((entry): entry is GrokCredential => entry !== null)
    .sort((left, right) => (right.expiresAt ?? 0) - (left.expiresAt ?? 0));

  return candidates[0] ?? null;
}

async function readExecutableVersion(command: string): Promise<string | null> {
  try {
    const result = await execFile(command, ["--version"], {
      timeout: 2_500,
      maxBuffer: 16 * 1024,
    });
    const match = result.stdout.match(/\bgrok\s+([\w.-]+)/i);
    return match?.[1] ?? result.stdout.trim().split(/\s+/)[0] ?? null;
  } catch {
    return null;
  }
}

function commandFromOptions(providerOptions: unknown): string {
  const options = asRecord(providerOptions);
  const launchSpec = asRecord(options?.acpLaunchSpec);
  return stringValue(launchSpec?.command) ?? "grok";
}

function healthResult(health: ProviderHealth): ProviderHealthResult {
  return { supported: true, health };
}

function usageResult(usage: ProviderUsage): ProviderUsageResult {
  return { supported: true, usage };
}

function grokHeaders(credential: GrokCredential, installedVersion: string): Record<string, string> {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${credential.token}`,
    "X-XAI-Token-Auth": TOKEN_AUTH_HEADER,
    "x-grok-client-version": installedVersion,
    "x-grok-client-mode": CLIENT_MODE,
    "x-userid": credential.userId,
  };
}

export function parseSubscriptionTier(payload: unknown): string | null {
  const response = asRecord(payload);
  return stringValue(
    property(response ?? {}, "subscription_tier_display", "subscriptionTierDisplay", "subscriptionTier"),
  );
}

async function readSubscriptionTier(
  credential: GrokCredential,
  installedVersion: string,
): Promise<string | null> {
  try {
    const response = await fetch(SETTINGS_URL, {
      headers: grokHeaders(credential, installedVersion),
      signal: AbortSignal.timeout(2_500),
    });
    if (!response.ok) return null;
    return parseSubscriptionTier(await response.json());
  } catch {
    // Plan metadata is supplementary; billing usage should remain visible if
    // the settings endpoint is unavailable or changes shape.
    return null;
  }
}

export async function readGrokHealth(providerOptions?: unknown): Promise<ProviderHealthResult> {
  const command = commandFromOptions(providerOptions);
  const installedVersion = await readExecutableVersion(command);
  if (installedVersion === null) {
    return healthResult({
      status: "not_installed",
      statusMessage: null,
      accountEmail: null,
      planLabel: null,
      installedVersion: null,
      minimumSupportedVersion: null,
      canInstall: false,
      canUpdate: false,
      loginCommand: LOGIN_COMMAND,
    });
  }

  const credential = await readCredential();
  const expiresAt = credential?.expiresAt ?? null;
  const expired = expiresAt !== null && expiresAt <= Date.now();
  const status = credential === null ? "unauthenticated" : expired ? "expired" : "ready";
  const planLabel = credential !== null && !expired
    ? await readSubscriptionTier(credential, installedVersion)
    : null;

  return healthResult({
    status,
    statusMessage: null,
    accountEmail: credential?.email ?? null,
    planLabel,
    installedVersion,
    minimumSupportedVersion: null,
    canInstall: false,
    canUpdate: false,
    loginCommand: LOGIN_COMMAND,
  });
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 100.5) {
    throw new Error("Grok Build returned an invalid usage percentage");
  }
  return Math.round(Math.min(100, Math.max(0, value)));
}

function centValue(value: unknown): number | null {
  const record = asRecord(value);
  return numberValue(record ? property(record, "val", "value") : value);
}

function validReset(value: unknown): string | null {
  const reset = stringValue(value);
  if (reset === null) return null;
  if (Number.isNaN(Date.parse(reset))) {
    throw new Error("Grok Build returned an invalid usage reset time");
  }
  return new Date(reset).toISOString();
}

export function parseBillingUsage(
  payload: unknown,
  accountEmail: string | null,
  subscriptionTier: string | null = null,
): ProviderUsage {
  const response = asRecord(payload);
  const config = asRecord(response?.config);
  if (config === null) throw new Error("Grok Build returned no billing configuration");

  const period = asRecord(property(config, "currentPeriod", "current_period"));
  const periodType = stringValue(property(period ?? {}, "type", "periodType", "period_type"))?.toUpperCase() ?? "";
  const explicitPercent = numberValue(property(config, "creditUsagePercent", "credit_usage_percent"));
  const used = centValue(property(config, "used"));
  const limit = centValue(property(config, "monthlyLimit", "monthly_limit"));

  let usedPercent: number;
  if (explicitPercent !== null) {
    usedPercent = clampPercent(explicitPercent);
  } else if (period !== null) {
    // The proto omits a zero-valued percentage immediately after rollover.
    usedPercent = 0;
  } else if (used !== null && limit !== null && limit > 0 && used >= 0) {
    usedPercent = clampPercent((used / limit) * 100);
  } else if (
    property(
      config,
      "billingPeriodEnd",
      "billing_period_end",
      "prepaidBalance",
      "prepaid_balance",
      "isUnifiedBillingUser",
      "is_unified_billing_user",
    ) !== undefined
  ) {
    usedPercent = 0;
  } else {
    throw new Error("Grok Build returned no coherent usage percentage");
  }

  const planLabel = subscriptionTier ??
    stringValue(property(response ?? {}, "subscriptionTier", "subscription_tier")) ??
    stringValue(property(config, "subscriptionTier", "subscription_tier"));
  const reset = validReset(
    property(period ?? {}, "end") ?? property(config, "billingPeriodEnd", "billing_period_end"),
  );
  const label = periodType.endsWith("WEEKLY")
    ? "Weekly credits"
    : periodType.endsWith("MONTHLY") || (period === null && (limit !== null || used !== null))
      ? "Monthly credits"
      : "Grok Build credits";

  return {
    status: "ok",
    accountEmail,
    planLabel,
    windows: [{ label, usedPercent, resetsAt: reset }],
  };
}

export async function readGrokUsage(providerOptions?: unknown): Promise<ProviderUsageResult> {
  const command = commandFromOptions(providerOptions);
  const installedVersion = await readExecutableVersion(command);
  if (installedVersion === null) return usageResult({ status: "not_installed" });

  const credential = await readCredential();
  if (credential === null) return usageResult({ status: "unauthenticated" });
  if (credential.expiresAt !== null && credential.expiresAt <= Date.now()) {
    return usageResult({ status: "expired" });
  }

  try {
    const [response, subscriptionTier] = await Promise.all([
      fetch(BILLING_URL, {
        headers: grokHeaders(credential, installedVersion),
        signal: AbortSignal.timeout(15_000),
      }),
      readSubscriptionTier(credential, installedVersion),
    ]);

    if (response.status === 401) return usageResult({ status: "expired" });
    if (!response.ok) {
      return usageResult({
        status: "error",
        message: `Grok Build billing service returned HTTP ${response.status}`,
        accountEmail: credential.email,
        planLabel: null,
      });
    }

    return usageResult(parseBillingUsage(await response.json(), credential.email, subscriptionTier));
  } catch (error) {
    const message = error instanceof Error && error.name === "TimeoutError"
      ? "Grok Build billing request timed out"
      : "Unable to read Grok Build billing usage";
    return usageResult({
      status: "error",
      message,
      accountEmail: credential.email,
      planLabel: null,
    });
  }
}
