// The classifier against a fake OpenRouter: validation, retry, fallback, trace lines.
import { describe, expect, it } from "vitest";
import { CLASSIFY_PROMPT, Classification, classify, loadPrompt, modelInput } from "../src/agent/classify.js";
import { jsonSchemaOf } from "../src/agent/llm-call.js";
import type { IncomingMessage } from "../src/agent/message.js";
import { createTracer } from "../src/trace.js";

const message: IncomingMessage = {
  eventId: "evt_5",
  text: "There's a strong smell of gas in the entrance hall.",
  subject: null,
  actor: { id: "tenant_09", role: "tenant", name: "Nadia" },
  propertyId: "prop_09",
  caseRef: null,
  occurredAt: "2026-11-11T17:04:00.000Z",
};

const good = {
  urgency: "emergency",
  why: "Suspected gas leak in a communal area.",
  next_step: "external",
  safety_advice: "Do not use switches; open the door and wait outside.",
  open_questions: [],
  title: "Smell of gas in the entrance hall",
  summary: "Tenant reports a strong gas smell in the entrance hall.",
};

/** A fake fetch that answers each call with the next content in the list. */
function openRouter(...contents: string[]) {
  const bodies: { messages: { role: string; content: string }[]; response_format: unknown }[] = [];
  const impl = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    const content = contents[bodies.length - 1] ?? "";
    return new Response(
      JSON.stringify({ id: "gen", model: "m-served", provider: "P", choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.0001 } }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return { impl, bodies };
}

function setup(...contents: string[]) {
  const fake = openRouter(...contents);
  const lines: Record<string, unknown>[] = [];
  const tracer = createTracer("t", (l) => lines.push(JSON.parse(l)));
  const deps = { llm: { apiKey: "k", model: "m" }, prompt: loadPrompt(CLASSIFY_PROMPT), tracer, fetchImpl: fake.impl };
  return { deps, fake, lines };
}

describe("classify", () => {
  it("accepts a valid answer in one call and traces it with the prompt version", async () => {
    const { deps, fake, lines } = setup(JSON.stringify(good));
    const r = await classify(deps, null, message);
    expect(r).toEqual({ classification: good, attempts: 1, error: null });
    expect(fake.bodies).toHaveLength(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: "llm.call", event_id: "evt_5", attempt: 1, prompt: deps.prompt.version, model: "m-served", error: null });
    expect(deps.prompt.version).toMatch(/^classify\.v\d+@[0-9a-f]{12}$/);
  });

  it("retries once with the validation error, then accepts", async () => {
    const bad = JSON.stringify({ ...good, urgency: "critical" });
    const { deps, fake, lines } = setup(bad, JSON.stringify(good));
    const r = await classify(deps, null, message);
    expect(r.attempts).toBe(2);
    expect(r.classification).toEqual(good);
    const retry = fake.bodies[1]?.messages ?? [];
    expect(retry.at(-2)).toEqual({ role: "assistant", content: bad });
    expect(retry.at(-1)?.content).toMatch(/invalid: .*urgency/s);
    expect(lines.map((l) => l["error"] === null)).toEqual([false, true]);
  });

  it("returns null after two bad answers, so the caller can fall back", async () => {
    const { deps, fake } = setup("not json", '{"urgency":"high"}');
    const r = await classify(deps, null, message);
    expect(r.classification).toBeNull();
    expect(r.attempts).toBe(2);
    expect(r.error).toMatch(/why|next_step/);
    expect(fake.bodies).toHaveLength(2);
  });

  it("sends a strict schema: no extra keys, every key required", async () => {
    const schema = jsonSchemaOf(Classification) as { additionalProperties: unknown; required: string[]; properties: Record<string, unknown> };
    expect(schema.additionalProperties).toBe(false);
    expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
    expect(schema).not.toHaveProperty("$schema");
  });

  it("shows the model only the latest case state and the new message", () => {
    expect(modelInput(null, message)).toEqual({
      case: null,
      message: { from: "tenant", name: "Nadia", subject: null, text: message.text },
    });
  });
});
