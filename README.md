# UCS Platform

A lightweight Node.js / Express **PWA platform** for UCS Design Group. It hosts
self-contained HTML "app modules" under route prefixes and provides shared
infrastructure: security headers, gzip compression, Postgres-backed sessions, a
PWA manifest + service worker, and a health-check endpoint.

## Routes

| Route          | Purpose                                             |
| -------------- | --------------------------------------------------- |
| `/`            | Platform landing page (module directory)            |
| `/health`      | JSON health check (used by Railway)                 |
| `/totaluxe/`   | TotaLuxe — Veranda Sales Suite (app module)         |
| `/manifest.webmanifest`, `/service-worker.js` | PWA assets         |

## App modules

Modules live under `modules/<slug>/` as static files (each is a self-contained
HTML app) and are registered in the `MODULES` array in `server.js`.

**Source of record:** the SharePoint folder
**TotaLuxe by UCS Design (App Modules)**
(`sites/TotaLuxe551/Shared Documents/TotaLuxe by UCS Design (App Modules)`).
When a module is updated there, copy the new file into the matching
`modules/<slug>/index.html` and commit.

Currently bundled:

- `modules/totaluxe/index.html` — `totaluxe-veranda-app-v76.html`

## Local development

```bash
npm install
cp .env.example .env   # then edit SESSION_SECRET
npm run dev            # node --watch server.js
```

The app boots without `DATABASE_URL` (sessions fall back to an in-memory store).
With `DATABASE_URL` set, sessions are stored in Postgres via `connect-pg-simple`
(the `session` table is created automatically).

## Environment variables

| Variable         | Required        | Notes                                            |
| ---------------- | --------------- | ------------------------------------------------ |
| `SESSION_SECRET` | yes (prod)      | Long random string used to sign session cookies. |
| `NODE_ENV`       | `production`    | Enables secure cookies and HSTS.                 |
| `DATABASE_URL`   | injected by Railway | Postgres connection string.                  |
| `PORT`           | injected        | Listen port (defaults to 3000 locally).          |

## Deployment (Railway)

Build: NIXPACKS. Start: `node server.js`. Health check: `/health`.
Attach a PostgreSQL database so `DATABASE_URL` is injected automatically.

## Security note

Content-Security-Policy is currently **disabled** in `server.js` because the
bundled module is a single-file app with inline scripts/styles that calls
third-party APIs directly (e.g. `api.signable.co.uk`). Hardening to a per-module
CSP is a recommended follow-up. All other Helmet protections remain enabled.
