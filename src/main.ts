// v0.1 placeholder: proves build -> env -> run works. The event loop arrives with rung 1.
import { loadConfig, maskToken } from "./config.js";

const config = loadConfig();
console.log(
  JSON.stringify({
    msg: "dwelly-agent v0.1",
    baseUrl: config.baseUrl,
    token: maskToken(config.token),
    llm: { model: config.llm.model, apiKey: maskToken(config.llm.apiKey) },
  }),
);
