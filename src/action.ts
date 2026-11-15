// A world-changing call we have decided to make: the outbox row. It is written in the same
// transaction as the case version that caused it, BEFORE any HTTP call ("record the intent
// before the call"), and the sender (src/agent/sender.ts) works through it afterwards.
import type { CaseCreate, CasePatch } from "./api/types.js";

export type ActionStatus =
  | "pending" //  waiting to be sent (also: retry after 429 / 403 / a PATCH that timed out)
  | "sending" //  marked just before the HTTP call; found at startup = we crashed mid-call
  | "sent" //     the world answered 2xx
  | "unknown" //  a POST whose outcome we cannot know (timeout, network, 5xx): never re-sent
  | "failed"; //  the world rejected it (4xx): our bug, a person should look

export type ActionRequest =
  | { kind: "case_open"; body: CaseCreate }
  | { kind: "case_patch"; body: CasePatch };

/** What the handler queues; the store adds the rest. */
export type NewAction = ActionRequest & { id: string };

export type Action = NewAction & {
  caseId: string;
  /** The case version that queued it; with `seq`, the order to send a case's actions in. */
  caseVersion: number;
  seq: number;
  /** The event that caused it. */
  eventId: string;
  status: ActionStatus;
  attempts: number;
  /** The Dwelly case id from a successful POST. */
  resultId: string | null;
  error: string | null;
  createdAt: string;
  sentAt: string | null;
};

export interface ActionUpdate {
  status: ActionStatus;
  error?: string | null;
  resultId?: string | null;
  sentAt?: string | null;
  /** Count this as one more attempt (set when marking `sending`). */
  attempt?: boolean;
}
