import "dotenv/config";
import { createAuth } from "./src/auth.js";
import { loadEnv } from "./src/env.js";

/** CLI entry for `npx @better-auth/cli migrate --config ./better-auth.config.ts` */
export const auth = createAuth(loadEnv());
