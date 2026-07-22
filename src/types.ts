// The wire contract, mirrors the General Liquidity OpenAPI spec. Kept in sync via the
// spec (general-liquidity-openapi).
//
// camelCase here; snake_case on the wire. This file is the SDK's own public contract:
// the noun/value types the client signs, submits, and decodes, plus the GeneralLiquidity
// surface it implements. The SDK vendors these so it carries zero workspace dependencies.

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

/** A signed self-description (identity + provenance). GL's disclosure format. */
export interface Disclosure {
  /** Equals the ed25519 public key. */
  agentId: string;
  document: Record<string, unknown>;
  signature: string;
}

/** A normalized, resolved counterparty identity. */
export interface Counterparty {
  id: string;
  transport: "a2a" | "disclosure" | "caip";
  capabilities: string[];
  rails: RailId[];
  trust?: Record<string, unknown>;
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
}
