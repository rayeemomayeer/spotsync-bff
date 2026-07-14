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

export type GoZone = {
  id: number;
  name: string;
  price_per_hour: number;
  available_spots: number;
};

export type GoReservation = {
  id: number;
  zone_id: number;
  spot_id?: number;
  license_plate: string;
  status: string;
};

export type GoPayment = {
  id: number;
  reservation_id?: number;
  user_id: number;
  stripe_payment_intent_id: string;
  amount_cents: number;
  status: string;
};

async function parseGoData<T>(res: Response, label: string): Promise<T> {
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${label} (${res.status}): ${text}`);
  }
  const json = (await res.json()) as { data?: T };
  if (json.data == null) {
    throw new Error(`${label}: missing data`);
  }
  return json.data;
}

export async function fetchGoZone(env: Env, zoneId: number): Promise<GoZone> {
  const base = env.GO_API_BASE_URL.replace(/\/$/, "");
  const res = await fetch(`${base}/api/v1/zones/${zoneId}`, {
    headers: { Accept: "application/json" },
  });
  return parseGoData<GoZone>(res, "go zone fetch failed");
}

export async function createGoReservation(
  env: Env,
  goUserId: number,
  body: { zone_id: number; license_plate: string; spot_id?: number },
  idempotencyKey: string,
): Promise<GoReservation> {
  const res = await goFetch(env, "/api/v1/reservations", {
    method: "POST",
    goUserId,
    role: "driver",
    body: JSON.stringify(body),
    headers: { "Idempotency-Key": idempotencyKey },
  });
  return parseGoData<GoReservation>(res, "go reservation create failed");
}

export async function cancelGoReservation(
  env: Env,
  goUserId: number,
  reservationId: number,
): Promise<void> {
  const res = await goFetch(env, `/api/v1/reservations/${reservationId}`, {
    method: "DELETE",
    goUserId,
    role: "driver",
  });
  if (!res.ok && res.status !== 204) {
    const text = await res.text();
    throw new Error(`go reservation cancel failed (${res.status}): ${text}`);
  }
}

export async function recordGoPayment(
  env: Env,
  goUserId: number,
  body: {
    reservation_id: number;
    stripe_payment_intent_id: string;
    amount_cents: number;
    currency?: string;
  },
): Promise<GoPayment> {
  const res = await goFetch(env, "/api/v1/payments", {
    method: "POST",
    goUserId,
    role: "driver",
    body: JSON.stringify(body),
  });
  return parseGoData<GoPayment>(res, "go payment record failed");
}

export async function fetchGoPayment(
  env: Env,
  goUserId: number,
  role: Role,
  paymentId: number,
): Promise<GoPayment> {
  const res = await goFetch(env, `/api/v1/payments/${paymentId}`, {
    method: "GET",
    goUserId,
    role,
  });
  return parseGoData<GoPayment>(res, "go payment fetch failed");
}

export async function recordGoRefund(
  env: Env,
  goUserId: number,
  role: Role,
  paymentId: number,
  body: { stripe_refund_id: string; amount_cents: number },
): Promise<void> {
  const res = await goFetch(env, `/api/v1/payments/${paymentId}/refunds`, {
    method: "POST",
    goUserId,
    role,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`go refund record failed (${res.status}): ${text}`);
  }
}
