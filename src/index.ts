import "dotenv/config";
import { initSentry } from "./lib/sentry.js";
import { createApp } from "./app.js";
import { loadEnv } from "./env.js";

initSentry();

const env = loadEnv();
const app = createApp(env);

const googleOauth =
  env.GOOGLE_CLIENT_ID.length > 0 && env.GOOGLE_CLIENT_SECRET.length > 0;
console.info(`[bff] google_oauth=${googleOauth ? "on" : "off"}`);

app.listen(env.PORT, () => {
  console.info(`[bff] listening on :${env.PORT} (${env.NODE_ENV})`);
});
