// The deterministic signed-bytes format the operator's Signer signs over, plus the one
// narrow decode the wire still needs.
//
// There is deliberately no outbound casing pass. Field names are camelCase on the wire,
// the same spelling these TypeScript types carry and the same spelling the server
// validates, so a request body is serialized exactly as the caller built it. A
// camelCase -> snake_case rewrite used to live in this file. It renamed every field out
// from under the server, which refused the request as missing a field that had in fact
// been supplied, and it made the signed preimage disagree with the bytes on the wire, so
// no signature this SDK sent could verify.
//
// SEAM: `canonicalBytes` must stay byte-identical with the server's verifier. It is a
// local stable-key JSON serializer with the contract the spec fixes: deterministic,
// sorted keys, UTF-8. Kept in sync via the general-liquidity-openapi spec.

type Json = unknown;

const isPlainObject = (v: Json): v is Record<string, Json> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The complete set of snake_case names the server still emits, and their camelCase
 * spelling here. Three OUTBOUND-ONLY envelopes predate the camelCase rule: `Page`
 * (`has_more`, `next_cursor`), `Job` (`created_at`, `terminal_at`) and `WebhookEvent`
 * (`created_at`). No request body carries any of them, which is why this map is applied
 * to responses only.
 *
 * This is an allowlist, not a rule: a name absent from it is passed through untouched, so
 * the list can only shrink as the server is corrected. Adding to it is a claim about what
 * the server emits and needs the same evidence.
 */
const SNAKE_CASE_LEGACY: Record<string, string> = {
  has_more: "hasMore",
  next_cursor: "nextCursor",
  created_at: "createdAt",
  terminal_at: "terminalAt",
};

// Fields the OpenAPI spec declares `additionalProperties: true` are opaque passthrough
// blobs (a Disclosure `document`, a Mandate/Counterparty `constraints`/`trust`, an
// AuditEvent `payload`). Their inner keys are caller/server-authored data, never GL's
// vocabulary, so they pass verbatim. A webhook event's `data` is the same kind of blob and
// keeps its `audit_seq`/`audit_hash`/`audit_type` chain coordinates as emitted.
const OPAQUE_FIELDS = new Set(["document", "constraints", "trust", "payload"]);

/** Response decode: rename ONLY the legacy envelope keys above, recursively. */
export function fromWire(value: Json): Json {
  if (Array.isArray(value)) return value.map(fromWire);
  if (isPlainObject(value)) {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(value)) {
      out[SNAKE_CASE_LEGACY[k] ?? k] = OPAQUE_FIELDS.has(k) ? v : fromWire(v);
    }
    return out;
  }
  return value;
}

/** Deterministic JSON with sorted keys, stable across engines. */
function stableStringify(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isPlainObject(value)) {
    const body = Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(",");
    return `{${body}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The bytes the Signer signs over. Deterministic; independent of key order. */
export function canonicalBytes(value: Json): Uint8Array {
  return new TextEncoder().encode(stableStringify(value));
}
