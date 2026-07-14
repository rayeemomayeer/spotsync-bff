import { Router, type RequestHandler, json, raw } from "express";
import Stripe from "stripe";
import type { Auth } from "../auth.js";
import { createRequireSession } from "../middleware/session.js";
import {
  clearOrgBillingPlan,
  fetchOrgById,
  fetchOrgMe,
  patchOrgBillingPlan,
  type GoOrganization,
} from "../lib/go-api.js";
import { fulfillDriverCheckoutSession, fulfillDriverPaymentIntent } from "./checkout.js";
import type { Env } from "../env.js";

type PlanKey = "starter" | "growth";

function parseOrgId(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.trunc(n);
}

function orgIdFromStripeMeta(
  meta: Stripe.Metadata | null | undefined,
  clientReferenceId?: string | null,
): number | null {
  return parseOrgId(meta?.organization_id ?? clientReferenceId);
}

/** Monthly cents from a subscription line item (yearly → /12). */
export function subscriptionItemMonthlyCents(item: Stripe.SubscriptionItem): number {
  const price = item.price;
  const unit = price.unit_amount ?? 0;
  const qty = item.quantity ?? 1;
  const total = unit * qty;
  const interval = price.recurring?.interval;
  const count = price.recurring?.interval_count ?? 1;
  if (interval === "year") {
    return Math.round(total / (12 * count));
  }
  if (interval === "month") {
    return Math.round(total / count);
  }
  if (interval === "week") {
    return Math.round((total * 52) / (12 * count));
  }
  if (interval === "day") {
    return Math.round((total * 365) / (12 * count));
  }
  return 0;
}

export async function computeStripeMrrCents(stripe: Stripe): Promise<{
  mrr_cents: number;
  subscription_count: number;
  currency: string;
}> {
  let mrr = 0;
  let count = 0;
  let currency = "usd";
  for (const status of ["active", "trialing"] as const) {
    for await (const sub of stripe.subscriptions.list({
      status,
      limit: 100,
      expand: ["data.items.data.price"],
    })) {
      count += 1;
      for (const item of sub.items.data) {
        mrr += subscriptionItemMonthlyCents(item);
        if (item.price.currency) currency = item.price.currency;
      }
    }
  }
  return { mrr_cents: mrr, subscription_count: count, currency };
}

export function createStripeRouter(opts: {
  auth: Auth;
  env: Env;
  secretKey: string;
  webhookSecret: string;
  frontendOrigin: string;
  priceStarter: string;
  priceGrowth: string;
}): Router {
  const router = Router();

  const stripe =
    opts.secretKey.length > 0
      ? new Stripe(opts.secretKey, { apiVersion: "2025-08-27.basil" })
      : null;

  const priceIdFor = (plan: PlanKey): string => {
    if (plan === "growth") return opts.priceGrowth;
    return opts.priceStarter;
  };

  const checkout: RequestHandler = async (req, res) => {
    if (!stripe) {
      res.status(503).json({
        success: false,
        message: "stripe not configured",
        errors: { stripe: "STRIPE_SECRET_KEY missing" },
      });
      return;
    }

    const role = req.sessionUser?.role;
    const goUserId = req.sessionUser?.goUserId;
    if (role !== "saas_admin" && role !== "org_admin") {
      res.status(403).json({
        success: false,
        message: "forbidden",
        errors: { role: "saas_admin or org_admin required" },
      });
      return;
    }
    if (goUserId == null || goUserId < 1) {
      res.status(403).json({
        success: false,
        message: "forbidden",
        errors: { goUserId: "Go user link required for billing" },
      });
      return;
    }

    const body = req.body as { plan?: string; organization_id?: number | string };
    const plan = body.plan === "growth" ? "growth" : body.plan === "starter" ? "starter" : null;
    if (!plan) {
      res.status(400).json({
        success: false,
        message: "invalid plan",
        errors: { plan: "must be starter or growth" },
      });
      return;
    }

    let org: GoOrganization | null = null;
    if (role === "org_admin") {
      org = await fetchOrgMe(opts.env, goUserId, role);
      if (!org) {
        res.status(404).json({
          success: false,
          message: "organization not found",
          errors: { organization: "no org membership" },
        });
        return;
      }
      if (org.status !== "active") {
        res.status(403).json({
          success: false,
          message: "organization not approved",
          errors: { organization: "approval required before subscribe" },
        });
        return;
      }
    } else {
      const orgId = parseOrgId(body.organization_id);
      if (orgId == null) {
        res.status(400).json({
          success: false,
          message: "organization_id required",
          errors: { organization_id: "required for platform checkout" },
        });
        return;
      }
      org = await fetchOrgById(opts.env, orgId);
      if (!org) {
        res.status(404).json({
          success: false,
          message: "organization not found",
          errors: { organization_id: "unknown org" },
        });
        return;
      }
      if (org.status !== "active") {
        res.status(403).json({
          success: false,
          message: "organization not approved",
          errors: { organization: "approve org before subscribe" },
        });
        return;
      }
    }

    if (org.billing_plan === plan) {
      res.status(409).json({
        success: false,
        message: "already on this plan",
        errors: {
          plan: "org already subscribed to this plan — use billing portal to manage",
        },
      });
      return;
    }

    const orgMeta = String(org.id);
    const origin = opts.frontendOrigin.replace(/\/$/, "");
    const successPath = role === "org_admin" ? "/org/billing" : "/platform/billing";
    const successUrl = `${origin}${successPath}?checkout=success`;
    const cancelUrl = `${origin}${successPath}?checkout=cancel`;
    const metadata: Stripe.MetadataParam = {
      plan,
      organization_id: orgMeta,
      actor_email: req.sessionUser?.email ?? "",
    };

    try {
      const session = await createSubscriptionCheckout(stripe, {
        plan,
        priceId: priceIdFor(plan),
        successUrl,
        cancelUrl,
        clientReferenceId: orgMeta,
        metadata,
        customerId: org.stripe_customer_id ?? undefined,
      });

      if (!session.url) {
        res.status(502).json({
          success: false,
          message: "checkout session missing url",
          errors: { stripe: "no redirect url" },
        });
        return;
      }

      res.status(200).json({
        success: true,
        message: "checkout session created",
        data: { url: session.url, id: session.id },
      });
    } catch (err) {
      console.error("[stripe] checkout create failed", err);
      res.status(502).json({
        success: false,
        message: "checkout create failed",
        errors: { stripe: err instanceof Error ? err.message : "unknown" },
      });
    }
  };

  const mrr: RequestHandler = async (req, res) => {
    if (!stripe) {
      res.status(503).json({
        success: false,
        message: "stripe not configured",
        errors: { stripe: "STRIPE_SECRET_KEY missing" },
      });
      return;
    }
    if (req.sessionUser?.role !== "saas_admin") {
      res.status(403).json({
        success: false,
        message: "forbidden",
        errors: { role: "saas_admin required" },
      });
      return;
    }
    try {
      const data = await computeStripeMrrCents(stripe);
      res.status(200).json({
        success: true,
        message: "stripe mrr",
        data: {
          ...data,
          source: "stripe_subscriptions",
        },
      });
    } catch (err) {
      console.error("[stripe] mrr failed", err);
      res.status(502).json({
        success: false,
        message: "mrr fetch failed",
        errors: { stripe: err instanceof Error ? err.message : "unknown" },
      });
    }
  };

  const webhook: RequestHandler = async (req, res) => {
    if (!stripe || !opts.webhookSecret) {
      res.status(503).json({
        success: false,
        message: "stripe not configured",
        errors: { stripe: "STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET missing" },
      });
      return;
    }

    const signature = req.headers["stripe-signature"];
    if (typeof signature !== "string") {
      res.status(400).json({
        success: false,
        message: "missing stripe-signature",
        errors: { stripe: "signature required" },
      });
      return;
    }

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body as Buffer,
        signature,
        opts.webhookSecret,
      );
    } catch {
      res.status(400).json({
        success: false,
        message: "invalid stripe signature",
        errors: { stripe: "signature verification failed" },
      });
      return;
    }

    console.info("[stripe] webhook received", {
      type: event.type,
      id: event.id,
      plan:
        event.type === "checkout.session.completed"
          ? (event.data.object as Stripe.Checkout.Session).metadata?.plan
          : undefined,
    });

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;

      if (
        session.mode === "payment" &&
        (session.metadata?.purpose === "driver_reservation" || session.metadata?.zone_id)
      ) {
        try {
          await fulfillDriverCheckoutSession(opts.env, session);
        } catch (err) {
          console.error("[stripe] driver checkout fulfillment failed", err);
          res.status(502).json({ received: false, error: "reservation fulfillment failed" });
          return;
        }
      } else {
        const plan = session.metadata?.plan;
        const orgId = orgIdFromStripeMeta(session.metadata, session.client_reference_id);
        if ((plan === "starter" || plan === "growth") && orgId != null) {
          try {
            await patchOrgBillingPlan(
              opts.env,
              orgId,
              plan,
              typeof session.customer === "string" ? session.customer : session.customer?.id,
            );
          } catch (err) {
            console.error("[stripe] failed to persist org plan", err);
            res.status(502).json({ received: false, error: "plan persistence failed" });
            return;
          }
        }
      }
    }

    if (event.type === "payment_intent.succeeded") {
      const intent = event.data.object as Stripe.PaymentIntent;
      if (intent.metadata?.zone_id) {
        try {
          await fulfillDriverPaymentIntent(opts.env, intent);
        } catch (err) {
          console.error("[stripe] driver payment fulfillment failed", err);
          res.status(502).json({ received: false, error: "reservation fulfillment failed" });
          return;
        }
      }
    }

    if (
      event.type === "customer.subscription.deleted" ||
      event.type === "customer.subscription.updated"
    ) {
      const sub = event.data.object as Stripe.Subscription;
      const orgId = orgIdFromStripeMeta(sub.metadata);
      const shouldClear =
        event.type === "customer.subscription.deleted" ||
        sub.status === "canceled" ||
        sub.status === "unpaid" ||
        sub.status === "incomplete_expired";
      if (shouldClear && orgId != null) {
        try {
          await clearOrgBillingPlan(opts.env, orgId);
          console.info("[stripe] cleared org billing_plan", { orgId, status: sub.status });
        } catch (err) {
          console.error("[stripe] failed to clear org plan", err);
          res.status(502).json({ received: false, error: "plan clear failed" });
          return;
        }
      }
    }

    res.status(200).json({ received: true });
  };

  const portal: RequestHandler = async (req, res) => {
    if (!stripe) {
      res.status(503).json({
        success: false,
        message: "stripe not configured",
        errors: { stripe: "STRIPE_SECRET_KEY missing" },
      });
      return;
    }

    const role = req.sessionUser?.role;
    const goUserId = req.sessionUser?.goUserId;
    if (role !== "saas_admin" && role !== "org_admin") {
      res.status(403).json({
        success: false,
        message: "forbidden",
        errors: { role: "saas_admin or org_admin required" },
      });
      return;
    }
    if (goUserId == null || goUserId < 1) {
      res.status(403).json({
        success: false,
        message: "forbidden",
        errors: { goUserId: "Go user link required" },
      });
      return;
    }

    let customerId: string | undefined;
    if (role === "org_admin") {
      const org = await fetchOrgMe(opts.env, goUserId, role);
      if (!org?.stripe_customer_id) {
        res.status(404).json({
          success: false,
          message: "no stripe customer",
          errors: { stripe: "subscribe first" },
        });
        return;
      }
      customerId = org.stripe_customer_id;
    } else {
      const body = req.body as { stripe_customer_id?: string; organization_id?: number | string };
      if (body.stripe_customer_id?.trim()) {
        customerId = body.stripe_customer_id.trim();
      } else {
        const orgId = parseOrgId(body.organization_id);
        if (orgId == null) {
          res.status(400).json({
            success: false,
            message: "organization_id required",
            errors: { organization_id: "required for platform portal" },
          });
          return;
        }
        const org = await fetchOrgById(opts.env, orgId);
        if (!org?.stripe_customer_id) {
          res.status(404).json({
            success: false,
            message: "no stripe customer",
            errors: { stripe: "org has no Stripe customer yet" },
          });
          return;
        }
        customerId = org.stripe_customer_id;
      }
    }

    if (!customerId) {
      res.status(400).json({
        success: false,
        message: "stripe customer required",
        errors: { stripe_customer_id: "required for platform portal" },
      });
      return;
    }

    const origin = opts.frontendOrigin.replace(/\/$/, "");
    const returnPath = role === "org_admin" ? "/org/billing" : "/platform/billing";

    try {
      const session = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: `${origin}${returnPath}`,
      });
      res.status(200).json({
        success: true,
        message: "portal session created",
        data: { url: session.url },
      });
    } catch (err) {
      console.error("[stripe] portal create failed", err);
      res.status(502).json({
        success: false,
        message: "portal create failed",
        errors: { stripe: err instanceof Error ? err.message : "unknown" },
      });
    }
  };

  router.post(
    "/webhook",
    raw({ type: "application/json" }),
    webhook,
  );

  router.post(
    "/checkout",
    json(),
    createRequireSession(opts.auth),
    checkout,
  );

  router.get(
    "/mrr",
    createRequireSession(opts.auth),
    mrr,
  );

  router.post(
    "/portal",
    json(),
    createRequireSession(opts.auth),
    portal,
  );

  return router;
}

/** Amounts match /org/billing UI (test mode). */
const PLAN_AMOUNT_CENTS: Record<PlanKey, number> = {
  starter: 4900,
  growth: 14900,
};

const PLAN_NAME: Record<PlanKey, string> = {
  starter: "SpotSync Starter",
  growth: "SpotSync Growth",
};

async function createSubscriptionCheckout(
  stripe: Stripe,
  opts: {
    plan: PlanKey;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    clientReferenceId?: string;
    metadata: Stripe.MetadataParam;
    customerId?: string;
  },
): Promise<Stripe.Checkout.Session> {
  const base: Stripe.Checkout.SessionCreateParams = {
    mode: "subscription",
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    client_reference_id: opts.clientReferenceId,
    metadata: opts.metadata,
    subscription_data: {
      metadata: opts.metadata,
    },
    ...(opts.customerId ? { customer: opts.customerId } : {}),
  };

  if (opts.priceId.trim()) {
    try {
      return await stripe.checkout.sessions.create({
        ...base,
        line_items: [{ price: opts.priceId.trim(), quantity: 1 }],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (!/No such price/i.test(msg)) {
        throw err;
      }
      console.warn(
        "[stripe] price id not on this Stripe account; using price_data fallback",
        opts.priceId,
      );
    }
  }

  return stripe.checkout.sessions.create({
    ...base,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: PLAN_AMOUNT_CENTS[opts.plan],
          recurring: { interval: "month" },
          product_data: {
            name: PLAN_NAME[opts.plan],
            description: "SpotSync subscription (Stripe test mode)",
          },
        },
      },
    ],
  });
}
