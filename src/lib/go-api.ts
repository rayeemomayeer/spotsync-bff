import type { Env } from "../env.js";
import { issueGoBridgeToken } from "./go-jwt.js";

export async function patchOrgBillingPlan(
  env: Env,
  orgId: number,
  plan: "starter" | "growth",
  stripeCustomerId?: string,
): Promise<void> {
  const goUserId = env.GO_PLATFORM_USER_ID;

  const token = await issueGoBridgeToken({
    goUserId,
    role: "saas_admin",
    secret: env.JWT_SECRET,
    expiresInSeconds: env.JWT_EXPIRY_SECONDS,
  });

  const base = env.GO_API_BASE_URL.replace(/\/$/, "");
  const res = await fetch(`${base}/api/v1/orgs/${orgId}/plan`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      plan,
      stripe_customer_id: stripeCustomerId ?? "",
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`go org plan patch failed (${res.status}): ${text}`);
  }
}
