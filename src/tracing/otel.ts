// Optional adapter mapping the Tracer seam onto @opentelemetry/api — WITHOUT a hard
// dependency. The types below are a hand-rolled minimal slice of the OTel API (we can't
// `import type` from a package that may not be installed), and `loadOtelTracer` reaches
// the module through a non-literal specifier so `tsc` never tries to resolve it. If OTel
// is absent the loader returns undefined and callers fall back to `noopTracer`.

import type { AttributeValue, Span, SpanAttributes, Tracer } from "./tracer.ts";

/** The subset of an OTel SpanContext we read to build a `traceparent`. */
interface OtelSpanContext {
  traceId: string;
  spanId: string;
  traceFlags: number;
}

/** The subset of an OTel Span we drive. */
interface OtelSpan {
  setAttribute(key: string, value: AttributeValue): void;
  recordException(error: unknown): void;
  setStatus(status: { code: number; message?: string }): void;
  spanContext(): OtelSpanContext;
  end(): void;
}

interface OtelTracer {
  startSpan(name: string, options?: { attributes?: Record<string, AttributeValue> }): OtelSpan;
}

/** The slice of the `@opentelemetry/api` module surface this adapter consumes. */
export interface OtelApi {
  trace: { getTracer(name: string, version?: string): OtelTracer };
}

// SpanStatusCode.ERROR in @opentelemetry/api. Hard-coded so we need no import for it.
const STATUS_ERROR = 2;

/** Build a W3C `traceparent` (version-00) from an OTel span context. */
function traceparentFrom(ctx: OtelSpanContext): string {
  const flags = (ctx.traceFlags & 0xff).toString(16).padStart(2, "0");
  return `00-${ctx.traceId}-${ctx.spanId}-${flags}`;
}

function wrapSpan(otel: OtelSpan): Span {
  return {
    setAttribute(key, value) {
      if (value !== undefined) otel.setAttribute(key, value);
    },
    recordException(error) {
      otel.recordException(error);
    },
    setError(error) {
      const message = error instanceof Error ? error.message : error ? String(error) : undefined;
      otel.setStatus({ code: STATUS_ERROR, message });
    },
    traceparent() {
      const ctx = otel.spanContext();
      if (!ctx?.traceId || !ctx.spanId) return undefined;
      return traceparentFrom(ctx);
    },
    end() {
      otel.end();
    },
  };
}

/**
 * Adapt an already-loaded `@opentelemetry/api` module to the Tracer seam. Prefer this
 * when the caller already holds the module; `loadOtelTracer` wraps it with a dynamic
 * import for the common case.
 */
export function otelTracer(api: OtelApi, name = "@general-liquidity/sdk"): Tracer {
  const tracer = api.trace.getTracer(name);
  return {
    startSpan(spanName: string, attrs?: SpanAttributes): Span {
      const attributes: Record<string, AttributeValue> = {};
      if (attrs) {
        for (const [k, v] of Object.entries(attrs)) if (v !== undefined) attributes[k] = v;
      }
      return wrapSpan(tracer.startSpan(spanName, { attributes }));
    },
  };
}

// A non-literal specifier: `tsc` does not resolve dynamic imports whose argument is a
// `string` variable, so this compiles cleanly even though @opentelemetry/api is not a
// dependency. The value is assembled at runtime.
const OTEL_MODULE = ["@opentelemetry", "api"].join("/");

/** How the loader reaches a module. Injectable so both branches stay testable. */
export type ModuleLoader = (specifier: string) => Promise<unknown>;

const dynamicImport: ModuleLoader = (specifier) => import(specifier);

/**
 * Try to load @opentelemetry/api and adapt it to the Tracer seam. Returns undefined when
 * the package is not installed or does not expose a tracer — the caller then falls back
 * to `noopTracer`. Never throws.
 */
export async function loadOtelTracer(
  name = "@general-liquidity/sdk",
  load: ModuleLoader = dynamicImport,
): Promise<Tracer | undefined> {
  try {
    const mod = (await load(OTEL_MODULE)) as OtelApi | undefined;
    if (typeof mod?.trace?.getTracer !== "function") return undefined;
    return otelTracer(mod, name);
  } catch {
    return undefined;
  }
}
