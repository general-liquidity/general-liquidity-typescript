// The operator credential recipe, ported byte-for-byte from the hosted server's
// `packages/server/src/operator/credential.ts`. This is the SEAM the operator verifier
// checks: the signing input, the body digest, and the `GL-Operator` header encoding
// must be reconstructed identically here or every operator call fails auth.
//
// A cross-repo conformance test in the platform repo pins these bytes against the REAL
// `createSignedOperatorVerifier`; the SDK's own fixed-signature test pins them here.
// Canonicalization is not authority: this module signs nothing on its own.

/** The header carrying operator authority. Distinct from `Authorization` on purpose. */
export const OPERATOR_HEADER = "gl-operator";

/** Version tag opening the credential header. */
export const OPERATOR_CREDENTIAL_VERSION = "v1";

/** The first line of every signing input. */
const SIGNING_PREFIX = "GL-OPERATOR-v1";

/** The five operator operations, one per hosted route. Signed over, so a credential
 *  minted for one operation cannot be replayed onto another. */
export type OperatorOperation =
  | "approve"
  | "refund"
  | "kill_switch.engage"
  | "kill_switch.disengage"
  | "circuit_breaker.reset";

/** base64url SHA-256 of the raw request body bytes. An empty body hashes as empty. */
export async function operatorBodyDigest(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return bytesToBase64Url(new Uint8Array(digest));
}

/**
 * The exact bytes an operator signs. Field order is fixed: prefix, operation, upper-case
 * method, canonical URL, timestamp (epoch seconds as a string), nonce, body digest —
 * joined by `\n`. Every field that changes the effect of the request is inside it.
 */
export function operatorSigningInput(input: {
  operation: string;
  method: string;
  url: string;
  ts: number;
  nonce: string;
  bodyDigest: string;
}): string {
  return [
    SIGNING_PREFIX,
    input.operation,
    input.method.toUpperCase(),
    canonicalUrl(input.url),
    String(input.ts),
    input.nonce,
    input.bodyDigest,
  ].join("\n");
}

/** Origin + path. Query and fragment are dropped, mirroring RFC 9449 `htu`. */
export function canonicalUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return url.origin + url.pathname;
  } catch {
    return raw;
  }
}

/** The parsed parts of a `GL-Operator` header value. */
export interface OperatorCredential {
  keyId: string;
  ts: number;
  nonce: string;
  /** base64url detached signature over {@link operatorSigningInput}. */
  signature: string;
}

/** Render a credential as the `GL-Operator` header value. */
export function formatOperatorCredential(credential: OperatorCredential): string {
  return (
    `${OPERATOR_CREDENTIAL_VERSION} keyId="${credential.keyId}", ts=${credential.ts}, ` +
    `nonce="${credential.nonce}", sig="${credential.signature}"`
  );
}

/**
 * Encode raw bytes as unpadded base64url. The runtime `btoa` yields base64; we translate
 * the alphabet and strip padding so the output matches Node's `base64url` byte-for-byte,
 * which is what the server decodes the signature and digest with.
 */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
