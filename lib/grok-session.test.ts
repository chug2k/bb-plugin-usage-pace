import { describe, expect, it } from "vitest";
import {
  RENEW_AFTER_MS,
  decideGrokRenewal,
  parseGrokSession,
  renewGrokSession,
} from "./grok-session";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-10-03T12:00:00.000Z");

function auth(createdAt: string, expiresAt: string): string {
  return JSON.stringify({
    "https://auth.x.ai::client": {
      key: "access-token",
      create_time: createdAt,
      expires_at: expiresAt,
      auth_mode: "oidc",
    },
  });
}

describe("Grok session renewal", () => {
  it("reads the newest auth.x.ai record and ignores the access token", () => {
    const session = parseGrokSession(
      JSON.stringify({
        "https://auth.x.ai::old": {
          key: "old",
          create_time: "2026-10-03T00:00:00.000Z",
          expires_at: "2026-10-03T06:00:00.000Z",
        },
        "https://auth.x.ai::new": {
          key: "new",
          create_time: "2026-10-03T06:00:00.000Z",
          expires_at: "2026-10-03T12:00:00.000Z",
        },
      }),
    );
    expect(session).toEqual({
      createdAt: Date.parse("2026-10-03T06:00:00.000Z"),
      expiresAt: Date.parse("2026-10-03T12:00:00.000Z"),
    });
  });

  it("waits while the login is younger than 5 hours", () => {
    const session = {
      createdAt: NOW - RENEW_AFTER_MS + 1,
      expiresAt: NOW + HOUR,
    };
    expect(decideGrokRenewal(session, NOW)).toBe("wait");
  });

  it("renews at 5 hours and after the access token has expired", () => {
    expect(
      decideGrokRenewal({ createdAt: NOW - RENEW_AFTER_MS, expiresAt: NOW + HOUR }, NOW),
    ).toBe("renew");
    expect(
      decideGrokRenewal({ createdAt: NOW - 6 * HOUR, expiresAt: NOW - 1 }, NOW),
    ).toBe("renew");
  });

  it("renews in the last hour when the file has no create time", () => {
    expect(decideGrokRenewal({ createdAt: null, expiresAt: NOW + 2 * HOUR }, NOW)).toBe("wait");
    expect(decideGrokRenewal({ createdAt: null, expiresAt: NOW + 30 * 60 * 1000 }, NOW)).toBe(
      "renew",
    );
  });

  it("does not run grok while the login is young", async () => {
    let called = false;
    const raw = auth("2026-10-03T11:00:00.000Z", "2026-10-03T17:00:00.000Z");
    const result = await renewGrokSession(
      { force: false },
      {
        now: () => NOW,
        readAuth: async () => raw,
        exec: async () => {
          called = true;
          return { exitCode: 0 };
        },
      },
    );
    expect(called).toBe(false);
    expect(result.status).toBe("waiting");
    expect(result.expiresAt).toBe("2026-10-03T17:00:00.000Z");
  });

  it("reports renewed only when the saved expiry moves forward", async () => {
    let raw = auth("2026-10-03T06:00:00.000Z", "2026-10-03T12:00:00.000Z");
    const result = await renewGrokSession(
      { force: false },
      {
        now: () => NOW,
        readAuth: async () => raw,
        exec: async () => {
          raw = auth("2026-10-03T12:00:01.000Z", "2026-10-03T18:00:01.000Z");
          return { exitCode: 0 };
        },
      },
    );
    expect(result).toEqual({
      status: "renewed",
      createdAt: "2026-10-03T12:00:01.000Z",
      expiresAt: "2026-10-03T18:00:01.000Z",
      message: null,
    });
  });

  it("does not open a login when no session is saved", async () => {
    let called = false;
    const result = await renewGrokSession(
      { force: true },
      {
        readAuth: async () => null,
        exec: async () => {
          called = true;
          return { exitCode: 0 };
        },
      },
    );
    expect(called).toBe(false);
    expect(result.status).toBe("missing");
  });

  it("reports failure when grok exits without extending the login", async () => {
    const raw = auth("2026-10-03T06:00:00.000Z", "2026-10-03T12:00:00.000Z");
    const result = await renewGrokSession(
      { force: true },
      {
        now: () => NOW,
        readAuth: async () => raw,
        exec: async () => ({ exitCode: 1 }),
      },
    );
    expect(result.status).toBe("failed");
    expect(result.message).toBe("grok models exited 1.");
  });
});
