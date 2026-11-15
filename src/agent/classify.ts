// Rung 2: one LLM call per message. Input: the case's latest state (Markov) + the new
// message. Output: urgency, next step, safety advice, questions, a rewritten summary.
// The call itself (zod check, one retry, `llm.call` traces) is structuredCall in llm-call.ts.
import { z } from "zod";
import { NEXT_STEPS, URGENCIES, type CaseRecord } from "../case.js";
import { structuredCall, type StructuredDeps } from "./llm-call.js";
import type { IncomingMessage } from "./message.js";

export { loadPrompt, type Prompt } from "./llm-call.js";

export const Classification = z.strictObject({
  urgency: z.enum(URGENCIES),
  why: z.string(),
  next_step: z.enum(NEXT_STEPS),
  safety_advice: z.string().nullable(),
  open_questions: z.array(z.string()),
  title: z.string(),
  summary: z.string(),
});
export type Classification = z.infer<typeof Classification>;


/** The prompt the agent uses. Older versions stay in prompts/ so runs can be compared. */
export const CLASSIFY_PROMPT = "classify.v2";

export type ClassifyDeps = StructuredDeps;

export interface ClassifyResult {
  /** null: still invalid after the retry. */
  classification: Classification | null;
  attempts: number;
  error: string | null;
}

/** What the model sees: the latest case state (or null) and the new message. Nothing older. */
export function modelInput(current: CaseRecord | null, message: IncomingMessage) {
  return {
    case: current && {
      title: current.title,
      urgency: current.urgency,
      next_step: current.nextStep,
      status: current.status,
      waiting_on: current.waitingOn,
      summary: current.summary,
      open_questions: current.openQuestions,
    },
    message: {
      from: message.actor.role,
      name: message.actor.name,
      subject: message.subject,
      text: message.text,
    },
  };
}

export async function classify(
  deps: ClassifyDeps,
  current: CaseRecord | null,
  message: IncomingMessage,
): Promise<ClassifyResult> {
  const r = await structuredCall(deps, {
    schemaName: "classification",
    schema: Classification,
    input: modelInput(current, message),
    eventId: message.eventId,
  });
  return { classification: r.value, attempts: r.attempts, error: r.error };
}
