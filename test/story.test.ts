import { describe, expect, it } from "vitest";
import { buildStory, parseTrace, renderStory } from "../src/story.js";

const at = (s: number) => `2026-11-15T10:00:${String(s).padStart(2, "0")}.000Z`;
const jsonl = (...lines: object[]) => lines.map((l) => JSON.stringify(l)).join("\n");

const version = (s: number, event: string, extra: object = {}) => ({
  ts: at(s), kind: "case.version", event_id: event, case_id: "case_aaaa1111-x", version: 1, applied: true, linked_by: "new",
  from: "tenant_06", role: "tenant", name: "Nadia", subject: null, text: "Gas smell in the hall.", property_id: "prop_06",
  urgency: "emergency", next_step: "external", status: "in_progress", waiting_on: "external", changed: ["urgency"],
  why: "gas", floor: ["gas smell"], role_guard: false, needs_review: false, title: "Gas smell", ...extra,
});

describe("story", () => {
  it("groups a run by case: message in, decision, actions with outcomes, replies", () => {
    const { lines, badLines } = parseTrace(
      jsonl(
        { ts: at(0), kind: "run.start", run: "r1", model: "m", prompt: "classify.v2", reply_prompt: "reply.v2", base_url: "http://x" },
        version(1, "evt_1"),
        { ts: at(2), kind: "action.queued", event_id: "evt_1", case_id: "case_aaaa1111-x", action_id: "a1", action: "msg_send", to: "tenant_06", reasons: ["new_case"], body: { subject: "Re", body: "Call 999 now." } },
        { ts: at(2), kind: "action.queued", event_id: "evt_1", case_id: "case_aaaa1111-x", action_id: "a2", action: "case_open", body: { urgency: "emergency" } },
        { ts: at(3), kind: "action.sent", event_id: "evt_1", case_id: "case_aaaa1111-x", action_id: "a1", action: "msg_send" },
        { ts: at(4), kind: "action.unknown", event_id: "evt_1", case_id: "case_aaaa1111-x", action_id: "a2", action: "case_open", error: "timeout" },
      ),
    );
    const s = buildStory(lines, badLines);
    expect(s.cases).toHaveLength(1);
    const turn = s.cases[0]?.turns[0];
    expect(turn?.message).toMatchObject({ role: "tenant", name: "Nadia", text: "Gas smell in the hall." });
    expect(turn?.actions.map((a) => [a.action, a.outcomes.map((o) => o.kind)])).toEqual([["msg_send", ["sent"]], ["case_open", ["unknown"]]]);

    const out = renderStory(s);
    expect(out).toContain("RUN r1");
    expect(out).toContain('CASE aaaa1111  "Gas smell"');
    expect(out).toContain("safety floor: gas smell");
    expect(out).toContain("→ message to tenant_06 [new_case]: sent ✓");
    expect(out).toContain("→ POST /cases (emergency): UNKNOWN ✗ (timeout)");
    expect(out).not.toContain("no reply");
  });

  it("says 'no reply' when a handled message queued no message", () => {
    const s = buildStory(parseTrace(jsonl(version(1, "evt_1"), version(5, "evt_2", { version: 2, text: "Thanks." }))).lines);
    expect(s.cases[0]?.turns).toHaveLength(2);
    expect(renderStory(s).match(/→ no reply/g)).toHaveLength(2);
  });

  it("an old trace without the text on case.version takes it from the classify call", () => {
    const content = JSON.stringify({ case: null, message: { from: "tenant", name: "Leo", subject: null, text: "The fan died." } });
    const { lines } = parseTrace(
      jsonl(
        { ts: at(1), kind: "llm.call", event_id: "evt_8", prompt: "classify.v2@x", input: [{ role: "user", content }] },
        { ts: at(1), kind: "llm.call", event_id: "evt_8", prompt: "reply.v1@y", input: [{ role: "user", content: "not json" }] },
        version(2, "evt_8", { text: undefined, role: undefined, name: undefined }),
      ),
    );
    expect(buildStory(lines).cases[0]?.turns[0]?.message).toMatchObject({ role: "tenant", name: "Leo", text: "The fan died.", from: "tenant_06" });
  });

  it("lines without a case go to 'not on a case'; a bad line is counted, not kept", () => {
    const { lines, badLines } = parseTrace(
      [
        JSON.stringify({ ts: at(1), kind: "event.ignored", event_id: "evt_3", type: "case.created", reason: "later rung" }),
        JSON.stringify({ ts: at(2), kind: "event.ignored", event_id: "evt_4", type: "case.created", reason: "later rung" }),
        JSON.stringify({ ts: at(3), kind: "message.unlinked", event_id: "evt_5", from: "landlord_02", text: "Any news?" }),
        "{not json",
        JSON.stringify({ no: "kind" }),
      ].join("\n"),
    );
    expect(badLines).toBe(2);
    const out = renderStory(buildStory(lines, badLines));
    expect(out).toContain("ignored ×2  case.created: later rung");
    expect(out).toContain("message.unlinked [evt_5] from landlord_02: Any news?");
    expect(out).toContain("2 unreadable trace lines");
  });

  it("--case shows one case; --full keeps the text whole", () => {
    const long = "x".repeat(400);
    const s = buildStory(
      parseTrace(jsonl(version(1, "evt_1", { text: long }), version(2, "evt_9", { case_id: "case_bbbb2222-y", title: "Other" }))).lines,
    );
    const one = renderStory(s, { caseFilter: "bbbb" });
    expect(one).toContain("Other");
    expect(one).not.toContain("aaaa1111");
    expect(renderStory(s)).toContain("x".repeat(300) + "…");
    expect(renderStory(s, { full: true })).toContain(long);
  });
});
