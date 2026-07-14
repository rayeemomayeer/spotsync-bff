import { randomBytes } from "node:crypto";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { betterAuth } from "better-auth";
import { Pool } from "pg";
import type { Env } from "./env.js";
import { ensureGoUserId } from "./lib/go-user-bridge.js";
import { forwardNotify } from "./lib/notify.js";

export const roles = ["saas_admin", "org_admin", "driver"] as const;
export type Role = (typeof roles)[number];

function resolveSignupRole(_requested: unknown): Role {
  return "driver";
}

function mintBridgePassword(): string {
  return `oauth.${randomBytes(24).toString("hex")}`;
}

async function notifyOrLog(
  env: Env,
  payload: Parameters<typeof forwardNotify>[2],
): Promise<void> {
  if (!env.NOTIFY_URL || !env.NOTIFY_INTERNAL_TOKEN) {
    console.info("[auth] notify skipped (NOTIFY_URL/TOKEN unset)", payload.type, payload.email);
    return;
  }
  const result = await forwardNotify(env.NOTIFY_URL, env.NOTIFY_INTERNAL_TOKEN, payload);
  if (!result.ok) {
    console.error("[auth] notify failed", payload.type, result.status, result.body);
  }
}

export function createAuth(env: Env) {
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  const googleEnabled =
    env.GOOGLE_CLIENT_ID.length > 0 && env.GOOGLE_CLIENT_SECRET.length > 0;
  const notifyEnabled = env.NOTIFY_URL.length > 0 && env.NOTIFY_INTERNAL_TOKEN.length > 0;

  return betterAuth({
    database: pool,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins: [env.FRONTEND_ORIGIN],
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      sendResetPassword: async ({ user, url }) => {
        await notifyOrLog(env, {
          type: "password_reset",
          email: user.email,
          reset_url: url,
        });
      },
    },
    emailVerification: {
      sendOnSignUp: notifyEnabled,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        await notifyOrLog(env, {
          type: "verify_email",
          email: user.email,
          verify_url: url,
        });
      },
    },
    ...(googleEnabled
      ? {
          socialProviders: {
            google: {
              clientId: env.GOOGLE_CLIENT_ID,
              clientSecret: env.GOOGLE_CLIENT_SECRET,
            },
          },
        }
      : {}),
    // Cross-origin: Vercel app → Render BFF. Lax cookies are dropped by browsers.
    advanced: {
      defaultCookieAttributes: {
        sameSite: env.NODE_ENV === "production" ? "none" : "lax",
        secure: env.NODE_ENV === "production",
        httpOnly: true,
        partitioned: env.NODE_ENV === "production",
      },
    },
    user: {
      additionalFields: {
        role: {
          type: "string",
          required: true,
          defaultValue: "driver",
          input: false,
        },
        goUserId: {
          type: "number",
          required: false,
          input: false,
        },
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user, ctx) => {
            const body = ctx?.body as
              | { role?: unknown; password?: string; name?: string }
              | undefined;
            const provided = typeof body?.password === "string" ? body.password : "";
            // Email signup must send a real password. Social OAuth has none — mint a
            // random Go bridge password the user never sees (login stays via Google).
            if (provided.length > 0 && provided.length < 8) {
              throw new APIError("BAD_REQUEST", {
                message: "Password must be at least 8 characters",
              });
            }
            const password = provided.length >= 8 ? provided : mintBridgePassword();

            let goUserId: number;
            try {
              goUserId = await ensureGoUserId(env.GO_API_BASE_URL, {
                name: user.name || body?.name || "",
                email: user.email,
                password,
              });
            } catch (err) {
              throw new APIError("BAD_REQUEST", {
                message:
                  err instanceof Error
                    ? err.message
                    : "Failed to provision Go user for bridge",
              });
            }

            return {
              data: {
                ...user,
                role: resolveSignupRole(body?.role),
                goUserId,
              },
            };
          },
        },
      },
    },
    hooks: {
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-in/email") return;

        const session = ctx.context.newSession;
        if (!session) return;
        const user = session.user as {
          id: string;
          email: string;
          name?: string;
          goUserId?: number | null;
        };
        if (
          user.goUserId != null &&
          Number.isInteger(user.goUserId) &&
          user.goUserId >= 1
        ) {
          return;
        }

        const body = ctx.body as { password?: string } | undefined;
        if (!body?.password) return;

        try {
          const goUserId = await ensureGoUserId(env.GO_API_BASE_URL, {
            name: user.name || "",
            email: user.email,
            password: body.password,
          });
          await pool.query(
            `UPDATE "user" SET "goUserId" = $1 WHERE id = $2`,
            [goUserId, user.id],
          );
          user.goUserId = goUserId;
        } catch (err) {
          console.error("goUserId link on sign-in failed", err);
        }
      }),
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  goUserId?: number | null;
};
