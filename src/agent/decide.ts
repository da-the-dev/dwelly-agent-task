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

  const next: CaseRecord = {
    id: current?.id ?? newId(),
    dwellyCaseId: current?.dwellyCaseId ?? null,
    propertyId: current?.propertyId ?? message.propertyId,
    reporter: current?.reporter ?? message.actor.id,
    ...stateFor(decision.nextStep),
    urgency: decision.urgency,
    nextStep: decision.nextStep,
    contractorId: current?.contractorId ?? null,
    title: (c?.title || current?.title || message.text).slice(0, 300),
    summary: c?.summary ?? [current?.summary, `${message.actor.role}: ${message.text}`].filter(Boolean).join("\n"),
    openQuestions: c ? c.open_questions : current?.openQuestions ?? [],
    needsReview: !c,
    version: (current?.version ?? 0) + 1,
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
  };
  return { next, why: decision.why, overrides, floor, classification: c, safetyAdvice: c?.safety_advice ?? null, attempts: r.attempts };
}
