// The agent's durable state, behind an interface so the SQLite adapter (local dev) can be
// swapped for a Postgres one (dev/stage/prod) without touching callers. Async on purpose:
// node:sqlite is synchronous, but every Postgres driver is not.
import type { WorldEvent } from "../api/types.js";

export type InboxStatus = "pending" | "done" | "failed";

export interface Store {
  /** Last cursor we committed; 0 on a fresh store. */
  getCursor(): Promise<number>;
  /**
   * Store a fetched batch and advance the cursor in ONE transaction. Events already in the
   * inbox are skipped (dedup by id). Returns how many were new.
   */
  saveBatch(events: WorldEvent[], nextCursor: number): Promise<number>;
  /** Pending events, oldest first. */
  pending(limit: number): Promise<WorldEvent[]>;
  mark(eventId: string, status: Exclude<InboxStatus, "pending">, error?: string): Promise<void>;
  close(): Promise<void>;
}
