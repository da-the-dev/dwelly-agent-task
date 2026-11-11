// The payload adapter: the only code that depends on the (assumed) payload shape.
import { describe, expect, it } from "vitest";
import type { WorldEvent } from "../src/api/types.js";
import { readMessage } from "../src/agent/message.js";

const event = (payload: Record<string, unknown>, actor: WorldEvent["actor"] = { id: "tenant_04", role: "tenant", name: "Emma Clarke" }): WorldEvent => ({
  id: "evt_1",
  cursor: 1,
  type: "message.received",
  channel: "email",
  actor,
  sim_ms: 0,
  occurred_at: "2026-11-11T10:00:00.000Z",
  payload,
});

describe("readMessage", () => {
  it("reads the fake world's shape: { body, property_id }", () => {
    expect(readMessage(event({ body: "Water is pouring through the ceiling", property_id: "prop_04" }))).toEqual({
      eventId: "evt_1",
      text: "Water is pouring through the ceiling",
      subject: null,
      actor: { id: "tenant_04", role: "tenant", name: "Emma Clarke" },
      propertyId: "prop_04",
      caseRef: null,
      occurredAt: "2026-11-11T10:00:00.000Z",
    });
  });

  it("accepts other plausible field names, a subject and a case reference", () => {
    const m = readMessage(event({ text: "hi", subject: "Re: leak", propertyId: "prop_02", case_id: "c-9" }));
    expect(m).toMatchObject({ text: "hi", subject: "Re: leak", propertyId: "prop_02", caseRef: "c-9" });
  });

  it("fails loudly with the payload keys when there is no text, so a live run shows the real shape", () => {
    expect(() => readMessage(event({ html: "<p>hi</p>", attachments: [] }))).toThrow(
      "message event without text; payload keys: [html, attachments]",
    );
  });

  it("fails when the message has no actor", () => {
    expect(() => readMessage(event({ body: "hi" }, null))).toThrow("without an actor");
  });
});
