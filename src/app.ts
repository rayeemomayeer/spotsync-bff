import express, {
  type ErrorRequestHandler,
  type Express,
  type RequestHandler,
} from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { Pool } from "pg";
import { toNodeHandler } from "better-auth/node";
import { createAuth } from "./auth.js";
import type { Env } from "./env.js";
import { createHealthRouter, createReadyRouter } from "./routes/health.js";
import { createProxyRouter } from "./routes/proxy.js";
import { createStripeRouter } from "./routes/stripe.js";
import { createCheckoutRouter } from "./routes/checkout.js";
import { createDemoRouter } from "./routes/demo.js";
import { createNotifyRouter } from "./routes/notify.js";
import { createPlatformUsersRouter } from "./routes/platform-users.js";
import { createOrgApplyRouter } from "./routes/org-apply.js";
import { attachDemoHeaders } from "./middleware/demo.js";

export function createApp(env: Env): Express {
  const app = express();
  const auth = createAuth(env);
  const platformPool = new Pool({
    connectionString: env.DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  app.set("trust proxy", 1);

  // Better Auth error redirects can land on BFF origin with ?error=...
  // Send users back to the Vercel app instead of a JSON 404.
  app.get("/", (req, res) => {
    const frontend = env.FRONTEND_ORIGIN.replace(/\/$/, "");
    const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    const target = qs.includes("error=")
      ? `${frontend}/login${qs}`
      : `${frontend}/`;
    res.redirect(302, target);
  });

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

  app.use(
    "/api",
    attachDemoHeaders(),
    createCheckoutRouter({
      auth,
      env,
      secretKey: env.STRIPE_SECRET_KEY,
    }),
  );

  app.use("/api/demo", createDemoRouter({ auth, env }));

  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false }));

  app.use(createHealthRouter(env));
  app.use(createReadyRouter(env.GO_API_BASE_URL));

  app.use(
    "/api/notify",
    createNotifyRouter({
      notifyUrl: env.NOTIFY_URL,
      notifyInternalToken: env.NOTIFY_INTERNAL_TOKEN,
    }),
  );

  app.use("/api/platform", createPlatformUsersRouter({ auth, pool: platformPool }));

  app.use(
    "/api/orgs",
    createOrgApplyRouter({ auth, env, pool: platformPool }),
  );

  app.use(
    "/api/v1",
    attachDemoHeaders(),
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
