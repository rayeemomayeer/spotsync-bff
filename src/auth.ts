import { APIError, createAuthMiddleware } from "better-auth/api";
import { betterAuth } from "better-auth";
import { Pool } from "pg";
import type { Env } from "./env.js";
import { ensureGoUserId } from "./lib/go-user-bridge.js";

export const roles = ["saas_admin", "org_admin", "driver"] as const;
export type Role = (typeof roles)[number];

function resolveSignupRole(_requested: unknown): Role {
  return "driver";
}

export type Auth = ReturnType<typeof createAuth>;

export function createAuth(env: Env) {
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  return betterAuth({
    database: pool,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins: [env.FRONTEND_ORIGIN],
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
    },
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
            const password = body?.password;
            if (!password || password.length < 8) {
              throw new APIError("BAD_REQUEST", {
                message: "Password must be at least 8 characters",
              });
            }

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

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  goUserId?: number | null;
};
