// The rung 2 handler end to end, with an in-memory store and a fake OpenRouter.
import { describe, expect, it } from "vitest";
import type { WorldEvent } from "../src/api/types.js";
import { CLASSIFY_PROMPT, loadPrompt } from "../src/agent/classify.js";
import { createHandler } from "../src/agent/handle.js";
import { openSqliteStore } from "../src/store/sqlite.js";
import { createTracer } from "../src/trace.js";

const message = (id: string, body: string, actor = "tenant_09", property = "prop_09"): WorldEvent => ({
  id,
  cursor: Number(id.replace(/\D/g, "")),
  type: "message.received",
  channel: "email",
  actor: { id: actor, role: "tenant", name: "Nadia" },
  sim_ms: 0,
  occurred_at: "2026-11-11T17:04:00.000Z",
  payload: { body, property_id: property },
});

const answer = (o: Record<string, unknown>) =>
  JSON.stringify({
    urgency: "medium",
    why: "w",
    next_step: "contractor",
    safety_advice: null,
    open_questions: [],
    title: "t",
    summary: "s",
    ...o,
  });

function setup(answers: string[], openCaseOutOfScope = true) {
  let calls = 0;
  const fetchImpl = (async () => {
    const content = answers[calls++] ?? "";
    return new Response(
      JSON.stringify({ id: "g", model: "m", provider: "P", choices: [{ message: { content }, finish_reason: "stop" }], usage: {} }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  const store = openSqliteStore(":memory:");
  const lines: Record<string, unknown>[] = [];
  const tracer = createTracer("t", (l) => lines.push(JSON.parse(l)));
  const handle = createHandler({
    store,
    tracer,
    classify: { llm: { apiKey: "k", model: "m" }, prompt: loadPrompt(CLASSIFY_PROMPT), tracer, fetchImpl },
    openCaseOutOfScope,
    now: () => "2026-11-11T17:05:00.000Z",
  });
  const kinds = () => lines.map((l) => l["kind"]).filter((k) => k !== "llm.call");
  const line = (kind: string) => lines.find((l) => l["kind"] === kind);
  return { store, handle, lines, kinds, line, calls: () => calls };
}

const gas = "There's a strong smell of gas in the entrance hall.";

describe("message handler (rungs 2-3)", () => {
  it("a new problem becomes version 1 of a new case, with its Dwelly calls queued and rung 5 traced", async () => {
    const t = setup([answer({ urgency: "emergency", next_step: "external", safety_advice: "Leave the building." })]);
    await t.handle(message("evt_1", gas));

    const caseId = String(t.line("case.version")?.["case_id"]);
    expect(await t.store.getCase(caseId)).toMatchObject({
      version: 1, urgency: "emergency", nextStep: "external", status: "in_progress", waitingOn: "external", propertyId: "prop_09", reporter: "tenant_09",
    });
    expect(t.kinds()).toEqual(["case.version", "action.queued", "action.queued", "intent.message_tenant"]);
    // gas is external (in_progress), and a Dwelly case is created open: POST, then PATCH
    const queued = await t.store.actionsForCase(caseId);
    expect(queued.map((a) => [a.kind, a.status, a.eventId])).toEqual([["case_open", "pending", "evt_1"], ["case_patch", "pending", "evt_1"]]);
    expect(queued[0]?.body).toMatchObject({ urgency: "emergency", property_id: "prop_09" });
    expect(queued[1]?.body).toEqual({ status: "in_progress" });
    expect(t.line("case.version")).toMatchObject({ event_id: "evt_1", linked_by: "new", applied: true });
    expect(t.line("intent.message_tenant")).toMatchObject({ to: "tenant_09", safety_advice: "Leave the building." });
  });

  it("a later message at the same property is the next version of the open case", async () => {
    const t = setup([answer({ urgency: "medium" }), answer({ urgency: "high", why: "water reached the flat below" })]);
    await t.handle(message("evt_1", "tiny leak under the sink, no rush"));
    await t.handle(message("evt_2", "brown stain on my ceiling", "tenant_10"));

    const caseId = String(t.line("case.version")?.["case_id"]);
    const history = await t.store.caseHistory(caseId);
    expect(history.map((h) => [h.version, h.causeId, h.urgency])).toEqual([[1, "evt_1", "medium"], [2, "evt_2", "high"]]);
    expect(history[1]?.changed).toContain("urgency");
    expect((await t.store.actionsForCase(caseId)).map((a) => [a.kind, a.body, a.caseVersion])).toEqual([
      ["case_open", expect.objectContaining({ urgency: "medium" }), 1],
      ["case_patch", { urgency: "high" }, 2],
    ]);
    expect(t.lines.filter((l) => l["kind"] === "case.version").map((l) => l["linked_by"])).toEqual(["new", "open_case_at_property"]);
  });

  it("the same event again (redelivery) is skipped before the LLM call", async () => {
    const t = setup([answer({})]);
    await t.handle(message("evt_1", gas));
    await t.handle(message("evt_1", gas));
    expect(t.calls()).toBe(1);
    expect(t.kinds().at(-1)).toBe("event.duplicate");
  });

  it("a redelivered event does not open a second case even after its case closed", async () => {
    const t = setup([answer({ urgency: "low", next_step: "out_of_scope" })]);
    await t.handle(message("evt_1", "the neighbours upstairs are stomping at 2am"));
    expect(await t.store.findOpenCase("prop_09")).toBeNull(); // closed: out_of_scope
    await t.handle(message("evt_1", "the neighbours upstairs are stomping at 2am"));
    expect(t.calls()).toBe(1);
    expect(t.lines.filter((l) => l["kind"] === "case.version")).toHaveLength(1);
    expect(await t.store.pendingActions(10)).toHaveLength(2); // POST + PATCH closed, queued once
  });

  it("ignores events that are not messages, without calling the LLM", async () => {
    const t = setup([]);
    await t.handle({ ...message("evt_1", "x"), type: "work_order.accepted", payload: {} });
    expect(t.calls()).toBe(0);
    expect(t.line("event.ignored")).toMatchObject({ event_id: "evt_1", type: "work_order.accepted" });
  });

  it("two invalid answers: needs_review, urgency from the safety floor", async () => {
    const t = setup(["not json", "{}"]);
    await t.handle(message("evt_1", gas));
    expect(t.line("case.version")).toMatchObject({ needs_review: true, urgency: "emergency", next_step: "external", attempts: 2 });
  });

  it("OPEN_CASE_OUT_OF_SCOPE=false: the case is kept, nothing is queued, the skip is traced", async () => {
    const t = setup([answer({ urgency: "low", next_step: "out_of_scope" })], false);
    await t.handle(message("evt_1", "the neighbours upstairs are stomping at 2am"));
    expect(t.line("action.skipped")).toMatchObject({ action: "case_open", reason: "OPEN_CASE_OUT_OF_SCOPE=false" });
    expect(await t.store.pendingActions(10)).toEqual([]);
  });

  it("a message without a property in the payload uses the property we know for the sender", async () => {
    const t = setup([answer({}), answer({})]);
    await t.handle(message("evt_1", "tiny leak"));
    await t.handle({ ...message("evt_2", "it got worse"), payload: { body: "it got worse" } });
    expect(t.lines.filter((l) => l["kind"] === "case.version").map((l) => [l["linked_by"], l["property_id"]])).toEqual([
      ["new", "prop_09"],
      ["open_case_at_property", "prop_09"],
    ]);
  });
});
