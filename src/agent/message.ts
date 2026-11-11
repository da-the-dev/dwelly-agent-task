// The one place that knows the shape of a message event's payload. The spec types
// Event.payload as an open object, so the field names below are ASSUMPTIONS (asked Dwelly
// on 11 Nov 2026). When the real feed shows the shape, change this file and its test only.
import type { WorldEvent } from "../api/types.js";

export interface IncomingMessage {
  eventId: string;
  text: string;
  subject: string | null;
  actor: { id: string; role: string; name: string };
  propertyId: string | null;
  /** A case the world says this message belongs to, if the payload carries one. */
  caseRef: string | null;
  occurredAt: string;
}

const TEXT_KEYS = ["body", "text", "message", "content"];
const SUBJECT_KEYS = ["subject"];
const PROPERTY_KEYS = ["property_id", "propertyId"];
const CASE_KEYS = ["case_id", "caseId"];

function pick(payload: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = payload[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

export function readMessage(event: WorldEvent): IncomingMessage {
  const payload = event.payload;
  const text = pick(payload, TEXT_KEYS);
  if (!text) {
    // Fail loudly: the event is marked failed with this message, so the first unexpected
    // payload in a live run shows its real keys in the trace.
    throw new Error(`message event without text; payload keys: [${Object.keys(payload).join(", ")}]`);
  }
  if (!event.actor) throw new Error("message event without an actor");
  return {
    eventId: event.id,
    text,
    subject: pick(payload, SUBJECT_KEYS),
    actor: { id: event.actor.id, role: event.actor.role, name: event.actor.name },
    propertyId: pick(payload, PROPERTY_KEYS),
    caseRef: pick(payload, CASE_KEYS),
    occurredAt: event.occurred_at,
  };
}
