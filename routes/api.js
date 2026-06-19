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
const msal = require('@azure/msal-node');

// Section/doc lists mirror the client's ALL_SECTIONS / ALL_DOCS so the user
// object returned on login drives the same UI nav as the client-side fallback.
const ALL_SECTIONS = ['quotes', 'customer', 'build', 'pricing', 'docs', 'admin'];
const ALL_DOCS = ['quote', 'contract', 'survey', 'picking'];
const SALES_SECTIONS = ['quotes', 'customer', 'build', 'pricing', 'docs'];

// Azure app credentials (Railway env vars) for sending PDF emails via Graph.
const msalConfig = {
  auth: {
    clientId: process.env.AZURE_CLIENT_ID,
    authority: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}`,
    clientSecret: process.env.AZURE_CLIENT_SECRET,
  },
};

// Rep -> Outlook mailbox. Quotes send from the rep; surveys from contracts@.
const REP_EMAILS = {
  Damien: 'Damien.Mallon@totalhomeni.co.uk',
  Ryan: 'Ryan.Ringland@totalhomeni.co.uk',
  Richard: 'Richard.Brier@totalhomeni.co.uk',
};

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

  // Shared admin/config store — one row per module. Holds the admin object
  // (company details, pricing matrix, image map, logos) so a change made by an
  // admin is live for every user on their next login instead of requiring a
  // re-downloaded HTML file.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_config (
      module     text        PRIMARY KEY,
      config     jsonb       NOT NULL,
      updated_by text,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
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

  function requireAdmin(req, res, next) {
    if (!req.session || !req.session.user || req.session.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
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

  // ---- Admin config (shared across all users in the module) ----
  // Any authenticated user reads the live config on login; only admins write it.
  router.get('/admin/config', requireAuth, requireDb, async (req, res, next) => {
    try {
      const { module } = req.session.user;
      const result = await pool.query('SELECT config FROM admin_config WHERE module = $1', [module]);
      res.json({ config: result.rows[0] ? result.rows[0].config : null });
    } catch (err) {
      next(err);
    }
  });

  router.post('/admin/config', requireAuth, requireAdmin, requireDb, async (req, res, next) => {
    try {
      const { module, name } = req.session.user;
      const config = req.body;
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        return res.status(400).json({ error: 'Config object required' });
      }
      await pool.query(
        `INSERT INTO admin_config (module, config, updated_by, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (module) DO UPDATE
           SET config = EXCLUDED.config,
               updated_by = EXCLUDED.updated_by,
               updated_at = now()`,
        [module, config, name]
      );
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // ---- Diagnostic: verify Azure token acquisition + Graph roles (sends nothing) ----
  // Auth-required. Returns only non-sensitive info (tenant/appid/role names).
  router.get('/send-email/test', requireAuth, async (req, res) => {
    try {
      if (!process.env.AZURE_CLIENT_ID || !process.env.AZURE_TENANT_ID || !process.env.AZURE_CLIENT_SECRET) {
        return res.status(503).json({ ok: false, error: 'Missing Azure env vars' });
      }
      const cca = new msal.ConfidentialClientApplication(msalConfig);
      const r = await cca.acquireTokenByClientCredential({ scopes: ['https://graph.microsoft.com/.default'] });
      if (!r || !r.accessToken) return res.status(500).json({ ok: false, error: 'No token returned' });
      const p = JSON.parse(Buffer.from(r.accessToken.split('.')[1], 'base64').toString());
      const roles = p.roles || [];
      res.json({ ok: true, tenant: p.tid, appid: p.appid || p.azp, roles, hasMailSend: roles.includes('Mail.Send') });
    } catch (err) {
      res.status(500).json({ ok: false, errorCode: err.errorCode || null, error: (err.message || '').split('\n')[0] });
    }
  });

  // ---- Send PDF email via Microsoft Graph (application permissions) ----
  // Body: { type:'quote'|'survey', repName, customerName, customerEmail,
  //         subject, body, pdfBase64, filename }
  router.post('/send-email', requireAuth, async (req, res) => {
    try {
      const { type, repName, customerName, customerEmail, subject, body, pdfBase64, filename } = req.body || {};
      if (!customerEmail || !pdfBase64) {
        return res.status(400).json({ error: 'customerEmail and pdfBase64 required' });
      }
      if (!process.env.AZURE_CLIENT_ID || !process.env.AZURE_TENANT_ID || !process.env.AZURE_CLIENT_SECRET) {
        return res.status(503).json({ error: 'Email service not configured (missing Azure credentials)' });
      }

      // Surveys send from contracts@; quotes from the rep's mailbox.
      const fromEmail = type === 'survey'
        ? 'contracts@totalhomeni.co.uk'
        : (REP_EMAILS[repName] || 'info@totalhomeni.co.uk');
      const fromName = type === 'survey' ? 'TotaLuxe Contracts' : (repName || 'TotaLuxe');
      const replyTo = REP_EMAILS[repName] || fromEmail;

      const cca = new msal.ConfidentialClientApplication(msalConfig);
      const tokenResult = await cca.acquireTokenByClientCredential({
        scopes: ['https://graph.microsoft.com/.default'],
      });
      if (!tokenResult || !tokenResult.accessToken) throw new Error('Could not acquire Azure token');

      const message = {
        subject,
        body: { contentType: 'HTML', content: `<p>${String(body || '').replace(/\n/g, '<br>')}</p>` },
        from: { emailAddress: { address: fromEmail, name: fromName } },
        replyTo: [{ emailAddress: { address: replyTo, name: repName || fromName } }],
        toRecipients: [{ emailAddress: { address: customerEmail, name: customerName || customerEmail } }],
        attachments: [{
          '@odata.type': '#microsoft.graph.fileAttachment',
          name: filename || 'TotaLuxe-Document.pdf',
          contentType: 'application/pdf',
          contentBytes: pdfBase64,
        }],
      };

      const graphResp = await fetch(
        `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(fromEmail)}/sendMail`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${tokenResult.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ message, saveToSentItems: true }),
        }
      );

      if (!graphResp.ok) {
        const errBody = await graphResp.json().catch(() => ({}));
        throw new Error((errBody && errBody.error && errBody.error.message) || `Graph API error ${graphResp.status}`);
      }

      res.json({ ok: true, from: fromEmail, to: customerEmail });
    } catch (err) {
      console.error('send-email error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

apiRouter.ensureSchema = ensureSchema;
module.exports = apiRouter;
