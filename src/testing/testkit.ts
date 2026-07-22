// Test-only helpers: a stub Signer, a scriptable stub fetch, and an Intent fixture.
// Not exported from index — internal to the suite.

import type { Signer } from "../signer/signer.ts";
import type { AttributeValue, Span, SpanAttributes, Tracer } from "../tracing/tracer.ts";
import type { FetchLike, Intent } from "../types.ts";

export interface FakeSpan {
  name: string;
  attributes: Record<string, AttributeValue>;
  traceparent: string;
  exceptions: unknown[];
  errored: boolean;
  ended: boolean;
}

export interface FakeTracer extends Tracer {
  spans: FakeSpan[];
}

/**
 * A Tracer that records every span in memory and hands out deterministic W3C
 * traceparents (`00-<32 hex>-<16 hex>-01`), so a test can assert the exact header the
 * client propagated alongside the attributes it set.
 */
export function fakeTracer(): FakeTracer {
  const spans: FakeSpan[] = [];
  return {
    spans,
    startSpan(name: string, attrs?: SpanAttributes): Span {
      const n = spans.length + 1;
      const record: FakeSpan = {
        name,
        attributes: {},
        traceparent: `00-${String(n).padStart(32, "0")}-${String(n).padStart(16, "0")}-01`,
        exceptions: [],
        errored: false,
        ended: false,
      };
      if (attrs) {
        for (const [k, v] of Object.entries(attrs)) if (v !== undefined) record.attributes[k] = v;
      }
      spans.push(record);
      return {
        setAttribute(key, value) {
          if (value !== undefined) record.attributes[key] = value;
        },
        recordException(error) {
          record.exceptions.push(error);
        },
        setError() {
          record.errored = true;
        },
        traceparent() {
          return record.traceparent;
        },
        end() {
          record.ended = true;
        },
      };
    },
  };
}

export function stubSigner(agentId = "agent:test"): Signer & { calls: Uint8Array[] } {
  const calls: Uint8Array[] = [];
  return {
    agentId,
    calls,
    sign(bytes: Uint8Array): string {
      calls.push(bytes);
      return `sig:${bytes.length}`;
    },
  };
}

export interface StubResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Throw a network error instead of responding. */
  throw?: boolean;
}

export interface StubFetch {
  fetch: FetchLike;
  /** Recorded (url, init) per call. */
  calls: Array<{ url: string; init?: RequestInit }>;
}

/** A fetch that replays a queued script of responses, one per call. */
export function stubFetch(script: StubResponse[]): StubFetch {
  const calls: StubFetch["calls"] = [];
  let i = 0;
  const fetch: FetchLike = async (input, init) => {
    calls.push({ url: String(input), init });
    const spec = script[Math.min(i, script.length - 1)];
    i++;
    if (spec?.throw) throw new Error("network down");
    const status = spec?.status ?? 200;
    const headers = new Headers(spec?.headers ?? {});
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    return new Response(spec?.body === undefined ? "{}" : JSON.stringify(spec.body), {
      status,
      headers,
    });
  };
  return { fetch, calls };
}

export function makeIntent(overrides: Partial<Intent> = {}): Intent {
  return {
    idempotencyKey: "",
    payee: "caip:eip155:1:0xPayee",
    amount: { value: "1000000", asset: "USDC" },
    purpose: "invoice-42",
    terms: {
      reversibility: "irreversible",
      finality: "instant",
      credential: "eip3009",
      rail: "x402",
      capitalSource: "payer",
      presence: "delegated",
    },
    envelope: {
      identity: "agent:test",
      mandateId: "mandate:1",
      grant: {
        agentId: "agent:test",
        mandateId: "mandate:1",
        expiresAt: "2030-01-01T00:00:00Z",
        signature: "g",
      },
      signature: "",
    },
    ...overrides,
  };
}
