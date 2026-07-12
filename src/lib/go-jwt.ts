import { SignJWT } from "jose";
import type { Role } from "../auth.js";

/**
 * Issues a short-lived HS256 JWT matching Go `platform.TokenClaims`
 * (`id` uint + `role` string + standard exp/iat).
 */
export async function issueGoBridgeToken(opts: {
  goUserId: number;
  role: Role;
  secret: string;
  expiresInSeconds: number;
}): Promise<string> {
  const key = new TextEncoder().encode(opts.secret);
  return new SignJWT({
    id: opts.goUserId,
    role: opts.role,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${opts.expiresInSeconds}s`)
    .sign(key);
}
