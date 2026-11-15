// Rung 5: the writer (a second LLM call, faked here) and the parts code adds around it.
import { describe, expect, it } from "vitest";
import type { CaseRecord } from "../src/case.js";
import { loadPrompt } from "../src/agent/llm-call.js";
import { REPLY_PROMPT, writeReply, writerInput, type ReplyInput } from "../src/agent/reply.js";
import { createTracer } from "../src/trace.js";

const gasCase: CaseRecord = {
  id: "case_5",
  dwellyCaseId: null,
  propertyId: "prop_05",
  reporter: "tenant_05",
  status: "in_progress",
  waitingOn: "external",
  outcome: null,
  urgency: "emergency",
  nextStep: "external",
  contractorId: null,
  title: "Smell of gas in the entrance hall",
  summary: "Strong gas smell near the meter cupboards.",
  openQuestions: [],
  needsReview: false,
  version: 1,
  createdAt: "t",
  updatedAt: "t",
};
const input: ReplyInput = {
  recipient: { to: "tenant_05", role: "tenant", name: "Nadia Rahman", reasons: ["new_case"] },
  case: gasCase,
  safetyAdvice: "Do not use light switches; prop the door open; wait outside.",
  incoming: { eventId: "evt_7", actor: { id: "tenant_05", role: "tenant", name: "Nadia Rahman" }, text: "Strong smell of gas in the hall." },
};

/** A fake OpenRouter that answers each call with the next content (or fails). */
function setup(answers: (string | Error)[]) {
  let calls = 0;
  const fetchImpl = (async () => {
    const a = answers[calls++] ?? "";
    if (a instanceof Error) throw a;
    return new Response(
      JSON.stringify({ id: "g", model: "m", provider: "P", choices: [{ message: { content: a }, finish_reason: "stop" }], usage: {} }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  const lines: Record<string, unknown>[] = [];
  const tracer = createTracer("t", (l) => lines.push(JSON.parse(l)));
  const deps = { llm: { apiKey: "k", model: "m" }, prompt: loadPrompt(REPLY_PROMPT), tracer, fetchImpl, emergencyNumber: "999" };
  return { deps, lines, calls: () => calls };
}

describe("writeReply", () => {
  it("the model writes the text; code puts the safety line first and sets the subject", async () => {
    const t = setup([JSON.stringify({ body: "Nadia, please leave the building now." })]);
    const w = await writeReply(t.deps, input);
    expect(w).toEqual({
      subject: "Re: Smell of gas in the entrance hall",
      body: "If anyone is in danger, get to a safe place and call 999 now.\n\nNadia, please leave the building now.",
      source: "model",
      error: null,
    });
    expect(t.lines.find((l) => l["kind"] === "llm.call")).toMatchObject({ event_id: "evt_7", prompt: expect.stringMatching(/^reply\.v1@/) });
  });

  it("an answer still invalid after the retry: the template goes, with the safety line and the advice", async () => {
    const t = setup(["not json", JSON.stringify({ text: "wrong key" })]);
    const w = await writeReply(t.deps, input);
    expect(t.calls()).toBe(2);
    expect(w.source).toBe("template");
    expect(w.body).toMatch(/^If anyone is in danger, .* call 999 now\.\n\nHi Nadia,/);
    expect(w.body).toContain("Do not use light switches");
    expect(t.lines.find((l) => l["kind"] === "reply.fallback")).toMatchObject({ event_id: "evt_7", to: "tenant_05" });
  });

  it("the LLM call itself fails: the template goes; a message is never lost", async () => {
    const t = setup([new TypeError("fetch failed")]);
    const w = await writeReply(t.deps, input);
    expect(w).toMatchObject({ source: "template", error: expect.stringContaining("fetch failed") });
  });

  it("a landlord gets no safety line and no tenant safety advice", async () => {
    const t = setup([JSON.stringify({ body: "Ms Whitlow, the cost is not known yet." })]);
    const landlord = { ...input, recipient: { to: "landlord_05", role: "landlord", name: "Ms Whitlow", reasons: ["asked" as const] } };
    expect((await writeReply(t.deps, landlord)).body).toBe("Ms Whitlow, the cost is not known yet.");
    expect(writerInput(landlord)).toMatchObject({ safety_advice: null, their_message: null });
  });

  it("a phone number in the model's text is an invalid answer: the retry tells the model why", async () => {
    const t = setup([
      JSON.stringify({ body: "Leave and call the National Gas Emergency line on 0800 111 999." }),
      JSON.stringify({ body: "Leave the building now." }),
    ]);
    const w = await writeReply(t.deps, input);
    expect(w).toMatchObject({ source: "model", body: expect.stringMatching(/call 999 now\.\n\nLeave the building now\.$/) });
    expect(t.lines.filter((l) => l["kind"] === "llm.call")[0]?.["error"]).toMatch(/phone number/);
  });

  it("the safety advice loses any sentence with a phone number, for the model and the template", async () => {
    const withLine = { ...input, safetyAdvice: "Leave the building. Call the gas line on 0800 111 999 from outside." };
    expect(writerInput(withLine).safety_advice).toBe("Leave the building.");
    const t = setup(["x", "y"]);
    const w = await writeReply(t.deps, withLine);
    expect(w.source).toBe("template");
    expect(w.body).toContain("Leave the building.");
    expect(w.body).not.toContain("0800");
  });
});
