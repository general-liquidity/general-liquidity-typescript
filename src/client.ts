import { DEFAULT_RETRY, Http, type RetryPolicy } from "./internal/http.ts";
import { type Signer, signIntent } from "./signer/signer.ts";
import { noopTracer, type Span, type Tracer } from "./tracing/tracer.ts";
import type {
  AuditEvent,
  Counterparty,
  Decision,
  Disclosure,
  FetchLike,
  GeneralLiquidity,
  Intent,
  Job,
  Page,
  PageQuery,
  Receipt,
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
class GlClient implements GeneralLiquidity {
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

  pay(intent: Intent): Promise<Receipt> {
    return this.traced("pay", async (span) => {
      // Auto-generate the idempotency key when the caller left it blank — never let the
      // agent own it silently, but don't force it to mint one either.
      const idempotencyKey = intent.idempotencyKey || this.newKey();
      span.setAttribute("gl.idempotency_key", idempotencyKey);
      const keyed: Intent = { ...intent, idempotencyKey };
      const signed = await signIntent(keyed, this.signer);
      return this.http.post<Receipt>("pay", signed, { "idempotency-key": idempotencyKey }, span);
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
}

/** Construct an embeddable GeneralLiquidity client bound to a server + operator signer. */
export function createClient(cfg: ClientConfig): GeneralLiquidity {
  return new GlClient(cfg);
}
