'use strict';

/**
 * /api routes for the TotaLuxe module: server-side auth + shared quote storage.
 *
 * Exposed as a factory so server.js can inject the shared pg Pool:
 *   app.use('/api', apiRouter(pool));
 * and initialise the schema at startup:
 *   apiRouter.ensureSchema(pool);
 *
 * The PWA client falls back to local PIN auth + IndexedDB when these endpoints
 * are unavailable, so the contract here only needs to be correct when online.
 */

const express = require('express');

// Section/doc lists mirror the client's ALL_SECTIONS / ALL_DOCS so the user
// object returned on login drives the same UI nav as the client-side fallback.
const ALL_SECTIONS = ['quotes', 'customer', 'build', 'pricing', 'docs', 'admin'];
const ALL_DOCS = ['quote', 'contract', 'survey', 'picking'];
const SALES_SECTIONS = ['quotes', 'customer', 'build', 'pricing', 'docs'];

// Hardcoded users per module. PINs are already visible in the client HTML — they
// select role/identity, not real secrets (internal staff tool). Mirrors USERS_SEED.
const USERS = {
  totaluxe: [
    { u: 'admin', pin: '0000', name: 'Administrator', role: 'admin', sections: ALL_SECTIONS, docs: ALL_DOCS, signedOnly: false },
    { u: 'damien', pin: '1111', name: 'Damien', role: 'sales', sections: SALES_SECTIONS, docs: ALL_DOCS, signedOnly: false },
    { u: 'ryan', pin: '2222', name: 'Ryan', role: 'sales', sections: SALES_SECTIONS, docs: ALL_DOCS, signedOnly: false },
    { u: 'richard', pin: '3333', name: 'Richard', role: 'sales', sections: SALES_SECTIONS, docs: ALL_DOCS, signedOnly: false },
    { u: 'surveyor', pin: '4444', name: 'Surveyor', role: 'surveyor', sections: ['quotes', 'docs'], docs: ['contract', 'survey', 'picking'], signedOnly: true },
  ],
};

// Strip the PIN before returning a user to the client / storing in the session.
function publicUser(user) {
  const { pin, ...rest } = user;
  return rest;
}

async function ensureSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS quotes (
      module     text        NOT NULL,
      id         text        NOT NULL,
      data       jsonb       NOT NULL,
      status     text,
      saved_by   text,
      saved_at   timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (module, id)
    );
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS quotes_module_status_idx ON quotes (module, status);');
}

function apiRouter(pool) {
  const router = express.Router();

  // Quote objects can be large (base64 images) — allow up to 50mb. Scoped to /api
  // so the platform's static routes aren't affected.
  router.use(express.json({ limit: '50mb' }));

  function requireAuth(req, res, next) {
    if (!req.session || !req.session.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    next();
  }

  function requireDb(req, res, next) {
    if (!pool) return res.status(503).json({ error: 'Database unavailable' });
    next();
  }

  // ---- Auth ----
  router.post('/auth/login', (req, res) => {
    const { pin, module } = req.body || {};
    const mod = module || 'totaluxe';
    const list = USERS[mod];
    if (!list) return res.status(400).json({ error: 'Unknown module' });

    const user = list.find((entry) => entry.pin === String(pin));
    if (!user) return res.status(401).json({ error: 'Incorrect PIN' });

    req.session.user = { ...publicUser(user), module: mod };
    res.json({ user: req.session.user });
  });

  router.post('/auth/logout', (req, res) => {
    if (!req.session) return res.json({ ok: true });
    req.session.destroy(() => {
      res.clearCookie('connect.sid');
      res.json({ ok: true });
    });
  });

  // ---- Quotes (shared across all users in the module) ----
  router.get('/quotes', requireAuth, requireDb, async (req, res, next) => {
    try {
      const { module, signedOnly } = req.session.user;
      const params = [module];
      let sql = 'SELECT data FROM quotes WHERE module = $1';
      if (signedOnly) {
        params.push('Signed');
        sql += ' AND status = $2';
      }
      sql += ' ORDER BY saved_at DESC NULLS LAST';
      const result = await pool.query(sql, params);
      res.json({ quotes: result.rows.map((row) => row.data) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/quotes', requireAuth, requireDb, async (req, res, next) => {
    try {
      const { module, name } = req.session.user;
      const quote = req.body;
      if (!quote || !quote.id) return res.status(400).json({ error: 'Quote id required' });

      const status = quote.status || 'Draft';
      const savedBy = quote.savedBy || name;
      const savedAt = quote.savedAt || new Date().toISOString();

      await pool.query(
        `INSERT INTO quotes (module, id, data, status, saved_by, saved_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (module, id) DO UPDATE
           SET data = EXCLUDED.data,
               status = EXCLUDED.status,
               saved_by = EXCLUDED.saved_by,
               saved_at = EXCLUDED.saved_at,
               updated_at = now()`,
        [module, quote.id, quote, status, savedBy, savedAt]
      );
      res.json({ ok: true, id: quote.id });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/quotes/:id', requireAuth, requireDb, async (req, res, next) => {
    try {
      const { module } = req.session.user;
      await pool.query('DELETE FROM quotes WHERE module = $1 AND id = $2', [module, req.params.id]);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

apiRouter.ensureSchema = ensureSchema;
module.exports = apiRouter;
