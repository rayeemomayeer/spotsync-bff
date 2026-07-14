import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),
  FRONTEND_ORIGIN: z.string().url(),
  GO_API_BASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(16),
  JWT_EXPIRY_SECONDS: z.coerce.number().int().positive().default(300),
  STRIPE_SECRET_KEY: z.string().optional().default(""),
  STRIPE_WEBHOOK_SECRET: z.string().optional().default(""),
  STRIPE_PRICE_STARTER: z.string().optional().default(""),
  STRIPE_PRICE_GROWTH: z.string().optional().default(""),
  /** Optional spotsync-notify base URL (e.g. http://localhost:3100). */
  NOTIFY_URL: z
    .string()
    .optional()
    .default("")
    .transform((v) => v.trim())
    .refine((v) => v === "" || z.string().url().safeParse(v).success, {
      message: "Invalid url",
    }),
  GOOGLE_CLIENT_ID: z.string().optional().default(""),
  GOOGLE_CLIENT_SECRET: z.string().optional().default(""),
  GO_PLATFORM_USER_ID: z.coerce.number().int().positive().default(1),
  NOTIFY_INTERNAL_TOKEN: z.string().optional().default(""),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment: ${detail}`);
  }
  const env = parsed.data;
  const goOrigin = new URL(env.GO_API_BASE_URL).origin;
  const bffOrigin = new URL(env.BETTER_AUTH_URL).origin;
  if (goOrigin === bffOrigin) {
    throw new Error(
      "GO_API_BASE_URL must point at the Go API, not the BFF (would cause a proxy loop)",
    );
  }
  return env;
}
