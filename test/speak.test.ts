// Rung 5: when we write, to whom, and the parts code writes (never the model).
import { describe, expect, it } from "vitest";
import type { CaseRecord } from "../src/case.js";
import { finalBody, hasPhoneNumber, looping, withoutPhoneNumbers, safetyLine, speakFor, subjectFor, templateReply, type PastTurn } from "../src/agent/speak.js";

const c: CaseRecord = {
  id: "case_1",
  dwellyCaseId: "d-1",
  propertyId: "prop_02",
  reporter: "tenant_02",
  status: "open",
  waitingOn: "tenant",
  outcome: null,
  urgency: "medium",
  nextStep: "need_info",
  contractorId: null,
  title: "Kitchen tap drips",
  summary: "s",
  openQuestions: ["Is it the hot or the cold side?"],
  needsReview: false,
  version: 1,
  createdAt: "t",
  updatedAt: "t",
};
const v2 = (change: Partial<CaseRecord>): CaseRecord => ({ ...c, version: 2, ...change });
const from = (id: string, role: string, text: string) => ({ actor: { id, role, name: "Priya Shah" }, text });
const tenant = (text: string) => from("tenant_02", "tenant", text);
const reasons = (rs: ReturnType<typeof speakFor>) => rs.map((r) => [r.to, ...r.reasons]);

describe("speakFor", () => {
  it("a new case: one message to the reporter", () => {
    expect(speakFor(null, c, tenant("The tap drips."), "Priya Shah")).toEqual([
      { to: "tenant_02", role: "tenant", name: "Priya Shah", reasons: ["new_case"] },
    ]);
  });

  it("each change worth telling the tenant", () => {
    const say = (change: Partial<CaseRecord>) => reasons(speakFor(c, v2(change), tenant("It is the cold side."), null));
    expect(say({ urgency: "high" })).toEqual([["tenant_02", "urgency_up"]]);
    expect(say({ openQuestions: ["Is the cabinet floor wet?"] })).toEqual([["tenant_02", "new_questions"]]);
    expect(say({ status: "in_progress", waitingOn: "external" })).toEqual([["tenant_02", "status_changed"]]);
    expect(say({ waitingOn: "contractor", nextStep: "contractor" })).toEqual([["tenant_02", "waiting_changed"]]);
    expect(say({ status: "closed", waitingOn: "none", outcome: "logged" })).toEqual([["tenant_02", "closed"]]);
  });

  it("a 'thanks' that changes nothing gets no message (no ping-pong)", () => {
    expect(speakFor(c, v2({ urgency: "low" }), tenant("Thanks, will do."), null)).toEqual([]);
  });

  it("an open emergency: every update from the reporter gets an answer, even with no change and no '?' (gas-update)", () => {
    const em = v2({ urgency: "emergency", status: "in_progress", waitingOn: "external", nextStep: "external", openQuestions: [] });
    const prev = { ...em, version: 1 };
    expect(reasons(speakFor(prev, em, tenant("I'm outside on the pavement now."), null))).toEqual([["tenant_02", "open_emergency"]]);
    // closed, or not the reporter: no
    const closed = { ...em, status: "closed" as const, waitingOn: "none" as const };
    expect(speakFor({ ...closed, version: 1 }, closed, tenant("Thanks."), null)).toEqual([]);
    expect(speakFor(prev, em, from("landlord_02", "landlord", "Noted."), null)).toEqual([]);
    // another reason already applies: no extra reason
    expect(reasons(speakFor(prev, em, tenant("Should I call them again?"), null))).toEqual([["tenant_02", "asked"]]);
  });

  it("a question from the reporter is answered even when nothing else changed", () => {
    expect(reasons(speakFor(c, v2({}), tenant("When will someone come?"), null))).toEqual([["tenant_02", "asked"]]);
  });

  it("a landlord gets a message only when they ask something; a contractor never", () => {
    expect(reasons(speakFor(c, v2({}), from("landlord_02", "landlord", "Approved."), null))).toEqual([]);
    expect(speakFor(c, v2({}), from("landlord_02", "landlord", "Can it be repaired instead?"), null)).toEqual([
      { to: "landlord_02", role: "landlord", name: "Priya Shah", reasons: ["asked"] },
    ]);
    expect(speakFor(c, v2({}), from("c_A", "contractor", "Thursday 12-2?"), null)).toEqual([]);
  });
});

describe("loop guard", () => {
  const turn = (messagedTo: string[], change: Partial<PastTurn> = {}): PastTurn => ({
    status: "open", waitingOn: "tenant", urgency: "medium", messagedTo, ...change,
  });
  it("five messages in a row to one actor with nothing moving is a loop", () => {
    expect(looping(Array(5).fill(turn(["tenant_02"])), "tenant_02")).toBe(true);
  });
  it("a normal exchange is not: fewer turns, a turn without a message, or the case moved", () => {
    expect(looping(Array(4).fill(turn(["tenant_02"])), "tenant_02")).toBe(false);
    expect(looping([...Array(4).fill(turn(["tenant_02"])), turn([])], "tenant_02")).toBe(false);
    expect(looping([...Array(4).fill(turn(["tenant_02"])), turn(["tenant_02"], { waitingOn: "contractor" })], "tenant_02")).toBe(false);
  });
});

describe("the parts code writes", () => {
  it("the safety line: only for an open emergency, with the configured number", () => {
    expect(safetyLine({ urgency: "emergency", status: "in_progress" }, "999")).toBe(
      "If anyone is in danger, get to a safe place and call 999 now.",
    );
    expect(safetyLine({ urgency: "emergency", status: "closed" }, "999")).toBeNull();
    expect(safetyLine({ urgency: "high", status: "open" }, "999")).toBeNull();
  });

  it("the final body puts the safety line first and keeps the spec's limits", () => {
    expect(finalBody("SAFETY", "  text ")).toBe("SAFETY\n\ntext");
    expect(finalBody(null, "x".repeat(20_000))).toHaveLength(10_000);
    expect(subjectFor({ title: "t".repeat(400) })).toHaveLength(300);
  });

  it("the fallback template: greeting, safety advice, what happens next, our questions", () => {
    const text = templateReply({ to: "tenant_02", role: "tenant", name: "Priya Shah", reasons: ["new_case"] }, c, "Turn the stopcock off.");
    expect(text).toBe(
      'Hi Priya,\n\nThank you for telling us about "Kitchen tap drips".\n\nTurn the stopcock off.\n\n' +
        "To work out the right next step, we need a few details from you.\n\nCould you tell us:\n- Is it the hot or the cold side?",
    );
    expect(templateReply({ to: "l", role: "landlord", name: null, reasons: ["asked"] }, c, null)).toMatch(/^Hello,/);
  });

  it("phone numbers are found whatever the separators; short numbers, times and prices are not (review 16 Nov)", () => {
    for (const t of ["0800 111 999", "0800-111-999", "0800.111.999", "(0800) 111999", "+44 20 7946 0000", "+44-20-7946-0000", "08001119999"]) {
      expect(hasPhoneNumber(`Call ${t} now.`), t).toBe(true);
    }
    for (const t of ["Call 999 now.", "We will come at 10:30.", "It costs £150.", "Flat 12, 3rd floor.", "Within 72 hours."]) {
      expect(hasPhoneNumber(t), t).toBe(false);
    }
    expect(withoutPhoneNumbers("Leave now. Call 0800-111-999 from outside.")).toBe("Leave now.");
  });

  it("phone numbers: sentences with one are dropped; the short emergency code is not a phone number", () => {
    expect(withoutPhoneNumbers("Open the windows. Call 0800 111 999 now! Then wait outside.")).toBe("Open the windows. Then wait outside.");
    expect(withoutPhoneNumbers("Call 999 if anyone is hurt.")).toBe("Call 999 if anyone is hurt.");
    expect(withoutPhoneNumbers("Call +44 20 7946 0000.")).toBeNull();
  });
});
