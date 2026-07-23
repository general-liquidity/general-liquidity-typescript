// The wire contract, mirrors the General Liquidity OpenAPI spec. Kept in sync via the
// spec (general-liquidity-openapi).
//
// camelCase here; snake_case on the wire. This file is the SDK's own public contract:
// the noun/value types the client signs, submits, and decodes, plus the GeneralLiquidity
// surface it implements. The SDK vendors these so it carries zero workspace dependencies.

import type { Problem } from "./internal/errors.ts";

/** An injected fetch. Defaults to the global `fetch` when the caller supplies none. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** A payment rail behind pay()/buy(). Vendor + protocol names appear ONLY here as ids. */
export type RailId = "x402" | "mpp" | "ap2" | "acp" | "ucp" | "card" | "onchain";

/** The gate's verdict. Deny-first. */
export type Outcome = "allow" | "confirm" | "deny";

/** Whether a settled payment can be reversed. */
export type Reversibility = "reversible" | "irreversible";

/** When value becomes final. */
export type Finality = "instant" | "deferred";

/** Who fronts capital across the settlement. */
export type CapitalSource = "payer" | "facilitator" | "merchant_of_record" | "solver";

/** Human-presence requirement at authorization time. */
export type Presence = "present" | "delegated";

/** A value + its asset. Minor units / atomic, carried as a string to avoid float loss. */
export interface Amount {
  value: string;
  /** Currency code or CAIP-19 asset id. */
  asset: string;
}

/**
 * The six irreducible fields. Explicit on every Intent and Receipt, never defaulted
 * silently — this is what the Gate reasons over and where a spend agent loses money.
 */
export interface Terms {
  reversibility: Reversibility;
  finality: Finality;
  /** Authorization model id, e.g. "eip3009" | "vc-mandate" | "http-sig". */
  credential: string;
  rail: RailId;
  capitalSource: CapitalSource;
  presence: Presence;
}

/** Operator-granted, scoped, capped, expiring spend authority. */
export interface Mandate {
  id: string;
  /** Allowed counterparties (CAIP-10 where on-chain). */
  payees: string[];
  perTxCap: Amount;
  perPeriodCap: Amount;
  /** ISO-8601 duration for the period cap window. */
  period: string;
  /** ISO-8601 instant. */
  expiresAt: string;
  constraints?: Record<string, unknown>;
}

/** An operator-counter-signed delegation of scope to an agent key. */
export interface Grant {
  agentId: string;
  mandateId: string;
  /** ISO-8601 instant. */
  expiresAt: string;
  signature: string;
}

/** The layered signed delegation wrapping an Intent: identity + mandate + provenance. */
export interface Envelope {
  /** Caller agent id (CAIP-addressed). */
  identity: string;
  mandateId: string;
  grant: Grant;
  signature: string;
}

/** A signed request to move value. Input to pay(); never carries a settle primitive. */
export interface Intent {
  idempotencyKey: string;
  payee: string;
  amount: Amount;
  purpose: string;
  terms: Terms;
  envelope: Envelope;
}

/** The gate's decision on an Intent. */
export interface Decision {
  outcome: Outcome;
  reasons: string[];
  mandateId: string;
}

/** Durable, machine-parseable proof of settlement. */
export interface Receipt {
  intentKey: string;
  rail: RailId;
  /** Rail settlement reference / on-chain tx hash. */
  reference: string;
  terms: Terms;
  /** ISO-8601 instant. */
  settledAt: string;
  /** Proof-of-Enforcement hash, byte-identical between emitter and verifier. */
  enforcement: string;
}

/** The ed25519 signature over a canonicalized disclosure document. */
export interface DisclosureSignature {
  algorithm: "ed25519";
  /**
   * Signer's public key (hex). Equals `document.agentId` in the common case; under
   * rotation it is the current key at the tip of `rotationChain`.
   */
  publicKey: string;
  /** Signature over the canonicalized document (hex). */
  value: string;
}

/**
 * One signed hop of a key-rotation chain: the old key signs the move to the new key,
 * so an identity survives a key change (an agentId IS its public key).
 */
export interface KeyRotationStatement {
  type: "rotation";
  /** agentId (public key hex) being rotated away from. */
  from: string;
  /** agentId (public key hex) being rotated to. */
  to: string;
  /** ISO-8601 instant. */
  rotatedAt: string;
  /** Old key's signature over {type, from, to, rotatedAt} (hex). */
  signature: string;
}

/**
 * A signed self-description (identity + provenance). GL's disclosure format. The wire
 * shape equals the signed envelope both sides exchange, so a rotated signing key can
 * disclose while the stable agent id (`document.agentId`) is preserved. No agentId at
 * the top level: it lives in the signed document.
 */
export interface Disclosure {
  /** The signed disclosure document (an AgentDisclosure). Its `agentId` roots the signature. */
  document: Record<string, unknown>;
  signature: DisclosureSignature;
  /**
   * Present only when the signing key has rotated away from `document.agentId`; links the
   * stable id to `signature.publicKey`. Absent in the common no-rotation case.
   */
  rotationChain?: KeyRotationStatement[];
}

/** A normalized, resolved counterparty identity. */
export interface Counterparty {
  id: string;
  transport: "a2a" | "disclosure" | "caip";
  capabilities: string[];
  rails: RailId[];
  trust?: Record<string, unknown>;
}

/** A single signed, hash-linked entry in the audit trail. */
export interface AuditEvent {
  /** Monotonic wire event type, e.g. "intent.gated" | "intent.settled". */
  type: string;
  /** ISO-8601 instant. */
  at: string;
  intentKey?: string;
  /** HMAC hash of the previous entry — the hash-link. */
  prev?: string;
  /** Opaque passthrough payload. */
  payload: Record<string, unknown>;
}

/**
 * A cursor-paginated page envelope. `data` holds the items; `nextCursor` names the last
 * item so the next call resumes strictly after it (no overlap, no gap).
 */
export interface Page<T> {
  data: T[];
  /** True when items remain after this page. */
  hasMore: boolean;
  /** Token for the next page, or null when `hasMore` is false. */
  nextCursor: string | null;
}

/** Cursor-pagination query params. `limit` is clamped to [1, 100] server-side. */
export interface PageQuery {
  cursor?: string;
  limit?: number;
}

/**
 * Terminal-state enum for a job, grounded one-for-one in the store states. `pending` is
 * the only non-terminal state (parked, awaiting operator approval).
 */
export type JobStatus = "pending" | "settled" | "denied" | "failed";

/** A read projection over an intent's confirm-park-approve lifecycle. */
export interface Job {
  /** The idempotency/intent key — the stable resource id. */
  id: string;
  status: JobStatus;
  /** ISO-8601 instant of the intent's first audit entry, falling back to its settle time. */
  createdAt: string;
  /** Set ONLY for terminal states (settled/denied/failed). */
  terminalAt?: string;
  outcome: Outcome;
  /** Present on a settled job. */
  receipt?: Receipt;
  /** The RFC 9457 problem on a denied/failed job. */
  problem?: Problem;
  /** Resume material, present only on a pending job. */
  pending?: {
    mandateId?: string;
    /** Opaque challenge an operator approval binds to. */
    challenge?: string;
  };
  links: {
    self: string;
    events: string;
  };
}

/** Metered call counts for one principal over a half-open window. Counts only. */
export interface UsageSummary {
  keyId: string;
  /** ISO-8601 inclusive lower bound. */
  since: string;
  /** ISO-8601 exclusive upper bound. */
  until: string;
  /** Total calls counted in the window (after any tag filter). */
  total: number;
  /** Count keyed by operation, e.g. { pay: 3, resolve: 1 }. */
  byOperation: Record<string, number>;
  /** Count keyed by outcome, e.g. { allow: 2, deny: 1 }. */
  byOutcome: Record<string, number>;
}

/** Usage query: a half-open window `[since, until)` plus an optional AND-tag filter. */
export interface UsageQuery {
  /** ISO-8601 inclusive lower bound. */
  since: string;
  /** ISO-8601 exclusive upper bound. */
  until: string;
  /** Count only calls carrying EVERY listed tag (AND semantics). */
  tags?: string[];
}

// Operator surface (the `/operator/*` routes). A SEPARATE authorization domain from the
// agent bearer token: these are gated only by the detached `GL-Operator` ed25519
// credential, which the hand-written client does not mint. The wire types are mirrored
// here so callers can construct and decode operator payloads; the transport for them is
// operator-tooling, not this agent client.

/** Resume material for a parked (confirm-tier) intent, plus the operator's acknowledgement. */
export interface OperatorApprove {
  /** The parked intent id. */
  intentId: string;
  /** The opaque challenge that binds this approval to that intent. Not a bearer credential. */
  challenge: string;
  /** The mandate the gate matched when it parked the intent. */
  mandateId: string;
  /** Why the operator is releasing it. Recorded in the signed audit chain (min 10 chars). */
  rationale: string;
  /** Explicit challenge-response acknowledgement. Never inferred for a high-risk release. */
  acknowledged: boolean;
}

/** Request to reverse a settled payment on a reversible rail. */
export interface OperatorRefund {
  intentId: string;
  /** Minor units to refund. Omitted, the full outstanding amount. */
  amountMinor?: number;
  /** min 10 chars. */
  rationale: string;
}

/** Engage or disengage the kill switch. Signed separately per direction. */
export interface OperatorKillSwitch {
  /** True freezes the settle path; false releases it. */
  engaged: boolean;
  /** min 10 chars. */
  rationale: string;
}

/** A bare operator rationale, e.g. to reset a tripped circuit breaker. */
export interface OperatorRationale {
  /** min 10 chars. */
  rationale: string;
}

/** The result of an operator refund. */
export interface RefundResult {
  ok: boolean;
  /** Cumulative minor units refunded against the intent. */
  refundedMinor: number;
  /** Present on refusal, e.g. an irreversible settlement. */
  reason?: string;
}

/** The live halt state, returned so an operator sees the effect of what they just did. */
export interface OperatorStateView {
  killSwitchEngaged: boolean;
  circuitBreakerOpen: boolean;
}

// Webhook subscription management. OPERATOR authority: an endpoint that receives
// settlement/audit events is gated by the `GL-Operator` credential, not the agent bearer
// token, so this CRUD rides the OperatorClient. Events are derived from the signed audit
// chain and signed with a per-endpoint `whsec_` secret (the `GL-Signature` header).

/** The outbound event types a subscription filters on. */
export type WebhookEventType =
  | "payment.settled"
  | "intent.denied"
  | "approval.pending"
  | "audit.appended";

/** A registered delivery endpoint as the reads expose it (secret redacted). */
export interface WebhookEndpoint {
  id: string;
  url: string;
  events: WebhookEventType[];
  active: boolean;
}

/** The created endpoint, including its one-time `whsec_` secret (returned ONCE, at create). */
export interface WebhookEndpointCreated extends WebhookEndpoint {
  /** The `whsec_` HMAC signing secret. Shown ONCE, at create, never again. */
  secret: string;
}

/** Registration input for a new webhook endpoint. */
export interface CreateWebhookEndpoint {
  url: string;
  events: WebhookEventType[];
  /** Defaults to true server-side. */
  active?: boolean;
}

/** Partial update for a webhook endpoint. Only the named fields change. */
export interface UpdateWebhookEndpoint {
  url?: string;
  events?: WebhookEventType[];
  active?: boolean;
}

/**
 * One delivered webhook event, derived from a signed audit entry. `id` is deterministic
 * in the source entry (dedup key across at-least-once retries), signed with the endpoint's
 * secret via the `GL-Signature` header.
 */
export interface WebhookEvent {
  /** Deterministic event id, `evt_<audit_hash>`. */
  id: string;
  type: WebhookEventType;
  /** ISO-8601 instant. */
  createdAt: string;
  /** Source entry payload plus chain coordinates (`audit_seq`, `audit_hash`, `audit_type`). */
  data: Record<string, unknown>;
}

/**
 * The canonical General Liquidity surface. Small, task-shaped, self-describing —
 * every method is also an MCP tool name. The agent submits signed intents; the
 * sovereign gate decides and settles. The agent never reaches a settle primitive.
 */
export interface GeneralLiquidity {
  /** Normalize a counterparty reference into one identity. */
  resolve(ref: string): Promise<Counterparty>;

  /** Submit a signed Intent. The gate decides; on `allow` it settles and returns a Receipt. */
  pay(intent: Intent): Promise<Receipt>;

  /** Check a counterparty's signed disclosure against policy. */
  verify(disclosure: Disclosure): Promise<Decision>;

  /** Produce GL's own signed disclosure: what this agent is and is authorized to do. */
  disclose(): Promise<Disclosure>;

  /** Read the async job resource for one intent (`GET /intents/{id}`). */
  getJob(id: string): Promise<Job>;

  /** List one intent's signed audit events, cursor-paginated (`GET /intents/{id}/events`). */
  getJobEvents(id: string, query?: PageQuery): Promise<Page<AuditEvent>>;

  /** Read the signed, hash-linked audit trail, cursor-paginated (`GET /audit`). */
  getAudit(query?: PageQuery): Promise<Page<AuditEvent>>;

  /** Read metered call counts for the authenticated principal (`GET /usage`). */
  getUsage(query: UsageQuery): Promise<UsageSummary>;
}
