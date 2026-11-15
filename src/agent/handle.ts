// The event handler the loop calls for each inbox event. For a message: find its case,
// decide (classify -> safety floor -> state), write the messages the new version calls for
// (rung 5), and save the version together with its outbox actions: the messages first,
// then the POST / PATCH /cases calls (rung 3). The handler makes no world call itself; the
// sender does, after the batch.
//
// Delivery is at-least-once, so the handler is idempotent: an event that already produced
// a case version is skipped BEFORE any LLM call (no cost, and no duplicate case or message
// even if the first case has closed since), and a version saved twice queues its actions once.
import { randomUUID } from "node:crypto";
import type { NewAction } from "../action.js";
import { changedFields, type CaseRecord, type CaseVersion } from "../case.js";
import type { WorldEvent } from "../api/types.js";
import type { Store } from "../store/store.js";
import type { Tracer } from "../trace.js";
import { actionsFor } from "./actions.js";
import type { ClassifyDeps } from "./classify.js";
import { decide } from "./decide.js";
import type { EventHandler } from "./loop.js";
import { readMessage } from "./message.js";
import { writeReply, type WriterDeps } from "./reply.js";
import { isClosed, LOOP_LIMIT, looping, speakFor, type PastTurn } from "./speak.js";

export interface HandlerDeps {
  store: Store;
  tracer: Tracer;
  classify: ClassifyDeps;
  /** Rung 5: the writer (second LLM call) and the emergency number. */
  writer: WriterDeps;
  /** Config OPEN_CASE_OUT_OF_SCOPE: whether rung 3 opens a Dwelly case for out_of_scope. */
  openCaseOutOfScope: boolean;
  now?: () => string;
}

type LinkedBy = "case_ref" | "open_case_at_property" | "recent_closed_case" | "new";

/**
 * A tenant who writes within this time after their case closed is answering us (rung 5:
 * every message we send gets an answer), not reporting a new problem. Without this, each
 * answer to a close note opened a new case, which got a message, which got an answer...
 */
export const REOPEN_WINDOW_MS = 72 * 3600_000;

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
    if (!current && propertyId && message.actor.role === "tenant") {
      const latest = await store.findLatestCase(propertyId, message.actor.id);
      if (latest && isClosed(latest) && Date.parse(now()) - Date.parse(latest.updatedAt) <= REOPEN_WINDOW_MS) {
        current = latest;
        linkedBy = "recent_closed_case";
      }
    }
    // Role guard: only a tenant reports a new problem. A landlord or contractor message we
    // cannot place must not open a case (POST /cases would tell the landlord about it).
    if (!current && message.actor.role !== "tenant") {
      tracer.trace("message.unlinked", {
        event_id: event.id,
        from: message.actor.id,
        role: message.actor.role,
        property_id: propertyId,
        text: message.text,
        note: "no case found; not a tenant, so no new case: a person should look",
      });
      return;
    }

    const r = await decide(deps.classify, current, { ...message, propertyId }, now());
    let next = r.next;

    // Rung 5: who gets a message, and why. The loop guard stops a sixth message in a row to
    // one person while the case does not move; a person looks instead.
    const reporterName =
      next.reporter === message.actor.id ? message.actor.name : next.reporter ? ((await store.getActor(next.reporter))?.name ?? null) : null;
    let recipients = speakFor(current, next, message, reporterName);
    if (current && recipients.length) {
      const past = await pastTurns(store, current.id);
      const now_ = { status: next.status, waitingOn: next.waitingOn, urgency: next.urgency };
      const stopped = recipients.filter((x) => looping([...past, { ...now_, messagedTo: [x.to] }], x.to, LOOP_LIMIT + 1));
      if (stopped.length) {
        next = { ...next, needsReview: true };
        recipients = recipients.filter((x) => !stopped.includes(x));
        for (const x of stopped) {
          tracer.trace("speak.loop_guard", { event_id: event.id, case_id: next.id, to: x.to, reasons: x.reasons, limit: LOOP_LIMIT });
        }
      }
    }
    const messages: { action: NewAction; reasons: string[]; source: string }[] = [];
    for (const recipient of recipients) {
      const w = await writeReply(deps.writer, { recipient, case: next, safetyAdvice: r.safetyAdvice, incoming: message });
      messages.push({
        action: { id: `act_${randomUUID()}`, kind: "msg_send", body: { to: recipient.to, subject: w.subject, body: w.body } },
        reasons: recipient.reasons,
        source: w.source,
      });
    }

    const version: CaseVersion = {
      ...next,
      causeKind: "event",
      causeId: event.id,
      changed: changedFields(current, next),
      why: r.why,
    };
    const plan = actionsFor(current, next, { openCaseOutOfScope: deps.openCaseOutOfScope });
    // Messages first: a safety text must not wait behind POST /cases.
    const { applied } = await store.saveCaseVersion(version, [...messages.map((m) => m.action), ...plan.actions]);

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
      role_guard: r.roleGuard,
      needs_review: next.needsReview,
      attempts: r.attempts,
      title: next.title,
    });
    if (!applied) return;

    // Queued in the same transaction as the version; the sender makes the calls.
    for (const m of messages) {
      const { to, ...body } = m.action.body as { to: string };
      tracer.trace("action.queued", {
        event_id: event.id, case_id: next.id, action_id: m.action.id, action: m.action.kind, to, reasons: m.reasons, source: m.source, body,
      });
    }
    for (const a of plan.actions) {
      tracer.trace("action.queued", { event_id: event.id, case_id: next.id, action_id: a.id, action: a.kind, body: a.body });
    }
    if (plan.skipped) {
      tracer.trace("action.skipped", { event_id: event.id, case_id: next.id, action: "case_open", reason: plan.skipped });
    }
  };
}

/** The case's past versions caused by events, with who got a message from each. */
async function pastTurns(store: Store, caseId: string): Promise<PastTurn[]> {
  const sentTo = new Map<number, string[]>();
  for (const a of await store.actionsForCase(caseId)) {
    if (a.kind === "msg_send") sentTo.set(a.caseVersion, [...(sentTo.get(a.caseVersion) ?? []), a.body.to]);
  }
  return (await store.caseHistory(caseId))
    .filter((v) => v.causeKind === "event")
    .map((v) => ({ status: v.status, waitingOn: v.waitingOn, urgency: v.urgency, messagedTo: sentTo.get(v.version) ?? [] }));
}
