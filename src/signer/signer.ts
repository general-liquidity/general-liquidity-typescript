import { canonicalBytes } from "../internal/canonical.ts";
import type { Envelope, Intent } from "../types.ts";

/**
 * An operator-held signer. Keys NEVER leave the operator's process — the SDK only
 * ever calls `sign(bytes)` and receives a detached signature. This is the settle-line
 * split at the SDK boundary: the SDK signs, it never settles.
 */
export interface Signer {
  /** The signing key's agent id (ed25519 public key / CAIP-addressed identity). */
  readonly agentId?: string;
  /** Sign canonical bytes, returning a signature string (base64 / hex, signer's choice). */
  sign(bytes: Uint8Array): string | Promise<string>;
}

/**
 * Sign an Intent's envelope in place-free fashion: canonicalize the intent with an
 * empty envelope signature, sign it, and return a new Intent carrying the signature.
 * The signed-over bytes exclude only the envelope signature so a verifier can recompute.
 */
export async function signIntent(intent: Intent, signer: Signer): Promise<Intent> {
  const unsignedEnvelope: Envelope = { ...intent.envelope, signature: "" };
  const preimage = { ...intent, envelope: unsignedEnvelope };
  const signature = await signer.sign(canonicalBytes(preimage));
  const identity = signer.agentId ?? intent.envelope.identity;
  return { ...intent, envelope: { ...intent.envelope, identity, signature } };
}
