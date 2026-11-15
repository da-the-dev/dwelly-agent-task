import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL, DEFAULT_PROVIDERS, FAKE_TOKEN, loadConfig, maskToken } from "../src/config.js";

describe("loadConfig", () => {
  it("rejects a missing base URL", () => {
    expect(() => loadConfig({})).toThrow(/DWELLY_BASE_URL/);
  });
  it("rejects plain http (the spec's servers entry says http; the world is https)", () => {
    expect(() => loadConfig({ DWELLY_BASE_URL: "http://x" })).toThrow(/https/);
  });
  it("allows plain http only to this machine (the fake world)", () => {
    expect(loadConfig({ DWELLY_BASE_URL: "http://127.0.0.1:8787" }).baseUrl).toBe("http://127.0.0.1:8787");
    expect(loadConfig({ DWELLY_BASE_URL: "http://localhost:8787/" }).baseUrl).toBe("http://localhost:8787");
    expect(() => loadConfig({ DWELLY_BASE_URL: "http://localhost.evil.com" })).toThrow(/https/);
  });
  it("treats an empty token as missing and trims the trailing slash", () => {
    expect(loadConfig({ DWELLY_BASE_URL: "https://x/", DWELLY_TOKEN: " " })).toEqual({
      baseUrl: "https://x",
      token: null,
      stateDb: "state/agent.db",
      pollIntervalMs: 2000,
      openCaseOutOfScope: true,
      llm: { apiKey: null, model: DEFAULT_MODEL, providers: DEFAULT_PROVIDERS },
      langfuse: null,
    });
  });
  it("Langfuse is on only with both keys; EU cloud by default; LANGFUSE_TRACES=off keeps prompts only", () => {
    const lf = (e: Record<string, string>) => loadConfig({ DWELLY_BASE_URL: "https://x", ...e }).langfuse;
    expect(lf({ LANGFUSE_PUBLIC_KEY: "pk" })).toBeNull();
    expect(lf({ LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk" })).toEqual({
      baseUrl: "https://cloud.langfuse.com", publicKey: "pk", secretKey: "sk", traces: true,
    });
    expect(lf({ LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk", LANGFUSE_TRACES: "off" })?.traces).toBe(false);
  });
  it("OPEN_CASE_OUT_OF_SCOPE=false turns opening out-of-scope cases off", () => {
    const flag = (v: string) => loadConfig({ DWELLY_BASE_URL: "https://x", OPEN_CASE_OUT_OF_SCOPE: v }).openCaseOutOfScope;
    expect([flag("false"), flag("0"), flag("NO"), flag("true"), flag("")]).toEqual([false, false, false, true, true]);
  });
  it("pins the LLM provider by default; LLM_PROVIDERS overrides it, 'any' unpins", () => {
    const providers = (v?: string) => loadConfig({ DWELLY_BASE_URL: "https://x", LLM_PROVIDERS: v }).llm.providers;
    expect(providers()).toEqual(["deepinfra/fp8"]);
    expect(providers("a/fp8, b")).toEqual(["a/fp8", "b"]);
    expect(providers("any")).toEqual([]);
  });
  it("refuses the fake world's token for any address but this machine (found in a live run)", () => {
    expect(() => loadConfig({ DWELLY_BASE_URL: "https://167.172.96.156.sslip.io", DWELLY_TOKEN: FAKE_TOKEN })).toThrow(
      /fake world's token.*env \| grep DWELLY_/,
    );
    expect(loadConfig({ DWELLY_BASE_URL: "http://127.0.0.1:8787", DWELLY_TOKEN: FAKE_TOKEN }).token).toBe(FAKE_TOKEN);
  });
  it("lets LLM_MODEL override the default model", () => {
    expect(loadConfig({ DWELLY_BASE_URL: "https://x", LLM_MODEL: "a/b" }).llm.model).toBe("a/b");
  });
  it("never prints a full token", () => {
    expect(maskToken("abcd1234efgh")).toBe("abcd…efgh");
  });
});
