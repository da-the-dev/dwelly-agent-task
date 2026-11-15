// Rung 5: who we write to after a new case version, and why. Pure: the handler writes the
// text (reply.ts) and queues one msg_send per recipient with the version.
//
// Every message we send gets an answer in the event feed, and every answer makes a new
// case version. So we write only when there is something new to say; a "thanks" that
// changes nothing gets no message back (no ping-pong).
//
//   to the reporter (tenant)   new case | urgency went up | new open questions |
//                              status or waiting_on changed | case closed | they asked us |
//                              any message of theirs while the case is an open emergency
//   to anyone else who asked   a landlord or another tenant whose message has a "?"
//   never                      a contractor (rung 4 talks to them through work orders);
//                              a landlord only to announce the case (POST /cases told them)
import type { CaseRecord, CaseStatus, NextStep, Urgency, WaitingOn } from "../case.js";
import { urgencyRank } from "../case.js";
import type { IncomingMessage } from "./message.js";

export type SpeakReason =
  | "new_case" | "urgency_up" | "new_questions" | "status_changed" | "waiting_changed" | "closed" | "asked" | "open_emergency";

export interface Recipient {
  to: string;
  role: string;
  /** null when we never heard their name. */
  name: string | null;
  reasons: SpeakReason[];
}

const CLOSED: CaseStatus[] = ["closed", "resolved"];
export const isClosed = (c: Pick<CaseRecord, "status">) => CLOSED.includes(c.status);

/** The message asks us something. Crude on purpose: deterministic and testable. */
export const asks = (text: string) => text.includes("?");

export function speakFor(
  prev: CaseRecord | null,
  next: CaseRecord,
  message: Pick<IncomingMessage, "actor" | "text">,
  reporterName: string | null,
): Recipient[] {
  const out: Recipient[] = [];
  const asked = asks(message.text) && message.actor.role !== "contractor";

  if (next.reporter) {
    const r: SpeakReason[] = [];
    if (!prev) r.push("new_case");
    else {
      if (urgencyRank(next.urgency) > urgencyRank(prev.urgency)) r.push("urgency_up");
      if (next.openQuestions.some((q) => !prev.openQuestions.includes(q))) r.push("new_questions");
      if (next.status !== prev.status) r.push(isClosed(next) ? "closed" : "status_changed");
      else if (next.waitingOn !== prev.waitingOn && !isClosed(next)) r.push("waiting_changed");
    }
    if (asked && message.actor.id === next.reporter) r.push("asked");
    // In an open emergency the tenant is never left without an answer (user, 15 Nov; the
    // gas-update scenario). The loop guard still limits a long exchange.
    if (!r.length && message.actor.id === next.reporter && next.urgency === "emergency" && !isClosed(next)) r.push("open_emergency");
    if (r.length) out.push({ to: next.reporter, role: "tenant", name: reporterName, reasons: r });
  }
  if (asked && message.actor.id !== next.reporter) {
    out.push({ to: message.actor.id, role: message.actor.role, name: message.actor.name || null, reasons: ["asked"] });
  }
  return out;
}

/** One past case version, as the loop guard sees it. */
export interface PastTurn {
  status: CaseStatus;
  waitingOn: WaitingOn;
  urgency: Urgency;
  /** Who got a message queued with this version. */
  messagedTo: string[];
}

export const LOOP_LIMIT = 5;

/**
 * Loop guard: the last LOOP_LIMIT versions each messaged `to` while the status, waiting_on
 * and urgency never moved. Then a person should look instead of a sixth message.
 */
export function looping(past: PastTurn[], to: string, limit = LOOP_LIMIT): boolean {
  const last = past.slice(-limit);
  const first = last[0];
  if (!first || last.length < limit) return false;
  return last.every(
    (t) => t.messagedTo.includes(to) && t.status === first.status && t.waitingOn === first.waitingOn && t.urgency === first.urgency,
  );
}

/**
 * The safety line: code, never the model. Every message to the tenant of an open emergency
 * case starts with it. One number for gas, fire, an intruder or an injury.
 */
export function safetyLine(c: Pick<CaseRecord, "urgency" | "status">, emergencyNumber: string): string | null {
  if (c.urgency !== "emergency" || isClosed(c)) return null;
  return `If anyone is in danger, get to a safe place and call ${emergencyNumber} now.`;
}

/**
 * A phone number other than a short emergency code (999, 112): 8+ digits and spaces. Only
 * code puts a number in a message (the safety line), so the model's text must have none.
 * Found in a try run on 15 Nov: the writer copied the gas line (0800 111 999) from the case.
 */
export const PHONE = /\+?\d[\d ]{6,}\d/;

/** Drop every sentence that holds a phone number; null when nothing is left. */
export function withoutPhoneNumbers(text: string | null): string | null {
  if (!text) return null;
  const kept = text.split(/(?<=[.!?])\s+/).filter((s) => !PHONE.test(s)).join(" ").trim();
  return kept || null;
}

// Limits from the spec's ActorMessage.
const SUBJECT_MAX = 300;
const BODY_MAX = 10_000;

/** The body we send: the safety line from code first, then the text. */
export function finalBody(safety: string | null, text: string): string {
  return (safety ? `${safety}\n\n${text.trim()}` : text.trim()).slice(0, BODY_MAX);
}

export const subjectFor = (c: Pick<CaseRecord, "title">) => `Re: ${c.title}`.slice(0, SUBJECT_MAX);

const NEXT: Record<NextStep, string> = {
  need_info: "To work out the right next step, we need a few details from you.",
  contractor: "We will arrange a contractor and confirm the time with you.",
  self_help: "This is often something you can sort out safely yourself. Tell us if it does not help.",
  external: "This needs the emergency service, not a contractor. We are following it up.",
  log_only: "We have logged this on your home's record; no visit is needed for now. Tell us if it changes.",
  out_of_scope: "This is not a repair we can arrange, but we have recorded it.",
};

/** The fallback text when the writer fails: plain, but a message is never lost. */
export function templateReply(r: Recipient, c: CaseRecord, safetyAdvice: string | null): string {
  const hello = r.name ? `Hi ${r.name.split(" ")[0]},` : "Hello,";
  if (r.role !== "tenant") {
    return `${hello}\n\nThank you for your message about "${c.title}". We have added it to the case and will come back to you shortly.`;
  }
  const parts = [hello];
  if (r.reasons.includes("new_case")) parts.push(`Thank you for telling us about "${c.title}".`);
  const advice = withoutPhoneNumbers(safetyAdvice);
  if (advice) parts.push(advice);
  parts.push(isClosed(c) ? "We are closing this case now. Tell us if the problem comes back." : NEXT[c.nextStep]);
  if (c.openQuestions.length && !isClosed(c)) parts.push(`Could you tell us:\n${c.openQuestions.map((q) => `- ${q}`).join("\n")}`);
  return parts.join("\n\n");
}
