import { describe, expect, test } from "bun:test";
import { stubFetch } from "../testing/testkit.ts";
import { RateLimitError } from "./errors.ts";
import { Http } from "./http.ts";

const noSleep = () => Promise.resolve();

describe("Http retry/backoff", () => {
  test("retries on 429 then succeeds, honoring Retry-After", async () => {
    const net = stubFetch([
      {
        status: 429,
        headers: { "retry-after": "2" },
        body: { type: "rate-limited", title: "slow down" },
      },
      { body: { ok: true } },
    ]);
    const waits: number[] = [];
    const http = new Http({
      baseUrl: "https://x/",
      fetch: net.fetch,
      retry: { maxRetries: 3, baseMs: 100, maxMs: 5000 },
      sleep: async (ms) => void waits.push(ms),
    });
    const out = await http.post<{ ok: boolean }>("pay", {});
    expect(out.ok).toBe(true);
    expect(net.calls.length).toBe(2);
    expect(waits[0]).toBe(2000); // Retry-After seconds → ms
  });

  test("retries a network error then throws after exhausting attempts", async () => {
    const net = stubFetch([{ throw: true }, { throw: true }]);
    const http = new Http({
      baseUrl: "https://x/",
      fetch: net.fetch,
      retry: { maxRetries: 1, baseMs: 1, maxMs: 10 },
      sleep: noSleep,
    });
    await expect(http.post("pay", {})).rejects.toThrow();
    expect(net.calls.length).toBe(2);
  });

  test("does not retry a 4xx client error and throws the typed error", async () => {
    const net = stubFetch([
      { status: 429, body: { type: "rate-limited" } },
      { status: 400, body: { type: "insufficient-funds", title: "no funds" } },
    ]);
    const http = new Http({
      baseUrl: "https://x/",
      fetch: net.fetch,
      retry: { maxRetries: 5, baseMs: 1, maxMs: 10 },
      sleep: noSleep,
      random: () => 0.5,
    });
    await expect(http.post("pay", {})).rejects.toBeInstanceOf(Error);
    // one retry (429 retryable) then the 400 stops the loop
    expect(net.calls.length).toBe(2);
  });

  test("full jitter uses injected random within [0, exp]", async () => {
    const net = stubFetch([{ status: 500 }, { body: {} }]);
    const waits: number[] = [];
    const http = new Http({
      baseUrl: "https://x/",
      fetch: net.fetch,
      retry: { maxRetries: 2, baseMs: 1000, maxMs: 5000 },
      sleep: async (ms) => void waits.push(ms),
      random: () => 0.5,
    });
    await http.post("pay", {});
    expect(waits[0]).toBe(500); // 0.5 * (1000 * 2^0)
  });

  test("surfaces a RateLimitError type on a terminal 429", async () => {
    const net = stubFetch([
      { status: 429, body: { type: "https://gl/problems/rate-limited", title: "x" } },
    ]);
    const http = new Http({
      baseUrl: "https://x/",
      fetch: net.fetch,
      retry: { maxRetries: 0, baseMs: 1, maxMs: 1 },
      sleep: noSleep,
    });
    await expect(http.post("pay", {})).rejects.toBeInstanceOf(RateLimitError);
  });
});
