// The safety floor on real archive messages, and on traps where tone and hazard disagree.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { HistoryCasesResponse } from "../src/api/types.js";
import { applyFloor, safetyFloor } from "../src/agent/floor.js";
import { stateFor } from "../src/agent/state.js";
import { NEXT_STEPS, type Urgency } from "../src/case.js";

const archive = JSON.parse(readFileSync(new URL("../data/history.json", import.meta.url), "utf8")) as HistoryCasesResponse;
const firstTenantMessage = (id: string) => archive.cases.find((c) => c.id === id)?.messages.find((m) => m.from === "tenant")?.body ?? "";

// What the floor must say on each case's FIRST tenant message. null = no rule fires and the
// model decides alone. Every value is at or below the archive's final urgency.
const expected: [string, Urgency | null, string[]][] = [
  ["case-01", "emergency", ["water near electrics", "water escape"]],
  ["case-02", null, []], // a dripping tap is not a water escape
  ["case-03", null, []],
  ["case-04", "medium", ["water escape"]], // "tiny leak, no rush": the floor ignores the tone
  ["case-05", "emergency", ["gas smell"]],
  ["case-06", "high", ["no heating or hot water in the cold", "no heating or hot water"]],
  ["case-07", null, []],
  ["case-08", "high", ["smoke, sparks or burning smell"]],
  ["case-09", null, []],
  ["case-10", null, []], // "No leaks anywhere": negated
  ["case-11", null, []],
  ["case-12", "high", ["home cannot be locked"]],
  ["case-13", "medium", ["water escape"]], // "worried there's a leak": over-fires, harmlessly (archive: medium)
  ["case-14", null, []],
  ["case-15", "medium", ["water escape"]],
];

describe("safety floor on the archive's first messages", () => {
  it.each(expected)("%s -> %s", (id, urgency, rules) => {
    const f = safetyFloor(firstTenantMessage(id));
    expect(f.urgency).toBe(urgency);
    expect(f.rules).toEqual(rules);
  });

  it("only gas is external", () => {
    expect(expected.filter(([id]) => safetyFloor(firstTenantMessage(id)).external).map(([id]) => id)).toEqual(["case-05"]);
  });

  it("case-04's turning point (the flat below reports a stain) is high", () => {
    const jamal = archive.cases.find((c) => c.id === "case-04")?.messages[6]?.body ?? "";
    expect(safetyFloor(jamal).urgency).toBe("high");
  });
});

describe("safety floor traps", () => {
  it("calm tone, real hazard: still an external emergency", () => {
    const f = safetyFloor("Hi, no rush at all, but I think I can smell gas near the cooker. A faint eggy smell. Whenever suits!");
    expect(f).toEqual({ urgency: "emergency", external: true, rules: ["gas smell"] });
  });

  it("panicky tone, no hazard: no floor, the model decides", () => {
    expect(safetyFloor("HELP!!! The kitchen tap is dripping and I can't take it anymore, please send someone NOW!!!").urgency).toBeNull();
  });

  it("a negated hazard does not fire", () => {
    expect(safetyFloor("There is no smell of gas and nothing is leaking, the hob just won't light.").urgency).toBeNull();
  });

  it("a dead boiler without cold weather is medium, not high", () => {
    expect(safetyFloor("The boiler has died, no hot water this morning.").urgency).toBe("medium");
  });
});

describe("applyFloor", () => {
  it("raises urgency and forces gas to external, and says why", () => {
    const r = applyFloor({ urgency: "medium", nextStep: "contractor", why: "smell near the meter" }, safetyFloor("strong smell of gas"));
    expect(r.decision).toEqual({ urgency: "emergency", nextStep: "external", why: "smell near the meter [safety floor: gas smell]" });
    expect(r.overrides).toEqual(["urgency medium -> emergency", "next_step contractor -> external"]);
  });

  it("never lowers what the model said", () => {
    const r = applyFloor({ urgency: "high", nextStep: "contractor", why: "x" }, safetyFloor("small leak under the sink"));
    expect(r.decision.urgency).toBe("high");
    expect(r.overrides).toEqual([]);
  });
});

describe("state from next_step", () => {
  it("every next_step has a state, and closed ones have an outcome", () => {
    for (const step of NEXT_STEPS) {
      const s = stateFor(step);
      expect(s.status === "closed").toBe(s.outcome !== null);
    }
    expect(stateFor("external")).toEqual({ status: "in_progress", waitingOn: "external", outcome: null });
    expect(stateFor("out_of_scope")).toEqual({ status: "closed", waitingOn: "none", outcome: "out_of_scope" });
  });
});
