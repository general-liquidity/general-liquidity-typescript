// The tracing seam. A minimal, provider-agnostic Tracer/Span the client emits a span
// around each surface op with (BUILD-PLAN §5: OTel via SDK hooks — traceparent + retries
// + idempotency key as span attributes). The SDK never hard-depends on OpenTelemetry;
// `otel.ts` maps this seam onto @opentelemetry/api when it happens to be installed, and
// `noopTracer` is the zero-cost default so tracing is opt-in and always present.

/** Values allowed on a span attribute. Mirrors the OTel attribute value shape. */
export type AttributeValue = string | number | boolean;

export interface SpanAttributes {
  [key: string]: AttributeValue | undefined;
}

/** One in-flight span. Ended exactly once by the code that started it. */
export interface Span {
  /** Attach/overwrite a single attribute. Undefined values are ignored. */
  setAttribute(key: string, value: AttributeValue | undefined): void;
  /** Record an exception event on the span without ending it. */
  recordException(error: unknown): void;
  /** Mark the span's status as error (a typed GL failure). */
  setError(error?: unknown): void;
  /**
   * The W3C `traceparent` header value for this span, propagated on the outgoing
   * request so the server joins the same trace. Undefined when the tracer emits none
   * (e.g. the no-op default) — the client then sends no header.
   */
  traceparent(): string | undefined;
  /** End the span. Idempotent-safe adapters may ignore a second call. */
  end(): void;
}

export interface Tracer {
  /** Start a span for `name`, seeding it with `attrs`. Never throws. */
  startSpan(name: string, attrs?: SpanAttributes): Span;
}

const NOOP_SPAN: Span = {
  setAttribute() {},
  recordException() {},
  setError() {},
  traceparent() {
    return undefined;
  },
  end() {},
};

/** The default tracer: allocates nothing, propagates no header. Tracing stays opt-in. */
export const noopTracer: Tracer = {
  startSpan() {
    return NOOP_SPAN;
  },
};
