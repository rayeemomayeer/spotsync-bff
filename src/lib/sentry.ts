import * as Sentry from "@sentry/node";

let started = false;

/** Init Sentry for Express BFF when SENTRY_DSN is set. */
export function initSentry(): void {
  if (started) return;
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) return;
  Sentry.init({
    dsn,
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.2 : 1,
    environment: process.env.NODE_ENV ?? "development",
  });
  started = true;
  console.info("[bff] sentry enabled");
}

export { Sentry };
