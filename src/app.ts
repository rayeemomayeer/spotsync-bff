import express, {
  type ErrorRequestHandler,
  type Express,
  type RequestHandler,
} from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { toNodeHandler } from "better-auth/node";
import { createAuth } from "./auth.js";
import type { Env } from "./env.js";
import { healthRouter } from "./routes/health.js";
import { createProxyRouter } from "./routes/proxy.js";
import { createStripeRouter } from "./routes/stripe.js";
import { createNotifyRouter } from "./routes/notify.js";

export function createApp(env: Env): Express {
  const app = express();
  const auth = createAuth(env);

  app.set("trust proxy", 1);

  app.use(
    helmet({
      contentSecurityPolicy: false,
    }),
  );

  app.use(
    cors({
      origin: env.FRONTEND_ORIGIN,
      credentials: true,
    }),
  );

  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max: env.NODE_ENV === "production" ? 300 : 2000,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );

  // Better Auth must see the raw request before express.json().
  app.all("/api/auth/*", toNodeHandler(auth));

  app.use(
    "/api/stripe",
    createStripeRouter({
      auth,
      env,
      secretKey: env.STRIPE_SECRET_KEY,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET,
      frontendOrigin: env.FRONTEND_ORIGIN,
      priceStarter: env.STRIPE_PRICE_STARTER,
      priceGrowth: env.STRIPE_PRICE_GROWTH,
    }),
  );

  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false }));

  app.use(healthRouter);

  app.use(
    "/api/notify",
    createNotifyRouter({
      notifyUrl: env.NOTIFY_URL,
      notifyInternalToken: env.NOTIFY_INTERNAL_TOKEN,
    }),
  );

  app.use(
    "/api/v1",
    createProxyRouter({
      auth,
      goApiBaseUrl: env.GO_API_BASE_URL,
      jwtSecret: env.JWT_SECRET,
      jwtExpirySeconds: env.JWT_EXPIRY_SECONDS,
    }),
  );

  const notFound: RequestHandler = (_req, res) => {
    res.status(404).json({
      success: false,
      message: "not found",
      errors: { path: "no matching route" },
    });
  };

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    console.error("[bff] unhandled error", err);
    void import("./lib/sentry.js").then(({ Sentry }) => {
      Sentry.captureException(err);
    });
    res.status(500).json({
      success: false,
      message: "internal server error",
      errors: { server: "unexpected error" },
    });
  };

  app.use(notFound);
  app.use(onError);

  return app;
}
