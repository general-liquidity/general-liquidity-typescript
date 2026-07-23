// @general-liquidity/sdk — the embeddable client implementing the GeneralLiquidity
// surface by resolving + building + SIGNING intents locally and submitting to the
// hosted server over HTTP. It NEVER holds a settle primitive (DESIGN §7 settle-line).

export type { ClientConfig } from "./client.ts";
export { createClient } from "./client.ts";
export { canonicalBytes, fromWire, toWire } from "./internal/canonical.ts";
export type { Problem } from "./internal/errors.ts";
export {
  ApprovalPendingError,
  AuthError,
  DeniedError,
  GlError,
  IdempotencyConflictError,
  InsufficientFundsError,
  MandateExceededError,
  PendingSettlementError,
  problemCode,
  RateLimitError,
  ServerError,
  ValidationError,
} from "./internal/errors.ts";
export type { RetryPolicy } from "./internal/http.ts";
export { DEFAULT_RETRY } from "./internal/http.ts";
export type { OperatorClientConfig } from "./operator/client.ts";
export { createOperatorClient, OperatorClient, signOperatorRequest } from "./operator/client.ts";
// Operator authority — a SEPARATE credential domain from the agent bearer token. The
// OperatorClient signs the detached `GL-Operator` ed25519 credential the hosted
// `/operator/*` routes verify; the agent client never mints it.
export {
  bytesToBase64Url,
  canonicalUrl,
  formatOperatorCredential,
  type MemoryOperatorOperation,
  OPERATOR_CREDENTIAL_VERSION,
  OPERATOR_HEADER,
  type OperatorCredential,
  type OperatorOperation,
  operatorBodyDigest,
  operatorSigningInput,
  type WebhookOperatorOperation,
} from "./operator/credential.ts";
export type { OperatorSigner } from "./operator/signer.ts";
export { operatorSignerFromSeed } from "./operator/signer.ts";
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
  AssembledContext,
  AssembleRequest,
  AuditEvent,
  Counterparty,
  CreateWebhookEndpoint,
  Decision,
  Disclosure,
  DisclosureSignature,
  ErasureProof,
  EvidenceClass,
  ForgetRequest,
  GeneralLiquidity,
  Intent,
  Job,
  JobStatus,
  KeyRotationStatement,
  MemoryEdge,
  MemoryMandate,
  MemoryRecord,
  MemoryVerification,
  OperatorApprove,
  OperatorKillSwitch,
  OperatorRationale,
  OperatorRefund,
  OperatorStateView,
  Page,
  PageQuery,
  PendingSettlement,
  RecallRequest,
  Receipt,
  RefundResult,
  RememberRequest,
  Seal,
  Snapshot,
  SnapshotPage,
  UpdateWebhookEndpoint,
  UsageQuery,
  UsageSummary,
  WebhookEndpoint,
  WebhookEndpointCreated,
  WebhookEvent,
  WebhookEventType,
} from "./types.ts";
