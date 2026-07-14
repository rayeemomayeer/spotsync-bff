import { describe, expect, it } from "vitest";
import { subscriptionItemMonthlyCents } from "./stripe.js";
import type Stripe from "stripe";

function item(
  unit: number,
  interval: Stripe.Price.Recurring.Interval,
  intervalCount = 1,
  qty = 1,
): Stripe.SubscriptionItem {
  return {
    id: "si_x",
    object: "subscription_item",
    quantity: qty,
    price: {
      id: "price_x",
      object: "price",
      unit_amount: unit,
      currency: "usd",
      recurring: { interval, interval_count: intervalCount },
    },
  } as Stripe.SubscriptionItem;
}

describe("subscriptionItemMonthlyCents", () => {
  it("passes through monthly", () => {
    expect(subscriptionItemMonthlyCents(item(4900, "month"))).toBe(4900);
  });

  it("divides yearly by 12", () => {
    expect(subscriptionItemMonthlyCents(item(12000, "year"))).toBe(1000);
  });

  it("respects quantity", () => {
    expect(subscriptionItemMonthlyCents(item(4900, "month", 1, 2))).toBe(9800);
  });
});
