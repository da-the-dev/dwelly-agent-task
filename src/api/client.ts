// Typed client for the Dwelly world API. Plain fetch; one method per endpoint as we need them.
import type { ActorMessage, ActorMessageAccepted, Case, CaseCreate, CasePatch, EventsResponse } from "./types.js";

/**
 * The server answered with an error status. Anything else thrown by the client (timeout,
 * network error) means we do not know whether a world-changing request took effect.
 */
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
  /** Not idempotent: every call creates a case. Tells the landlord. */
  createCase(body: CaseCreate): Promise<Case>;
  /** Idempotent: sets the given fields. */
  patchCase(id: string, body: CasePatch): Promise<Case>;
  /** Not idempotent: every call delivers a message. The answer comes later as an event. */
  sendMessage(actorId: string, body: ActorMessage): Promise<ActorMessageAccepted>;
}

export function createApi(cfg: { baseUrl: string; token: string }, fetchImpl: typeof fetch = fetch): Api {
  async function request(method: string, path: string, json?: unknown): Promise<unknown> {
    const res = await fetchImpl(cfg.baseUrl + path, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: "application/json",
        ...(json === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
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
    async createCase(body) {
      return checkCase("POST /cases", await request("POST", "/cases", body));
    },
    async patchCase(id, body) {
      return checkCase(`PATCH /cases/${id}`, await request("PATCH", `/cases/${encodeURIComponent(id)}`, body));
    },
    async sendMessage(actorId, body) {
      const path = `/actors/${encodeURIComponent(actorId)}/messages`;
      return checkAccepted(`POST ${path}`, await request("POST", path, body));
    },
  };
}

/**
 * Trust boundary: check the shape we depend on before it reaches the store.
 * Hand-written: rung 1 needs only id/cursor/type.
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

/** Trust boundary: we keep only the id from a case response; the rest we already know. */
function checkCase(what: string, body: unknown): Case {
  const b = body as Partial<Case> | null;
  if (!b || typeof b.id !== "string" || !b.id) {
    throw new Error(`${what}: unexpected body ${JSON.stringify(body)?.slice(0, 300)}`);
  }
  return b as Case;
}

/** Trust boundary: a 202 must say the message was accepted. */
function checkAccepted(what: string, body: unknown): ActorMessageAccepted {
  const b = body as Partial<ActorMessageAccepted> | null;
  if (!b || b.status !== "accepted") {
    throw new Error(`${what}: unexpected body ${JSON.stringify(body)?.slice(0, 300)}`);
  }
  return b as ActorMessageAccepted;
}
