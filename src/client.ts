import { DEFAULT_RETRY, Http, type RetryPolicy } from "./internal/http.ts";
import { type Signer, signIntent } from "./signer/signer.ts";
import { noopTracer, type Span, type Tracer } from "./tracing/tracer.ts";
import type {
  AssembledContext,
  AssembleRequest,
  AuditEvent,
  BuyRequest,
  Cart,
  Commerce,
  Counterparty,
  Decision,
  Disclosure,
  FetchLike,
  GeneralLiquidity,
  Intent,
  Job,
  MemoryRecord,
  MemoryVerification,
  Order,
  Page,
  PageQuery,
  QuoteRequest,
  RecallRequest,
  Receipt,
  RememberRequest,
  SnapshotPage,
  UsageQuery,
  UsageSummary,
} from "./types.ts";

export interface ClientConfig {
  /** Base URL of the hosted GL server (the trust boundary that holds the settler). */
  baseUrl: string;
  /** Operator-held signer. Keys never enter the SDK. */
  signer: Signer;
  /** Injected fetch. Defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Retry/backoff policy override. */
  retry?: Partial<RetryPolicy>;
  /** Idempotency-key generator override (tests/deterministic runs). */
  newIdempotencyKey?: () => string;
  /**
   * Tracing seam. Defaults to `noopTracer`. Pass `otelTracer(api)` / `await
   * loadOtelTracer()` to emit OpenTelemetry spans; the SDK never depends on OTel itself.
   */
  tracer?: Tracer;
}

const defaultKey = (): string => globalThis.crypto.randomUUID();

/**
 * The embeddable GL client. Resolves + builds + SIGNS intents locally and submits
 * to the server over HTTP. It never holds a settle primitive — `pay` sends a signed
 * intent and the sovereign gate on the server decides and settles.
 */
class GlClient implements GeneralLiquidity, Commerce {
  private readonly http: Http;
  private readonly signer: Signer;
  private readonly newKey: () => string;
  private readonly tracer: Tracer;

  constructor(cfg: ClientConfig) {
    const fetchImpl = cfg.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (!fetchImpl) throw new Error("no fetch available: inject one via createClient({ fetch })");
    this.signer = cfg.signer;
    this.newKey = cfg.newIdempotencyKey ?? defaultKey;
    this.tracer = cfg.tracer ?? noopTracer;
    this.http = new Http({
      baseUrl: cfg.baseUrl,
      fetch: fetchImpl,
      retry: { ...DEFAULT_RETRY, ...cfg.retry },
    });
  }

  /**
   * One span per surface op. Typed GL failures mark the span as errored and record the
   * exception before rethrowing — a traced failure is still the caller's failure.
   */
  private async traced<T>(op: string, run: (span: Span) => Promise<T>): Promise<T> {
    const span = this.tracer.startSpan(`gl.${op}`, { "gl.op": op });
    try {
      return await run(span);
    } catch (error) {
      span.recordException(error);
      span.setError(error);
      throw error;
    } finally {
      span.end();
    }
  }

  resolve(ref: string): Promise<Counterparty> {
    return this.traced("resolve", (span) =>
      this.http.post<Counterparty>("resolve", { ref }, {}, span),
    );
  }

  /**
   * Submit a signed Intent. On `allow` (200) the gate settles and returns a `Receipt`. A 202
   * is accepted-but-not-settled and surfaces as a typed error, never a `Receipt`: `confirm`
   * throws `ApprovalPendingError` (needs operator approval), and — on a stack that wired the
   * optional PENDING clearing band — a HELD bound spend throws `PendingSettlementError`
   * (`clearing.pending`, carrying the typed `.settlement`). `deny` throws `DeniedError`.
   */
  pay(intent: Intent): Promise<Receipt> {
    return this.traced("pay", async (span) => {
      // Auto-generate the idempotency key when the caller left it blank — never let the
      // agent own it silently, but don't force it to mint one either.
      const idempotencyKey = intent.idempotencyKey || this.newKey();
      span.setAttribute("gl.idempotency_key", idempotencyKey);
      const keyed: Intent = { ...intent, idempotencyKey };
      const signed = await signIntent(keyed, this.signer);
      // Money settles on 200 only; a 202 (approval.pending / clearing.pending) is a typed error.
      return this.http.post<Receipt>(
        "pay",
        signed,
        { "idempotency-key": idempotencyKey },
        span,
        true,
      );
    });
  }

  verify(disclosure: Disclosure): Promise<Decision> {
    return this.traced("verify", (span) =>
      this.http.post<Decision>("verify", disclosure, {}, span),
    );
  }

  disclose(): Promise<Disclosure> {
    return this.traced("disclose", async (span) => {
      // Ask the server for GL's disclosure document, then sign it locally so the
      // signature is bound to the operator's key, not the server's.
      const document = await this.http.post<Record<string, unknown>>("disclose", {}, {}, span);
      const value = await this.signer.sign(new TextEncoder().encode(JSON.stringify(document)));
      const publicKey = this.signer.agentId ?? "";
      return { document, signature: { algorithm: "ed25519", publicKey, value } };
    });
  }

  // Commerce. Opt-in and default-off server-side: a deployment that did not enable the tier
  // answers 404 `not_found`, which arrives here as the same typed problem as any other
  // refusal. The client does not probe for the capability — a missing tier is a server
  // answer, not a different client shape.

  quote(req: QuoteRequest): Promise<Cart> {
    // Commits nothing, so no idempotency key and no strict-200: `quote` is a read of the
    // merchant's pricing, and the Cart it returns is the server-authoritative one.
    return this.traced("quote", (span) => this.http.post<Cart>("quote", req, {}, span));
  }

  /**
   * Drive a merchant checkout to a completed `Order`. The price is never taken from the
   * caller: it comes from the server-authoritative cart the merchant priced, which is why
   * this body carries lines and no amount.
   *
   * Unlike `pay`, the replay key rides the BODY and is namespaced apart from `/pay`'s, so it
   * is required rather than auto-generated — a caller that let the SDK mint one silently
   * could not re-send the identical request after a `503 rail.unavailable`, which is the one
   * outcome the server does not store precisely so it can be retried.
   *
   * There is no parked-intent path here. A merchant session cannot be held open across an
   * out-of-band operator approval, so a gate `confirm` arrives as `DeniedError` (403) rather
   * than `ApprovalPendingError`; there is nothing for `/operator/approve` to release.
   */
  buy(req: BuyRequest): Promise<Order> {
    return this.traced("buy", (span) => {
      span.setAttribute("gl.idempotency_key", req.idempotencyKey);
      // Money settles on 200 only, as on `pay`.
      return this.http.post<Order>("buy", req, {}, span, true);
    });
  }

  getJob(id: string): Promise<Job> {
    return this.traced("get_job", (span) =>
      this.http.get<Job>(`intents/${encodeURIComponent(id)}`, {}, span),
    );
  }

  getJobEvents(id: string, query: PageQuery = {}): Promise<Page<AuditEvent>> {
    return this.traced("get_job_events", (span) =>
      this.http.get<Page<AuditEvent>>(
        `intents/${encodeURIComponent(id)}/events`,
        { cursor: query.cursor, limit: query.limit },
        span,
      ),
    );
  }

  getAudit(query: PageQuery = {}): Promise<Page<AuditEvent>> {
    return this.traced("get_audit", (span) =>
      this.http.get<Page<AuditEvent>>("audit", { cursor: query.cursor, limit: query.limit }, span),
    );
  }

  getUsage(query: UsageQuery): Promise<UsageSummary> {
    return this.traced("get_usage", (span) =>
      this.http.get<UsageSummary>(
        "usage",
        { since: query.since, until: query.until, tags: query.tags },
        span,
      ),
    );
  }

  // Memory group. Read back verbatim, without even the legacy envelope rename: a
  // MemoryRecord `body` is an arbitrary caller payload whose keys are the caller's.

  memoryRemember(req: RememberRequest): Promise<MemoryRecord> {
    return this.traced("memory_remember", (span) =>
      this.http.postRaw<MemoryRecord>("memory/remember", req, {}, span),
    );
  }

  memoryRecall(req: RecallRequest, page: PageQuery = {}): Promise<SnapshotPage> {
    return this.traced("memory_recall", async (span) => {
      // Recall pagination rides the query string (the server reads `?cursor=&limit=`), not
      // the body. The seal covers the complete snapshot regardless of the page.
      const qs = new URLSearchParams();
      if (page.cursor !== undefined) qs.set("cursor", page.cursor);
      if (page.limit !== undefined) qs.set("limit", String(page.limit));
      const query = qs.toString();
      const path = query ? `memory/recall?${query}` : "memory/recall";
      const wire = await this.http.postRaw<{
        data: MemoryRecord[];
        has_more: boolean;
        next_cursor: string | null;
        validAt: string;
        txAt: string;
        seal: SnapshotPage["seal"];
      }>(path, req, {}, span);
      return {
        data: wire.data,
        hasMore: wire.has_more,
        nextCursor: wire.next_cursor,
        validAt: wire.validAt,
        txAt: wire.txAt,
        seal: wire.seal,
      };
    });
  }

  memoryAssemble(req: AssembleRequest): Promise<AssembledContext> {
    return this.traced("memory_assemble", (span) =>
      this.http.postRaw<AssembledContext>("memory/assemble", req, {}, span),
    );
  }

  memoryVerify(artifact: unknown): Promise<MemoryVerification> {
    return this.traced("memory_verify", (span) =>
      this.http.postRaw<MemoryVerification>("memory/verify", { artifact }, {}, span),
    );
  }
}

/**
 * Construct an embeddable GeneralLiquidity client bound to a server + operator signer.
 *
 * The returned client carries the commerce tier as well as the canonical surface. Commerce
 * stays off `GeneralLiquidity` itself because it is opt-in per deployment; calling `quote` or
 * `buy` against a stack that did not enable it returns a `not_found` problem.
 */
export function createClient(cfg: ClientConfig): GeneralLiquidity & Commerce {
  return new GlClient(cfg);
}
