import type { BbPluginApi } from "@get-bb/plugin-sdk";

/** Provider totals already include cached/reasoning tokens where applicable. */
export function tokenDelta(total: number, last: number, previous?: number): number {
  if (![total, last].every((n) => Number.isSafeInteger(n) && n >= 0)) return 0;
  if (previous === undefined || total < previous) return Math.min(total, last);
  return total - previous;
}

export function sumPeriods(rows: { createdAt: number; tokens: number }[], timeZone: string, now = Date.now()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  });
  const key = (at: number) => {
    const parts = formatter.formatToParts(at);
    return ["year", "month", "day"].map((type) => parts.find((p) => p.type === type)!.value).join("-");
  };
  const today = key(now);
  let day = 0, month = 0;
  for (const row of rows) {
    if (row.createdAt > now) continue;
    const date = key(row.createdAt);
    if (date === today) day += row.tokens;
    if (date.slice(0, 7) === today.slice(0, 7)) month += row.tokens;
  }
  return { day, month };
}

export function createTokenTotals(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    "CREATE TABLE token_events (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, tokens INTEGER NOT NULL)",
    "CREATE INDEX token_events_date ON token_events(created_at)",
    "CREATE TABLE token_cursors (thread_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
    "CREATE TABLE token_sessions (thread_id TEXT NOT NULL, provider_thread_id TEXT NOT NULL, total INTEGER NOT NULL, PRIMARY KEY(thread_id, provider_thread_id))",
  ]);
  const insert = db.prepare("INSERT OR IGNORE INTO token_events VALUES (?, ?, ?)");
  const previous = db.prepare("SELECT total FROM token_sessions WHERE thread_id = ? AND provider_thread_id = ?");
  const saveSession = db.prepare("INSERT OR REPLACE INTO token_sessions VALUES (?, ?, ?)");
  const cursor = db.prepare("SELECT seq, updated_at FROM token_cursors WHERE thread_id = ?");
  const saveCursor = db.prepare("INSERT OR REPLACE INTO token_cursors VALUES (?, ?, ?)");
  let pending: Promise<void> | null = null;
  let fetchedAt = 0;
  let error: string | null = null;
  const controller = new AbortController();
  bb.onDispose(() => controller.abort());

  async function sync() {
    const seen = new Set<string>();
    let failures = 0;
    // Both lists include hidden workers; paging avoids the default list cap.
    for (const archived of [false, true]) {
      for (let offset = 0; ; offset += 100) {
        const threads = await bb.sdk.threads.list({ archived, includeHidden: true, limit: 100, offset, signal: controller.signal });
        for (const thread of threads) {
          if (seen.has(thread.id)) continue;
          seen.add(thread.id);
          const saved = cursor.get(thread.id) as { seq: number; updated_at: number } | undefined;
          if (saved?.updated_at === thread.updatedAt && !["active", "starting", "stopping"].includes(thread.status)) continue;
          let seq = saved?.seq ?? 0;
          try {
            while (true) {
              const events = await bb.sdk.threads.events.list({
                threadId: thread.id, afterSeq: String(seq), order: "asc", limit: "100",
                types: ["thread/tokenUsage/updated"], signal: controller.signal,
              });
              db.transaction(() => {
                for (const event of events) {
                  if (event.type !== "thread/tokenUsage/updated") continue;
                  const { providerThreadId, tokenUsage } = event.data;
                  const prior = previous.get(thread.id, providerThreadId) as { total: number } | undefined;
                  const total = tokenUsage.total.totalTokens;
                  const amount = tokenDelta(total, tokenUsage.last.totalTokens, prior?.total);
                  // Copied fork history establishes a baseline but is not new spend.
                  if (event.createdAt >= thread.createdAt) insert.run(event.id, event.createdAt, amount);
                  saveSession.run(thread.id, providerThreadId, total);
                  seq = event.seq;
                }
                saveCursor.run(thread.id, seq, thread.updatedAt);
              })();
              if (events.length < 100) break;
            }
          } catch (cause) {
            if (controller.signal.aborted) throw cause;
            // Retry unfinished pages even when the thread is otherwise unchanged.
            saveCursor.run(thread.id, seq, -1);
            failures++;
          }
        }
        if (threads.length < 100) break;
      }
    }
    error = failures ? `Could not refresh ${failures} threads. Showing available data.` : null;
    fetchedAt = Date.now();
  }

  return async (timeZone: string, force = false) => {
    // Validate the timezone before doing any work.
    new Intl.DateTimeFormat("en", { timeZone }).format();
    if (pending) await pending;
    else if (force || Date.now() - fetchedAt > 30_000) {
      pending = sync().catch((cause) => {
        if (controller.signal.aborted) throw cause;
        error = "Could not refresh token usage. Showing saved data.";
      }).finally(() => { pending = null; });
      await pending;
    }
    const rows = db.prepare("SELECT created_at AS createdAt, tokens FROM token_events WHERE created_at >= ?")
      .all(Date.now() - 33 * 86400_000) as { createdAt: number; tokens: number }[];
    return { ...sumPeriods(rows, timeZone), timeZone, fetchedAt: fetchedAt ? new Date(fetchedAt).toISOString() : null, error };
  };
}
