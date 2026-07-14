import { Router, type RequestHandler } from "express";
import type { Auth, Role } from "../auth.js";
import { issueGoBridgeToken } from "../lib/go-jwt.js";
import { UpstreamTimeoutError, upstreamFetch } from "../lib/upstream-fetch.js";
import { createOptionalSession } from "../middleware/session.js";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "cookie",
]);

export function createProxyRouter(opts: {
  auth: Auth;
  goApiBaseUrl: string;
  jwtSecret: string;
  jwtExpirySeconds: number;
}): Router {
  const router = Router();
  const base = opts.goApiBaseUrl.replace(/\/$/, "");

  const proxy: RequestHandler = async (req, res, next) => {
    try {
      const user = req.sessionUser;
      const incomingAuth = req.headers.authorization;

      if (user && (user.goUserId == null || !Number.isInteger(user.goUserId) || user.goUserId < 1)) {
        res.status(403).json({
          success: false,
          message: "go user not linked",
          errors: {
            goUserId:
              "sign out/in once so BFF can link goUserId, or contact support",
          },
        });
        return;
      }

      const pathOnly = (req.url || "/").split("?")[0] ?? "/";
      if (
        req.method.toUpperCase() === "POST" &&
        pathOnly === "/reservations" &&
        user?.role === "driver"
      ) {
        const demoHeader = req.headers["x-demo-reservation"];
        const demo =
          demoHeader === "true" ||
          demoHeader === "1" ||
          (Array.isArray(demoHeader) && (demoHeader[0] === "true" || demoHeader[0] === "1"));
        if (!demo) {
          res.status(403).json({
            success: false,
            message: "use checkout flow",
            errors: { payment: "POST /api/checkout/payment-intent required" },
          });
          return;
        }
      }

      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value == null || HOP_BY_HOP.has(key.toLowerCase())) continue;
        if (key.toLowerCase() === "authorization") continue;
        if (Array.isArray(value)) {
          for (const v of value) headers.append(key, v);
        } else {
          headers.set(key, String(value));
        }
      }

      if (user?.goUserId != null) {
        const token = await issueGoBridgeToken({
          goUserId: user.goUserId,
          role: user.role as Role,
          secret: opts.jwtSecret,
          expiresInSeconds: opts.jwtExpirySeconds,
        });
        headers.set("authorization", `Bearer ${token}`);
      } else if (typeof incomingAuth === "string" && incomingAuth.length > 0) {
        headers.set("authorization", incomingAuth);
      }

      const demoMode = req.headers["x-demo-mode"];
      const demoSession = req.headers["x-demo-session-id"];
      if (typeof demoMode === "string" && demoMode.length > 0) {
        headers.set("x-demo-mode", demoMode);
      }
      if (typeof demoSession === "string" && demoSession.length > 0) {
        headers.set("x-demo-session-id", demoSession);
      }

      headers.set("accept", headers.get("accept") ?? "application/json");

      const suffix = req.url || "/";
      const target = new URL(`${base}/api/v1${suffix}`);
      const method = req.method.toUpperCase();
      const hasBody = !["GET", "HEAD"].includes(method);

      const init: RequestInit = { method, headers };

      if (hasBody) {
        if (Buffer.isBuffer(req.body)) {
          init.body = req.body;
        } else if (typeof req.body === "string") {
          init.body = req.body;
        } else if (req.body != null) {
          if (!headers.has("content-type")) {
            headers.set("content-type", "application/json");
          }
          init.body = JSON.stringify(req.body);
        }
      }

      const upstream = await upstreamFetch(target, init);
      const buf = Buffer.from(await upstream.arrayBuffer());

      res.status(upstream.status);
      upstream.headers.forEach((value, key) => {
        if (HOP_BY_HOP.has(key.toLowerCase())) return;
        if (key.toLowerCase() === "content-encoding") return;
        res.setHeader(key, value);
      });
      res.send(buf);
    } catch (err) {
      if (err instanceof UpstreamTimeoutError) {
        console.error("[bff] upstream timeout", err.url);
        res.status(504).json({
          success: false,
          message: "upstream timeout",
          errors: { upstream: "Go API did not respond in time" },
        });
        return;
      }
      next(err);
    }
  };

  router.use(createOptionalSession(opts.auth));
  router.all("/*", proxy);

  return router;
}
