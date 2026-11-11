// Turn an error into one trace-friendly line, including its cause chain.
// Node's fetch throws `TypeError: fetch failed` and hides the reason (ECONNREFUSED,
// ENOTFOUND, a TLS error) in `cause`. Without the chain, a trace cannot tell
// "the world is down" from "wrong address".

export function describeError(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; current != null && depth < 5; depth++) {
    parts.push(describeOne(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join(" | cause: ");
}

function describeOne(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  // TypeError / Error add nothing; TimeoutError, AbortError, ApiError do.
  const name = err.name === "Error" || err.name === "TypeError" ? "" : `${err.name}:`;
  const code = (err as { code?: unknown }).code;
  const codeText = typeof code === "string" && !err.message.includes(code) ? `[${code}]` : "";
  // "localhost" resolves to ::1 and 127.0.0.1; a failed connect then throws an
  // AggregateError with an empty message and the real errors inside.
  const inner = err instanceof AggregateError && err.errors.length
    ? `(${err.errors.map(describeOne).join("; ")})`
    : "";
  return [name, err.message, codeText, inner].filter(Boolean).join(" ");
}
