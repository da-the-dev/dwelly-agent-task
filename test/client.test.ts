// Rung 3: the case endpoints send the spec's bodies and report who answered.
import { describe, expect, it } from "vitest";
import { ApiError, createApi } from "../src/api/client.js";

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const cfg = { baseUrl: "https://world.test", token: "t" };

describe("case endpoints", () => {
  it("POST /cases sends JSON with the token and returns the case", async () => {
    const f = fakeFetch(201, { id: "d-1", title: "Leak", status: "open" });
    const api = createApi(cfg, f.impl);
    const c = await api.createCase({ title: "Leak", urgency: "medium", property_id: "prop_02" });
    expect(c.id).toBe("d-1");
    expect(f.calls[0]?.url).toBe("https://world.test/cases");
    expect(f.calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(f.calls[0]?.init.body))).toEqual({ title: "Leak", urgency: "medium", property_id: "prop_02" });
    expect(f.calls[0]?.init.headers).toMatchObject({ Authorization: "Bearer t", "Content-Type": "application/json" });
  });

  it("PATCH /cases/{id} sends only the given fields", async () => {
    const f = fakeFetch(200, { id: "d-1" });
    await createApi(cfg, f.impl).patchCase("d-1", { urgency: "high" });
    expect(f.calls[0]?.url).toBe("https://world.test/cases/d-1");
    expect(JSON.parse(String(f.calls[0]?.init.body))).toEqual({ urgency: "high" });
  });

  it("an error status is an ApiError with the status (the server answered)", async () => {
    const f = fakeFetch(429, { error: "rate_limited" });
    const err = await createApi(cfg, f.impl).createCase({ title: "x", urgency: "low" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(429);
  });

  it("a 2xx without an id is rejected at the trust boundary", async () => {
    const f = fakeFetch(201, { ok: true });
    await expect(createApi(cfg, f.impl).createCase({ title: "x", urgency: "low" })).rejects.toThrow(/unexpected body/);
  });
});
