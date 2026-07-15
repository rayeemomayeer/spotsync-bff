# SpotSync BFF

Express + TypeScript backend-for-frontend. Handles Better Auth (email/password),
proxies `/api/v1/*` to the Go reservation API with a short-lived HS256 JWT,
exposes a Stripe TEST webhook stub, and optionally forwards email/notify events
to `spotsync-notify`.

## Stack

- Express + TypeScript (`type: module`)
- Better Auth + Postgres (`pg` Pool)
- Zod env validation, Helmet, CORS, rate limit
- `jose` HS256 bridge tokens (`id` + `role`) shared with Go via `JWT_SECRET`

## Roles

| Role | Public signup |
|------|----------------|
| `driver` | default (only public role) |
| `org_admin` | not via signup — set in DB/admin |
| `saas_admin` | never via public signup |

`user.role` additional field uses `input: false`. Create hook forces `driver`
(and remaps any attempted `saas_admin`).

## Go JWT bridge

Proxy requires `user.goUserId` (numeric, matches Go `users.id`). On email
sign-up (and sign-in when missing), BFF calls Go `/auth/register` (or `/auth/login`
on conflict) and stores the returned id on the Better Auth user. Bridge JWT claims:

```json
{ "id": 123, "role": "driver", "iat": ..., "exp": ... }
```

Signed HS256 with `JWT_SECRET` (same secret Go uses).

## Routes

| Method | Path | Notes |
|--------|------|--------|
| * | `/api/auth/*` | Better Auth handler |
| GET | `/healthz` | Liveness |
| GET | `/api/session/go-token` | Session → longer-lived Go JWT for SPA |
| * | `/api/v1/*` | Optional session → Go proxy (bridge JWT) |
| POST | `/api/checkout/*` | Driver quote / Checkout / demo-confirm / refund |
| POST | `/api/stripe/*` | Org subscription + webhook (test mode) |
| POST | `/api/stripe/webhook` | Stripe TEST webhook |
| POST | `/api/notify` | Optional forward to spotsync-notify |

## Notify forward (optional)

Set `NOTIFY_URL` (e.g. `http://localhost:3100`) and `NOTIFY_INTERNAL_TOKEN`
(same as notify `INTERNAL_TOKEN`). Body matches notify event schema
(`reservation_confirmed`, `password_reset`, …). Returns `503` when unset.

## Local run

```bash
cp .env.example .env
# fill DATABASE_URL, secrets, FRONTEND_ORIGIN, GO_API_BASE_URL, JWT_SECRET

npm install
npx @better-auth/cli migrate   # create Better Auth tables (once DB is up)
npm run dev
```

Build / production:

```bash
npm run build
npm start
```

Sibling services (separate repos): Go API (`SpotSync-server`), web (`spotsync-web`),
notify (`spotsync-notify` on `:3100`).

## Render (free)

`render.yaml` defines a free web service. Set env vars in the Render dashboard
(especially `DATABASE_URL`, secrets, `FRONTEND_ORIGIN`, `GO_API_BASE_URL`).
Use a free Postgres instance or external provider; free web services sleep on idle.
