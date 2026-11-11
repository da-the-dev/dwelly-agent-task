// One real OpenRouter call with a structured output, to check the key, the model and
// json_schema support end to end. Uses the first tenant message of archive case-05 (gas smell).
// Run: npm run llm:smoke
import { readFileSync } from "node:fs";
import type { HistoryCasesResponse } from "../api/types.js";
import { loadConfig } from "../config.js";
import { chat } from "../llm.js";

const config = loadConfig();
if (!config.llm.apiKey) throw new Error("OPENROUTER_API_KEY is not set in .env");

const archive = JSON.parse(readFileSync("data/history.json", "utf8")) as HistoryCasesResponse;
const message = archive.cases.find((c) => c.id === "case-05")?.messages[0]?.body ?? "";

const result = await chat(
  { apiKey: config.llm.apiKey, model: config.llm.model },
  {
    messages: [
      { role: "system", content: "You triage maintenance messages for a UK letting agent. Answer in JSON." },
      { role: "user", content: message },
    ],
    jsonSchema: {
      name: "triage",
      schema: {
        type: "object",
        properties: {
          urgency: { type: "string", enum: ["low", "medium", "high", "emergency"] },
          needs_contractor: { type: "boolean" },
          reason: { type: "string" },
        },
        required: ["urgency", "needs_contractor", "reason"],
        additionalProperties: false,
      },
    },
  },
);

console.log(JSON.stringify({ input: message, ...result, parsed: JSON.parse(result.text) }, null, 2));
