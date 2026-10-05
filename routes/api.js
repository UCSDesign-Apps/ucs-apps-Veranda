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

const crypto = require('crypto');
const express = require('express');
const msal = require('@azure/msal-node');

// Section/doc lists mirror the client's ALL_SECTIONS / ALL_DOCS so the user
// object returned on login drives the same UI nav as the client-side fallback.
// KEEP IN SYNC with modules/totaluxe/index.html — the login response wins over
// the client's USERS_SEED, so a section missing here is hidden for everyone.
const ALL_SECTIONS = ['quotes', 'customer', 'qualify', 'build', 'pricing', 'decking', 'docs', 'costings', 'admin'];
const ALL_DOCS = ['quote', 'contract', 'signed', 'survey', 'picking'];
const SALES_SECTIONS = ['quotes', 'customer', 'qualify', 'build', 'pricing', 'decking', 'docs'];

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

// Users per module. Identity and default permissions live here; PINs do NOT.
// Each user's PIN is read from the environment variable named in `pinVar`
// (e.g. TOTALUXE_PIN_ADMIN). A user whose variable is unset, or set to anything
// other than 4+ digits, cannot sign in — there is deliberately no default PIN.
// 4 digits is Richard's choice (2026-10-05), made knowing the guessing odds; the
// per-IP attempt limit below is what keeps that tolerable.
// Admin -> Users in the page never set a PIN: login has only ever read PINs from
// here, never from admin_config.
const USERS = {
  totaluxe: [
    { u: 'admin', pinVar: 'TOTALUXE_PIN_ADMIN', name: 'Administrator', role: 'admin', sections: ALL_SECTIONS, docs: ALL_DOCS, signedOnly: false },
    { u: 'damien', pinVar: 'TOTALUXE_PIN_DAMIEN', name: 'Damien', role: 'sales', sections: SALES_SECTIONS, docs: ALL_DOCS, signedOnly: false },
    { u: 'ryan', pinVar: 'TOTALUXE_PIN_RYAN', name: 'Ryan', role: 'sales', sections: SALES_SECTIONS, docs: ALL_DOCS, signedOnly: false },
    { u: 'richard', pinVar: 'TOTALUXE_PIN_RICHARD', name: 'Richard', role: 'sales', sections: SALES_SECTIONS, docs: ALL_DOCS, signedOnly: false },
    { u: 'surveyor', pinVar: 'TOTALUXE_PIN_SURVEYOR', name: 'Surveyor', role: 'surveyor', sections: ['quotes', 'docs'], docs: ['contract', 'signed', 'survey', 'picking'], signedOnly: true },
  ],
};

const PIN_FORMAT = /^\d{4,}$/;

// The original PINs were published in the page and stay in git history, so they
// are refused for everyone even if someone sets one of them again by mistake.
// 1111 (Damien) and 2222 (Ryan) are deliberately NOT here: Richard chose to keep
// them on 2026-10-05, knowing they were published.
const RETIRED_PINS = new Set(['0000', '3333', '4444']);

// The user's configured PIN, or null if it is unset, too short or retired (that
// user is then refused). Read on every login so a changed variable needs no code change.
function configuredPin(user) {
  const pin = String(process.env[user.pinVar] || '').trim();
  return PIN_FORMAT.test(pin) && !RETIRED_PINS.has(pin) ? pin : null;
}

// Constant-time comparison (hash first so differing lengths are not leaked).
function pinMatches(given, expected) {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

// Find the user a PIN belongs to. Refuses PINs under 4 digits outright, and
// refuses a PIN that two users share rather than guessing between them.
function userForPin(list, pin) {
  const given = String(pin == null ? '' : pin).trim();
  if (!PIN_FORMAT.test(given)) return null;
  const hits = list.filter((entry) => {
    const expected = configuredPin(entry);
    return expected !== null && pinMatches(given, expected);
  });
  return hits.length === 1 ? hits[0] : null;
}

// Startup report: names the variables that are missing or invalid, never their values.
function reportPinConfig() {
  for (const [mod, list] of Object.entries(USERS)) {
    const bad = list.filter((entry) => configuredPin(entry) === null).map((entry) => entry.pinVar);
    const pins = list.map(configuredPin).filter(Boolean);
    if (bad.length) console.warn(`[auth] ${mod}: these users cannot sign in until a 4+ digit PIN (not 0000/3333/4444) is set: ${bad.join(', ')}`);
    if (new Set(pins).size !== pins.length) console.warn(`[auth] ${mod}: two users share a PIN — neither of them can sign in with it`);
  }
}

// What a user looks like to the client / in the session: no PIN variable name.
function publicUser(user) {
  const { pinVar, ...rest } = user;
  return rest;
}

// Fields that must never reach a browser or be stored in admin_config:
// staff PINs (login reads them from the environment) and the Signable API key
// (the server reads it from SIGNABLE_API_KEY). Stripping on GET as well as POST
// means copies already saved in admin_config are never sent out either.
function scrubConfig(config) {
  if (!config || typeof config !== 'object') return config;
  if (config.company && typeof config.company === 'object') delete config.company.signableKey;
  if (Array.isArray(config.users)) {
    for (const entry of config.users) if (entry && typeof entry === 'object') delete entry.pin;
  }
  return config;
}

// Failed sign-in limit: 5 failures per IP per 15 minutes, then 429 until the
// window has passed. In memory, so a restart clears it — acceptable for one
// instance. Uses req.ip, which honours server.js's `trust proxy` (Railway).
const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginFailures = new Map(); // ip -> { count, first }

function loginBlocked(ip, now = Date.now()) {
  const rec = loginFailures.get(ip);
  if (!rec) return 0;
  if (now - rec.first >= LOGIN_WINDOW_MS) { loginFailures.delete(ip); return 0; }
  return rec.count >= LOGIN_MAX_FAILURES ? Math.ceil((rec.first + LOGIN_WINDOW_MS - now) / 1000) : 0;
}
function recordLoginFailure(ip, now = Date.now()) {
  const rec = loginFailures.get(ip);
  if (!rec || now - rec.first >= LOGIN_WINDOW_MS) loginFailures.set(ip, { count: 1, first: now });
  else rec.count += 1;
}
// Keep the map from growing without bound.
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of loginFailures) if (now - rec.first >= LOGIN_WINDOW_MS) loginFailures.delete(ip);
}, LOGIN_WINDOW_MS).unref();

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

  await backfillDeckingSection(pool);
}

// The Decking section shipped after admin configs were already saved. A saved
// config's per-user `sections` array overrides the defaults at login, so those
// stale arrays would hide Decking from every non-admin however the code reads.
// Grant it once to users who already quote (they hold 'pricing'), then set a
// flag so this never runs again — otherwise an admin who revokes Decking would
// find it silently restored on the next boot.
async function backfillDeckingSection(pool) {
  try {
    const { rows } = await pool.query('SELECT module, config FROM admin_config');
    for (const row of rows) {
      const cfg = row.config;
      if (!cfg || typeof cfg !== 'object') continue;
      if (cfg._migrations && cfg._migrations.deckingSection) continue;

      const granted = [];
      if (Array.isArray(cfg.users)) {
        for (const u of cfg.users) {
          if (!u || !Array.isArray(u.sections)) continue;
          if (u.sections.includes('decking')) continue;
          if (u.role === 'admin' || u.sections.includes('pricing')) {
            u.sections.push('decking');
            granted.push(u.u);
          }
        }
      }
      cfg._migrations = Object.assign({}, cfg._migrations, { deckingSection: true });
      await pool.query('UPDATE admin_config SET config = $2 WHERE module = $1', [row.module, cfg]);
      console.log(
        `[migration] decking section — module=${row.module} granted to: ${granted.join(', ') || '(none)'}`
      );
    }
  } catch (e) {
    // Never block boot on a migration; the server defaults still grant Decking
    // to anyone without a saved per-user override.
    console.warn('[migration] decking section backfill skipped:', e.message);
  }
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
  router.post('/auth/login', async (req, res, next) => {
    try {
      const ip = req.ip;
      const wait = loginBlocked(ip);
      if (wait) {
        res.set('Retry-After', String(wait));
        return res.status(429).json({ error: 'Too many attempts — try again in ' + Math.ceil(wait / 60) + ' minutes' });
      }
      const { pin, module } = req.body || {};
      const mod = module || 'totaluxe';
      const list = USERS[mod];
      if (!list) return res.status(400).json({ error: 'Unknown module' });

      const user = userForPin(list, pin);
      if (!user) {
        recordLoginFailure(ip);
        console.warn(`[auth/login] failed sign-in from ${ip}`);
        return res.status(401).json({ error: 'Incorrect PIN' });
      }
      loginFailures.delete(ip);

      req.session.user = { ...publicUser(user), module: mod };
      // Per-user permission overrides: admins grant/revoke sections & docs via
      // Admin → Users, which is persisted into admin_config. Apply the saved
      // entry for this user so permission changes take effect without a deploy.
      // The 'admin' role always keeps its full hardcoded access — never let a
      // stale saved config lock an administrator out of a section.
      if (user.role !== 'admin' && pool) {
        try {
          const cfg = await pool.query('SELECT config FROM admin_config WHERE module = $1', [mod]);
          const savedUsers = cfg.rows[0] && cfg.rows[0].config && cfg.rows[0].config.users;
          if (Array.isArray(savedUsers)) {
            const match = savedUsers.find((su) => su && su.u === user.u);
            if (match) {
              if (Array.isArray(match.sections)) req.session.user.sections = match.sections;
              if (Array.isArray(match.docs)) req.session.user.docs = match.docs;
              if (typeof match.signedOnly === 'boolean') req.session.user.signedOnly = match.signedOnly;
            }
          }
        } catch (e) {
          console.warn('[auth/login] per-user permission merge skipped:', e.message);
        }
      }
      // Explicitly persist the session to the store BEFORE responding, so the
      // Set-Cookie references a session row that already exists — avoids a race
      // where the next request arrives before an async store write commits.
      await new Promise((resolve, reject) =>
        req.session.save((err) => (err ? reject(err) : resolve()))
      );
      res.json({ user: req.session.user });
    } catch (err) {
      console.error('[auth/login] error:', err.message);
      next(err);
    }
  });

  // The signed-in user, so the page can skip the PIN screen while the session is
  // still valid (e.g. after a refresh).
  router.get('/auth/me', requireAuth, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ user: req.session.user });
  });

  router.post('/auth/logout', (req, res) => {
    if (!req.session) return res.json({ ok: true });
    req.session.destroy(() => {
      res.clearCookie('connect.sid');
      res.json({ ok: true });
    });
  });

  // ---- CRM (Maximizer via Power BI): quotation number → customer details ----
  require('./crm').mount(router, requireAuth);

  // ---- Quotes ----
  // Who sees what (Richard, 2026-10-05):
  //   admin    → every quote
  //   sales    → only quotes they own; the owner is the quote's "Prepared by" (job.prep)
  //   surveyor → every Signed quote, whoever prepared it (signedOnly)
  // Enforced here, not just in the page, so a rep cannot read, overwrite or delete
  // another rep's quote by calling the API directly. Admin hands a quote to a rep
  // by changing its "Prepared by".
  const isSalesRep = (user) => user.role === 'sales' && !user.signedOnly;
  const samePerson = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  const PREP_SQL = "lower(trim(data->'job'->>'prep'))";

  // The current owner (job.prep) of a saved quote, or undefined if it does not exist.
  async function existingPrep(module, id) {
    const r = await pool.query(`SELECT data->'job'->>'prep' AS prep FROM quotes WHERE module = $1 AND id = $2`, [module, id]);
    return r.rows[0] ? r.rows[0].prep || '' : undefined;
  }

  router.get('/quotes', requireAuth, requireDb, async (req, res, next) => {
    try {
      const user = req.session.user;
      const { module, signedOnly } = user;
      const params = [module];
      let sql = 'SELECT data FROM quotes WHERE module = $1';
      if (signedOnly) {
        params.push('Signed');
        sql += ` AND status = $${params.length}`;
      } else if (user.role !== 'admin') {
        // Sales (and any other non-admin role) see only their own quotes.
        params.push(user.name);
        sql += ` AND ${PREP_SQL} = lower(trim($${params.length}))`;
      }
      sql += ' ORDER BY saved_at DESC NULLS LAST';
      const result = await pool.query(sql, params);
      // Highest quote number across the WHOLE module, not just this user's list,
      // so a rep who sees only their own quotes never reuses another rep's number.
      const max = await pool.query(
        `SELECT max((data->'job'->>'quote')::bigint) AS m FROM quotes
          WHERE module = $1 AND data->'job'->>'quote' ~ '^[0-9]{1,15}$'`,
        [module]
      );
      res.json({ quotes: result.rows.map((row) => row.data), maxQuoteNo: max.rows[0].m != null ? Number(max.rows[0].m) : null });
    } catch (err) {
      next(err);
    }
  });

  router.post('/quotes', requireAuth, requireDb, async (req, res, next) => {
    try {
      const user = req.session.user;
      const { module, name } = user;
      const quote = req.body;
      if (!quote || !quote.id) return res.status(400).json({ error: 'Quote id required' });

      if (isSalesRep(user)) {
        const prep = await existingPrep(module, quote.id);
        if (prep !== undefined && !samePerson(prep, name)) {
          return res.status(403).json({ error: 'This quote belongs to another rep' });
        }
        // A rep's quotes are always theirs: "Prepared by" is set to them on every save.
        quote.job = Object.assign({}, quote.job, { prep: name });
      }

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
      const user = req.session.user;
      const { module } = user;
      // Admin deletes anything; a sales rep only their own quotes; nobody else deletes.
      if (user.role !== 'admin') {
        if (!isSalesRep(user)) return res.status(403).json({ error: 'Not allowed to delete quotes' });
        const prep = await existingPrep(module, req.params.id);
        if (prep !== undefined && !samePerson(prep, user.name)) {
          return res.status(403).json({ error: 'This quote belongs to another rep' });
        }
      }
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
      // Never let the browser serve a cached/304 config — admins expect the
      // freshest image map immediately after another admin saves.
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.set('Pragma', 'no-cache');
      res.json({ config: result.rows[0] ? scrubConfig(result.rows[0].config) : null });
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
      scrubConfig(config);
      const payloadKB = Math.round(JSON.stringify(config).length / 1024);
      const imgCount = config.imgmap ? Object.keys(config.imgmap).reduce((n, cat) =>
        n + Object.values(config.imgmap[cat] || {}).filter(Boolean).length, 0) : 0;
      await pool.query(
        `INSERT INTO admin_config (module, config, updated_by, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (module) DO UPDATE
           SET config = EXCLUDED.config,
               updated_by = EXCLUDED.updated_by,
               updated_at = now()`,
        [module, config, name]
      );
      res.json({ ok: true, payloadKB, imgCount });
    } catch (err) {
      console.error(`[admin/config] POST error:`, err.message);
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
        ? 'office@totalhomeni.co.uk'
        : (REP_EMAILS[repName] || 'info@totalhomeni.co.uk');
      const fromName = type === 'survey' ? 'TotaLuxe' : (repName || 'TotaLuxe');
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

  // ---- Signable proxy ----
  // Signable is a server-to-server API: it sends no CORS headers, so a browser
  // fetch to api.signable.co.uk is blocked before it leaves the page. Every
  // Signable call goes through here instead.
  // Key: SIGNABLE_API_KEY on the server only. It is never sent to or accepted from a browser.
  const SIGNABLE_BASE = process.env.SIGNABLE_BASE_URL || 'https://api.signable.co.uk/v1'; // override for local testing only
  function signableAuth() {
    const key = process.env.SIGNABLE_API_KEY;
    if (!key) return null;
    return 'Basic ' + Buffer.from(`${key}:x`).toString('base64');
  }
  const validFingerprint = (fp) => /^[A-Za-z0-9_-]{6,128}$/.test(String(fp || ''));

  // Signable's own 401/403 means the API key was refused. Pass it on as a 502 so
  // the client does not mistake it for its own session expiring.
  const KEY_REFUSED = 'Signable rejected the API key — check SIGNABLE_API_KEY on the server';

  async function signableJson(resp) {
    const text = await resp.text();
    try { return JSON.parse(text); } catch (e) { return { message: text.slice(0, 300) }; }
  }

  router.post('/signable/envelopes', requireAuth, async (req, res) => {
    try {
      const { envelope } = req.body || {};
      const auth = signableAuth();
      if (!auth) return res.status(503).json({ error: 'Signable API key not configured' });
      if (!envelope || typeof envelope !== 'object') return res.status(400).json({ error: 'envelope object required' });
      const resp = await fetch(`${SIGNABLE_BASE}/envelopes`, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(envelope),
      });
      const data = await signableJson(resp);
      if (resp.status === 401 || resp.status === 403) return res.status(502).json({ error: KEY_REFUSED });
      res.status(resp.status).json(data);
    } catch (err) {
      console.error('[signable] create error:', err.message);
      res.status(502).json({ error: 'Could not reach Signable: ' + err.message });
    }
  });

  async function readEnvelope(req) {
    const auth = signableAuth();
    if (!auth) return { status: 503, data: { error: 'Signable API key not configured' } };
    const resp = await fetch(`${SIGNABLE_BASE}/envelopes/${encodeURIComponent(req.params.fingerprint)}`, {
      headers: { Authorization: auth, Accept: 'application/json' },
    });
    return { status: resp.status, data: await signableJson(resp), auth };
  }

  router.get('/signable/envelopes/:fingerprint', requireAuth, async (req, res) => {
    try {
      if (!validFingerprint(req.params.fingerprint)) return res.status(400).json({ error: 'Bad envelope reference' });
      const { status, data } = await readEnvelope(req);
      if (status === 401 || status === 403) return res.status(502).json({ error: KEY_REFUSED });
      res.status(status).json(data);
    } catch (err) {
      console.error('[signable] status error:', err.message);
      res.status(502).json({ error: 'Could not reach Signable: ' + err.message });
    }
  });

  // Streams the executed PDF (or the document as sent, while still unsigned).
  router.get('/signable/envelopes/:fingerprint/pdf', requireAuth, async (req, res) => {
    try {
      if (!validFingerprint(req.params.fingerprint)) return res.status(400).json({ error: 'Bad envelope reference' });
      const { status, data, auth } = await readEnvelope(req);
      if (status === 401 || status === 403) return res.status(502).json({ error: KEY_REFUSED });
      if (status === 503) return res.status(503).json(data);
      if (status !== 200) return res.status(status === 404 ? 404 : 502).json({ error: data.message || data.error || `Signable returned ${status}` });
      const pdfUrl = data.envelope_signed_pdf || data.envelope_pdf;
      if (!pdfUrl) return res.status(409).json({ error: 'Signable has no PDF for this envelope yet', envelope_status: data.envelope_status });
      // The PDF link is normally pre-signed storage: send no credentials to it.
      // Only if that is refused AND it is Signable's own host, retry with the key.
      let pdf = await fetch(pdfUrl);
      if ((pdf.status === 401 || pdf.status === 403) && /^https:\/\/[^/]*signable\.co\.uk\//.test(pdfUrl)) {
        pdf = await fetch(pdfUrl, { headers: { Authorization: auth } });
      }
      if (!pdf.ok) return res.status(502).json({ error: `PDF download failed (${pdf.status})` });
      const buf = Buffer.from(await pdf.arrayBuffer());
      if (!buf.length) return res.status(502).json({ error: 'Signable returned an empty PDF' });
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', `inline; filename="contract-${req.params.fingerprint}.pdf"`);
      res.set('Cache-Control', 'private, no-store');
      res.set('X-Envelope-Status', String(data.envelope_status || ''));
      res.send(buf);
    } catch (err) {
      console.error('[signable] pdf error:', err.message);
      res.status(502).json({ error: 'Could not reach Signable: ' + err.message });
    }
  });

  return router;
}

apiRouter.ensureSchema = ensureSchema;
apiRouter.reportPinConfig = reportPinConfig;
module.exports = apiRouter;
