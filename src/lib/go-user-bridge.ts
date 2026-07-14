type GoEnvelope<T> = {
  success: boolean;
  message?: string;
  data?: T;
  errors?: Record<string, string>;
};

type GoUser = {
  id: number;
  email: string;
  name: string;
  role: string;
};

export type BridgeCredentials = {
  name: string;
  email: string;
  password: string;
};

/**
 * Ensures a Go `users` row exists for this email and returns its id.
 * Register first; on conflict (email taken), login to recover the id.
 * Passwords must match what was used at Go registration for the login fallback.
 */
export async function ensureGoUserId(
  goApiBaseUrl: string,
  creds: BridgeCredentials,
): Promise<number> {
  const base = goApiBaseUrl.replace(/\/$/, "");
  const name = sanitizeName(creds.name, creds.email);
  const email = creds.email.trim().toLowerCase();
  const password = creds.password;

  const registered = await postJSON<GoUser>(`${base}/api/v1/auth/register`, {
    name,
    email,
    password,
    role: "driver",
  });

  if (registered.ok && registered.body.data?.id != null) {
    return registered.body.data.id;
  }

  if (registered.status === 409 || registered.status === 400) {
    const loggedIn = await postJSON<{ token: string; user: GoUser }>(
      `${base}/api/v1/auth/login`,
      { email, password },
    );
    if (loggedIn.ok && loggedIn.body.data?.user?.id != null) {
      return loggedIn.body.data.user.id;
    }
  }

  const detail =
    registered.body.message ||
    Object.values(registered.body.errors ?? {})[0] ||
    `Go register failed (${registered.status})`;
  throw new Error(detail);
}

function sanitizeName(name: string, email: string): string {
  const trimmed = name.trim();
  if (trimmed.length >= 2) return trimmed.slice(0, 255);
  const local = email.split("@")[0]?.trim() || "driver";
  return local.length >= 2 ? local.slice(0, 255) : `u${local}`.padEnd(2, "x");
}

async function postJSON<T>(
  url: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; body: GoEnvelope<T> }> {
  const attempts = 5;
  let lastStatus = 0;
  let lastBody: GoEnvelope<T> = { success: false };

  for (let i = 0; i < attempts; i++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60_000);
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      let parsed: GoEnvelope<T> = { success: false };
      try {
        parsed = (await res.json()) as GoEnvelope<T>;
      } catch {
        parsed = { success: false, message: "invalid JSON from Go API" };
      }

      lastStatus = res.status;
      lastBody = parsed;

      if (res.ok && parsed.success === true) {
        return { ok: true, status: res.status, body: parsed };
      }
      // Do not retry client errors (except rate limit / request timeout).
      if (
        res.status >= 400 &&
        res.status < 500 &&
        res.status !== 408 &&
        res.status !== 429
      ) {
        return { ok: false, status: res.status, body: parsed };
      }
    } catch {
      /* Go cold start / network — retry */
    }
    if (i < attempts - 1) {
      await new Promise((r) => setTimeout(r, Math.min(8_000, 1_200 * 2 ** i)));
    }
  }

  return { ok: false, status: lastStatus || 503, body: lastBody };
}
