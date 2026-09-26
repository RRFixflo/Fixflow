// Job management: every submitted report is saved as a job in PostgreSQL, and a
// password-protected admin dashboard (/admin) reads and updates them.
//
// Railway settings (Settings -> Variables on the Fixflow service):
//   DATABASE_URL    set automatically by referencing the Railway Postgres service
//   ADMIN_PASSWORD  the password for /admin
//
// Without DATABASE_URL the report tool works exactly as before (email only) and
// /admin says the database isn't connected.
const crypto = require('crypto');

let Pool = null;
try { Pool = require('pg').Pool; } catch (e) { /* pg not installed: jobs disabled */ }

// How long each urgency gets before a job is overdue. A job's own due date can
// be changed in the dashboard; these only set the starting point.
const DUE_HOURS = { Emergency: 24, Urgent: 24 * 7, Routine: 24 * 28 };
const URGENCIES = ['Emergency', 'Urgent', 'Routine'];

// Payment details printed on landlord invoices. Kept in Railway variables, not
// in this public code, and only sent to signed-in staff:
//   INVOICE_PAYEE, INVOICE_SORT_CODE, INVOICE_ACCOUNT_NUMBER,
//   INVOICE_PAYMENT_DAYS (optional, default 14), INVOICE_FROM (optional),
//   INVOICE_ADDRESS, INVOICE_COMPANY_NO, INVOICE_VAT_NO (optional; default to the registered details below)
const INVOICE = {
  payee: process.env.INVOICE_PAYEE || '',
  sortCode: process.env.INVOICE_SORT_CODE || '',
  accountNumber: process.env.INVOICE_ACCOUNT_NUMBER || '',
  paymentDays: parseInt(process.env.INVOICE_PAYMENT_DAYS, 10) || 14,
  from: process.env.INVOICE_FROM || 'Residential Realtors',
  address: process.env.INVOICE_ADDRESS || '28-30 Harper Road, London, SE1 6AD',
  companyNo: process.env.INVOICE_COMPANY_NO || '08760284',
  vatNo: process.env.INVOICE_VAT_NO || '178090487'
};
const STATUSES = ['New', 'Assigned', 'Contractor booked', 'Awaiting parts', 'On hold', 'Completed', 'Cancelled'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id               SERIAL PRIMARY KEY,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  status           TEXT NOT NULL DEFAULT 'New',
  urgency          TEXT NOT NULL DEFAULT 'Routine',
  due_at           TIMESTAMPTZ,
  tenant_name      TEXT,
  tenant_email     TEXT,
  tenant_phone     TEXT,
  property_address TEXT,
  category         TEXT,
  affected         TEXT,
  symptom          TEXT,
  location         TEXT,
  description      TEXT,
  access_days      TEXT,
  access_time      TEXT,
  access_notes     TEXT,
  key_permission   TEXT,
  key_instructions TEXT,
  photo_count      INTEGER NOT NULL DEFAULT 0,
  report_text      TEXT,
  pdf_filename     TEXT,
  pdf              BYTEA,
  assigned_to      TEXT,
  next_steps       TEXT,
  estimated_cost   NUMERIC(10,2),
  actual_cost      NUMERIC(10,2),
  landlord_charge  NUMERIC(10,2),
  completed_at     TIMESTAMPTZ,
  completion_notes TEXT
);
CREATE TABLE IF NOT EXISTS job_updates (
  id         SERIAL PRIMARY KEY,
  job_id     INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind       TEXT NOT NULL DEFAULT 'note',
  body       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS job_updates_job_idx ON job_updates (job_id, created_at);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'Online report';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS landlord_name TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS landlord_email TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS landlord_phone TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS landlord_address TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS invoice_number TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS invoiced_at TIMESTAMPTZ;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS invoice_total NUMERIC(10,2);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS archived_reason TEXT;
CREATE TABLE IF NOT EXISTS job_photos (
  id         SERIAL PRIMARY KEY,
  job_id     INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  added_by   TEXT NOT NULL DEFAULT 'tenant',
  name       TEXT,
  mime       TEXT NOT NULL,
  data       BYTEA NOT NULL
);
CREATE INDEX IF NOT EXISTS job_photos_job_idx ON job_photos (job_id, id);
CREATE TABLE IF NOT EXISTS contractors (
  id         SERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  name       TEXT NOT NULL,
  trade      TEXT,
  phone      TEXT,
  email      TEXT,
  notes      TEXT,
  active     BOOLEAN NOT NULL DEFAULT true
);
`;

// The first contractors can be loaded from the CONTRACTORS_SEED variable (a JSON
// list of {name, trade, phone, email, notes}) so their numbers never have to be
// written into this public code. It is only used while the table is empty;
// after that, contractors are managed from the dashboard.
async function seedContractors(p) {
  const raw = process.env.CONTRACTORS_SEED;
  if (!raw) return;
  const count = await p.query('SELECT count(*)::int AS n FROM contractors');
  if (count.rows[0].n > 0) return;
  let list;
  try { list = JSON.parse(raw); } catch (e) { console.error('CONTRACTORS_SEED is not valid JSON'); return; }
  if (!Array.isArray(list)) return;
  for (const c of list) {
    if (!c || !str(c.name)) continue;
    await p.query('INSERT INTO contractors (name, trade, phone, email, notes) VALUES ($1, $2, $3, $4, $5)',
      [str(c.name, 200), str(c.trade, 200), str(c.phone, 50), str(c.email, 200), str(c.notes, 1000)]);
  }
  console.log('Loaded ' + list.length + ' contractors from CONTRACTORS_SEED');
}

// How a job reached us. Tenant submissions are 'Online report'; staff pick one
// of the others when adding a job by hand.
const SOURCES = ['Online report', 'Phone call', 'Email', 'Text / WhatsApp', 'In person', 'Inspection', 'Landlord request', 'Other'];

// Everything the list view needs; the PDF and full report text are left out so
// the list stays quick however many jobs there are.
// Description and access details are included so several jobs can be sent to a
// contractor together straight from the list.
const LIST_COLUMNS = `id, created_at, updated_at, status, urgency, due_at, tenant_name, tenant_email,
  tenant_phone, property_address, category, affected, symptom, location, description, access_days,
  access_time, access_notes, key_permission, key_instructions, assigned_to, next_steps,
  estimated_cost, actual_cost, landlord_charge, completed_at, completion_notes, photo_count, source,
  archived_at, archived_reason, (SELECT count(*)::int FROM job_photos ph WHERE ph.job_id = jobs.id) AS photos_saved,
  (SELECT array_agg(ph.id ORDER BY ph.id) FROM job_photos ph WHERE ph.job_id = jobs.id) AS photo_ids,
  landlord_name, landlord_email, landlord_phone, landlord_address, invoice_number, invoiced_at, invoice_total`;

function str(v, max) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max || 500) : null;
}

function money(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(/[£,\s]/g, ''));
  if (!isFinite(n) || n < 0 || n > 10000000) return undefined; // undefined = invalid
  return Math.round(n * 100) / 100;
}

// Photos arrive as data URLs from the browser. Only real images are kept, each
// under 6 MB (the tenant page shrinks them to a few hundred KB first).
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_PHOTOS_PER_UPLOAD = 30;
function decodePhotos(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const ph of list.slice(0, MAX_PHOTOS_PER_UPLOAD)) {
    const m = /^data:(image\/[a-z+]+);base64,([A-Za-z0-9+/=]+)$/.exec(String((ph && ph.dataUrl) || ''));
    if (!m || PHOTO_TYPES.indexOf(m[1]) === -1) continue;
    const buf = Buffer.from(m[2], 'base64');
    if (!buf.length || buf.length > 6 * 1024 * 1024) continue;
    out.push({ name: str(ph.name, 200), mime: m[1], data: buf });
  }
  return out;
}
async function insertPhotos(p, jobIdValue, photos, addedBy) {
  for (const ph of photos) {
    await p.query('INSERT INTO job_photos (job_id, added_by, name, mime, data) VALUES ($1, $2, $3, $4, $5)',
      [jobIdValue, addedBy, ph.name, ph.mime, ph.data]);
  }
}

function gbp(n) {
  return n === null || n === undefined ? '—' : '£' + Number(n).toFixed(2);
}

module.exports = function mountJobs(app, opts) {
  const sendEmail = opts.sendEmail;           // async ({to, subject, text}) => {ok}
  const canEmail = opts.canEmail;             // () => bool
  const DATABASE_URL = process.env.DATABASE_URL || '';
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

  let pool = null;
  let ready = Promise.resolve(false);
  if (DATABASE_URL && Pool) {
    pool = new Pool({
      connectionString: DATABASE_URL,
      // Railway's internal network needs no TLS; its public proxy URL does.
      ssl: /railway\.internal|localhost|127\.0\.0\.1|\/tmp/.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
      max: 5
    });
    pool.on('error', function (err) { console.error('Postgres pool error:', err.message); });
    ready = pool.query(SCHEMA)
      .then(function () { return seedContractors(pool).catch(function (err) { console.error('Contractor seed failed:', err.message); }); })
      .then(function () { console.log('Jobs database ready'); return true; })
      .catch(function (err) { console.error('Jobs database setup failed:', err.message); return false; });
  } else if (DATABASE_URL && !Pool) {
    console.error('DATABASE_URL is set but the pg package is missing; run npm install');
  }

  async function db() {
    return (await ready) ? pool : null;
  }

  // ---------- Saving a submitted report ----------
  async function saveReport(r, pdfBase64, pdfFilename, reportText, photos) {
    const p = await db();
    if (!p) return null;
    r = r || {};
    const urgency = URGENCIES.indexOf(r.urgency) !== -1 ? r.urgency : 'Routine';
    const dueAt = new Date(Date.now() + DUE_HOURS[urgency] * 3600 * 1000);
    const pdf = pdfBase64 ? Buffer.from(pdfBase64, 'base64') : null;
    const res = await p.query(
      `INSERT INTO jobs (urgency, due_at, tenant_name, tenant_email, tenant_phone, property_address,
         category, affected, symptom, location, description, access_days, access_time, access_notes,
         key_permission, key_instructions, photo_count, report_text, pdf_filename, pdf)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING id`,
      [urgency, dueAt, str(r.name, 200), str(r.email, 200), str(r.phone, 50), str(r.address, 500),
        str(r.category, 200), str(r.affected, 200), str(r.symptom, 200), str(r.location, 200),
        str(r.description, 5000), str(Array.isArray(r.accessDays) ? r.accessDays.join(', ') : r.accessDays, 100),
        str(r.accessTime, 50), str(r.accessNotes, 1000), str(r.keyPermission, 10), str(r.keyInstructions, 1000),
        Math.max(0, Math.min(50, parseInt(r.photoCount, 10) || 0)), str(reportText, 20000),
        str(pdfFilename, 200), pdf]
    );
    const id = res.rows[0].id;
    // Photos are saved separately too, so staff can view them without the PDF.
    // A problem here shouldn't lose the report itself.
    try { await insertPhotos(p, id, decodePhotos(photos), 'tenant'); } catch (err) { console.error('Saving photos failed:', err.message); }
    await p.query('INSERT INTO job_updates (job_id, kind, body) VALUES ($1, $2, $3)',
      [id, 'created', 'Report submitted by ' + (str(r.name, 200) || 'tenant') + ' (' + urgency + ').']);
    return { id: id, ref: refFor(id) };
  }

  function refFor(id) { return 'RR-' + String(id).padStart(5, '0'); }

  // ---------- Admin sign-in ----------
  // A signed, expiring token in an HttpOnly cookie. Changing ADMIN_PASSWORD
  // signs everyone out, since the signing key is derived from it.
  const SESSION_DAYS = 30;
  const signingKey = crypto.createHash('sha256').update('rr-admin-session:' + ADMIN_PASSWORD).digest();
  function sign(exp) { return crypto.createHmac('sha256', signingKey).update('admin:' + exp).digest('hex'); }
  function makeToken() {
    const exp = Date.now() + SESSION_DAYS * 86400 * 1000;
    return exp + '.' + sign(exp);
  }
  function validToken(tok) {
    if (!ADMIN_PASSWORD || !tok) return false;
    const parts = String(tok).split('.');
    if (parts.length !== 2 || !(Number(parts[0]) > Date.now())) return false;
    const a = Buffer.from(parts[1]);
    const b = Buffer.from(sign(parts[0]));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  function readCookie(req, name) {
    const m = (req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
    return m ? decodeURIComponent(m[1]) : '';
  }
  function passwordMatches(given) {
    const a = crypto.createHash('sha256').update(String(given || '')).digest();
    const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
    return crypto.timingSafeEqual(a, b);
  }

  const loginAttempts = new Map();
  function loginAllowed(ip) {
    const now = Date.now();
    const e = loginAttempts.get(ip);
    if (!e || now - e.start > 15 * 60 * 1000) { loginAttempts.set(ip, { start: now, n: 1 }); return true; }
    e.n += 1;
    return e.n <= 10;
  }

  app.post('/api/admin/login', function (req, res) {
    if (!ADMIN_PASSWORD) return res.status(503).json({ ok: false, error: 'admin-not-configured' });
    if (!loginAllowed(req.ip)) return res.status(429).json({ ok: false, error: 'too-many-attempts' });
    if (!passwordMatches((req.body || {}).password)) return res.status(401).json({ ok: false, error: 'wrong-password' });
    loginAttempts.delete(req.ip); // only failed attempts count towards the limit
    res.setHeader('Set-Cookie', 'rr_admin=' + makeToken() + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' +
      (SESSION_DAYS * 86400) + (req.secure ? '; Secure' : ''));
    res.json({ ok: true });
  });

  app.post('/api/admin/logout', function (req, res) {
    res.setHeader('Set-Cookie', 'rr_admin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
    res.json({ ok: true });
  });

  // Everything below needs a valid session. State-changing requests must also be
  // JSON, which a cross-site form can't send — on top of the SameSite cookie.
  app.use('/api/admin', function (req, res, next) {
    if (!ADMIN_PASSWORD) return res.status(503).json({ ok: false, error: 'admin-not-configured' });
    if (!validToken(readCookie(req, 'rr_admin'))) return res.status(401).json({ ok: false, error: 'signed-out' });
    if (req.method !== 'GET' && !req.is('application/json')) return res.status(415).json({ ok: false, error: 'json-only' });
    next();
  });

  app.get('/api/admin/me', async function (req, res) {
    res.json({ ok: true, db: !!(await db()), canEmail: canEmail(), canAi: !!(opts.canAi && opts.canAi()), invoice: INVOICE, statuses: STATUSES, urgencies: URGENCIES, dueHours: DUE_HOURS, sources: SOURCES });
  });

  // Wraps a handler: no database -> 503; unexpected errors -> 500 (logged).
  function withDb(handler) {
    return async function (req, res) {
      const p = await db();
      if (!p) return res.status(503).json({ ok: false, error: 'no-database' });
      try { await handler(p, req, res); } catch (err) {
        console.error('admin api error:', req.method, req.path, err.message);
        res.status(500).json({ ok: false, error: 'server-error' });
      }
    };
  }

  function jobId(req) {
    const id = parseInt(req.params.id, 10);
    return id > 0 ? id : null;
  }

  app.get('/api/admin/jobs', withDb(async function (p, req, res) {
    const r = await p.query('SELECT ' + LIST_COLUMNS + ' FROM jobs ORDER BY created_at DESC LIMIT 5000');
    res.json({ ok: true, jobs: r.rows.map(function (j) { j.ref = refFor(j.id); return j; }) });
  }));

  app.get('/api/admin/jobs/:id', withDb(async function (p, req, res) {
    const id = jobId(req);
    const r = await p.query('SELECT *, (pdf IS NOT NULL) AS has_pdf FROM jobs WHERE id = $1', [id]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'not-found' });
    const job = r.rows[0];
    delete job.pdf;
    job.ref = refFor(job.id);
    const u = await p.query('SELECT id, created_at, kind, body FROM job_updates WHERE job_id = $1 ORDER BY created_at DESC, id DESC', [id]);
    const ph = await p.query('SELECT id, created_at, added_by, name FROM job_photos WHERE job_id = $1 ORDER BY id', [id]);
    res.json({ ok: true, job: job, updates: u.rows, photos: ph.rows });
  }));

  app.get('/api/admin/jobs/:id/pdf', withDb(async function (p, req, res) {
    const r = await p.query('SELECT pdf, pdf_filename FROM jobs WHERE id = $1', [jobId(req)]);
    if (!r.rows.length || !r.rows[0].pdf) return res.status(404).send('No PDF saved for this job.');
    const name = (r.rows[0].pdf_filename || 'Repair-Report.pdf').replace(/[^a-zA-Z0-9.\-_]+/g, '-');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="' + name + '"');
    res.send(r.rows[0].pdf);
  }));

  // Editable fields, how to clean each, and how a change reads in the timeline.
  const EDITABLE = {
    status: { clean: function (v) { return STATUSES.indexOf(v) !== -1 && v !== 'Completed' ? v : undefined; }, label: 'Status' },
    urgency: { clean: function (v) { return URGENCIES.indexOf(v) !== -1 ? v : undefined; }, label: 'Urgency' },
    due_at: {
      clean: function (v) { if (!v) return null; const d = new Date(v); return isNaN(d) ? undefined : d; },
      label: 'Due', show: function (v) { return v ? new Date(v).toLocaleString('en-GB', { timeZone: 'Europe/London', dateStyle: 'medium', timeStyle: 'short' }) : 'none'; }
    },
    assigned_to: { clean: function (v) { return str(v, 200); }, label: 'Assigned to' },
    next_steps: { clean: function (v) { return str(v, 2000); }, label: 'Next steps', quiet: true },
    // Report details, correctable from "Edit details" (mainly for jobs typed in by hand).
    tenant_name: { clean: function (v) { return str(v, 200); }, label: 'Tenant' },
    tenant_email: { clean: function (v) { return str(v, 200); }, label: 'Tenant email' },
    tenant_phone: { clean: function (v) { return str(v, 50); }, label: 'Tenant phone' },
    property_address: { clean: function (v) { return str(v, 500); }, label: 'Property' },
    category: { clean: function (v) { return str(v, 200); }, label: 'Issue type' },
    affected: { clean: function (v) { return str(v, 200); }, label: 'What’s affected' },
    symptom: { clean: function (v) { return str(v, 200); }, label: 'What’s happening' },
    location: { clean: function (v) { return str(v, 200); }, label: 'Location' },
    description: { clean: function (v) { return str(v, 5000); }, label: 'Description', quiet: true },
    access_days: { clean: function (v) { return str(v, 100); }, label: 'Access days' },
    access_time: { clean: function (v) { return str(v, 50); }, label: 'Best time' },
    access_notes: { clean: function (v) { return str(v, 1000); }, label: 'Access notes' },
    key_permission: { clean: function (v) { return v === 'Yes' || v === 'No' ? v : (v ? undefined : null); }, label: 'Keys to contractor' },
    key_instructions: { clean: function (v) { return str(v, 1000); }, label: 'Contractor notes' },
    source: { clean: function (v) { return SOURCES.indexOf(v) !== -1 ? v : undefined; }, label: 'Came in via' },
    landlord_name: { clean: function (v) { return str(v, 200); }, label: 'Landlord' },
    landlord_email: { clean: function (v) { return str(v, 200); }, label: 'Landlord email' },
    landlord_phone: { clean: function (v) { return str(v, 50); }, label: 'Landlord phone' },
    landlord_address: { clean: function (v) { return str(v, 500); }, label: 'Landlord address' },
    estimated_cost: { clean: money, label: 'Estimated cost', show: gbp },
    actual_cost: { clean: money, label: 'Actual cost', show: gbp },
    landlord_charge: { clean: money, label: 'Charge to landlord', show: gbp }
  };

  app.patch('/api/admin/jobs/:id', withDb(async function (p, req, res) {
    const id = jobId(req);
    const body = req.body || {};
    const cur = await p.query('SELECT ' + Object.keys(EDITABLE).join(', ') + ' FROM jobs WHERE id = $1', [id]);
    if (!cur.rows.length) return res.status(404).json({ ok: false, error: 'not-found' });
    const before = cur.rows[0];
    const sets = [];
    const vals = [];
    const notes = [];
    for (const field of Object.keys(EDITABLE)) {
      if (!(field in body)) continue;
      if (field === 'status' && body.status === before.status) continue;
      const spec = EDITABLE[field];
      const v = spec.clean(body[field]);
      if (v === undefined) return res.status(400).json({ ok: false, error: 'invalid-' + field });
      const oldShown = spec.show ? spec.show(before[field]) : (before[field] || 'none');
      const newShown = spec.show ? spec.show(v) : (v || 'none');
      if (String(oldShown) === String(newShown)) continue;
      vals.push(v);
      sets.push(field + ' = $' + vals.length);
      notes.push(spec.quiet ? spec.label + ' updated: ' + (v || '(cleared)') : spec.label + ': ' + oldShown + ' → ' + newShown);
    }
    // A new urgency moves the due date to match, unless a due date was set in the same save.
    if ('urgency' in body && !('due_at' in body) && body.urgency !== before.urgency) {
      const created = await p.query('SELECT created_at FROM jobs WHERE id = $1', [id]);
      const due = new Date(new Date(created.rows[0].created_at).getTime() + DUE_HOURS[body.urgency] * 3600 * 1000);
      vals.push(due);
      sets.push('due_at = $' + vals.length);
      notes.push('Due: moved to ' + EDITABLE.due_at.show(due) + ' to match the new urgency');
    }
    if (!sets.length) return res.json({ ok: true, changed: false });
    vals.push(id);
    await p.query('UPDATE jobs SET ' + sets.join(', ') + ', updated_at = now() WHERE id = $' + vals.length, vals);
    for (const n of notes) {
      await p.query('INSERT INTO job_updates (job_id, kind, body) VALUES ($1, $2, $3)', [id, 'change', n]);
    }
    res.json({ ok: true, changed: true });
  }));

  // ---------- Saved tenants ----------
  // Tenants aren't kept in a separate list: every job already records them, so
  // this returns the most recent details for each tenant (by name + address),
  // matching a name, address, phone or email. Used to fill in "New job".
  app.get('/api/admin/tenants', withDb(async function (p, req, res) {
    const q = String(req.query.q || '').trim().slice(0, 100);
    if (q.length < 2) return res.json({ ok: true, tenants: [] });
    const like = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
    const digits = q.replace(/\D/g, '');
    // One entry per person: same name and phone number (or same name and address
    // when there's no phone), taking the newest non-empty value of each detail so
    // an email given on an older report still fills in.
    const latest = function (col) {
      return '(array_agg(' + col + ' ORDER BY created_at DESC) FILTER (WHERE ' + col + ' IS NOT NULL AND ' + col + " <> ''))[1] AS " + col;
    };
    const r = await p.query(
      `SELECT ${['tenant_name', 'tenant_phone', 'tenant_email', 'property_address', 'access_days', 'access_time',
          'access_notes', 'key_permission', 'key_instructions'].map(latest).join(', ')},
         count(*)::int AS job_count, max(created_at) AS created_at
       FROM (
         SELECT *, lower(coalesce(tenant_name, '')) || '|' ||
           coalesce(nullif(regexp_replace(coalesce(tenant_phone, ''), '\\D', '', 'g'), ''), lower(coalesce(property_address, ''))) AS person
         FROM jobs
         WHERE (tenant_name ILIKE $1 OR property_address ILIKE $1 OR tenant_email ILIKE $1
                OR ($2 <> '' AND regexp_replace(coalesce(tenant_phone, ''), '\\D', '', 'g') LIKE '%' || $2 || '%'))
           AND (tenant_name IS NOT NULL OR property_address IS NOT NULL)
       ) x
       GROUP BY person
       ORDER BY max(created_at) DESC
       LIMIT 8`, [like, digits.length >= 4 ? digits : '']);
    const tenants = r.rows;
    res.json({ ok: true, tenants: tenants });
  }));

  // ---------- AI email drafts ----------
  // Drafts an email about a job for a council, landlord, tenant, contractor or
  // anyone else. Built here from the saved job so the page only sends the
  // choice of recipient and what the email should say. Costs are only shared
  // with landlords.
  const RECIPIENTS = {
    Council: 'the local council (for example environmental health, housing standards, pest control, highways, waste and bins, building control, or council tax — pick the right department from the issue and instructions). Write formally, identify the property clearly, explain the problem factually, say what action is requested of the council, and ask for a reference number and timescale.',
    Landlord: 'the landlord who owns the property. Keep it professional and concise: what was reported, what has been done so far, the recommended next step, and any cost that needs their approval.',
    Tenant: 'the tenant who lives at the property. Be warm, clear and reassuring, in plain English, with any next steps for them.',
    Contractor: 'a contractor who will carry out the work. Be practical: the job, the address, access arrangements and tenant contact, and what is needed by when.',
    Other: 'the recipient described in the instructions.'
  };

  app.post('/api/admin/jobs/:id/ai-email', withDb(async function (p, req, res) {
    if (!opts.askAi || !opts.canAi || !opts.canAi()) return res.status(503).json({ ok: false, error: 'ai-not-configured' });
    const body = req.body || {};
    const recipient = RECIPIENTS[body.recipient] ? body.recipient : 'Other';
    const toName = str(body.to_name, 200);
    const instructions = str(body.instructions, 2000);
    const variation = Math.max(0, Math.min(20, parseInt(body.variation, 10) || 0));
    const r = await p.query('SELECT * FROM jobs WHERE id = $1', [jobId(req)]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'not-found' });
    const j = r.rows[0];
    const u = await p.query(`SELECT created_at, kind, body FROM job_updates WHERE job_id = $1 AND kind IN ('note', 'completed', 'change')
      ORDER BY created_at DESC LIMIT 8`, [j.id]);

    const fact = function (label, v) { return v ? '- ' + label + ': ' + String(v).replace(/\s+/g, ' ').trim() + '\n' : ''; };
    const when = function (d) { return d ? new Date(d).toLocaleString('en-GB', { timeZone: 'Europe/London', dateStyle: 'medium', timeStyle: 'short' }) : ''; };
    let facts = fact('Job reference', refFor(j.id)) + fact('Property', j.property_address) +
      fact('Issue', [j.category, j.affected, j.symptom].filter(Boolean).join(' – ')) + fact('Location in property', j.location) +
      fact('Description', j.description) + fact('Urgency', j.urgency) + fact('Status', j.status) +
      fact('Reported', when(j.created_at)) + fact('Deadline', when(j.due_at)) + fact('Completed', when(j.completed_at)) +
      fact('Completion notes', j.completion_notes) + fact('Assigned contractor', j.assigned_to) + fact('Next steps', j.next_steps);
    if (recipient === 'Tenant' || recipient === 'Contractor' || recipient === 'Landlord') facts += fact('Tenant name', j.tenant_name);
    if (recipient === 'Contractor') {
      facts += fact('Tenant phone', j.tenant_phone) + fact('Access days', j.access_days) + fact('Best time', j.access_time) +
        fact('Access notes', j.access_notes) + fact('Keys can be released to contractor', j.key_permission) + fact('Contractor notes', j.key_instructions);
    }
    if (recipient === 'Landlord') {
      facts += fact('Estimated cost to landlord', j.landlord_charge != null ? '£' + Number(j.landlord_charge).toFixed(2) : null);
    }
    const history = u.rows.reverse().map(function (x) { return '- ' + when(x.created_at) + ': ' + String(x.body).replace(/\s+/g, ' ').slice(0, 300); }).join('\n');

    const prompt = 'You write emails for Residential Realtors, a UK letting and property management agency, about property repairs.\n\n' +
      'Write an email to ' + RECIPIENTS[recipient] + (toName ? ' Address it to: ' + toName + '.' : '') + '\n\n' +
      'Job details:\n' + facts + (history ? '\nRecent history:\n' + history + '\n' : '') +
      (instructions ? '\nWhat this email needs to do (from the staff member): ' + instructions + '\n' : '') +
      '\nRules: use UK English. Only use the facts above — never invent names, dates, costs, reference numbers or events; where something is needed but unknown, put a placeholder in square brackets such as [DATE]. ' +
      'Include the job reference. Do not mention internal costs, profit or margins' + (recipient === 'Landlord' ? ' other than the cost to the landlord given above' : '') + '. ' +
      'Sign off as "Residential Realtors Maintenance Team". Keep it as short as the purpose allows. ' +
      (variation ? 'This is alternative draft number ' + variation + ', so word it differently from a standard version. ' : '') +
      'Reply with ONLY a JSON object: {"subject": "...", "body": "..."} where body is plain text with \\n line breaks and no markdown.';

    const result = await opts.askAi(prompt, true);
    if (!result.ok) return res.status(502).json({ ok: false, error: 'ai-failed' });
    let parsed = null;
    try {
      parsed = JSON.parse(result.text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim());
    } catch (e) { /* fall through */ }
    if (!parsed || !parsed.body) return res.status(502).json({ ok: false, error: 'ai-bad-reply' });
    res.json({ ok: true, subject: String(parsed.subject || '').slice(0, 300), body: String(parsed.body).slice(0, 10000) });
  }));

  // Emails sent to someone other than the tenant (council, landlord…), when email is set up.
  app.post('/api/admin/jobs/:id/email', withDb(async function (p, req, res) {
    if (!canEmail()) return res.status(503).json({ ok: false, error: 'email-not-configured' });
    const b = req.body || {};
    const to = str(b.to, 200);
    const subject = str(b.subject, 300);
    const text = str(b.body, 10000);
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ ok: false, error: 'bad-address' });
    if (!subject || !text) return res.status(400).json({ ok: false, error: 'empty' });
    const id = jobId(req);
    const r = await p.query('SELECT id FROM jobs WHERE id = $1', [id]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'not-found' });
    const sent = await sendEmail({ to: [to], subject: subject, text: text });
    if (!sent.ok) return res.status(502).json({ ok: false, error: 'send-failed' });
    await p.query('INSERT INTO job_updates (job_id, kind, body) VALUES ($1, $2, $3)',
      [id, 'email', 'Emailed ' + to + ' — ' + subject + '\n\n' + text]);
    await p.query('UPDATE jobs SET updated_at = now() WHERE id = $1', [id]);
    res.json({ ok: true });
  }));

  // ---------- Landlord invoices ----------
  // The PDF is made in the browser; this records that it was issued (number,
  // date, total) and remembers the landlord for this job.
  app.post('/api/admin/jobs/:id/invoice', withDb(async function (p, req, res) {
    const id = jobId(req);
    const b = req.body || {};
    const total = money(b.total);
    if (total === undefined || total === null) return res.status(400).json({ ok: false, error: 'bad-total' });
    const number = str(b.invoice_number, 50) || ('INV-' + refFor(id));
    const r = await p.query(
      `UPDATE jobs SET invoice_number = $2, invoiced_at = now(), invoice_total = $3,
         landlord_name = coalesce($4, landlord_name), landlord_email = coalesce($5, landlord_email),
         landlord_phone = coalesce($6, landlord_phone), landlord_address = coalesce($7, landlord_address), updated_at = now()
       WHERE id = $1 RETURNING id`, [id, number, total, str(b.landlord_name, 200), str(b.landlord_email, 200),
        str(b.landlord_phone, 50), str(b.landlord_address, 500)]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'not-found' });
    await p.query('INSERT INTO job_updates (job_id, kind, body) VALUES ($1, $2, $3)',
      [id, 'email', 'Invoice ' + number + ' issued to ' + (str(b.landlord_name, 200) || 'the landlord') + ' for ' + gbp(total) +
        (str(b.how, 100) ? ' (' + str(b.how, 100) + ')' : '') + '.']);
    res.json({ ok: true, invoice_number: number });
  }));

  // Suggests an itemised breakdown of the charge to the landlord (labour,
  // materials, call-out…) that adds up exactly to the total staff entered. It's
  // a starting point for staff to check and edit, never sent without review.
  app.post('/api/admin/jobs/:id/ai-invoice', withDb(async function (p, req, res) {
    if (!opts.askAi || !opts.canAi || !opts.canAi()) return res.status(503).json({ ok: false, error: 'ai-not-configured' });
    const total = money((req.body || {}).total);
    if (!total) return res.status(400).json({ ok: false, error: 'bad-total' });
    const r = await p.query('SELECT * FROM jobs WHERE id = $1', [jobId(req)]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'not-found' });
    const j = r.rows[0];
    const fact = function (label, v) { return v ? '- ' + label + ': ' + String(v).replace(/\s+/g, ' ').trim() + '\n' : ''; };
    const prompt = 'You itemise invoices for Residential Realtors, a UK letting agent, billing a landlord for a repair.\n\n' +
      'Repair:\n' + fact('Issue', [j.category, j.affected, j.symptom].filter(Boolean).join(' – ')) + fact('Location', j.location) +
      fact('Tenant description', j.description) + fact('Work carried out', j.completion_notes) + fact('Contractor', j.assigned_to) +
      '\nThe total to charge the landlord is £' + total.toFixed(2) + ' (excluding VAT).\n\n' +
      'Break this total into 2 to 5 clear invoice lines typical for this kind of UK repair, e.g. labour (with a sensible number of hours), ' +
      'materials or parts, call-out or attendance, waste disposal, or management/arrangement fee — only lines that fit this job. ' +
      'Each description should be short and specific to the job. Amounts in pounds with 2 decimals, and they must add up to exactly £' + total.toFixed(2) + '. ' +
      'Do not invent brand names, part numbers or dates. ' +
      'Reply with ONLY JSON: {"lines": [{"desc": "...", "amount": 0.00}]}';
    const result = await opts.askAi(prompt, true);
    if (!result.ok) return res.status(502).json({ ok: false, error: 'ai-failed' });
    let lines = null;
    try {
      const parsed = JSON.parse(result.text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim());
      lines = (parsed.lines || []).map(function (l) { return { desc: str(l.desc, 300), amount: money(l.amount) }; })
        .filter(function (l) { return l.desc && typeof l.amount === 'number' && l.amount > 0; }).slice(0, 8);
    } catch (e) { lines = null; }
    if (!lines || !lines.length) return res.status(502).json({ ok: false, error: 'ai-bad-reply' });
    // Make the lines add up to the total exactly (adjust the largest line by any rounding gap).
    const sum = Math.round(lines.reduce(function (a, l) { return a + l.amount; }, 0) * 100);
    const gap = Math.round(total * 100) - sum;
    if (gap !== 0) {
      if (Math.abs(gap) > Math.round(total * 100) * 0.2) {
        // Too far off to trust: scale every line to the total.
        const factor = total / (sum / 100);
        lines.forEach(function (l) { l.amount = Math.round(l.amount * factor * 100) / 100; });
      }
      const again = Math.round(total * 100) - Math.round(lines.reduce(function (a, l) { return a + l.amount; }, 0) * 100);
      const biggest = lines.reduce(function (a, l) { return l.amount > a.amount ? l : a; }, lines[0]);
      biggest.amount = Math.round((biggest.amount * 100 + again)) / 100;
    }
    res.json({ ok: true, lines: lines });
  }));

  // ---------- Photos ----------
  app.get('/api/admin/photos/:id', withDb(async function (p, req, res) {
    const r = await p.query('SELECT mime, data FROM job_photos WHERE id = $1', [jobId(req)]);
    if (!r.rows.length) return res.status(404).send('Not found');
    res.setHeader('Content-Type', r.rows[0].mime);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(r.rows[0].data);
  }));

  app.post('/api/admin/jobs/:id/photos', withDb(async function (p, req, res) {
    const id = jobId(req);
    const photos = decodePhotos((req.body || {}).photos);
    if (!photos.length) return res.status(400).json({ ok: false, error: 'no-photos' });
    const r = await p.query('UPDATE jobs SET updated_at = now() WHERE id = $1 RETURNING id', [id]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'not-found' });
    await insertPhotos(p, id, photos, 'staff');
    await p.query('INSERT INTO job_updates (job_id, kind, body) VALUES ($1, $2, $3)',
      [id, 'note', photos.length + ' photo' + (photos.length === 1 ? '' : 's') + ' added by staff.']);
    res.json({ ok: true, added: photos.length });
  }));

  // ---------- Archive ----------
  // "Deleting" a job moves it to the archive: hidden from the day-to-day lists
  // but kept with all its details, photos and history, and can be restored.
  app.post('/api/admin/jobs/:id/archive', withDb(async function (p, req, res) {
    const id = jobId(req);
    const reason = str((req.body || {}).reason, 500);
    const r = await p.query('UPDATE jobs SET archived_at = now(), archived_reason = $2, updated_at = now() WHERE id = $1 AND archived_at IS NULL RETURNING id', [id, reason]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'not-found-or-archived' });
    await p.query('INSERT INTO job_updates (job_id, kind, body) VALUES ($1, $2, $3)',
      [id, 'change', 'Job deleted and moved to the archive.' + (reason ? ' Reason: ' + reason : '')]);
    res.json({ ok: true });
  }));

  app.post('/api/admin/jobs/:id/restore', withDb(async function (p, req, res) {
    const id = jobId(req);
    const r = await p.query('UPDATE jobs SET archived_at = NULL, archived_reason = NULL, updated_at = now() WHERE id = $1 AND archived_at IS NOT NULL RETURNING id', [id]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'not-found-or-not-archived' });
    await p.query('INSERT INTO job_updates (job_id, kind, body) VALUES ($1, $2, $3)', [id, 'change', 'Job restored from the archive.']);
    res.json({ ok: true });
  }));

  // Permanently delete a job, with its photos and history (cascade). Only
  // jobs already in the archive can be deleted this way.
  app.delete('/api/admin/jobs/:id', withDb(async function (p, req, res) {
    const r = await p.query('DELETE FROM jobs WHERE id = $1 AND archived_at IS NOT NULL RETURNING id', [jobId(req)]);
    if (!r.rows.length) return res.status(409).json({ ok: false, error: 'not-archived' });
    res.json({ ok: true });
  }));

  // ---------- Contractors ----------
  function cleanContractor(b) {
    const out = {};
    if ('name' in b) { out.name = str(b.name, 200); if (!out.name) return null; }
    ['trade', 'email'].forEach(function (f) { if (f in b) out[f] = str(b[f], 200); });
    if ('phone' in b) out.phone = str(b.phone, 50);
    if ('notes' in b) out.notes = str(b.notes, 1000);
    if ('active' in b) out.active = !!b.active;
    return out;
  }

  app.get('/api/admin/contractors', withDb(async function (p, req, res) {
    const r = await p.query('SELECT id, name, trade, phone, email, notes, active FROM contractors ORDER BY active DESC, lower(name)');
    res.json({ ok: true, contractors: r.rows });
  }));

  app.post('/api/admin/contractors', withDb(async function (p, req, res) {
    const c = cleanContractor(req.body || {});
    if (!c || !c.name) return res.status(400).json({ ok: false, error: 'name-required' });
    const r = await p.query('INSERT INTO contractors (name, trade, phone, email, notes) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [c.name, c.trade || null, c.phone || null, c.email || null, c.notes || null]);
    res.json({ ok: true, id: r.rows[0].id });
  }));

  // Editing a contractor's name also updates the open jobs assigned to them, so
  // they stay linked to the right person.
  app.patch('/api/admin/contractors/:id', withDb(async function (p, req, res) {
    const id = jobId(req);
    const c = cleanContractor(req.body || {});
    if (!c) return res.status(400).json({ ok: false, error: 'name-required' });
    const cur = await p.query('SELECT name FROM contractors WHERE id = $1', [id]);
    if (!cur.rows.length) return res.status(404).json({ ok: false, error: 'not-found' });
    const keys = Object.keys(c);
    if (!keys.length) return res.json({ ok: true });
    await p.query('UPDATE contractors SET ' + keys.map(function (k, i) { return k + ' = $' + (i + 1); }).join(', ') +
      ' WHERE id = $' + (keys.length + 1), keys.map(function (k) { return c[k]; }).concat([id]));
    if (c.name && c.name !== cur.rows[0].name) {
      await p.query(`UPDATE jobs SET assigned_to = $1 WHERE assigned_to = $2 AND status NOT IN ('Completed', 'Cancelled')`,
        [c.name, cur.rows[0].name]);
    }
    res.json({ ok: true });
  }));

  // A job added by hand (phone call, email, inspection…). Uses the same cleaning
  // rules as editing. "Received" can be set to when the call actually came in,
  // and the deadline follows from it unless one is given.
  app.post('/api/admin/jobs', withDb(async function (p, req, res) {
    const body = req.body || {};
    const cols = [];
    const vals = [];
    const add = function (col, v) { cols.push(col); vals.push(v); };
    const fields = ['tenant_name', 'tenant_email', 'tenant_phone', 'property_address', 'category', 'affected',
      'symptom', 'location', 'description', 'access_days', 'access_time', 'access_notes', 'key_permission',
      'key_instructions', 'assigned_to', 'next_steps', 'estimated_cost', 'landlord_charge',
      'landlord_name', 'landlord_email', 'landlord_phone', 'landlord_address'];
    for (const f of fields) {
      if (!(f in body)) continue;
      const v = EDITABLE[f].clean(body[f]);
      if (v === undefined) return res.status(400).json({ ok: false, error: 'invalid-' + f });
      if (v !== null) add(f, v);
    }
    if (!body.property_address || !str(body.property_address)) return res.status(400).json({ ok: false, error: 'address-required' });
    if (!body.category && !body.description) return res.status(400).json({ ok: false, error: 'issue-required' });

    const urgency = URGENCIES.indexOf(body.urgency) !== -1 ? body.urgency : 'Routine';
    const source = SOURCES.indexOf(body.source) !== -1 && body.source !== 'Online report' ? body.source : 'Phone call';
    let received = body.received_at ? new Date(body.received_at) : new Date();
    if (isNaN(received) || received > new Date(Date.now() + 5 * 60 * 1000)) received = new Date();
    let due = body.due_at ? new Date(body.due_at) : null;
    if (!due || isNaN(due)) due = new Date(received.getTime() + DUE_HOURS[urgency] * 3600 * 1000);
    const status = str(body.assigned_to) ? 'Assigned' : 'New';
    add('urgency', urgency); add('source', source); add('created_at', received); add('due_at', due); add('status', status);

    const r = await p.query('INSERT INTO jobs (' + cols.join(', ') + ') VALUES (' +
      cols.map(function (_, i) { return '$' + (i + 1); }).join(', ') + ') RETURNING id', vals);
    const id = r.rows[0].id;
    await p.query('INSERT INTO job_updates (job_id, kind, body) VALUES ($1, $2, $3)',
      [id, 'created', 'Job added by staff (' + source + ', ' + urgency + ').' +
        (str(body.assigned_to) ? ' Assigned to ' + str(body.assigned_to, 200) + '.' : '')]);
    res.json({ ok: true, id: id, ref: refFor(id) });
  }));

  app.post('/api/admin/jobs/:id/updates', withDb(async function (p, req, res) {
    const id = jobId(req);
    const text = str((req.body || {}).body, 5000);
    const kind = ['tenant_message', 'contractor_message', 'email'].indexOf((req.body || {}).kind) !== -1 ? req.body.kind : 'note';
    if (!text) return res.status(400).json({ ok: false, error: 'empty' });
    const r = await p.query('UPDATE jobs SET updated_at = now() WHERE id = $1 RETURNING id', [id]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'not-found' });
    await p.query('INSERT INTO job_updates (job_id, kind, body) VALUES ($1, $2, $3)', [id, kind, text]);
    res.json({ ok: true });
  }));

  app.post('/api/admin/jobs/:id/complete', withDb(async function (p, req, res) {
    const id = jobId(req);
    const notes = str((req.body || {}).notes, 5000);
    const r = await p.query(
      `UPDATE jobs SET status = 'Completed', completed_at = now(), completion_notes = $2, updated_at = now()
       WHERE id = $1 RETURNING completed_at`, [id, notes]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'not-found' });
    await p.query('INSERT INTO job_updates (job_id, kind, body) VALUES ($1, $2, $3)',
      [id, 'completed', 'Job marked completed.' + (notes ? ' ' + notes : '')]);
    res.json({ ok: true });
  }));

  app.post('/api/admin/jobs/:id/reopen', withDb(async function (p, req, res) {
    const id = jobId(req);
    const r = await p.query(
      `UPDATE jobs SET status = 'Assigned', completed_at = NULL, updated_at = now() WHERE id = $1 RETURNING id`, [id]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'not-found' });
    await p.query('INSERT INTO job_updates (job_id, kind, body) VALUES ($1, $2, $3)', [id, 'change', 'Job reopened.']);
    res.json({ ok: true });
  }));

  app.post('/api/admin/jobs/:id/email-tenant', withDb(async function (p, req, res) {
    if (!canEmail()) return res.status(503).json({ ok: false, error: 'email-not-configured' });
    const id = jobId(req);
    const subject = str((req.body || {}).subject, 300);
    const text = str((req.body || {}).body, 10000);
    if (!subject || !text) return res.status(400).json({ ok: false, error: 'empty' });
    const r = await p.query('SELECT tenant_email FROM jobs WHERE id = $1', [id]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'not-found' });
    const to = r.rows[0].tenant_email;
    if (!to) return res.status(400).json({ ok: false, error: 'no-tenant-email' });
    const sent = await sendEmail({ to: [to], subject: subject, text: text });
    if (!sent.ok) return res.status(502).json({ ok: false, error: 'send-failed' });
    await p.query('INSERT INTO job_updates (job_id, kind, body) VALUES ($1, $2, $3)',
      [id, 'tenant_message', 'Emailed tenant — ' + subject + '\n\n' + text]);
    await p.query('UPDATE jobs SET updated_at = now() WHERE id = $1', [id]);
    res.json({ ok: true });
  }));

  return { saveReport: saveReport, hasDb: async function () { return !!(await db()); } };
};
