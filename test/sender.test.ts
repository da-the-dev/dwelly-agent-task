// Rung 3: the outbox sender. A fake world API answers from a script; the store is real.
import { describe, expect, it } from "vitest";
import type { NewAction } from "../src/action.js";
import { ApiError, type Api } from "../src/api/client.js";
import type { Case } from "../src/api/types.js";
import { createSender } from "../src/agent/sender.js";
import { changedFields, type CaseRecord } from "../src/case.js";
import { tick } from "../src/agent/loop.js";
import { openSqliteStore } from "../src/store/sqlite.js";
import { createTracer } from "../src/trace.js";

const base: CaseRecord = {
  id: "case_1",
  dwellyCaseId: null,
  propertyId: "prop_05",
  reporter: "tenant_05",
  status: "in_progress",
  waitingOn: "external",
  outcome: null,
  urgency: "emergency",
  nextStep: "external",
  contractorId: null,
  title: "Gas smell in the hall",
  summary: "Strong smell of gas in the entrance hall.",
  openQuestions: [],
  needsReview: false,
  version: 1,
  createdAt: "2026-11-15T10:00:00.000Z",
  updatedAt: "2026-11-15T10:00:00.000Z",
};
const open: NewAction = { id: "act_1", kind: "case_open", body: { title: base.title, urgency: "emergency", property_id: "prop_05" } };
const patch: NewAction = { id: "act_2", kind: "case_patch", body: { status: "in_progress" } };

type Reply = Case | Error;
const ok = (id = "d-1") => ({ id }) as Case;
const status = (s: number) => new ApiError(s, "X", "/cases", { error: `e${s}` });

/** A world that answers each call with the next scripted reply, and records the calls. */
function world(replies: Reply[]) {
  const calls: string[] = [];
  const next = (call: string) => {
    calls.push(call);
    const r = replies.shift() ?? ok();
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  };
  const api: Pick<Api, "createCase" | "patchCase"> = {
    createCase: (b) => next(`POST ${b.urgency}`),
    patchCase: (id, b) => next(`PATCH ${id} ${JSON.stringify(b)}`),
  };
  return { api, calls };
}

async function setup(replies: Reply[], actions: NewAction[] = [open, patch]) {
  const store = openSqliteStore(":memory:");
  await store.saveCaseVersion({ ...base, causeKind: "event", causeId: "evt_5", changed: changedFields(null, base), why: "gas" }, actions);
  const w = world(replies);
  const lines: Record<string, unknown>[] = [];
  let t = 0;
  const sender = createSender({
    api: w.api,
    store,
    tracer: createTracer("t", (l) => lines.push(JSON.parse(l))),
    now: () => "2026-11-15T10:01:00.000Z",
    clock: () => t,
    rateLimitPauseMs: 1000,
  });
  const statuses = async () => (await store.actionsForCase("case_1")).map((a) => a.status);
  const kinds = () => lines.map((l) => l["kind"]);
  return { store, sender, calls: w.calls, lines, kinds, statuses, advance: (ms: number) => void (t += ms) };
}

describe("outbox sender", () => {
  it("201: the Dwelly id becomes a case version caused by the action; the PATCH then goes", async () => {
    const s = await setup([ok("d-1"), ok("d-1")]);
    expect(await s.sender.drain()).toMatchObject({ sent: 2 });
    expect(s.calls).toEqual(["POST emergency", 'PATCH d-1 {"status":"in_progress"}']);
    const history = await s.store.caseHistory("case_1");
    expect(history.map((h) => [h.version, h.causeKind, h.causeId, h.dwellyCaseId])).toEqual([
      [1, "event", "evt_5", null],
      [2, "action", "act_1", "d-1"],
    ]);
    expect(history[1]?.changed).toEqual(["dwellyCaseId"]);
    expect(await s.statuses()).toEqual(["sent", "sent"]);
    expect(s.lines.filter((l) => l["kind"] === "action.sent")).toHaveLength(2);
  });

  it("a POST that times out is unknown, flags the case, and is never sent again", async () => {
    const s = await setup([new DOMException("The operation was aborted due to timeout", "TimeoutError")]);
    expect(await s.sender.drain()).toMatchObject({ unknown: 1, sent: 0 });
    await s.sender.drain();
    await s.sender.drain();
    expect(s.calls).toEqual(["POST emergency"]);
    expect(await s.statuses()).toEqual(["unknown", "pending"]); // the PATCH waits for a person
    expect(await s.store.getCase("case_1")).toMatchObject({ needsReview: true, dwellyCaseId: null, version: 2 });
    expect(s.kinds()).toContain("action.unknown");
  });

  it("a 5xx on POST is unknown too: the server may have created the case", async () => {
    const s = await setup([status(502)]);
    await s.sender.drain();
    expect(await s.statuses()).toEqual(["unknown", "pending"]);
  });

  it("429: back to pending, sending pauses, then the action goes", async () => {
    const s = await setup([status(429)]);
    expect(await s.sender.drain()).toMatchObject({ deferred: 1 });
    await s.sender.drain(); // still paused: no call
    expect(s.calls).toEqual(["POST emergency"]);
    s.advance(1000);
    expect(await s.sender.drain()).toMatchObject({ sent: 2 });
    expect((await s.store.actionsForCase("case_1"))[0]).toMatchObject({ status: "sent", attempts: 2 });
  });

  it("403: the session is over; nothing more is sent this run", async () => {
    const s = await setup([status(403)]);
    await s.sender.drain();
    s.advance(60_000);
    await s.sender.drain();
    expect(s.calls).toEqual(["POST emergency"]);
    expect(await s.statuses()).toEqual(["pending", "pending"]);
    expect(s.kinds()).toContain("session.ended");
  });

  it("400: our request is wrong; failed, the case needs review", async () => {
    const s = await setup([status(400)]);
    expect(await s.sender.drain()).toMatchObject({ failed: 1 });
    expect(await s.statuses()).toEqual(["failed", "pending"]);
    expect((await s.store.getCase("case_1"))?.needsReview).toBe(true);
  });

  it("a PATCH that times out is retried on the next drain (PATCH is idempotent)", async () => {
    const s = await setup([ok("d-1"), new TypeError("fetch failed"), ok("d-1")]);
    expect(await s.sender.drain()).toMatchObject({ sent: 1, deferred: 1 });
    expect(await s.sender.drain()).toMatchObject({ sent: 1 });
    expect(s.calls).toEqual(["POST emergency", 'PATCH d-1 {"status":"in_progress"}', 'PATCH d-1 {"status":"in_progress"}']);
  });

  it("a crash mid-call: on restart the POST is unknown (not re-sent), a PATCH is pending again", async () => {
    const s = await setup([ok("d-1")], [open]);
    await s.store.markAction("act_1", { status: "sending", attempt: true }); // then the process died
    await s.sender.drain();
    expect(s.calls).toEqual([]);
    expect(await s.statuses()).toEqual(["unknown"]);
    expect(s.lines.find((l) => l["kind"] === "action.recovered")).toMatchObject({ action_id: "act_1", to: "unknown" });
  });

  it("runs after each batch in the loop; its errors never stop the poll", async () => {
    const store = openSqliteStore(":memory:");
    const lines: Record<string, unknown>[] = [];
    const tracer = createTracer("t", (l) => lines.push(JSON.parse(l)));
    const api = { getEvents: async () => ({ events: [], next_cursor: 0 }) };
    await tick({ api, store, tracer, handle: async () => {}, afterBatch: async () => { throw new Error("db locked"); } });
    expect(lines.find((l) => l["kind"] === "send.error")).toMatchObject({ error: "db locked" });
  });
});
