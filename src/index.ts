import "dotenv/config";
import { initSentry } from "./lib/sentry.js";
import { createApp } from "./app.js";
import { loadEnv } from "./env.js";

initSentry();

const env = loadEnv();
const app = createApp(env);

app.listen(env.PORT, () => {
  console.info(`[bff] listening on :${env.PORT} (${env.NODE_ENV})`);
});
