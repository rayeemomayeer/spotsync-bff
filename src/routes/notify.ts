import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { forwardNotify } from "../lib/notify.js";

const bodySchema = z.object({
  type: z.enum([
    "reservation_confirmed",
    "reservation_cancelled",
    "password_reset",
    "verify_email",
    "org_invite",
  ]),
  email: z.string().email().optional(),
  zone_id: z.string().optional(),
  spot_id: z.string().optional(),
  user_id: z.string().optional(),
  reservation_id: z.string().optional(),
  license_plate: z.string().optional(),
  reset_url: z.string().url().optional(),
  verify_url: z.string().url().optional(),
  invite_url: z.string().url().optional(),
  org_name: z.string().optional(),
});

export function createNotifyRouter(opts: {
  notifyUrl: string;
  notifyInternalToken: string;
}): Router {
  const router = Router();

  const postNotify: RequestHandler = async (req, res) => {
    if (!opts.notifyUrl || !opts.notifyInternalToken) {
      res.status(503).json({
        success: false,
        message: "notify not configured",
        errors: {
          notify: "NOTIFY_URL and NOTIFY_INTERNAL_TOKEN required",
        },
      });
      return;
    }

    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        message: "validation failed",
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    try {
      const result = await forwardNotify(
        opts.notifyUrl,
        opts.notifyInternalToken,
        parsed.data,
      );
      res.status(result.status).json(
        result.body ?? {
          success: result.ok,
          message: result.ok ? "forwarded" : "notify upstream error",
        },
      );
    } catch (err) {
      console.error("[bff] notify forward failed", err);
      res.status(502).json({
        success: false,
        message: "notify upstream unreachable",
        errors: { notify: "connection failed" },
      });
    }
  };

  router.post("/", postNotify);
  return router;
}
