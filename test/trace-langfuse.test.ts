// The Langfuse trace sink: the line -> observation mapping, and the real SDK path with an
// in-memory exporter (no network).
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import { planObservation, promptRef, startLangfuseTracing } from "../src/trace-langfuse.js";

const llmCall = {
  ts: "2026-11-15T12:00:02.000Z", run: "r1", kind: "llm.call", event_id: "evt_5",
  prompt: "classify.v2@ac3f84a93520", model: "deepseek/x", provider: "DeepInfra", attempt: 1,
  input: [{ role: "user", content: "{...}" }], raw: "{}", parsed: { urgency: "high" }, error: null,
  tokens_in: 1000, tokens_out: 300, cost_usd: 0.0002, latency_ms: 1500,
};
const caseVersion = { ts: "2026-11-15T12:00:02.100Z", run: "r1", kind: "case.version", event_id: "evt_5", case_id: "case_9", title: "Boiler dead", urgency: "high" };

describe("planObservation", () => {
  it("an llm.call is a generation with its timing, usage, cost and prompt version", () => {
    const p = planObservation(llmCall, { sessions: "case" });
    expect(p).toMatchObject({ traceKey: "evt_5", asType: "generation", name: "classify", level: "DEFAULT" });
    expect(p.startTime.toISOString()).toBe("2026-11-15T12:00:00.500Z");
    expect(p.endTime.toISOString()).toBe("2026-11-15T12:00:02.000Z");
    expect(p.attributes).toMatchObject({
      model: "deepseek/x", output: { urgency: "high" },
      usageDetails: { input: 1000, output: 300 }, costDetails: { total: 0.0002 },
      prompt: { name: "classify", version: 2, isFallback: false },
    });
  });

  it("a generation is named after its prompt (the writer is 'reply', not 'classify'); no prompt -> llm.call", () => {
    expect(planObservation({ ...llmCall, prompt: "reply.v3@abc" }, { sessions: "case" }).name).toBe("reply");
    expect(planObservation({ ...llmCall, prompt: undefined }, { sessions: "case" }).name).toBe("llm.call");
  });

  it("case.version names the trace and puts it in the case's session", () => {
    const p = planObservation(caseVersion, { sessions: "case" });
    expect(p).toMatchObject({ traceKey: "evt_5", traceName: "evt_5 · Boiler dead", sessionId: "case_9", asType: "event" });
  });

  it("eval and try runs group by run; lines without an event go to the run's trace", () => {
    expect(planObservation(caseVersion, { sessions: "run" }).sessionId).toBe("r1");
    expect(planObservation({ ts: llmCall.ts, run: "r1", kind: "poll" }, { sessions: "case" }).traceKey).toBe("run:r1");
  });

  it("levels: failures are errors, deferrals and reviews are warnings", () => {
    const lvl = (kind: string, extra = {}) => planObservation({ ts: llmCall.ts, run: "r1", kind, ...extra }, { sessions: "case" }).level;
    expect([lvl("action.unknown"), lvl("event.failed"), lvl("action.deferred"), lvl("case.version", { needs_review: true }), lvl("action.sent")])
      .toEqual(["ERROR", "ERROR", "WARNING", "WARNING", "DEFAULT"]);
  });

  it("reads the prompt version only from our own naming", () => {
    expect(promptRef("classify.v12@abc")).toEqual({ name: "classify", version: 12, isFallback: false });
    expect(promptRef("something else")).toBeNull();
  });
});

describe("startLangfuseTracing (SDK, in-memory exporter)", () => {
  it("one trace per event: a root span, a generation and an event under it", async () => {
    const exporter = new InMemorySpanExporter();
    exporter.shutdown = async () => {}; // the real one forgets the spans, and shutdown() calls it
    const lf = startLangfuseTracing(
      { baseUrl: "https://lf.test", publicKey: "pk", secretKey: "sk", traces: true },
      { sessions: "case", environment: "test", exporter },
    );
    lf.sink(JSON.stringify(llmCall));
    lf.sink(JSON.stringify(caseVersion));
    lf.sink("not json"); // never throws into the agent
    await lf.shutdown();

    const spans = exporter.getFinishedSpans();
    expect(spans.map((s) => s.name).sort()).toEqual(["case.version", "classify", "evt_5"]);
    expect(new Set(spans.map((s) => s.spanContext().traceId)).size).toBe(1);
    const root = spans.find((s) => s.name === "evt_5");
    for (const s of spans.filter((x) => x !== root)) expect(s.parentSpanContext?.spanId).toBe(root?.spanContext().spanId);
    const version = spans.find((s) => s.name === "case.version");
    expect(version?.attributes["session.id"]).toBe("case_9");
    expect(version?.attributes["langfuse.trace.name"]).toBe("evt_5 · Boiler dead");
    // before the case was named, the trace carried its key; every span carries a name
    expect(spans.find((s) => s.name === "classify")?.attributes["langfuse.trace.name"]).toBe("evt_5");
  });
});
