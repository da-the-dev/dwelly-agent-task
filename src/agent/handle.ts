// The event handler the loop calls for each inbox event. Rung 2: for a message, find its
// case, decide (classify -> safety floor -> state), save the next case version, and trace
// what rungs 3 and 5 WOULD do. Nothing is sent to the world yet.
//
// Delivery is at-least-once, so the handler is idempotent: an event that already produced
// a case version is skipped BEFORE the LLM call (no cost, and no duplicate case even if
// the first one has closed since).
import { changedFields, type CaseRecord, type CaseVersion } from "../case.js";
import type { WorldEvent } from "../api/types.js";
import type { Store } from "../store/store.js";
import type { Tracer } from "../trace.js";
import type { ClassifyDeps } from "./classify.js";
import { decide } from "./decide.js";
import type { EventHandler } from "./loop.js";
import { readMessage } from "./message.js";

export interface HandlerDeps {
  store: Store;
  tracer: Tracer;
  classify: ClassifyDeps;
  /** Config OPEN_CASE_OUT_OF_SCOPE: whether rung 3 would open a Dwelly case for out_of_scope. */
  openCaseOutOfScope: boolean;
  now?: () => string;
}

type LinkedBy = "case_ref" | "open_case_at_property" | "new";

export function createHandler(deps: HandlerDeps): EventHandler {
  const { store, tracer } = deps;
  const now = deps.now ?? (() => new Date().toISOString());

  return async (event: WorldEvent) => {
    if (event.type !== "message.received") {
      tracer.trace("event.ignored", { event_id: event.id, type: event.type, reason: "not handled before rungs 3-4" });
      return;
    }

    const message = readMessage(event);
    await store.upsertActor({ ...message.actor, propertyId: message.propertyId }, event.id);
    const propertyId = message.propertyId ?? (await store.getActor(message.actor.id))?.propertyId ?? null;

    const already = await store.caseForCause(event.id);
    if (already) {
      tracer.trace("event.duplicate", { event_id: event.id, case_id: already });
      return;
    }

    let current: CaseRecord | null = null;
    let linkedBy: LinkedBy = "new";
    if (message.caseRef) {
      current = await store.findCaseByDwellyId(message.caseRef);
      if (current) linkedBy = "case_ref";
    }
    if (!current && propertyId) {
      current = await store.findOpenCase(propertyId);
      if (current) linkedBy = "open_case_at_property";
    }

    const r = await decide(deps.classify, current, { ...message, propertyId }, now());
    const next = r.next;
    const version: CaseVersion = {
      ...next,
      causeKind: "event",
      causeId: event.id,
      changed: changedFields(current, next),
      why: r.why,
    };
    const { applied } = await store.saveCaseVersion(version);

    tracer.trace("case.version", {
      event_id: event.id,
      case_id: next.id,
      version: next.version,
      applied,
      linked_by: linkedBy,
      from: message.actor.id,
      property_id: next.propertyId,
      urgency: next.urgency,
      next_step: next.nextStep,
      status: next.status,
      waiting_on: next.waitingOn,
      outcome: next.outcome,
      changed: version.changed,
      why: r.why,
      floor: r.floor.rules,
      overrides: r.overrides,
      needs_review: next.needsReview,
      attempts: r.attempts,
      title: next.title,
    });
    if (!applied) return;

    // What the next rungs would do with this decision. Traced only.
    if (!current) {
      const skip = next.nextStep === "out_of_scope" && !deps.openCaseOutOfScope;
      tracer.trace("intent.case_open", {
        event_id: event.id,
        case_id: next.id,
        title: next.title,
        urgency: next.urgency,
        property_id: next.propertyId,
        ...(skip ? { skipped: "OPEN_CASE_OUT_OF_SCOPE=false" } : {}),
      });
    } else if (current.urgency !== next.urgency || current.status !== next.status) {
      tracer.trace("intent.case_patch", {
        event_id: event.id,
        case_id: next.id,
        dwelly_case_id: next.dwellyCaseId,
        ...(current.urgency !== next.urgency ? { urgency: { from: current.urgency, to: next.urgency } } : {}),
        ...(current.status !== next.status ? { status: { from: current.status, to: next.status } } : {}),
      });
    }
    if (r.safetyAdvice || next.openQuestions.length) {
      tracer.trace("intent.message_tenant", {
        event_id: event.id,
        case_id: next.id,
        to: message.actor.id,
        safety_advice: r.safetyAdvice,
        questions: next.openQuestions,
      });
    }
  };
}
