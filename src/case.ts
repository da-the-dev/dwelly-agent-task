// Our own view of a maintenance case. Dwelly's /cases is the landlord-facing record and has
// no GET, so this is the source of truth for what we know and plan.
//
// A case evolves as versions (snapshots). The latest version is the whole state: the
// classifier sees only it plus the new message (Markov), so `summary` and `openQuestions`
// must carry everything worth remembering. Older versions are for review and debugging.
import type { Urgency } from "./api/types.js";

export type { Urgency };

export const URGENCIES = ["low", "medium", "high", "emergency"] as const satisfies readonly Urgency[];

export const NEXT_STEPS = ["contractor", "external", "self_help", "log_only", "out_of_scope", "need_info"] as const;
export type NextStep = (typeof NEXT_STEPS)[number];

/** Dwelly's own Case.status values, so rung 3 can PATCH them as they are. */
export type CaseStatus = "open" | "in_progress" | "resolved" | "closed";
export const CASE_STATUSES = ["open", "in_progress", "resolved", "closed"] as const satisfies readonly CaseStatus[];
/** Who has the next move. */
export type WaitingOn = "tenant" | "landlord" | "contractor" | "external" | "none";
/** Set when the case closes. */
export type Outcome = "resolved" | "self_help" | "logged" | "out_of_scope" | "external";

export interface CaseRecord {
  id: string;
  /** null until POST /cases succeeds (rung 3). */
  dwellyCaseId: string | null;
  propertyId: string | null;
  /** actors.id of whoever reported the problem. */
  reporter: string | null;
  status: CaseStatus;
  waitingOn: WaitingOn;
  outcome: Outcome | null;
  urgency: Urgency;
  nextStep: NextStep;
  /** null until rung 4 has an accepted work order. */
  contractorId: string | null;
  title: string;
  /** The case's memory: rewritten on every version. */
  summary: string;
  /** What we asked and are waiting to hear back. */
  openQuestions: string[];
  /** The model's output stayed invalid after a retry: a person should look. */
  needsReview: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CaseVersion extends CaseRecord {
  /** What caused this version: a world event (inbox id) or one of our own actions. */
  causeKind: "event" | "action";
  causeId: string;
  /** Fields that differ from the previous version (all of them for version 1). */
  changed: string[];
  /** One sentence: the model's reason, or the safety rule that fired. */
  why: string;
}

export function urgencyRank(u: Urgency): number {
  return URGENCIES.indexOf(u);
}

const TRACKED: (keyof CaseRecord)[] = [
  "dwellyCaseId", "propertyId", "reporter", "status", "waitingOn", "outcome", "urgency", "nextStep",
  "contractorId", "title", "summary", "openQuestions", "needsReview",
];

/** Fields that differ between two versions of a case; every tracked field for a new case. */
export function changedFields(prev: CaseRecord | null, next: CaseRecord): string[] {
  if (!prev) return [...TRACKED];
  return TRACKED.filter((k) => JSON.stringify(prev[k]) !== JSON.stringify(next[k]));
}
