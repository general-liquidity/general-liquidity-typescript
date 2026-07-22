import { describe, expect, test } from "bun:test";
import { createClient } from "./client.ts";
import { makeIntent, stubFetch, stubSigner } from "./testing/testkit.ts";

describe("createClient / pay", () => {
  test("signs the intent, auto-generates an idempotency key, and sends snake_case", async () => {
    const signer = stubSigner();
    const receiptWire = {
      intent_key: "k1",
      rail: "x402",
      reference: "0xabc",
      terms: {
        reversibility: "irreversible",
        finality: "instant",
        credential: "eip3009",
        rail: "x402",
        capital_source: "payer",
        presence: "delegated",
      },
      settled_at: "2026-07-22T00:00:00Z",
      enforcement: "hash",
    };
    const net = stubFetch([{ body: receiptWire }]);
    const client = createClient({
      baseUrl: "https://gl.example/v1/",
      signer,
      fetch: net.fetch,
      newIdempotencyKey: () => "gen-key",
    });

    const receipt = await client.pay(makeIntent());

    // camelCase came back to the caller.
    expect(receipt.intentKey).toBe("k1");
    expect(receipt.terms.capitalSource).toBe("payer");

    // signer was invoked (local signing, keys never left the operator).
    expect(signer.calls.length).toBe(1);

    // wire body is snake_case and carries the generated key + signature.
    const sent = JSON.parse(net.calls[0]!.init!.body as string);
    expect(sent.idempotency_key).toBe("gen-key");
    expect(sent.envelope.mandate_id).toBe("mandate:1");
    expect(sent.envelope.signature).toBe("sig:" + signer.calls[0]!.length);
    expect(net.calls[0]!.init!.headers).toMatchObject({ "idempotency-key": "gen-key" });
  });

  test("honors a caller-provided idempotency key", async () => {
    const net = stubFetch([{ body: {} }]);
    const client = createClient({
      baseUrl: "https://gl.example/",
      signer: stubSigner(),
      fetch: net.fetch,
    });
    await client.pay(makeIntent({ idempotencyKey: "caller-key" }));
    const sent = JSON.parse(net.calls[0]!.init!.body as string);
    expect(sent.idempotency_key).toBe("caller-key");
  });

  test("resolve decodes a snake_case Counterparty", async () => {
    const net = stubFetch([
      { body: { id: "cp1", transport: "disclosure", capabilities: ["pay"], rails: ["x402"] } },
    ]);
    const client = createClient({
      baseUrl: "https://gl.example/",
      signer: stubSigner(),
      fetch: net.fetch,
    });
    const cp = await client.resolve("did:web:acme.example");
    expect(cp.id).toBe("cp1");
    expect(JSON.parse(net.calls[0]!.init!.body as string).ref).toBe("did:web:acme.example");
  });
});
