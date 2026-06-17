'use strict';

/**
 * UCS Design Group — PWA platform server
 *
 * A thin Express shell that hosts self-contained HTML "app modules" under
 * route prefixes (e.g. /totaluxe/) and provides shared platform
 * infrastructure: security headers, gzip, Postgres-backed sessions, a PWA
 * manifest + service worker, and a /health endpoint for Railway health checks.
 */

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const session = require('express-session');
const { Pool } = require('pg');
const apiRouter = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

// Railway terminates TLS at a proxy in front of the app. Trusting the first
// proxy hop lets secure cookies and req.protocol behave correctly.
app.set('trust proxy', 1);

// ---------------------------------------------------------------------------
// Postgres connection pool
// ---------------------------------------------------------------------------
// Railway injects DATABASE_URL when a Postgres database is attached. Internal
// connections (*.railway.internal) don't need TLS; external/public proxy
// connections do. Locally, DATABASE_URL may be absent — the app still boots.
let pool = null;
if (process.env.DATABASE_URL) {
  const url = process.env.DATABASE_URL;
  const needsSsl = !url.includes('railway.internal') && !url.includes('localhost');
  pool = new Pool({
    connectionString: url,
    ssl: needsSsl ? { rejectUnauthorized: false } : false,
    max: 5,
  });
  pool.on('error', (err) => console.error('[pg] idle client error:', err.message));
  // Create the quotes table on startup (best-effort; logged on failure).
  apiRouter
    .ensureSchema(pool)
    .then(() => console.log('[startup] quotes table ready'))
    .catch((err) => console.error('[startup] quotes schema init failed:', err.message));
} else {
  console.warn('[startup] DATABASE_URL not set — running without Postgres (sessions will use in-memory store).');
}

// ---------------------------------------------------------------------------
// Core middleware
// ---------------------------------------------------------------------------
app.use(compression());

// The hosted modules are self-contained single-file HTML apps that rely on
// inline <style>/<script> and talk directly to third-party APIs (e.g.
// api.signable.co.uk). A strict CSP would break them, so CSP is disabled here
// and left as a future hardening step (per-module CSP). All other helmet
// protections (HSTS, no-sniff, frameguard, etc.) remain enabled.
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);

// ---------------------------------------------------------------------------
// Sessions (Postgres-backed via connect-pg-simple when a DB is available)
// ---------------------------------------------------------------------------
const sessionConfig = {
  secret: process.env.SESSION_SECRET || 'dev-insecure-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: IS_PROD, // requires HTTPS in production (Railway provides it)
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 12, // 12 hours
  },
};

if (pool) {
  const PgSession = require('connect-pg-simple')(session);
  sessionConfig.store = new PgSession({
    pool,
    tableName: 'session',
    createTableIfMissing: true,
  });
}

if (!process.env.SESSION_SECRET) {
  console.warn('[startup] SESSION_SECRET not set — using an insecure development fallback.');
}

app.use(session(sessionConfig));

// ---------------------------------------------------------------------------
// API routes (server-side auth + shared quote storage). JSON body parsing is
// scoped inside this router so it doesn't affect the static module/asset routes.
// ---------------------------------------------------------------------------
app.use('/api', apiRouter(pool));

// ---------------------------------------------------------------------------
// Health check (used by Railway)
// ---------------------------------------------------------------------------
app.get('/health', async (req, res) => {
  const payload = {
    status: 'ok',
    service: 'ucs-platform',
    version: require('./package.json').version,
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV || 'development',
    database: 'not_configured',
  };

  if (pool) {
    try {
      await pool.query('SELECT 1');
      payload.database = 'connected';
    } catch (err) {
      payload.database = 'error';
      payload.databaseError = err.message;
    }
  }

  res.status(200).json(payload);
});

// ---------------------------------------------------------------------------
// App modules
// ---------------------------------------------------------------------------
// Each module is a directory under /modules served as static files under its
// own route prefix. Add new modules here as they land in the App Modules
// SharePoint folder.
const MODULES = [
  { slug: 'totaluxe', title: 'TotaLuxe — Veranda Sales Suite' },
];

for (const mod of MODULES) {
  const dir = path.join(__dirname, 'modules', mod.slug);
  // Serving the module as static files at its prefix means both `/totaluxe`
  // and `/totaluxe/` resolve to index.html (Express uses non-strict routing).
  // The module is a self-contained single file, so the trailing slash does not
  // affect internal asset resolution.
  app.use(`/${mod.slug}`, express.static(dir, { index: 'index.html', extensions: ['html'] }));
}

// ---------------------------------------------------------------------------
// Static platform assets (manifest, service worker, icons, landing page)
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Fallbacks
// ---------------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`[startup] UCS platform listening on port ${PORT} (${process.env.NODE_ENV || 'development'})`);
  console.log(`[startup] Modules: ${MODULES.map((m) => `/${m.slug}/`).join(', ')}`);
});
