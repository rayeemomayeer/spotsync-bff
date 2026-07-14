import { Router, type RequestHandler, json } from "express";
import type { Pool } from "pg";
import type { Auth, Role } from "../auth.js";
import type { Env } from "../env.js";
import { issueGoBridgeToken } from "../lib/go-jwt.js";
import { createRequireSession } from "../middleware/session.js";

type GoOrg = {
  id: number;
  name: string;
  slug: string;
  status: string;
  billing_plan?: string | null;
};

/**
 * Driver self-apply for an organization.
 * Calls Go POST /orgs/apply, then promotes Better Auth role → org_admin.
 */
export function createOrgApplyRouter(opts: {
  auth: Auth;
  env: Env;
  pool: Pool;
}): Router {
  const router = Router();

  const apply: RequestHandler = async (req, res) => {
    const user = req.sessionUser;
    if (!user) {
      res.status(401).json({
        success: false,
        message: "unauthorized",
        errors: { session: "sign in required" },
      });
      return;
    }
    if (user.role === "saas_admin") {
      res.status(400).json({
        success: false,
        message: "use platform create",
        errors: { role: "Platform admins create orgs via /platform/orgs" },
      });
      return;
    }
    if (user.goUserId == null || user.goUserId < 1) {
      res.status(403).json({
        success: false,
        message: "go user not linked",
        errors: {
          goUserId: "Sign out and sign in once so BFF can link your Go user",
        },
      });
      return;
    }

    const body = req.body as { name?: string; slug?: string };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const slug = typeof body.slug === "string" ? body.slug.trim().toLowerCase() : "";
    if (name.length < 2 || slug.length < 2) {
      res.status(400).json({
        success: false,
        message: "invalid body",
        errors: {
          ...(name.length < 2 ? { name: "min 2 characters" } : {}),
          ...(slug.length < 2 ? { slug: "min 2 characters" } : {}),
        },
      });
      return;
    }

    const token = await issueGoBridgeToken({
      goUserId: user.goUserId,
      role: user.role as Role,
      secret: opts.env.JWT_SECRET,
      expiresInSeconds: opts.env.JWT_EXPIRY_SECONDS,
    });
    const base = opts.env.GO_API_BASE_URL.replace(/\/$/, "");
    let goRes: Response;
    try {
      goRes = await fetch(`${base}/api/v1/orgs/apply`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ name, slug }),
      });
    } catch (err) {
      console.error("[orgs/apply] go upstream failed", err);
      res.status(502).json({
        success: false,
        message: "upstream unavailable",
        errors: { go: "organization apply failed" },
      });
      return;
    }

    const text = await goRes.text();
    let goJson: {
      success?: boolean;
      message?: string;
      data?: GoOrg;
      errors?: Record<string, string>;
    } = {};
    try {
      goJson = JSON.parse(text) as typeof goJson;
    } catch {
      goJson = { success: false, message: text.slice(0, 200) };
    }

    if (!goRes.ok || !goJson.success || !goJson.data) {
      res.status(goRes.status >= 400 && goRes.status < 600 ? goRes.status : 502).json({
        success: false,
        message: goJson.message ?? "organization apply failed",
        errors: goJson.errors ?? { apply: "failed" },
      });
      return;
    }

    if (user.role !== "org_admin") {
      try {
        await opts.pool.query(`UPDATE "user" SET role = $1 WHERE id = $2`, [
          "org_admin",
          user.id,
        ]);
      } catch (err) {
        console.error("[orgs/apply] failed to promote Better Auth role", err);
        res.status(502).json({
          success: false,
          message: "org created but session role update failed — sign out/in",
          errors: { role: "re-login required" },
          data: goJson.data,
        });
        return;
      }
    }

    res.status(201).json({
      success: true,
      message: goJson.message ?? "Organization application submitted",
      data: {
        ...goJson.data,
        role: "org_admin",
      },
    });
  };

  router.post("/apply", json(), createRequireSession(opts.auth), apply);
  return router;
}
