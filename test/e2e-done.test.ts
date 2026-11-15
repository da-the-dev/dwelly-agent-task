// Found in the first e2e run (15 Nov): quiet output alone stopped the agent mid LLM call.
import { describe, expect, it } from "vitest";
import { notOverBecause } from "../src/e2e/done.js";

const idle = { msSinceOutput: 9_000, quietMs: 8_000, inbox: { pending: 0, done: 5, failed: 0 }, actions: [{ status: "sent" as const }] };

describe("e2e: when the run is over", () => {
  it("over: quiet, every event handled, every call sent", () => {
    expect(notOverBecause(idle)).toBeNull();
  });
  it("not over while an event is still being handled, however long the LLM call is quiet", () => {
    expect(notOverBecause({ ...idle, msSinceOutput: 18_000, inbox: { ...idle.inbox, pending: 1 } })).toBe("1 events not handled yet");
  });
  it("not over while a call waits to be sent", () => {
    expect(notOverBecause({ ...idle, actions: [{ status: "sending" }, { status: "pending" }] })).toBe("2 calls not sent yet");
  });
  it("not over until the quiet time has passed", () => {
    expect(notOverBecause({ ...idle, msSinceOutput: 1_000 })).toBe("the agent printed something recently");
  });
});
