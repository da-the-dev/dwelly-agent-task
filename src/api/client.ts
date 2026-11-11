// Typed client for the Dwelly world API. Plain fetch; one method per endpoint as we need them.
import type { EventsResponse } from "./types.js";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: unknown,
  ) {
    super(`${method} ${path} -> ${status}: ${JSON.stringify(body)?.slice(0, 300)}`);
    this.name = "ApiError";
  }
}

export interface Api {
  getEvents(after: number, limit: number): Promise<EventsResponse>;
}

export function createApi(cfg: { baseUrl: string; token: string }, fetchImpl: typeof fetch = fetch): Api {
  async function request(method: string, path: string): Promise<unknown> {
    const res = await fetchImpl(cfg.baseUrl + path, {
      method,
      headers: { Authorization: `Bearer ${cfg.token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, method, path, body);
    return body;
  }

  return {
    async getEvents(after, limit) {
      const body = await request("GET", `/events?after=${after}&limit=${limit}`);
      return checkEventsResponse(body);
    },
  };
}

/**
 * Trust boundary: check the shape we depend on before it reaches the store.
 * Hand-written for now (rung 1 needs only id/cursor/type); zod arrives with rung 2.
 */
function checkEventsResponse(body: unknown): EventsResponse {
  const b = body as Partial<EventsResponse> | null;
  if (!b || !Array.isArray(b.events) || !Number.isInteger(b.next_cursor)) {
    throw new Error(`GET /events: unexpected body ${JSON.stringify(body)?.slice(0, 300)}`);
  }
  for (const e of b.events) {
    if (typeof e?.id !== "string" || !Number.isInteger(e?.cursor) || typeof e?.type !== "string") {
      throw new Error(`GET /events: malformed event ${JSON.stringify(e)?.slice(0, 300)}`);
    }
  }
  return b as EventsResponse;
}
