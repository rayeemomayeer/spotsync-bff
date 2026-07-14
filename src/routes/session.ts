import { Router, json } from "express";
import { fromNodeHeaders } from "better-auth/node";
import type { Auth, Role, SessionUser } from "../auth.js";
import type { Env } from "../env.js";
import { createOptionalSession, createRequireSession } from "../middleware/session.js";
import { issueGoBridgeToken } from "../lib/go-jwt.js";
import { ensureGoUserId } from "../lib/go-user-bridge.js";

function mintPayload(
  user: SessionUser,
  token: string,
  expiresInSeconds: number,
) {
  return {
    success: true,
    message: "ok",
    data: {
      token,
      expires_in: expiresInSeconds,
      role: user.role,
      go_user_id: user.goUserId,
    },
  };
}

/**
 * Mint a Go API JWT.
 * - GET: Better Auth cookie session (when third-party cookies work)
 * - POST: { email, password } — no cookie required (Vercel→Render email login)
 */
export function createSessionRouter(opts: { auth: Auth; env: Env }): Router {
  const router = Router();
  const requireSession = createRequireSession(opts.auth);
  const optionalSession = createOptionalSession(opts.auth);
  const expiresInSeconds = Math.max(opts.env.JWT_EXPIRY_SECONDS, 60 * 60 * 12);

  async function mintForSessionUser(user: SessionUser) {
    if (user.goUserId == null || !Number.isInteger(user.goUserId) || user.goUserId < 1) {
      return { error: "unlink" as const };
    }
    const token = await issueGoBridgeToken({
      goUserId: user.goUserId,
      role: user.role,
      secret: opts.env.JWT_SECRET,
      expiresInSeconds,
    });
    return { token, user };
  }

  router.get("/go-token", requireSession, async (req, res, next) => {
    try {
      const result = await mintForSessionUser(req.sessionUser!);
      if ("error" in result) {
        res.status(403).json({
          success: false,
          message: "go user not linked",
          errors: {
            goUserId: "Sign out and sign in once so BFF can link your Go user",
          },
        });
        return;
      }
      res.json(mintPayload(result.user, result.token, expiresInSeconds));
    } catch (err) {
      next(err);
    }
  });

  router.post("/go-token", json(), optionalSession, async (req, res, next) => {
    try {
      if (req.sessionUser) {
        const result = await mintForSessionUser(req.sessionUser);
        if (!("error" in result)) {
          res.json(mintPayload(result.user, result.token, expiresInSeconds));
          return;
        }
      }

      const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
      const password = typeof req.body?.password === "string" ? req.body.password : "";
      if (!email || password.length < 8) {
        res.status(401).json({
          success: false,
          message: "unauthorized",
          errors: { auth: "session or email/password required" },
        });
        return;
      }

      let signedIn: { user: { id: string; email: string; name: string; role?: string; goUserId?: number | null } };
      try {
        signedIn = (await opts.auth.api.signInEmail({
          body: { email, password },
          headers: fromNodeHeaders(req.headers),
        })) as typeof signedIn;
      } catch {
        res.status(401).json({
          success: false,
          message: "unauthorized",
          errors: { auth: "invalid credentials" },
        });
        return;
      }

      if (!signedIn?.user) {
        res.status(401).json({
          success: false,
          message: "unauthorized",
          errors: { auth: "invalid credentials" },
        });
        return;
      }

      const u = signedIn.user;
      let goUserId = u.goUserId ?? null;
      if (goUserId == null || !Number.isInteger(goUserId) || goUserId < 1) {
        try {
          goUserId = await ensureGoUserId(opts.env.GO_API_BASE_URL, {
            name: u.name || "",
            email: u.email,
            password,
          });
        } catch (err) {
          res.status(403).json({
            success: false,
            message: "go user not linked",
            errors: {
              goUserId: err instanceof Error ? err.message : "Failed to link Go user",
            },
          });
          return;
        }
      }

      const sessionUser: SessionUser = {
        id: u.id,
        email: u.email,
        name: u.name,
        role: (u.role ?? "driver") as Role,
        goUserId,
      };
      const result = await mintForSessionUser(sessionUser);
      if ("error" in result) {
        res.status(403).json({
          success: false,
          message: "go user not linked",
          errors: { goUserId: "Go user link failed" },
        });
        return;
      }
      res.json(mintPayload(result.user, result.token, expiresInSeconds));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
