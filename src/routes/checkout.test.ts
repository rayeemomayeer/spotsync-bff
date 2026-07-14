/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { quoteAmountCents } from "./checkout.js";

describe("quoteAmountCents", () => {
  it("charges at least one hour", () => {
    expect(quoteAmountCents(5, 0.5)).toBe(500);
  });

  it("multiplies price by duration", () => {
    expect(quoteAmountCents(3.5, 2)).toBe(700);
  });

  it("enforces minimum 50 cents", () => {
    expect(quoteAmountCents(0.01, 1)).toBe(50);
  });
});
