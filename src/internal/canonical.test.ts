import { describe, expect, test } from "bun:test";
import { signIntent } from "../signer/signer.ts";
import { makeIntent, stubSigner } from "../testing/testkit.ts";
import { canonicalBytes, fromWire } from "./canonical.ts";

describe("fromWire", () => {
  test("renames only the legacy envelope keys, leaving everything else alone", () => {
    const wire = {
      data: [{ id: "intent-1", created_at: "t", terminal_at: "t2", intentKey: "k" }],
      has_more: true,
      next_cursor: "cur-2",
    };
    expect(fromWire(wire)).toEqual({
      data: [{ id: "intent-1", createdAt: "t", terminalAt: "t2", intentKey: "k" }],
      hasMore: true,
      nextCursor: "cur-2",
    });
  });

  test("an unlisted snake_case name passes through untouched", () => {
    // The allowlist is not a rule. A name the server should never have emitted stays
    // visible rather than being quietly repaired, so the defect surfaces here and not in a
    // caller's undefined field.
    expect(fromWire({ intent_key: "k", settled_at: "t" })).toEqual({
      intent_key: "k",
      settled_at: "t",
    });
  });

  test("opaque additionalProperties blobs pass through with keys untouched", () => {
    // openapi.yaml marks document/constraints/trust/payload `additionalProperties: true`.
    // Their inner keys are caller/server data, never GL's vocabulary, so renaming one would
    // corrupt content the signer signs over in disclose().
    const wire = {
      document: { created_at: "t", nestedKey: { deep_key: 1 } },
      trust: { some_score: 1 },
      constraints: { max_per_day: 2 },
      payload: { created_at: "x" },
    };
    expect(fromWire(wire)).toEqual(wire);
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

  test("the preimage carries the wire's own field names", async () => {
    // The signature is computed over these bytes and verified against the body received, so
    // the preimage spelling IS the wire spelling. A casing pass between the two, which is
    // what this SDK used to do, makes every signature unverifiable.
    const signer = stubSigner();
    await signIntent(makeIntent({ idempotencyKey: "k" }), signer);
    const preimage = JSON.parse(new TextDecoder().decode(signer.calls[0]!));
    expect(preimage.idempotencyKey).toBe("k");
    expect(preimage.terms.capitalSource).toBe("payer");
    expect(preimage.envelope.mandateId).toBe("mandate:1");
    expect(preimage.envelope.grant.expiresAt).toBe("2030-01-01T00:00:00Z");
  });
});
