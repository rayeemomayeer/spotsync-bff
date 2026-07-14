import type { Env } from "../env.js";
import type { Role } from "../auth.js";
import { issueGoBridgeToken } from "./go-jwt.js";

async function goFetch(
  env: Env,
  path: string,
  init: RequestInit & { goUserId: number; role: Role },
): Promise<Response> {
  const token = await issueGoBridgeToken({
    goUserId: init.goUserId,
    role: init.role,
    secret: env.JWT_SECRET,
    expiresInSeconds: env.JWT_EXPIRY_SECONDS,
  });
  const base = env.GO_API_BASE_URL.replace(/\/$/, "");
  const { goUserId: _uid, role: _role, ...fetchInit } = init;
  return fetch(`${base}${path}`, {
    ...fetchInit,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(fetchInit.headers ?? {}),
    },
  });
}

export type GoOrganization = {
  id: number;
  name: string;
  slug: string;
  status: string;
  billing_plan?: string | null;
  stripe_customer_id?: string | null;
};

export async function fetchOrgMe(
  env: Env,
  goUserId: number,
  role: Role,
): Promise<GoOrganization | null> {
  const res = await goFetch(env, "/api/v1/orgs/me", {
    method: "GET",
    goUserId,
    role,
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`go org me failed (${res.status}): ${text}`);
  }
  const json = (await res.json()) as { data?: GoOrganization };
  return json.data ?? null;
}

export async function patchOrgBillingPlan(
  env: Env,
  orgId: number,
  plan: "starter" | "growth",
  stripeCustomerId?: string,
): Promise<void> {
  const goUserId = env.GO_PLATFORM_USER_ID;

  const res = await goFetch(env, `/api/v1/orgs/${orgId}/plan`, {
    method: "PATCH",
    goUserId,
    role: "saas_admin",
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
