export const DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash-1017";

export interface Config {
  baseUrl: string;
  /** null until the live session hands one out; API calls must check it. */
  token: string | null;
  llm: {
    /** OpenRouter key; null means LLM calls are unavailable. */
    apiKey: string | null;
    /** OpenRouter model id. Pin a dated snapshot so eval runs are comparable. */
    model: string;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const baseUrl = env["DWELLY_BASE_URL"]?.trim();
  if (!baseUrl) {
    throw new Error("DWELLY_BASE_URL is not set. Copy .env.example to .env.");
  }
  if (!/^https:\/\//.test(baseUrl)) {
    throw new Error(`DWELLY_BASE_URL must be https (got ${baseUrl}).`);
  }
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    token: env["DWELLY_TOKEN"]?.trim() || null,
    llm: {
      apiKey: env["OPENROUTER_API_KEY"]?.trim() || null,
      model: env["LLM_MODEL"]?.trim() || DEFAULT_MODEL,
    },
  };
}

export function maskToken(token: string | null): string {
  if (!token) return "(missing)";
  return token.length <= 8 ? "****" : `${token.slice(0, 4)}…${token.slice(-4)}`;
}
