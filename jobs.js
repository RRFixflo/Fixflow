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
`;

// Everything the list view needs; the PDF and full report text are left out so
// the list stays quick however many jobs there are.
const LIST_COLUMNS = `id, created_at, updated_at, status, urgency, due_at, tenant_name, tenant_email,
  tenant_phone, property_address, category, affected, symptom, location, assigned_to, next_steps,
  estimated_cost, actual_cost, landlord_charge, completed_at, photo_count`;

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
      .then(function () { console.log('Jobs database ready'); return true; })
      .catch(function (err) { console.error('Jobs database setup failed:', err.message); return false; });
  } else if (DATABASE_URL && !Pool) {
    console.error('DATABASE_URL is set but the pg package is missing; run npm install');
  }

  async function db() {
    return (await ready) ? pool : null;
  }

  // ---------- Saving a submitted report ----------
  async function saveReport(r, pdfBase64, pdfFilename, reportText) {
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
    res.json({ ok: true, db: !!(await db()), canEmail: canEmail(), statuses: STATUSES, urgencies: URGENCIES, dueHours: DUE_HOURS });
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
    res.json({ ok: true, job: job, updates: u.rows });
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

  app.post('/api/admin/jobs/:id/updates', withDb(async function (p, req, res) {
    const id = jobId(req);
    const text = str((req.body || {}).body, 5000);
    const kind = (req.body || {}).kind === 'tenant_message' ? 'tenant_message' : 'note';
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
