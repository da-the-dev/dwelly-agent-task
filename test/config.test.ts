import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL, loadConfig, maskToken } from "../src/config.js";

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
      llm: { apiKey: null, model: DEFAULT_MODEL },
    });
  });
  it("lets LLM_MODEL override the default model", () => {
    expect(loadConfig({ DWELLY_BASE_URL: "https://x", LLM_MODEL: "a/b" }).llm.model).toBe("a/b");
  });
  it("never prints a full token", () => {
    expect(maskToken("abcd1234efgh")).toBe("abcd…efgh");
  });
});
