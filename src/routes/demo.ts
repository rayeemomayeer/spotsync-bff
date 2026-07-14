import { Router, type RequestHandler, json } from "express";
import type { Auth } from "../auth.js";
import type { Env } from "../env.js";
import { createRequireSession } from "../middleware/session.js";
import { issueGoBridgeToken } from "../lib/go-jwt.js";
import { upstreamFetch } from "../lib/upstream-fetch.js";

export function createDemoRouter(opts: { auth: Auth; env: Env }): Router {
  const router = Router();
  const base = opts.env.GO_API_BASE_URL.replace(/\/$/, "");

  const reset: RequestHandler = async (req, res) => {
    const user = req.sessionUser;
    if (!user?.goUserId) {
      res.status(403).json({
        success: false,
        message: "forbidden",
        errors: { auth: "session required" },
      });
      return;
    }

    const sessionId = String(req.headers["x-demo-session-id"] ?? "").trim();
    if (!sessionId) {
      res.status(400).json({
        success: false,
        message: "demo session id required",
        errors: { demo_session_id: "missing header" },
      });
      return;
    }

    try {
      const token = await issueGoBridgeToken({
        goUserId: user.goUserId,
        role: user.role,
        secret: opts.env.JWT_SECRET,
        expiresInSeconds: opts.env.JWT_EXPIRY_SECONDS,
      });
      const upstream = await upstreamFetch(`${base}/api/v1/demo/reset`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-Demo-Mode": "true",
          "X-Demo-Session-Id": sessionId,
        },
      });
      const text = await upstream.text();
      res.status(upstream.status).type("application/json").send(text);
    } catch (err) {
      console.error("[demo] reset failed", err);
      res.status(502).json({
        success: false,
        message: "demo reset failed",
        errors: { demo: err instanceof Error ? err.message : "unknown" },
      });
    }
  };

  router.post("/reset", json(), createRequireSession(opts.auth), reset);
  return router;
}
