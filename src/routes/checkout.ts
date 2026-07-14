import { Router, type RequestHandler, json } from "express";
import Stripe from "stripe";
import type { Auth } from "../auth.js";
import { createRequireSession } from "../middleware/session.js";
import type { Env } from "../env.js";
import {
  cancelGoReservation,
  createGoReservation,
  fetchGoPayment,
  fetchGoZone,
  recordGoPayment,
  recordGoRefund,
} from "../lib/go-api.js";

export function quoteAmountCents(pricePerHour: number, durationHours: number): number {
  const hours = Math.max(1, Math.min(24, durationHours));
  return Math.max(50, Math.round(pricePerHour * hours * 100));
}

export function createCheckoutRouter(opts: {
  auth: Auth;
  env: Env;
  secretKey: string;
}): Router {
  const router = Router();
  const stripe =
    opts.secretKey.length > 0
      ? new Stripe(opts.secretKey, { apiVersion: "2025-08-27.basil" })
      : null;

  const quote: RequestHandler = async (req, res) => {
    const body = req.body as {
      zone_id?: number | string;
      duration_hours?: number | string;
      license_plate?: string;
    };
    const zoneId = Number(body.zone_id);
    const durationHours = Number(body.duration_hours ?? 1);
    if (!Number.isFinite(zoneId) || zoneId < 1) {
      res.status(400).json({
        success: false,
        message: "invalid zone_id",
        errors: { zone_id: "required positive integer" },
      });
      return;
    }

    try {
      const zone = await fetchGoZone(opts.env, zoneId);
      const amountCents = quoteAmountCents(zone.price_per_hour, durationHours);
      const hours = Math.max(1, Math.min(24, durationHours));
      res.status(200).json({
        success: true,
        message: "quote ready",
        data: {
          zone_id: zone.id,
          zone_name: zone.name,
          duration_hours: hours,
          amount_cents: amountCents,
          currency: "usd",
          line_items: [
            {
              description: `${zone.name} · ${hours}h @ $${zone.price_per_hour.toFixed(2)}/hr`,
              amount_cents: amountCents,
            },
          ],
          license_plate: body.license_plate?.trim() ?? "",
        },
      });
    } catch (err) {
      console.error("[checkout] quote failed", err);
      res.status(502).json({
        success: false,
        message: "quote failed",
        errors: { zone: err instanceof Error ? err.message : "unknown" },
      });
    }
  };

  const paymentIntent: RequestHandler = async (req, res) => {
    if (!stripe) {
      res.status(503).json({
        success: false,
        message: "stripe not configured",
        errors: { stripe: "STRIPE_SECRET_KEY missing" },
      });
      return;
    }

    const user = req.sessionUser;
    if (!user || user.role !== "driver") {
      res.status(403).json({
        success: false,
        message: "forbidden",
        errors: { role: "driver required" },
      });
      return;
    }
    if (user.goUserId == null || user.goUserId < 1) {
      res.status(403).json({
        success: false,
        message: "forbidden",
        errors: { goUserId: "Go user link required" },
      });
      return;
    }

    const body = req.body as {
      zone_id?: number | string;
      duration_hours?: number | string;
      license_plate?: string;
      spot_id?: number | string;
    };
    const zoneId = Number(body.zone_id);
    const spotIdRaw = body.spot_id != null ? Number(body.spot_id) : undefined;
    const durationHours = Number(body.duration_hours ?? 1);
    const plate = body.license_plate?.trim() ?? "";
    if (!Number.isFinite(zoneId) || zoneId < 1 || plate.length < 1) {
      res.status(400).json({
        success: false,
        message: "invalid checkout payload",
        errors: {
          zone_id: "required",
          license_plate: "required",
        },
      });
      return;
    }

    try {
      const zone = await fetchGoZone(opts.env, zoneId);
      const amountCents = quoteAmountCents(zone.price_per_hour, durationHours);
      const hours = Math.max(1, Math.min(24, durationHours));

      const pi = await stripe.paymentIntents.create({
        amount: amountCents,
        currency: "usd",
        automatic_payment_methods: { enabled: true },
        metadata: {
          zone_id: String(zoneId),
          go_user_id: String(user.goUserId),
          license_plate: plate,
          duration_hours: String(hours),
          ...(spotIdRaw != null && Number.isFinite(spotIdRaw) && spotIdRaw > 0
            ? { spot_id: String(spotIdRaw) }
            : {}),
        },
      });

      if (!pi.client_secret) {
        res.status(502).json({
          success: false,
          message: "payment intent missing client secret",
          errors: { stripe: "no client_secret" },
        });
        return;
      }

      res.status(200).json({
        success: true,
        message: "payment intent created",
        data: {
          client_secret: pi.client_secret,
          payment_intent_id: pi.id,
          amount_cents: amountCents,
          currency: "usd",
        },
      });
    } catch (err) {
      console.error("[checkout] payment-intent failed", err);
      res.status(502).json({
        success: false,
        message: "payment intent failed",
        errors: { stripe: err instanceof Error ? err.message : "unknown" },
      });
    }
  };

  const refundPayment: RequestHandler = async (req, res) => {
    if (!stripe) {
      res.status(503).json({
        success: false,
        message: "stripe not configured",
        errors: { stripe: "STRIPE_SECRET_KEY missing" },
      });
      return;
    }

    const user = req.sessionUser;
    if (!user?.goUserId) {
      res.status(403).json({
        success: false,
        message: "forbidden",
        errors: { auth: "session required" },
      });
      return;
    }

    const paymentId = Number(req.params.id);
    if (!Number.isFinite(paymentId) || paymentId < 1) {
      res.status(400).json({
        success: false,
        message: "invalid payment id",
        errors: { id: "must be positive integer" },
      });
      return;
    }

    try {
      const payment = await fetchGoPayment(
        opts.env,
        user.goUserId,
        user.role,
        paymentId,
      );
      if (!payment.reservation_id) {
        res.status(409).json({
          success: false,
          message: "payment not linked to reservation",
          errors: { payment: "missing reservation" },
        });
        return;
      }
      if (payment.status === "refunded") {
        res.status(409).json({
          success: false,
          message: "already refunded",
          errors: { payment: "refunded" },
        });
        return;
      }

      const stripeRefund = await stripe.refunds.create({
        payment_intent: payment.stripe_payment_intent_id,
      });

      await recordGoRefund(opts.env, user.goUserId, user.role, paymentId, {
        stripe_refund_id: stripeRefund.id,
        amount_cents: payment.amount_cents,
      });
      await cancelGoReservation(opts.env, user.goUserId, payment.reservation_id);

      res.status(200).json({
        success: true,
        message: "refund processed",
        data: {
          refund_id: stripeRefund.id,
          reservation_id: payment.reservation_id,
        },
      });
    } catch (err) {
      console.error("[checkout] refund failed", err);
      res.status(502).json({
        success: false,
        message: "refund failed",
        errors: { stripe: err instanceof Error ? err.message : "unknown" },
      });
    }
  };

  const demoConfirm: RequestHandler = async (req, res) => {
    const demoMode = req.headers["x-demo-mode"];
    const demo =
      demoMode === "true" ||
      demoMode === "1" ||
      (Array.isArray(demoMode) && (demoMode[0] === "true" || demoMode[0] === "1"));
    if (!demo) {
      res.status(403).json({
        success: false,
        message: "demo mode required",
        errors: { demo: "enable demo mode" },
      });
      return;
    }

    const user = req.sessionUser;
    if (!user || user.role !== "driver") {
      res.status(403).json({
        success: false,
        message: "forbidden",
        errors: { role: "driver required" },
      });
      return;
    }
    if (user.goUserId == null || user.goUserId < 1) {
      res.status(403).json({
        success: false,
        message: "forbidden",
        errors: { goUserId: "Go user link required" },
      });
      return;
    }

    const body = req.body as {
      zone_id?: number | string;
      duration_hours?: number | string;
      license_plate?: string;
      spot_id?: number | string;
    };
    const zoneId = Number(body.zone_id);
    const spotIdRaw = body.spot_id != null ? Number(body.spot_id) : undefined;
    const durationHours = Number(body.duration_hours ?? 1);
    const plate = body.license_plate?.trim() ?? "";
    if (!Number.isFinite(zoneId) || zoneId < 1 || plate.length < 1) {
      res.status(400).json({
        success: false,
        message: "invalid checkout payload",
        errors: { zone_id: "required", license_plate: "required" },
      });
      return;
    }

    try {
      const zone = await fetchGoZone(opts.env, zoneId);
      const amountCents = quoteAmountCents(zone.price_per_hour, durationHours);
      const intentId = `demo_pi_${Date.now()}`;
      const reservationBody: {
        zone_id: number;
        license_plate: string;
        spot_id?: number;
      } = { zone_id: zoneId, license_plate: plate };
      if (spotIdRaw != null && Number.isFinite(spotIdRaw) && spotIdRaw > 0) {
        reservationBody.spot_id = spotIdRaw;
      }
      const reservation = await createGoReservation(
        opts.env,
        user.goUserId,
        reservationBody,
        intentId,
        {
          demoMode: true,
          demoSessionId: String(req.headers["x-demo-session-id"] ?? ""),
        },
      );
      const payment = await recordGoPayment(opts.env, user.goUserId, {
        reservation_id: reservation.id,
        stripe_payment_intent_id: intentId,
        amount_cents: amountCents,
        currency: "usd",
      });
      res.status(200).json({
        success: true,
        message: "demo reservation confirmed",
        data: {
          reservation_id: reservation.id,
          payment_id: payment.id,
          amount_cents: amountCents,
        },
      });
    } catch (err) {
      console.error("[checkout] demo-confirm failed", err);
      res.status(502).json({
        success: false,
        message: "demo confirm failed",
        errors: { checkout: err instanceof Error ? err.message : "unknown" },
      });
    }
  };

  router.post("/checkout/quote", json(), createRequireSession(opts.auth), quote);
  router.post("/checkout/payment-intent", json(), createRequireSession(opts.auth), paymentIntent);
  router.post("/checkout/demo-confirm", json(), createRequireSession(opts.auth), demoConfirm);
  router.post(
    "/payments/:id/refund",
    json(),
    createRequireSession(opts.auth),
    refundPayment,
  );

  return router;
}

export async function fulfillDriverPaymentIntent(
  env: Env,
  intent: Stripe.PaymentIntent,
): Promise<void> {
  const meta = intent.metadata ?? {};
  const goUserId = Number(meta.go_user_id);
  const zoneId = Number(meta.zone_id);
  const plate = meta.license_plate?.trim() ?? "";
  const spotRaw = meta.spot_id != null ? Number(meta.spot_id) : undefined;

  if (
    !Number.isFinite(goUserId) ||
    goUserId < 1 ||
    !Number.isFinite(zoneId) ||
    zoneId < 1 ||
    plate.length < 1
  ) {
    throw new Error("payment_intent metadata incomplete");
  }

  const body: { zone_id: number; license_plate: string; spot_id?: number } = {
    zone_id: zoneId,
    license_plate: plate,
  };
  if (spotRaw != null && Number.isFinite(spotRaw) && spotRaw > 0) {
    body.spot_id = spotRaw;
  }

  const reservation = await createGoReservation(env, goUserId, body, intent.id);
  await recordGoPayment(env, goUserId, {
    reservation_id: reservation.id,
    stripe_payment_intent_id: intent.id,
    amount_cents: intent.amount_received || intent.amount,
    currency: intent.currency,
  });
}
