/** Optional forward to spotsync-notify `/internal/notify`. No-op when URL unset. */

export type NotifyPayload = {
  type: string;
  email?: string;
  zone_id?: string;
  spot_id?: string;
  user_id?: string;
  reservation_id?: string;
  license_plate?: string;
  reset_url?: string;
  verify_url?: string;
  invite_url?: string;
  org_name?: string;
};

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
