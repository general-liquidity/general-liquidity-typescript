import { describe, expect, test } from "bun:test";
import { createClient } from "./client.ts";
import { ApprovalPendingError, PendingSettlementError } from "./internal/errors.ts";
import { makeIntent, stubFetch, stubSigner } from "./testing/testkit.ts";

describe("createClient / pay", () => {
  test("signs the intent, auto-generates an idempotency key, and sends camelCase", async () => {
    const signer = stubSigner();
    const receiptWire = {
      intentKey: "k1",
      rail: "x402",
      reference: "0xabc",
      terms: {
        reversibility: "irreversible",
        finality: "instant",
        credential: "eip3009",
        rail: "x402",
        capitalSource: "payer",
        presence: "delegated",
      },
      settledAt: "2026-07-22T00:00:00Z",
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

    // camelCase came back to the caller, unrenamed.
    expect(receipt.intentKey).toBe("k1");
    expect(receipt.terms.capitalSource).toBe("payer");

    // signer was invoked (local signing, keys never left the operator).
    expect(signer.calls.length).toBe(1);

    // The wire body carries the field names the server validates. This is the assertion the
    // old suite got backwards: it pinned `idempotency_key`, which /pay rejects as a missing
    // `idempotencyKey`, so a green suite and a broken client agreed with each other.
    const sent = JSON.parse(net.calls[0]!.init!.body as string);
    expect(sent.idempotencyKey).toBe("gen-key");
    expect(sent.envelope.mandateId).toBe("mandate:1");
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
    expect(sent.idempotencyKey).toBe("caller-key");
  });

  test("a 202 clearing.pending decodes as a typed PendingSettlementError, not a Receipt", async () => {
    const net = stubFetch([
      {
        status: 202,
        body: {
          type: "clearing.pending",
          title: "The bound spend is held pending admissible delivery evidence.",
          status: 202,
          obligationId: "obl-7",
          state: "pending",
          awaiting: "att",
          achievedClass: "wit",
        },
      },
    ]);
    const client = createClient({
      baseUrl: "https://gl.example/",
      signer: stubSigner(),
      fetch: net.fetch,
    });

    const err = await client.pay(makeIntent()).catch((e) => e);
    expect(err).toBeInstanceOf(PendingSettlementError);
    expect(err.type).toBe("clearing.pending");
    expect(err.status).toBe(202);
    // The problem body is camelCase as served, so the typed variant reads it directly.
    const settlement = (err as PendingSettlementError).settlement;
    expect(settlement).toEqual({
      type: "clearing.pending",
      title: "The bound spend is held pending admissible delivery evidence.",
      obligationId: "obl-7",
      state: "pending",
      awaiting: "att",
      achievedClass: "wit",
    });
  });

  test("a 202 approval.pending confirm surfaces as a typed error, not a Receipt", async () => {
    const net = stubFetch([
      {
        status: 202,
        body: {
          type: "approval.pending",
          title: "The intent is parked pending operator approval.",
          status: 202,
        },
      },
    ]);
    const client = createClient({
      baseUrl: "https://gl.example/",
      signer: stubSigner(),
      fetch: net.fetch,
    });

    const err = await client.pay(makeIntent()).catch((e) => e);
    expect(err).toBeInstanceOf(ApprovalPendingError);
    expect(err.type).toBe("approval.pending");
    expect(err.status).toBe(202);
  });

  test("resolve decodes a Counterparty", async () => {
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

describe("the wire the server actually reads", () => {
  // These two hold the client to the server rather than to itself. The suite that shipped
  // before them asserted the SDK's own renaming back to the SDK, so it stayed green while
  // agreeing with nobody: every /pay was refused for a missing `idempotencyKey`, and every
  // signature was unverifiable against the body that arrived.
  //
  // A true end-to-end test, a real server on a real port with a real client pointed at it,
  // lives in the platform repo, which is the only place both halves exist. This repo can
  // only pin the bytes it emits. That is the residual gap, and it is why these assertions
  // read the request body rather than the client's return value.

  /** Every property name in a request body, recursively. */
  function fieldNames(value: unknown, out: string[] = []): string[] {
    if (Array.isArray(value)) for (const item of value) fieldNames(item, out);
    else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        out.push(k);
        fieldNames(v, out);
      }
    }
    return out;
  }

  test("no request body field is snake_case", async () => {
    const net = stubFetch([{ body: {} }]);
    const client = createClient({
      baseUrl: "https://gl.example/",
      signer: stubSigner(),
      fetch: net.fetch,
      newIdempotencyKey: () => "gen-key",
    });
    await client.pay(makeIntent());

    const sent = JSON.parse(net.calls[0]!.init!.body as string);
    const snake = fieldNames(sent).filter((n) => n.includes("_"));
    expect(snake).toEqual([]);
    // Named explicitly, since an empty list also passes when nothing was sent at all.
    expect(fieldNames(sent)).toContain("idempotencyKey");
    expect(fieldNames(sent)).toContain("capitalSource");
    expect(fieldNames(sent)).toContain("mandateId");
    expect(fieldNames(sent)).toContain("expiresAt");
  });

  test("the bytes signed are the bytes sent", async () => {
    const signer = stubSigner();
    const net = stubFetch([{ body: {} }]);
    const client = createClient({
      baseUrl: "https://gl.example/",
      signer,
      fetch: net.fetch,
      newIdempotencyKey: () => "gen-key",
    });
    await client.pay(makeIntent());

    // The verifier recomputes the preimage from the body it received, blanking the envelope
    // signature. If anything renames fields between signing and sending, this diverges and
    // no signature this SDK produces can verify.
    const sent = JSON.parse(net.calls[0]!.init!.body as string);
    const recomputed = { ...sent, envelope: { ...sent.envelope, signature: "" } };
    const signed = JSON.parse(new TextDecoder().decode(signer.calls[0]!));
    expect(recomputed).toEqual(signed);
  });
});

describe("agent read surface", () => {
  test("getJob GETs /intents/{id} and renames the Job envelope's legacy keys", async () => {
    const net = stubFetch([
      {
        body: {
          id: "intent-1",
          status: "settled",
          created_at: "2026-07-24T00:00:00Z",
          terminal_at: "2026-07-24T00:00:05Z",
          outcome: "allow",
          receipt: { intentKey: "intent-1", rail: "x402", reference: "0xabc" },
          links: { self: "/intents/intent-1", events: "/intents/intent-1/events" },
        },
      },
    ]);
    const client = createClient({
      baseUrl: "https://gl.example/v1/",
      signer: stubSigner(),
      fetch: net.fetch,
    });
    const job = await client.getJob("intent-1");
    expect(job.status).toBe("settled");
    expect(job.createdAt).toBe("2026-07-24T00:00:00Z");
    expect(job.terminalAt).toBe("2026-07-24T00:00:05Z");
    expect(job.receipt?.intentKey).toBe("intent-1");
    expect(job.links.events).toBe("/intents/intent-1/events");
    expect(net.calls[0]!.url).toBe("https://gl.example/v1/intents/intent-1");
    expect(net.calls[0]!.init!.method).toBe("GET");
    expect(net.calls[0]!.init!.body).toBeUndefined();
  });

  test("getJobEvents passes cursor + limit as query and decodes a Page", async () => {
    const net = stubFetch([
      {
        body: {
          data: [
            {
              type: "intent.settled",
              at: "2026-07-24T00:00:00Z",
              intentKey: "intent-1",
              payload: {},
            },
          ],
          has_more: true,
          next_cursor: "cur-2",
        },
      },
    ]);
    const client = createClient({
      baseUrl: "https://gl.example/",
      signer: stubSigner(),
      fetch: net.fetch,
    });
    const page = await client.getJobEvents("intent-1", { cursor: "cur-1", limit: 50 });
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe("cur-2");
    expect(page.data[0]!.intentKey).toBe("intent-1");
    const url = new URL(net.calls[0]!.url);
    expect(url.pathname).toBe("/intents/intent-1/events");
    expect(url.searchParams.get("cursor")).toBe("cur-1");
    expect(url.searchParams.get("limit")).toBe("50");
  });

  test("getAudit GETs /audit with pagination and decodes a Page", async () => {
    const net = stubFetch([{ body: { data: [], has_more: false, next_cursor: null } }]);
    const client = createClient({
      baseUrl: "https://gl.example/",
      signer: stubSigner(),
      fetch: net.fetch,
    });
    const page = await client.getAudit({ limit: 20 });
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
    const url = new URL(net.calls[0]!.url);
    expect(url.pathname).toBe("/audit");
    expect(url.searchParams.get("limit")).toBe("20");
    expect(url.searchParams.has("cursor")).toBe(false);
  });

  test("getUsage sends since/until and repeats tags, decoding a UsageSummary", async () => {
    const net = stubFetch([
      {
        body: {
          keyId: "key-1",
          since: "2026-07-01T00:00:00Z",
          until: "2026-07-24T00:00:00Z",
          total: 4,
          byOperation: { pay: 3, resolve: 1 },
          byOutcome: { allow: 3, deny: 1 },
        },
      },
    ]);
    const client = createClient({
      baseUrl: "https://gl.example/",
      signer: stubSigner(),
      fetch: net.fetch,
    });
    const usage = await client.getUsage({
      since: "2026-07-01T00:00:00Z",
      until: "2026-07-24T00:00:00Z",
      tags: ["team:trading", "env:prod"],
    });
    expect(usage.total).toBe(4);
    expect(usage.byOperation.pay).toBe(3);
    const url = new URL(net.calls[0]!.url);
    expect(url.pathname).toBe("/usage");
    expect(url.searchParams.get("since")).toBe("2026-07-01T00:00:00Z");
    expect(url.searchParams.getAll("tags")).toEqual(["team:trading", "env:prod"]);
  });
});

describe("agent memory surface", () => {
  const MANDATE = { namespace: "ns", canRead: true, canWrite: true, canErase: false };

  test("memoryRemember sends the body verbatim (camelCase wire) and decodes the record", async () => {
    const record = {
      id: "mem-1",
      body: { note: "prefers_limit_orders" },
      validFrom: "2026-07-20T00:00:00Z",
      validTo: null,
      recordedAt: "2026-07-23T00:00:00Z",
      invalidatedAt: null,
      edges: [],
      taint: false,
      source: "trade-journal",
    };
    const net = stubFetch([{ body: record }]);
    const client = createClient({
      baseUrl: "https://gl.example/",
      signer: stubSigner(),
      fetch: net.fetch,
    });

    const out = await client.memoryRemember({
      mandate: MANDATE,
      body: { note: "prefers_limit_orders" },
      validFrom: "2026-07-20T00:00:00Z",
      validTo: null,
      source: "trade-journal",
    });
    expect(out.id).toBe("mem-1");
    expect(out.validFrom).toBe("2026-07-20T00:00:00Z");

    // No camelCase->snake_case mapping: the arbitrary `body` payload and camelCase fields
    // (validFrom, canWrite) are sent exactly as given.
    const sent = JSON.parse(net.calls[0]!.init!.body as string);
    expect(sent.validFrom).toBe("2026-07-20T00:00:00Z");
    expect(sent.body).toEqual({ note: "prefers_limit_orders" });
    expect(sent.mandate.canWrite).toBe(true);
    expect(net.calls[0]!.url).toBe("https://gl.example/memory/remember");
  });

  test("a 202 memory.pending surfaces as a typed error, not a MemoryRecord", async () => {
    const net = stubFetch([
      {
        status: 202,
        body: {
          type: "https://docs.generalliquidity.com/problems/memory.pending",
          title: "The memory write is parked pending operator confirmation.",
          status: 202,
        },
      },
    ]);
    const client = createClient({
      baseUrl: "https://gl.example/",
      signer: stubSigner(),
      fetch: net.fetch,
    });
    await expect(
      client.memoryRemember({
        mandate: MANDATE,
        validFrom: "2026-07-20T00:00:00Z",
        validTo: null,
        source: "trade-journal",
      }),
    ).rejects.toMatchObject({ status: 202, type: "memory.pending" });
  });

  test("memoryRecall pages via the query string and maps the snapshot page to camelCase", async () => {
    const net = stubFetch([
      {
        body: {
          data: [
            {
              id: "mem-1",
              body: { k: "v" },
              validFrom: "2026-07-20T00:00:00Z",
              validTo: null,
              recordedAt: "2026-07-23T00:00:00Z",
              invalidatedAt: null,
              edges: [],
              taint: false,
              source: "s",
            },
          ],
          has_more: true,
          next_cursor: "cur-2",
          validAt: "2026-07-22T00:00:00Z",
          txAt: "2026-07-23T00:00:00Z",
          seal: { hash: "h", signature: "sig" },
        },
      },
    ]);
    const client = createClient({
      baseUrl: "https://gl.example/",
      signer: stubSigner(),
      fetch: net.fetch,
    });

    const page = await client.memoryRecall(
      { mandate: MANDATE, validAt: "2026-07-22T00:00:00Z", txAt: "2026-07-23T00:00:00Z" },
      { cursor: "cur-1", limit: 50 },
    );
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe("cur-2");
    expect(page.validAt).toBe("2026-07-22T00:00:00Z");
    expect(page.seal.hash).toBe("h");
    // The arbitrary record body is preserved verbatim (never key-mapped).
    expect(page.data[0]!.body).toEqual({ k: "v" });

    const url = new URL(net.calls[0]!.url);
    expect(url.pathname).toBe("/memory/recall");
    expect(url.searchParams.get("cursor")).toBe("cur-1");
    expect(url.searchParams.get("limit")).toBe("50");
    // Pagination rides the query string, not the body.
    const sent = JSON.parse(net.calls[0]!.init!.body as string);
    expect(sent).toEqual({
      mandate: MANDATE,
      validAt: "2026-07-22T00:00:00Z",
      txAt: "2026-07-23T00:00:00Z",
    });
  });

  test("memoryAssemble returns a signed context, abstention included", async () => {
    const net = stubFetch([
      {
        body: {
          records: [],
          order: [],
          budget: { maxTokens: 1000 },
          abstained: true,
          abstainReason: "budget too small",
          seal: { hash: "h", signature: "sig" },
        },
      },
    ]);
    const client = createClient({
      baseUrl: "https://gl.example/",
      signer: stubSigner(),
      fetch: net.fetch,
    });
    const ctx = await client.memoryAssemble({ mandate: MANDATE, budget: { maxTokens: 1000 } });
    expect(ctx.abstained).toBe(true);
    expect(ctx.budget.maxTokens).toBe(1000);
    expect(net.calls[0]!.url).toBe("https://gl.example/memory/assemble");
  });

  test("memoryVerify wraps the artifact and decodes the verdict", async () => {
    const net = stubFetch([{ body: { valid: true } }]);
    const client = createClient({
      baseUrl: "https://gl.example/",
      signer: stubSigner(),
      fetch: net.fetch,
    });
    const verdict = await client.memoryVerify({ hash: "h", signature: "sig" });
    expect(verdict.valid).toBe(true);
    const sent = JSON.parse(net.calls[0]!.init!.body as string);
    expect(sent).toEqual({ artifact: { hash: "h", signature: "sig" } });
    expect(net.calls[0]!.url).toBe("https://gl.example/memory/verify");
  });
});
