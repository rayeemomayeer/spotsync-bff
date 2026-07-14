import { Router } from "express";
import type { Env } from "../env.js";
import { upstreamFetch } from "../lib/upstream-fetch.js";

export function createHealthRouter(env: Env) {
  const router = Router();
  const googleOauth =
    env.GOOGLE_CLIENT_ID.length > 0 && env.GOOGLE_CLIENT_SECRET.length > 0;

  router.get("/healthz", (_req, res) => {
    res.status(200).json({ ok: true, google_oauth: googleOauth });
  });

  return router;
}

export function createReadyRouter(goApiBaseUrl: string) {
  const router = Router();
  const base = goApiBaseUrl.replace(/\/$/, "");

  router.get("/readyz", async (_req, res) => {
    try {
      const upstream = await upstreamFetch(`${base}/healthz`, {
        method: "GET",
        timeoutMs: 15_000,
      });
      if (!upstream.ok) {
        res.status(503).json({ ok: false, upstream: upstream.status });
        return;
      }
      res.status(200).json({ ok: true, upstream: "go" });
    } catch (err) {
      console.error("[bff] readyz upstream failed", err);
      res.status(503).json({ ok: false, upstream: "unreachable" });
    }
  });

  return router;
}
