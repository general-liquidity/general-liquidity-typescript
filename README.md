# @general-liquidity/sdk

The embeddable General Liquidity client. It resolves counterparties, builds and signs
payment intents locally, and submits them to a hosted GL server over HTTP. It never holds
a settle primitive: the SDK signs, the sovereign gate on the server decides and settles.

## Why the split matters

The operator's signing key never enters the SDK. The client only ever calls
`sign(bytes)` on an injected `Signer` and receives a detached signature back. That is the
settle-line split drawn at the SDK boundary: signing authority stays with the operator,
settlement authority stays behind the server's trust boundary. The client submits a
signed intent and the gate returns a `Receipt` on `allow`, a typed error otherwise.

## Install

```sh
bun add @general-liquidity/sdk
# or
npm install @general-liquidity/sdk
```

`@opentelemetry/api` is an optional peer dependency. Install it only if you want
OpenTelemetry spans; the SDK never depends on it directly.

## Usage

```ts
import { createClient, type Signer } from "@general-liquidity/sdk";

// Your key stays in your process. The SDK only asks for a signature.
const signer: Signer = {
  agentId: "agent:my-operator",
  sign(bytes) {
    return mySigningBackend.signDetached(bytes); // string | Promise<string>
  },
};

const gl = createClient({
  baseUrl: "https://gl.example/v1/",
  signer,
});

const receipt = await gl.pay({
  idempotencyKey: "", // left blank, the client mints one and returns it on the receipt
  payee: "caip:eip155:1:0xPayee",
  amount: { value: "1000000", asset: "USDC" },
  purpose: "invoice-42",
  terms: {
    reversibility: "irreversible",
    finality: "instant",
    credential: "eip3009",
    rail: "x402",
    capitalSource: "payer",
    presence: "delegated",
  },
  envelope: {
    identity: "agent:my-operator",
    mandateId: "mandate:1",
    grant: {
      agentId: "agent:my-operator",
      mandateId: "mandate:1",
      expiresAt: "2030-01-01T00:00:00Z",
      signature: "...",
    },
    signature: "",
  },
});

console.log(receipt.intentKey, receipt.enforcement);
```

The surface has four operations: `resolve`, `pay`, `verify`, and `disclose`. Typed
failures (`InsufficientFundsError`, `MandateExceededError`, `DeniedError`,
`RateLimitError`, and friends) let agents branch deterministically on the problem type
rather than on prose.

## The injected Signer seam

`Signer` is the only place keys touch the flow:

```ts
export interface Signer {
  readonly agentId?: string;
  sign(bytes: Uint8Array): string | Promise<string>;
}
```

`signIntent` canonicalizes the intent with an empty envelope signature, hands the bytes
to `sign`, and returns a new intent carrying the signature. A verifier recomputes the
same preimage, so the signed-over bytes stay reproducible on both sides.

## Tracing

Tracing is opt-in and provider-agnostic. The default is a zero-cost `noopTracer`. Pass an
OpenTelemetry tracer when you want spans:

```ts
import { createClient, loadOtelTracer } from "@general-liquidity/sdk";

const tracer = await loadOtelTracer(); // undefined when @opentelemetry/api is absent
const gl = createClient({ baseUrl, signer, tracer });
```

Each surface op emits one span carrying the W3C `traceparent`, the idempotency key, the
retry count, and the HTTP status.

## Wire contract

The noun and value types live in `src/types.ts`. They mirror the General Liquidity
OpenAPI spec and are kept in sync via that spec (general-liquidity-openapi). TypeScript is
camelCase; the wire is snake_case, converted at the HTTP boundary.

## Development

```sh
bun install
bunx tsc --noEmit -p tsconfig.json
bun test
bunx biome check .
```

## License

MIT
