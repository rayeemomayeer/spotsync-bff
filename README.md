# SpotSync BFF

Express + TypeScript backend-for-frontend. Handles Better Auth (email/password),
proxies `/api/v1/*` to the Go reservation API with a short-lived HS256 JWT, and
exposes a Stripe TEST webhook stub.

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

Proxy requires `user.goUserId` (numeric, matches Go `users.id`). Set it in the
Better Auth `user` row after linking/syncing with Go. Bridge JWT claims:

```json
{ "id": 123, "role": "driver", "iat": ..., "exp": ... }
```

Signed HS256 with `JWT_SECRET` (same secret Go uses).

## Routes

| Method | Path | Notes |
|--------|------|--------|
| * | `/api/auth/*` | Better Auth handler |
| GET | `/healthz` | Liveness |
| * | `/api/v1/*` | Session required → Go proxy |
| POST | `/api/stripe/webhook` | Stripe TEST webhook stub |

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

## Render (free)

`render.yaml` defines a free web service. Set env vars in the Render dashboard
(especially `DATABASE_URL`, secrets, `FRONTEND_ORIGIN`, `GO_API_BASE_URL`).
Use a free Postgres instance or external provider; free web services sleep on idle.
