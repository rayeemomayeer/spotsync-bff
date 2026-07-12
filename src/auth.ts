import { betterAuth } from "better-auth";
import { Pool } from "pg";
import type { Env } from "./env.js";

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
            const body = ctx?.body as { role?: unknown } | undefined;
            return {
              data: {
                ...user,
                role: resolveSignupRole(body?.role),
              },
            };
          },
        },
      },
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
