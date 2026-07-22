// @general-liquidity/sdk — the embeddable client implementing the GeneralLiquidity
// surface by resolving + building + SIGNING intents locally and submitting to the
// hosted server over HTTP. It NEVER holds a settle primitive (DESIGN §7 settle-line).

export type { ClientConfig } from "./client.ts";
export { createClient } from "./client.ts";
export { canonicalBytes, fromWire, toWire } from "./internal/canonical.ts";
export type { Problem } from "./internal/errors.ts";
export {
  AuthError,
  DeniedError,
  GlError,
  IdempotencyConflictError,
  InsufficientFundsError,
  MandateExceededError,
  problemCode,
  RateLimitError,
  ServerError,
  ValidationError,
} from "./internal/errors.ts";
export type { RetryPolicy } from "./internal/http.ts";
export { DEFAULT_RETRY } from "./internal/http.ts";
export type { Signer } from "./signer/signer.ts";
export { signIntent } from "./signer/signer.ts";
export type { OtelApi } from "./tracing/otel.ts";
export { loadOtelTracer, otelTracer } from "./tracing/otel.ts";
export type { AttributeValue, Span, SpanAttributes, Tracer } from "./tracing/tracer.ts";
// Tracing seam (BUILD-PLAN §5). `noopTracer` is the default; the OTel adapter is
// optional and dynamically loaded — @opentelemetry/api is never a dependency.
export { noopTracer } from "./tracing/tracer.ts";
// Re-export the surface types the SDK consumes, so callers need one import.
export type {
  Counterparty,
  Decision,
  Disclosure,
  GeneralLiquidity,
  Intent,
  Receipt,
} from "./types.ts";
