// npm run eval's set and scoring, without the LLM.
import { describe, expect, it } from "vitest";
import { isCritical, replyClaims, report, score, summaryClaims, type RunResult } from "../src/eval/score.js";
import { itemMessages, loadArchive, loadEvalSet, type EvalItem } from "../src/eval/set.js";

const archive = loadArchive();
const items = loadEvalSet();
const byId = (id: string) => {
  const i = items.find((x) => x.id === id);
  if (!i) throw new Error(`no eval item ${id}`);
  return i;
};

describe("eval set", () => {
  it("covers every archive case's first message, the 04 turning point and the tone flips", () => {
    for (const c of archive) expect(items.map((i) => i.id)).toContain(c.id);
    expect(byId("case-04@6")).toBeDefined();
    expect(items.filter((i) => "text" in i).length).toBeGreaterThanOrEqual(6);
  });

  it("accepts the archive's own urgency for every archive item", () => {
    for (const i of items) {
      if (!("archive" in i)) continue;
      const c = archive.find((x) => x.id === i.archive);
      expect(i.expect.urgency, i.id).toContain(c?.classification.urgency);
    }
  });

  it("replays a thread as its non-manager messages, in order", () => {
    expect(itemMessages(byId("case-04@6"), archive).map((m) => m.eventId)).toEqual([
      "case-04#0#r0", "case-04#2#r0", "case-04#4#r0", "case-04#6#r0",
    ]);
    expect(itemMessages(byId("case-05"), archive, 2)).toHaveLength(1);
    expect(itemMessages(byId("calm-gas"), archive)[0]?.text).toMatch(/rotten eggs/);
  });

  it("marks items critical when their lowest accepted urgency is high or emergency", () => {
    expect(isCritical(byId("case-05"))).toBe(true);
    expect(isCritical(byId("case-06"))).toBe(true);
    expect(isCritical(byId("case-04"))).toBe(false); // medium or high
    expect(isCritical(byId("panicky-drip"))).toBe(false);
  });
});

const run = (item: string, o: Partial<RunResult>): RunResult => ({
  item, run: 0, urgency: "medium", nextStep: "contractor", modelUrgency: "medium", modelNextStep: "contractor",
  floorOverrode: false, invalid: false, summary: "Tenant reports a leak.", why: "w", status: "open", speak: ["tenant"], ...o,
});
const gas: EvalItem = { id: "g", text: "gas", expect: { urgency: ["emergency"], next_step: ["external"] }, why: "" };

describe("scoring", () => {
  it("a critical item rated below its floor is a hard fail", () => {
    expect(score(gas, run("g", { urgency: "high", nextStep: "external" }))).toMatchObject({ urgencyOk: false, underRated: true });
    expect(score(gas, run("g", { urgency: "emergency", nextStep: "external" }))).toMatchObject({ urgencyOk: true, nextStepOk: true, underRated: false });
  });

  it("records when only the safety floor saved the item", () => {
    const s = score(gas, run("g", { urgency: "emergency", nextStep: "external", modelUrgency: "medium", floorOverrode: true }));
    expect(s).toMatchObject({ underRated: false, modelUnderRated: true });
  });

  it("flags a summary that claims we already did something", () => {
    expect(summaryClaims("Tenant reports gas smell. We have advised her to leave.")).toBe(true);
    expect(summaryClaims("The tenant has been asked to send photos.")).toBe(true);
    expect(summaryClaims("Tenant asked if someone can come today; she was advised by a friend to wait.")).toBe(false);
    expect(summaryClaims("Gas smell in the hall; tenant has left the building.")).toBe(false);
  });

  it("totals across items and runs", () => {
    const r = report([gas], [
      run("g", { urgency: "emergency", nextStep: "external" }),
      run("g", { urgency: "high", nextStep: "contractor", run: 1 }),
    ]);
    expect(r.totals).toMatchObject({ runs: 2, urgencyOk: 1, nextStepOk: 1, bothOk: 1, underRated: 1 });
    expect(r.items[0]?.urgencies).toEqual({ emergency: 1, high: 1 });
  });

  it("status and speak are scored only for items that expect them", () => {
    expect(score(gas, run("g", { urgency: "emergency", nextStep: "external" }))).toMatchObject({ statusOk: null, speakOk: null });
    const fixed: EvalItem = { ...gas, expect: { ...gas.expect, status: ["closed", "resolved"], speak: [] } };
    expect(score(fixed, run("g", { status: "closed", speak: [] }))).toMatchObject({ statusOk: true, speakOk: true });
    expect(score(fixed, run("g", { status: "open", speak: ["tenant"] }))).toMatchObject({ statusOk: false, speakOk: false });
    const r = report([gas, fixed], [run("g", { status: "closed", speak: [] })]);
    expect(r.totals).toMatchObject({ statusRuns: 1, statusOk: 1, speakRuns: 1, speakOk: 1 });
    expect(r.items.map((x) => x.speakOk)).toEqual([null, 1]);
    expect(r.items[1]?.speaks).toEqual({ none: 1 });
  });

  it("speak is an exact set: an extra recipient fails", () => {
    const landlordOnly: EvalItem = { ...gas, expect: { ...gas.expect, speak: ["landlord"] } };
    expect(score(landlordOnly, run("g", { speak: ["landlord"] })).speakOk).toBe(true);
    expect(score(landlordOnly, run("g", { speak: ["landlord", "tenant"] })).speakOk).toBe(false);
  });
});

describe("scenario set (15 Nov)", () => {
  const scenarios = loadEvalSet("scenarios");
  it("loads, and every thread starts with the tenant who reports it", () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(10);
    for (const i of scenarios) if ("thread" in i) expect(i.thread[0]?.role, i.id).toBe("tenant");
  });
  it("replays a thread turn by turn: each role has its own actor, a minute apart", () => {
    const item = scenarios.find((i) => i.id === "landlord-asks");
    if (!item) throw new Error("no landlord-asks");
    const ms = itemMessages(item, archive, 1);
    expect(ms.map((m) => [m.eventId, m.actor.id, m.actor.role])).toEqual([
      ["landlord-asks#0#r1", "tenant:eval", "tenant"],
      ["landlord-asks#1#r1", "landlord:eval", "landlord"],
    ]);
    expect(Date.parse(ms[1]?.occurredAt ?? "") - Date.parse(ms[0]?.occurredAt ?? "")).toBe(60_000);
  });
});

describe("reply claims (rung 5)", () => {
  it("flags a message that says something happened when it has not", () => {
    expect(replyClaims("We've booked Thames & Vale for Thursday.")).toBe(true);
    expect(replyClaims("We have called the gas emergency line.")).toBe(true);
    expect(replyClaims("An engineer is on the way.")).toBe(true);
    expect(replyClaims("A plumber has been booked.")).toBe(true);
    // fake-world run, 15 Nov: nobody was on the way
    expect(replyClaims("Keep others away from the hall until the engineer arrives.")).toBe(true);
    expect(replyClaims("Stay somewhere safe until they arrive.")).toBe(true);
    // experiment 003, locked-out run 0: nobody is checking
    expect(replyClaims("We're checking whether your landlord holds a spare.")).toBe(true);
    expect(replyClaims("We are currently contacting the landlord about it.")).toBe(true);
  });
  it("lets through what we will do, and what the tenant did", () => {
    expect(replyClaims("We will arrange a plumber and confirm a time with you.")).toBe(false);
    expect(replyClaims("Thanks for turning the stopcock off - you have done the right thing.")).toBe(false);
    expect(replyClaims("We have logged this on your home's record.")).toBe(false);
    expect(replyClaims("We will confirm a time with you. Until then, keep the door open.")).toBe(false);
    expect(replyClaims("We will check whether your landlord holds a spare and come back to you.")).toBe(false);
    expect(replyClaims("We're treating this as urgent.")).toBe(false);
  });
});
