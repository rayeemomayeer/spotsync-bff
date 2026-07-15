/** Optional forward to spotsync-notify `/internal/notify`. No-op when URL unset. */

export type NotifyPayload = {
  type: string;
  email?: string;
  zone_id?: string;
  spot_id?: string;
  user_id?: string;
  reservation_id?: string;
  license_plate?: string;
  amount_cents?: string;
  reset_url?: string;
  verify_url?: string;
  invite_url?: string;
  org_name?: string;
};

/** Best-effort — never throws into payment path. */
export async function notifyQuiet(
  env: { NOTIFY_URL: string; NOTIFY_INTERNAL_TOKEN: string },
  payload: NotifyPayload,
): Promise<void> {
  if (!env.NOTIFY_URL || !env.NOTIFY_INTERNAL_TOKEN) {
    console.info("[notify] skipped (NOTIFY unset)", payload.type);
    return;
  }
  try {
    const result = await forwardNotify(env.NOTIFY_URL, env.NOTIFY_INTERNAL_TOKEN, payload);
    if (!result.ok) {
      console.error("[notify] failed", payload.type, result.status, result.body);
    }
  } catch (err) {
    console.error("[notify] error", payload.type, err);
  }
}

export async function forwardNotify(
  baseUrl: string,
  internalToken: string,
  payload: NotifyPayload,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const url = `${baseUrl.replace(/\/$/, "")}/internal/notify`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${internalToken}`,
    },
    body: JSON.stringify(payload),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { ok: res.ok, status: res.status, body };
}
