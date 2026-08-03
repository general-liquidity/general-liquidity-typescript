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

The canonical surface has four operations: `resolve`, `pay`, `verify`, and `disclose`.
Typed failures (`InsufficientFundsError`, `MandateExceededError`, `DeniedError`,
`RateLimitError`, and friends) let agents branch deterministically on the problem type
rather than on prose.

The client also carries the read-back group (`getJob`, `getJobEvents`, `getAudit`,
`getUsage`), the memory group (`memoryRemember`, `memoryRecall`, `memoryAssemble`,
`memoryVerify`), and the commerce tier below. Operator authority rides a separate client
with its own credential — see [Read surface and webhooks](#read-surface-and-webhooks).

## Commerce

`quote` prices a cart against a merchant and commits nothing. `buy` drives that checkout
to a completed `Order`, authorizing it through the same gate `pay` uses.

```ts
const cart = await client.quote({
  rail: "acp",                       // checkout protocols only: acp | ucp
  merchant: "shop.example",
  currency: "USD",
  lines: [{ id: "sku-1", quantity: 2 }],
});

if (cart.status === "ready") {
  const order = await client.buy({
    idempotencyKey: crypto.randomUUID(),
    rail: "acp",
    merchant: "shop.example",
    currency: "USD",
    lines: [{ id: "sku-1", quantity: 2 }],
    purpose: "office-supplies",
    terms,
    envelope,
  });
  console.log(order.id, order.receipt.enforcement);
}
```

Four things differ from `pay` and each is deliberate:

- **No amount.** The price is the merchant's, read from the server-authoritative cart, so
  the request carries lines instead. A caller cannot name its own price.
- **The replay key is yours to choose.** It rides the body, namespaced apart from `pay`'s,
  and is required rather than minted when blank — only a caller that chose its own key can
  safely re-send after a `503 rail.unavailable`, the one outcome the server does not store.
- **No parked-intent path.** A merchant session cannot be held open across an out-of-band
  operator approval, so a gate `confirm` arrives as `DeniedError`, not
  `ApprovalPendingError`. There is nothing for `/operator/approve` to release.
- **Only `ready` carts can be bought.** Every other `CartStatus` is the refusal reporting
  what the checkout still needs.

Commerce is typed as its own `Commerce` interface rather than as methods on
`GeneralLiquidity`. The canonical surface is what every deployment answers; the commerce
tier is opt-in per stack, and one that did not enable it returns a `not_found` problem on
both paths. `createClient` returns `GeneralLiquidity & Commerce`, so callers see no seam.

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
OpenAPI spec and are kept in sync via that spec (general-liquidity-openapi). Field names
are camelCase here AND on the wire: nothing is renamed at the HTTP boundary, so the body
the server validates is the body you built, and the canonical bytes the signer signs are
the bytes that arrive.

Three outbound-only envelopes predate that rule and are still served snake_case: `Page`
(`has_more`, `next_cursor`), `Job` (`created_at`, `terminal_at`) and `WebhookEvent`
(`created_at`). Those four names, and only those, are renamed on the way in. No request
body carries any of them.

## Read surface and webhooks

Beyond the four core verbs and the commerce tier, the agent client exposes read projections
over the signed audit trail: `getJob(id)` reads the async job resource for one intent (`GET /intents/{id}`),
`getJobEvents(id, { cursor, limit })` and `getAudit({ cursor, limit })` page the signed
events, and `getUsage({ since, until, tags })` reads metered call counts. The `Page` and
`Job` envelopes they return are the two shapes still served snake_case, renamed on the way
in as described above.

Webhook endpoint management (`POST/GET/PATCH/DELETE /webhooks/endpoints`) is OPERATOR
authority, so it rides the `OperatorClient`, not the agent key: `createWebhookEndpoint`,
`listWebhookEndpoints`, `getWebhookEndpoint`, `updateWebhookEndpoint`,
`deleteWebhookEndpoint`. Create returns the `whsec_` secret once. Each call is signed with
the same `GL-Operator` scheme as approve/refund, bound to a distinct `webhook:<method>`
operation so a webhook credential cannot be replayed onto the settle path.

The SSE audit feed (`GET /audit/stream`, `text/event-stream`, `Last-Event-ID` resume) is
available on the server but has no SDK wrapper yet: this client has no streaming transport,
so consume it with a standard `EventSource` / fetch-stream reader against the same base URL.

## Development

```sh
bun install
bunx tsc --noEmit -p tsconfig.json
bun test
bunx biome check .
```

## License

MIT
