import type { Span } from "../tracing/tracer.ts";
import type { FetchLike } from "../types.ts";
import { fromWire, toWire } from "./canonical.ts";
import { errorFromProblem, type GlError, type Problem, ServerError } from "./errors.ts";

export interface RetryPolicy {
  /** Max retry attempts after the first try. */
  maxRetries: number;
  /** Base delay in ms for exponential backoff. */
  baseMs: number;
  /** Cap on any single backoff delay in ms. */
  maxMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { maxRetries: 3, baseMs: 200, maxMs: 20_000 };

export interface HttpConfig {
  baseUrl: string;
  fetch: FetchLike;
  retry: RetryPolicy;
  /** Injectable for deterministic tests; defaults to timer + Math.random. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Parse a Retry-After header (delta-seconds or HTTP-date) into ms, if present. */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(header);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return undefined;
}

function backoffMs(attempt: number, policy: RetryPolicy, rand: () => number): number {
  const exp = Math.min(policy.maxMs, policy.baseMs * 2 ** attempt);
  // Full jitter: uniform in [0, exp]. Avoids retry stampedes.
  return Math.floor(rand() * exp);
}

async function readProblem(res: Response): Promise<Problem> {
  try {
    const body = (await res.json()) as unknown;
    if (body && typeof body === "object") return fromWire(body) as Problem;
  } catch {
    // fall through to a synthetic problem
  }
  return { status: res.status, title: res.statusText || `HTTP ${res.status}` };
}

export class Http {
  constructor(private readonly cfg: HttpConfig) {}

  /**
   * POST a camelCase body as snake_case JSON; return a camelCase-decoded response.
   * When a `span` is supplied the request carries its W3C `traceparent` so the server
   * joins the same trace, and the number of retries spent lands on the span as
   * `gl.retries` (BUILD-PLAN §5).
   */
  async post<T>(
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
    span?: Span,
  ): Promise<T> {
    const url = new URL(path, this.cfg.baseUrl).toString();
    const payload = JSON.stringify(toWire(body));
    return this.execute<T>(
      "POST",
      url,
      { "content-type": "application/json", ...headers },
      payload,
      span,
    );
  }

  /**
   * POST a body verbatim (no camelCase↔snake_case mapping) and decode the response verbatim.
   * The memory group uses this: its wire fields are already camelCase and a MemoryRecord
   * `body` is an arbitrary caller payload that must not be key-mapped. Success is 200 only,
   * so a `202 memory.pending` falls through to the typed-error path instead of decoding as a
   * record. Retry/backoff on 429/5xx is unchanged.
   */
  async postRaw<T>(
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
    span?: Span,
  ): Promise<T> {
    const url = new URL(path, this.cfg.baseUrl).toString();
    const payload = JSON.stringify(body);
    return this.execute<T>(
      "POST",
      url,
      { "content-type": "application/json", ...headers },
      payload,
      span,
      true,
    );
  }

  /**
   * GET a read surface, decoding the snake_case response to camelCase. Query values are
   * appended in order; arrays repeat the key (the spec's repeatable `tags`). Shares the
   * same retry/backoff and typed-error path as POST.
   */
  async get<T>(
    path: string,
    query: Record<string, string | number | string[] | undefined> = {},
    span?: Span,
  ): Promise<T> {
    const url = new URL(path, this.cfg.baseUrl);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, item);
      else url.searchParams.set(key, String(value));
    }
    return this.execute<T>("GET", url.toString(), {}, undefined, span);
  }

  private async execute<T>(
    method: string,
    url: string,
    headers: Record<string, string>,
    payload: string | undefined,
    span?: Span,
    raw = false,
  ): Promise<T> {
    const sleep = this.cfg.sleep ?? defaultSleep;
    const rand = this.cfg.random ?? Math.random;

    // One logical request = one span, so the traceparent is stable across retries; the
    // retry count is what distinguishes the attempts.
    const traceparent = span?.traceparent();
    const traced: Record<string, string> = traceparent ? { traceparent } : {};

    let lastError: GlError | undefined;
    for (let attempt = 0; attempt <= this.cfg.retry.maxRetries; attempt++) {
      // `attempt` is 0 on the first try, so it equals the retries spent so far.
      span?.setAttribute("gl.retries", attempt);
      let res: Response;
      try {
        res = await this.cfg.fetch(url, {
          method,
          headers: {
            accept: "application/json",
            ...traced,
            ...headers,
          },
          ...(payload !== undefined ? { body: payload } : {}),
        });
      } catch (cause) {
        // Network failure — retryable transport error.
        lastError = new ServerError({
          type: "network",
          status: 0,
          message: cause instanceof Error ? cause.message : "network error",
        });
        if (attempt < this.cfg.retry.maxRetries) {
          await sleep(backoffMs(attempt, this.cfg.retry, rand));
          continue;
        }
        throw lastError;
      }

      span?.setAttribute("gl.http.status", res.status);

      // Raw memory calls succeed on 200 alone: a 202 (memory.pending) is a parked write and
      // routes through the typed-error path so the caller cannot mistake it for a record.
      if (raw ? res.status === 200 : res.ok) {
        if (!raw && res.status === 204) return undefined as T;
        const body = (await res.json()) as unknown;
        return (raw ? body : fromWire(body)) as T;
      }

      const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
      const problem = await readProblem(res);
      const err = errorFromProblem(problem, res.status, retryAfterMs);

      if (err.retryable && attempt < this.cfg.retry.maxRetries) {
        lastError = err;
        const wait = err.retryAfterMs ?? backoffMs(attempt, this.cfg.retry, rand);
        await sleep(wait);
        continue;
      }
      throw err;
    }
    // Exhausted retries.
    throw (
      lastError ?? new ServerError({ type: "exhausted", status: 0, message: "retries exhausted" })
    );
  }
}
