// Rung 3: which calls a new case version needs.
import { describe, expect, it } from "vitest";
import { actionsFor, describeCase } from "../src/agent/actions.js";
import type { CaseRecord } from "../src/case.js";

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

let n = 0;
const id = () => `act_${++n}`;
const on = { openCaseOutOfScope: true };

describe("actionsFor", () => {
  it("a new case (need_info too) is one POST with title, urgency, property and our ref", () => {
    const plan = actionsFor(null, base, on, id);
    expect(plan.skipped).toBeNull();
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({
      kind: "case_open",
      body: { title: base.title, urgency: "medium", property_id: "prop_02", description: `${base.summary}\n\nref: case_1` },
    });
  });

  it("a new case that closes at once (log_only) is a POST, then a PATCH to closed", () => {
    const plan = actionsFor(null, { ...base, nextStep: "log_only", status: "closed", urgency: "low" }, on, id);
    expect(plan.actions.map((a) => [a.kind, a.body])).toEqual([
      ["case_open", expect.objectContaining({ urgency: "low" })],
      ["case_patch", { status: "closed" }],
    ]);
  });

  it("gas (external, in_progress): a POST, then a PATCH to in_progress", () => {
    const plan = actionsFor(null, { ...base, nextStep: "external", status: "in_progress", urgency: "emergency" }, on, id);
    expect(plan.actions.map((a) => a.kind)).toEqual(["case_open", "case_patch"]);
  });

  it("out_of_scope with OPEN_CASE_OUT_OF_SCOPE=false: nothing, and says why", () => {
    const plan = actionsFor(null, { ...base, nextStep: "out_of_scope", status: "closed" }, { openCaseOutOfScope: false }, id);
    expect(plan).toEqual({ actions: [], skipped: "OPEN_CASE_OUT_OF_SCOPE=false" });
  });

  it("urgency up on an existing case (04 at messages[6]): one PATCH with only the urgency", () => {
    const plan = actionsFor(base, { ...base, urgency: "high", summary: "now reaching the flat below", version: 2 }, on, id);
    expect(plan.actions.map((a) => [a.kind, a.body])).toEqual([["case_patch", { urgency: "high" }]]);
  });

  it("only the summary changed: no call", () => {
    expect(actionsFor(base, { ...base, summary: "more detail", version: 2 }, on, id).actions).toEqual([]);
  });

  it("keeps within the spec's limits", () => {
    const long = { ...base, title: "x".repeat(400), summary: "y".repeat(20_000), propertyId: "p".repeat(150) };
    const body = actionsFor(null, long, on, id).actions[0]?.body as Record<string, string>;
    expect(body["title"]).toHaveLength(300);
    expect(body["property_id"]).toHaveLength(100);
    expect(body["description"]).toHaveLength(10_000);
    expect(describeCase(long).endsWith("ref: case_1")).toBe(true);
  });
});
