// Renews the Grok CLI access token before its 6-hour lifetime ends.
// `grok login` opens a browser and replaces the session. `grok models` with
// a wide early-refresh window uses the saved refresh token and writes a new
// access token into ~/.grok/auth.json. A probe on this machine did that in
// about one second and left the login valid.

import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { promisify } from "node:util";

import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const execFile = promisify(execFileCallback);

/** Refresh once the saved login is this old. The access token lasts 6 hours. */
export const RENEW_AFTER_MS = 5 * 60 * 60 * 1000;
/** How often each machine is checked. The check is cheap when the login is young. */
export const RENEW_CHECK_MS = 15 * 60 * 1000;
/**
 * Seconds before expiry at which this renew treats the token as due.
 * Grok's own default is 5 minutes, which is too late for a 5-hour renew.
 */
export const RENEW_EARLY_SECS = 7 * 24 * 60 * 60;

const statusSchema = z.enum(["missing", "waiting", "renewed", "failed"]);

export const grokSessionContract = defineRpcContract({
  renewGrokSession: {
    input: z.object({ force: z.boolean() }).strict(),
    output: z
      .object({
        status: statusSchema,
        expiresAt: z.string().nullable(),
        createdAt: z.string().nullable(),
        message: z.string().nullable(),
      })
      .strict(),
  },
});

export type GrokRenewResult = {
  status: "missing" | "waiting" | "renewed" | "failed";
  expiresAt: string | null;
  createdAt: string | null;
  message: string | null;
};

export type GrokSessionTimes = {
  createdAt: number | null;
  expiresAt: number | null;
};

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function timeMilliseconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** The newest auth.x.ai record that has an access token. Tokens stay in the file. */
export function parseGrokSession(raw: string | null): GrokSessionTimes | null {
  if (raw === null) return null;
  let parsed: JsonRecord | null;
  try {
    parsed = asRecord(JSON.parse(raw));
  } catch {
    return null;
  }
  if (parsed === null) return null;

  const sessions = Object.entries(parsed)
    .filter(([identity, value]) => identity.includes("auth.x.ai") && asRecord(value) !== null)
    .map(([, value]) => asRecord(value)!)
    .filter((entry) => {
      const token = entry.key ?? entry.access_token;
      return typeof token === "string" && token.trim() !== "";
    })
    .map((entry) => ({
      createdAt: timeMilliseconds(entry.create_time ?? entry.createdAt),
      expiresAt: timeMilliseconds(entry.expires_at ?? entry.expiresAt),
    }))
    .sort((left, right) => (right.expiresAt ?? 0) - (left.expiresAt ?? 0));

  return sessions[0] ?? null;
}

export function decideGrokRenewal(
  session: GrokSessionTimes | null,
  now: number,
): "missing" | "wait" | "renew" {
  if (session === null || session.expiresAt === null) return "missing";
  if (session.expiresAt <= now) return "renew";
  if (session.createdAt !== null) {
    return now - session.createdAt >= RENEW_AFTER_MS ? "renew" : "wait";
  }
  return session.expiresAt - now <= 60 * 60 * 1000 ? "renew" : "wait";
}

function iso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function result(
  status: GrokRenewResult["status"],
  session: GrokSessionTimes | null,
  message: string | null,
): GrokRenewResult {
  return {
    status,
    expiresAt: iso(session?.expiresAt ?? null),
    createdAt: iso(session?.createdAt ?? null),
    message,
  };
}

async function readAuthFile(): Promise<string | null> {
  try {
    return await readFile(`${homedir()}/.grok/auth.json`, "utf8");
  } catch {
    return null;
  }
}

async function runGrokModels(): Promise<{ exitCode: number }> {
  try {
    await execFile("grok", ["models"], {
      timeout: 20_000,
      maxBuffer: 64 * 1024,
      env: {
        ...process.env,
        GROK_AUTH_EARLY_INVALIDATION_SECS: String(RENEW_EARLY_SECS),
      },
    });
    return { exitCode: 0 };
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: unknown }).code === "ENOENT"
    ) {
      throw new Error("grok is not on PATH");
    }
    const exitCode =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof (error as { code: unknown }).code === "number"
        ? (error as { code: number }).code
        : 1;
    return { exitCode };
  }
}

export async function renewGrokSession(
  input: { force: boolean },
  deps?: {
    now?: () => number;
    readAuth?: () => Promise<string | null>;
    exec?: () => Promise<{ exitCode: number }>;
  },
): Promise<GrokRenewResult> {
  const readAuth = deps?.readAuth ?? readAuthFile;
  const exec = deps?.exec ?? runGrokModels;
  const now = deps?.now?.() ?? Date.now();
  const before = parseGrokSession(await readAuth());
  const decision =
    input.force && before?.expiresAt != null ? "renew" : decideGrokRenewal(before, now);

  if (decision === "missing") {
    return result("missing", before, "No Grok login is saved on this machine.");
  }
  if (decision === "wait") return result("waiting", before, null);

  const previousExpiry = before!.expiresAt!;
  try {
    const run = await exec();
    if (run.exitCode !== 0) {
      return result("failed", before, `grok models exited ${run.exitCode}.`);
    }
  } catch (error) {
    return result(
      "failed",
      before,
      error instanceof Error ? error.message : "Grok refresh failed.",
    );
  }

  const after = parseGrokSession(await readAuth());
  if (after?.expiresAt != null && after.expiresAt > previousExpiry) {
    return result("renewed", after, null);
  }
  return result("failed", after ?? before, "Grok did not extend the saved login.");
}
