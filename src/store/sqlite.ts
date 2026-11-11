import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { WorldEvent } from "../api/types.js";
import type { InboxStatus, Store } from "./store.js";

// Resolves to <repo>/src/store/schema.sql both from dist/store/ (built) and src/store/ (vitest).
const SCHEMA = readFileSync(new URL("../../src/store/schema.sql", import.meta.url), "utf8");

/** path ":memory:" for tests. */
export function openSqliteStore(path: string): Store {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  db.exec(SCHEMA);

  const getCursor = db.prepare("SELECT value FROM event_cursor WHERE id = 1");
  const setCursor = db.prepare(
    "INSERT INTO event_cursor (id, value) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET value = excluded.value",
  );
  const insert = db.prepare(
    "INSERT INTO inbox (id, cursor, type, raw, received_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING",
  );
  const pending = db.prepare("SELECT raw FROM inbox WHERE status = 'pending' ORDER BY cursor LIMIT ?");
  const mark = db.prepare("UPDATE inbox SET status = ?, error = ?, processed_at = ? WHERE id = ?");

  return {
    async getCursor() {
      const row = getCursor.get() as { value: number } | undefined;
      return row ? Number(row.value) : 0;
    },
    async saveBatch(events: WorldEvent[], nextCursor: number) {
      const now = new Date().toISOString();
      let inserted = 0;
      db.exec("BEGIN");
      try {
        for (const e of events) {
          inserted += Number(insert.run(e.id, e.cursor, e.type, JSON.stringify(e), now).changes);
        }
        setCursor.run(nextCursor);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return inserted;
    },
    async pending(limit: number) {
      return (pending.all(limit) as { raw: string }[]).map((r) => JSON.parse(r.raw) as WorldEvent);
    },
    async mark(eventId: string, status: Exclude<InboxStatus, "pending">, error?: string) {
      mark.run(status, error ?? null, new Date().toISOString(), eventId);
    },
    async close() {
      db.close();
    },
  };
}
