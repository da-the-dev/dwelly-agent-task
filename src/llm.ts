// Minimal OpenRouter client over plain fetch. One endpoint (OpenAI-style chat completions),
// so an SDK would add a dependency without removing any code we need to understand.
// Returns the raw text plus what the trace needs: model actually used, tokens, cost, latency.

export interface LlmConfig {
  apiKey: string;
  model: string;
  /**
   * OpenRouter provider endpoints to use, in order, with no fallback to others
   * (e.g. ["deepinfra/fp8"]). Different providers serve different quantizations of the
   * same model, so an unpinned run is not comparable with the last one. Empty: any provider.
   */
  providers?: string[];
  baseUrl?: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface JsonSchemaFormat {
  name: string;
  schema: Record<string, unknown>;
}

export interface ChatRequest {
  messages: ChatMessage[];
  /** When set, the model must answer with JSON matching this schema (strict). */
  jsonSchema?: JsonSchemaFormat;
  temperature?: number;
  maxTokens?: number;
}

export interface ChatResult {
  id: string;
  /** The model OpenRouter actually served; can differ from the requested one. */
  model: string;
  provider: string | null;
  text: string;
  finishReason: string | null;
  usage: { promptTokens: number; completionTokens: number; costUsd: number | null };
  latencyMs: number;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

export async function chat(
  cfg: LlmConfig,
  req: ChatRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<ChatResult> {
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: req.messages,
    temperature: req.temperature ?? 0,
    usage: { include: true },
  };
  if (req.maxTokens !== undefined) body["max_tokens"] = req.maxTokens;
  const provider: Record<string, unknown> = {};
  if (req.jsonSchema) {
    body["response_format"] = {
      type: "json_schema",
      json_schema: { name: req.jsonSchema.name, strict: true, schema: req.jsonSchema.schema },
    };
    // Only route to providers that honour response_format; otherwise the schema is silently ignored.
    provider["require_parameters"] = true;
  }
  if (cfg.providers?.length) {
    provider["order"] = cfg.providers;
    provider["allow_fallbacks"] = false;
  }
  if (Object.keys(provider).length) body["provider"] = provider;

  const started = performance.now();
  const res = await fetchImpl(`${cfg.baseUrl ?? DEFAULT_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const latencyMs = Math.round(performance.now() - started);
  const json: unknown = await res.json().catch(() => null);

  if (!res.ok) {
    throw new LlmError(`OpenRouter ${res.status}: ${errorMessage(json)}`, res.status, json);
  }
  return parseCompletion(json, latencyMs);
}

function parseCompletion(json: unknown, latencyMs: number): ChatResult {
  const r = json as {
    id?: string;
    model?: string;
    provider?: string;
    error?: unknown;
    choices?: { message?: { content?: string | null }; finish_reason?: string | null }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  } | null;
  // OpenRouter can answer 200 with an error object (e.g. the upstream provider failed mid-stream).
  if (!r || r.error) throw new LlmError(`OpenRouter error: ${errorMessage(r)}`, null, r);
  const choice = r.choices?.[0];
  const text = choice?.message?.content;
  if (typeof text !== "string") throw new LlmError("OpenRouter: no message content", null, r);
  return {
    id: r.id ?? "",
    model: r.model ?? "",
    provider: r.provider ?? null,
    text,
    finishReason: choice?.finish_reason ?? null,
    usage: {
      promptTokens: r.usage?.prompt_tokens ?? 0,
      completionTokens: r.usage?.completion_tokens ?? 0,
      costUsd: r.usage?.cost ?? null,
    },
    latencyMs,
  };
}

function errorMessage(json: unknown): string {
  const e = (json as { error?: { message?: string } | string } | null)?.error;
  if (typeof e === "string") return e;
  return e?.message ?? JSON.stringify(json)?.slice(0, 300) ?? "no body";
}
