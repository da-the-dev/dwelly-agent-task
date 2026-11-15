// Rung 2 state: a case evolves as versions; the latest one is the case.
import { describe, expect, it } from "vitest";
import { changedFields, type CaseRecord, type CaseVersion } from "../src/case.js";
import { openSqliteStore } from "../src/store/sqlite.js";

const base: CaseRecord = {
  id: "case_1",
  dwellyCaseId: null,
  propertyId: "prop_02",
  reporter: "tenant_02",
  status: "open",
  waitingOn: "tenant",
  outcome: null,
  urgency: "medium",
  nextStep: "need_info",
  contractorId: null,
  title: "Leak under the kitchen sink",
  summary: "Tiny leak under the sink, tenant says no rush.",
  openQuestions: ["Which joint is dripping?"],
  needsReview: false,
  version: 1,
  createdAt: "2026-11-11T10:00:00.000Z",
  updatedAt: "2026-11-11T10:00:00.000Z",
};

const v = (c: CaseRecord, causeId: string, prev: CaseRecord | null, why = "test"): CaseVersion => ({
  ...c,
  causeKind: "event",
  causeId,
  changed: changedFields(prev, c),
  why,
});

describe("case versions", () => {
  it("a version becomes the case's latest state, and history keeps every version in order", async () => {
    const store = openSqliteStore(":memory:");
    await store.saveCaseVersion(v(base, "evt_3", null));
    const v2: CaseRecord = { ...base, version: 2, urgency: "high", nextStep: "contractor", openQuestions: [], updatedAt: "2026-11-11T11:00:00.000Z" };
    await store.saveCaseVersion(v(v2, "evt_15", base, "water reached the flat below"));

    expect(await store.getCase("case_1")).toEqual(v2);
    const history = await store.caseHistory("case_1");
    expect(history.map((h) => [h.version, h.causeId, h.urgency])).toEqual([[1, "evt_3", "medium"], [2, "evt_15", "high"]]);
    expect(history[1]?.changed).toEqual(["urgency", "nextStep", "openQuestions"]);
    expect(history[1]?.why).toBe("water reached the flat below");
  });

  it("the same event twice (at-least-once redelivery) does not add a version or change the case", async () => {
    const store = openSqliteStore(":memory:");
    expect(await store.saveCaseVersion(v(base, "evt_3", null))).toEqual({ applied: true });
    const replay = { ...base, version: 2, urgency: "emergency" as const };
    expect(await store.saveCaseVersion(v(replay, "evt_3", base))).toEqual({ applied: false });
    expect((await store.getCase("case_1"))?.urgency).toBe("medium");
    expect(await store.caseHistory("case_1")).toHaveLength(1);
  });

  it("finds the open case at a property, and ignores closed ones", async () => {
    const store = openSqliteStore(":memory:");
    await store.saveCaseVersion(v({ ...base, id: "case_old", status: "closed", outcome: "resolved" }, "evt_1", null));
    expect(await store.findOpenCase("prop_02")).toBeNull();
    await store.saveCaseVersion(v(base, "evt_3", null));
    expect((await store.findOpenCase("prop_02"))?.id).toBe("case_1");
    expect(await store.findOpenCase("prop_99")).toBeNull();
  });

  it("finds a case by its Dwelly id, and the case an event already touched", async () => {
    const store = openSqliteStore(":memory:");
    await store.saveCaseVersion(v({ ...base, dwellyCaseId: "d-42" }, "evt_3", null));
    expect((await store.findCaseByDwellyId("d-42"))?.id).toBe("case_1");
    expect(await store.findCaseByDwellyId("d-0")).toBeNull();
    expect(await store.caseForCause("evt_3")).toBe("case_1");
    expect(await store.caseForCause("evt_4")).toBeNull();
  });

  it("a version that would reuse a version number fails and leaves the case untouched", async () => {
    const store = openSqliteStore(":memory:");
    await store.saveCaseVersion(v(base, "evt_3", null));
    await expect(store.saveCaseVersion(v({ ...base, urgency: "high" }, "evt_4", base))).rejects.toThrow();
    expect((await store.getCase("case_1"))?.urgency).toBe("medium");
  });
});

describe("actors", () => {
  it("keeps a known property when a later event has none", async () => {
    const store = openSqliteStore(":memory:");
    await store.upsertActor({ id: "tenant_02", role: "tenant", name: "Hannah", propertyId: "prop_02" }, "evt_3");
    await store.upsertActor({ id: "tenant_02", role: "tenant", name: "Hannah Osei", propertyId: null }, "evt_7");
    expect(await store.getActor("tenant_02")).toEqual({ id: "tenant_02", role: "tenant", name: "Hannah Osei", propertyId: "prop_02" });
  });
});

describe("outbox actions (rung 3)", () => {
  const open = { id: "act_1", kind: "case_open" as const, body: { title: "Leak", urgency: "medium" as const } };
  const close = { id: "act_2", kind: "case_patch" as const, body: { status: "closed" as const } };

  it("actions are queued with their version, in order, pending", async () => {
    const store = openSqliteStore(":memory:");
    await store.saveCaseVersion(v(base, "evt_3", null), [open, close]);
    const queued = await store.pendingActions(10);
    expect(queued.map((a) => [a.id, a.kind, a.status, a.caseId, a.caseVersion, a.seq, a.eventId])).toEqual([
      ["act_1", "case_open", "pending", "case_1", 1, 0, "evt_3"],
      ["act_2", "case_patch", "pending", "case_1", 1, 1, "evt_3"],
    ]);
    expect(queued[0]?.body).toEqual({ title: "Leak", urgency: "medium" });
  });

  it("a redelivered event queues no second action (no second POST /cases)", async () => {
    const store = openSqliteStore(":memory:");
    await store.saveCaseVersion(v(base, "evt_3", null), [open]);
    await store.saveCaseVersion(v(base, "evt_3", null), [{ ...open, id: "act_9" }]);
    expect((await store.actionsForCase("case_1")).map((a) => a.id)).toEqual(["act_1"]);
  });

  it("marking an action sent writes the case version in the same transaction", async () => {
    const store = openSqliteStore(":memory:");
    await store.saveCaseVersion(v(base, "evt_3", null), [open]);
    const withId = { ...base, dwellyCaseId: "d-1", version: 2 };
    await store.markAction("act_1", { status: "sent", resultId: "d-1", sentAt: "t" }, { ...v(withId, "act_1", base), causeKind: "action" });
    expect(await store.findCaseByDwellyId("d-1")).toMatchObject({ id: "case_1", version: 2 });
    expect((await store.actionsForCase("case_1"))[0]).toMatchObject({ status: "sent", resultId: "d-1" });
  });

  it("a version that cannot be written leaves the action as it was", async () => {
    const store = openSqliteStore(":memory:");
    await store.saveCaseVersion(v(base, "evt_3", null), [open]);
    // version 1 already exists: the write fails, and the status change rolls back with it
    await expect(store.markAction("act_1", { status: "sent" }, v({ ...base, urgency: "high" }, "act_1", base))).rejects.toThrow();
    expect((await store.actionsForCase("case_1"))[0]?.status).toBe("pending");
  });

  it("read-only views for reports: every case, every action, inbox counts by status", async () => {
    const store = openSqliteStore(":memory:");
    await store.saveCaseVersion(v(base, "evt_3", null), [open, close]);
    const other: CaseRecord = { ...base, id: "case_2", propertyId: "prop_03", createdAt: "2026-11-11T12:00:00.000Z" };
    await store.saveCaseVersion(v(other, "evt_4", null));
    await store.markAction("act_1", { status: "sent", resultId: "d-1" });
    expect((await store.allCases()).map((c) => c.id)).toEqual(["case_1", "case_2"]);
    expect((await store.allActions()).map((a) => [a.id, a.status])).toEqual([["act_1", "sent"], ["act_2", "pending"]]);
    expect(await store.inboxCounts()).toEqual({ pending: 0, done: 0, failed: 0 });
  });

  it("after a crash mid-call: a POST becomes unknown, a PATCH goes back to pending", async () => {
    const store = openSqliteStore(":memory:");
    await store.saveCaseVersion(v(base, "evt_3", null), [open, close]);
    await store.markAction("act_1", { status: "sending", attempt: true });
    await store.markAction("act_2", { status: "sending", attempt: true });
    expect((await store.recoverSending()).map((a) => a.id)).toEqual(["act_1", "act_2"]);
    expect((await store.actionsForCase("case_1")).map((a) => [a.status, a.attempts])).toEqual([["unknown", 1], ["pending", 1]]);
  });
});
