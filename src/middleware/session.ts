import type { RequestHandler } from "express";
import { fromNodeHeaders } from "better-auth/node";
import type { Auth, Role, SessionUser } from "../auth.js";

declare global {
  namespace Express {
    interface Request {
      sessionUser?: SessionUser;
    }
  }
}

export function createRequireSession(auth: Auth): RequestHandler {
  return async (req, res, next) => {
    try {
      const session = await auth.api.getSession({
        headers: fromNodeHeaders(req.headers),
      });

      if (!session?.user) {
        res.status(401).json({
          success: false,
          message: "unauthorized",
          errors: { auth: "session required" },
        });
        return;
      }

      const user = session.user as typeof session.user & {
        role?: string;
        goUserId?: number | null;
      };

      req.sessionUser = {
        id: user.id,
        email: user.email,
        name: user.name,
        role: (user.role ?? "driver") as Role,
        goUserId: user.goUserId ?? null,
      };

      next();
    } catch (err) {
      next(err);
    }
  };
}
