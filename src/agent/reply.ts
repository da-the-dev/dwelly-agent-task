// Rung 5: the writer. A second LLM call (not part of classify) turns one recipient's
// reasons and the case into a message body. Code adds the parts that must be right every
// time: the safety line with the emergency number, the subject, the length limits.
//
// The writer can never lose a message: if its answer stays invalid after the retry, or the
// call itself fails, the plain template from speak.ts is sent instead (`reply.fallback`).
import { z } from "zod";
import type { CaseRecord } from "../case.js";
import { describeError } from "../errors.js";
import { structuredCall, type StructuredDeps } from "./llm-call.js";
import type { IncomingMessage } from "./message.js";
import { finalBody, PHONE, safetyLine, subjectFor, templateReply, withoutPhoneNumbers, type Recipient } from "./speak.js";

/** The prompt the writer uses. Older versions stay in prompts/ so runs can be compared. */
export const REPLY_PROMPT = "reply.v3";

export const Reply = z.strictObject({
  body: z.string().refine((b) => !PHONE.test(b), "the body must not contain a phone number: code adds the only number"),
});

export interface WriterDeps extends StructuredDeps {
  /** Config EMERGENCY_NUMBER: the number in the safety line. */
  emergencyNumber: string;
}

export interface ReplyInput {
  recipient: Recipient;
  case: CaseRecord;
  safetyAdvice: string | null;
  incoming: Pick<IncomingMessage, "eventId" | "actor" | "text">;
}

export interface Written {
  subject: string;
  body: string;
  source: "model" | "template";
  /** Why the template was used. */
  error: string | null;
}

/** What the model sees. Our own ids and the Dwelly id stay out. */
export function writerInput(i: ReplyInput) {
  const c = i.case;
  return {
    to: { role: i.recipient.role, name: i.recipient.name },
    reasons: i.recipient.reasons,
    case: {
      title: c.title,
      urgency: c.urgency,
      next_step: c.nextStep,
      status: c.status,
      waiting_on: c.waitingOn,
      summary: c.summary,
      open_questions: c.openQuestions,
    },
    safety_advice: i.recipient.role === "tenant" ? withoutPhoneNumbers(i.safetyAdvice) : null,
    their_message: i.incoming.actor.id === i.recipient.to ? i.incoming.text : null,
  };
}

export async function writeReply(deps: WriterDeps, i: ReplyInput): Promise<Written> {
  let text: string | null = null;
  let error: string | null = null;
  try {
    const r = await structuredCall(deps, { schemaName: "reply", schema: Reply, input: writerInput(i), eventId: i.incoming.eventId });
    text = r.value?.body.trim() || null;
    if (!text) error = r.error ?? "empty body";
  } catch (err) {
    error = describeError(err);
  }
  const source = text ? "model" : "template";
  if (!text) {
    text = templateReply(i.recipient, i.case, i.recipient.role === "tenant" ? i.safetyAdvice : null);
    deps.tracer.trace("reply.fallback", { event_id: i.incoming.eventId, case_id: i.case.id, to: i.recipient.to, error });
  }
  const safety = i.recipient.role === "tenant" ? safetyLine(i.case, deps.emergencyNumber) : null;
  return { subject: subjectFor(i.case), body: finalBody(safety, text), source, error };
}
