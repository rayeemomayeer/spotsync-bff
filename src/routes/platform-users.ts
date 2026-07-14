import { Router, type RequestHandler } from "express";
import type { Pool } from "pg";
import type { Auth, Role } from "../auth.js";
import { createRequireSession } from "../middleware/session.js";

function requireRoles(roles: Role[]): RequestHandler {
  return (req, res, next) => {
    const role = req.sessionUser?.role;
    if (!role || !roles.includes(role)) {
      res.status(403).json({
        success: false,
        message: "forbidden",
        errors: { role: `requires ${roles.join(" or ")}` },
      });
      return;
    }
    next();
  };
}

export type PlatformUserRow = {
  id: string;
  name: string;
  email: string;
  role: string;
  go_user_id: number | null;
  email_verified: boolean;
  created_at: string | null;
};

/**
 * Lists Better Auth users for saas_admin (additive BFF surface — not Go contract).
 */
export function createPlatformUsersRouter(opts: { auth: Auth; pool: Pool }) {
  const router = Router();
  router.use(createRequireSession(opts.auth));
  router.use(requireRoles(["saas_admin"]));

  router.get("/users", async (_req, res, next) => {
    try {
      const { rows } = await opts.pool.query<{
        id: string;
        name: string | null;
        email: string;
        role: string | null;
        goUserId: number | null;
        emailVerified: boolean | null;
        createdAt: Date | string | null;
      }>(
        `SELECT id, name, email, role, "goUserId", "emailVerified", "createdAt"
         FROM "user"
         ORDER BY "createdAt" DESC NULLS LAST
         LIMIT 200`,
      );

      const data: PlatformUserRow[] = rows.map((r) => ({
        id: r.id,
        name: r.name ?? "",
        email: r.email,
        role: r.role ?? "driver",
        go_user_id: r.goUserId,
        email_verified: Boolean(r.emailVerified),
        created_at:
          r.createdAt instanceof Date
            ? r.createdAt.toISOString()
            : r.createdAt
              ? String(r.createdAt)
              : null,
      }));

      res.json({
        success: true,
        message: "Platform users",
        data,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
