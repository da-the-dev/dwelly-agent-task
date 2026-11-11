export const DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash-1017";
/**
 * OpenRouter endpoint(s) for DEFAULT_MODEL, no fallback. DeepInfra fp8, standard tier: a
 * known quantization, strict structured outputs, among the cheapest ($0.098 in / $0.294
 * out per 1M tokens on 11 Nov 2026). Unpinned, calls were spread over 5 providers with
 * different quantizations. Override with LLM_PROVIDERS (comma-separated; "any" = unpinned).
 */
export const DEFAULT_PROVIDERS = ["deepinfra/fp8"];
/** The token the local fake world accepts (.env.fake). Never valid on a real server. */
export const FAKE_TOKEN = "fake-token";
const LOCAL_HTTP = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/;

export interface Config {
  baseUrl: string;
  /** null until the live session hands one out; API calls must check it. */
  token: string | null;
  /** SQLite file for agent state (cursor, inbox). */
  stateDb: string;
  pollIntervalMs: number;
  /**
   * Open a Dwelly case (rung 3) for an out-of-scope report too. Opening one tells the
   * landlord; the archive records these cases anyway (case-11), so the default is true.
   */
  openCaseOutOfScope: boolean;
  llm: {
    /** OpenRouter key; null means LLM calls are unavailable. */
    apiKey: string | null;
    /** OpenRouter model id. Pin a dated snapshot so eval runs are comparable. */
    model: string;
    /** OpenRouter provider endpoints, in order, no fallback. Empty: any provider. */
    providers: string[];
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const baseUrl = env["DWELLY_BASE_URL"]?.trim();
  if (!baseUrl) {
    throw new Error("DWELLY_BASE_URL is not set. Copy .env.example to .env.");
  }
  // https everywhere, except plain http to this machine (the local fake world).
  if (!/^https:\/\//.test(baseUrl) && !LOCAL_HTTP.test(baseUrl)) {
    throw new Error(`DWELLY_BASE_URL must be https, or http://127.0.0.1 / localhost (got ${baseUrl}).`);
  }
  const token = env["DWELLY_TOKEN"]?.trim() || null;
  // Found in a live run: a DWELLY_BASE_URL inherited from the shell beat .env.fake
  // (--env-file never overrides a variable that is already set), so the fake token went
  // to the real server and every poll was a 401. Fail at startup instead.
  if (token === FAKE_TOKEN && !LOCAL_HTTP.test(baseUrl)) {
    throw new Error(
      `DWELLY_TOKEN is the fake world's token but DWELLY_BASE_URL is ${baseUrl}. ` +
        "Is DWELLY_BASE_URL set in your shell? Check: env | grep DWELLY_",
    );
  }
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    token,
    stateDb: env["STATE_DB"]?.trim() || "state/agent.db",
    pollIntervalMs: Number(env["POLL_INTERVAL_MS"] ?? 2000),
    openCaseOutOfScope: !/^(false|0|no)$/i.test(env["OPEN_CASE_OUT_OF_SCOPE"]?.trim() ?? ""),
    llm: {
      apiKey: env["OPENROUTER_API_KEY"]?.trim() || null,
      model: env["LLM_MODEL"]?.trim() || DEFAULT_MODEL,
      providers: parseProviders(env["LLM_PROVIDERS"]),
    },
  };
}

function parseProviders(raw: string | undefined): string[] {
  const v = raw?.trim();
  if (!v) return [...DEFAULT_PROVIDERS];
  if (v === "any") return [];
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

export function maskToken(token: string | null): string {
  if (!token) return "(missing)";
  return token.length <= 8 ? "****" : `${token.slice(0, 4)}…${token.slice(-4)}`;
}
