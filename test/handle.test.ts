// The rung 2 handler end to end, with an in-memory store and a fake OpenRouter.
import { describe, expect, it } from "vitest";
import type { WorldEvent } from "../src/api/types.js";
import { CLASSIFY_PROMPT, loadPrompt } from "../src/agent/classify.js";
import { createHandler } from "../src/agent/handle.js";
import { REPLY_PROMPT } from "../src/agent/reply.js";
import { openSqliteStore } from "../src/store/sqlite.js";
import { createTracer } from "../src/trace.js";

const message = (id: string, body: string, actor = "tenant_09", property: string | null = "prop_09", role = "tenant"): WorldEvent => ({
  id,
  cursor: Number(id.replace(/\D/g, "")),
  type: "message.received",
  channel: "email",
  actor: { id: actor, role, name: role === "tenant" ? "Nadia" : "Ms Whitlow" },
  sim_ms: 0,
  occurred_at: "2026-11-11T17:04:00.000Z",
  payload: property ? { body, property_id: property } : { body },
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

/** A fake OpenRouter: classify calls get `answers` in order, writer calls get `replies`. */
function setup(answers: string[], openCaseOutOfScope = true, replies: string[] = []) {
  let calls = 0;
  let writes = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const system = (JSON.parse(String(init.body)) as { messages: { content: string }[] }).messages[0]?.content ?? "";
    const content = system.startsWith("You write one message")
      ? (replies[writes++] ?? JSON.stringify({ body: `Reply ${writes}.` }))
      : (answers[calls++] ?? "");
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
    writer: { llm: { apiKey: "k", model: "m" }, prompt: loadPrompt(REPLY_PROMPT), tracer, fetchImpl, emergencyNumber: "999" },
    openCaseOutOfScope,
    now: () => "2026-11-11T17:05:00.000Z",
  });
  const kinds = () => lines.map((l) => l["kind"]).filter((k) => k !== "llm.call");
  const line = (kind: string) => lines.find((l) => l["kind"] === kind);
  const queued = (kind: string) => lines.filter((l) => l["kind"] === "action.queued" && l["action"] === kind);
  return { store, handle, lines, kinds, line, queued, calls: () => calls, writes: () => writes };
}

const gas = "There's a strong smell of gas in the entrance hall.";

describe("message handler (rungs 2-3)", () => {
  it("a new problem becomes version 1 of a new case, with its message and its Dwelly calls queued", async () => {
    const t = setup([answer({ urgency: "emergency", next_step: "external", safety_advice: "Leave the building." })]);
    await t.handle(message("evt_1", gas));

    const caseId = String(t.line("case.version")?.["case_id"]);
    expect(await t.store.getCase(caseId)).toMatchObject({
      version: 1, urgency: "emergency", nextStep: "external", status: "in_progress", waitingOn: "external", propertyId: "prop_09", reporter: "tenant_09",
    });
    expect(t.kinds()).toEqual(["case.version", "action.queued", "action.queued", "action.queued"]);
    // the message first (safety must not wait for POST /cases); gas is external
    // (in_progress), and a Dwelly case is created open: POST, then PATCH
    const queued = await t.store.actionsForCase(caseId);
    expect(queued.map((a) => [a.kind, a.status, a.eventId])).toEqual([
      ["msg_send", "pending", "evt_1"], ["case_open", "pending", "evt_1"], ["case_patch", "pending", "evt_1"],
    ]);
    expect(queued[0]?.body).toEqual({
      to: "tenant_09",
      subject: "Re: t",
      body: "If anyone is in danger, get to a safe place and call 999 now.\n\nReply 1.",
    });
    expect(queued[1]?.body).toMatchObject({ urgency: "emergency", property_id: "prop_09" });
    expect(queued[2]?.body).toEqual({ status: "in_progress" });
    expect(t.line("case.version")).toMatchObject({ event_id: "evt_1", linked_by: "new", applied: true, role: "tenant", text: gas });
    expect(t.queued("msg_send")[0]).toMatchObject({ to: "tenant_09", reasons: ["new_case"], source: "model" });
  });

  it("a later message at the same property is the next version of the open case", async () => {
    const t = setup([answer({ urgency: "medium" }), answer({ urgency: "high", why: "water reached the flat below" })]);
    await t.handle(message("evt_1", "tiny leak under the sink, no rush"));
    await t.handle(message("evt_2", "brown stain on my ceiling", "tenant_10"));

    const caseId = String(t.line("case.version")?.["case_id"]);
    const history = await t.store.caseHistory(caseId);
    expect(history.map((h) => [h.version, h.causeId, h.urgency])).toEqual([[1, "evt_1", "medium"], [2, "evt_2", "high"]]);
    expect(history[1]?.changed).toContain("urgency");
    expect((await t.store.actionsForCase(caseId)).filter((a) => a.kind !== "msg_send").map((a) => [a.kind, a.body, a.caseVersion])).toEqual([
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
    expect((await t.store.pendingActions(10)).map((a) => a.kind)).toEqual(["msg_send", "case_open", "case_patch"]); // queued once
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
    // no Dwelly case, but the tenant still gets an honest answer
    expect((await t.store.pendingActions(10)).map((a) => a.kind)).toEqual(["msg_send"]);
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

describe("role guard: only a tenant's report moves the case", () => {
  it("a landlord's 'approved' keeps the urgency, the next step and the status", async () => {
    const t = setup([
      answer({ urgency: "high", next_step: "contractor" }),
      answer({ urgency: "low", next_step: "log_only", summary: "landlord approved the spend" }),
    ]);
    await t.handle(message("evt_1", "water is coming through my ceiling"));
    await t.handle(message("evt_2", "Approved - please proceed.", "landlord_09", "prop_09", "landlord"));

    const caseId = String(t.line("case.version")?.["case_id"]);
    expect(await t.store.getCase(caseId)).toMatchObject({
      version: 2, urgency: "high", nextStep: "contractor", status: "open", waitingOn: "contractor", summary: "landlord approved the spend",
    });
    expect(t.lines.filter((l) => l["kind"] === "case.version").map((l) => l["role_guard"])).toEqual([false, true]);
    // nothing changed that Dwelly holds: no PATCH; "Approved." asks nothing: no message
    expect((await t.store.actionsForCase(caseId)).map((a) => a.kind)).toEqual(["msg_send", "case_open"]);
  });

  it("a landlord's message can still raise the urgency", async () => {
    const t = setup([answer({ urgency: "medium" }), answer({ urgency: "high", next_step: "log_only" })]);
    await t.handle(message("evt_1", "small leak under the sink"));
    await t.handle(message("evt_2", "The tenant below says water is coming through her ceiling.", "landlord_09", "prop_09", "landlord"));
    const caseId = String(t.line("case.version")?.["case_id"]);
    expect(await t.store.getCase(caseId)).toMatchObject({ urgency: "high", nextStep: "contractor", status: "open" });
  });

  it("a contractor's message we cannot place opens no case and makes no LLM call", async () => {
    const t = setup([answer({})]);
    await t.handle(message("evt_1", "We can do Thursday 12-2 for the tap.", "c_A", null, "contractor"));
    expect(t.calls()).toBe(0);
    expect(t.kinds()).toEqual(["message.unlinked"]);
    expect(t.line("message.unlinked")).toMatchObject({ event_id: "evt_1", from: "c_A", role: "contractor" });
    expect(await t.store.pendingActions(10)).toEqual([]);
  });
});

describe("rung 5: messages from the handler", () => {
  it("a tenant's 'thanks' that changes nothing gets no message; a question does", async () => {
    const t = setup([answer({}), answer({}), answer({})]);
    await t.handle(message("evt_1", "tiny leak under the sink"));
    await t.handle(message("evt_2", "Thanks, will do."));
    await t.handle(message("evt_3", "When will the plumber come?"));
    expect(t.queued("msg_send").map((l) => [l["event_id"], l["reasons"]])).toEqual([["evt_1", ["new_case"]], ["evt_3", ["asked"]]]);
    expect(t.writes()).toBe(2);
  });

  it("a landlord's question gets an answer, without the tenant's safety line", async () => {
    const t = setup([answer({ urgency: "emergency", next_step: "external" }), answer({ urgency: "emergency", next_step: "external" })]);
    await t.handle(message("evt_1", gas));
    await t.handle(message("evt_2", "Has the gas board been called?", "landlord_09", "prop_09", "landlord"));
    const second = t.queued("msg_send")[1];
    expect(second).toMatchObject({ event_id: "evt_2", to: "landlord_09", reasons: ["asked"], body: { body: "Reply 2." } });
  });

  it("the loop guard stops the sixth message in a row and every one after it while the case does not move", async () => {
    const asks = (i: number) => answer({ next_step: "need_info", open_questions: [`question ${i}?`] });
    const t = setup([1, 2, 3, 4, 5, 6, 7].map(asks));
    for (const i of [1, 2, 3, 4, 5, 6, 7]) await t.handle(message(`evt_${i}`, `answer ${i}`));
    expect(t.queued("msg_send")).toHaveLength(5);
    expect(t.lines.filter((l) => l["kind"] === "speak.loop_guard").map((l) => l["event_id"])).toEqual(["evt_6", "evt_7"]);
    const caseId = String(t.line("case.version")?.["case_id"]);
    expect((await t.store.getCase(caseId))?.needsReview).toBe(true);
    // the stopped messages are kept as 'held' (never sent, never written): a person decides
    const held = (await t.store.actionsForCase(caseId)).filter((a) => a.status === "held");
    expect(held.map((a) => [a.kind, a.eventId])).toEqual([["msg_send", "evt_6"], ["msg_send", "evt_7"]]);
    expect(t.writes()).toBe(5);
    expect((await t.store.pendingActions(50)).some((a) => a.status === "held")).toBe(false);
  });

  it("after the loop guard, a move of the case lets messages through again", async () => {
    const asks = (i: number) => answer({ next_step: "need_info", open_questions: [`question ${i}?`] });
    const t = setup([...[1, 2, 3, 4, 5, 6].map(asks), answer({ next_step: "contractor", open_questions: [] })]);
    for (const i of [1, 2, 3, 4, 5, 6, 7]) await t.handle(message(`evt_${i}`, `answer ${i}`));
    // evt_7: need_info -> contractor (waiting_on tenant -> contractor): the case moved
    expect(t.queued("msg_send").map((l) => l["event_id"])).toEqual(["evt_1", "evt_2", "evt_3", "evt_4", "evt_5", "evt_7"]);
  });

  it("needs_review stays set: a later good answer does not clear it; only a person does (review 16 Nov)", async () => {
    // message 1: the model's answer stays invalid after the retry -> needs_review
    const t = setup(["not json", "still not json", answer({ urgency: "medium", next_step: "contractor" })]);
    await t.handle(message("evt_1", "The kitchen tap drips."));
    const caseId = String(t.line("case.version")?.["case_id"]);
    expect((await t.store.getCase(caseId))?.needsReview).toBe(true);
    // message 2: a valid answer
    await t.handle(message("evt_2", "It is the cold side."));
    expect(await t.store.getCase(caseId)).toMatchObject({ version: 2, needsReview: true });
  });

  it("a redelivered event writes no second message", async () => {
    const t = setup([answer({})]);
    await t.handle(message("evt_1", gas));
    await t.handle(message("evt_1", gas));
    expect(t.writes()).toBe(1);
    expect((await t.store.pendingActions(10)).map((a) => a.kind)).toEqual(["msg_send", "case_open", "case_patch"]);
  });

  it("an answer to a closed case joins that case: no new case, and a 'thanks' gets no message", async () => {
    const t = setup([answer({ urgency: "low", next_step: "out_of_scope" }), answer({ urgency: "low", next_step: "out_of_scope" })]);
    await t.handle(message("evt_1", "the neighbours upstairs are stomping at 2am"));
    await t.handle(message("evt_2", "Thanks, will do."));
    expect(t.lines.filter((l) => l["kind"] === "case.version").map((l) => [l["linked_by"], l["version"]])).toEqual([
      ["new", 1], ["recent_closed_case", 2],
    ]);
    expect(t.queued("msg_send")).toHaveLength(1);
    expect(t.queued("case_open")).toHaveLength(1);
  });

  it("after the window a tenant's message is a new report again", async () => {
    let now = "2026-11-11T17:05:00.000Z";
    const t = setup([answer({ urgency: "low", next_step: "log_only" }), answer({})]);
    const store = t.store;
    const handle = createHandler({
      store,
      tracer: createTracer("t2", (l) => t.lines.push(JSON.parse(l))),
      classify: { llm: { apiKey: "k", model: "m" }, prompt: loadPrompt(CLASSIFY_PROMPT), tracer: createTracer("x", () => {}), fetchImpl: fakeLlm([answer({})]) },
      writer: { llm: { apiKey: "k", model: "m" }, prompt: loadPrompt(REPLY_PROMPT), tracer: createTracer("x", () => {}), fetchImpl: fakeLlm([JSON.stringify({ body: "ok" })]), emergencyNumber: "999" },
      openCaseOutOfScope: true,
      now: () => now,
    });
    await t.handle(message("evt_1", "a small scuff on the hallway wall"));
    now = "2026-11-15T17:05:00.000Z"; // four days later
    await handle(message("evt_2", "the bathroom tap now drips"));
    expect(t.lines.filter((l) => l["kind"] === "case.version").map((l) => l["linked_by"])).toEqual(["new", "new"]);
  });

  it("the 72 h window counts from the close, not from the last joined message (review 16 Nov)", async () => {
    let now = "2026-11-11T12:00:00.000Z";
    const lines: Record<string, unknown>[] = [];
    const closed = answer({ urgency: "low", next_step: "log_only" });
    const handle = createHandler({
      store: openSqliteStore(":memory:"),
      tracer: createTracer("t3", (l) => lines.push(JSON.parse(l))),
      classify: { llm: { apiKey: "k", model: "m" }, prompt: loadPrompt(CLASSIFY_PROMPT), tracer: createTracer("x", () => {}), fetchImpl: fakeLlm([closed]) },
      writer: { llm: { apiKey: "k", model: "m" }, prompt: loadPrompt(REPLY_PROMPT), tracer: createTracer("x", () => {}), fetchImpl: fakeLlm([JSON.stringify({ body: "ok" })]), emergencyNumber: "999" },
      openCaseOutOfScope: true,
      now: () => now,
    });
    await handle(message("evt_1", "a small scuff on the hallway wall")); // closed at once (log_only)
    now = "2026-11-14T10:00:00.000Z"; // 70 h after the close: joins
    await handle(message("evt_2", "Thanks, will do."));
    now = "2026-11-14T13:00:00.000Z"; // 73 h after the close: a new report
    await handle(message("evt_3", "another scuff by the door"));
    expect(lines.filter((l) => l["kind"] === "case.version").map((l) => l["linked_by"])).toEqual(["new", "recent_closed_case", "new"]);
  });
});

/** A fake OpenRouter that always answers with the same content. */
function fakeLlm(contents: string[]): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({ id: "g", model: "m", provider: "P", choices: [{ message: { content: contents[0] ?? "" }, finish_reason: "stop" }], usage: {} }),
      { status: 200 },
    )) as unknown as typeof fetch;
}
