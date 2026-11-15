import { describe, expect, it } from "vitest";
import type { Action } from "../src/action.js";
import type { CaseRecord } from "../src/case.js";
import { checkRun, failed, renderChecks, type RunInputs, type WorldState } from "../src/e2e/checks.js";
import { buildStory, type TraceLine } from "../src/story.js";

const SAFETY = "If anyone is in danger, get to a safe place and call 999 now.";

const kase = (over: Partial<CaseRecord> = {}): CaseRecord => ({
  id: "case_gas", dwellyCaseId: "d-gas", propertyId: "prop_06", reporter: "tenant_06", status: "in_progress", waitingOn: "external",
  outcome: null, urgency: "emergency", nextStep: "external", contractorId: null, title: "Gas smell", summary: "", openQuestions: [],
  needsReview: false, version: 2, createdAt: "t", updatedAt: "t", ...over,
});

const msg = (over: Partial<Action> & { to: string; text: string }): Action => {
  const { to, text, ...rest } = over;
  return {
    id: "act_m", kind: "msg_send", body: { to, subject: "Re", body: text }, caseId: "case_gas", caseVersion: 1, seq: 0,
    eventId: "evt_1", status: "sent", attempts: 1, resultId: null, error: null, createdAt: "t", sentAt: "t", ...rest,
  } as Action;
};
const open: Action = {
  id: "act_o", kind: "case_open", body: { title: "Gas smell", urgency: "emergency", property_id: "prop_06" }, caseId: "case_gas",
  caseVersion: 1, seq: 1, eventId: "evt_1", status: "sent", attempts: 1, resultId: "d-gas", error: null, createdAt: "t", sentAt: "t",
};

const trace = (extra: TraceLine[] = []): TraceLine[] => [
  { ts: "1", kind: "case.version", event_id: "evt_1", case_id: "case_gas", version: 1, urgency: "emergency", status: "in_progress", text: "gas" },
  { ts: "2", kind: "action.queued", event_id: "evt_1", case_id: "case_gas", action_id: "act_m", action: "msg_send", to: "tenant_06", reasons: ["new_case"] },
  ...extra,
];

const worldOk = (): WorldState => ({
  scenario: "t",
  cases: [{ id: "d-gas", property_id: "prop_06", urgency: "emergency", status: "in_progress" }],
  work_orders: [],
  outbox: [{ to: { id: "tenant_06", role: "tenant" }, message: { body: `${SAFETY}\n\nHi.` } }],
  log: [{ method: "POST", path: "/cases", status: 201, response: {} }],
});

const inputs = (over: Partial<RunInputs> = {}, lines = trace()): RunInputs => ({
  world: worldOk(),
  cases: [kase()],
  actions: [msg({ to: "tenant_06", text: `${SAFETY}\n\nHi.` }), open],
  inbox: { pending: 0, done: 3, failed: 0 },
  story: buildStory(lines),
  emergencyNumber: "999",
  ...over,
});

const failedNames = (r: RunInputs) => failed(checkRun(r)).map((c) => c.name);

describe("e2e checks", () => {
  it("a clean run passes every fail-level check, and says what it did not cover", () => {
    const checks = checkRun(inputs());
    expect(failed(checks)).toEqual([]);
    expect(renderChecks(checks)).toContain("0 work orders (rung 4 is not built)");
  });

  it("an empty run fails: a broken start is not a pass", () => {
    expect(failedNames(inputs({ cases: [], actions: [], world: { ...worldOk(), cases: [], outbox: [] } }))).toContain(
      "the agent handled at least one message",
    );
  });

  it("a pending or failed inbox event fails", () => {
    expect(failedNames(inputs({ inbox: { pending: 1, done: 2, failed: 1 } }))).toEqual(["no inbox event left pending or failed"]);
  });

  it("a call that was not sent fails", () => {
    const names = failedNames(inputs({ actions: [msg({ to: "tenant_06", text: SAFETY }), { ...open, status: "unknown", error: "timeout" }] }));
    expect(names).toContain("every queued call was sent");
  });

  it("a request the world rejected fails", () => {
    const world = { ...worldOk(), log: [...worldOk().log, { method: "PATCH", path: "/cases/x", status: 400, response: { error: "validation_failed" } }] };
    expect(failedNames(inputs({ world }))).toEqual(["the world rejected none of our requests"]);
  });

  it("two Dwelly cases at one property fail (POST /cases is not idempotent)", () => {
    const world = { ...worldOk(), cases: [...worldOk().cases, { id: "d-dup", property_id: "prop_06", urgency: "emergency", status: "open" }] };
    expect(failedNames(inputs({ world }))).toEqual(["at most one Dwelly case per property", "our cases and the world's cases match one to one"]);
  });

  it("a case of ours without a Dwelly case fails, unless POST was skipped on purpose", () => {
    const noId = inputs({ cases: [kase({ dwellyCaseId: null })], world: { ...worldOk(), cases: [] } });
    expect(failedNames(noId)).toEqual(["our cases and the world's cases match one to one"]);
    const skipped = trace([{ ts: "3", kind: "action.skipped", event_id: "evt_1", case_id: "case_gas", action: "case_open", reason: "out of scope" }]);
    expect(failedNames(inputs({ cases: [kase({ dwellyCaseId: null })], world: { ...worldOk(), cases: [] } }, skipped))).toEqual([]);
  });

  it("a message we sent that the world does not have fails", () => {
    expect(failedNames(inputs({ world: { ...worldOk(), outbox: [] } }))).toEqual([
      "the world received every message we sent",
      "every reporter got at least one message",
    ]);
  });

  it("an emergency message to the tenant without the safety line first fails", () => {
    expect(failedNames(inputs({ actions: [msg({ to: "tenant_06", text: "Hi, please leave." }), open] }))).toEqual([
      "emergency messages to the tenant start with the safety line",
    ]);
  });

  it("a message to a landlord who did not ask fails", () => {
    const lines = trace([
      { ts: "3", kind: "action.queued", event_id: "evt_1", case_id: "case_gas", action_id: "act_l", action: "msg_send", to: "landlord_06", reasons: ["new_case"] },
    ]);
    const world = { ...worldOk(), outbox: [...worldOk().outbox, { to: { id: "landlord_06", role: "landlord" }, message: { body: "FYI" } }] };
    const actions = [msg({ to: "tenant_06", text: SAFETY }), msg({ id: "act_l", to: "landlord_06", text: "FYI" }), open];
    expect(failedNames(inputs({ world, actions }, lines))).toEqual(["a landlord got a message only when they asked"]);
  });

  it("a message held by the loop guard is a warning, not an unsent call or a missing safety line", () => {
    const held = msg({ id: "act_h", to: "tenant_06", text: "(held by the loop guard: not written, not sent)", status: "held", sentAt: null, attempts: 0 });
    const checks = checkRun(inputs({ actions: [msg({ to: "tenant_06", text: SAFETY }), held, open] }));
    expect(failed(checks)).toEqual([]);
    expect(checks.find((c) => c.name === "no message held by the loop guard")).toMatchObject({ level: "warn", ok: false });
  });

  it("too many messages to one actor and a case needing review are warnings, not failures", () => {
    const outbox = Array.from({ length: 6 }, () => ({ to: { id: "tenant_06", role: "tenant" }, message: { body: SAFETY } }));
    const actions = [...outbox.map((_, i) => msg({ id: `act_${i}`, to: "tenant_06", text: SAFETY })), open];
    const checks = checkRun(inputs({ world: { ...worldOk(), outbox }, actions, cases: [kase({ needsReview: true })] }));
    expect(failed(checks)).toEqual([]);
    expect(checks.filter((c) => !c.ok).map((c) => c.level)).toEqual(["warn", "warn"]);
  });
});
