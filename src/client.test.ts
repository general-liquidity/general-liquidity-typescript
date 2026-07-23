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
