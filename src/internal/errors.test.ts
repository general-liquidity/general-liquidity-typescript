import { describe, expect, test } from "bun:test";
import {
  DeniedError,
  errorFromProblem,
  GlError,
  InsufficientFundsError,
  MandateExceededError,
  problemCode,
  ServerError,
} from "./errors.ts";

describe("problem+json → typed errors", () => {
  test("problemCode extracts the trailing segment of a type URI", () => {
    expect(problemCode("https://gl.example/problems/insufficient-funds")).toBe(
      "insufficient-funds",
    );
    expect(problemCode("mandate-exceeded")).toBe("mandate-exceeded");
    expect(problemCode(undefined)).toBe("about:blank");
  });

  test("branches to the right class by type", () => {
    expect(errorFromProblem({ type: "insufficient-funds" }, 402)).toBeInstanceOf(
      InsufficientFundsError,
    );
    expect(errorFromProblem({ type: "mandate-exceeded" }, 403)).toBeInstanceOf(
      MandateExceededError,
    );
    expect(errorFromProblem({ type: "denied" }, 403)).toBeInstanceOf(DeniedError);
  });

  test("unknown 5xx type falls back to ServerError and is retryable", () => {
    const e = errorFromProblem({ type: "wat", title: "boom" }, 503);
    expect(e).toBeInstanceOf(ServerError);
    expect(e.retryable).toBe(true);
  });

  test("carries detail, instance, status, and retry hint", () => {
    const e = errorFromProblem(
      { type: "rate-limited", detail: "too fast", instance: "/pay/1" },
      429,
      1500,
    );
    expect(e).toBeInstanceOf(GlError);
    expect(e.detail).toBe("too fast");
    expect(e.instance).toBe("/pay/1");
    expect(e.retryAfterMs).toBe(1500);
    expect(e.retryable).toBe(true);
  });

  test("a 4xx unknown type is not retryable", () => {
    expect(errorFromProblem({ type: "validation" }, 400).retryable).toBe(false);
  });
});
