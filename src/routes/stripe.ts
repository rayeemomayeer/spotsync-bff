import { Router, type RequestHandler, raw } from "express";
import Stripe from "stripe";

export function createStripeRouter(opts: {
  secretKey: string;
  webhookSecret: string;
}): Router {
  const router = Router();

  const stripe =
    opts.secretKey.length > 0
      ? new Stripe(opts.secretKey, { apiVersion: "2025-08-27.basil" })
      : null;

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

    // TEST-mode stub: acknowledge and log type only.
    console.info("[stripe] webhook received", { type: event.type, id: event.id });
    res.status(200).json({ received: true });
  };

  router.post(
    "/webhook",
    raw({ type: "application/json" }),
    webhook,
  );

  return router;
}
