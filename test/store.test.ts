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
