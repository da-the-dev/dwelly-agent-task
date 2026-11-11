import { describe, expect, it } from "vitest";
import { chat, LlmError } from "../src/llm.js";

const cfg = { apiKey: "k", model: "deepseek/x" };

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const ok = {
  id: "gen-1",
  model: "deepseek/x-served",
  provider: "DeepSeek",
  choices: [{ message: { content: '{"a":1}' }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.00001 },
};

describe("chat", () => {
  it("sends a strict json_schema and only routes to providers that support it", async () => {
    const f = fakeFetch(200, ok);
    await chat(cfg, { messages: [{ role: "user", content: "hi" }], jsonSchema: { name: "t", schema: { type: "object" } } }, f.impl);
    const sent = JSON.parse(String(f.calls[0]?.init.body));
    expect(f.calls[0]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(sent.response_format).toEqual({ type: "json_schema", json_schema: { name: "t", strict: true, schema: { type: "object" } } });
    expect(sent.provider).toEqual({ require_parameters: true });
    expect(sent.temperature).toBe(0);
  });

  it("returns text, served model, usage and cost for the trace", async () => {
    const r = await chat(cfg, { messages: [{ role: "user", content: "hi" }] }, fakeFetch(200, ok).impl);
    expect(r).toMatchObject({ text: '{"a":1}', model: "deepseek/x-served", provider: "DeepSeek", finishReason: "stop" });
    expect(r.usage).toEqual({ promptTokens: 10, completionTokens: 5, costUsd: 0.00001 });
  });

  it("throws LlmError with the status on a non-2xx", async () => {
    const p = chat(cfg, { messages: [] }, fakeFetch(401, { error: { message: "No auth" } }).impl);
    await expect(p).rejects.toThrow(LlmError);
    await expect(p).rejects.toMatchObject({ status: 401, message: "OpenRouter 401: No auth" });
  });

  it("throws on a 200 that carries an error object", async () => {
    await expect(chat(cfg, { messages: [] }, fakeFetch(200, { error: { message: "upstream" } }).impl)).rejects.toThrow(/upstream/);
  });
});
