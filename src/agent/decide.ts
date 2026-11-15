// Rung 2's decision for one message: classify -> safety floor -> state. Pure apart from the
// LLM call: it takes the case's latest state and returns the next one; saving is the caller's.
import { randomUUID } from "node:crypto";
import { urgencyRank, type CaseRecord, type Urgency } from "../case.js";
import { classify, type Classification, type ClassifyDeps } from "./classify.js";
import { applyFloor, safetyFloor, type Floor } from "./floor.js";
import type { IncomingMessage } from "./message.js";
import { stateFor } from "./state.js";

export interface DecideResult {
  next: CaseRecord;
  why: string;
  /** What the safety floor changed in the model's answer. */
  overrides: string[];
  floor: Floor;
  /** null: the model's output stayed invalid and the fallback was used (needsReview). */
  classification: Classification | null;
  safetyAdvice: string | null;
  attempts: number;
  /** A landlord or contractor wrote: the case's next step and state were kept. */
  roleGuard: boolean;
}

const max = (...us: (Urgency | null | undefined)[]): Urgency =>
  us.filter((u): u is Urgency => !!u).reduce((a, b) => (urgencyRank(b) > urgencyRank(a) ? b : a), "low");

export async function decide(
  deps: ClassifyDeps,
  current: CaseRecord | null,
  message: IncomingMessage,
  now: string = new Date().toISOString(),
  newId: () => string = () => `case_${randomUUID()}`,
): Promise<DecideResult> {
  const floor = safetyFloor(message.text);
  const r = await classify(deps, current, message);
  const c = r.classification;

  // Fallback when the model never gave a valid answer: keep what we knew, never lower the
  // urgency, at least medium, and flag the case for a person.
  const proposed = c
    ? { urgency: c.urgency, nextStep: c.next_step, why: c.why }
    : {
        urgency: max(current?.urgency, floor.urgency, "medium"),
        nextStep: current?.nextStep ?? "need_info",
        why: `model output invalid after ${r.attempts} attempts: ${r.error}`,
      };
  const { decision, overrides } = applyFloor(proposed, floor);

  // Role guard: the classifier triages a tenant's report. A landlord's "go ahead" or a
  // contractor's "Thursday works" is not a report, so it may add to the summary and the
  // questions but never moves the case: next step and state stay, urgency can only rise.
  const guard = current && message.actor.role !== "tenant" ? current : null;
  const nextStep = guard ? guard.nextStep : decision.nextStep;
  const state = guard ? { status: guard.status, waitingOn: guard.waitingOn, outcome: guard.outcome } : stateFor(nextStep);
  const urgency = guard ? max(guard.urgency, decision.urgency) : decision.urgency;
  const why = guard ? `role guard (${message.actor.role}): next step and state kept; ${decision.why}` : decision.why;

  const next: CaseRecord = {
    id: current?.id ?? newId(),
    dwellyCaseId: current?.dwellyCaseId ?? null,
    propertyId: current?.propertyId ?? message.propertyId,
    reporter: current?.reporter ?? message.actor.id,
    ...state,
    urgency,
    nextStep,
    contractorId: current?.contractorId ?? null,
    title: (c?.title || current?.title || message.text).slice(0, 300),
    summary: c?.summary ?? [current?.summary, `${message.actor.role}: ${message.text}`].filter(Boolean).join("\n"),
    openQuestions: c ? c.open_questions : current?.openQuestions ?? [],
    // One flag for "a person must look": the agent sets it (invalid answer here; failed or
    // unknown calls in the sender; the loop guard in the handler) and never clears it.
    needsReview: (current?.needsReview ?? false) || !c,
    version: (current?.version ?? 0) + 1,
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
  };
  return { next, why, overrides, floor, classification: c, safetyAdvice: c?.safety_advice ?? null, attempts: r.attempts, roleGuard: !!guard };
}
