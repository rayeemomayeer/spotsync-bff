import { Router, type RequestHandler, json, raw } from "express";
import Stripe from "stripe";
import type { Auth } from "../auth.js";
import { createRequireSession } from "../middleware/session.js";
import { patchOrgBillingPlan } from "../lib/go-api.js";
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
    if (role !== "saas_admin") {
      res.status(403).json({
        success: false,
        message: "forbidden",
        errors: { role: "saas_admin required" },
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

    const origin = opts.frontendOrigin.replace(/\/$/, "");
    const orgMeta =
      body.organization_id != null ? String(body.organization_id) : undefined;

    try {
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        line_items: [{ price, quantity: 1 }],
        success_url: `${origin}/platform/billing?checkout=success`,
        cancel_url: `${origin}/platform/billing?checkout=cancel`,
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

    res.status(200).json({ received: true });
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

  return router;
}
