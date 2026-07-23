import { describe, expect, test } from "bun:test";
import { createClient } from "../client.ts";
import { DeniedError } from "../internal/errors.ts";
import { fakeTracer, makeIntent, stubFetch, stubSigner } from "../testing/testkit.ts";
import { loadOtelTracer, type OtelApi, otelTracer } from "./otel.ts";
import { noopTracer } from "./tracer.ts";

const W3C_TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

/** A minimal @opentelemetry/api-shaped span, enough for the adapter to drive. */
const otelSpanStub = () => ({
  setAttribute: () => {},
  recordException: () => {},
  setStatus: () => {},
  spanContext: () => ({
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "00f067aa0ba902b7",
    traceFlags: 1,
  }),
  end: () => {},
});

describe("tracing on the surface ops", () => {
  test("pay emits a span carrying traceparent + idempotency-key attributes", async () => {
    const tracer = fakeTracer();
    const net = stubFetch([{ body: { intent_key: "k1" } }]);
    const client = createClient({
      baseUrl: "https://gl.example/",
      signer: stubSigner(),
      fetch: net.fetch,
      newIdempotencyKey: () => "gen-key",
      tracer,
    });

    await client.pay(makeIntent());

    expect(tracer.spans.length).toBe(1);
    const span = tracer.spans[0]!;
    expect(span.name).toBe("gl.pay");
    expect(span.attributes["gl.op"]).toBe("pay");
    expect(span.attributes["gl.idempotency_key"]).toBe("gen-key");
    expect(span.attributes["gl.retries"]).toBe(0);
    expect(span.attributes["gl.http.status"]).toBe(200);
    expect(span.errored).toBe(false);
    expect(span.ended).toBe(true);

    // The span's traceparent went out on the wire so the server joins the trace.
    const headers = net.calls[0]!.init!.headers as Record<string, string>;
    expect(span.traceparent).toMatch(W3C_TRACEPARENT);
    expect(headers.traceparent).toBe(span.traceparent);
    expect(headers["idempotency-key"]).toBe("gen-key");
  });

  test("records the retries spent and keeps one traceparent across attempts", async () => {
    const tracer = fakeTracer();
    const net = stubFetch([
      { status: 500, body: { type: "server" } },
      { status: 500, body: { type: "server" } },
      { body: { intent_key: "k1" } },
    ]);
    const client = createClient({
      baseUrl: "https://gl.example/",
      signer: stubSigner(),
      fetch: net.fetch,
      retry: { maxRetries: 3, baseMs: 0, maxMs: 0 },
      tracer,
    });

    await client.pay(makeIntent({ idempotencyKey: "k" }));

    expect(net.calls.length).toBe(3);
    expect(tracer.spans[0]!.attributes["gl.retries"]).toBe(2);
    // One logical request = one span, so every attempt shares the traceparent.
    const sent = net.calls.map((c) => (c.init!.headers as Record<string, string>).traceparent);
    expect(new Set(sent).size).toBe(1);
    expect(sent[0]).toBe(tracer.spans[0]!.traceparent);
  });

  test("a typed failure marks the span errored and records the exception", async () => {
    const tracer = fakeTracer();
    const net = stubFetch([{ status: 403, body: { type: "denied", title: "over mandate" } }]);
    const client = createClient({
      baseUrl: "https://gl.example/",
      signer: stubSigner(),
      fetch: net.fetch,
      retry: { maxRetries: 0 },
      tracer,
    });

    await expect(client.pay(makeIntent())).rejects.toBeInstanceOf(DeniedError);

    const span = tracer.spans[0]!;
    expect(span.errored).toBe(true);
    expect(span.ended).toBe(true);
    expect(span.exceptions[0]).toBeInstanceOf(DeniedError);
  });

  test("resolve, verify and disclose each emit their own named span", async () => {
    const tracer = fakeTracer();
    const net = stubFetch([{ body: {} }]);
    const client = createClient({
      baseUrl: "https://gl.example/",
      signer: stubSigner(),
      fetch: net.fetch,
      tracer,
    });

    await client.resolve("did:web:acme.example");
    await client.verify({
      document: {},
      signature: { algorithm: "ed25519", publicKey: "a", value: "s" },
    });
    await client.disclose();

    expect(tracer.spans.map((s) => s.name)).toEqual(["gl.resolve", "gl.verify", "gl.disclose"]);
    expect(tracer.spans.every((s) => s.ended)).toBe(true);
  });
});

describe("noop default", () => {
  test("the client works with no tracer configured and sends no traceparent", async () => {
    const net = stubFetch([{ body: { intent_key: "k1" } }]);
    const client = createClient({
      baseUrl: "https://gl.example/",
      signer: stubSigner(),
      fetch: net.fetch,
    });

    const receipt = await client.pay(makeIntent({ idempotencyKey: "k" }));

    expect(receipt.intentKey).toBe("k1");
    expect((net.calls[0]!.init!.headers as Record<string, string>).traceparent).toBeUndefined();
  });

  test("noopTracer spans are inert and emit no traceparent", () => {
    const span = noopTracer.startSpan("gl.pay", { "gl.op": "pay" });
    expect(span.traceparent()).toBeUndefined();
    // None of these throw or allocate observable state.
    span.setAttribute("k", 1);
    span.recordException(new Error("x"));
    span.setError(new Error("x"));
    span.end();
  });
});

describe("optional OTel adapter", () => {
  test("maps the seam onto an @opentelemetry/api-shaped module", () => {
    const calls: Array<[string, unknown]> = [];
    let status: { code: number; message?: string } | undefined;
    let ended = false;
    const api: OtelApi = {
      trace: {
        getTracer: () => ({
          startSpan: (name, options) => {
            calls.push([name, options?.attributes]);
            return {
              setAttribute: (k, v) => void calls.push([k, v]),
              recordException: (e) => void calls.push(["exception", e]),
              setStatus: (s) => {
                status = s;
              },
              spanContext: () => ({
                traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
                spanId: "00f067aa0ba902b7",
                traceFlags: 1,
              }),
              end: () => {
                ended = true;
              },
            };
          },
        }),
      },
    };

    const span = otelTracer(api).startSpan("gl.pay", { "gl.op": "pay", skipped: undefined });
    span.setAttribute("gl.retries", 2);
    span.setError(new Error("denied"));
    span.end();

    expect(calls[0]).toEqual(["gl.pay", { "gl.op": "pay" }]);
    expect(calls[1]).toEqual(["gl.retries", 2]);
    // W3C traceparent built from the OTel span context, flags hex-padded.
    expect(span.traceparent()).toBe("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
    expect(status).toEqual({ code: 2, message: "denied" });
    expect(ended).toBe(true);
  });

  test("loadOtelTracer degrades to undefined when the module is absent", async () => {
    // @opentelemetry/api is deliberately NOT a dependency, so a resolution failure must
    // degrade to undefined (caller falls back to noopTracer) rather than throw.
    const absent = () => Promise.reject(new Error("Cannot find module"));
    expect(await loadOtelTracer("gl", absent)).toBeUndefined();
    // Present but not tracer-shaped is treated the same way.
    expect(await loadOtelTracer("gl", () => Promise.resolve({}))).toBeUndefined();
  });

  test("loadOtelTracer adapts the module when it IS present", async () => {
    const present = () =>
      Promise.resolve({ trace: { getTracer: () => ({ startSpan: () => otelSpanStub() }) } });
    const tracer = await loadOtelTracer("gl", present);
    expect(tracer).toBeDefined();
    expect(tracer!.startSpan("gl.pay").traceparent()).toMatch(W3C_TRACEPARENT);
  });

  test("the real dynamic import never throws, whatever is installed", async () => {
    // Resolves against the ambient @opentelemetry/api if one is hoisted, undefined if not.
    const tracer = await loadOtelTracer();
    expect(tracer === undefined || typeof tracer.startSpan === "function").toBe(true);
  });
});
