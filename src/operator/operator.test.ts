import { describe, expect, test } from "bun:test";
import { stubFetch } from "../testing/testkit.ts";
import type { FetchLike } from "../types.ts";
import { createOperatorClient, type OperatorClient, signOperatorRequest } from "./client.ts";
import { operatorBodyDigest, operatorSigningInput } from "./credential.ts";
import { operatorSignerFromSeed } from "./signer.ts";

// The fixed vector shared byte-for-byte with the platform conformance test
// (packages/server/src/operator/operatorClientConformance.test.ts). ed25519 is
// deterministic (RFC 8032), so a fixed seed + fixed request yields a fixed signature; a
// drift on either side of the wire fails one of the two tests.
const SEED_HEX = "11".repeat(32);
const KEY_ID = "ops-1";
const TS_MILLIS = 1_760_000_000_000;
const TS_SECONDS = 1_760_000_000;
const NONCE = "fixed-nonce-01";
const BASE_URL = "https://gl.example";
const REFUND_URL = "https://gl.example/operator/refund";
const REFUND_BODY = JSON.stringify({
  intentId: "intent-abc",
  amountMinor: 500,
  rationale: "duplicate charge refunded to customer",
});
const FIXED_SIGNATURE =
  "zOxNLrL5Z5op9wT75p4rdbbxoJa6weXIcrBNLgHXCgVZkVJzY4C3F0Cn_MMNpih9gugEI85Po5F4V5vC45ZXCg";
const FIXED_HEADER = `v1 keyId="ops-1", ts=${TS_SECONDS}, nonce="${NONCE}", sig="${FIXED_SIGNATURE}"`;

describe("operator signer + credential recipe", () => {
  test("a fixed seed and request produce the known, stable signature", async () => {
    const signer = await operatorSignerFromSeed(KEY_ID, SEED_HEX);
    const header = await signOperatorRequest({
      signer,
      operation: "refund",
      method: "POST",
      url: REFUND_URL,
      body: REFUND_BODY,
      ts: TS_SECONDS,
      nonce: NONCE,
    });
    // Any change to the signing recipe, the seed handling, or the base64url encoding
    // moves this value and fails the test.
    expect(header).toBe(FIXED_HEADER);
  });

  test("the body digest matches the server's base64url SHA-256", async () => {
    // Node computes this as Buffer.from(sha256).toString("base64url"); the SDK computes
    // it from btoa. They must agree, or the digest bound into the signature diverges.
    expect(await operatorBodyDigest(REFUND_BODY)).toBe(
      "PgIIvL6tCWyuTy2Dg_TWS9s2GnZtYI3Fbwn6OxYkymU",
    );
    expect(await operatorBodyDigest("")).toBe("47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU");
  });

  test("the signing input is the exact newline-joined preimage", async () => {
    const input = operatorSigningInput({
      operation: "refund",
      method: "post",
      url: "https://gl.example/operator/refund?ignored=1#frag",
      ts: TS_SECONDS,
      nonce: NONCE,
      bodyDigest: "DIGEST",
    });
    expect(input).toBe(
      [
        "GL-OPERATOR-v1",
        "refund",
        "POST",
        "https://gl.example/operator/refund",
        String(TS_SECONDS),
        NONCE,
        "DIGEST",
      ].join("\n"),
    );
  });
});

function fixedClient(fetch: FetchLike): OperatorClient {
  return createOperatorClient({
    baseUrl: BASE_URL,
    // operatorSignerFromSeed is async; the caller awaits it before this in each test.
    signer: signerRef,
    fetch,
    now: () => TS_MILLIS,
    newNonce: () => NONCE,
  });
}

// Bound once for the client tests below.
const signerRef = await operatorSignerFromSeed(KEY_ID, SEED_HEX);

describe("OperatorClient", () => {
  test("refund sends the exact signed body and the GL-Operator header", async () => {
    const stub = stubFetch([{ status: 200, body: { ok: true, refundedMinor: 500 } }]);
    const client = fixedClient(stub.fetch);

    const result = await client.refund({
      intentId: "intent-abc",
      amountMinor: 500,
      rationale: "duplicate charge refunded to customer",
    });
    expect(result).toEqual({ ok: true, refundedMinor: 500 });

    const call = stub.calls[0];
    expect(call?.url).toBe(REFUND_URL);
    expect(call?.init?.method).toBe("POST");
    // The body is byte-identical to what was digested and signed.
    expect(call?.init?.body).toBe(REFUND_BODY);
    const headers = new Headers(call?.init?.headers);
    expect(headers.get("gl-operator")).toBe(FIXED_HEADER);
    // The agent bearer token is never set by this client.
    expect(headers.get("authorization")).toBeNull();
  });

  test("approve carries intentId, challenge, mandateId, rationale and acknowledged", async () => {
    const receipt = {
      intentKey: "intent-abc",
      rail: "mpp",
      reference: "psp-ref-1",
      settledAt: "2026-07-22T00:00:00Z",
      enforcement: "hash-abc",
    };
    const stub = stubFetch([{ status: 200, body: receipt }]);
    const client = fixedClient(stub.fetch);

    const out = await client.approve({
      intentId: "intent-abc",
      challenge: "chal-1",
      mandateId: "m-1",
      rationale: "operator released after review",
      acknowledged: true,
    });
    expect(out).toMatchObject({ reference: "psp-ref-1" });

    const sent = JSON.parse(String(stub.calls[0]?.init?.body));
    expect(sent).toEqual({
      intentId: "intent-abc",
      challenge: "chal-1",
      mandateId: "m-1",
      rationale: "operator released after review",
      acknowledged: true,
    });
  });

  test("memoryForget sends {mandate, rootId} on the operator credential and returns the proof", async () => {
    const proof = { erased: ["mem-root", "mem-child"], proof: { hash: "h", signature: "s" } };
    const stub = stubFetch([{ status: 200, body: proof }]);
    const client = fixedClient(stub.fetch);

    const out = await client.memoryForget({
      mandate: { namespace: "ns", canRead: true, canWrite: true, canErase: true },
      rootId: "mem-root",
    });
    expect(out).toEqual(proof);

    const call = stub.calls[0];
    expect(call?.url).toBe("https://gl.example/memory/forget");
    expect(call?.init?.method).toBe("POST");
    // The memory body is sent verbatim (camelCase wire) — no snake_case mapping.
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      mandate: { namespace: "ns", canRead: true, canWrite: true, canErase: true },
      rootId: "mem-root",
    });
    const headers = new Headers(call?.init?.headers);
    // Operator authority, not the agent bearer token.
    expect(headers.get("gl-operator")).not.toBeNull();
    expect(headers.get("authorization")).toBeNull();
  });

  test("memoryForget signs over the memory:forget operation, distinct from refund", async () => {
    // A credential minted for memory:forget must not match one minted for refund on the same
    // body/ts/nonce — the operation is bound into the signing input.
    const body = JSON.stringify({
      mandate: { namespace: "ns", canRead: true, canWrite: true, canErase: true },
      rootId: "mem-root",
    });
    const forgetHeader = await signOperatorRequest({
      signer: signerRef,
      operation: "memory:forget",
      method: "POST",
      url: "https://gl.example/memory/forget",
      body,
      ts: TS_SECONDS,
      nonce: NONCE,
    });
    const refundHeader = await signOperatorRequest({
      signer: signerRef,
      operation: "refund",
      method: "POST",
      url: "https://gl.example/memory/forget",
      body,
      ts: TS_SECONDS,
      nonce: NONCE,
    });
    expect(forgetHeader).not.toBe(refundHeader);
  });

  test("a 202 approval.pending surfaces as a typed error, not a Receipt", async () => {
    const stub = stubFetch([
      {
        status: 202,
        body: {
          type: "https://docs.generalliquidity.com/problems/approval.pending",
          code: "approval.pending",
          title: "Intent parked pending operator approval",
          status: 202,
          reasons: ["Confirm you recognise the payee."],
          approval: { intentId: "intent-abc", challenge: "chal-1", mandateId: "m-1" },
        },
      },
    ]);
    const client = fixedClient(stub.fetch);

    await expect(
      client.approve({
        intentId: "intent-abc",
        challenge: "chal-1",
        mandateId: "m-1",
        rationale: "operator released after review",
        acknowledged: false,
      }),
    ).rejects.toMatchObject({ status: 202, type: "approval.pending" });
  });

  test("a 401 operator.unauthorized throws with the status preserved", async () => {
    const stub = stubFetch([
      {
        status: 401,
        body: {
          type: "https://docs.generalliquidity.com/problems/operator.unauthorized",
          code: "operator.unauthorized",
          title: "Operator authority required",
          status: 401,
        },
      },
    ]);
    const client = fixedClient(stub.fetch);
    await expect(
      client.refund({ intentId: "x", rationale: "reversing a mistaken charge" }),
    ).rejects.toMatchObject({
      status: 401,
    });
  });

  test("the kill switch signs engage and disengage as distinct operations", async () => {
    const engageStub = stubFetch([
      { status: 200, body: { killSwitchEngaged: true, circuitBreakerOpen: false } },
    ]);
    const engaged = await fixedClient(engageStub.fetch).engageKillSwitch(
      "halting settle during incident",
    );
    expect(engaged).toEqual({ killSwitchEngaged: true, circuitBreakerOpen: false });
    expect(JSON.parse(String(engageStub.calls[0]?.init?.body))).toEqual({
      engaged: true,
      rationale: "halting settle during incident",
    });

    const releaseStub = stubFetch([
      { status: 200, body: { killSwitchEngaged: false, circuitBreakerOpen: false } },
    ]);
    await fixedClient(releaseStub.fetch).disengageKillSwitch("incident resolved, resuming settle");
    expect(JSON.parse(String(releaseStub.calls[0]?.init?.body))).toEqual({
      engaged: false,
      rationale: "incident resolved, resuming settle",
    });
    // The two directions carry different signatures because the operation differs.
    const engageHeader = new Headers(engageStub.calls[0]?.init?.headers).get("gl-operator");
    const releaseHeader = new Headers(releaseStub.calls[0]?.init?.headers).get("gl-operator");
    expect(engageHeader).not.toBe(releaseHeader);
  });

  test("resetCircuitBreaker posts to the breaker route", async () => {
    const stub = stubFetch([
      { status: 200, body: { killSwitchEngaged: false, circuitBreakerOpen: false } },
    ]);
    const state = await fixedClient(stub.fetch).resetCircuitBreaker(
      "clearing breaker after venue recovered",
    );
    expect(state).toEqual({ killSwitchEngaged: false, circuitBreakerOpen: false });
    expect(stub.calls[0]?.url).toBe("https://gl.example/operator/circuit-breaker/reset");
  });
});

describe("OperatorClient webhook CRUD", () => {
  const CREATED = {
    id: "wh-1",
    url: "https://sink.example/hook",
    events: ["payment.settled"],
    active: true,
    secret: "whsec_abc123",
  };

  test("createWebhookEndpoint POSTs the endpoint under a webhook:post credential", async () => {
    const stub = stubFetch([{ status: 201, body: CREATED }]);
    const created = await fixedClient(stub.fetch).createWebhookEndpoint({
      url: "https://sink.example/hook",
      events: ["payment.settled"],
    });
    expect(created.secret).toBe("whsec_abc123");
    const call = stub.calls[0];
    expect(call?.url).toBe("https://gl.example/webhooks/endpoints");
    expect(call?.init?.method).toBe("POST");
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      url: "https://sink.example/hook",
      events: ["payment.settled"],
    });
    // Operator credential is present; the agent bearer token is never set.
    const headers = new Headers(call?.init?.headers);
    expect(headers.get("gl-operator")).toBeTruthy();
    expect(headers.get("authorization")).toBeNull();

    // The signature binds the webhook:post operation over the exact sent body.
    const expected = await signOperatorRequest({
      signer: signerRef,
      operation: "webhook:post",
      method: "POST",
      url: "https://gl.example/webhooks/endpoints",
      body: String(call?.init?.body),
      ts: TS_SECONDS,
      nonce: NONCE,
    });
    expect(headers.get("gl-operator")).toBe(expected);
  });

  test("listWebhookEndpoints GETs with no body, digesting the empty string", async () => {
    const stub = stubFetch([{ status: 200, body: { data: [CREATED] } }]);
    const out = await fixedClient(stub.fetch).listWebhookEndpoints();
    expect(out.data[0]?.id).toBe("wh-1");
    const call = stub.calls[0];
    expect(call?.init?.method).toBe("GET");
    expect(call?.init?.body).toBeUndefined();
    const expected = await signOperatorRequest({
      signer: signerRef,
      operation: "webhook:get",
      method: "GET",
      url: "https://gl.example/webhooks/endpoints",
      body: "",
      ts: TS_SECONDS,
      nonce: NONCE,
    });
    expect(new Headers(call?.init?.headers).get("gl-operator")).toBe(expected);
  });

  test("updateWebhookEndpoint PATCHes only the named fields", async () => {
    const stub = stubFetch([{ status: 200, body: { ...CREATED, active: false } }]);
    const out = await fixedClient(stub.fetch).updateWebhookEndpoint("wh-1", { active: false });
    expect(out.active).toBe(false);
    const call = stub.calls[0];
    expect(call?.url).toBe("https://gl.example/webhooks/endpoints/wh-1");
    expect(call?.init?.method).toBe("PATCH");
    expect(JSON.parse(String(call?.init?.body))).toEqual({ active: false });
  });

  test("deleteWebhookEndpoint returns on a 204 with no body", async () => {
    const stub = stubFetch([{ status: 204 }]);
    await expect(fixedClient(stub.fetch).deleteWebhookEndpoint("wh-1")).resolves.toBeUndefined();
    const call = stub.calls[0];
    expect(call?.init?.method).toBe("DELETE");
    expect(call?.url).toBe("https://gl.example/webhooks/endpoints/wh-1");
  });

  test("a 401 on the webhook surface throws with the status preserved", async () => {
    const stub = stubFetch([
      {
        status: 401,
        body: {
          type: "https://docs.generalliquidity.com/problems/operator.unauthorized",
          title: "Operator authority required",
          status: 401,
        },
      },
    ]);
    await expect(fixedClient(stub.fetch).getWebhookEndpoint("wh-1")).rejects.toMatchObject({
      status: 401,
    });
  });
});
