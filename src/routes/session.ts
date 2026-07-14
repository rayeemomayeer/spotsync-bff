import { Router } from "express";
import type { Auth } from "../auth.js";
import type { Env } from "../env.js";
import { createRequireSession } from "../middleware/session.js";
import { issueGoBridgeToken } from "../lib/go-jwt.js";

/**
 * Mint a Go API JWT from the Better Auth cookie session.
 * Frontend stores this so /api/v1 calls work even when third-party
 * cookies are flaky across Vercel → Render.
 */
export function createSessionRouter(opts: { auth: Auth; env: Env }): Router {
  const router = Router();
  const requireSession = createRequireSession(opts.auth);

  router.get("/go-token", requireSession, async (req, res, next) => {
    try {
      const user = req.sessionUser!;
      if (user.goUserId == null || !Number.isInteger(user.goUserId) || user.goUserId < 1) {
        res.status(403).json({
          success: false,
          message: "go user not linked",
          errors: {
            goUserId: "Sign out and sign in once so BFF can link your Go user",
          },
        });
        return;
      }

      // Client-held tokens need longer life than hop-by-hop proxy bridges.
      const expiresInSeconds = Math.max(opts.env.JWT_EXPIRY_SECONDS, 60 * 60 * 12);
      const token = await issueGoBridgeToken({
        goUserId: user.goUserId,
        role: user.role,
        secret: opts.env.JWT_SECRET,
        expiresInSeconds,
      });

      res.json({
        success: true,
        message: "ok",
        data: {
          token,
          expires_in: expiresInSeconds,
          role: user.role,
          go_user_id: user.goUserId,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
