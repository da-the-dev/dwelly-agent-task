// The agent's durable state, behind an interface so the SQLite adapter (local dev) can be
// swapped for a Postgres one (dev/stage/prod) without touching callers. Async on purpose:
// node:sqlite is synchronous, but every Postgres driver is not.
import type { WorldEvent } from "../api/types.js";
import type { CaseRecord, CaseVersion } from "../case.js";

export type InboxStatus = "pending" | "done" | "failed";

export interface Actor {
  id: string;
  role: string;
  name: string;
  propertyId: string | null;
}

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

  /** Record an actor we heard from. A later event never erases a known property. */
  upsertActor(actor: Actor, eventId: string): Promise<void>;
  getActor(id: string): Promise<Actor | null>;
  /** The latest version of a case. */
  getCase(id: string): Promise<CaseRecord | null>;
  /** The most recently updated case at this property that is not resolved or closed. */
  findOpenCase(propertyId: string): Promise<CaseRecord | null>;
  /** Our case for a Dwelly case id (set once rung 3 has created it). */
  findCaseByDwellyId(dwellyCaseId: string): Promise<CaseRecord | null>;
  /** The case this cause (e.g. an event id) already produced a version of, if any. */
  caseForCause(causeId: string): Promise<string | null>;
  /**
   * Append a version and make it the case's latest state, in ONE transaction. If this
   * cause already produced a version of this case (a redelivered event), nothing changes
   * and `applied` is false.
   */
  saveCaseVersion(v: CaseVersion): Promise<{ applied: boolean }>;
  /** Every version of a case, oldest first. */
  caseHistory(caseId: string): Promise<CaseVersion[]>;

  close(): Promise<void>;
}
