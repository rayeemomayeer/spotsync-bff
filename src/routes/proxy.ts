import { Router, type RequestHandler } from "express";
import type { Auth, Role } from "../auth.js";
import { issueGoBridgeToken } from "../lib/go-jwt.js";
import { createRequireSession } from "../middleware/session.js";

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
      if (!user) {
        res.status(401).json({
          success: false,
          message: "unauthorized",
          errors: { auth: "session required" },
        });
        return;
      }

      if (user.goUserId == null || !Number.isInteger(user.goUserId) || user.goUserId < 1) {
        res.status(403).json({
          success: false,
          message: "go user not linked",
          errors: {
            goUserId:
              "set user.goUserId to the matching Go users.id before calling the API proxy",
          },
        });
        return;
      }

      const token = await issueGoBridgeToken({
        goUserId: user.goUserId,
        role: user.role as Role,
        secret: opts.jwtSecret,
        expiresInSeconds: opts.jwtExpirySeconds,
      });

      const suffix = req.url || "/";
      const target = new URL(`${base}/api/v1${suffix}`);

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
      headers.set("authorization", `Bearer ${token}`);
      headers.set("accept", headers.get("accept") ?? "application/json");

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

      const upstream = await fetch(target, init);
      const buf = Buffer.from(await upstream.arrayBuffer());

      res.status(upstream.status);
      upstream.headers.forEach((value, key) => {
        if (HOP_BY_HOP.has(key.toLowerCase())) return;
        if (key.toLowerCase() === "content-encoding") return;
        res.setHeader(key, value);
      });
      res.send(buf);
    } catch (err) {
      next(err);
    }
  };

  router.use(createRequireSession(opts.auth));
  router.all("/*", proxy);

  return router;
}
