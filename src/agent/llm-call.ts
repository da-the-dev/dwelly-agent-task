// One structured LLM call: a prompt file, a JSON input, an answer checked with a zod schema.
// Shared by the classifier (rung 2) and the reply writer (rung 5).
//
// The output is a trust boundary: parsed as unknown, then checked with zod. On a bad answer
// we retry once, telling the model what was wrong. If it is still bad the caller gets null
// and falls back. Every attempt writes one `llm.call` trace line with the full input and
// output, so traces (not a table) are the record of what the model saw.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { describeError } from "../errors.js";
import { chat, type ChatMessage, type LlmConfig } from "../llm.js";
import type { Tracer } from "../trace.js";

export interface Prompt {
  name: string;
  /** name@sha256-prefix of the file content: any edit is a new version in the traces. */
  version: string;
  text: string;
}

/** Prompts live in <repo>/prompts/, two levels up from both src/agent/ and dist/agent/. */
export function loadPrompt(name: string): Prompt {
  const text = readFileSync(new URL(`../../prompts/${name}.md`, import.meta.url), "utf8");
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 12);
  return { name, version: `${name}@${hash}`, text };
}

export interface StructuredDeps {
  llm: LlmConfig;
  prompt: Prompt;
  tracer: Tracer;
  fetchImpl?: typeof fetch;
}

export interface StructuredResult<T> {
  /** null: still invalid after the retry. */
  value: T | null;
  attempts: number;
  error: string | null;
}

/** Strict JSON Schema for response_format, generated from the zod schema. */
export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...json } = z.toJSONSchema(schema, { io: "output" }) as Record<string, unknown>;
  return json;
}

const MAX_ATTEMPTS = 2;

export async function structuredCall<T>(
  deps: StructuredDeps,
  call: { schemaName: string; schema: z.ZodType<T>; input: unknown; eventId: string },
): Promise<StructuredResult<T>> {
  const messages: ChatMessage[] = [
    { role: "system", content: deps.prompt.text },
    { role: "user", content: JSON.stringify(call.input, null, 2) },
  ];
  const jsonSchema = { name: call.schemaName, schema: jsonSchemaOf(call.schema) };
  let error: string | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Transport errors (network, 5xx, 401) are thrown: the caller decides. Only a bad
    // ANSWER is retried here.
    const res = await chat(deps.llm, { messages, jsonSchema }, deps.fetchImpl);
    const parsed = parse(res.text, call.schema);
    error = parsed.ok ? null : parsed.error;
    deps.tracer.trace("llm.call", {
      event_id: call.eventId,
      prompt: deps.prompt.version,
      model_requested: deps.llm.model,
      model: res.model,
      provider: res.provider,
      attempt,
      input: messages.slice(1), // the system prompt is identified by its version
      raw: res.text,
      parsed: parsed.ok ? parsed.value : null,
      error,
      finish_reason: res.finishReason,
      tokens_in: res.usage.promptTokens,
      tokens_out: res.usage.completionTokens,
      cost_usd: res.usage.costUsd,
      latency_ms: res.latencyMs,
    });
    if (parsed.ok) return { value: parsed.value, attempts: attempt, error: null };

    messages.push(
      { role: "assistant", content: res.text },
      { role: "user", content: `That answer is invalid: ${error}\nAnswer again with one JSON object that matches the schema.` },
    );
  }
  return { value: null, attempts: MAX_ATTEMPTS, error };
}

function parse<T>(text: string, schema: z.ZodType<T>): { ok: true; value: T } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `not JSON: ${describeError(err)}` };
  }
  const r = schema.safeParse(json);
  return r.success ? { ok: true, value: r.data } : { ok: false, error: z.prettifyError(r.error) };
}
