import { Router } from "express";
import { upstreamFetch } from "../lib/upstream-fetch.js";

export const healthRouter = Router();

healthRouter.get("/healthz", (_req, res) => {
  res.status(200).json({ ok: true });
});

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
