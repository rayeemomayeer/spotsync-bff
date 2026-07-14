import { Router, type RequestHandler, json, raw } from "express";
import Stripe from "stripe";
import type { Auth } from "../auth.js";
import { createRequireSession } from "../middleware/session.js";
import { fetchOrgMe, patchOrgBillingPlan } from "../lib/go-api.js";
import { fulfillDriverCheckoutSession, fulfillDriverPaymentIntent } from "./checkout.js";
import type { Env } from "../env.js";

type PlanKey = "starter" | "growth";

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

    const price = priceIdFor(plan);
    if (!price) {
      res.status(503).json({
        success: false,
        message: "stripe price not configured",
        errors: {
          plan: plan === "growth" ? "STRIPE_PRICE_GROWTH missing" : "STRIPE_PRICE_STARTER missing",
        },
      });
      return;
    }

    let orgMeta: string | undefined;
    if (role === "org_admin") {
      const org = await fetchOrgMe(opts.env, goUserId, role);
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
      orgMeta = String(org.id);
    } else if (body.organization_id != null) {
      orgMeta = String(body.organization_id);
    }

    const origin = opts.frontendOrigin.replace(/\/$/, "");
    const successPath = role === "org_admin" ? "/org/billing" : "/platform/billing";

    try {
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        line_items: [{ price, quantity: 1 }],
        success_url: `${origin}${successPath}?checkout=success`,
        cancel_url: `${origin}${successPath}?checkout=cancel`,
        client_reference_id: orgMeta,
        metadata: {
          plan,
          ...(orgMeta ? { organization_id: orgMeta } : {}),
          actor_email: req.sessionUser?.email ?? "",
        },
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
        const orgRaw = session.metadata?.organization_id ?? session.client_reference_id;
        const orgId = orgRaw ? Number(orgRaw) : NaN;
        if ((plan === "starter" || plan === "growth") && Number.isFinite(orgId) && orgId > 0) {
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
      const body = req.body as { stripe_customer_id?: string };
      customerId = body.stripe_customer_id?.trim();
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

  router.post(
    "/portal",
    json(),
    createRequireSession(opts.auth),
    portal,
  );

  return router;
}
