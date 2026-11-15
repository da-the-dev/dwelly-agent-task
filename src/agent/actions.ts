// Rung 3: which world-changing calls a new case version needs. Pure: the handler saves the
// result with the version (one transaction) and the sender makes the calls later.
//
//   new case, or a case never    -> POST /cases  (+ PATCH status if it is not "open")
//   opened in Dwelly before
//   out_of_scope, flag off       -> nothing (our own case is still kept)
//   urgency or status changed    -> PATCH /cases/{id} with only those fields
//   anything else                -> nothing (the description is not kept in sync: every
//                                   PATCH is a world event and counts toward the 429 limit)
import { randomUUID } from "node:crypto";
import type { NewAction } from "../action.js";
import type { CasePatch } from "../api/types.js";
import type { CaseRecord } from "../case.js";

export interface ActionsConfig {
  /** OPEN_CASE_OUT_OF_SCOPE: open a Dwelly case for an out-of-scope report too. */
  openCaseOutOfScope: boolean;
  /** A case_open was queued for this case before. False: an out-of-scope case kept only by
   *  us (flag off) that may now need its POST. Default true. */
  opened?: boolean;
}

export interface ActionPlan {
  actions: NewAction[];
  /** Why a new case is NOT opened in Dwelly, when it is not. */
  skipped: string | null;
}

// Limits from the spec's CaseCreate.
const TITLE_MAX = 300;
const DESCRIPTION_MAX = 10_000;
const PROPERTY_MAX = 100;

/**
 * The summary, plus our case id. The ref lets us match the world's echo of the case (or a
 * person reading Dwelly's record) back to our case file.
 */
export function describeCase(c: CaseRecord): string {
  const ref = `\n\nref: ${c.id}`;
  return c.summary.slice(0, DESCRIPTION_MAX - ref.length) + ref;
}

export function actionsFor(
  prev: CaseRecord | null,
  next: CaseRecord,
  cfg: ActionsConfig,
  newId: () => string = () => `act_${randomUUID()}`,
): ActionPlan {
  // A case we never opened in Dwelly is still "new" to Dwelly: POST, never a lone PATCH
  // (review, 16 Nov: OPEN_CASE_OUT_OF_SCOPE=false, then a repair, used to queue a PATCH).
  if (!prev || cfg.opened === false) {
    if (next.nextStep === "out_of_scope" && !cfg.openCaseOutOfScope) {
      return { actions: [], skipped: "OPEN_CASE_OUT_OF_SCOPE=false" };
    }
    const actions: NewAction[] = [
      {
        id: newId(),
        kind: "case_open",
        body: {
          title: next.title.slice(0, TITLE_MAX) || "Maintenance report",
          urgency: next.urgency,
          ...(next.propertyId ? { property_id: next.propertyId.slice(0, PROPERTY_MAX) } : {}),
          description: describeCase(next),
        },
      },
    ];
    // A case is created "open"; log_only / out_of_scope close at once, external is in progress.
    if (next.status !== "open") actions.push({ id: newId(), kind: "case_patch", body: { status: next.status } });
    return { actions, skipped: null };
  }

  const patch: CasePatch = {};
  if (prev.urgency !== next.urgency) patch.urgency = next.urgency;
  if (prev.status !== next.status) patch.status = next.status;
  if (Object.keys(patch).length === 0) return { actions: [], skipped: null };
  return { actions: [{ id: newId(), kind: "case_patch", body: patch }], skipped: null };
}
