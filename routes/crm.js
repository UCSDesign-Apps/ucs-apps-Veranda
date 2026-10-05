'use strict';

/**
 * CRM (Maximizer) quotation lookup, read through Power BI — the same dataset and
 * service principal the INSITE dashboard uses.
 *
 *   GET /api/crm/quotation/:number  (signed in; sales or admin)
 *   → { quotation, customer: { cname, ctel, caddr1, caddr2, cpost }, owner }
 *
 * How a quotation number reaches a customer (verified against live data 2026-10-05):
 *   AMGR_User_Fields_Tbl  Type_Id 365 "Quotation", AlphaNumericCol = the number,
 *                         Client_Id = the Opp_Id
 *   AMGR_Opportunity_Tbl  Opp_Id → Client_Id (the customer, ends "C")
 *   AMGR_Client_Tbl       Client_Id + Contact_Number 0 = the customer's own record
 *                         (Name, First_Name, Address_Line_1/2, City, Zip_Code, Phone_1)
 *
 *   AMGR_User_Fields_Tbl  Type_Id 58850 "E-mail Address", Client_Id = the customer,
 *                         AlphaNumericCol = the email (found 2026-10-05 via quotation
 *                         58038). NOT Email_Tbl, which only holds leads. A few customers
 *                         have two rows and some values are not emails, so only a value
 *                         that looks like an email is used.
 *
 * Only opportunities owned by THI reps are returned, so the app cannot be used to
 * read UCS Belfast/Dublin customers. Read-only throughout.
 *
 * Env (Railway): POWERBI_TENANT_ID, POWERBI_CLIENT_ID, POWERBI_CLIENT_SECRET,
 * POWERBI_WORKSPACE_ID, POWERBI_DATASET_ID. If any is missing the route answers 503.
 */

const msal = require('@azure/msal-node');

const SCOPE = 'https://analysis.windows.net/powerbi/api/.default';
const QUERY_TIMEOUT_MS = 20000; // DirectQuery → on-prem SQL via the gateway can be slow
const QUOTATION_TYPE_ID = 365;
const EMAIL_TYPE_ID = 58850;
const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Maximizer Owner_Ids of the THI reps (as in the dashboard's config/reps.js).
const THI_OWNERS = ['RBRIER', 'RRINGLAND', 'DMALLON'];
const OWNER_NAMES = { RBRIER: 'Richard', RRINGLAND: 'Ryan', DMALLON: 'Damien' };

function cfg() {
  return {
    tenant: process.env.POWERBI_TENANT_ID,
    client: process.env.POWERBI_CLIENT_ID,
    secret: process.env.POWERBI_CLIENT_SECRET,
    workspace: process.env.POWERBI_WORKSPACE_ID,
    dataset: process.env.POWERBI_DATASET_ID,
  };
}
const isConfigured = () => Object.values(cfg()).every(Boolean);

let cca = null;
async function token() {
  const c = cfg();
  if (!cca) {
    cca = new msal.ConfidentialClientApplication({
      auth: { clientId: c.client, authority: `https://login.microsoftonline.com/${c.tenant}`, clientSecret: c.secret },
    });
  }
  const r = await cca.acquireTokenByClientCredential({ scopes: [SCOPE] }); // msal caches until expiry
  if (!r || !r.accessToken) throw new Error('No Power BI token');
  return r.accessToken;
}

async function query(dax) {
  const c = cfg();
  const res = await fetch(`https://api.powerbi.com/v1.0/myorg/groups/${c.workspace}/datasets/${c.dataset}/executeQueries`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ queries: [{ query: dax }], serializerSettings: { includeNulls: true } }),
    signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Power BI ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const json = await res.json();
  const rows = (json.results && json.results[0] && json.results[0].tables && json.results[0].tables[0] && json.results[0].tables[0].rows) || [];
  // "[col]" / "Table[col]" → "col"
  return rows.map((r) => {
    const o = {};
    for (const k of Object.keys(r)) o[k.replace(/^.*\[/, '').replace(/\]$/, '')] = r[k];
    return o;
  });
}

const text = (v) => (v == null ? '' : String(v).trim());
// DAX string literal (the number is validated as digits, but escape anyway).
const daxStr = (s) => '"' + String(s).replace(/"/g, '""') + '"';

/** Pure: Maximizer customer row → the app's customer fields (unit-testable). */
function toCustomer(c) {
  const first = text(c.First_Name), last = text(c.Name);
  const line1 = text(c.Address_Line_1), line2 = text(c.Address_Line_2);
  return {
    cname: first && last && !last.toLowerCase().startsWith(first.toLowerCase()) ? `${first} ${last}` : last || first,
    ctel: text(c.Phone_1) || text(c.Phone_2),
    caddr1: [line1, line2].filter(Boolean).join(', '),
    caddr2: text(c.City),
    cpost: text(c.Zip_Code).toUpperCase(),
    cemail: EMAIL_FORMAT.test(text(c.Email)) ? text(c.Email) : '',
  };
}

async function lookupQuotation(number) {
  const owners = '{' + THI_OWNERS.map(daxStr).join(',') + '}';
  const opps = await query(
    `EVALUATE VAR ids = CALCULATETABLE(VALUES(AMGR_User_Fields_Tbl[Client_Id]), ` +
    `AMGR_User_Fields_Tbl[Type_Id] = ${QUOTATION_TYPE_ID}, AMGR_User_Fields_Tbl[AlphaNumericCol] = ${daxStr(number)}) ` +
    `RETURN SELECTCOLUMNS(FILTER(ALL(AMGR_Opportunity_Tbl), AMGR_Opportunity_Tbl[Opp_Id] IN ids && AMGR_Opportunity_Tbl[Owner_Id] IN ${owners}), ` +
    `"oppId", AMGR_Opportunity_Tbl[Opp_Id], "clientId", AMGR_Opportunity_Tbl[Client_Id], "owner", AMGR_Opportunity_Tbl[Owner_Id], "created", AMGR_Opportunity_Tbl[Create_Date])`
  );
  if (!opps.length) return { status: 404 };
  const clients = [...new Set(opps.map((o) => o.clientId))];
  if (clients.length > 1) return { status: 409 };
  const rows = await query(
    `EVALUATE SELECTCOLUMNS(FILTER(ALL(AMGR_Client_Tbl), AMGR_Client_Tbl[Client_Id] = ${daxStr(clients[0])} && AMGR_Client_Tbl[Contact_Number] = 0), ` +
    `"Name", AMGR_Client_Tbl[Name], "First_Name", AMGR_Client_Tbl[First_Name], "Address_Line_1", AMGR_Client_Tbl[Address_Line_1], ` +
    `"Address_Line_2", AMGR_Client_Tbl[Address_Line_2], "City", AMGR_Client_Tbl[City], "Zip_Code", AMGR_Client_Tbl[Zip_Code], ` +
    `"Phone_1", AMGR_Client_Tbl[Phone_1], "Phone_2", AMGR_Client_Tbl[Phone_2], ` +
    `"Email", CALCULATE(MAX(AMGR_User_Fields_Tbl[AlphaNumericCol]), FILTER(ALL(AMGR_User_Fields_Tbl), ` +
    `AMGR_User_Fields_Tbl[Type_Id] = ${EMAIL_TYPE_ID} && AMGR_User_Fields_Tbl[Client_Id] = ${daxStr(clients[0])} && ` +
    `CONTAINSSTRING(AMGR_User_Fields_Tbl[AlphaNumericCol], "@"))))`
  );
  if (!rows.length) return { status: 404 };
  const latest = opps.slice().sort((a, b) => String(b.created).localeCompare(String(a.created)))[0];
  return { status: 200, body: { quotation: number, customer: toCustomer(rows[0]), owner: OWNER_NAMES[latest.owner] || latest.owner } };
}

function mount(router, requireAuth) {
  router.get('/crm/quotation/:number', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const user = req.session.user;
    if (user.role !== 'admin' && user.role !== 'sales') return res.status(403).json({ error: 'Not available for your role' });
    const number = String(req.params.number || '').trim();
    if (!/^\d{3,9}$/.test(number)) return res.status(400).json({ error: 'Enter the quotation number (digits only)' });
    if (!isConfigured()) return res.status(503).json({ error: 'CRM lookup is not set up on the server' });
    try {
      const r = await lookupQuotation(number);
      if (r.status === 404) return res.status(404).json({ error: `No THI quotation ${number} found in Maximizer` });
      if (r.status === 409) return res.status(409).json({ error: `Quotation ${number} is on more than one customer in Maximizer — enter the details by hand` });
      res.json(r.body);
    } catch (err) {
      // Usually the Power BI gateway to the CRM being down. Never fatal: reps type the details instead.
      console.error('[crm] quotation lookup failed:', err.message);
      res.status(502).json({ error: 'CRM unavailable right now — enter the details by hand' });
    }
  });
}

module.exports = { mount, toCustomer, isConfigured, THI_OWNERS };
