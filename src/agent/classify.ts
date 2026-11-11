// Rung 2: one LLM call per message. Input: the case's latest state (Markov) + the new
// message. Output: urgency, next step, safety advice, questions, a rewritten summary.
//
// The output is a trust boundary: parsed as unknown, then checked with zod. On a bad answer
// we retry once, telling the model what was wrong. If it is still bad we return null and the
// caller falls back (needs_review). Every attempt writes one `llm.call` trace line with the
// full input and output, so traces (not a table) are the record of what the model saw.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { NEXT_STEPS, URGENCIES, type CaseRecord } from "../case.js";
import { describeError } from "../errors.js";
import { chat, type ChatMessage, type LlmConfig } from "../llm.js";
import type { Tracer } from "../trace.js";
import type { IncomingMessage } from "./message.js";

export const Classification = z.strictObject({
  urgency: z.enum(URGENCIES),
  why: z.string(),
  next_step: z.enum(NEXT_STEPS),
  safety_advice: z.string().nullable(),
  open_questions: z.array(z.string()),
  title: z.string(),
  summary: z.string(),
});
export type Classification = z.infer<typeof Classification>;

/** Strict JSON Schema for response_format, generated from the same zod schema. */
export function classificationJsonSchema(): Record<string, unknown> {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(Classification, { io: "output" }) as Record<string, unknown>;
  return schema;
}

/** The prompt the agent uses. Older versions stay in prompts/ so runs can be compared. */
export const CLASSIFY_PROMPT = "classify.v2";

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

export interface ClassifyDeps {
  llm: LlmConfig;
  prompt: Prompt;
  tracer: Tracer;
  fetchImpl?: typeof fetch;
}

export interface ClassifyResult {
  /** null: still invalid after the retry. */
  classification: Classification | null;
  attempts: number;
  error: string | null;
}

/** What the model sees: the latest case state (or null) and the new message. Nothing older. */
export function modelInput(current: CaseRecord | null, message: IncomingMessage) {
  return {
    case: current && {
      title: current.title,
      urgency: current.urgency,
      next_step: current.nextStep,
      status: current.status,
      waiting_on: current.waitingOn,
      summary: current.summary,
      open_questions: current.openQuestions,
    },
    message: {
      from: message.actor.role,
      name: message.actor.name,
      subject: message.subject,
      text: message.text,
    },
  };
}

const MAX_ATTEMPTS = 2;

export async function classify(
  deps: ClassifyDeps,
  current: CaseRecord | null,
  message: IncomingMessage,
): Promise<ClassifyResult> {
  const messages: ChatMessage[] = [
    { role: "system", content: deps.prompt.text },
    { role: "user", content: JSON.stringify(modelInput(current, message), null, 2) },
  ];
  let error: string | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Transport errors (network, 5xx, 401) are thrown: the event fails and is traced.
    // Only a bad ANSWER is retried here.
    const res = await chat(
      deps.llm,
      { messages, jsonSchema: { name: "classification", schema: classificationJsonSchema() } },
      deps.fetchImpl,
    );
    const parsed = parse(res.text);
    error = parsed.ok ? null : parsed.error;
    deps.tracer.trace("llm.call", {
      event_id: message.eventId,
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
    if (parsed.ok) return { classification: parsed.value, attempts: attempt, error: null };

    messages.push(
      { role: "assistant", content: res.text },
      { role: "user", content: `That answer is invalid: ${error}\nAnswer again with one JSON object that matches the schema.` },
    );
  }
  return { classification: null, attempts: MAX_ATTEMPTS, error };
}

function parse(text: string): { ok: true; value: Classification } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `not JSON: ${describeError(err)}` };
  }
  const r = Classification.safeParse(json);
  return r.success ? { ok: true, value: r.data } : { ok: false, error: z.prettifyError(r.error) };
}
