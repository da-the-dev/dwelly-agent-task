// A second trace sink: every JSONL trace line also goes to Langfuse, as a viewer for people.
// The JSONL file stays the source of truth; nothing here may stop or slow the agent. Lines are
// mapped by a pure function (`planObservation`, unit-tested) and sent with the official SDK
// (@langfuse/tracing on a private OpenTelemetry provider, not the global one).
//
// One Langfuse trace per event_id (all the lines one event caused, incl. the sender's later
// calls), one per run for lines without an event_id. llm.call lines become generations
// (model, tokens, cost, timing, linked prompt version); every other line becomes an event.
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  propagateAttributes,
  setLangfuseTracerProvider,
  startObservation,
  type LangfuseGenerationAttributes,
  type LangfuseSpanAttributes,
} from "@langfuse/tracing";
import { context, type SpanContext } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { LangfuseConfig } from "./config.js";
import type { TraceSink } from "./trace.js";

type Line = Record<string, unknown> & { ts: string; run: string; kind: string };
type Level = "DEFAULT" | "WARNING" | "ERROR";

export interface ObservationPlan {
  /** Lines with the same key share one Langfuse trace. */
  traceKey: string;
  traceName: string | null;
  sessionId: string | null;
  name: string;
  asType: "generation" | "event";
  startTime: Date;
  endTime: Date;
  level: Level;
  attributes: LangfuseGenerationAttributes;
}

export interface PlanOptions {
  /** "case": a session per case (the agent). "run": a session per run (eval, try). */
  sessions: "case" | "run";
}

const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** "classify.v2@ac3f84a93520" -> { name: "classify", version: 2 }: Langfuse version N = prompts/<name>.vN.md. */
export function promptRef(version: unknown): { name: string; version: number; isFallback: false } | null {
  const m = /^([\w-]+)\.v(\d+)@/.exec(String(version ?? ""));
  return m?.[1] && m[2] ? { name: m[1], version: Number(m[2]), isFallback: false } : null;
}

function levelOf(kind: string, data: Record<string, unknown>): Level {
  if (/failed|error|unknown/.test(kind)) return "ERROR";
  if (/deferred|duplicate|skipped|recovered|session\.ended/.test(kind) || data["needs_review"] === true) return "WARNING";
  return "DEFAULT";
}

export function planObservation(line: Line, opts: PlanOptions): ObservationPlan {
  const { ts, run, kind, ...data } = line;
  const eventId = str(data["event_id"]);
  const at = new Date(ts);
  const caseId = str(data["case_id"]);
  const base = {
    traceKey: eventId ?? `run:${run}`,
    traceName: kind === "case.version" && str(data["title"]) ? `${eventId} · ${String(data["title"])}` : null,
    sessionId: opts.sessions === "run" ? run : caseId,
  };

  if (kind === "llm.call") {
    const latency = num(data["latency_ms"]) ?? 0;
    const error = str(data["error"]);
    const prompt = promptRef(data["prompt"]);
    return {
      ...base,
      // Named after its prompt, so the writer's call reads "reply" (review, 16 Nov).
      name: prompt?.name ?? "llm.call",
      asType: "generation",
      startTime: new Date(at.getTime() - latency),
      endTime: at,
      level: error ? "WARNING" : "DEFAULT",
      attributes: {
        input: data["input"],
        output: data["parsed"] ?? data["raw"],
        model: str(data["model"]) ?? str(data["model_requested"]) ?? "unknown",
        usageDetails: { input: num(data["tokens_in"]) ?? 0, output: num(data["tokens_out"]) ?? 0 },
        ...(num(data["cost_usd"]) !== null ? { costDetails: { total: num(data["cost_usd"]) ?? 0 } } : {}),
        ...(prompt ? { prompt } : {}),
        metadata: {
          provider: data["provider"],
          attempt: data["attempt"],
          prompt_version: data["prompt"],
          finish_reason: data["finish_reason"],
          ...(error ? { error } : {}),
        },
        ...(error ? { statusMessage: error } : {}),
      },
    };
  }

  const level = levelOf(kind, data);
  return {
    ...base,
    name: kind,
    asType: "event",
    startTime: at,
    endTime: at,
    level,
    attributes: {
      output: data,
      ...(level !== "DEFAULT" && str(data["error"]) ? { statusMessage: String(data["error"]) } : {}),
    },
  };
}

export interface LangfuseTracing {
  sink: TraceSink;
  /** Send what is buffered and stop. Call once at the end of a run. */
  shutdown(): Promise<void>;
}

export interface LangfuseTracingOptions extends PlanOptions {
  /** Langfuse environment, e.g. agent-fake, agent-live, eval, try. */
  environment: string;
  /** Tests pass an in-memory exporter; normally the processor sends to Langfuse. */
  exporter?: SpanExporter;
  /** Where to report a failure of the sink itself (never the tracer: that would loop). */
  warn?: (message: string) => void;
}

export function startLangfuseTracing(cfg: LangfuseConfig, opts: LangfuseTracingOptions): LangfuseTracing {
  const processor = new LangfuseSpanProcessor({
    publicKey: cfg.publicKey,
    secretKey: cfg.secretKey,
    baseUrl: cfg.baseUrl,
    environment: opts.environment,
    ...(opts.exporter ? { exporter: opts.exporter } : {}),
  });
  const provider = new NodeTracerProvider({ spanProcessors: [processor] });
  setLangfuseTracerProvider(provider);
  // Trace name, session and tags travel in the OTel context (propagateAttributes), which needs
  // a context manager. Only the context manager is global; the tracer provider is not.
  // setGlobalContextManager returns false when one is already set: that one is kept.
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

  const roots = new Map<string, SpanContext>();
  // Every span of a trace carries the trace's name (Langfuse keeps the last one it sees): the
  // trace key at first, then "evt_N · <title>" once a case.version line names the case.
  const names = new Map<string, string>();
  const warn = opts.warn ?? ((m: string) => console.error(m));
  let warned = 0;

  function emit(p: ObservationPlan): void {
    if (p.traceName) names.set(p.traceKey, p.traceName);
    const attrs = {
      tags: [opts.environment],
      traceName: names.get(p.traceKey) ?? p.traceKey,
      ...(p.sessionId ? { sessionId: p.sessionId } : {}),
    };
    propagateAttributes(attrs, () => {
      let parent = roots.get(p.traceKey);
      if (!parent) {
        // The trace's root: a zero-length span at the first line; everything else hangs off it.
        const root = startObservation(p.traceKey, { metadata: { trace_key: p.traceKey } } satisfies LangfuseSpanAttributes, {
          startTime: p.startTime,
        });
        root.end(p.startTime);
        parent = root.otelSpan.spanContext();
        roots.set(p.traceKey, parent);
        if (roots.size > 10_000) {
          const oldest = roots.keys().next().value as string;
          roots.delete(oldest);
          names.delete(oldest);
        }
      }
      const attributes = { ...p.attributes, level: p.level };
      if (p.asType === "generation") {
        startObservation(p.name, attributes, { asType: "generation", startTime: p.startTime, parentSpanContext: parent }).end(p.endTime);
      } else {
        startObservation(p.name, attributes, { asType: "event", startTime: p.startTime, parentSpanContext: parent });
      }
    });
  }

  return {
    sink(line: string) {
      try {
        emit(planObservation(JSON.parse(line) as Line, opts));
      } catch (err) {
        if (warned++ < 3) warn(`langfuse trace sink: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    async shutdown() {
      try {
        await provider.forceFlush();
        await provider.shutdown();
      } catch (err) {
        warn(`langfuse trace sink: flush failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      setLangfuseTracerProvider(null);
    },
  };
}
