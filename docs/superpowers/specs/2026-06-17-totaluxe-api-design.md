# TotaLuxe API — design

**Date:** 2026-06-17
**Status:** approved (build directly per user direction)

## Goal

Add server-side auth + shared quote storage for the `totaluxe` module, backed by
the existing Railway Postgres. The PWA client already calls these endpoints and
falls back to local PIN + IndexedDB when they're unavailable, so the server only
needs to behave correctly when online.

## Scope

- `POST /api/auth/login` — body `{pin, module}`. Look up the PIN in the server's
  hardcoded user list for that module. On match, store the user in the session
  and return `{user}` (without the PIN). On no match, `401`.
- `POST /api/auth/logout` — destroy the session, return `{ok:true}`.
- `GET /api/quotes` — auth required. Return `{quotes:[...]}` (the full stored
  quote objects) for the session user's module. If the user is `signedOnly`
  (surveyor), filter to `status = 'Signed'`. Order by `saved_at` desc.
- `POST /api/quotes` — auth required. Body is a full quote object (`{id, ...}`,
  up to ~500 KB). Upsert by `(module, id)`; store the whole object as JSONB.
- `DELETE /api/quotes/:id` — auth required. Delete by `(module, id)`.

## Users (hardcoded, server-side)

PINs are already visible in the client HTML — they select role/identity, not
real secrets (internal staff tool). Mirrors the client's `USERS_SEED`:

| PIN  | u        | name          | role     | signedOnly |
|------|----------|---------------|----------|------------|
| 0000 | admin    | Administrator | admin    | false      |
| 1111 | damien   | Damien        | sales    | false      |
| 2222 | ryan     | Ryan          | sales    | false      |
| 3333 | richard  | Richard       | sales    | false      |
| 4444 | surveyor | Surveyor      | surveyor | true       |

`sections`/`docs` arrays match the client seed (`ALL_SECTIONS`/`ALL_DOCS`) so the
returned user drives the same UI nav as the local fallback.

## Data model

```
CREATE TABLE IF NOT EXISTS quotes (
  module     text        NOT NULL,
  id         text        NOT NULL,
  data       jsonb       NOT NULL,   -- the full quote object
  status     text,                   -- extracted from data.status, for filtering
  saved_by   text,
  saved_at   timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (module, id)
);
```

Created at startup when a DB is available.

## Architecture

- New `routes/api.js` exports `apiRouter(pool)` (an Express Router) and
  `apiRouter.ensureSchema(pool)`. Keeps `server.js` thin.
- `server.js`: mount `app.use('/api', apiRouter(pool))` after session middleware
  and before the 404. JSON body parsing (`express.json({limit:'50mb'})`) is scoped
  inside the router. Call `ensureSchema(pool)` at startup.
- Auth = `express-session` (already Postgres-backed via `connect-pg-simple`).
  `requireAuth` rejects unauthenticated requests with `401`; `requireDb` returns
  `503` if no pool (e.g. local dev without `DATABASE_URL`).

## Client fix (required)

`modules/totaluxe/index.html` `doLogin()` references `u` after its try/catch, but
`u` was only declared `const` inside the fallback branches → `ReferenceError` on
every path (login is broken in the current build). Fix: declare `let u;` at
function scope, assign `u=d.user` on server success and `u=admin.users.find(...)`
in both fallbacks, then a single `if(!u){...return;}` + `currentUser=u;` after the
try/catch. (This diverges from the SharePoint source until re-uploaded.)

## Verification

- `curl POST /api/auth/login` pin `0000` → 200 `{user:{role:'admin',...}}`.
- `curl GET /api/quotes` with that session cookie → 200 `{quotes:[]}`.
- POST a quote → GET shows it → DELETE → GET empty again.
- Deployed HTML contains the fixed `doLogin`; browser login completes.
