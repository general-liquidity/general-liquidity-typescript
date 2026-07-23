import { describe, expect, test } from "bun:test";
import { createClient } from "./client.ts";
import { makeIntent, stubFetch, stubSigner } from "./testing/testkit.ts";

describe("createClient / pay", () => {
  test("signs the intent, auto-generates an idempotency key, and sends snake_case", async () => {
    const signer = stubSigner();
    const receiptWire = {
      intent_key: "k1",
      rail: "x402",
      reference: "0xabc",
      terms: {
        reversibility: "irreversible",
        finality: "instant",
        credential: "eip3009",
        rail: "x402",
        capital_source: "payer",
        presence: "delegated",
      },
      settled_at: "2026-07-22T00:00:00Z",
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

    // camelCase came back to the caller.
    expect(receipt.intentKey).toBe("k1");
    expect(receipt.terms.capitalSource).toBe("payer");

    // signer was invoked (local signing, keys never left the operator).
    expect(signer.calls.length).toBe(1);

    // wire body is snake_case and carries the generated key + signature.
    const sent = JSON.parse(net.calls[0]!.init!.body as string);
    expect(sent.idempotency_key).toBe("gen-key");
    expect(sent.envelope.mandate_id).toBe("mandate:1");
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
    expect(sent.idempotency_key).toBe("caller-key");
  });

  test("resolve decodes a snake_case Counterparty", async () => {
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

describe("agent read surface", () => {
  test("getJob GETs /intents/{id} and decodes the snake_case Job", async () => {
    const net = stubFetch([
      {
        body: {
          id: "intent-1",
          status: "settled",
          created_at: "2026-07-24T00:00:00Z",
          terminal_at: "2026-07-24T00:00:05Z",
          outcome: "allow",
          receipt: { intent_key: "intent-1", rail: "x402", reference: "0xabc" },
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
              intent_key: "intent-1",
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
