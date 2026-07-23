// The OperatorClient: the client half of the operator authority domain. It signs the
// detached `GL-Operator` credential and calls the hosted `/operator/*` routes.
//
//   approve                 POST /operator/approve
//   refund                  POST /operator/refund
//   engage/disengageKillSwitch  POST /operator/kill-switch
//   resetCircuitBreaker     POST /operator/circuit-breaker/reset
//
// It is DELIBERATELY not the agent `createClient`: operator authority must never ride
// the agent's bearer token. The body is sent as the EXACT bytes the signature digests
// (camelCase, serialized once) — the operator routes read those fields verbatim and the
// digest binds the intent id / amount / direction to the signature.

import { errorFromProblem, type Problem } from "../internal/errors.ts";
import type {
  CreateWebhookEndpoint,
  ErasureProof,
  FetchLike,
  ForgetRequest,
  OperatorApprove,
  OperatorRefund,
  OperatorStateView,
  Receipt,
  RefundResult,
  UpdateWebhookEndpoint,
  WebhookEndpoint,
  WebhookEndpointCreated,
} from "../types.ts";
import {
  formatOperatorCredential,
  type MemoryOperatorOperation,
  OPERATOR_HEADER,
  type OperatorOperation,
  operatorBodyDigest,
  operatorSigningInput,
  type WebhookOperatorOperation,
} from "./credential.ts";
import type { OperatorSigner } from "./signer.ts";

export interface OperatorClientConfig {
  /** Base URL of the hosted GL server. */
  baseUrl: string;
  /** The operator-held ed25519 signer. Its key never enters the SDK. */
  signer: OperatorSigner;
  /** Injected fetch. Defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Injected epoch-MILLIS clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Single-use nonce generator. Defaults to `crypto.randomUUID`. */
  newNonce?: () => string;
}

/**
 * Sign one operator request and return the `GL-Operator` header value. Exposed so the
 * exact header bytes can be pinned by a fixed-vector test. `body` MUST be the exact
 * string that will be sent: the digest is over those bytes.
 */
export async function signOperatorRequest(params: {
  signer: OperatorSigner;
  operation: OperatorOperation | WebhookOperatorOperation | MemoryOperatorOperation;
  method: string;
  url: string;
  body: string;
  ts: number;
  nonce: string;
}): Promise<string> {
  const bodyDigest = await operatorBodyDigest(params.body);
  const input = operatorSigningInput({
    operation: params.operation,
    method: params.method,
    url: params.url,
    ts: params.ts,
    nonce: params.nonce,
    bodyDigest,
  });
  const signature = await params.signer.sign(new TextEncoder().encode(input));
  return formatOperatorCredential({
    keyId: params.signer.keyId,
    ts: params.ts,
    nonce: params.nonce,
    signature,
  });
}

const defaultNonce = (): string => globalThis.crypto.randomUUID();

/** The operator command client. One signed request per method; no shared bearer token. */
export class OperatorClient {
  private readonly baseUrl: string;
  private readonly signer: OperatorSigner;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly newNonce: () => string;

  constructor(cfg: OperatorClientConfig) {
    const fetchImpl = cfg.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (!fetchImpl)
      throw new Error("no fetch available: inject one via new OperatorClient({ fetch })");
    this.baseUrl = cfg.baseUrl;
    this.signer = cfg.signer;
    this.fetchImpl = fetchImpl;
    this.now = cfg.now ?? Date.now;
    this.newNonce = cfg.newNonce ?? defaultNonce;
  }

  /**
   * Release one parked intent. Carries exactly the fields the `approval.pending` problem
   * hands back — `intentId`, `challenge`, `mandateId` — plus the operator's `rationale`
   * and explicit `acknowledged`. On `settled` returns the Receipt; a withheld challenge
   * surfaces as an `ApprovalPendingError`, a kernel refusal as a GL error.
   */
  approve(req: OperatorApprove): Promise<Receipt> {
    return this.call<Receipt>("approve", "/operator/approve", {
      intentId: req.intentId,
      challenge: req.challenge,
      mandateId: req.mandateId,
      rationale: req.rationale,
      acknowledged: req.acknowledged,
    });
  }

  /** Reverse a settled payment. Full amount unless `amountMinor` names a partial. */
  refund(req: OperatorRefund): Promise<RefundResult> {
    return this.call<RefundResult>("refund", "/operator/refund", {
      intentId: req.intentId,
      ...(req.amountMinor !== undefined ? { amountMinor: req.amountMinor } : {}),
      rationale: req.rationale,
    });
  }

  /** Freeze the settle path. */
  engageKillSwitch(rationale: string): Promise<OperatorStateView> {
    return this.call<OperatorStateView>("kill_switch.engage", "/operator/kill-switch", {
      engaged: true,
      rationale,
    });
  }

  /** Release the settle path. Signed as a distinct operation from the freeze. */
  disengageKillSwitch(rationale: string): Promise<OperatorStateView> {
    return this.call<OperatorStateView>("kill_switch.disengage", "/operator/kill-switch", {
      engaged: false,
      rationale,
    });
  }

  /** Clear a tripped circuit breaker. */
  resetCircuitBreaker(rationale: string): Promise<OperatorStateView> {
    return this.call<OperatorStateView>(
      "circuit_breaker.reset",
      "/operator/circuit-breaker/reset",
      { rationale },
    );
  }

  /**
   * Cascading erasure of a memory record and its dependents (`POST /memory/forget`).
   * OPERATOR authority — it rides the SAME `GL-Operator` credential as approve/refund, never
   * the agent key, and the mandate's `canErase` is checked in addition server-side. Returns
   * the signed ErasureProof. The body is sent verbatim (memory wire is camelCase).
   */
  memoryForget(req: ForgetRequest): Promise<ErasureProof> {
    return this.call<ErasureProof>("memory:forget", "/memory/forget", {
      mandate: req.mandate,
      rootId: req.rootId,
    });
  }

  /**
   * Register a webhook endpoint. OPERATOR authority — an endpoint that receives
   * settlement/audit events is gated by the `GL-Operator` credential, not the agent key.
   * The `whsec_` signing secret is returned ONCE, on this call; the reads never re-expose it.
   */
  createWebhookEndpoint(req: CreateWebhookEndpoint): Promise<WebhookEndpointCreated> {
    return this.webhookRequest<WebhookEndpointCreated>("POST", "/webhooks/endpoints", {
      url: req.url,
      events: req.events,
      ...(req.active !== undefined ? { active: req.active } : {}),
    });
  }

  /** List the registered webhook endpoints (secrets redacted). */
  listWebhookEndpoints(): Promise<{ data: WebhookEndpoint[] }> {
    return this.webhookRequest<{ data: WebhookEndpoint[] }>("GET", "/webhooks/endpoints");
  }

  /** Read one webhook endpoint (secret redacted). */
  getWebhookEndpoint(id: string): Promise<WebhookEndpoint> {
    return this.webhookRequest<WebhookEndpoint>(
      "GET",
      `/webhooks/endpoints/${encodeURIComponent(id)}`,
    );
  }

  /** Update one webhook endpoint. Only the named fields change. */
  updateWebhookEndpoint(id: string, req: UpdateWebhookEndpoint): Promise<WebhookEndpoint> {
    return this.webhookRequest<WebhookEndpoint>(
      "PATCH",
      `/webhooks/endpoints/${encodeURIComponent(id)}`,
      { ...req },
    );
  }

  /** Delete one webhook endpoint. */
  deleteWebhookEndpoint(id: string): Promise<void> {
    return this.webhookRequest<void>("DELETE", `/webhooks/endpoints/${encodeURIComponent(id)}`);
  }

  /**
   * One signed webhook-CRUD request. Same operator credential scheme as {@link call}, but
   * the verb varies (GET/POST/PATCH/DELETE) and the operation is the webhook-scoped
   * `webhook:<method>` the server signs over. GET/DELETE send no body — the digest is over
   * the empty string, matching the server. Any 2xx is success (201 create, 200 read/update,
   * 204 delete); everything else is a typed GL error.
   */
  private async webhookRequest<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    bodyObj?: Record<string, unknown>,
  ): Promise<T> {
    const url = new URL(path, this.baseUrl).toString();
    // Serialize ONCE. The digest, the signature, and the wire body are all this string;
    // a bodyless GET/DELETE digests the empty string, as the server does.
    const body = bodyObj === undefined ? "" : JSON.stringify(bodyObj);
    const ts = Math.floor(this.now() / 1000);
    const nonce = this.newNonce();

    const credential = await signOperatorRequest({
      signer: this.signer,
      operation: `webhook:${method.toLowerCase()}` as WebhookOperatorOperation,
      method,
      url,
      body,
      ts,
      nonce,
    });

    const headers: Record<string, string> = {
      accept: "application/json",
      [OPERATOR_HEADER]: credential,
    };
    if (bodyObj !== undefined) headers["content-type"] = "application/json";

    const res = await this.fetchImpl(url, {
      method,
      headers,
      ...(bodyObj !== undefined ? { body } : {}),
    });

    if (res.status >= 200 && res.status < 300) {
      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    }

    const problem = await readProblem(res);
    throw errorFromProblem(problem, res.status);
  }

  private async call<T>(
    operation: OperatorOperation | MemoryOperatorOperation,
    path: string,
    bodyObj: Record<string, unknown>,
  ): Promise<T> {
    const url = new URL(path, this.baseUrl).toString();
    // Serialize ONCE. The digest, the signature, and the wire body are all this string.
    const body = JSON.stringify(bodyObj);
    const ts = Math.floor(this.now() / 1000);
    const nonce = this.newNonce();

    const credential = await signOperatorRequest({
      signer: this.signer,
      operation,
      method: "POST",
      url,
      body,
      ts,
      nonce,
    });

    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        [OPERATOR_HEADER]: credential,
      },
      body,
    });

    // The operator routes serialize their kernel results as plain camelCase JSON (no
    // snake_case wire mapping), so the success body decodes directly. 200 alone is a
    // completed operation: a 202 `approval.pending` is a withheld challenge and routes
    // through the typed-error path so the caller cannot mistake it for a settlement.
    if (res.status === 200) {
      return (await res.json()) as T;
    }

    const problem = await readProblem(res);
    throw errorFromProblem(problem, res.status);
  }
}

async function readProblem(res: Response): Promise<Problem> {
  try {
    const body = (await res.json()) as unknown;
    if (body && typeof body === "object") return body as Problem;
  } catch {
    // fall through
  }
  return { status: res.status, title: res.statusText || `HTTP ${res.status}` };
}

/** Construct an OperatorClient bound to a server and an operator signer. */
export function createOperatorClient(cfg: OperatorClientConfig): OperatorClient {
  return new OperatorClient(cfg);
}
