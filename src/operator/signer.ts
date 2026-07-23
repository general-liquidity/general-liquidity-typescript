// The operator-held ed25519 signer. Operator authority is a SEPARATE domain from the
// agent's bearer token: this key signs the detached `GL-Operator` credential and the
// server holds only its PUBLIC half. The key stays in the operator's process — the
// client only ever calls `sign(bytes)` and receives a detached signature.
//
// Uses WebCrypto (`crypto.subtle`) — the same primitive the server verifier uses — so
// the SDK adds no crypto dependency.

import { bytesToBase64Url } from "./credential.ts";

/** An operator ed25519 signer. `keyId` names the public key the server has registered. */
export interface OperatorSigner {
  /** The key id the server maps to this signer's public key. Carried in the header. */
  readonly keyId: string;
  /** Detached ed25519 signature over `message`, as unpadded base64url. */
  sign(message: Uint8Array): Promise<string>;
}

// The fixed PKCS8 wrapper for a raw 32-byte ed25519 seed: the DER prefix a WebCrypto
// `importKey("pkcs8", …)` expects, followed by the seed.
const PKCS8_ED25519_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

function seedBytes(seed: string | Uint8Array): Uint8Array {
  if (typeof seed !== "string") {
    if (seed.length !== 32) throw new Error("operator seed must be 32 bytes");
    return seed;
  }
  const hex = seed.startsWith("0x") ? seed.slice(2) : seed;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("operator seed must be a 32-byte ed25519 seed as 64 hex chars");
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Build an operator signer from a 32-byte ed25519 seed (hex, optionally `0x`-prefixed,
 * or raw bytes). The private key is imported once and never leaves this closure.
 */
export async function operatorSignerFromSeed(
  keyId: string,
  seed: string | Uint8Array,
): Promise<OperatorSigner> {
  const pkcs8 = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32);
  pkcs8.set(PKCS8_ED25519_PREFIX, 0);
  pkcs8.set(seedBytes(seed), PKCS8_ED25519_PREFIX.length);

  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);

  return {
    keyId,
    async sign(message: Uint8Array): Promise<string> {
      // Copy into a fresh ArrayBuffer-backed view: WebCrypto's typed signature narrows
      // to Uint8Array<ArrayBuffer>, and a caller's encoder output may be ArrayBufferLike.
      const sig = await crypto.subtle.sign({ name: "Ed25519" }, key, new Uint8Array(message));
      return bytesToBase64Url(new Uint8Array(sig));
    },
  };
}
