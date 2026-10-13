import { describe, expect, it, vi } from "vitest";
vi.mock("../src/server/db", () => ({ pool: {}, transaction: vi.fn() }));
import { APICallError } from "ai";
import { aiBuildErrorMessage } from "../src/server/ai-errors";
import { DomainError } from "../src/server/auth";

const gatewayError = (
  statusCode: number,
  body: unknown,
  message = "Gateway request failed",
) =>
  new APICallError({
    url: "https://gateway.example/openai/v1/responses",
    requestBodyValues: {},
    statusCode,
    responseBody: JSON.stringify(body),
    message,
  });

describe("AI Gateway failure messages", () => {
  it.each([
    [
      429,
      {
        error_code: "REQUEST_LIMIT_EXCEEDED",
        message:
          "ai gateway account daily spend limit exceeded. Retry after the daily spend limit resets",
      },
    ],
    [
      402,
      {
        error: {
          code: "insufficient_credits",
          message: "Insufficient prepaid credits",
        },
      },
    ],
    [
      403,
      { error: { message: "ai gateway prepaid credit balance is too low" } },
    ],
    [429, { error: { code: "insufficient_quota" } }],
  ])(
    "shows the budget message for explicit financial exhaustion (%s)",
    (status, body) => {
      expect(aiBuildErrorMessage(gatewayError(status, body))).toContain(
        "budget has been used",
      );
    },
  );

  it.each([
    {
      error_code: "REQUEST_LIMIT_EXCEEDED",
      message:
        "ai gateway account token rate limit exceeded (200000 tokens per minute across all models in this region)",
    },
    {
      error_code: "REQUEST_LIMIT_EXCEEDED",
      message: "ai gateway daily token limit exceeded",
    },
    { error: { code: "rate_limit_exceeded", message: "Too many requests" } },
    {},
  ])(
    "does not mistake a temporary or unspecified rate limit for spending exhaustion",
    (body) => {
      expect(aiBuildErrorMessage(gatewayError(429, body))).toBe(
        "Neon's AI Gateway is busy. Please try again shortly.",
      );
    },
  );

  it("handles structured SDK data and malformed response bodies", () => {
    const error = new APICallError({
      url: "https://gateway.example/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 402,
      data: { error: { code: "insufficient_credits" } },
      responseBody: "not JSON",
      message: "Gateway request failed",
    });
    expect(aiBuildErrorMessage(error)).toContain("budget has been used");
    expect(aiBuildErrorMessage(gatewayError(402, null))).not.toContain(
      "budget",
    );
  });

  it("preserves validation and interruption messages and hides unknown errors", () => {
    expect(aiBuildErrorMessage(new DomainError("Pieces overlap"))).toBe(
      "Pieces overlap",
    );
    expect(
      aiBuildErrorMessage(
        gatewayError(429, { error: { code: "insufficient_credits" } }),
        true,
      ),
    ).toContain("interrupted");
    expect(
      aiBuildErrorMessage(
        gatewayError(403, {
          error: { message: "credential not authorized for this branch" },
        }),
      ),
    ).not.toContain("budget");
    expect(aiBuildErrorMessage(new Error("secret budget details"))).toBe(
      "AI couldn't finish this build. Please try again.",
    );
  });
});
