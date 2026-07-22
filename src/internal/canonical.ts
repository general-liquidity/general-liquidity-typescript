// Wire boundary: TypeScript is camelCase, the wire is snake_case (NAMING.md rule 7).
// Also the deterministic signed-bytes format the operator's Signer signs over.
//
// SEAM: `canonicalBytes` must stay byte-identical with the server's verifier. It is a
// local stable-key JSON serializer with the contract the spec fixes: deterministic,
// sorted keys, UTF-8. Kept in sync via the general-liquidity-openapi spec.

type Json = unknown;

const camelToSnake = (k: string): string => k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);

const snakeToCamel = (k: string): string =>
  k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

const isPlainObject = (v: Json): v is Record<string, Json> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// Fields the OpenAPI spec declares `additionalProperties: true` — opaque passthrough
// blobs (a Disclosure `document`, a Mandate/Counterparty `constraints`/`trust`, an
// AuditEvent `payload`). Their inner keys are caller/server-authored data, NOT part of
// GL's camelCase↔snake_case contract, so recursing into them would corrupt content the
// signer signs over (disclose) and free-form trust signals. Their values pass verbatim.
const OPAQUE_FIELDS = new Set(["document", "constraints", "trust", "payload"]);

function mapKeys(value: Json, keyFn: (k: string) => string): Json {
  if (Array.isArray(value)) return value.map((v) => mapKeys(v, keyFn));
  if (isPlainObject(value)) {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(value)) {
      // `document`/`constraints`/`trust`/`payload` are single words — identical in both
      // cases — so matching the source key covers toWire and fromWire alike.
      out[keyFn(k)] = OPAQUE_FIELDS.has(k) ? v : mapKeys(v, keyFn);
    }
    return out;
  }
  return value;
}

/** camelCase object → snake_case wire object (recursive). */
export const toWire = (value: Json): Json => mapKeys(value, camelToSnake);

/** snake_case wire object → camelCase object (recursive). */
export const fromWire = (value: Json): Json => mapKeys(value, snakeToCamel);

/** Deterministic JSON with sorted keys — stable across engines. */
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
