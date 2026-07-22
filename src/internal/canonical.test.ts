import { describe, expect, test } from "bun:test";
import { signIntent } from "../signer/signer.ts";
import { makeIntent, stubSigner } from "../testing/testkit.ts";
import { canonicalBytes, fromWire, toWire } from "./canonical.ts";

describe("wire case conversion", () => {
  test("toWire is snake_case and round-trips via fromWire", () => {
    const camel = { capitalSource: "payer", nested: [{ intentKey: "k" }] };
    const wire = toWire(camel) as Record<string, unknown>;
    expect(wire.capital_source).toBe("payer");
    expect((wire.nested as Array<Record<string, unknown>>)[0]!.intent_key).toBe("k");
    expect(fromWire(wire)).toEqual(camel);
  });

  test("opaque additionalProperties blobs pass through with keys untouched", () => {
    // openapi.yaml marks document/constraints/trust/payload `additionalProperties: true`.
    // Their inner keys are caller/server data, not GL's case contract — converting them
    // would corrupt the bytes the signer signs over in disclose().
    const camel = {
      agentId: "a",
      document: { created_at: "t", nestedKey: { deep_key: 1 } },
      trust: { some_score: 1 },
      constraints: { max_per_day: 2 },
      payload: { event_name: "x" },
    };
    const wire = toWire(camel) as Record<string, unknown>;
    expect(wire.agent_id).toBe("a");
    expect(wire.document).toEqual({ created_at: "t", nestedKey: { deep_key: 1 } });
    expect(wire.trust).toEqual({ some_score: 1 });
    expect(wire.constraints).toEqual({ max_per_day: 2 });
    expect(wire.payload).toEqual({ event_name: "x" });
    expect(fromWire(wire)).toEqual(camel);
  });

  test("canonicalBytes is deterministic and key-order independent", () => {
    const a = canonicalBytes({ b: 1, a: 2 });
    const b = canonicalBytes({ a: 2, b: 1 });
    expect(new TextDecoder().decode(a)).toBe(new TextDecoder().decode(b));
  });
});

describe("signIntent", () => {
  test("signs over the intent with an empty envelope signature preimage", async () => {
    const signer = stubSigner("agent:xyz");
    const signed = await signIntent(makeIntent({ idempotencyKey: "k" }), signer);
    expect(signed.envelope.signature).toBe(`sig:${signer.calls[0]!.length}`);
    expect(signed.envelope.identity).toBe("agent:xyz");

    // preimage must have carried an empty signature (verifier recomputes the same way).
    const preimage = JSON.parse(new TextDecoder().decode(signer.calls[0]!));
    expect(preimage.envelope.signature).toBe("");
  });
});
