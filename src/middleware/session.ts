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

async function loadSessionUser(auth: Auth, req: Parameters<RequestHandler>[0]) {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });
  if (!session?.user) return undefined;

  const user = session.user as typeof session.user & {
    role?: string;
    goUserId?: number | null;
  };

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: (user.role ?? "driver") as Role,
    goUserId: user.goUserId ?? null,
  } satisfies SessionUser;
}

export function createRequireSession(auth: Auth): RequestHandler {
  return async (req, res, next) => {
    try {
      const sessionUser = await loadSessionUser(auth, req);
      if (!sessionUser) {
        res.status(401).json({
          success: false,
          message: "unauthorized",
          errors: { auth: "session required" },
        });
        return;
      }
      req.sessionUser = sessionUser;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Attach Better Auth user when cookie present; never 401. */
export function createOptionalSession(auth: Auth): RequestHandler {
  return async (req, _res, next) => {
    try {
      req.sessionUser = await loadSessionUser(auth, req);
      next();
    } catch (err) {
      next(err);
    }
  };
}
