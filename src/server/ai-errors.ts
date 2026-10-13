import { APICallError } from "ai";
import { DomainError } from "./auth";

const budgetCodes = new Set([
  "insufficient_quota",
  "insufficient_credits",
  "insufficient_balance",
  "credits_exhausted",
  "credit_balance_exhausted",
  "out_of_credits",
  "budget_exceeded",
  "spend_limit_exceeded",
]);

function budgetDetails(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const detail = value as Record<string, unknown>;
  if (
    [detail.error_code, detail.code, detail.type].some(
      (code) => typeof code === "string" && budgetCodes.has(code.toLowerCase()),
    )
  )
    return true;
  const message = typeof detail.message === "string" ? detail.message : "";
  // REQUEST_LIMIT_EXCEEDED also covers TPM limits; require financial context.
  return (
    /\b(?:budget|spend(?:ing)? (?:limit|cap)|(?:prepaid )?credits?|(?:credit )?balance)\b.{0,80}\b(?:exceeded|exhausted|depleted|insufficient|too low|empty)\b/i.test(
      message,
    ) ||
    /\b(?:insufficient|exhausted|depleted|no remaining|out of)\b.{0,30}\b(?:credits?|(?:credit )?balance|budget)\b/i.test(
      message,
    )
  );
}

function isBudgetError(error: APICallError): boolean {
  let body: unknown = error.data;
  if (error.responseBody) {
    try {
      body = JSON.parse(error.responseBody);
    } catch {}
  }
  return (
    budgetDetails(body) ||
    (body !== null &&
      typeof body === "object" &&
      budgetDetails((body as Record<string, unknown>).error)) ||
    budgetDetails({ message: error.message })
  );
}

export function aiBuildErrorMessage(
  error: unknown,
  interrupted = false,
): string {
  if (error instanceof DomainError) return error.message;
  if (interrupted) return "This build was interrupted. Please try again.";
  if (APICallError.isInstance(error)) {
    if (
      [400, 402, 403, 429].includes(error.statusCode || 0) &&
      isBudgetError(error)
    )
      return "Neon's AI Gateway budget has been used. Check the prepaid credits or spending limit in Neon.";
    if (error.statusCode === 429)
      return "Neon's AI Gateway is busy. Please try again shortly.";
  }
  return "AI couldn't finish this build. Please try again.";
}
