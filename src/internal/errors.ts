// Typed error taxonomy. Agents branch deterministically on the problem+json `type`
// field (RFC 7807), not on prose. `type` may be a full URI or a bare slug; we key on
// the trailing path segment so both wire shapes resolve to the same class.

import type { EvidenceClass, PendingSettlement } from "../types.ts";

/** RFC 7807 problem+json body. */
export interface Problem {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  instance?: string;
  /** Machine-parseable retry hint some servers include alongside Retry-After. */
  retryAfter?: number | string;
  [key: string]: unknown;
}

export class GlError extends Error {
  /** Stable machine code — the trailing segment of the problem `type`. */
  readonly type: string;
  readonly status: number;
  readonly detail?: string;
  readonly instance?: string;
  /** Milliseconds the caller should wait before retrying, when the server hinted one. */
  readonly retryAfterMs?: number;
  readonly problem?: Problem;

  constructor(args: {
    type: string;
    status: number;
    message: string;
    detail?: string;
    instance?: string;
    retryAfterMs?: number;
    problem?: Problem;
  }) {
    super(args.message);
    this.name = new.target.name;
    this.type = args.type;
    this.status = args.status;
    this.detail = args.detail;
    this.instance = args.instance;
    this.retryAfterMs = args.retryAfterMs;
    this.problem = args.problem;
  }

  /** Whether a retry could plausibly succeed. Drives the backoff loop. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

export class RateLimitError extends GlError {}
export class InsufficientFundsError extends GlError {}
export class MandateExceededError extends GlError {}
/** The gate returned `deny` (or `confirm` on a path that required `allow`). */
export class DeniedError extends GlError {}
export class ValidationError extends GlError {}
export class IdempotencyConflictError extends GlError {}
export class AuthError extends GlError {}
export class ServerError extends GlError {}
/** The gate parked a confirm-tier intent; it needs an operator approval before settling. */
export class ApprovalPendingError extends GlError {}
/**
 * The optional PENDING clearing band HELD a bound spend: gated and authorized, but the
 * obligation's admissibility floor is not yet met and its deadline has not passed. Retry once
 * admissible evidence exists (the hold auto-releases to a `Receipt`); the hold refuses once the
 * deadline passes. Mirrors `ApprovalPendingError`, the other 202-tier `pay` outcome.
 */
export class PendingSettlementError extends GlError {
  /** The `clearing.pending` hold, typed. Decoded from the problem body's camelCase fields. */
  get settlement(): PendingSettlement | undefined {
    const p = this.problem;
    if (!p) return undefined;
    return {
      type: "clearing.pending",
      title: String(p.title ?? ""),
      obligationId: String(p.obligationId ?? ""),
      state: "pending",
      awaiting: p.awaiting as EvidenceClass,
      achievedClass: p.achievedClass as EvidenceClass | undefined,
    };
  }
}

const BY_TYPE: Record<string, new (a: ConstructorParameters<typeof GlError>[0]) => GlError> = {
  "rate-limited": RateLimitError,
  "rate-limit": RateLimitError,
  "approval.pending": ApprovalPendingError,
  "approval-pending": ApprovalPendingError,
  "clearing.pending": PendingSettlementError,
  "clearing-pending": PendingSettlementError,
  "insufficient-funds": InsufficientFundsError,
  "mandate-exceeded": MandateExceededError,
  denied: DeniedError,
  deny: DeniedError,
  validation: ValidationError,
  "idempotency-conflict": IdempotencyConflictError,
  unauthorized: AuthError,
  forbidden: AuthError,
};

/** Trailing segment of a problem `type` URI/slug — the stable machine code. */
export function problemCode(type: string | undefined): string {
  if (!type || type === "about:blank") return "about:blank";
  const trimmed = type.replace(/[/#]+$/, "");
  const seg = trimmed.split(/[/#]/).pop();
  return seg && seg.length > 0 ? seg : "about:blank";
}

export function errorFromProblem(problem: Problem, status: number, retryAfterMs?: number): GlError {
  const code = problemCode(problem.type);
  const message = problem.title ?? problem.detail ?? `request failed (${status})`;
  const args = {
    type: code,
    status,
    message,
    detail: problem.detail,
    instance: problem.instance,
    retryAfterMs,
    problem,
  };
  const Ctor = BY_TYPE[code] ?? (status >= 500 ? ServerError : GlError);
  return new Ctor(args);
}
