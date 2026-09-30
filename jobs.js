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
const express = require('express');
const tenancy = require('./tenancy');

let Pool = null;
try { Pool = require('pg').Pool; } catch (e) { /* pg not installed: jobs disabled */ }

// How long each urgency gets before a job is overdue (the end of each target
// window: Emergency 24-48 hours, Urgent 3-5 days, Routine 7-14 days). A job's own
// due date can be changed in the dashboard; these only set the starting point.
// When this version went live: each Railway deploy starts the app afresh.
const DEPLOYED_AT = new Date().toISOString();
const DUE_HOURS = { Emergency: 48, Urgent: 24 * 5, Routine: 24 * 14 };
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
// Instant phone alerts for new reports, via the free ntfy app (ntfy.sh).
//   NTFY_TOPIC   a long random channel name; staff subscribe to it in the app
//   NTFY_SERVER  optional, defaults to https://ntfy.sh
// Alerts carry the address, issue and urgency only, never tenant contact details.
const NTFY_TOPIC = process.env.NTFY_TOPIC || '';
const NTFY_SERVER = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/+$/, '');
const PUBLIC_URL = process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : '');
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
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS direct_contact TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS summary TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS appointment_date TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS appointment_time TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS landlord_handles TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS landlord_contractor TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS landlord_address TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS contractor_paid_at TIMESTAMPTZ;
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
CREATE TABLE IF NOT EXISTS landlords (
  id         SERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  name       TEXT NOT NULL,
  email      TEXT,
  phone      TEXT,
  address    TEXT,
  notes      TEXT
);
CREATE TABLE IF NOT EXISTS property_landlords (
  property_key TEXT PRIMARY KEY,
  address      TEXT,
  landlord_id  INTEGER NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tenants (
  id         SERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  name       TEXT,
  phone      TEXT,
  email      TEXT,
  notes      TEXT
);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS deleted_key TEXT;
CREATE TABLE IF NOT EXISTS property_tenants (
  tenant_id    INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  property_key TEXT NOT NULL,
  address      TEXT,
  moved_out_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, property_key)
);
CREATE TABLE IF NOT EXISTS invoices (
  id             SERIAL PRIMARY KEY,
  job_id         INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  number         TEXT,
  total          NUMERIC(10,2),
  landlord_name  TEXT,
  landlord_email TEXT,
  data           JSONB
);
CREATE INDEX IF NOT EXISTS invoices_job_idx ON invoices (job_id, id);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS photo_token TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS jobs_photo_token_idx ON jobs (photo_token);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS track_token TEXT;
CREATE TABLE IF NOT EXISTS job_parts (
  id          SERIAL PRIMARY KEY,
  job_id      INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  description TEXT NOT NULL,
  supplier    TEXT,
  cost        NUMERIC(10,2),
  charge      NUMERIC(10,2),
  status      TEXT NOT NULL DEFAULT 'Ordered'
);
CREATE INDEX IF NOT EXISTS job_parts_job_idx ON job_parts (job_id, id);
CREATE TABLE IF NOT EXISTS property_certificates (
  id           SERIAL PRIMARY KEY,
  property_key TEXT NOT NULL,
  address      TEXT,
  type         TEXT NOT NULL,
  issued_on    TEXT,
  expires_on   TEXT,
  reference    TEXT,
  rating       TEXT,
  notes        TEXT,
  job_id       INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  reminded_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (property_key, type)
);
ALTER TABLE property_certificates ADD COLUMN IF NOT EXISTS not_required BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS epc_checks (
  property_key TEXT PRIMARY KEY,
  checked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  found        BOOLEAN NOT NULL DEFAULT false
);
ALTER TABLE epc_checks ADD COLUMN IF NOT EXISTS address_synced BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS tenancies (
  id           SERIAL PRIMARY KEY,
  property_key TEXT,
  address      TEXT,
  start_date   TEXT,
  data         JSONB NOT NULL DEFAULT '{}'::jsonb,
  log          JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tenancies_key ON tenancies (property_key);
CREATE TABLE IF NOT EXISTS admin_sessions (
  id          TEXT PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip          TEXT,
  user_agent  TEXT,
  revoked_at  TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS site_visits (
  day     TEXT NOT NULL,
  page    TEXT NOT NULL,
  visits  INTEGER NOT NULL DEFAULT 0,
  uniques INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, page)
);
CREATE TABLE IF NOT EXISTS site_visitors (
  day   TEXT NOT NULL,
  page  TEXT NOT NULL,
  vhash TEXT NOT NULL,
  PRIMARY KEY (day, page, vhash)
);
CREATE TABLE IF NOT EXISTS site_sessions (
  sid           TEXT PRIMARY KEY,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  landing       TEXT,
  pages         TEXT[] NOT NULL DEFAULT '{}',
  device        TEXT,
  browser       TEXT,
  os            TEXT,
  source        TEXT,
  ref_host      TEXT,
  screen        TEXT,
  lang          TEXT,
  tz            TEXT,
  chosen_lang   TEXT,
  steps         TEXT[] NOT NULL DEFAULT '{}',
  categories    TEXT[] NOT NULL DEFAULT '{}',
  subject       TEXT,
  job_id        INTEGER,
  submitted_ref TEXT,
  views         INTEGER NOT NULL DEFAULT 0,
  events        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS site_sessions_started_idx ON site_sessions (started_at);
CREATE TABLE IF NOT EXISTS tenant_notices (
  id            SERIAL PRIMARY KEY,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  subject       TEXT,
  body          TEXT NOT NULL,
  audience      TEXT,
  property_keys TEXT[] NOT NULL DEFAULT '{}',
  recipients    JSONB NOT NULL DEFAULT '[]'::jsonb,
  sent          JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS shared_docs (
  id         SERIAL PRIMARY KEY,
  token      TEXT NOT NULL UNIQUE,
  job_id     INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
  name       TEXT,
  pdf        BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_track_token_idx ON jobs (track_token);
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
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS escalation_email TEXT;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS portal_token TEXT;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS portal_on BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS portal_seen_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS job_updates_created_idx ON job_updates (created_at);
`;

// ---------- Landlords and their properties ----------
// A property is identified by a tidied-up version of its address (postcode
// removed, case/punctuation ignored, Street -> st etc.). This must match
// propKey() in admin.html so both sides agree on which property is which.
const POSTCODE_RE = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i;
const ADDR_WORDS = { street: 'st', road: 'rd', avenue: 'ave', lane: 'ln', drive: 'dr', close: 'cl', court: 'ct', place: 'pl', crescent: 'cres', gardens: 'gdns', apartment: 'flat', apt: 'flat' };
// Job addresses need at least a door number and a full postcode. The postcode
// is tidied to capitals with a single space (se16rw -> SE1 6RW).
// A booked visit: the day (YYYY-MM-DD) and a free-text time ("Morning", "10am").
function apptDay(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || ''));
  if (!m) return '';
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
  if (dt.getUTCMonth() !== +m[2] - 1 || dt.getUTCDate() !== +m[3]) return '';   // e.g. 31 February
  return dt.toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
}
function certDay(v) { return apptDay(v) ? new Date(v + 'T12:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' }) : ''; }
function apptText(j) { const d = apptDay(j.appointment_date); return d ? d + (j.appointment_time ? ', ' + j.appointment_time : '') : ''; }
function tidyAddress(v) {
  const s = str(v, 500);
  return s ? s.replace(POSTCODE_RE, function (m, a, b) { return a.toUpperCase() + ' ' + b.toUpperCase(); }).replace(/\s+/g, ' ').replace(/\s+,/g, ',') : s;
}
function addressProblem(a) {
  if (!a) return 'address';
  if (!POSTCODE_RE.test(a)) return 'postcode';
  if (!/\d/.test(a.replace(POSTCODE_RE, ' '))) return 'door';
  return null;
}
function propKey(addr) {
  return String(addr || '').replace(POSTCODE_RE, ' ').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean)
    .map(function (w) { return ADDR_WORDS[w] || w; }).join(' ');
}

// Saves a landlord (matched to an existing one by id, name or email, whose
// details are topped up rather than wiped) and, given an address, records that
// the property is theirs. Returns the landlord id, or null without a name.
async function ensureLandlord(p, l, address) {
  const name = str(l.landlord_name || l.name, 200);
  if (!name) return null;
  const email = str(l.landlord_email || l.email, 200), phone = str(l.landlord_phone || l.phone, 50), addr = str(l.landlord_address || l.address, 500);
  let id = parseInt(l.landlord_id, 10) || null;
  if (!id) {
    const m = await p.query(`SELECT id FROM landlords WHERE lower(name) = lower($1) OR ($2::text IS NOT NULL AND lower(email) = lower($2))
      ORDER BY (lower(name) = lower($1)) DESC, id LIMIT 1`, [name, email]);
    if (m.rows.length) id = m.rows[0].id;
  }
  if (id) {
    await p.query(`UPDATE landlords SET email = coalesce($2, email), phone = coalesce($3, phone), address = coalesce($4, address), updated_at = now() WHERE id = $1`,
      [id, email, phone, addr]);
  } else {
    id = (await p.query('INSERT INTO landlords (name, email, phone, address) VALUES ($1, $2, $3, $4) RETURNING id', [name, email, phone, addr])).rows[0].id;
  }
  const key = propKey(address);
  if (key) {
    await p.query(`INSERT INTO property_landlords (property_key, address, landlord_id) VALUES ($1, $2, $3)
      ON CONFLICT (property_key) DO UPDATE SET landlord_id = excluded.landlord_id, address = excluded.address, updated_at = now()`, [key, str(address, 500), id]);
  }
  return id;
}

// ---------- Tenants ----------
// A tenant is matched by phone number (last 10 digits, so 07… and +44 7… agree),
// then email, then the same name at the same property. Details are topped up,
// never wiped, and the property is linked (a property can have many tenants).
function phoneTail(v) { const d = String(v || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : ''; }
const PLACEHOLDER_NAMES = ['', 'tenant', 'tenants', 'no name'];
// A tenant deleted on the Tenants page stays deleted when their old jobs are
// edited; only a new report, a new job or adding them again (restore) brings
// them back.
async function ensureTenant(p, t, address, restore) {
  const name = str(t.tenant_name !== undefined ? t.tenant_name : t.name, 200);
  const phone = str(t.tenant_phone !== undefined ? t.tenant_phone : t.phone, 50);
  const email = str(t.tenant_email !== undefined ? t.tenant_email : t.email, 200);
  if (!name && !phone && !email) return null;
  const key = propKey(address);
  let row = null;
  const tail = phoneTail(phone);
  if (tail) row = (await p.query(`SELECT id, name, deleted_at FROM tenants WHERE right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 10) = $1 ORDER BY (deleted_at IS NULL) DESC, id LIMIT 1`, [tail])).rows[0];
  if (!row && email) row = (await p.query('SELECT id, name, deleted_at FROM tenants WHERE lower(email) = lower($1) ORDER BY (deleted_at IS NULL) DESC, id LIMIT 1', [email])).rows[0];
  if (!row && name && key) row = (await p.query(`SELECT t.id, t.name, t.deleted_at FROM tenants t JOIN property_tenants pt ON pt.tenant_id = t.id
    WHERE pt.property_key = $1 AND lower(t.name) = lower($2) ORDER BY t.id LIMIT 1`, [key, name])).rows[0];
  // Deleted tenants lose their property links, so also check by name at the address they had.
  if (!row && name && key) row = (await p.query(`SELECT id, name, deleted_at FROM tenants WHERE deleted_at IS NOT NULL AND lower(name) = lower($1)
    AND deleted_key = $2 ORDER BY id LIMIT 1`, [name, key])).rows[0];
  if (row && row.deleted_at) {
    if (!restore) return null;
    await p.query('UPDATE tenants SET deleted_at = NULL, deleted_key = NULL WHERE id = $1', [row.id]);
  }
  let id;
  if (row) {
    id = row.id;
    const betterName = name && PLACEHOLDER_NAMES.indexOf(String(row.name || '').trim().toLowerCase()) !== -1 ? name : null;
    await p.query('UPDATE tenants SET name = coalesce($2, name), phone = coalesce(phone, $3), email = coalesce(email, $4), updated_at = now() WHERE id = $1',
      [id, betterName, phone, email]);
  } else {
    id = (await p.query('INSERT INTO tenants (name, phone, email) VALUES ($1, $2, $3) RETURNING id', [name || 'Tenant', phone, email])).rows[0].id;
  }
  if (key) {
    await p.query(`INSERT INTO property_tenants (tenant_id, property_key, address) VALUES ($1, $2, $3)
      ON CONFLICT (tenant_id, property_key) DO UPDATE SET address = excluded.address`, [id, key, str(address, 500)]);
  }
  return id;
}
async function migrateTenants(p) {
  const n = (await p.query('SELECT count(*)::int AS n FROM tenants')).rows[0].n;
  if (n > 0) return;
  const r = await p.query(`SELECT tenant_name, tenant_phone, tenant_email, property_address FROM jobs
    WHERE coalesce(tenant_name, '') <> '' OR coalesce(tenant_phone, '') <> '' OR coalesce(tenant_email, '') <> '' ORDER BY created_at, id`);
  for (const j of r.rows) await ensureTenant(p, j, j.property_address);
  if (r.rows.length) console.log('Built the tenant list from ' + r.rows.length + ' job(s)');
}

// First run: build the landlord list from landlord details already on jobs.
async function migrateLandlords(p) {
  const n = (await p.query('SELECT count(*)::int AS n FROM landlords')).rows[0].n;
  if (n > 0) return;
  const r = await p.query(`SELECT landlord_name, landlord_email, landlord_phone, landlord_address, property_address
    FROM jobs WHERE landlord_name IS NOT NULL AND landlord_name <> '' ORDER BY updated_at, id`);
  for (const j of r.rows) await ensureLandlord(p, j, j.property_address);
  if (r.rows.length) console.log('Built the landlord list from ' + r.rows.length + ' job(s)');
}

// Contractors can be loaded from the CONTRACTORS_SEED variable(s) (a JSON list of
// {name, trade, phone, email, escalation_email, notes}) so their details never have to be written
// into this public code. On startup any listed contractor not already in the
// directory (matched by name, phone or email) is added; existing ones, including
// any edited or removed in the dashboard, are left alone.
// Public organisations (council teams) are listed here rather than in the variable.
const BUILT_IN_CONTRACTORS = [
  { name: 'Southwark Council', trade: 'Council repairs', email: 'repairs@southwark.gov.uk', escalation_email: 'complaints@southwark.gov.uk', notes: 'Southwark Council repairs team' },
  { name: 'Marathon Energy', trade: 'EPC assessor', notes: 'Energy Performance Certificates (EPC)' },
  { name: 'Leaksfromabove', trade: 'Council – leaks from above', email: 'leaksfromabove@southwark.gov.uk', escalation_email: 'complaints@southwark.gov.uk', notes: 'Southwark Council leaks from above team' }
];
async function seedContractors(p) {
  // CONTRACTORS_SEED plus any extra variables named CONTRACTORS_SEED_<anything>,
  // so a contractor can be added without rewriting the existing list.
  let list = [];
  Object.keys(process.env).filter(function (k) { return /^CONTRACTORS_SEED(_\w+)?$/.test(k); }).sort().forEach(function (k) {
    let part;
    try { part = JSON.parse(process.env[k]); } catch (e) { console.error(k + ' is not valid JSON'); return; }
    if (Array.isArray(part)) list = list.concat(part);
    else if (part && typeof part === 'object') list.push(part);
  });
  list = list.concat(BUILT_IN_CONTRACTORS);
  const have = (await p.query('SELECT name, phone, email FROM contractors')).rows;
  const digits = function (v) { return String(v || '').replace(/\D/g, ''); };
  let added = 0;
  for (const c of list) {
    if (!c || !str(c.name)) continue;
    const known = have.some(function (h) {
      return h.name.trim().toLowerCase() === str(c.name).toLowerCase() ||
        (digits(c.phone) && digits(h.phone) === digits(c.phone)) ||
        (str(c.email) && String(h.email || '').toLowerCase() === str(c.email).toLowerCase());
    });
    if (known) continue;
    await p.query('INSERT INTO contractors (name, trade, phone, email, escalation_email, notes) VALUES ($1, $2, $3, $4, $5, $6)',
      [str(c.name, 200), str(c.trade, 200), str(c.phone, 50), str(c.email, 200), str(c.escalation_email, 200), str(c.notes, 1000)]);
    added += 1;
  }
  if (added) console.log('Added ' + added + ' contractor' + (added === 1 ? '' : 's') + ' to the directory');
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
  access_time, access_notes, key_permission, key_instructions, direct_contact, summary, appointment_date, appointment_time, assigned_to, next_steps,
  estimated_cost, actual_cost, landlord_charge, completed_at, completion_notes, photo_count, source,
  archived_at, archived_reason, (SELECT count(*)::int FROM job_photos ph WHERE ph.job_id = jobs.id) AS photos_saved,
  (SELECT array_agg(ph.id ORDER BY ph.id) FROM job_photos ph WHERE ph.job_id = jobs.id) AS photo_ids,
  (SELECT coalesce(sum(jp.cost), 0) FROM job_parts jp WHERE jp.job_id = jobs.id) AS parts_cost,
  (SELECT coalesce(sum(jp.charge), 0) FROM job_parts jp WHERE jp.job_id = jobs.id) AS parts_charge,
  (SELECT count(*)::int FROM job_parts jp WHERE jp.job_id = jobs.id) AS parts_count,
  landlord_name, landlord_email, landlord_phone, landlord_address, invoice_number, invoiced_at, invoice_total, contractor_paid_at, landlord_handles, landlord_contractor`;

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


// The contractor's job page (served at /c/<token>): lists their jobs from the
// JSON endpoint and lets them mark each one completed.
const CONTRACTOR_PAGE_JS = `(function(){
  var TOKEN = __TOKEN__, list = document.getElementById('list');
  function esc(v){ return String(v == null ? '' : v).replace(/[&<>"']/g, function(c){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function day(v){ if (!v) return ''; var d = new Date(String(v).length === 10 ? v + 'T12:00:00' : v); return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }); }
  function item(icon, label, v){ return v ? '<div class="it"><span class="ic">' + icon + '</span><div><div class="lb">' + label + '</div><div class="vl">' + esc(v) + '</div></div></div>' : ''; }
  function first(n){ var s = String(n || '').trim(), m = /^(mrs|miss|mr|ms|mx|dr)\\b\\.?\\s*(.*)$/i.exec(s); if (/^tenant$/i.test(s)) return ''; if (m) { if (!m[2].trim()) return ''; m[2] = m[2].trim(); var t = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase(), w = m[2].split(/\\s+/); return t + ' ' + (w.length > 1 && w[0].replace(/\\./g, '').length === 1 ? w[w.length - 1] : w[0]); } return s.split(/\\s+/)[0] || ''; }
  function wa(v){ var n = String(v || '').replace(/[^0-9]/g, ''); if (/^0\\d{9,10}$/.test(n)) n = '44' + n.slice(1); return n.length >= 10 ? n : ''; }
  function load(){
    fetch('/api/c/' + TOKEN + '/jobs').then(function(r){ return r.json(); }).then(function(d){
      if (!d.ok) { list.innerHTML = '<p class="muted">This link is no longer active. Please contact Residential Realtors.</p>'; return; }
      var open = d.jobs.filter(function(j){ return j.status !== 'Completed'; }), done = d.jobs.filter(function(j){ return j.status === 'Completed'; });
      list.innerHTML = '<h2 style="font-size:1.05rem;margin:18px 0 8px">To do (' + open.length + ')</h2>' +
        (open.length ? open.map(card).join('') : '<p class="muted">No jobs waiting — thank you!</p>') +
        (done.length ? '<h2 style="font-size:1.05rem;margin:22px 0 8px">Completed in the last 30 days</h2>' + done.map(function(j){
          return '<div class="card" style="opacity:.75"><div class="ref">' + esc(j.ref) + ' · ✓ Completed ' + esc(day(j.completed_at)) + '</div><div>' + esc(j.property_address || '') + '</div><div class="muted">' + esc(j.summary || [j.category, j.affected, j.symptom].filter(Boolean).join(' · ')) + '</div></div>';
        }).join('') : '');
    }).catch(function(){ list.innerHTML = '<p class="muted">Couldn’t load your jobs — please check your connection and refresh.</p>'; });
  }
  function card(j){
    var urgent = j.urgency === 'Emergency' || j.urgency === 'Urgent';
    var access = j.direct_contact === 'No' ? 'Residential Realtors will arrange access with the tenant.' : 'Please contact the tenant directly to arrange a time.';
    var keys = j.key_permission ? j.key_permission + (j.key_instructions ? ' — ' + j.key_instructions : '') : '';
    return '<div class="card" data-id="' + j.id + '">' +
      '<div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline"><div class="ref">' + esc(j.ref) + '</div>' +
        (urgent ? '<span style="color:#D9262E;font-weight:700;font-size:.85rem">' + esc(j.urgency) + '</span>' : '<span class="muted">' + esc(j.status) + '</span>') + '</div>' +
      '<div style="font-weight:600;margin:4px 0">' + esc(j.property_address || '') + '</div>' +
      '<div>' + esc(j.summary || [j.category, j.affected, j.symptom].filter(Boolean).join(' · ')) + '</div>' +
      (j.appointment_date ? '<div style="margin:6px 0;font-weight:600">📅 Booked for ' + esc(day(j.appointment_date)) + (j.appointment_time ? ' at ' + esc(j.appointment_time) : '') + '</div>' : '') +
      '<details class="dt"><summary>Details and access</summary><div class="dbody">' +
        (j.description ? '<div class="desc">' + esc(j.description) + '</div>' : '') +
        item('📍', 'Where in the property', j.location) +
        (j.tenant_name || j.tenant_phone ? '<div class="tn"><div class="lb">Tenant</div><div class="vl" style="font-weight:600">' + esc(j.tenant_name || 'Tenant') + '</div>' +
          (j.tenant_phone ? '<div class="muted" style="margin:2px 0 8px">' + esc(j.tenant_phone) + '</div><div class="acts">' +
            '<a class="abtn" href="tel:' + esc(String(j.tenant_phone).replace(/[^0-9+]/g, '')) + '">📞 Call</a>' +
            (wa(j.tenant_phone) ? '<a class="abtn wa" target="_blank" rel="noopener" href="https://wa.me/' + wa(j.tenant_phone) + '?text=' + encodeURIComponent('Hi' + (first(j.tenant_name) ? ' ' + first(j.tenant_name) : '') + ', I’m the contractor from Residential Realtors for the repair at ' + (j.property_address || 'your property') + ' (' + j.ref + '). When would be a good time for me to come round?') + '">WhatsApp</a>' : '') +
          '</div>' : '') + '</div>' : '') +
        item('🔑', 'Access', access) + item('🕒', 'Best times', j.access_time) + item('🗝️', 'Keys', keys) + item('📝', 'Access notes', j.access_notes) +
        item('📆', 'Reported', day(j.created_at)) +
      '</div></details>' +
      '<details class="dt"><summary>📅 ' + (j.appointment_date ? 'Change the booking' : 'Booked a visit? Say when') + '</summary>' +
        '<form class="stack" style="margin:10px 0 0" data-book="' + j.id + '">' +
          '<label class="muted">Date<input type="date" name="date" required value="' + esc(j.appointment_date || '') + '" style="display:block;width:100%;margin-top:4px"></label>' +
          '<label class="muted">Time<input name="time" placeholder="e.g. 10am or 9–12" value="' + esc(j.appointment_time || '') + '" style="display:block;width:100%;margin-top:4px"></label>' +
          '<input name="note" placeholder="Note (optional), e.g. tenant confirmed">' +
          '<button type="submit">Save booking</button>' +
        '</form></details>' +
      '<details class="dt"><summary style="color:#139A4B">✓ Mark completed</summary>' +
        '<form class="stack" style="margin:10px 0 0" data-done="' + j.id + '">' +
          '<textarea name="notes" rows="3" placeholder="What did you do? (optional)" style="padding:12px 14px;border:1px solid #d5d7dd;border-radius:12px;font:inherit"></textarea>' +
          '<input name="price" inputmode="decimal" placeholder="Your price £ (optional)">' +
          '<label class="muted" style="display:block">Photos of the finished work (optional)<input type="file" name="photos" accept="image/*" multiple style="display:block;margin-top:6px;padding:10px;background:#fff"></label>' +
          '<button type="submit" style="background:#139A4B">Mark ' + esc(j.ref) + ' completed</button>' +
        '</form></details>' +
    '</div>';
  }
  // Photos are made smaller on the phone before sending (max 1600px, JPEG).
  function shrink(file){
    return new Promise(function(resolve){
      var fr = new FileReader();
      fr.onload = function(){
        var img = new Image();
        img.onload = function(){
          var k = Math.min(1, 1600 / Math.max(img.width, img.height)), cv = document.createElement('canvas');
          cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
          cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
          resolve({ name: file.name, dataUrl: cv.toDataURL('image/jpeg', 0.82) });
        };
        img.onerror = function(){ resolve(null); };
        img.src = fr.result;
      };
      fr.onerror = function(){ resolve(null); };
      fr.readAsDataURL(file);
    });
  }
  list.addEventListener('submit', function(e){
    var bk = e.target.closest('[data-book]');
    if (bk) {
      e.preventDefault();
      var bb = bk.querySelector('button'); bb.disabled = true; bb.textContent = 'Saving…';
      fetch('/api/c/' + TOKEN + '/jobs/' + bk.dataset.book + '/book', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: bk.date.value, time: bk.time.value.trim(), note: bk.note.value.trim() }) })
        .then(function(r){ return r.json(); }).then(function(d){
          if (!d.ok) { bb.disabled = false; bb.textContent = d.error === 'bad-date' ? 'Pick a valid date and try again' : 'Couldn’t save — try again'; return; }
          load();
        }).catch(function(){ bb.disabled = false; bb.textContent = 'Couldn’t save — try again'; });
      return;
    }
    var f = e.target.closest('[data-done]'); if (!f) return;
    e.preventDefault();
    var btn = f.querySelector('button'); btn.disabled = true; btn.textContent = 'Saving…';
    var price = f.price.value.replace(/[£,\\s]/g, '');
    var files = Array.prototype.slice.call(f.photos.files || [], 0, 10);
    if (files.length) btn.textContent = 'Uploading ' + files.length + ' photo' + (files.length === 1 ? '' : 's') + '…';
    Promise.all(files.map(shrink)).then(function(ph){ return fetch('/api/c/' + TOKEN + '/jobs/' + f.dataset.done + '/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: f.notes.value.trim(), price: price === '' ? null : price, photos: ph.filter(Boolean) }) }); })
      .then(function(r){ return r.json(); }).then(function(d){
        if (!d.ok) { btn.disabled = false; btn.textContent = d.error === 'bad-price' ? 'Check the price and try again' : 'Couldn’t save — try again'; return; }
        load();
      }).catch(function(){ btn.disabled = false; btn.textContent = 'Couldn’t save — try again'; });
  });
  load();
})();`;

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
      .then(function () { return migrateLandlords(pool).catch(function (err) { console.error('Landlord migration failed:', err.message); }); })
      .then(function () { return migrateTenants(pool).catch(function (err) { console.error('Tenant migration failed:', err.message); }); })
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
    try { r.address = await canonicalAddress(p, r.address); } catch (e) { /* keep as typed */ }
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
    // If we know whose property this is, record the landlord on the job.
    try {
      await p.query(`UPDATE jobs SET landlord_name = l.name, landlord_email = l.email, landlord_phone = l.phone, landlord_address = l.address
        FROM property_landlords pl JOIN landlords l ON l.id = pl.landlord_id WHERE jobs.id = $1 AND pl.property_key = $2`, [id, propKey(r.address)]);
    } catch (err) { console.error('Landlord lookup failed:', err.message); }
    try { await ensureTenant(p, { name: r.name, phone: r.phone, email: r.email }, r.address, true); } catch (err) { console.error('Saving tenant failed:', err.message); }
    // Photos are saved separately too, so staff can view them without the PDF.
    // A problem here shouldn't lose the report itself.
    try { await insertPhotos(p, id, decodePhotos(photos), 'tenant'); } catch (err) { console.error('Saving photos failed:', err.message); }
    await p.query('INSERT INTO job_updates (job_id, kind, body) VALUES ($1, $2, $3)',
      [id, 'created', 'Report submitted by ' + (str(r.name, 200) || 'tenant') + ' (' + urgency + ').']);
    const trackToken = await ensureTrackToken(p, id);
    notifyNewJob({ id: id, urgency: urgency, address: r.address, issue: [r.category, r.affected, r.symptom].filter(Boolean).join(' – '),
      location: r.location, photos: parseInt(r.photoCount, 10) || 0 });
    return { id: id, ref: refFor(id), trackPath: trackToken ? '/t/' + trackToken : null };
  }

  // A tenant's private link to follow one repair (/t/<token>).
  async function ensureTrackToken(p, id) {
    const cur = (await p.query('SELECT track_token FROM jobs WHERE id = $1', [id])).rows[0];
    if (!cur) return null;
    if (cur.track_token) return cur.track_token;
    const token = crypto.randomBytes(18).toString('base64url');
    await p.query('UPDATE jobs SET track_token = $2 WHERE id = $1 AND track_token IS NULL', [id, token]);
    return (await p.query('SELECT track_token FROM jobs WHERE id = $1', [id])).rows[0].track_token;
  }

  // Phone alert for a new job. Never delays or breaks saving the report.
  function notifyNewJob(j) {
    if (!NTFY_TOPIC || typeof fetch !== 'function') return;
    const PRIORITY = { Emergency: 5, Urgent: 4, Routine: 3 };
    const TAGS = { Emergency: ['rotating_light'], Urgent: ['warning'], Routine: ['wrench'] };
    const body = {
      topic: NTFY_TOPIC,
      title: j.urgency.toUpperCase() + ' · New repair ' + refFor(j.id),
      message: [String(j.address || 'No address given').replace(/\s+/g, ' ').trim(),
        (j.issue || 'Repair') + (j.location ? ' (' + j.location + ')' : ''),
        j.photos ? j.photos + ' photo' + (j.photos === 1 ? '' : 's') : ''].filter(Boolean).join('\n').slice(0, 1000),
      priority: PRIORITY[j.urgency] || 3,
      tags: TAGS[j.urgency] || ['wrench']
    };
    if (PUBLIC_URL) body.click = PUBLIC_URL + '/admin#job=' + j.id;
    fetch(NTFY_SERVER, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) })
      .then(function (res) { if (!res.ok) console.error('Phone alert failed: HTTP ' + res.status); })
      .catch(function (err) { console.error('Phone alert failed:', err.message); });
  }

  function refFor(id) { return 'RR-' + String(id).padStart(5, '0'); }

  // ---------- Admin sign-in ----------
  // A signed, expiring token in an HttpOnly cookie. Changing ADMIN_PASSWORD
  // signs everyone out, since the signing key is derived from it.
  const SESSION_DAYS = 30;
  const signingKey = crypto.createHash('sha256').update('rr-admin-session:' + ADMIN_PASSWORD).digest();
  function sign(exp) { return crypto.createHmac('sha256', signingKey).update('admin:' + exp).digest('hex'); }
  // A sign-in token: expiry, the sign-in (session) id, signature. Each sign-in is
  // recorded in admin_sessions so staff can see where they're signed in and sign
  // a device out. Older tokens (expiry.signature) are still accepted and are
  // upgraded to a recorded sign-in on their next visit.
  function makeToken(sid, exp) {
    exp = exp || Date.now() + SESSION_DAYS * 86400 * 1000;
    return exp + '.' + sid + '.' + sign(exp + '.' + sid);
  }
  function parseToken(tok) {
    if (!ADMIN_PASSWORD || !tok) return null;
    const parts = String(tok).split('.');
    if (!(Number(parts[0]) > Date.now())) return null;
    let signed, sig, sid = null;
    if (parts.length === 2) { signed = parts[0]; sig = parts[1]; }
    else if (parts.length === 3 && /^[a-f0-9]{16,64}$/.test(parts[1])) { signed = parts[0] + '.' + parts[1]; sig = parts[2]; sid = parts[1]; }
    else return null;
    const a = Buffer.from(sig), b = Buffer.from(sign(signed));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return { exp: Number(parts[0]), sid: sid };
  }
  function validToken(tok) { return !!parseToken(tok); }
  function sessionCookie(req, token, exp) {
    return 'rr_admin=' + token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + Math.max(0, Math.round((exp - Date.now()) / 1000)) + (req.secure ? '; Secure' : '');
  }
  const sessionCache = new Map();   // sid -> { revoked, touched }
  async function startSession(req, sid) {
    const p = await db();
    if (!p) return;
    await p.query('INSERT INTO admin_sessions (id, ip, user_agent) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
      [sid, str(req.ip, 100), str(req.get('user-agent'), 400)]);
    sessionCache.set(sid, { revoked: false, touched: Date.now() });
  }
  // Is this sign-in still allowed? Also notes when it was last used (every few minutes).
  async function sessionOk(req, sid) {
    let c = sessionCache.get(sid);
    const p = await db();
    if (!p) return true;
    if (!c) {
      const row = (await p.query('SELECT revoked_at FROM admin_sessions WHERE id = $1', [sid])).rows[0];
      if (!row) { await startSession(req, sid); return true; }
      c = { revoked: !!row.revoked_at, touched: 0 };
      sessionCache.set(sid, c);
    }
    if (c.revoked) return false;
    if (Date.now() - c.touched > 5 * 60 * 1000) {
      c.touched = Date.now();
      p.query('UPDATE admin_sessions SET last_seen = now(), ip = $2, user_agent = coalesce($3, user_agent) WHERE id = $1',
        [sid, str(req.ip, 100), str(req.get('user-agent'), 400)]).catch(function () {});
    }
    return true;
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
    const sid = crypto.randomBytes(16).toString('hex'), exp = Date.now() + SESSION_DAYS * 86400 * 1000;
    startSession(req, sid).catch(function (err) { console.error('Sign-in record failed:', err.message); });
    res.setHeader('Set-Cookie', sessionCookie(req, makeToken(sid, exp), exp));
    res.json({ ok: true });
  });

  app.post('/api/admin/logout', function (req, res) {
    const t = parseToken(readCookie(req, 'rr_admin'));
    if (t && t.sid) {
      sessionCache.set(t.sid, { revoked: true, touched: Date.now() });
      db().then(function (p) { return p && p.query('UPDATE admin_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [t.sid]); }).catch(function () {});
    }
    res.setHeader('Set-Cookie', 'rr_admin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
    res.json({ ok: true });
  });

  // Everything below needs a valid session. State-changing requests must also be
  // JSON, which a cross-site form can't send — on top of the SameSite cookie.
  app.use('/api/admin', async function (req, res, next) {
    if (!ADMIN_PASSWORD) return res.status(503).json({ ok: false, error: 'admin-not-configured' });
    const t = parseToken(readCookie(req, 'rr_admin'));
    if (!t) return res.status(401).json({ ok: false, error: 'signed-out' });
    try {
      if (t.sid) {
        if (!(await sessionOk(req, t.sid))) {
          res.setHeader('Set-Cookie', 'rr_admin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
          return res.status(401).json({ ok: false, error: 'signed-out' });
        }
        req.sessionId = t.sid;
      } else {
        // A sign-in from before sign-ins were recorded: record it now, same expiry.
        const sid = crypto.randomBytes(16).toString('hex');
        await startSession(req, sid);
        res.setHeader('Set-Cookie', sessionCookie(req, makeToken(sid, t.exp), t.exp));
        req.sessionId = sid;
      }
    } catch (err) { console.error('Sign-in check failed:', err.message); }
    if (req.method !== 'GET' && !req.is('application/json')) return res.status(415).json({ ok: false, error: 'json-only' });
    next();
  });

  // ---------- Where staff are signed in ----------
  app.get('/api/admin/sessions', withDb(async function (p, req, res) {
    const r = await p.query(`SELECT id, created_at, last_seen, ip, user_agent FROM admin_sessions
      WHERE revoked_at IS NULL AND created_at > now() - interval '${SESSION_DAYS} days' ORDER BY last_seen DESC LIMIT 200`);
    res.json({ ok: true, sessions: r.rows.map(function (x) { return { id: x.id, created_at: x.created_at, last_seen: x.last_seen, ip: x.ip, user_agent: x.user_agent, current: x.id === req.sessionId }; }) });
  }));
  app.post('/api/admin/sessions/:sid/revoke', withDb(async function (p, req, res) {
    const sid = String(req.params.sid || '');
    if (sid === req.sessionId) return res.status(400).json({ ok: false, error: 'this-device' });
    await p.query('UPDATE admin_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [sid]);
    sessionCache.set(sid, { revoked: true, touched: Date.now() });
    res.json({ ok: true });
  }));
  app.post('/api/admin/sessions/revoke-others', withDb(async function (p, req, res) {
    const r = await p.query('UPDATE admin_sessions SET revoked_at = now() WHERE revoked_at IS NULL AND id <> $1 RETURNING id', [req.sessionId || '']);
    r.rows.forEach(function (x) { sessionCache.set(x.id, { revoked: true, touched: Date.now() }); });
    res.json({ ok: true, signed_out: r.rows.length });
  }));

  // ---------- Visits to the tenant pages ----------
  // Counted per day (London time): visits, and unique visitors (a daily one-way
  // hash of address + browser, so no one can be identified from it).
  const BOT_UA = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|monitor|pingdom|uptime|curl|wget|python|axios|node-fetch|headless/i;
  const londonDay = function (d) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d || new Date()); };
  const visitHits = new Map();
  async function countVisit(req, page) {
    const ua = String(req.get('user-agent') || '');
    if (!ua || BOT_UA.test(ua)) return;
    const now = Date.now(), e = visitHits.get(req.ip);
    if (!e || now - e.start > 10 * 60 * 1000) visitHits.set(req.ip, { start: now, n: 1 });
    else if (++e.n > 60) return;
    if (visitHits.size > 20000) visitHits.clear();
    const p = await db();
    if (!p) return;
    const day = londonDay(), vhash = crypto.createHmac('sha256', signingKey).update(day + '|' + req.ip + '|' + ua).digest('hex').slice(0, 32);
    const fresh = (await p.query('INSERT INTO site_visitors (day, page, vhash) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [day, page, vhash])).rowCount;
    await p.query(`INSERT INTO site_visits (day, page, visits, uniques) VALUES ($1, $2, 1, $3)
      ON CONFLICT (day, page) DO UPDATE SET visits = site_visits.visits + 1, uniques = site_visits.uniques + excluded.uniques`, [day, page, fresh]);
  }
  // The tenant repair page reports its own visit (so only real browsers count).
  app.post('/api/visit', function (req, res) {
    const page = req.query.p === 'track' ? 'track' : 'report';
    countVisit(req, page).catch(function () {});
    res.status(204).end();
  });
  // Visit activity from /rrt.js: one row per visit (a random id per browser
  // tab), with device, where they came from, steps reached and what they did.
  function uaInfo(ua) {
    const device = /iPad|Tablet|PlayBook|Silk|(Android(?!.*Mobile))/i.test(ua) ? 'Tablet' : /Mobi|iPhone|iPod|Android|Windows Phone/i.test(ua) ? 'Mobile' : 'Computer';
    const browser = /FBAN|FBAV|Instagram/i.test(ua) ? 'Facebook / Instagram app' : /EdgA?\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
      : /OPR\/|Opera/.test(ua) ? 'Opera' : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Other';
    const os = /iPhone|iPad|iPod/.test(ua) ? 'iPhone / iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'Chromebook'
      : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Other';
    return { device: device, browser: browser, os: os };
  }
  function visitSource(ref, utm, ownHost) {
    const u = String(utm || '').toLowerCase();
    if (u) return { source: /whatsapp|wa\b/.test(u) ? 'WhatsApp' : /mail/.test(u) ? 'Email' : /sms|text/.test(u) ? 'Text message' : /qr/.test(u) ? 'QR code' : /facebook|fb|insta/.test(u) ? 'Facebook / Instagram' : u.slice(0, 40), host: '' };
    let host = '';
    try { host = new URL(ref).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) {}
    if (!host) return { source: 'Direct or a link in a message', host: '' };
    const src = host === ownHost ? 'Fixflow (another page)' : /google\./.test(host) ? 'Google' : /bing\.|duckduckgo|yahoo\.|ecosia/.test(host) ? 'Other search engine'
      : /facebook|fb\.|instagram/.test(host) ? 'Facebook / Instagram' : /whatsapp|wa\.me/.test(host) ? 'WhatsApp' : /mail\.|outlook\.|live\.com/.test(host) ? 'Email'
      : /residentialrealtors/.test(host) ? 'Our website' : /rightmove|zoopla|onthemarket/.test(host) ? 'Property portal' : 'Another website';
    return { source: src, host: host };
  }
  const visitEvents = new Map();
  const VISIT_EVENTS = ['view', 'step', 'cat', 'lang', 'submit', 'hide', 'ping'];
  app.post('/api/visit/e', express.text({ type: function () { return true; }, limit: '8kb' }), function (req, res) {
    res.status(204).end();
    (async function () {
      const ua = String(req.get('user-agent') || '');
      if (!ua || BOT_UA.test(ua)) return;
      const now = Date.now(), e = visitEvents.get(req.ip);
      if (!e || now - e.start > 10 * 60 * 1000) visitEvents.set(req.ip, { start: now, n: 1 });
      else if (++e.n > 400) return;
      if (visitEvents.size > 20000) visitEvents.clear();
      let b; try { b = JSON.parse(typeof req.body === 'string' ? req.body : '{}'); } catch (err) { return; }
      const sid = String(b.sid || ''), ev = String(b.ev || ''), page = ['report', 'track', 'portal'].indexOf(b.page) !== -1 ? b.page : null;
      if (!/^[a-z0-9]{8,40}$/i.test(sid) || VISIT_EVENTS.indexOf(ev) === -1 || !page) return;
      const v = b.v == null ? null : String(b.v).slice(0, 120);
      const p = await db(); if (!p) return;
      await p.query('INSERT INTO site_sessions (sid, landing) VALUES ($1, $2) ON CONFLICT (sid) DO NOTHING', [sid, page]);
      if (ev === 'view') {
        const u = uaInfo(ua), src = visitSource(b.ref, b.utm, String(req.get('host') || '').replace(/^www\./, '').split(':')[0]);
        let subject = null, jobIdV = null;
        const path = String(b.path || '');
        const tm = /^\/t\/([A-Za-z0-9_-]{10,})/.exec(path), cm = /^\/c\/([A-Za-z0-9_-]{20,})/.exec(path);
        if (tm) { const j = (await p.query('SELECT id FROM jobs WHERE track_token = $1', [tm[1]])).rows[0]; if (j) { jobIdV = j.id; subject = 'Tracker for ' + refFor(j.id); } }
        else if (cm) { const c = (await p.query('SELECT name FROM contractors WHERE portal_token = $1', [cm[1]])).rows[0]; if (c) subject = c.name + '’s job link'; }
        else if (page === 'track') subject = 'Repair look-up page';
        // The first view sets where they came from; later pages add to the list.
        await p.query(`UPDATE site_sessions SET last_at = now(), views = views + 1, events = events + 1,
            pages = CASE WHEN $2 = ANY(pages) THEN pages ELSE array_append(pages, $2) END,
            device = coalesce(device, $3), browser = coalesce(browser, $4), os = coalesce(os, $5),
            source = coalesce(source, $6), ref_host = coalesce(ref_host, nullif($7, '')), screen = coalesce(screen, $8),
            lang = coalesce(lang, nullif($9, '')), tz = coalesce(tz, nullif($10, '')),
            subject = coalesce($11, subject), job_id = coalesce(job_id, $12)
          WHERE sid = $1`, [sid, page, u.device, u.browser, u.os, src.source, src.host, (parseInt(b.w, 10) || 0) + '×' + (parseInt(b.h, 10) || 0),
          String(b.lang || '').slice(0, 20), String(b.tz || '').slice(0, 60), subject, jobIdV]);
        if (page === 'report') countVisit(req, 'report').catch(function () {});
        return;
      }
      const sets = ['last_at = now()', 'events = events + 1'], args = [sid];
      if (ev === 'step' && v) { args.push(v); sets.push('steps = CASE WHEN steps[array_length(steps, 1)] = $2 THEN steps ELSE array_append(steps, $2) END'); }
      if (ev === 'cat' && v) { args.push(v); sets.push('categories = CASE WHEN $2 = ANY(categories) THEN categories ELSE array_append(categories, $2) END'); }
      if (ev === 'lang' && v) { args.push(v); sets.push('chosen_lang = $2'); }
      if (ev === 'submit' && v) {
        const m = /^RR-0*(\d+)$/.exec(v);
        args.push(v); sets.push('submitted_ref = $2');
        if (m) { args.push(Number(m[1])); sets.push('job_id = $3'); }
      }
      await p.query('UPDATE site_sessions SET ' + sets.join(', ') + ' WHERE sid = $1', args);
    })().catch(function () {});
  });
  // ---------- Notices to tenants (a property, a building, or everyone) ----------
  // The message is written once; each tenant gets their own copy by email (sent
  // here, one email each) or WhatsApp (opened one at a time on the admin page).
  // Every notice is kept with who it went to and how.
  app.post('/api/admin/tenant-notices', withDb(async function (p, req, res) {
    const b = req.body || {}, body = str(b.body, 10000);
    if (!body) return res.status(400).json({ ok: false, error: 'empty' });
    const recips = (Array.isArray(b.recipients) ? b.recipients : []).slice(0, 1000).map(function (r) {
      return { key: str(r && r.key, 80) || '', name: str(r && r.name, 120) || '', phone: str(r && r.phone, 40) || '', email: str(r && r.email, 200) || '', address: str(r && r.address, 300) || '' };
    });
    const keys = (Array.isArray(b.property_keys) ? b.property_keys : []).slice(0, 1000).map(function (k) { return str(k, 300); }).filter(Boolean);
    const r = await p.query('INSERT INTO tenant_notices (subject, body, audience, property_keys, recipients) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [str(b.subject, 300), body, str(b.audience, 300), keys, JSON.stringify(recips)]);
    res.json({ ok: true, id: r.rows[0].id });
  }));
  // Record how one tenant was sent the notice (WhatsApp / copied / email app).
  app.post('/api/admin/tenant-notices/:id/sent', withDb(async function (p, req, res) {
    const b = req.body || {}, k = str(b.key, 80), how = str(b.how, 40);
    if (!k || !how) return res.status(400).json({ ok: false });
    await p.query("UPDATE tenant_notices SET sent = sent || jsonb_build_object($2::text, $3::text) WHERE id = $1", [parseInt(req.params.id, 10) || 0, k, how]);
    res.json({ ok: true });
  }));
  // Email each tenant their own copy.
  app.post('/api/admin/tenant-notices/:id/email', withDb(async function (p, req, res) {
    if (!canEmail()) return res.status(503).json({ ok: false, error: 'email-not-configured' });
    const id = parseInt(req.params.id, 10) || 0, b = req.body || {};
    const n = (await p.query('SELECT id FROM tenant_notices WHERE id = $1', [id])).rows[0];
    if (!n) return res.status(404).json({ ok: false, error: 'not-found' });
    const subject = str(b.subject, 300) || 'A message from Residential Realtors';
    const list = (Array.isArray(b.messages) ? b.messages : []).slice(0, 300);
    const done = {}, failed = [];
    for (const m of list) {
      const to = str(m && m.to, 200), text = str(m && m.text, 10000), k = str(m && m.key, 80);
      if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) || !text) { if (k) failed.push(k); continue; }
      const sent = await sendEmail({ to: [to], subject: str(m && m.subject, 300) || subject, text: text }).catch(function () { return { ok: false }; });
      if (sent && sent.ok) { if (k) done[k] = 'email'; } else if (k) failed.push(k);
    }
    if (Object.keys(done).length) await p.query('UPDATE tenant_notices SET sent = sent || $2::jsonb WHERE id = $1', [id, JSON.stringify(done)]);
    res.json({ ok: true, sent: Object.keys(done), failed: failed });
  }));
  app.get('/api/admin/tenant-notices', withDb(async function (p, req, res) {
    const k = str(req.query.property_key, 300);
    const r = k
      ? await p.query('SELECT id, created_at, subject, body, audience, property_keys, recipients, sent FROM tenant_notices WHERE $1 = ANY(property_keys) ORDER BY id DESC LIMIT 20', [k])
      : await p.query('SELECT id, created_at, subject, body, audience, property_keys, recipients, sent FROM tenant_notices ORDER BY id DESC LIMIT 50');
    res.json({ ok: true, notices: r.rows });
  }));

  // For the Activity page: every visit in the period, summed up, plus the latest visits.
  app.get('/api/admin/site-sessions', withDb(async function (p, req, res) {
    const days = String(Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30)));
    const rows = (await p.query(`SELECT sid, started_at, last_at, landing, pages, device, browser, os, source, ref_host, screen, lang, tz, chosen_lang, steps, categories,
        subject, job_id, submitted_ref, views, events, extract(epoch FROM last_at - started_at)::int AS secs,
        extract(hour FROM started_at AT TIME ZONE 'Europe/London')::int AS hour, extract(isodow FROM started_at AT TIME ZONE 'Europe/London')::int AS dow
      FROM site_sessions WHERE started_at > now() - ($1 || ' days')::interval ORDER BY started_at DESC LIMIT 20000`, [days])).rows;
    const live = (await p.query("SELECT count(*)::int AS n FROM site_sessions WHERE last_at > now() - interval '5 minutes'")).rows[0].n;
    const since = (await p.query('SELECT min(started_at) AS t FROM site_sessions')).rows[0].t;
    res.json({ ok: true, days: Number(days), live: live, since: since, sessions: rows });
  }));
  app.get('/api/admin/visits', withDb(async function (p, req, res) {
    const days = Math.min(365, Math.max(7, parseInt(req.query.days, 10) || 30));
    const from = londonDay(new Date(Date.now() - (days - 1) * 86400000));
    const v = (await p.query('SELECT day, page, visits, uniques FROM site_visits WHERE day >= $1 ORDER BY day', [from])).rows;
    const reports = (await p.query(`SELECT to_char(created_at AT TIME ZONE 'Europe/London', 'YYYY-MM-DD') AS day, count(*)::int AS n
      FROM jobs WHERE source = 'Online report' AND created_at > now() - ($1 || ' days')::interval GROUP BY 1 ORDER BY 1`, [String(days)])).rows;
    res.json({ ok: true, from: from, today: londonDay(), visits: v, reports: reports });
  }));
  // Everything for the Activity page over a period: jobs in and done, time to
  // complete, messages sent, where jobs came from, contractors, and a feed of
  // the latest updates across all jobs.
  app.get('/api/admin/activity', withDb(async function (p, req, res) {
    const days = String(Math.min(365, Math.max(7, parseInt(req.query.days, 10) || 30)));
    const since = "now() - ($1 || ' days')::interval";
    const q = function (sql) { return p.query(sql, [days]).then(function (r) { return r.rows; }); };
    const out = await Promise.all([
      q(`SELECT to_char(created_at AT TIME ZONE 'Europe/London', 'YYYY-MM-DD') AS day, count(*)::int AS n FROM jobs WHERE created_at > ${since} GROUP BY 1`),
      q(`SELECT to_char(completed_at AT TIME ZONE 'Europe/London', 'YYYY-MM-DD') AS day, count(*)::int AS n FROM jobs WHERE status = 'Completed' AND completed_at > ${since} GROUP BY 1`),
      q(`SELECT count(*)::int AS n, round(avg(extract(epoch FROM completed_at - created_at)) / 3600)::int AS avg_hours,
           round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM completed_at - created_at)) / 3600)::numeric)::int AS median_hours,
           count(*) FILTER (WHERE due_at IS NOT NULL AND completed_at <= due_at)::int AS on_time, count(*) FILTER (WHERE due_at IS NOT NULL)::int AS with_due
         FROM jobs WHERE status = 'Completed' AND completed_at > ${since} AND completed_at >= created_at`),
      q(`SELECT coalesce(nullif(source, ''), 'Other') AS k, count(*)::int AS n FROM jobs WHERE created_at > ${since} GROUP BY 1 ORDER BY 2 DESC`),
      q(`SELECT coalesce(nullif(category, ''), 'Other') AS k, count(*)::int AS n FROM jobs WHERE created_at > ${since} GROUP BY 1 ORDER BY 2 DESC LIMIT 8`),
      q(`SELECT coalesce(nullif(urgency, ''), 'Routine') AS k, count(*)::int AS n FROM jobs WHERE created_at > ${since} GROUP BY 1`),
      q(`SELECT kind AS k, count(*)::int AS n FROM job_updates WHERE created_at > ${since} GROUP BY 1`),
      q(`SELECT trim(assigned_to) AS name, count(*) FILTER (WHERE created_at > ${since})::int AS given,
           count(*) FILTER (WHERE status = 'Completed' AND completed_at > ${since})::int AS done,
           round(avg(extract(epoch FROM completed_at - created_at) / 3600) FILTER (WHERE status = 'Completed' AND completed_at > ${since} AND completed_at >= created_at))::int AS avg_hours
         FROM jobs WHERE assigned_to IS NOT NULL AND trim(assigned_to) <> '' AND archived_at IS NULL GROUP BY 1
         HAVING count(*) FILTER (WHERE created_at > ${since} OR (status = 'Completed' AND completed_at > ${since})) > 0 ORDER BY 3 DESC, 2 DESC LIMIT 12`),
      p.query("SELECT name, portal_seen_at FROM contractors WHERE portal_on AND active ORDER BY portal_seen_at DESC NULLS LAST").then(function (r) { return r.rows; }),
      q(`SELECT count(*)::int AS n FROM admin_sessions WHERE created_at > ${since}`),
      p.query(`SELECT u.id, u.job_id, u.created_at, u.kind, left(u.body, 400) AS body, j.property_address, j.archived_at
         FROM job_updates u JOIN jobs j ON j.id = u.job_id ORDER BY u.created_at DESC, u.id DESC LIMIT 150`).then(function (r) { return r.rows; }),
      p.query(`SELECT count(*) FILTER (WHERE status NOT IN ('Completed', 'Cancelled'))::int AS open,
           count(*) FILTER (WHERE status NOT IN ('Completed', 'Cancelled') AND due_at < now())::int AS overdue,
           count(*) FILTER (WHERE status NOT IN ('Completed', 'Cancelled') AND (assigned_to IS NULL OR trim(assigned_to) = ''))::int AS unassigned
         FROM jobs WHERE archived_at IS NULL`).then(function (r) { return r.rows[0]; })
    ]);
    res.json({ ok: true, days: Number(days), today: londonDay(), created: out[0], completed: out[1], speed: out[2][0], sources: out[3], categories: out[4],
      urgency: out[5], messages: out[6], contractors: out[7], portals: out[8], signins: out[9][0].n,
      feed: out[10].map(function (u) { u.ref = refFor(u.job_id); return u; }), now: out[11] });
  }));
  setInterval(function () {
    db().then(function (p) { return p && p.query("DELETE FROM site_visitors WHERE day < to_char(now() - interval '60 days', 'YYYY-MM-DD')"); }).catch(function () {});
    db().then(function (p) { return p && p.query("DELETE FROM site_sessions WHERE started_at < now() - interval '400 days'"); }).catch(function () {});
  }, 24 * 3600 * 1000).unref();

  app.get('/api/admin/me', async function (req, res) {
    res.json({ ok: true, db: !!(await db()), canEmail: canEmail(), canAi: !!(opts.canAi && opts.canAi()), invoice: INVOICE, statuses: STATUSES, urgencies: URGENCIES, dueHours: DUE_HOURS, sources: SOURCES, deployedAt: DEPLOYED_AT });
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
    const inv = await p.query('SELECT id, created_at, number, total, landlord_name, landlord_email, data, paid_at FROM invoices WHERE job_id = $1 ORDER BY id DESC', [id]);
    const parts = await p.query('SELECT id, created_at, description, supplier, cost, charge, status FROM job_parts WHERE job_id = $1 ORDER BY id', [id]);
    res.json({ ok: true, job: job, updates: u.rows, photos: ph.rows, invoices: inv.rows, parts: parts.rows });
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
    // The landlord does the work themselves ('self') or with their own contractor ('contractor').
    landlord_handles: { clean: function (v) { return v === 'self' || v === 'contractor' ? v : (v ? undefined : null); }, label: 'Done by',
      show: function (v) { return v === 'self' ? 'the landlord' : v === 'contractor' ? 'the landlord’s own contractor' : 'our contractor'; } },
    landlord_contractor: { clean: function (v) { return str(v, 300); }, label: 'Landlord’s contractor' },
    next_steps: { clean: function (v) { return str(v, 2000); }, label: 'Next steps', quiet: true },
    // Report details, correctable from "Edit details" (mainly for jobs typed in by hand).
    tenant_name: { clean: function (v) { return str(v, 200); }, label: 'Tenant' },
    tenant_email: { clean: function (v) { return str(v, 200); }, label: 'Tenant email' },
    tenant_phone: { clean: function (v) { return str(v, 50); }, label: 'Tenant phone' },
    property_address: { clean: function (v) { const a = tidyAddress(v); return addressProblem(a) ? undefined : a; }, label: 'Property' },
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
    direct_contact: { clean: function (v) { return v === 'Yes' || v === 'No' ? v : (v ? undefined : null); }, label: 'We arrange access (not the contractor)', show: function (v) { return v === 'No' ? 'yes' : 'no'; } },
    appointment_date: { clean: function (v) { if (!v) return null; return apptDay(v) ? String(v) : undefined; }, label: 'Appointment', show: function (v) { return apptDay(v) || 'none'; } },
    appointment_time: { clean: function (v) { return str(v, 60); }, label: 'Appointment time' },
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
    // The one-line contractor summary is rewritten next time if the job's wording changed.
    if (['category', 'affected', 'symptom', 'location', 'description'].some(function (f) { return sets.some(function (s) { return s.indexOf(f + ' =') === 0; }); })) sets.push('summary = NULL');
    vals.push(id);
    await p.query('UPDATE jobs SET ' + sets.join(', ') + ', updated_at = now() WHERE id = $' + vals.length, vals);
    for (const n of notes) {
      await p.query('INSERT INTO job_updates (job_id, kind, body) VALUES ($1, $2, $3)', [id, 'change', n]);
    }
    if (['tenant_name', 'tenant_phone', 'tenant_email', 'property_address'].some(function (f) { return f in body; })) {
      const tn = (await p.query('SELECT property_address, tenant_name, tenant_phone, tenant_email FROM jobs WHERE id = $1', [id])).rows[0];
      await ensureTenant(p, tn, tn.property_address);
    }
    // Landlord details entered on a job are saved to the landlord list and the property linked to them.
    if (['landlord_name', 'landlord_email', 'landlord_phone', 'landlord_address'].some(function (f) { return f in body; })) {
      const now = (await p.query('SELECT property_address, landlord_name, landlord_email, landlord_phone, landlord_address FROM jobs WHERE id = $1', [id])).rows[0];
      await ensureLandlord(p, Object.assign({}, now, { landlord_id: body.landlord_id }), now.property_address);
    }
    res.json({ ok: true, changed: true });
  }));

  // ---------- Landlords ----------
  app.get('/api/admin/landlords', withDb(async function (p, req, res) {
    const l = await p.query('SELECT id, name, email, phone, address, notes, created_at, updated_at FROM landlords ORDER BY lower(name)');
    const links = await p.query('SELECT property_key, address, landlord_id FROM property_landlords ORDER BY address');
    res.json({ ok: true, landlords: l.rows, links: links.rows });
  }));

  function cleanLandlord(b) {
    const out = {};
    if ('name' in b) { out.name = str(b.name, 200); if (!out.name) return null; }
    if ('email' in b) out.email = str(b.email, 200);
    if ('phone' in b) out.phone = str(b.phone, 50);
    if ('address' in b) out.address = str(b.address, 500);
    if ('notes' in b) out.notes = str(b.notes, 2000);
    return out;
  }

  // Add a landlord (an existing one with the same name is updated instead),
  // optionally with the first property.
  app.post('/api/admin/landlords', withDb(async function (p, req, res) {
    const b = req.body || {};
    const c = cleanLandlord(b);
    if (!c || !c.name) return res.status(400).json({ ok: false, error: 'name-required' });
    const addrs = (Array.isArray(b.property_addresses) ? b.property_addresses : [b.property_address]).map(function (x) { return str(x, 500); }).filter(Boolean).slice(0, 30);
    const id = await ensureLandlord(p, c, addrs[0] || null);
    for (const a of addrs.slice(1)) await ensureLandlord(p, Object.assign({}, c, { landlord_id: id }), a);
    if (c.notes !== undefined) await p.query('UPDATE landlords SET notes = $2 WHERE id = $1', [id, c.notes]);
    res.json({ ok: true, id: id, properties: addrs.length });
  }));

  app.patch('/api/admin/landlords/:id', withDb(async function (p, req, res) {
    const c = cleanLandlord(req.body || {});
    if (!c) return res.status(400).json({ ok: false, error: 'name-required' });
    const keys = Object.keys(c);
    if (!keys.length) return res.json({ ok: true });
    const vals = keys.map(function (k) { return c[k]; });
    vals.push(jobId(req));
    const r = await p.query('UPDATE landlords SET ' + keys.map(function (k, i) { return k + ' = $' + (i + 1); }).join(', ') +
      ', updated_at = now() WHERE id = $' + vals.length + ' RETURNING id', vals);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'not-found' });
    res.json({ ok: true });
  }));

  // Set (or clear, with landlord_id null) whose property an address is.
  app.put('/api/admin/property-landlord', withDb(async function (p, req, res) {
    const b = req.body || {};
    const key = propKey(b.address);
    if (!key) return res.status(400).json({ ok: false, error: 'address-required' });
    const lid = parseInt(b.landlord_id, 10) || null;
    if (!lid) { await p.query('DELETE FROM property_landlords WHERE property_key = $1', [key]); return res.json({ ok: true }); }
    const ok = await p.query('SELECT id FROM landlords WHERE id = $1', [lid]);
    if (!ok.rows.length) return res.status(404).json({ ok: false, error: 'landlord-not-found' });
    await p.query(`INSERT INTO property_landlords (property_key, address, landlord_id) VALUES ($1, $2, $3)
      ON CONFLICT (property_key) DO UPDATE SET landlord_id = excluded.landlord_id, address = excluded.address, updated_at = now()`, [key, str(b.address, 500), lid]);
    res.json({ ok: true });
  }));

  // ---------- Tenant records ----------
  app.get('/api/admin/tenant-records', withDb(async function (p, req, res) {
    const t = await p.query('SELECT id, name, phone, email, notes, created_at, updated_at FROM tenants WHERE deleted_at IS NULL ORDER BY lower(name)');
    const links = await p.query('SELECT pt.tenant_id, pt.property_key, pt.address, pt.moved_out_at, pt.created_at FROM property_tenants pt JOIN tenants t ON t.id = pt.tenant_id WHERE t.deleted_at IS NULL ORDER BY pt.created_at');
    res.json({ ok: true, tenants: t.rows, links: links.rows });
  }));

  app.post('/api/admin/tenant-records', withDb(async function (p, req, res) {
    const b = req.body || {};
    if (!str(b.name) && !str(b.phone) && !str(b.email)) return res.status(400).json({ ok: false, error: 'details-required' });
    const id = await ensureTenant(p, { name: b.name, phone: b.phone, email: b.email }, b.property_address, true);
    if ('notes' in b) await p.query('UPDATE tenants SET notes = $2 WHERE id = $1', [id, str(b.notes, 2000)]);
    res.json({ ok: true, id: id });
  }));

  // Edit a tenant. Their open jobs get the new contact details too, so
  // contractors are sent the right number.
  app.patch('/api/admin/tenant-records/:id', withDb(async function (p, req, res) {
    const b = req.body || {};
    const id = jobId(req);
    const cur = (await p.query('SELECT id, name, phone, email FROM tenants WHERE id = $1', [id])).rows[0];
    if (!cur) return res.status(404).json({ ok: false, error: 'not-found' });
    const next = {
      name: 'name' in b ? (str(b.name, 200) || cur.name) : cur.name,
      phone: 'phone' in b ? str(b.phone, 50) : cur.phone,
      email: 'email' in b ? str(b.email, 200) : cur.email
    };
    await p.query('UPDATE tenants SET name = $2, phone = $3, email = $4' + ('notes' in b ? ', notes = $5' : '') + ', updated_at = now() WHERE id = $1',
      'notes' in b ? [id, next.name, next.phone, next.email, str(b.notes, 2000)] : [id, next.name, next.phone, next.email]);
    const keys = (await p.query('SELECT property_key FROM property_tenants WHERE tenant_id = $1', [id])).rows.map(function (r) { return r.property_key; });
    const open = await p.query(`SELECT id, tenant_name, tenant_phone, tenant_email, property_address FROM jobs
      WHERE archived_at IS NULL AND status NOT IN ('Completed', 'Cancelled')`);
    const oldTail = phoneTail(cur.phone);
    let updated = 0;
    for (const j of open.rows) {
      const samePhone = oldTail && phoneTail(j.tenant_phone) === oldTail;
      const sameNameHere = cur.name && String(j.tenant_name || '').toLowerCase() === String(cur.name).toLowerCase() && keys.indexOf(propKey(j.property_address)) !== -1;
      if (!samePhone && !sameNameHere) continue;
      if (j.tenant_name === next.name && j.tenant_phone === next.phone && j.tenant_email === next.email) continue;
      await p.query('UPDATE jobs SET tenant_name = $2, tenant_phone = $3, tenant_email = $4, updated_at = now() WHERE id = $1', [j.id, next.name, next.phone, next.email]);
      await p.query('INSERT INTO job_updates (job_id, kind, body) VALUES ($1, $2, $3)', [j.id, 'change', 'Tenant details updated from the Tenants page.']);
      updated += 1;
    }
    res.json({ ok: true, jobs_updated: updated });
  }));

  // Delete a tenant from the Tenants page. Their jobs (and the tenant details
  // recorded on them) are kept; the tenant record and property links go.
  app.delete('/api/admin/tenant-records/:id', withDb(async function (p, req, res) {
    const id = jobId(req);
    const links = (await p.query('SELECT property_key FROM property_tenants WHERE tenant_id = $1 ORDER BY created_at DESC', [id])).rows;
    const r = await p.query('UPDATE tenants SET deleted_at = now(), deleted_key = $2 WHERE id = $1 AND deleted_at IS NULL RETURNING id', [id, links.length ? links[0].property_key : null]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'not-found' });
    await p.query('DELETE FROM property_tenants WHERE tenant_id = $1', [id]);
    res.json({ ok: true });
  }));

  // Link a tenant to a property, mark them moved out / back in, or remove the link.
  app.put('/api/admin/tenant-records/:id/property', withDb(async function (p, req, res) {
    const b = req.body || {};
    const id = jobId(req);
    const key = propKey(b.address);
    if (!key) return res.status(400).json({ ok: false, error: 'address-required' });
    if (!(await p.query('SELECT id FROM tenants WHERE id = $1', [id])).rows.length) return res.status(404).json({ ok: false, error: 'not-found' });
    if (b.remove) { await p.query('DELETE FROM property_tenants WHERE tenant_id = $1 AND property_key = $2', [id, key]); return res.json({ ok: true }); }
    await p.query(`INSERT INTO property_tenants (tenant_id, property_key, address, moved_out_at) VALUES ($1, $2, $3, $4)
      ON CONFLICT (tenant_id, property_key) DO UPDATE SET moved_out_at = excluded.moved_out_at, address = coalesce(excluded.address, property_tenants.address)`,
      [id, key, str(b.address, 500), b.moved_out ? new Date() : null]);
    res.json({ ok: true });
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
    Landlord: 'the landlord who owns the property. Unless the staff instructions ask for something different, structure it in plain text with short numbered headings: ' +
      '1. The issue: what the tenant reported, where in the property, when, how urgent, and anything already done. ' +
      '2. Possible solutions: one to three realistic options a UK contractor would typically consider for this kind of problem, each explained in a sentence or two in plain English, with the one we recommend marked, and a note that the exact fix will be confirmed once a contractor has inspected. ' +
      '3. Cost estimates: an estimate for each option (see the cost rules below). ' +
      'Then ask the landlord to approve the recommended option (or tell us which they prefer) so the work can go ahead, briefly mentioning any urgency, safety or legal repairing obligation where it genuinely applies. Professional, clear and concise.',
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
    let facts = (recipient === 'Contractor' ? '' : fact('Job reference', refFor(j.id))) + fact('Property', j.property_address) +
      fact('Issue', [j.category, j.affected, j.symptom].filter(Boolean).join(' – ')) + fact('Location in property', j.location) +
      fact('Description', j.description) + fact('Urgency', j.urgency) + fact('Status', j.status) +
      fact('Reported', when(j.created_at)) + fact('Deadline', when(j.due_at)) + fact('Completed', when(j.completed_at)) +
      fact('Completion notes', j.completion_notes) + fact('Assigned contractor', j.assigned_to) + fact('Next steps', j.next_steps) +
      fact('Appointment booked for', j.status !== 'Completed' ? apptText(j) : '');
    if (recipient === 'Tenant' || recipient === 'Contractor' || recipient === 'Landlord') facts += fact('Tenant name', j.tenant_name);
    if (recipient === 'Contractor') {
      facts += fact('Tenant phone', j.tenant_phone) + fact('Access days', j.access_days) + fact('Best time', j.access_time) +
        fact('Access notes', j.access_notes) + fact('Keys can be released to contractor', j.key_permission) + fact('Contractor notes', j.key_instructions) +
        (j.direct_contact !== 'No' ? fact('Arranging access', 'The contractor will contact the tenant directly to arrange a time') : fact('Arranging access', 'We (the agency) will arrange access with the tenant'));
    }
    const partRows = (await p.query('SELECT description, supplier, charge, status FROM job_parts WHERE job_id = $1 ORDER BY id', [j.id])).rows;
    if (partRows.length && recipient === 'Landlord') facts += fact('Parts (charged to the landlord)', partRows.map(function (x) { return x.description + (x.charge != null ? ' £' + Number(x.charge).toFixed(2) : '') + ' (' + x.status.toLowerCase() + ')'; }).join('; '));
    else if (partRows.length && recipient !== 'Council') facts += fact('Parts', partRows.map(function (x) { return x.description + ' (' + x.status.toLowerCase() + ')'; }).join('; '));
    if (recipient === 'Landlord') {
      facts += fact('Cost to landlord (our estimate for the recommended work)', j.landlord_charge != null ? '£' + Number(j.landlord_charge).toFixed(2) : null) +
        fact('Photos provided by the tenant', j.photo_count || null);
    }
    // Cost changes in the history are internal (what we pay, our charge) and never go into a draft.
    const COST_CHANGE = /(Estimated cost|Actual cost|Charge to landlord)\s*:/i;
    const history = u.rows.reverse().filter(function (x) { return !(x.kind === 'change' && COST_CHANGE.test(x.body)); }).map(function (x) { return '- ' + when(x.created_at) + ': ' + String(x.body).replace(/\s+/g, ' ').slice(0, 300); }).join('\n');

    const prompt = 'You write emails for Residential Realtors, a UK letting and property management agency, about property repairs.\n\n' +
      'Write an email to ' + RECIPIENTS[recipient] + (toName ? ' Address it to: ' + toName + '.' : '') + '\n\n' +
      'Job details:\n' + facts + (history ? '\nRecent history:\n' + history + '\n' : '') +
      (instructions ? '\nWhat this email needs to do (from the staff member): ' + instructions + '\n' : '') +
      '\nRules: use UK English. Only use the facts above — never invent names, dates, ' + (recipient === 'Landlord' ? '' : 'costs, ') + 'reference numbers or events; where something is needed but unknown, put a placeholder in square brackets such as [DATE]. ' +
      (recipient === 'Landlord'
        ? 'Cost rules: if a "Cost to landlord" is given above, present it as our estimate for the recommended option. If the staff instructions give prices, use those exactly. ' +
          'For any option without a given price, give an approximate typical UK price range (for example "typically £120–£200 including labour"), clearly labelled as an estimate that will be confirmed by a contractor\'s quote. ' +
          'Never mention what we pay contractors, internal costs, profit or margins. '
        : 'Do not mention internal costs, profit or margins. ') +
      (recipient === 'Contractor' ? 'Do not include any job reference number — identify the job by its address and issue. ' : 'Include the job reference. ') +
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
    // Optional PDF attachment (e.g. a landlord report made in the browser).
    const att = typeof b.attachment_base64 === 'string' && b.attachment_base64.length < 30 * 1024 * 1024 ? b.attachment_base64.replace(/^data:[^,]*,/, '') : null;
    const attName = (str(b.attachment_name, 150) || 'Report.pdf').replace(/[^a-zA-Z0-9.\-_]+/g, '-');
    const sent = await sendEmail({ to: [to], subject: subject, text: text, attachmentBase64: att || undefined, attachmentFilename: att ? attName : undefined });
    if (!sent.ok) return res.status(502).json({ ok: false, error: 'send-failed' });
    await p.query('INSERT INTO job_updates (job_id, kind, body) VALUES ($1, $2, $3)',
      [id, 'email', 'Emailed ' + to + (att ? ' (with ' + attName + ')' : '') + ' — ' + subject + '\n\n' + text]);
    await p.query('UPDATE jobs SET updated_at = now() WHERE id = $1', [id]);
    res.json({ ok: true });
  }));

  // ---------- Landlord invoices ----------
  function cleanInvoiceData(d, number, total) {
    return {
      number: number, date: str(d.date, 20), due: str(d.due, 20), ref: str(d.ref, 100),
      landlord: str(d.landlord, 200), landlordAddress: str(d.landlordAddress, 500), landlordEmail: str(d.landlordEmail, 200), landlordPhone: str(d.landlordPhone, 50),
      lines: (Array.isArray(d.lines) ? d.lines : []).slice(0, 50).map(function (l) { return { desc: str(l && l.desc, 1000) || '', amount: money(l && l.amount) }; }),
      sub: money(d.sub), vat: money(d.vat) || 0, total: total
    };
  }

  // Every invoice (for what landlords owe), newest first, with its job's address.
  app.get('/api/admin/invoices', withDb(async function (p, req, res) {
    const r = await p.query(`SELECT i.id, i.job_id, i.created_at, i.number, i.total, i.landlord_name, i.landlord_email, i.paid_at,
        i.data->>'due' AS due, i.data->>'landlordPhone' AS landlord_phone, j.property_address, j.archived_at
      FROM invoices i JOIN jobs j ON j.id = i.job_id ORDER BY i.id DESC LIMIT 5000`);
    res.json({ ok: true, invoices: r.rows.map(function (x) { x.ref = refFor(x.job_id); return x; }) });
  }));

  // Mark an invoice as paid by the landlord (or not paid).
  app.post('/api/admin/invoices/:id/paid', withDb(async function (p, req, res) {
    const paid = (req.body || {}).paid !== false;
    const r = await p.query('UPDATE invoices SET paid_at = ' + (paid ? 'coalesce(paid_at, now())' : 'NULL') + ' WHERE id = $1 RETURNING job_id, number, total, landlord_name', [jobId(req)]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'not-found' });
    const x = r.rows[0];
    await p.query('INSERT INTO job_updates (job_id, kind, body) VALUES ($1, $2, $3)', [x.job_id, 'change',
      paid ? 'Invoice ' + x.number + ' paid' + (x.landlord_name ? ' by ' + x.landlord_name : '') + ' (' + gbp(x.total) + ').' : 'Invoice ' + x.number + ' marked as not paid.']);
    res.json({ ok: true });
  }));

  // Delete an invoice (e.g. raised by mistake). The job's "invoiced" details fall
  // back to its latest remaining invoice, or are cleared; noted in the history.
  async function refreshJobInvoice(p, jid) {
    const last = (await p.query('SELECT number, total, created_at FROM invoices WHERE job_id = $1 ORDER BY id DESC LIMIT 1', [jid])).rows[0];
    await p.query('UPDATE jobs SET invoice_number = $2, invoice_total = $3, invoiced_at = $4, updated_at = now() WHERE id = $1',
      [jid, last ? last.number : null, last ? last.total : null, last ? last.created_at : null]);
  }
  app.delete('/api/admin/invoices/:id', withDb(async function (p, req, res) {
    const r = await p.query('DELETE FROM invoices WHERE id = $1 RETURNING job_id, number, total, landlord_name, paid_at', [jobId(req)]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'not-found' });
    const x = r.rows[0];
    await refreshJobInvoice(p, x.job_id);
    await p.query('INSERT INTO job_updates (job_id, kind, body) VALUES ($1, $2, $3)', [x.job_id, 'change',
      'Invoice ' + (x.number || '') + ' deleted (' + gbp(x.total) + (x.landlord_name ? ', ' + x.landlord_name : '') + (x.paid_at ? ', was marked paid' : '') + ').']);
    res.json({ ok: true });
  }));
  // An invoice from before invoices were saved (only recorded on the job).
  app.delete('/api/admin/jobs/:id/invoice', withDb(async function (p, req, res) {
    const id = jobId(req);
    const cur = (await p.query('SELECT invoice_number, invoice_total FROM jobs WHERE id = $1', [id])).rows[0];
    if (!cur) return res.status(404).json({ ok: false, error: 'not-found' });
    await refreshJobInvoice(p, id);
    await p.query('INSERT INTO job_updates (job_id, kind, body) VALUES ($1, $2, $3)', [id, 'change', 'Invoice ' + (cur.invoice_number || '') + ' deleted (' + gbp(cur.invoice_total) + ').']);
    res.json({ ok: true });
  }));

  // Edit a saved invoice in place (same record, change noted in the job history).
  app.put('/api/admin/invoices/:id', withDb(async function (p, req, res) {
    const b = req.body || {};
    const total = money(b.total);
    if (total === undefined || total === null) return res.status(400).json({ ok: false, error: 'bad-total' });
    if (!b.data || typeof b.data !== 'object') return res.status(400).json({ ok: false, error: 'no-data' });
    const cur = await p.query('SELECT i.id, i.job_id, i.number, i.total, j.property_address FROM invoices i JOIN jobs j ON j.id = i.job_id WHERE i.id = $1', [jobId(req)]);
    if (!cur.rows.length) return res.status(404).json({ ok: false, error: 'not-found' });
    const inv = cur.rows[0];
    const number = str(b.invoice_number, 50) || inv.number;
    const clean = cleanInvoiceData(b.data, number, total);
    await p.query('UPDATE invoices SET number = $2, total = $3, landlord_name = $4, landlord_email = $5, data = $6 WHERE id = $1',
      [inv.id, number, total, clean.landlord, clean.landlordEmail, JSON.stringify(clean)]);
    // Keep the job's invoice summary in step when this is its latest invoice.
    const latest = await p.query('SELECT max(id) AS id FROM invoices WHERE job_id = $1', [inv.job_id]);
    if (latest.rows[0].id === inv.id) await p.query('UPDATE jobs SET invoice_number = $2, invoice_total = $3, updated_at = now() WHERE id = $1', [inv.job_id, number, total]);
    if (str(b.landlord_name)) await ensureLandlord(p, b, inv.property_address);
    const changes = [];
    if (number !== inv.number) changes.push('number ' + inv.number + ' → ' + number);
    if (Number(inv.total) !== total) changes.push('total ' + gbp(inv.total) + ' → ' + gbp(total));
    await p.query('INSERT INTO job_updates (job_id, kind, body) VALUES ($1, $2, $3)', [inv.job_id, 'email',
      'Invoice ' + number + ' edited' + (changes.length ? ' (' + changes.join(', ') + ')' : '') + '.']);
    res.json({ ok: true });
  }));
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
       WHERE id = $1 RETURNING id, property_address`, [id, number, total, str(b.landlord_name, 200), str(b.landlord_email, 200),
        str(b.landlord_phone, 50), str(b.landlord_address, 500)]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'not-found' });
    if (str(b.landlord_name)) await ensureLandlord(p, b, r.rows[0].property_address);
    // Keep the whole invoice so it can be opened and resent exactly as issued.
    let invoiceId = null;
    if (b.data && typeof b.data === 'object') {
      const clean = cleanInvoiceData(b.data, number, total);
      invoiceId = (await p.query('INSERT INTO invoices (job_id, number, total, landlord_name, landlord_email, data) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [id, number, total, clean.landlord, clean.landlordEmail, JSON.stringify(clean)])).rows[0].id;
    }
    await p.query('INSERT INTO job_updates (job_id, kind, body) VALUES ($1, $2, $3)',
      [id, 'email', 'Invoice ' + number + ' issued to ' + (str(b.landlord_name, 200) || 'the landlord') + ' for ' + gbp(total) +
        (str(b.how, 100) ? ' (' + str(b.how, 100) + ')' : '') + '.']);
    res.json({ ok: true, invoice_number: number, invoice_id: invoiceId });
  }));

  // Suggests an itemised breakdown of the charge to the landlord (labour,
  // materials, call-out…) that adds up exactly to the total staff entered. It's
  // a starting point for staff to check and edit, never sent without review.
  // ---------- Contractor payments ----------
  // Marks jobs as paid (or not paid) to the contractor. What's owed is worked
  // out in the dashboard from each job's actual cost and contractor.
  app.post('/api/admin/contractor-payments', withDb(async function (p, req, res) {
    const b = req.body || {};
    const ids = (Array.isArray(b.job_ids) ? b.job_ids : []).map(function (x) { return parseInt(x, 10); }).filter(function (x) { return x > 0; }).slice(0, 500);
    if (!ids.length) return res.status(400).json({ ok: false, error: 'no-jobs' });
    const paid = b.paid !== false;
    const r = await p.query(
      'UPDATE jobs SET contractor_paid_at = ' + (paid ? 'coalesce(contractor_paid_at, now())' : 'NULL') + ', updated_at = now() WHERE id = ANY($1::int[]) RETURNING id, assigned_to, actual_cost',
      [ids]);
    const note = str(b.note, 200);
    for (const row of r.rows) {
      await p.query('INSERT INTO job_updates (job_id, kind, body) VALUES ($1, $2, $3)', [row.id, 'change',
        paid ? 'Contractor paid' + (row.assigned_to ? ' (' + row.assigned_to + ')' : '') + (row.actual_cost != null ? ': ' + gbp(row.actual_cost) : '') + (note ? ' — ' + note : '') + '.'
             : 'Contractor payment un-marked.']);
    }
    res.json({ ok: true, updated: r.rows.length });
  }));

  // A tenant's email listing their repairs: find the tenant and property, and
  // organise the issues into jobs by trade so each can go to the right contractor.
  function emailPrompt(text, trades) {
    return 'You organise repair requests for Residential Realtors, a UK letting agent. Below is an email (or message) from a tenant, pasted by staff, between the ---- lines. It may include a signature, greetings, forwarded headers and quoted older messages; ignore anything that is not about current repairs.\n----\n' + text + '\n----\n\n' +
      'Their contractors: ' + (trades || 'none listed') + '.\n\n' +
      'Organise the reported problems into jobs: group problems that the same kind of tradesperson would fix (e.g. all plumbing together, all electrics together, gas appliances separately for a Gas Safe engineer, general handyman tasks together). If everything suits one handyman, make one job. For each job give:\n' +
      '- address: the property address from the email (signature, subject or body), tidied up; keep flat/house numbers and postcode exactly. Same address on every job.\n' +
      '- category: a short issue type, e.g. "Plumbing", "Electrics", "Heating and boiler", "Gas appliance", "Damp and mould", "Doors and locks", "Windows", "Pest control", "General repair"\n' +
      '- title: a short job title, e.g. "Leaking kitchen tap" or "General repairs (3 items)"\n' +
      '- description: for one problem, one or two plain sentences for the contractor; for several, one per line (separated by \\n). Keep every detail the tenant gave (room, item, what is wrong, since when). Do not drop problems.\n' +
      '- tenants: the tenant(s) who wrote or are named, as [{"name": "", "phone": "", "email": ""}] using only what appears in the email (the sender\'s email address if shown); [] if none\n' +
      '- urgency: "Emergency" (danger to people or property: gas smell, electrical danger, major leak, no heating or hot water in cold weather, insecure front door), "Urgent" (significant but not dangerous), or "Routine"\n' +
      '- contractor: the contractor name from the list that fits the trade, or "" if none fits\n' +
      '- send: false\n' +
      '- warning: a short note if a job needs a specialist that none of the contractors are (e.g. "Gas hob fault needs a Gas Safe registered engineer"), or if the tenant mentions a safety risk; otherwise ""\n' +
      'Never invent names, phone numbers, addresses or dates.\n' +
      'Reply with ONLY JSON: {"jobs": [{"address": "", "category": "", "title": "", "description": "", "urgency": "Routine", "contractor": "", "send": false, "tenants": [], "warning": ""}], "understood": true}. ' +
      'If there are no repair requests in it, reply {"jobs": [], "understood": false}.';
  }

  // ---------- Assistant: plain-English (or spoken) commands ----------
  // Turns something like "add a gas safety for 6 Whitworth House" into a
  // structured job draft. Nothing is created here: the dashboard matches the
  // property, tenant and contractor and shows the draft for staff to confirm.
  app.post('/api/admin/assistant', withDb(async function (p, req, res) {
    if (!opts.askAi || !opts.canAi || !opts.canAi()) return res.status(503).json({ ok: false, error: 'ai-not-configured' });
    // Pasted messages can carry invisible direction marks around phone numbers.
    const text = str(String((req.body || {}).text || '').replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, ''), 6000);
    if (!text) return res.status(400).json({ ok: false, error: 'no-text' });
    const trades = (await p.query('SELECT name, trade FROM contractors WHERE active ORDER BY name')).rows
      .map(function (c) { return c.name + (c.trade ? ' (' + c.trade + ')' : ''); }).join('; ');
    const fromEmail = (req.body || {}).mode === 'email';
    const prompt = fromEmail ? emailPrompt(text, trades) : 'You turn instructions from a UK letting agent\'s maintenance manager into repair jobs for their job system.\n\n' +
      'Instruction (spoken via speech-to-text, so allow for mis-heard words, or a pasted message that may list several properties, each with its tasks and tenant contacts), between the ---- lines:\n----\n' + text + '\n----\n\n' +
      'Their contractors: ' + (trades || 'none listed') + '.\n\n' +
      'Make exactly one job per property address mentioned (a pasted message may contain several, often each followed by "for Jim" or similar). Put all the tasks for the same property into that one job. For each job give:\n' +
      '- address: the property as said, tidied up (e.g. "6 Whitworth House"); keep flat/house numbers exactly\n' +
      '- category: a short issue type, e.g. "Gas safety", "EICR", "Plumbing", "Heating and boiler", "Electrics", "Damp and mould", "Doors and locks", "Pest control", "General repair"\n' +
      '- title: a short job title, e.g. "Annual gas safety check (CP12)", or for several tasks a summary like "General repairs (5 items)"\n' +
      '- description: for one task, one or two plain sentences for the contractor. For several tasks, one task per line (separated by \\n), each written clearly and keeping every detail given (room, item, what to do); do not drop or merge tasks. For gas safety checks and EICRs, and whenever the instruction says so, end with "Please contact the tenant directly to arrange a time."\n' +
      '- tenants: the tenants for that property exactly as given in the instruction, as [{"name": "", "phone": ""}] (name "" if only a number is given; numbers written as given); [] if none given\n' +
      '- urgency: "Emergency" (danger, no heating/water in winter, major leak), "Urgent", or "Routine" (checks, certificates, minor repairs)\n' +
      '- contractor: the contractor name from the list that fits the trade or was named, or "" if none fits\n' +
      '- send: true if the instruction asks to send, email or message it to the contractor, or to get them to arrange it; otherwise false\n' +
      '- warning: if any task involves a gas appliance or gas supply (hob, cooker, boiler, gas fire, gas smell) and the chosen contractor is not a gas engineer, a short note such as "Gas hob fault needs a Gas Safe registered engineer"; otherwise ""\n' +
      'Never invent tenant names, phone numbers, addresses or dates; only use what is in the instruction.\n\n' +
      'The instruction may instead (or also) ask to ADD A CONTACT: a new contractor, a landlord, or a tenant (e.g. "add a contractor: Miguel, cleaner, NW Cleaning, 07404 043045" or "Mrs Jones is the landlord of 9 Park Road"). ' +
      'Do not make a job for that. Put each contact in "contacts" with: type ("contractor", "landlord" or "tenant"), name (the person, as given), company (business name if given, else ""), ' +
      'trade (for contractors: e.g. "Cleaner", "Plumber", "Handyman", "Electrician", "Gas safety"; else ""), phone, email, address (a landlord\'s own postal address if given, else ""), ' +
      'property (for tenants: the property they live at; for landlords: every property they own, separated by "; "; else ""), notes (anything else useful, else "").\n' +
      'The instruction may instead be the details of a NEW TENANCY (a new let: property, tenants, rent, start date, landlord, deposit, fees — e.g. a pasted offer, Terms of Let or notes). ' +
      'Do not make a job or contacts for that. Put it in "tenancies" with: address (full, keep flat/house number and postcode), start_date, move_in_due (when the first rent and deposit are due), date_taken, checkin_date (all YYYY-MM-DD; today is ' + new Date().toISOString().slice(0, 10) + '; "" if not given), ' +
      'checkin_time ("HH:MM" or ""), checkin_type ("clerk" if an inventory clerk / check-in is booked, "diy" for a DIY check-in / tenant\'s own inventory, "" if not said), term_months, break_months, rent_pcm (monthly rent in pounds; convert weekly rent × 52 / 12), deposit, holding (holding deposit / reservation fee paid) — numbers or null if not given, holding_date (when the holding deposit was paid, YYYY-MM-DD or ""), ' +
      'deposit_by ("agent" if we/the agent register it, "landlord" if the landlord does, "" if not said), deposit_scheme, negotiator, service ("Tenant Find", "Rent Collection" or "Fully Managed"), ' +
      'find_pct, collect_pct, manage_pct (percentages as numbers, or null), find_basis ("upfront" if the fee is on the annual rent / taken up front, "monthly" if monthly, "" if not said), ' +
      'tenants and guarantors (each [{"name": "", "email": "", "phone": ""}], names with titles as given), landlord ({"name": "", "email": "", "phone": "", "line1": "", "line2": "", "country": "", "postcode": ""} — their own address), ' +
      'fees (other fees charged to the landlord: [{"label": "", "amount": 0}]), notes (anything else useful).\n' +
      'Reply with ONLY JSON: {"jobs": [{"address": "", "category": "", "title": "", "description": "", "urgency": "Routine", "contractor": "", "send": false, "tenants": [], "warning": ""}], ' +
      '"contacts": [{"type": "contractor", "name": "", "company": "", "trade": "", "phone": "", "email": "", "address": "", "property": "", "notes": ""}], "tenancies": [], "understood": true}. ' +
      'Use [] for jobs, contacts or tenancies when there are none. If the instruction is none of these, reply {"jobs": [], "contacts": [], "tenancies": [], "understood": false}.';
    const result = await opts.askAi(prompt, true);
    if (!result.ok) return res.status(502).json({ ok: false, error: 'ai-failed' });
    let parsed = null;
    try { parsed = JSON.parse(result.text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()); } catch (e) { parsed = null; }
    if (!parsed) return res.status(502).json({ ok: false, error: 'ai-bad-reply' });
    const jobs = (Array.isArray(parsed.jobs) ? parsed.jobs : []).slice(0, 20).map(function (j) {
      return {
        address: str(j.address, 300) || '', category: str(j.category, 100) || '', title: str(j.title, 200) || '',
        description: str(j.description, 2000) || '', urgency: URGENCIES.indexOf(j.urgency) !== -1 ? j.urgency : 'Routine',
        contractor: str(j.contractor, 200) || '', send: !!j.send, warning: str(j.warning, 300) || '',
        tenants: (Array.isArray(j.tenants) ? j.tenants : []).slice(0, 10).map(function (t) {
          return { name: str(t && t.name, 200) || '', phone: str(t && t.phone, 50) || '', email: str(t && t.email, 200) || '' };
        }).filter(function (t) { return t.name || t.phone || t.email; })
      };
    }).filter(function (j) { return j.address || j.title; });
    const contacts = (Array.isArray(parsed.contacts) ? parsed.contacts : []).slice(0, 10).map(function (c) {
      return {
        type: ['contractor', 'landlord', 'tenant'].indexOf(c && c.type) !== -1 ? c.type : 'contractor',
        name: str(c && c.name, 200) || '', company: str(c && c.company, 200) || '', trade: str(c && c.trade, 100) || '',
        phone: str(c && c.phone, 50) || '', email: str(c && c.email, 200) || '', address: str(c && c.address, 500) || '',
        property: str(c && c.property, 300) || '', notes: str(c && c.notes, 500) || ''
      };
    }).filter(function (c) { return c.name || c.company || c.phone || c.email; });
    // New tenancies: cleaned like a saved one, then shown for staff to check.
    const tenancies = (Array.isArray(parsed.tenancies) ? parsed.tenancies : []).slice(0, 5).map(function (t) {
      const d = cleanTenancy(t || {});
      if (!(t && t.break_months)) d.break_months = 0;
      if (!(t && (t.deposit_by === 'agent' || t.deposit_by === 'landlord'))) d.deposit_by = null;
      if (!(t && (t.find_basis === 'upfront' || t.find_basis === 'monthly'))) d.find_basis = null;
      return d;
    }).filter(function (d) { return d.address || d.tenants.length; });
    res.json({ ok: true, jobs: jobs, contacts: contacts, tenancies: tenancies, understood: parsed.understood !== false && (jobs.length > 0 || contacts.length > 0 || tenancies.length > 0) });
  }));

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

  // ---------- Tenant repair tracker ----------
  // /track: tenants look up their open repairs by reference or full address.
  // /t/<token>: the private progress page linked from messages to the tenant.
  // Only safe details are shown: reference, issue, progress stage, dates and the
  // messages we sent them. Never names, phone numbers, contractors or costs.
  app.post('/api/admin/jobs/:id/track-link', withDb(async function (p, req, res) {
    const token = await ensureTrackToken(p, jobId(req));
    if (!token) return res.status(404).json({ ok: false, error: 'not-found' });
    res.json({ ok: true, url: baseUrl(req) + '/t/' + token });
  }));

  const STAGES = [
    { key: 'reported', label: 'Reported' },
    { key: 'arranging', label: 'Arranging a contractor' },
    { key: 'booked', label: 'Contractor arranged' },
    { key: 'done', label: 'Completed' }
  ];
  function stageOf(status) {
    return status === 'Completed' ? 3 : (status === 'Contractor booked' || status === 'Awaiting parts') ? 2 : status === 'New' ? 0 : 1;
  }
  const STATUS_TEXT = {
    'New': 'We’ve received your report and are reviewing it.',
    'Assigned': 'We’re arranging a contractor for this repair.',
    'Contractor booked': 'A contractor has been arranged and will contact you directly to arrange a convenient time.',
    'Awaiting parts': 'The contractor is waiting for parts. We’ll be in touch when they arrive.',
    'On hold': 'This repair is on hold for now. We’ll update you as soon as it can go ahead.',
    'Completed': 'This repair has been completed.',
    'Cancelled': 'This repair has been closed.'
  };
  // What tenants see for each status ("Contractor booked" reads as "Contractor arranged").
  const PUBLIC_STATUS = { 'Contractor booked': 'Contractor arranged' };
  function statusNote(j) {
    const appt = j.status !== 'Completed' && j.status !== 'Cancelled' ? apptText(j) : '';
    if (appt) return 'Your repair is booked for ' + appt + '. Please make sure someone can give access, or let us know if this doesn’t suit.';
    if (j.landlord_handles && j.status !== 'Completed' && j.status !== 'Cancelled') return 'Your landlord is arranging this repair' + (j.landlord_handles === 'contractor' ? ' with their own contractor' : '') + ' and will be in touch with you directly to arrange a time.';
    if (j.status === 'Contractor booked' && j.direct_contact === 'No') return 'A contractor has been arranged. We’ll be in touch to arrange access.';
    return STATUS_TEXT[j.status] || '';
  }
  const TARGET = { Emergency: 'within 48 hours', Urgent: 'within 5 days', Routine: 'within 14 days' };
  function whenUk(d) { return d ? new Date(d).toLocaleDateString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'long', year: 'numeric' }) : ''; }
  // bare: no Back link or link to the tenant pages (the contractor's job page).
  function trackShell(title, inner, bare) {
    return '<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">' +
      '<link rel="icon" type="image/png" sizes="32x32" href="/icons/app-32.png"><link rel="apple-touch-icon" sizes="180x180" href="/icons/app-180.png">' +
      '<title>' + htmlEsc(title) + ' — Residential Realtors</title><style>' +
      ':root{--ink:#0b0c0f;--soft:#5b616e;--faint:#8b919c;--line:#e8e9ed;--red:#D9262E;--ok:#139A4B;--okt:#e9f7ef;--blue:#2F5BEA;--bluet:#eef2fe;--amber:#c26a00;--ambert:#fef4e6;--bg:#f4f5f7;--card:#fff;--shadow:0 1px 2px rgba(16,18,24,.04),0 8px 24px -12px rgba(16,18,24,.12)}' +
      '*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Inter,Roboto,sans-serif;background:var(--bg);color:var(--ink);line-height:1.5;-webkit-font-smoothing:antialiased}' +
      'header{background:linear-gradient(180deg,#0e0f13,#16181e);color:#fff;padding:16px 16px 18px}header .in{max-width:640px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;gap:10px}header b{color:var(--red)}header a{color:#fff;text-decoration:none;font-weight:700}header .logo{display:inline-flex}header .logo img{height:34px;width:auto;display:block}header .tag{font-size:.72rem;letter-spacing:.14em;text-transform:uppercase;color:#9da2ad;font-weight:600}' +
      'main{max-width:640px;margin:0 auto;padding:16px 16px 48px}h1{font-size:1.45rem;margin:0 0 4px;letter-spacing:-.025em;line-height:1.2}.sub{color:var(--soft);margin:0 0 18px}' +
      'form{display:flex;gap:8px;margin:0 0 18px}form[hidden]{display:none}form.stack{flex-direction:column}.tabs{display:inline-flex;background:#e9eaee;border-radius:12px;padding:3px;margin:0 0 12px}.tabs button{background:none;color:var(--soft);padding:8px 14px;border-radius:9px}.tabs button.on{background:#fff;color:var(--ink);box-shadow:0 1px 2px rgba(0,0,0,.08)}input{flex:1;min-width:0;padding:12px 14px;border:1px solid #d9dbe1;border-radius:12px;font:inherit;background:#fff}input:focus{outline:none;border-color:var(--blue);box-shadow:0 0 0 3px var(--bluet)}button{padding:12px 18px;border:0;border-radius:12px;background:var(--ink);color:#fff;font:inherit;font-weight:600;cursor:pointer}' +
      '.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:18px;margin-bottom:12px;box-shadow:var(--shadow)}.ref{font-weight:700}.muted{color:var(--soft);font-size:.9rem}' +
      '.steps{display:flex;gap:6px;margin:14px 0 8px}.steps div{flex:1;height:6px;border-radius:6px;background:#e7e8ec}.steps div.on{background:var(--ok)}' +
      '.labels{display:flex;justify-content:space-between;font-size:.72rem;color:var(--soft);gap:4px}.labels span.on{color:var(--ink);font-weight:600}' +
      '.status{font-weight:600;margin:10px 0 2px}.upd{border-top:1px solid var(--line);padding-top:10px;margin-top:10px;white-space:pre-line;font-size:.92rem}.upd .d{font-size:.78rem;color:var(--soft);font-weight:600}' +
      'a.more{color:var(--blue);font-weight:600;text-decoration:none}a.back{display:inline-flex;align-items:center;gap:4px;color:var(--soft);font-weight:600;font-size:.9rem;text-decoration:none;margin:0 0 10px;padding:6px 0}a.back:hover{color:var(--ink)}.note{font-size:.85rem;color:var(--soft);margin-top:18px}' +
      'footer{max-width:640px;margin:0 auto;padding:0 16px 32px;color:var(--faint);font-size:.78rem;text-align:center}' +
      /* repair tracker */
      '.hero{padding:20px}.chip{display:inline-flex;align-items:center;gap:6px;font-size:.74rem;font-weight:700;letter-spacing:.04em;padding:4px 10px;border-radius:999px;background:#f0f1f4;color:var(--soft)}.chip i{width:7px;height:7px;border-radius:50%;background:currentColor}' +
      '.chip.blue{background:var(--bluet);color:var(--blue)}.chip.ok{background:var(--okt);color:var(--ok)}.chip.amber{background:var(--ambert);color:var(--amber)}.chip.grey{background:#f0f1f4;color:var(--soft)}' +
      '.hero-top{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:12px}.hero h1{font-size:1.3rem;margin:0}.addr{display:flex;align-items:center;gap:6px;color:var(--soft);font-size:.92rem;margin-top:6px}.addr svg{flex:none}' +
      '.now{display:flex;gap:14px;align-items:flex-start;margin-top:16px;padding:14px;border-radius:14px;background:#f7f8fa}.now .ic{width:44px;height:44px;border-radius:12px;display:grid;place-items:center;flex:none}.now .ic svg{width:22px;height:22px}' +
      '.now.blue .ic{background:var(--bluet);color:var(--blue)}.now.ok .ic{background:var(--okt);color:var(--ok)}.now.amber .ic{background:var(--ambert);color:var(--amber)}.now.grey .ic{background:#eceef1;color:var(--soft)}' +
      '.now h2{font-size:1.02rem;margin:0 0 3px;letter-spacing:-.01em}.now p{margin:0;color:var(--soft);font-size:.9rem}' +
      '.sec{font-size:.72rem;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--faint);margin:0 0 12px}' +
      '.tl{list-style:none;margin:0;padding:0}.tl li{position:relative;display:flex;gap:14px;padding-bottom:18px}.tl li:last-child{padding-bottom:0}.tl li:not(:last-child)::before{content:"";position:absolute;left:13px;top:28px;bottom:2px;width:2px;background:var(--line)}.tl li.done:not(:last-child)::before{background:var(--ok)}' +
      '.tl .dot{width:28px;height:28px;border-radius:50%;flex:none;display:grid;place-items:center;background:#fff;border:2px solid #d9dbe1;color:#fff}.tl li.done .dot{background:var(--ok);border-color:var(--ok)}.tl li.cur .dot{border-color:var(--blue);box-shadow:0 0 0 4px var(--bluet)}.tl li.cur .dot::after{content:"";width:10px;height:10px;border-radius:50%;background:var(--blue)}' +
      '.tl .t{font-weight:600;font-size:.95rem;line-height:28px}.tl li.todo .t{color:var(--faint);font-weight:500}.tl .s{color:var(--soft);font-size:.84rem;margin-top:-2px}' +
      '.facts{display:grid;grid-template-columns:1fr 1fr;gap:10px}.fact{background:#f7f8fa;border-radius:12px;padding:10px 12px}.fact .k{font-size:.72rem;color:var(--faint);font-weight:600;text-transform:uppercase;letter-spacing:.05em}.fact .v{font-weight:600;font-size:.92rem;margin-top:2px}' +
      '.msg{border-top:1px solid var(--line);padding:14px 0 0;margin-top:14px}.sec+.msg{border-top:0;margin-top:0;padding-top:0}.msg .d{font-size:.78rem;color:var(--faint);font-weight:600;margin-bottom:4px}.msg .h{font-weight:650;font-size:.94rem;margin-bottom:4px}.msg .b{white-space:pre-line;font-size:.92rem;color:#2b2e36}' +
      '.help{display:flex;flex-direction:column;gap:10px}.help p{margin:0;color:var(--soft);font-size:.9rem}.btns{display:flex;flex-wrap:wrap;gap:8px}.btn2{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:11px 16px;border-radius:12px;font-weight:600;font-size:.9rem;text-decoration:none;background:var(--ink);color:#fff}.btn2.ghost{background:#fff;color:var(--ink);border:1px solid var(--line)}' +
      '@media (max-width:420px){.facts{grid-template-columns:1fr 1fr}.hero h1{font-size:1.18rem}}</style></head><body>' +
      '<header><div class="in">' + (bare ? '<span class="logo"><img src="/logo-white.png" alt="Residential Realtors"></span>' : '<a class="logo" href="/"><img src="/logo-white.png" alt="Residential Realtors"></a>') + '<span class="tag">Maintenance</span></div></header><main>' + (bare ? '' : '<a class="back" href="/" onclick="if(history.length>1){history.back();return false}">&larr; Back</a>') + inner + '</main><footer>Residential Realtors · Property maintenance</footer><script src="/rrt.js" defer></script></body></html>';
  }
  function progressHtml(j) {
    const st = stageOf(j.status), cancelled = j.status === 'Cancelled';
    return '<div class="steps">' + STAGES.map(function (x, i) { return '<div class="' + (!cancelled && i <= st ? 'on' : '') + '"></div>'; }).join('') + '</div>' +
      '<div class="labels">' + STAGES.map(function (x, i) { return '<span class="' + (!cancelled && i === st ? 'on' : '') + '">' + x.label + '</span>'; }).join('') + '</div>' +
      '<div class="status">' + htmlEsc(j.status === 'Completed' && j.completed_at ? 'Completed on ' + whenUk(j.completed_at) : (j.status !== 'Cancelled' && apptText(j) ? 'Booked for ' + apptText(j) : (PUBLIC_STATUS[j.status] || j.status))) + '</div>' +
      '<div class="muted">' + htmlEsc(statusNote(j)) + '</div>';
  }
  // Tenant-facing pages never show the door number: drop "Flat 4" / "Apartment 2"
  // style parts and the house/building number, keeping street, town and postcode.
  function publicAddress(addr) {
    const parts = String(addr || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    const kept = parts.map(function (x) {
      if (/^(flat|apartment|apt|unit|room|studio|maisonette|no\.?)\s*[\w-]*\d[\w-]*$/i.test(x)) return '';   // "Flat 4", "Unit 2B"
      if (/^[\d]+[a-z]?(\s*[-/]\s*\d+[a-z]?)?$/i.test(x)) return '';                                         // "22", "3-5"
      return x.replace(/^(flat|apartment|apt|unit|room|studio)\s+[\w-]*\d[\w-]*\s+/i, '')                   // "Flat 4 22 Queen St"
        .replace(/^\d+[a-z]?(\s*[-/]\s*\d+[a-z]?)?\s+/i, '');                                                   // "22 Queen St" -> "Queen St"
    }).filter(Boolean);
    return kept.join(', ');
  }
  // The door numbers in an address ("Flat 3, 24 Wisden House" -> 3, 24), postcode
  // left out, so a tenant can prove which home they live in.
  function doorNumbers(addr) {
    return (String(addr || '').replace(POSTCODE_RE, ' ').match(/\b\d+[a-z]?\b/gi) || []).map(function (x) { return x.toUpperCase(); });
  }
  function issueText(j) { return [j.category, j.affected, j.symptom].filter(Boolean).join(' – ') + (j.location ? ' (' + j.location + ')' : ''); }
  // Light protection against guessing: a few lookups a minute per visitor.
  const trackHits = new Map();
  function trackAllowed(ip) {
    const now = Date.now(), e = trackHits.get(ip);
    if (!e || now - e.start > 10 * 60 * 1000) { trackHits.set(ip, { start: now, n: 1 }); return true; }
    e.n += 1; return e.n <= 40;
  }

  app.get('/track', withDb(async function (p, req, res) {
    countVisit(req, 'track').catch(function () {});
    res.setHeader('X-Robots-Tag', 'noindex'); res.setHeader('Referrer-Policy', 'no-referrer');
    const ref = String(req.query.ref || req.query.q || '').trim().slice(0, 40);
    const door = String(req.query.door || '').trim().slice(0, 20);
    const name = String(req.query.name || '').trim().slice(0, 120);
    const phone = String(req.query.phone || '').trim().slice(0, 40);
    const byPhone = !!(name || phone);
    let results = '';
    const COLS = 'id, status, urgency, created_at, updated_at, completed_at, category, affected, symptom, location, property_address, direct_contact, appointment_date, appointment_time, track_token';
    if (ref || door || byPhone) {
      if (!trackAllowed(req.ip)) {
        results = '<div class="card">Too many searches — please wait a few minutes and try again.</div>';
      } else {
        let rows = [], problem = '';
        if (byPhone) {
          // Name and phone number: the tenant's own open repairs, and those at the
          // property they live at (e.g. reported by a housemate).
          const tail = phoneTail(phone);
          const words = name.toLowerCase().split(/[^a-z']+/).filter(function (w) { return w.length >= 2; });
          if (!tail || !words.length) problem = 'Please enter your name and the phone number you gave us.';
          else {
            const nameOk = function (n) { const have = String(n || '').toLowerCase(); return words.some(function (w) { return have.split(/[^a-z']+/).indexOf(w) !== -1; }); };
            const open = (await p.query('SELECT ' + COLS + ", tenant_name, tenant_phone FROM jobs WHERE archived_at IS NULL AND status NOT IN ('Completed', 'Cancelled') ORDER BY created_at DESC LIMIT 3000")).rows;
            const mine = open.filter(function (j) { return phoneTail(j.tenant_phone) === tail && nameOk(j.tenant_name); });
            const t = (await p.query(`SELECT t.name, pt.property_key FROM tenants t JOIN property_tenants pt ON pt.tenant_id = t.id
              WHERE pt.moved_out_at IS NULL AND right(regexp_replace(coalesce(t.phone, ''), '\\D', '', 'g'), 10) = $1`, [tail])).rows.filter(function (x) { return nameOk(x.name); });
            const keys = t.map(function (x) { return x.property_key; });
            const seen = {};
            rows = mine.concat(open.filter(function (j) { return keys.indexOf(propKey(j.property_address)) !== -1; }))
              .filter(function (j) { if (seen[j.id]) return false; seen[j.id] = true; return true; });
          }
        } else {
          // Reference and door number must both match, so a guessed reference shows nothing.
          const m = /^\s*RR[-\s]?0*(\d{1,7})\s*$/i.exec(ref) || /^\s*0*(\d{1,7})\s*$/.exec(ref);
          const dn = door.toUpperCase().replace(/^\s*(FLAT|APARTMENT|APT|UNIT|HOUSE|NO\.?|NUMBER)\s*/, '').replace(/\s+/g, '');
          if (!m) problem = 'That doesn’t look like a reference — it should look like RR-00012.';
          else if (!/^\d{1,5}[A-Z]?$/.test(dn)) problem = 'Please enter your door number, e.g. 24 or 3B.';
          else rows = (await p.query('SELECT ' + COLS + " FROM jobs WHERE id = $1 AND archived_at IS NULL AND status NOT IN ('Completed', 'Cancelled')", [parseInt(m[1], 10)])).rows
            .filter(function (j) { return doorNumbers(j.property_address).indexOf(dn) !== -1; });
        }
        if (problem) results = '<div class="card">' + htmlEsc(problem) + '</div>';
        else if (!rows.length) {
          results = '<div class="card"><strong>No open repairs found.</strong><div class="muted">' + (byPhone
            ? 'Check you’ve used the same name and phone number you gave when reporting, or search by your reference instead.'
            : 'Check the reference (it’s in the messages we sent you and looks like RR-00012) and your door number — or search with your name and phone number instead.') + ' Completed repairs aren’t shown here.</div></div>';
        } else {
          for (const j of rows) { if (!j.track_token) j.track_token = await ensureTrackToken(p, j.id); }
          results = rows.map(function (j) {
            return '<div class="card"><div class="ref">' + refFor(j.id) + ' · ' + htmlEsc(issueText(j) || 'Repair') + '</div>' +
              '<div class="muted">' + htmlEsc(publicAddress(j.property_address)) + ' · reported ' + whenUk(j.created_at) + '</div>' + progressHtml(j) +
              '<div style="margin-top:10px"><a class="more" href="/t/' + j.track_token + '">See full progress →</a></div></div>';
          }).join('');
        }
      }
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(trackShell('Track a repair',
      '<h1>Track a repair</h1><p class="sub">See how your open repairs are progressing. Use your reference and door number, or your name and phone number.</p>' +
      '<div class="tabs"><button type="button" data-t="ref" class="' + (byPhone ? '' : 'on') + '">Reference &amp; door number</button><button type="button" data-t="phone" class="' + (byPhone ? 'on' : '') + '">Name &amp; phone</button></div>' +
      '<form method="get" action="/track" id="fRef" class="stack"' + (byPhone ? ' hidden' : '') + '><input name="ref" value="' + htmlEsc(ref) + '" placeholder="Reference, e.g. RR-00012" aria-label="Reference" autocomplete="off">' +
        '<input name="door" value="' + htmlEsc(door) + '" placeholder="Your door number, e.g. 24 or Flat 3" aria-label="Door number" autocomplete="off"><button type="submit">Track</button></form>' +
      '<form method="get" action="/track" id="fPhone" class="stack"' + (byPhone ? '' : ' hidden') + '><input name="name" value="' + htmlEsc(name) + '" placeholder="Your name" aria-label="Your name" autocomplete="name">' +
        '<input name="phone" value="' + htmlEsc(phone) + '" placeholder="Your phone number" aria-label="Your phone number" type="tel" autocomplete="tel"><button type="submit">Track</button></form>' +
      results + '<p class="note">Need to report something new? <a class="more" href="/">Report a repair</a>. For emergencies such as a gas smell or flooding, call us straight away.</p>' +
      '<script>document.querySelectorAll(".tabs button").forEach(function(b){b.addEventListener("click",function(){var r=b.dataset.t==="ref";document.getElementById("fRef").hidden=!r;document.getElementById("fPhone").hidden=r;' +
      'document.querySelectorAll(".tabs button").forEach(function(x){x.classList.toggle("on",x===b);});(r?document.querySelector("#fRef input"):document.querySelector("#fPhone input")).focus();});});</script>'));
  }));

  app.get('/t/:token', withDb(async function (p, req, res) {
    countVisit(req, 'track').catch(function () {});
    res.setHeader('X-Robots-Tag', 'noindex'); res.setHeader('Referrer-Policy', 'no-referrer');
    const token = String(req.params.token || '');
    if (!/^[A-Za-z0-9_-]{20,}$/.test(token)) return res.status(404).send('Not found');
    const j = (await p.query(`SELECT id, status, urgency, created_at, updated_at, completed_at, category, affected, symptom, location, property_address, direct_contact, appointment_date, appointment_time, assigned_to, landlord_handles
      FROM jobs WHERE track_token = $1 AND archived_at IS NULL`, [token])).rows[0];
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (!j) return res.status(404).send(trackShell('Repair not found', '<h1>Repair not found</h1><p class="sub">This link is no longer available. <a class="more" href="/track">Look up a repair</a></p>'));
    const u = (await p.query(`SELECT created_at, body FROM job_updates WHERE job_id = $1 AND kind = 'tenant_message' ORDER BY created_at DESC LIMIT 10`, [j.id])).rows;
    // Contractor names never show here (this link also goes to landlords).
    const names = (await p.query("SELECT name FROM contractors WHERE coalesce(trim(name), '') <> ''")).rows.map(function (r) { return r.name.trim(); });
    if (j.assigned_to && names.indexOf(j.assigned_to.trim()) === -1) names.push(j.assigned_to.trim());
    names.sort(function (a, b) { return b.length - a.length; });
    const reEsc = function (t) { return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
    const pubAddr = publicAddress(j.property_address);
    // A logged message is "<how> — <subject>\n\n<message>" or "Told the tenant …:\n\n<message>".
    // Show just the subject and the message itself: no log wording, greeting,
    // sign-off, links, contractor names or door numbers.
    const seenMsg = {};
    const updates = u.map(function (x) {
      let raw = String(x.body || ''), head = '';
      const nl = raw.indexOf('\n');
      const first = nl === -1 ? raw : raw.slice(0, nl);
      if (/ — /.test(first)) { head = first.replace(/^[^\n]*? — /, '').trim(); raw = raw.slice(first.length); }
      else if (/^(told the tenant|sent on whatsapp|copied|opened in|emailed tenant)/i.test(first)) raw = raw.slice(first.length);
      let lines = raw.replace(/\r/g, '').split('\n');
      lines = lines.filter(function (l) { return !/https?:\/\//.test(l) && !/check the progress|follow the progress/i.test(l); });
      while (lines.length && !lines[0].trim()) lines.shift();
      if (lines.length && /^(hi|dear|hello)\b[^\n]{0,60},\s*$/i.test(lines[0].trim())) lines.shift();
      const signOff = lines.findIndex(function (l) { return /^(thanks|thank you|kind regards|best regards|regards|many thanks)\b[,!.]?\s*$/i.test(l.trim()); });
      if (signOff !== -1) lines = lines.slice(0, signOff);
      let text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 1500);
      if (j.property_address) { text = text.split(j.property_address).join(pubAddr); head = head.split(j.property_address).join(pubAddr); }
      names.forEach(function (n) { const re = new RegExp('\\b' + reEsc(n) + '\\b', 'gi'); text = text.replace(re, 'our contractor'); head = head.replace(re, 'our contractor'); });
      text = text.replace(/\b(We’ve|We've) booked our contractor for/g, '$1 booked a contractor for').replace(/^our contractor/gm, 'Our contractor');
      head = head.replace(/\s*\[RR-\d+\]\s*/g, ' ').trim();
      text = text.replace(/^This is Residential Realtors\.\s*/i, '');
      if (!text && !head) return '';
      // The same message sent twice (WhatsApp and email, say) shows once.
      const key = (head + '|' + text).toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 160);
      if (seenMsg[key]) return '';
      seenMsg[key] = 1;
      return '<div class="msg"><div class="d">' + whenUk(x.created_at) + '</div>' + (head ? '<div class="h">' + htmlEsc(head) + '</div>' : '') + (text ? '<div class="b">' + htmlEsc(text) + '</div>' : '') + '</div>';
    }).join('');
    const st = j.landlord_handles && (j.status === 'New' || j.status === 'Assigned') ? 2 : stageOf(j.status), cancelled = j.status === 'Cancelled', held = j.status === 'On hold';
    const appt = !cancelled && j.status !== 'Completed' ? apptText(j) : '';
    const tone = cancelled || held ? 'grey' : st === 3 ? 'ok' : st === 1 ? 'amber' : 'blue';
    const ICONS = {
      inbox: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13l3.5 7v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z"/></svg>',
      tool: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L3 17.8V21h3.2l6.3-6.3a4 4 0 0 0 5.2-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/></svg>',
      cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="16" rx="3"/><path d="M16 3v3M8 3v3M3 10h18"/></svg>',
      check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
      pause: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M10 9v6M14 9v6"/></svg>'
    };
    const headline = cancelled ? 'This repair has been closed' : held ? 'On hold for now' : j.status === 'Completed' ? 'Repair completed' + (j.completed_at ? ' on ' + whenUk(j.completed_at) : '')
      : appt ? 'Booked for ' + appt : j.landlord_handles ? 'Your landlord is arranging this' : st === 2 ? 'Contractor arranged' : st === 1 ? 'Arranging a contractor' : 'Report received';
    const icon = cancelled || held ? ICONS.pause : st === 3 ? ICONS.check : appt || st === 2 ? ICONS.cal : st === 1 ? ICONS.tool : ICONS.inbox;
    const chipText = cancelled ? 'Closed' : held ? 'On hold' : j.status === 'Completed' ? 'Completed' : appt ? 'Booked' : j.landlord_handles ? 'Landlord arranging' : (PUBLIC_STATUS[j.status] || (st === 1 ? 'In progress' : 'Received'));
    const stepSub = [whenUk(j.created_at), st >= 1 ? (st === 1 ? 'In progress' : 'Done') : '', appt || (st >= 2 ? (st === 2 ? (j.landlord_handles ? 'Your landlord will be in touch' : 'The contractor will be in touch') : 'Done') : ''), j.completed_at && st === 3 ? whenUk(j.completed_at) : ''];
    const steps = STAGES.map(function (x, i) {
      const cls = cancelled ? 'todo' : i < st || st === 3 ? 'done' : i === st ? 'cur' : 'todo';
      return '<li class="' + cls + '"><span class="dot">' + (cls === 'done' ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' : '') + '</span>' +
        '<div><div class="t">' + x.label + '</div>' + (stepSub[i] ? '<div class="s">' + htmlEsc(stepSub[i]) + '</div>' : '') + '</div></li>';
    }).join('');
    const pin = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>';
    res.send(trackShell('Repair ' + refFor(j.id),
      '<div class="card hero">' +
        '<div class="hero-top"><span class="chip">' + refFor(j.id) + '</span><span class="chip ' + tone + '"><i></i>' + htmlEsc(chipText) + '</span></div>' +
        '<h1>' + htmlEsc(issueText(j) || 'Repair') + '</h1>' +
        '<div class="addr">' + pin + htmlEsc(pubAddr) + '</div>' +
        '<div class="now ' + tone + '"><span class="ic">' + icon + '</span><div><h2>' + htmlEsc(headline) + '</h2><p>' + htmlEsc(appt ? 'Please make sure someone can give access, or let us know if this time doesn’t suit.' : statusNote(j)) + '</p></div></div>' +
      '</div>' +
      '<div class="card"><div class="sec">Progress</div><ol class="tl">' + steps + '</ol></div>' +
      '<div class="card"><div class="sec">Details</div><div class="facts">' +
        '<div class="fact"><div class="k">Reference</div><div class="v">' + refFor(j.id) + '</div></div>' +
        '<div class="fact"><div class="k">Reported</div><div class="v">' + whenUk(j.created_at) + '</div></div>' +
        '<div class="fact"><div class="k">Priority</div><div class="v">' + htmlEsc(j.urgency || 'Routine') + (j.status !== 'Completed' && TARGET[j.urgency] ? '<div class="muted" style="font-weight:400;font-size:.78rem">Usually ' + TARGET[j.urgency] + '</div>' : '') + '</div></div>' +
        '<div class="fact"><div class="k">Last updated</div><div class="v">' + whenUk(j.updated_at) + '</div></div>' +
      '</div></div>' +
      (updates ? '<div class="card"><div class="sec">Updates from us</div>' + updates + '</div>' : '') +
      '<div class="card help"><div class="sec" style="margin:0">Need help?</div><p>Questions about this repair? Reply to our last message and quote <strong>' + refFor(j.id) + '</strong>.</p>' +
        '<div class="btns"><a class="btn2" href="/">Report another repair</a><a class="btn2 ghost" href="/track">Look up a repair</a></div></div>'));
  }));

  // ---------- Photo links for contractors ----------
  // Each job can have a long random link (/p/<token>) that shows its photos
  // without signing in, so they can be sent in a WhatsApp message or email.
  function baseUrl(req) {
    if (PUBLIC_URL) return PUBLIC_URL;
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    return proto + '://' + req.get('host');
  }
  app.post('/api/admin/photo-links', withDb(async function (p, req, res) {
    const ids = (Array.isArray((req.body || {}).job_ids) ? req.body.job_ids : []).map(function (x) { return parseInt(x, 10); }).filter(function (x) { return x > 0; }).slice(0, 100);
    const links = {};
    for (const id of ids) {
      const has = await p.query('SELECT photo_token, (SELECT count(*)::int FROM job_photos WHERE job_id = jobs.id) AS n FROM jobs WHERE id = $1', [id]);
      if (!has.rows.length || !has.rows[0].n) continue;
      let token = has.rows[0].photo_token;
      if (!token) {
        token = crypto.randomBytes(18).toString('base64url');
        await p.query('UPDATE jobs SET photo_token = $2 WHERE id = $1 AND photo_token IS NULL', [id, token]);
        token = (await p.query('SELECT photo_token FROM jobs WHERE id = $1', [id])).rows[0].photo_token;
      }
      links[id] = baseUrl(req) + '/p/' + token;
    }
    res.json({ ok: true, links: links });
  }));

  function htmlEsc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  // ---------- Parts ----------
  // Parts ordered for a job: what we paid and what we charge the landlord (added
  // to the job's charge, its profit and the landlord invoice).
  const PART_STATUSES = ['Ordered', 'Arrived', 'Fitted'];
  function partLine(pt) { return pt.description + (pt.supplier ? ' from ' + pt.supplier : '') + ' (cost ' + gbp(pt.cost) + ', charge to landlord ' + gbp(pt.charge) + ')'; }
  app.post('/api/admin/jobs/:id/parts', withDb(async function (p, req, res) {
    const id = jobId(req), b = req.body || {};
    const description = str(b.description, 300), cost = money(b.cost), charge = money(b.charge);
    if (!description) return res.status(400).json({ ok: false, error: 'description-required' });
    if (cost === undefined || charge === undefined) return res.status(400).json({ ok: false, error: 'bad-amount' });
    if (!(await p.query('SELECT id FROM jobs WHERE id = $1', [id])).rows.length) return res.status(404).json({ ok: false, error: 'not-found' });
    const status = PART_STATUSES.indexOf(b.status) !== -1 ? b.status : 'Ordered';
    const r = await p.query('INSERT INTO job_parts (job_id, description, supplier, cost, charge, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [id, description, str(b.supplier, 200), cost, charge, status]);
    await p.query('INSERT INTO job_updates (job_id, kind, body) VALUES ($1, $2, $3)', [id, 'change', 'Part added: ' + partLine(r.rows[0])]);
    await p.query('UPDATE jobs SET updated_at = now() WHERE id = $1', [id]);
    res.json({ ok: true, part: r.rows[0] });
  }));
  app.patch('/api/admin/parts/:id', withDb(async function (p, req, res) {
    const id = jobId(req), b = req.body || {};
    const cur = (await p.query('SELECT * FROM job_parts WHERE id = $1', [id])).rows[0];
    if (!cur) return res.status(404).json({ ok: false, error: 'not-found' });
    const next = {
      description: 'description' in b ? (str(b.description, 300) || cur.description) : cur.description,
      supplier: 'supplier' in b ? str(b.supplier, 200) : cur.supplier,
      cost: 'cost' in b ? money(b.cost) : cur.cost,
      charge: 'charge' in b ? money(b.charge) : cur.charge,
      status: 'status' in b ? (PART_STATUSES.indexOf(b.status) !== -1 ? b.status : undefined) : cur.status
    };
    if (next.cost === undefined || next.charge === undefined || next.status === undefined) return res.status(400).json({ ok: false, error: 'bad-value' });
    await p.query('UPDATE job_parts SET description = $2, supplier = $3, cost = $4, charge = $5, status = $6 WHERE id = $1',
      [id, next.description, next.supplier, next.cost, next.charge, next.status]);
    const note = next.status !== cur.status && Object.keys(b).length === 1 ? 'Part ' + next.status.toLowerCase() + ': ' + next.description : 'Part updated: ' + partLine(next);
    await p.query('INSERT INTO job_updates (job_id, kind, body) VALUES ($1, $2, $3)', [cur.job_id, 'change', note]);
    await p.query('UPDATE jobs SET updated_at = now() WHERE id = $1', [cur.job_id]);
    res.json({ ok: true });
  }));
  app.delete('/api/admin/parts/:id', withDb(async function (p, req, res) {
    const r = await p.query('DELETE FROM job_parts WHERE id = $1 RETURNING *', [jobId(req)]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'not-found' });
    await p.query('INSERT INTO job_updates (job_id, kind, body) VALUES ($1, $2, $3)', [r.rows[0].job_id, 'change', 'Part removed: ' + r.rows[0].description]);
    res.json({ ok: true });
  }));

  // One-line job summaries for contractor messages ("Kitchen sink overflowing –
  // check waste and washing machine drain"), written once by AI and kept.
  app.post('/api/admin/jobs/summaries', withDb(async function (p, req, res) {
    const ids = (Array.isArray((req.body || {}).ids) ? req.body.ids : []).map(function (x) { return parseInt(x, 10); }).filter(Boolean).slice(0, 25);
    if (!ids.length) return res.json({ ok: true, summaries: {} });
    const rows = (await p.query('SELECT id, category, affected, symptom, location, description, summary FROM jobs WHERE id = ANY($1)', [ids])).rows;
    const out = {};
    rows.forEach(function (r) { if (r.summary) out[r.id] = r.summary; });
    const todo = rows.filter(function (r) { return !r.summary; });
    if (!todo.length || !opts.askAi || !opts.canAi || !opts.canAi()) return res.json({ ok: true, summaries: out });
    const prompt = 'You write one-line job summaries for a UK letting agent to send to contractors.\n\n' +
      'For each repair job below, write ONE short line (ideally under 15 words) saying what needs doing, in plain UK English, e.g. ' +
      '"Kitchen sink overflowing – check waste pipe and washing machine drainage" or "Annual gas safety check (CP12)". ' +
      'If a job lists several separate tasks, keep every task, very briefly, separated by semicolons. ' +
      'Do not include names, phone numbers, addresses, dates, costs or the tenant\'s feelings. Do not invent anything.\n\n' +
      todo.map(function (r) {
        return '[' + r.id + '] ' + [r.category, r.affected, r.symptom].filter(Boolean).join(' – ') + (r.location ? ' (' + r.location + ')' : '') +
          (r.description ? '\n' + String(r.description).replace(/^Other tenants:.*$/im, '').slice(0, 1500) : '');
      }).join('\n\n') +
      '\n\nReply with ONLY JSON: {"summaries": {"<id>": "<one line>"}}';
    const result = await opts.askAi(prompt, true);
    if (result.ok) {
      let parsed = null;
      try { parsed = JSON.parse(result.text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()); } catch (e) { parsed = null; }
      const got = (parsed && parsed.summaries) || {};
      for (const r of todo) {
        const s = str(String(got[r.id] || '').replace(/\s+/g, ' ').replace(/^["']|["']$/g, ''), 200);
        if (!s) continue;
        out[r.id] = s;
        await p.query('UPDATE jobs SET summary = $2 WHERE id = $1', [r.id, s]);
      }
    }
    res.json({ ok: true, summaries: out });
  }));

  // Reports and invoices shared by WhatsApp: the PDF is kept behind a private,
  // unguessable link so it can go straight into the landlord's chat.
  app.post('/api/admin/shared-docs', withDb(async function (p, req, res) {
    const b = req.body || {};
    const buf = Buffer.from(String(b.pdf_base64 || ''), 'base64');
    if (buf.length < 100 || buf.length > 15 * 1024 * 1024 || buf.slice(0, 4).toString() !== '%PDF') return res.status(400).json({ ok: false, error: 'bad-pdf' });
    const name = (str(b.name, 150) || 'Document.pdf').replace(/[^\w .()-]+/g, '-').replace(/(\.pdf)?$/i, '.pdf');
    const jobIdN = parseInt(b.job_id, 10) || null;
    const token = crypto.randomBytes(18).toString('base64url');
    await p.query('INSERT INTO shared_docs (token, job_id, name, pdf) VALUES ($1, $2, $3, $4)', [token, jobIdN, name, buf]);
    res.json({ ok: true, path: '/d/' + token + '/' + encodeURIComponent(name) });
  }));
  app.get('/d/:token/:name?', withDb(async function (p, req, res) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const r = (await p.query('SELECT name, pdf FROM shared_docs WHERE token = $1', [String(req.params.token || '')])).rows[0];
    if (!r) return res.status(404).send('This link has expired or is not valid.');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="' + String(r.name || 'Document.pdf').replace(/"/g, '') + '"');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(r.pdf);
  }));

  app.get('/p/:token', withDb(async function (p, req, res) {
    const token = String(req.params.token || '');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (!/^[A-Za-z0-9_-]{20,}$/.test(token)) return res.status(404).send('Not found');
    const j = (await p.query('SELECT id, property_address, category, affected, symptom FROM jobs WHERE photo_token = $1 AND archived_at IS NULL', [token])).rows[0];
    if (!j) return res.status(404).send('This link is no longer available.');
    const ph = (await p.query('SELECT id, added_by FROM job_photos WHERE job_id = $1 ORDER BY id', [j.id])).rows;
    const issue = [j.category, j.affected, j.symptom].filter(Boolean).join(' – ');
    // Grouped: what the tenant reported, then the contractor's photos of the work, then any added by the office.
    const GROUPS = [['tenant', 'Reported by the tenant'], ['contractor', 'From the contractor — the work'], ['other', 'Added by Residential Realtors']];
    const groupOf = function (x) { return x.added_by === 'tenant' || x.added_by === 'contractor' ? x.added_by : 'other'; };
    const used = GROUPS.filter(function (g) { return ph.some(function (x) { return groupOf(x) === g[0]; }); });
    let n = 0;
    const gallery = used.map(function (g) {
      const list = ph.filter(function (x) { return groupOf(x) === g[0]; });
      return (used.length > 1 ? '<h2>' + g[1] + ' <span>' + list.length + '</span></h2>' : '') + '<main>' + list.map(function (x) {
        const u = '/p/' + token + '/' + x.id; n++;
        return '<a href="' + u + '" target="_blank" rel="noopener"><img loading="lazy" src="' + u + '" alt="Photo ' + n + '"></a>';
      }).join('') + '</main>';
    }).join('');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send('<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">' +
      '<title>Job photos ' + refFor(j.id) + '</title><style>body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f4f4f6;color:#0b0c0f}' +
      'header{padding:16px;background:#0e0f13;color:#fff}header .logo{display:inline-flex;margin-bottom:6px}header .logo img{height:32px;width:auto;display:block}h1{font-size:1rem;margin:6px 0 2px}p{margin:0;color:#b9bcc4;font-size:.85rem}' +
      'main{padding:12px;display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(260px,1fr))}a{display:block;border-radius:12px;overflow:hidden;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.1)}' +
      'img{display:block;width:100%;height:auto}h2{font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;color:#5b616e;margin:18px 12px 0}h2 span{color:#9a9ea8}</style></head><body><header><div class="logo"><img src="/logo-white.png" alt="Residential Realtors"></div><h1>' + refFor(j.id) + ' · ' + htmlEsc(j.property_address || '') + '</h1><p>' +
      htmlEsc(issue) + ' · ' + ph.length + ' photo' + (ph.length === 1 ? '' : 's') + ' — tap a photo to open it full size</p></header>' + gallery + '</body></html>');
  }));
  app.get('/p/:token/:photo', withDb(async function (p, req, res) {
    const token = String(req.params.token || '');
    if (!/^[A-Za-z0-9_-]{20,}$/.test(token)) return res.status(404).send('Not found');
    const r = await p.query(`SELECT ph.mime, ph.data FROM job_photos ph JOIN jobs j ON j.id = ph.job_id
      WHERE j.photo_token = $1 AND j.archived_at IS NULL AND ph.id = $2`, [token, parseInt(req.params.photo, 10) || 0]);
    if (!r.rows.length) return res.status(404).send('Not found');
    res.setHeader('Content-Type', r.rows[0].mime);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Robots-Tag', 'noindex');
    res.send(r.rows[0].data);
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

  // Correct a property's address on every job there (and on its landlord and
  // tenant links), e.g. to add a missing door number or postcode.
  app.post('/api/admin/properties/rename', withDb(async function (p, req, res) {
    const b = req.body || {};
    const to = tidyAddress(b.to);
    if (addressProblem(to)) return res.status(400).json({ ok: false, error: 'invalid-property_address' });
    if (!propKey(b.from)) return res.status(400).json({ ok: false, error: 'no-from' });
    const changed = await renameProperty(p, propKey(b.from), to);
    res.json({ ok: true, address: to, changed: changed });
  }));
  // Delete a property: its jobs go to the archive (restorable); its landlord and
  // tenant links, certificates, EPC checks and tenancies are removed. Tenants
  // and landlords themselves stay on file.
  app.delete('/api/admin/properties', withDb(async function (p, req, res) {
    const b = req.body || {}, key = propKey(str(b.address, 500));
    if (!key || b.confirm !== true) return res.status(400).json({ ok: false, error: 'bad-request' });
    const reason = 'Property deleted' + (str(b.reason, 300) ? ': ' + str(b.reason, 300) : '');
    const jobsHere = (await p.query('SELECT id, property_address FROM jobs WHERE property_address IS NOT NULL AND archived_at IS NULL')).rows
      .filter(function (r) { return propKey(r.property_address) === key; });
    for (const r of jobsHere) {
      await p.query('UPDATE jobs SET archived_at = now(), archived_reason = $2, updated_at = now() WHERE id = $1', [r.id, reason]);
      await p.query('INSERT INTO job_updates (job_id, kind, body) VALUES ($1, $2, $3)', [r.id, 'change', 'Job moved to the archive — ' + reason + '.']);
    }
    const n = {};
    for (const t of ['property_landlords', 'property_tenants', 'property_certificates', 'epc_checks', 'tenancies']) {
      n[t] = (await p.query('DELETE FROM ' + t + ' WHERE property_key = $1', [key])).rowCount;
    }
    console.log('Property deleted: ' + str(b.address, 500) + ' (' + jobsHere.length + ' jobs archived)');
    res.json({ ok: true, jobs_archived: jobsHere.length, removed: n });
  }));

  // Give a property a new address everywhere: its jobs (with a history note),
  // landlord and tenant links, certificates and EPC checks.
  async function renameProperty(p, fromKey, to) {
    const toKey = propKey(to);
    const rows = (await p.query('SELECT id, property_address FROM jobs WHERE property_address IS NOT NULL')).rows
      .filter(function (r) { return propKey(r.property_address) === fromKey && r.property_address !== to; });
    for (const r of rows) {
      await p.query('UPDATE jobs SET property_address = $1, updated_at = now() WHERE id = $2', [to, r.id]);
      await p.query('INSERT INTO job_updates (job_id, kind, body) VALUES ($1, $2, $3)', [r.id, 'change', 'Property: ' + r.property_address + ' → ' + to]);
    }
    if (toKey !== fromKey) {
      // Keep an existing link at the new address rather than clashing with it.
      await p.query('DELETE FROM property_landlords WHERE property_key = $1 AND EXISTS (SELECT 1 FROM property_landlords x WHERE x.property_key = $2)', [fromKey, toKey]);
      await p.query('DELETE FROM property_tenants t WHERE property_key = $1 AND EXISTS (SELECT 1 FROM property_tenants x WHERE x.tenant_id = t.tenant_id AND x.property_key = $2)', [fromKey, toKey]);
    }
    await p.query('UPDATE property_landlords SET property_key = $2, address = $3, updated_at = now() WHERE property_key = $1', [fromKey, toKey, to]);
    await p.query('UPDATE property_tenants SET property_key = $2, address = $3 WHERE property_key = $1', [fromKey, toKey, to]);
    if (toKey !== fromKey) await p.query('DELETE FROM property_certificates c WHERE property_key = $1 AND EXISTS (SELECT 1 FROM property_certificates x WHERE x.property_key = $2 AND x.type = c.type)', [fromKey, toKey]);
    await p.query('UPDATE property_certificates SET property_key = $2, address = $3, updated_at = now() WHERE property_key = $1', [fromKey, toKey, to]);
    if (toKey !== fromKey) {
      await p.query('DELETE FROM epc_checks WHERE property_key = $2 AND EXISTS (SELECT 1 FROM epc_checks x WHERE x.property_key = $1)', [fromKey, toKey]);
      await p.query('UPDATE epc_checks SET property_key = $2 WHERE property_key = $1', [fromKey, toKey]);
    }
    // Tenancies at the property move too (otherwise the property splits in two).
    await p.query(`UPDATE tenancies SET property_key = $2, address = $3, data = jsonb_set(data, '{address}', to_jsonb($3::text)), updated_at = now() WHERE property_key = $1`, [fromKey, toKey, to]);
    return rows.length;
  }
  // One-off repair: tenancies left behind by an address change before renames
  // included tenancies. A tenancy whose address has nothing else on file is
  // moved to the property with the same postcode and door number that does.
  async function relinkTenancies(p) {
    const done = (await p.query("SELECT 1 FROM app_settings WHERE key = 'tenancy_relink_v1'")).rows.length;
    if (done) return;
    const known = new Set((await p.query('SELECT property_key FROM property_landlords UNION SELECT property_key FROM property_certificates')).rows.map(function (r) { return r.property_key; }));
    const props = await allProperties(p);
    for (const t of (await p.query('SELECT id, property_key, address FROM tenancies')).rows) {
      if (!t.address || known.has(t.property_key)) continue;
      const pc = POSTCODE_RE.exec(t.address); if (!pc) continue;
      const code = (pc[1] + pc[2]).toUpperCase();
      const hits = props.filter(function (x) { const m = POSTCODE_RE.exec(x.address); return x.key !== t.property_key && known.has(x.key) && m && (m[1] + m[2]).toUpperCase() === code && sameHome(t.address, x.address); });
      if (hits.length !== 1) continue;
      await p.query(`UPDATE tenancies SET property_key = $2, address = $3, data = jsonb_set(data, '{address}', to_jsonb($3::text)), updated_at = now() WHERE id = $1`, [t.id, hits[0].key, hits[0].address]);
      console.log('Tenancy moved to its property: ' + t.address + ' → ' + hits[0].address);
    }
    await p.query(`INSERT INTO app_settings (key, value) VALUES ('tenancy_relink_v1', 'true') ON CONFLICT (key) DO NOTHING`);
  }
  setTimeout(function () { db().then(function (p) { return p && relinkTenancies(p); }).catch(function (err) { console.error('Tenancy relink failed:', err.message); }); }, 20 * 1000);

  // ---------- Certificates ----------
  // EPC (10 years), gas safety (12 months) and electrical safety / EICR (5 years)
  // for each property, with the contractor who renews each kind.
  const CERT_TYPES = {
    EPC: { name: 'EPC', years: 10, category: 'EPC', job: 'Energy Performance Certificate (EPC)', long: 'Energy Performance Certificate', trade: /epc|energy/i },
    Gas: { name: 'Gas safety certificate', years: 1, category: 'Gas safety', job: 'Annual gas safety check (CP12)', long: 'Gas safety certificate', trade: /gas/i },
    EICR: { name: 'Electrical safety certificate (EICR)', years: 5, category: 'EICR', job: 'Electrical safety check (EICR)', long: 'Electrical safety certificate (EICR)', trade: /eicr|electric/i }
  };
  const REMIND_DAYS = 10;
  // What each certificate costs us (the landlord charge varies, so it's left blank).
  const CERT_COST_DEFAULT = { Gas: 60, EICR: 70, EPC: 70 };
  async function certCosts(p) {
    const s = (await p.query("SELECT value FROM app_settings WHERE key = 'cert_costs'")).rows[0];
    return Object.assign({}, CERT_COST_DEFAULT, (s && s.value) || {});
  }
  // Which certificate a job is for, from its issue type / title.
  function certTypeOf(category, affected) {
    const t = String(category || '') + ' ' + String(affected || '');
    return /eicr|electrical (safety|installation)/i.test(t) ? 'EICR' : /gas safety|cp12/i.test(t) ? 'Gas' : /\bepc\b|energy performance/i.test(t) ? 'EPC' : null;
  }
  function isoDay(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && apptDay(v) ? String(v) : null; }
  // ---------- Tenancies ----------
  // A tenancy's details are kept as one JSON document (the admin page works out
  // the deposit, move-in monies and statements from them). Saving one also
  // records the landlord and tenants against the property.
  function cleanTenancy(b) {
    const s = function (v, n) { return str(v, n || 200); };
    const day = function (v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null; };
    const amt = function (v) { const m = money(v); return m === undefined ? null : m; };
    const person = function (x) { x = x || {}; return { name: s(x.name), email: s(x.email), phone: s(x.phone, 50), address: s(x.address, 500) }; };
    const l = b.landlord || {};
    return {
      address: s(b.address, 500), negotiator: s(b.negotiator), date_taken: day(b.date_taken),
      start_date: day(b.start_date), term_months: parseInt(b.term_months, 10) || null, break_months: parseInt(b.break_months, 10) || 0,
      rent_pcm: amt(b.rent_pcm), deposit: amt(b.deposit), holding: amt(b.holding), holding_date: day(b.holding_date), deposit_by: b.deposit_by === 'landlord' ? 'landlord' : 'agent', deposit_scheme: s(b.deposit_scheme), pay_ref: s(b.pay_ref, 40),
      move_in_due: day(b.move_in_due), so_start: day(b.so_start), so_payments: parseInt(b.so_payments, 10) || null,
      checkin_date: day(b.checkin_date), checkin_time: s(b.checkin_time, 20), checkin_type: b.checkin_type === 'diy' ? 'diy' : b.checkin_type === 'clerk' ? 'clerk' : null,
      tenants: (Array.isArray(b.tenants) ? b.tenants : []).slice(0, 12).map(person).filter(function (x) { return x.name || x.email || x.phone; }),
      guarantors: (Array.isArray(b.guarantors) ? b.guarantors : []).slice(0, 12).map(person).filter(function (x) { return x.name || x.email || x.phone; }),
      landlord: { name: s(l.name), email: s(l.email), phone: s(l.phone, 50), line1: s(l.line1, 300), line2: s(l.line2, 300), country: s(l.country, 100), postcode: s(l.postcode, 20) },
      service: s(b.service, 60) || 'Tenant Find', find_pct: amt(b.find_pct), find_basis: b.find_basis === 'upfront' ? 'upfront' : 'monthly',
      find_unit: b.find_unit === 'gbp' ? 'gbp' : 'pct', collect_unit: b.collect_unit === 'gbp' ? 'gbp' : 'pct', manage_unit: b.manage_unit === 'gbp' ? 'gbp' : 'pct', collect_pct: amt(b.collect_pct), manage_pct: amt(b.manage_pct),
      fees: (Array.isArray(b.fees) ? b.fees : []).slice(0, 30).map(function (f) { return { label: s(f && f.label, 200), amount: amt(f && f.amount) }; }).filter(function (f) { return f.label; }),
      vat: b.vat !== false, statement_date: day(b.statement_date), notes: s(b.notes, 4000),
      // Banking trail: extra move-in charges and each payment received.
      admin_fee: amt(b.admin_fee), card_fee: amt(b.card_fee), ll_charge: amt(b.ll_charge), other_costs: amt(b.other_costs),
      receipts: (Array.isArray(b.receipts) ? b.receipts : []).slice(0, 40).map(function (r) {
        r = r || {}; return { desc: s(r.desc, 200), date: day(r.date), receipt: s(r.receipt, 60), method: s(r.method, 30), amount: amt(r.amount) };
      }).filter(function (r) { return r.desc || r.date || r.amount != null; })
    };
  }
  async function linkTenancyPeople(p, d) {
    if (!d.address) return;
    const l = d.landlord;
    if (l.name) await ensureLandlord(p, { name: l.name, email: l.email, phone: l.phone, address: [l.line1, l.line2, l.country, l.postcode].filter(Boolean).join(', ') || null }, d.address);
    for (const t of d.tenants) await ensureTenant(p, { name: t.name, email: t.email, phone: t.phone }, d.address, true);
  }
  app.get('/api/admin/tenancies', withDb(async function (p, req, res) {
    const r = await p.query('SELECT id, property_key, address, start_date, data, log, created_at, updated_at FROM tenancies ORDER BY start_date DESC NULLS LAST, id DESC');
    res.json({ ok: true, tenancies: r.rows });
  }));
  app.post('/api/admin/tenancies', withDb(async function (p, req, res) {
    const d = cleanTenancy(req.body || {});
    if (!d.address) return res.status(400).json({ ok: false, error: 'address-required' });
    const r = await p.query(`INSERT INTO tenancies (property_key, address, start_date, data, log) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [propKey(d.address), d.address, d.start_date, JSON.stringify(d), JSON.stringify([{ at: new Date().toISOString(), text: 'Tenancy created' }])]);
    await linkTenancyPeople(p, d);
    res.json({ ok: true, id: r.rows[0].id });
  }));
  app.put('/api/admin/tenancies/:id', withDb(async function (p, req, res) {
    const d = cleanTenancy(req.body || {});
    if (!d.address) return res.status(400).json({ ok: false, error: 'address-required' });
    const r = await p.query('UPDATE tenancies SET property_key = $2, address = $3, start_date = $4, data = $5, updated_at = now() WHERE id = $1 RETURNING id',
      [jobId(req), propKey(d.address), d.address, d.start_date, JSON.stringify(d)]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'not-found' });
    await linkTenancyPeople(p, d);
    res.json({ ok: true, id: r.rows[0].id });
  }));
  app.delete('/api/admin/tenancies/:id', withDb(async function (p, req, res) {
    const r = await p.query('DELETE FROM tenancies WHERE id = $1 RETURNING id', [jobId(req)]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'not-found' });
    res.json({ ok: true });
  }));
  // Something done with a tenancy (emails sent, documents made), for its history.
  app.post('/api/admin/tenancies/:id/log', withDb(async function (p, req, res) {
    const text = str((req.body || {}).text, 500);
    if (!text) return res.status(400).json({ ok: false, error: 'empty' });
    const r = await p.query(`UPDATE tenancies SET log = log || $2::jsonb, updated_at = now() WHERE id = $1 RETURNING id`,
      [jobId(req), JSON.stringify([{ at: new Date().toISOString(), text: text }])]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'not-found' });
    res.json({ ok: true });
  }));
  // Email templates, bank details and signatures (defaults until edited).
  async function tenancyTemplates(p) {
    const row = (await p.query("SELECT value FROM app_settings WHERE key = 'tenancy_templates'")).rows[0];
    return Object.assign(tenancy.defaultTemplates(), row && row.value && typeof row.value === 'object' ? row.value : {});
  }
  async function agreementTemplate(p) {
    const row = (await p.query("SELECT value, updated_at FROM app_settings WHERE key = 'tenancy_agreement'")).rows[0];
    return row && row.value && row.value.data ? { name: row.value.name, data: row.value.data, updated_at: row.updated_at } : null;
  }
  app.get('/api/admin/tenancy-settings', withDb(async function (p, req, res) {
    const a = await agreementTemplate(p);
    let fields = [];
    if (a) { try { fields = tenancy.docxPlaceholders(Buffer.from(a.data, 'base64')); } catch (e) { fields = []; } }
    res.json({ ok: true, templates: await tenancyTemplates(p), defaults: tenancy.defaultTemplates(), agreement: a ? { name: a.name, updated_at: a.updated_at, fields: fields } : null });
  }));
  app.put('/api/admin/tenancy-settings', withDb(async function (p, req, res) {
    const b = req.body || {}, keep = {};
    ['tenant_subject', 'tenant_body', 'landlord_subject', 'landlord_body', 'cert_subject', 'cert_body', 'bank_details', 'signature_tenant', 'signature_landlord'].forEach(function (k) {
      if (typeof b[k] === 'string') keep[k] = b[k].slice(0, 30000);
    });
    if (Array.isArray(b.fee_presets)) keep.fee_presets = b.fee_presets.slice(0, 40).map(function (f) {
      const m = money(f && f.amount);
      return { label: str(f && f.label, 200), amount: m === undefined ? null : m };
    }).filter(function (f) { return f.label; });
    await p.query(`INSERT INTO app_settings (key, value) VALUES ('tenancy_templates', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`, [JSON.stringify(keep)]);
    res.json({ ok: true, templates: await tenancyTemplates(p) });
  }));
  // The tenancy agreement: a Word .docx with {{placeholders}}.
  app.put('/api/admin/tenancy-agreement', withDb(async function (p, req, res) {
    const b = req.body || {};
    const data = typeof b.data === 'string' ? b.data.replace(/^data:[^,]*,/, '') : '';
    if (!data || data.length > 20 * 1024 * 1024) return res.status(400).json({ ok: false, error: 'no-file' });
    let fields;
    try { fields = tenancy.docxPlaceholders(Buffer.from(data, 'base64')); } catch (e) { return res.status(400).json({ ok: false, error: 'not-a-docx' }); }
    await p.query(`INSERT INTO app_settings (key, value) VALUES ('tenancy_agreement', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`,
      [JSON.stringify({ name: str(b.name, 200) || 'Tenancy agreement.docx', data: data })]);
    res.json({ ok: true, fields: fields });
  }));
  // Fill in the agreement for a tenancy: Word, or PDF (LibreOffice on the server).
  // The admin page sends the worked-out wording (dates, amounts, names).
  async function makeAgreement(p, body) {
    const a = await agreementTemplate(p);
    if (!a) return { error: 'no-template' };
    const v = body.values || {}, s = function (x) { return x == null ? '' : String(x).slice(0, 2000); };
    const clean = { tenants: (Array.isArray(v.tenants) ? v.tenants : []).slice(0, 12).map(s), guarantors: (Array.isArray(v.guarantors) ? v.guarantors : []).slice(0, 12).map(s), values: {} };
    ['address', 'payment_reference', 'landlord', 'start', 'rent', 'deposit', 'deposit_scheme', 'first_rent', 'rent_day', 'second_rent', 'second_rent_month', 'agreement_date'].forEach(function (k) { clean[k] = s(v[k]); });
    Object.keys(v.values || {}).slice(0, 200).forEach(function (k) { clean.values[String(k).toLowerCase()] = s(v.values[k]); });
    const docx = tenancy.fillAgreement(Buffer.from(a.data, 'base64'), clean);
    if (body.format !== 'pdf') return { data: docx, type: 'docx' };
    return { data: await tenancy.docxToPdf(docx), type: 'pdf' };
  }
  app.post('/api/admin/tenancies/:id/agreement', withDb(async function (p, req, res) {
    let out;
    try { out = await makeAgreement(p, req.body || {}); }
    catch (e) { console.error('Tenancy agreement failed:', e.message); return res.status(500).json({ ok: false, error: (req.body || {}).format === 'pdf' ? 'pdf-failed' : 'bad-template' }); }
    if (out.error) return res.status(404).json({ ok: false, error: out.error });
    res.json({ ok: true, type: out.type, data: out.data.toString('base64') });
  }));
  // Send a welcome email (when email sending is set up), with PDFs attached.
  app.post('/api/admin/tenancies/:id/email', withDb(async function (p, req, res) {
    if (!canEmail()) return res.status(503).json({ ok: false, error: 'email-not-configured' });
    const b = req.body || {};
    const to = (Array.isArray(b.to) ? b.to : [b.to]).map(function (x) { return str(x, 200); }).filter(function (x) { return x && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x); }).slice(0, 12);
    const subject = str(b.subject, 300), text = str(b.body, 30000);
    if (!to.length) return res.status(400).json({ ok: false, error: 'bad-address' });
    if (!subject || !text) return res.status(400).json({ ok: false, error: 'empty' });
    const atts = (Array.isArray(b.attachments) ? b.attachments : []).slice(0, 6).map(function (a) {
      return { filename: (str(a && a.name, 150) || 'Document.pdf').replace(/[^a-zA-Z0-9.\-_ ]+/g, '-'), content: String(a && a.data || '').replace(/^data:[^,]*,/, '') };
    }).filter(function (a) { return a.content && a.content.length < 15 * 1024 * 1024; });
    const html = typeof b.html === 'string' && b.html.length < 300000 ? b.html.replace(/<script[\s\S]*?<\/script>/gi, '') : undefined;
    const sent = await sendEmail({ to: to, subject: subject, text: text, html: html, attachments: atts });
    if (!sent.ok) return res.status(502).json({ ok: false, error: 'send-failed' });
    await p.query(`UPDATE tenancies SET log = log || $2::jsonb, updated_at = now() WHERE id = $1`,
      [jobId(req), JSON.stringify([{ at: new Date().toISOString(), text: 'Emailed ' + to.join(', ') + ' — ' + subject + (atts.length ? ' (with ' + atts.map(function (a) { return a.filename; }).join(', ') + ')' : '') }])]);
    res.json({ ok: true });
  }));

  // Outlook drafts (Microsoft 365), see outlook.js.
  require('./outlook')(app, { db: db, withDb: withDb, str: str, publicUrl: PUBLIC_URL });

  app.get('/api/admin/certificates', withDb(async function (p, req, res) {
    const r = await p.query('SELECT id, property_key, address, type, issued_on, expires_on, reference, rating, notes, not_required, job_id, reminded_at, updated_at FROM property_certificates ORDER BY expires_on NULLS LAST');
    const s = (await p.query("SELECT value FROM app_settings WHERE key = 'cert_contractors'")).rows[0];
    res.json({ ok: true, certificates: r.rows, contractors: (s && s.value) || {}, costs: await certCosts(p), remind_days: REMIND_DAYS });
  }));
  app.put('/api/admin/certificates', withDb(async function (p, req, res) {
    const b = req.body || {};
    const key = propKey(b.address), type = CERT_TYPES[b.type] ? b.type : null;
    if (!key) return res.status(400).json({ ok: false, error: 'address-required' });
    if (!type) return res.status(400).json({ ok: false, error: 'bad-type' });
    const issued = b.issued_on ? isoDay(b.issued_on) : null, expires = b.expires_on ? isoDay(b.expires_on) : null;
    if ((b.issued_on && !issued) || (b.expires_on && !expires)) return res.status(400).json({ ok: false, error: 'bad-date' });
    const notRequired = !!b.not_required;
    if (!expires && !notRequired) return res.status(400).json({ ok: false, error: 'expiry-required' });
    const cur = (await p.query('SELECT id, expires_on, job_id FROM property_certificates WHERE property_key = $1 AND type = $2', [key, type])).rows[0];
    const renewed = !cur || cur.expires_on !== expires;
    const r = await p.query(`INSERT INTO property_certificates (property_key, address, type, issued_on, expires_on, reference, rating, notes, not_required)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (property_key, type) DO UPDATE SET address = excluded.address, issued_on = excluded.issued_on, expires_on = excluded.expires_on,
        reference = excluded.reference, rating = excluded.rating, notes = excluded.notes, not_required = excluded.not_required, updated_at = now()` +
        (renewed ? ', reminded_at = NULL, job_id = NULL' : '') + ' RETURNING id',
      [key, str(b.address, 500), type, notRequired ? null : issued, notRequired ? null : expires, str(b.reference, 100), str(b.rating, 5), str(b.notes, 1000), notRequired]);
    // Note it on the booked job, if there was one.
    if (cur && cur.job_id && renewed && expires) await p.query('INSERT INTO job_updates (job_id, kind, body) VALUES ($1, $2, $3)', [cur.job_id, 'note', CERT_TYPES[type].name + ' renewed — now expires ' + certDay(expires) + '.']);
    // An EPC picked from the register: use its exact address for the property.
    let renamedTo = null;
    if (type === 'EPC' && b.register_address) renamedTo = await adoptRegisterAddress(p, key, str(b.address, 500), b.register_address);
    // Already within 10 days? Raise the renewal job now rather than at the next check.
    if (expires && renewed) raiseCertificateJobs().catch(function (err) { console.error('Certificate jobs failed:', err.message); });
    res.json({ ok: true, id: r.rows[0].id, address: renamedTo });
  }));
  app.delete('/api/admin/certificates/:id', withDb(async function (p, req, res) {
    const r = await p.query('DELETE FROM property_certificates WHERE id = $1 RETURNING id', [jobId(req)]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'not-found' });
    res.json({ ok: true });
  }));
  // An open job already booked for this certificate at this property, if any.
  app.get('/api/admin/certificates/open-job', withDb(async function (p, req, res) {
    const type = CERT_TYPES[req.query.type] ? req.query.type : null;
    if (!type || !req.query.address) return res.status(400).json({ ok: false, error: 'bad-request' });
    const j = (await openCertJobs(p, type, String(req.query.address)))[0];
    const sent = j ? (await p.query("SELECT 1 FROM job_updates WHERE job_id = $1 AND kind = 'contractor_message' LIMIT 1", [j.id])).rows.length > 0 : false;
    res.json({ ok: true, job_id: j ? j.id : null, ref: j ? refFor(j.id) : null, sent: sent });
  }));
  // The job booked to renew a certificate.
  app.put('/api/admin/certificates/:id/job', withDb(async function (p, req, res) {
    const jid = parseInt((req.body || {}).job_id, 10) || null;
    const r = await p.query('UPDATE property_certificates SET job_id = $2, updated_at = now() WHERE id = $1 RETURNING id', [jobId(req), jid]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'not-found' });
    res.json({ ok: true });
  }));
  app.put('/api/admin/settings/cert-costs', withDb(async function (p, req, res) {
    const b = req.body || {}, v = {};
    for (const t of Object.keys(CERT_TYPES)) { if (t in b) { const m = money(b[t]); if (m === undefined) return res.status(400).json({ ok: false, error: 'bad-amount' }); if (m !== null) v[t] = m; } }
    await p.query(`INSERT INTO app_settings (key, value) VALUES ('cert_costs', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`, [JSON.stringify(v)]);
    res.json({ ok: true, costs: await certCosts(p) });
  }));
  app.put('/api/admin/settings/cert-contractors', withDb(async function (p, req, res) {
    const b = req.body || {}, v = {};
    Object.keys(CERT_TYPES).forEach(function (t) { if (str(b[t], 200)) v[t] = str(b[t], 200); });
    await p.query(`INSERT INTO app_settings (key, value) VALUES ('cert_contractors', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`, [JSON.stringify(v)]);
    res.json({ ok: true });
  }));
  // Look a postcode up on the government EPC register (find-energy-certificate.service.gov.uk):
  // each certificate's address, rating, "valid until" date and number.
  async function epcSearch(postcode) {
    const url = 'https://find-energy-certificate.service.gov.uk/find-a-certificate/search-by-postcode?lang=en&property_type=domestic&postcode=' + encodeURIComponent(postcode);
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Fixflow; Residential Realtors)', 'Accept': 'text/html' }, signal: AbortSignal.timeout(12000) });
    if (!r.ok) throw new Error('register-' + r.status);
    const html = await r.text();
    const clean = function (s) { return String(s || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim(); };
    const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
    const results = [];
    const re = /<a[^>]+href="(\/energy-certificate\/[\d-]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]+href="\/energy-certificate\/|<\/tbody>|$)/g;
    let x;
    while ((x = re.exec(html)) && results.length < 2000) {
      const rest = clean(x[3]);
      const d = /(\d{1,2}) (January|February|March|April|May|June|July|August|September|October|November|December) (\d{4})/i.exec(rest);
      const rating = /(?:^|\s)([A-G])(?:\s|$)/.exec(rest);
      results.push({
        address: clean(x[2]), link: 'https://find-energy-certificate.service.gov.uk' + x[1], reference: x[1].split('/').pop(),
        rating: rating ? rating[1] : '',
        expires_on: d ? d[3] + '-' + String(MONTHS[d[2].toLowerCase()]).padStart(2, '0') + '-' + String(d[1]).padStart(2, '0') : null,
        expired: /expired/i.test(rest)
      });
    }
    return { url: url, results: results };
  }
  app.get('/api/admin/epc-lookup', async function (req, res) {
    const m = POSTCODE_RE.exec(String(req.query.address || req.query.postcode || ''));
    if (!m) return res.status(400).json({ ok: false, error: 'postcode-required' });
    const pc = (m[1] + ' ' + m[2]).toUpperCase();
    try { const s = await epcSearch(pc); res.json({ ok: true, postcode: pc, url: s.url, results: s.results }); }
    catch (err) { res.json({ ok: false, error: 'register-unreachable', url: 'https://find-energy-certificate.service.gov.uk/find-a-certificate/search-by-postcode?lang=en&property_type=domestic&postcode=' + encodeURIComponent(pc) }); }
  });
  // The register entry for one of our properties: same door/flat number (first
  // number matching, all of ours present) and a street or building word in common.
  // The same flat is often written several ways over the years ("FLAT 52 ROWLAND
  // HILL HOUSE" / "52, Rowland Hill House"), so those count as one address. When
  // different addresses fit, the one sharing the most words wins; a tie is left alone.
  const EPC_STOP = ['flat', 'apartment', 'london', 'floor', 'ground', 'first', 'second', 'third', 'basement'];
  function epcNums(s) { return (String(s).replace(POSTCODE_RE, ' ').match(/\b\d+[a-z]?\b/gi) || []).map(function (x) { return x.toUpperCase(); }); }
  function epcWords(s) { return String(s).replace(POSTCODE_RE, ' ').toLowerCase().replace(/[^a-z ]+/g, ' ').split(/\s+/).filter(function (w) { return w.length >= 4 && EPC_STOP.indexOf(w) === -1; }); }
  // Building names in an address: "windsor court", "rowland hill house".
  function epcBuildings(s) {
    const t = String(s).replace(POSTCODE_RE, ' ').toLowerCase().replace(/[^a-z ]+/g, ' ').split(/\s+/).filter(Boolean), out = [];
    t.forEach(function (w, i) { if (EPC_BUILDING.indexOf(w) !== -1 && i > 0 && EPC_STOP.indexOf(t[i - 1]) === -1 && !/^\d/.test(t[i - 1])) out.push(t[i - 1] + ' ' + w); });
    return out;
  }
  function epcCandidates(address, results) {
    const an = epcNums(address), aw = epcWords(address), ab = epcBuildings(address);
    if (!an.length) return [];
    return results.filter(function (r) {
      const rn = epcNums(r.address), rw = epcWords(r.address);
      if (rn[0] !== an[0] || (aw.length && !rw.some(function (w) { return aw.indexOf(w) !== -1; }))) return false;
      if (an.every(function (n) { return rn.indexOf(n) !== -1; })) return true;
      // The register often leaves out the building's street number ("Flat 5,
      // Windsor Court, Coopers Road" for "Flat 5 Windsor Court 23 Coopers Road").
      // Allowed only when the building name matches too, so "5 Coopers Road"
      // (a different home) never stands in for "Flat 5, 23 Coopers Road".
      const low = String(r.address).toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ');
      return rn.every(function (n) { return an.indexOf(n) !== -1; }) && ab.some(function (b) { return low.indexOf(b) !== -1; });
    });
  }
  const EPC_BUILDING = ['house', 'court', 'apartments', 'mansions', 'lodge', 'tower', 'point', 'building', 'buildings', 'block', 'heights', 'wharf', 'gardens', 'place', 'lodge', 'hall'];
  function epcMatch(address, results) {
    const aw = epcWords(address);
    const cands = epcCandidates(address, results);
    if (!cands.length) return null;
    // One group per spelling; best is the one sharing most words with ours, then
    // with fewest extra words. Two different spellings equally good: left alone.
    const groups = {};
    cands.forEach(function (c) {
      const w = Array.from(new Set(epcWords(c.address))).sort(), k = w.join(' ');
      if (!groups[k]) groups[k] = { words: w, list: [], shared: w.filter(function (x) { return aw.indexOf(x) !== -1; }).length, extra: w.filter(function (x) { return aw.indexOf(x) === -1; }).length };
      groups[k].list.push(c);
    });
    const ranked = Object.keys(groups).map(function (k) { return groups[k]; }).sort(function (x, y) { return (y.shared - x.shared) || (x.extra - y.extra); });
    if (ranked.length > 1 && ranked[0].shared === ranked[1].shared && ranked[0].extra === ranked[1].extra) return null;
    // Other spellings of the same flat count too: shorter ones that keep the
    // building name, and — when ours names a building — longer ones.
    const top = ranked[0], pool = top.list.slice(), inside = function (xs, ys) { return xs.every(function (w) { return ys.indexOf(w) !== -1; }); };
    const building = aw.some(function (w) { return EPC_BUILDING.indexOf(w) !== -1; });
    ranked.slice(1).forEach(function (g) {
      if (!aw.length || g.words.indexOf(aw[0]) === -1) return;
      if (inside(g.words, top.words) || (building && inside(top.words, g.words))) pool.push.apply(pool, g.list);
    });
    return pool.filter(function (c) { return c.expires_on; }).sort(function (x, y) { return y.expires_on.localeCompare(x.expires_on); })[0] || null;
  }
  // The register writes addresses in capitals ("6 WHITWORTH HOUSE, FALMOUTH ROAD,
  // LONDON, SE1 6RW"); tidy them to "6 Whitworth House, Falmouth Road, London, SE1 6RW".
  function registerAddress(a) {
    return tidyAddress(String(a || '').replace(/\b([A-Z][A-Z'’-]{2,})\b/g, function (w) { return w.charAt(0) + w.slice(1).toLowerCase(); }));
  }
  // Swap the property's address for the register's exact one, when it's complete
  // and has the same door number.
  async function adoptRegisterAddress(p, key, current, regAddr) {
    const to = registerAddress(regAddr);
    if (!to || addressProblem(to) || to === current) return null;
    const first = function (s) { return ((String(s).replace(POSTCODE_RE, ' ').match(/\b\d+[a-z]?\b/i) || [''])[0]).toUpperCase(); };
    if (first(to) !== first(current)) return null;
    // Only when the register's spelling keeps every number of ours: never drop
    // part of the address (e.g. "23 Coopers Road" when the register just says
    // "Flat 5, Windsor Court").
    const nums = function (s) { return (String(s).replace(POSTCODE_RE, ' ').match(/\b\d+[a-z]?\b/gi) || []).map(function (x) { return x.toUpperCase(); }); };
    const tn = nums(to);
    if (!nums(current).every(function (n) { return tn.indexOf(n) !== -1; })) return null;
    await renameProperty(p, key, to);
    return to;
  }
  // A new report or job for a property we already know, written differently
  // ("6 Whitworth House, SE1 6RW" for "6 Whitworth House, Falmouth Road, London,
  // SE1 6RW"): same postcode, same door number(s) and a building/street word in
  // common. Returns the address on file, or the address as given.
  function sameHome(a, b) {
    const nums = function (s) { return (String(s).replace(POSTCODE_RE, ' ').match(/\b\d+[a-z]?\b/gi) || []).map(function (x) { return x.toUpperCase(); }); };
    const words = function (s) { return String(s).replace(POSTCODE_RE, ' ').toLowerCase().replace(/[^a-z ]+/g, ' ').split(/\s+/).filter(function (w) { return w.length >= 4 && EPC_STOP.indexOf(w) === -1; }); };
    const an = nums(a), bn = nums(b), aw = words(a), bw = words(b);
    if (!an.length || an[0] !== bn[0]) return false;
    const short = an.length <= bn.length ? an : bn, long = short === an ? bn : an;
    return short.every(function (n) { return long.indexOf(n) !== -1; }) && (!aw.length || !bw.length || aw.some(function (w) { return bw.indexOf(w) !== -1; }));
  }
  async function canonicalAddress(p, addr) {
    const a = str(addr, 500); const pc = a && POSTCODE_RE.exec(a);
    if (!pc) return a;
    const code = (pc[1] + pc[2]).toUpperCase(), key = propKey(a);
    const props = (await allProperties(p)).filter(function (x) { const m = POSTCODE_RE.exec(x.address); return m && (m[1] + m[2]).toUpperCase() === code; });
    if (props.some(function (x) { return x.key === key; })) return a;
    const hits = props.filter(function (x) { return sameHome(a, x.address); });
    return hits.length === 1 ? hits[0].address : a;
  }
  // Every property we know about, with the fullest version of its address.
  async function allProperties(p) {
    const rows = (await p.query(`SELECT property_address AS a FROM jobs WHERE property_address IS NOT NULL AND archived_at IS NULL
      UNION SELECT address FROM property_landlords WHERE address IS NOT NULL UNION SELECT address FROM property_certificates WHERE address IS NOT NULL`)).rows;
    const map = {};
    rows.forEach(function (r) {
      const k = propKey(r.a); if (!k) return;
      const cur = map[k], better = !cur || (POSTCODE_RE.test(r.a) && !POSTCODE_RE.test(cur)) || (POSTCODE_RE.test(r.a) === POSTCODE_RE.test(cur) && r.a.length > cur.length);
      if (better) map[k] = r.a;
    });
    return Object.keys(map).map(function (k) { return { key: k, address: map[k] }; });
  }
  // Fill in EPCs from the register. Properties without one are re-checked every
  // 30 days; ones expiring within 60 days (or expired) weekly, to catch a renewal.
  async function autoEpc(p, onlyAddress, limit) {
    const props = onlyAddress ? [{ key: propKey(onlyAddress), address: onlyAddress }] : await allProperties(p);
    const epc = {}, checked = {};
    (await p.query("SELECT property_key, expires_on FROM property_certificates WHERE type = 'EPC'")).rows.forEach(function (r) { epc[r.property_key] = r.expires_on; });
    const synced = {};
    (await p.query('SELECT property_key, checked_at, address_synced FROM epc_checks')).rows.forEach(function (r) { checked[r.property_key] = new Date(r.checked_at).getTime(); synced[r.property_key] = r.address_synced; });
    const now = Date.now(), soon = new Date(now + 60 * 86400000).toISOString().slice(0, 10), today = new Date(now).toISOString().slice(0, 10);
    const todo = props.filter(function (x) {
      if (!x.key || !POSTCODE_RE.test(x.address)) return false;
      if (onlyAddress) return true;
      const age = checked[x.key] ? now - checked[x.key] : Infinity;
      if (!epc[x.key]) return age > 30 * 86400000;
      if (!synced[x.key]) return true;   // once, to take the register's exact address
      if (epc[x.key] < today) return age > 86400000;   // expired: daily, to catch the new one
      return epc[x.key] <= soon && age > 7 * 86400000;
    });
    const cache = {}; let found = 0, done = 0, newAddress = null;
    for (const x of todo.slice(0, limit || 1000)) {
      const m = POSTCODE_RE.exec(x.address), pc = (m[1] + ' ' + m[2]).toUpperCase();
      try {
        if (!cache[pc]) { cache[pc] = (await epcSearch(pc)).results; await new Promise(function (r) { setTimeout(r, 1200); }); }
      } catch (err) { console.error('EPC register lookup failed for ' + pc + ':', err.message); break; }
      done += 1;
      const hit = epcMatch(x.address, cache[pc]);
      await p.query(`INSERT INTO epc_checks (property_key, checked_at, found, address_synced) VALUES ($1, now(), $2, true)
        ON CONFLICT (property_key) DO UPDATE SET checked_at = now(), found = excluded.found, address_synced = true`, [x.key, !!hit]);
      if (!hit) {
        const near = epcCandidates(x.address, cache[pc]).map(function (c) { return c.address + (c.expires_on ? ' (' + c.expires_on + ')' : ''); });
        console.log('EPC register: no clear match for ' + x.address + ' among ' + cache[pc].length + ' certificates at ' + pc + (near.length ? '; close: ' + near.slice(0, 5).join(' | ') : '; on the register: ' + Array.from(new Set(cache[pc].map(function (c) { return c.address; }))).slice(0, 15).join(' | ')));
        continue;
      }
      if (epc[x.key] && epc[x.key] >= hit.expires_on) {
        const renamedOnly = await adoptRegisterAddress(p, x.key, x.address, hit.address);
        if (renamedOnly) newAddress = renamedOnly;
        continue;
      }
      const renewed = epc[x.key] !== hit.expires_on;
      await p.query(`INSERT INTO property_certificates (property_key, address, type, expires_on, reference, rating, notes)
        VALUES ($1, $2, 'EPC', $3, $4, $5, 'From the EPC register')
        ON CONFLICT (property_key, type) DO UPDATE SET expires_on = excluded.expires_on, reference = excluded.reference, rating = excluded.rating,
          notes = excluded.notes, not_required = false, updated_at = now()` + (renewed ? ', reminded_at = NULL, job_id = NULL' : ''),
        [x.key, x.address, hit.expires_on, hit.reference, hit.rating]);
      found += 1;
      const renamed = await adoptRegisterAddress(p, x.key, x.address, hit.address);
      if (renamed) { newAddress = renamed; console.log('Address updated from the EPC register: ' + x.address + ' → ' + renamed); }
    }
    if (found) raiseCertificateJobs().catch(function () {});
    return { checked: done, found: found, remaining: Math.max(0, todo.length - done), address: newAddress };
  }
  // Tenant page address finder: every home at a postcode, from the public EPC
  // register (domestic), tidied. Cached for a day; limited per visitor.
  const pcCache = new Map(), pcHits = new Map();
  app.get('/api/address/postcode', async function (req, res) {
    const m = POSTCODE_RE.exec(String(req.query.postcode || ''));
    if (!m) return res.status(400).json({ ok: false, error: 'postcode-required' });
    const pc = (m[1] + ' ' + m[2]).toUpperCase();
    const now = Date.now(), hit = pcCache.get(pc);
    if (hit && now - hit.t < 24 * 3600 * 1000) return res.json({ ok: true, postcode: pc, addresses: hit.list });
    const e = pcHits.get(req.ip);
    if (!e || now - e.start > 10 * 60 * 1000) pcHits.set(req.ip, { start: now, n: 1 });
    else if (++e.n > 30) return res.status(429).json({ ok: false, error: 'rate-limited' });
    try {
      const seen = {}, list = [];
      (await epcSearch(pc)).results.forEach(function (r) {
        const a = registerAddress(r.address), k = a.toLowerCase();
        if (a && !seen[k]) { seen[k] = true; list.push(a); }
      });
      // Natural order: by the numbers in the address (flat, then building), then text.
      const key = function (a) { return (a.replace(POSTCODE_RE, ' ').match(/\d+/g) || []).map(function (n) { return n.padStart(6, '0'); }).join('.') + ' ' + a; };
      list.sort(function (a, b) { return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0; });
      if (pcCache.size > 2000) pcCache.clear();
      pcCache.set(pc, { t: now, list: list });
      res.json({ ok: true, postcode: pc, addresses: list });
    } catch (err) {
      res.json({ ok: false, error: 'unavailable' });
    }
  });

  app.post('/api/admin/epc-auto', withDb(async function (p, req, res) {
    const b = req.body || {};
    const r = await autoEpc(p, str(b.address, 500) || null, b.address ? 1 : 25);
    res.json(Object.assign({ ok: true }, r));
  }));
  let epcRunning = false;
  function autoEpcAll() {
    if (epcRunning) return; epcRunning = true;
    db().then(function (p) { return p ? autoEpc(p, null, 1000) : null; })
      .then(function (r) { if (r && (r.checked || r.found)) console.log('EPC register: checked ' + r.checked + ', filled in ' + r.found); })
      .catch(function (err) { console.error('EPC register check failed:', err.message); })
      .then(function () { epcRunning = false; });
  }
  // When the matching improves, look again at properties it couldn't place.
  const EPC_MATCH_VERSION = '4';
  setTimeout(function () {
    db().then(async function (p) {
      if (!p) return;
      const v = (await p.query("SELECT value FROM app_settings WHERE key = 'epc_match_version'")).rows[0];
      if (v && String(v.value).replace(/"/g, '') === EPC_MATCH_VERSION) return;
      await p.query(`DELETE FROM epc_checks c WHERE c.found = false OR EXISTS (SELECT 1 FROM property_certificates pc
        WHERE pc.property_key = c.property_key AND pc.type = 'EPC' AND pc.expires_on <= to_char(now() + interval '60 days', 'YYYY-MM-DD'))`);
      await p.query(`INSERT INTO app_settings (key, value) VALUES ('epc_match_version', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`, [JSON.stringify(EPC_MATCH_VERSION)]);
    }).catch(function (err) { console.error('EPC recheck reset failed:', err.message); });
  }, 60 * 1000);
  setTimeout(autoEpcAll, 2 * 60 * 1000);
  setInterval(autoEpcAll, 24 * 3600 * 1000).unref();
  // 10 days before a certificate expires (or once it has expired) with no open
  // job for it, raise the renewal job automatically — for the contractor who
  // renews that kind, with the tenant and landlord filled in — and send a phone
  // alert (ntfy). Checked a minute after start, then hourly, and whenever a
  // certificate is saved. Each certificate is handled once until it's renewed.
  function ntfy(body) {
    if (!NTFY_TOPIC || typeof fetch !== 'function') return Promise.resolve(false);
    return fetch(NTFY_SERVER, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ topic: NTFY_TOPIC }, body)), signal: AbortSignal.timeout(8000) })
      .then(function (r) { return r.ok; }).catch(function (err) { console.error('Phone alert failed:', err.message); return false; });
  }
  // Same home? Same tidied address, or same postcode (or one missing) with the
  // same door number(s) and a building/street word in common.
  function sameProperty(a, b) {
    if (!a || !b) return false;
    if (propKey(a) === propKey(b)) return true;
    const ma = POSTCODE_RE.exec(a), mb = POSTCODE_RE.exec(b);
    if (ma && mb && (ma[1] + ma[2]).toUpperCase() !== (mb[1] + mb[2]).toUpperCase()) return false;
    return sameHome(a, b);
  }
  // Open jobs for a certificate type at a property, oldest first.
  async function openCertJobs(p, type, address) {
    return (await p.query(`SELECT id, property_address, category, affected, status, created_at FROM jobs
      WHERE archived_at IS NULL AND status NOT IN ('Completed', 'Cancelled') ORDER BY created_at, id`)).rows
      .filter(function (x) { return certTypeOf(x.category, x.affected) === type && sameProperty(x.property_address, address); });
  }
  // One job per certificate: where a property has more than one open job for the
  // same certificate, keep the one already sent to the contractor (or the oldest)
  // and archive the extras that were never sent. Certificates are pointed at the
  // job that's kept.
  async function dedupeCertJobs(p) {
    const open = (await p.query(`SELECT j.id, j.property_address, j.category, j.affected, j.created_at, j.status,
        EXISTS (SELECT 1 FROM job_updates u WHERE u.job_id = j.id AND u.kind = 'contractor_message') AS sent,
        EXISTS (SELECT 1 FROM job_updates u WHERE u.job_id = j.id AND u.kind = 'created' AND u.body LIKE 'Job raised automatically%') AS auto
      FROM jobs j WHERE j.archived_at IS NULL AND j.status NOT IN ('Completed', 'Cancelled') ORDER BY j.created_at, j.id`)).rows
      .map(function (x) { x.type = certTypeOf(x.category, x.affected); return x; }).filter(function (x) { return x.type; });
    const groups = [];
    open.forEach(function (x) {
      const g = groups.filter(function (gr) { return gr.type === x.type && sameProperty(gr.jobs[0].property_address, x.property_address); })[0];
      if (g) g.jobs.push(x); else groups.push({ type: x.type, jobs: [x] });
    });
    let archived = 0;
    for (const g of groups) {
      if (g.jobs.length < 2) continue;
      // Keep the one furthest along (booked > awaiting parts > assigned > new),
      // then one already sent to the contractor, then one added by hand, then the oldest.
      const STAGE = { 'Contractor booked': 4, 'Awaiting parts': 3, 'On hold': 2, 'Assigned': 1, 'New': 0 };
      const keep = g.jobs.slice().sort(function (a, b) {
        return ((STAGE[b.status] || 0) - (STAGE[a.status] || 0)) || ((b.sent ? 1 : 0) - (a.sent ? 1 : 0)) || ((a.auto ? 1 : 0) - (b.auto ? 1 : 0)) || (new Date(a.created_at) - new Date(b.created_at));
      })[0];
      for (const x of g.jobs) {
        if (x.id === keep.id) continue;
        await p.query('UPDATE jobs SET archived_at = now(), archived_reason = $2, updated_at = now() WHERE id = $1', [x.id, 'Duplicate of ' + refFor(keep.id)]);
        await p.query('INSERT INTO job_updates (job_id, kind, body) VALUES ($1, $2, $3)', [x.id, 'change', 'Archived: duplicate of ' + refFor(keep.id) + ' (same ' + CERT_TYPES[g.type].name + ').' + (x.sent ? ' It had been sent to the contractor too — ' + refFor(keep.id) + ' is the job to use.' : '')]);
        await p.query('INSERT INTO job_updates (job_id, kind, body) VALUES ($1, $2, $3)', [keep.id, 'note', refFor(x.id) + ' was a duplicate of this job and has been archived.']);
        await p.query('UPDATE property_certificates SET job_id = $2 WHERE job_id = $1', [x.id, keep.id]);
        archived += 1;
      }
    }
    console.log('Duplicate check: ' + groups.filter(function (g) { return g.jobs.length > 1; }).length + ' set(s) found, ' + archived + ' job(s) archived');
    return archived;
  }
  // Certificate jobs are Urgent once the certificate has expired, otherwise Routine
  // (deadline: 5 days when urgent, else the expiry date).
  async function syncCertUrgency(p) {
    const today = new Date().toISOString().slice(0, 10);
    const rows = (await p.query(`SELECT c.type, c.expires_on, j.id, j.urgency, j.due_at FROM property_certificates c
      JOIN jobs j ON j.id = c.job_id AND j.archived_at IS NULL AND j.status NOT IN ('Completed', 'Cancelled')
      WHERE c.expires_on IS NOT NULL AND NOT c.not_required`)).rows;
    for (const r of rows) {
      const want = r.expires_on < today ? 'Urgent' : 'Routine';
      if (r.urgency === want) continue;
      const due = want === 'Urgent' ? new Date(Date.now() + DUE_HOURS.Urgent * 3600 * 1000) : new Date(r.expires_on + 'T17:00:00Z');
      await p.query('UPDATE jobs SET urgency = $2, due_at = $3, updated_at = now() WHERE id = $1', [r.id, want, due]);
      await p.query('INSERT INTO job_updates (job_id, kind, body) VALUES ($1, $2, $3)', [r.id, 'change',
        'Urgency: ' + r.urgency + ' → ' + want + (want === 'Urgent' ? ' (the ' + CERT_TYPES[r.type].name + ' has expired)' : ' (certificate still in date)')]);
    }
  }
  let raising = false;
  async function raiseCertificateJobs() {
    if (raising) return; raising = true;
    try {
      const p = await db(); if (!p) return;
      await dedupeCertJobs(p);
      await syncCertUrgency(p);
      const today = new Date().toISOString().slice(0, 10);
      const soon = new Date(Date.now() + REMIND_DAYS * 86400000).toISOString().slice(0, 10);
      const rows = (await p.query(`SELECT c.* FROM property_certificates c
        LEFT JOIN jobs j ON j.id = c.job_id AND j.archived_at IS NULL AND j.status NOT IN ('Completed', 'Cancelled')
        WHERE NOT c.not_required AND c.expires_on IS NOT NULL AND c.expires_on <= $1 AND c.reminded_at IS NULL AND j.id IS NULL`, [soon])).rows;
      if (!rows.length) return;
      const s = (await p.query("SELECT value FROM app_settings WHERE key = 'cert_contractors'")).rows[0];
      const who = (s && s.value) || {};
      const contractorsList = (await p.query('SELECT name, trade FROM contractors WHERE active ORDER BY id')).rows;
      for (const c of rows) {
        // Claim it first so it's never raised twice.
        const claim = await p.query('UPDATE property_certificates SET reminded_at = now() WHERE id = $1 AND reminded_at IS NULL RETURNING id', [c.id]);
        if (!claim.rows.length) continue;
        const def = CERT_TYPES[c.type], past = c.expires_on < today;
        // Already an open job for this certificate at this property? Use it — never book twice.
        const existing = (await openCertJobs(p, c.type, c.address))[0];
        if (existing) {
          await p.query('UPDATE property_certificates SET job_id = $2, updated_at = now() WHERE id = $1', [c.id, existing.id]);
          console.log('Linked ' + refFor(existing.id) + ' to the ' + def.name + ' at ' + c.address + ' (already booked)');
          continue;
        }
        const recent = (await p.query(`SELECT property_address, tenant_name, tenant_phone, tenant_email, key_permission, key_instructions, access_notes
          FROM jobs WHERE property_address IS NOT NULL ORDER BY created_at DESC LIMIT 2000`)).rows.filter(function (x) { return propKey(x.property_address) === c.property_key; });
        // Use a complete address (door number + postcode) from the certificate or an earlier job.
        const address = [c.address].concat(recent.map(function (x) { return x.property_address; })).filter(function (a) { return a && !addressProblem(tidyAddress(a)); })[0];
        if (!address) {
          await ntfy({ title: 'Can’t raise job: ' + def.name, message: String(c.address || '') + '\nExpires ' + certDay(c.expires_on) + '\nAdd the door number and postcode, then book it from Certificates.', priority: 4, tags: ['page_facing_up'], click: PUBLIC_URL ? PUBLIC_URL + '/admin#certs' : undefined });
          continue;
        }
        const assigned = who[c.type] || (contractorsList.filter(function (x) { return def.trade.test((x.trade || '') + ' ' + x.name); })[0] || {}).name || null;
        const tenant = (await p.query(`SELECT t.name, t.phone, t.email FROM property_tenants pt JOIN tenants t ON t.id = pt.tenant_id
          WHERE pt.property_key = $1 AND pt.moved_out_at IS NULL AND t.deleted_at IS NULL ORDER BY pt.created_at DESC LIMIT 1`, [c.property_key])).rows[0] || null;
        const last = recent.filter(function (x) { return x.tenant_name || x.tenant_phone; })[0] || {};
        const ll = (await p.query(`SELECT l.name, l.email, l.phone, l.address FROM property_landlords pl JOIN landlords l ON l.id = pl.landlord_id WHERE pl.property_key = $1`, [c.property_key])).rows[0] || null;
        const expiryAt = new Date(c.expires_on + 'T17:00:00Z');
        const due = expiryAt > new Date() ? expiryAt : new Date(Date.now() + DUE_HOURS.Urgent * 3600 * 1000);
        const cost = (await certCosts(p))[c.type];
        const r = await p.query(`INSERT INTO jobs (status, urgency, due_at, source, property_address, category, affected, description, assigned_to,
            tenant_name, tenant_phone, tenant_email, key_permission, key_instructions, access_notes, landlord_name, landlord_email, landlord_phone, landlord_address, estimated_cost)
          VALUES ($1, $2, $3, 'Other', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING id`,
          [assigned ? 'Assigned' : 'New', past ? 'Urgent' : 'Routine', due, tidyAddress(address), def.category, def.job,
            def.long + (past ? ' expired on ' : ' expires on ') + certDay(c.expires_on) + '. Please contact the tenant directly to arrange a time.', assigned,
            tenant ? tenant.name : last.tenant_name || null, tenant ? tenant.phone : last.tenant_phone || null, tenant ? tenant.email : last.tenant_email || null,
            last.key_permission || null, last.key_instructions || null, last.access_notes || null,
            ll ? ll.name : null, ll ? ll.email : null, ll ? ll.phone : null, ll ? ll.address : null, cost == null ? null : cost]);
        const id = r.rows[0].id;
        await p.query('INSERT INTO job_updates (job_id, kind, body) VALUES ($1, $2, $3)', [id, 'created',
          'Job raised automatically: ' + def.name + (past ? ' expired on ' : ' expires on ') + certDay(c.expires_on) + '.' + (assigned ? ' Assigned to ' + assigned + '.' : ' No contractor chosen for ' + def.name + ' yet.')]);
        await p.query('UPDATE property_certificates SET job_id = $2, updated_at = now() WHERE id = $1', [c.id, id]);
        console.log('Raised ' + refFor(id) + ' for ' + def.name + ' at ' + address);
        await ntfy({
          title: refFor(id) + ' raised: ' + def.name,
          message: String(address).replace(/\s+/g, ' ') + '\n' + (past ? 'Expired ' : 'Expires ') + certDay(c.expires_on) + '\n' + (assigned ? 'Assigned to ' + assigned + ' — open it to send them the job.' : 'No contractor chosen yet — open it to assign one.'),
          priority: past ? 5 : 4, tags: ['page_facing_up'], click: PUBLIC_URL ? PUBLIC_URL + '/admin#job=' + id : undefined
        });
      }
    } finally { raising = false; }
  }
  // Open certificate jobs raised before costs were set get the cost to us.
  setTimeout(function () {
    db().then(async function (p) {
      if (!p) return;
      const costs = await certCosts(p);
      const rows = (await p.query(`SELECT id, category, affected FROM jobs WHERE estimated_cost IS NULL AND actual_cost IS NULL AND archived_at IS NULL
        AND status NOT IN ('Completed', 'Cancelled')`)).rows;
      let n = 0;
      for (const r of rows) {
        const t = certTypeOf(r.category, r.affected);
        if (!t || costs[t] == null) continue;
        await p.query('UPDATE jobs SET estimated_cost = $2 WHERE id = $1 AND estimated_cost IS NULL', [r.id, costs[t]]);
        await p.query('INSERT INTO job_updates (job_id, kind, body) VALUES ($1, $2, $3)', [r.id, 'change', 'Estimated cost: none → ' + gbp(costs[t]) + ' (usual ' + CERT_TYPES[t].name + ' cost)']);
        n += 1;
      }
      if (n) console.log('Added the usual certificate cost to ' + n + ' open job(s)');
    }).catch(function (err) { console.error('Certificate cost backfill failed:', err.message); });
  }, 30 * 1000);
  setTimeout(function () { raiseCertificateJobs().catch(function (err) { console.error('Certificate jobs failed:', err.message); }); }, 60 * 1000);
  setInterval(function () { raiseCertificateJobs().catch(function (err) { console.error('Certificate jobs failed:', err.message); }); }, 3600 * 1000).unref();

  // ---------- Contractors ----------
  function cleanContractor(b) {
    const out = {};
    if ('name' in b) { out.name = str(b.name, 200); if (!out.name) return null; }
    ['trade', 'email', 'escalation_email'].forEach(function (f) { if (f in b) out[f] = str(b[f], 200); });
    if ('phone' in b) out.phone = str(b.phone, 50);
    if ('notes' in b) out.notes = str(b.notes, 1000);
    if ('active' in b) out.active = !!b.active;
    return out;
  }

  app.get('/api/admin/contractors', withDb(async function (p, req, res) {
    const r = await p.query('SELECT id, name, trade, phone, email, escalation_email, notes, active, portal_on, portal_token FROM contractors ORDER BY active DESC, lower(name)');
    res.json({ ok: true, contractors: r.rows });
  }));

  app.post('/api/admin/contractors', withDb(async function (p, req, res) {
    const c = cleanContractor(req.body || {});
    if (!c || !c.name) return res.status(400).json({ ok: false, error: 'name-required' });
    const r = await p.query('INSERT INTO contractors (name, trade, phone, email, escalation_email, notes) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [c.name, c.trade || null, c.phone || null, c.email || null, c.escalation_email || null, c.notes || null]);
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

  // ---------- Contractor job link ----------
  // A private link per contractor (turned on by staff): the jobs given to them,
  // with what they need to do the work (address, the problem, access, tenant
  // contact), and a button to mark each one completed. No costs or landlords.
  app.post('/api/admin/contractors/:id/portal', withDb(async function (p, req, res) {
    const b = req.body || {}, id = jobId(req);
    const cur = (await p.query('SELECT portal_token FROM contractors WHERE id = $1', [id])).rows[0];
    if (!cur) return res.status(404).json({ ok: false, error: 'not-found' });
    const token = !cur.portal_token || b.regenerate ? crypto.randomBytes(18).toString('base64url') : cur.portal_token;
    await p.query('UPDATE contractors SET portal_on = $2, portal_token = $3 WHERE id = $1', [id, b.on !== false, token]);
    res.json({ ok: true, on: b.on !== false, url: baseUrl(req) + '/c/' + token });
  }));
  async function portalContractor(p, token) {
    if (!/^[A-Za-z0-9_-]{20,}$/.test(String(token || ''))) return null;
    return (await p.query('SELECT id, name FROM contractors WHERE portal_token = $1 AND portal_on AND active', [token])).rows[0] || null;
  }
  const portalHits = new Map();
  function portalLimited(req) {
    const now = Date.now(), e = portalHits.get(req.ip);
    if (!e || now - e.start > 10 * 60 * 1000) { portalHits.set(req.ip, { start: now, n: 1 }); return false; }
    if (portalHits.size > 5000) portalHits.clear();
    return ++e.n > 300;
  }
  app.get('/api/c/:token/jobs', withDb(async function (p, req, res) {
    if (portalLimited(req)) return res.status(429).json({ ok: false, error: 'rate-limited' });
    const c = await portalContractor(p, req.params.token);
    if (!c) return res.status(404).json({ ok: false, error: 'not-found' });
    p.query("UPDATE contractors SET portal_seen_at = now() WHERE id = $1 AND (portal_seen_at IS NULL OR portal_seen_at < now() - interval '1 minute')", [c.id]).catch(function () {});
    const r = await p.query(`SELECT id, status, urgency, created_at, completed_at, category, affected, symptom, location, description, summary, property_address,
        tenant_name, tenant_phone, access_time, access_notes, key_permission, key_instructions, direct_contact, appointment_date, appointment_time, completion_notes
      FROM jobs WHERE archived_at IS NULL AND lower(trim(assigned_to)) = lower(trim($1))
        AND (status NOT IN ('Completed', 'Cancelled') OR (status = 'Completed' AND completed_at > now() - interval '30 days'))
      ORDER BY (status = 'Completed'), created_at DESC LIMIT 200`, [c.name]);
    res.json({ ok: true, name: c.name, jobs: r.rows.map(function (j) { j.ref = refFor(j.id); return j; }) });
  }));
  app.post('/api/c/:token/jobs/:id/complete', withDb(async function (p, req, res) {
    if (portalLimited(req)) return res.status(429).json({ ok: false, error: 'rate-limited' });
    const c = await portalContractor(p, req.params.token);
    if (!c) return res.status(404).json({ ok: false, error: 'not-found' });
    const b = req.body || {}, notes = str(b.notes, 3000), price = money(b.price), photos = decodePhotos(b.photos);
    if (price === undefined) return res.status(400).json({ ok: false, error: 'bad-price' });
    const r = await p.query(`UPDATE jobs SET status = 'Completed', completed_at = now(), updated_at = now(),
        completion_notes = coalesce($3, completion_notes), actual_cost = coalesce(actual_cost, $4)
      WHERE id = $1 AND archived_at IS NULL AND lower(trim(assigned_to)) = lower(trim($2)) AND status NOT IN ('Completed', 'Cancelled')
      RETURNING id, property_address`, [jobId(req), c.name, notes, price]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'not-found' });
    const ref = refFor(r.rows[0].id);
    if (photos.length) await insertPhotos(p, r.rows[0].id, photos, 'contractor');
    await p.query('INSERT INTO job_updates (job_id, kind, body) VALUES ($1, $2, $3)', [r.rows[0].id, 'completed',
      'Marked completed by ' + c.name + ' (contractor job link).' + (notes ? ' Notes: ' + notes.replace(/[.\s]*$/, '') + '.' : '') + (price != null ? ' Their price: ' + gbp(price) + '.' : '') +
      (photos.length ? ' ' + photos.length + ' photo' + (photos.length === 1 ? '' : 's') + ' added.' : '')]);
    ntfy({ title: 'Job completed: ' + ref, message: c.name + ' marked ' + ref + ' completed — ' + (r.rows[0].property_address || '') + '. Open the job in Fixflow to tell the tenant and landlord.', tags: ['white_check_mark'] }).catch(function () {});
    res.json({ ok: true });
  }));
  // The contractor says when they've booked the visit.
  app.post('/api/c/:token/jobs/:id/book', withDb(async function (p, req, res) {
    if (portalLimited(req)) return res.status(429).json({ ok: false, error: 'rate-limited' });
    const c = await portalContractor(p, req.params.token);
    if (!c) return res.status(404).json({ ok: false, error: 'not-found' });
    const b = req.body || {}, date = String(b.date || ''), time = str(b.time, 40), note = str(b.note, 1000);
    if (!apptDay(date)) return res.status(400).json({ ok: false, error: 'bad-date' });
    const r = await p.query(`UPDATE jobs SET appointment_date = $3, appointment_time = $4, updated_at = now(),
        status = CASE WHEN status IN ('New', 'Assigned') THEN 'Contractor booked' ELSE status END
      WHERE id = $1 AND archived_at IS NULL AND lower(trim(assigned_to)) = lower(trim($2)) AND status NOT IN ('Completed', 'Cancelled')
      RETURNING id, property_address`, [jobId(req), c.name, date, time]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'not-found' });
    const ref = refFor(r.rows[0].id), when = apptDay(date) + (time ? ', ' + time : '');
    await p.query('INSERT INTO job_updates (job_id, kind, body) VALUES ($1, $2, $3)', [r.rows[0].id, 'change',
      'Booked by ' + c.name + ' for ' + when + ' (contractor job link).' + (note ? ' Note: ' + note : '')]);
    ntfy({ title: 'Job booked: ' + ref, message: c.name + ' booked ' + ref + ' for ' + when + ' — ' + (r.rows[0].property_address || ''), tags: ['date'] }).catch(function () {});
    res.json({ ok: true, when: when });
  }));
  app.get('/c/:token', withDb(async function (p, req, res) {
    res.setHeader('X-Robots-Tag', 'noindex'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const c = await portalContractor(p, req.params.token);
    if (!c) return res.status(404).send(trackShell('Link not available', '<h1>Link not available</h1><p class="sub">This job link is no longer active. Please contact Residential Realtors.</p>', true));
    res.send(trackShell('Your jobs', '<h1>Hi ' + htmlEsc(c.name) + '</h1><p class="sub">Jobs from Residential Realtors. Tap a job for the details, and mark it completed when it’s done.</p>' +
      '<style>' +
        '.dt{margin-top:10px;border-top:1px solid #eee;padding-top:8px}.dt summary{cursor:pointer;font-weight:600;padding:6px 0;list-style:none}.dt summary::-webkit-details-marker{display:none}.dt summary:before{content:"▸ ";color:#888}.dt[open] summary:before{content:"▾ "}' +
        '.dbody{display:flex;flex-direction:column;gap:10px;margin-top:6px}.desc{white-space:pre-wrap;background:#f6f6f8;border-radius:12px;padding:10px 12px;font-size:.95rem}' +
        '.it{display:flex;gap:10px;align-items:flex-start}.it .ic{width:28px;text-align:center;font-size:1.1rem;flex:none}.lb{font-size:.78rem;color:#5b616e;text-transform:uppercase;letter-spacing:.03em}.vl{font-size:.98rem;word-break:break-word}' +
        '.tn{border:1px solid #e6e7eb;border-radius:14px;padding:12px}.acts{display:grid;grid-template-columns:1fr 1fr;gap:8px}.abtn{display:block;text-align:center;padding:12px;border-radius:12px;background:#0b0c0f;color:#fff;text-decoration:none;font-weight:600}.abtn.wa{background:#25D366;color:#fff}' +
        'details>summary{min-height:32px}' +
      '</style>' +
      '<div id="list"><p class="muted">Loading…</p></div>' +
      '<script>' + CONTRACTOR_PAGE_JS.replace('__TOKEN__', JSON.stringify(String(req.params.token))) + '</script>', true));
  }));

  // A job added by hand (phone call, email, inspection…). Uses the same cleaning
  // rules as editing. "Received" can be set to when the call actually came in,
  // and the deadline follows from it unless one is given.
  app.post('/api/admin/jobs', withDb(async function (p, req, res) {
    const body = req.body || {};
    const cols = [];
    const vals = [];
    const add = function (col, v) { cols.push(col); vals.push(v); };
    if (body.property_address) body.property_address = await canonicalAddress(p, body.property_address);
    // Never two open jobs for the same certificate at the same property.
    const certType = certTypeOf(body.category, body.affected);
    if (certType && body.property_address && !body.allow_duplicate) {
      const already = (await openCertJobs(p, certType, body.property_address))[0];
      if (already) return res.json({ ok: true, id: already.id, ref: refFor(already.id), existing: true });
    }
    const fields = ['tenant_name', 'tenant_email', 'tenant_phone', 'property_address', 'category', 'affected',
      'symptom', 'location', 'description', 'access_days', 'access_time', 'access_notes', 'key_permission',
      'key_instructions', 'direct_contact', 'assigned_to', 'next_steps', 'estimated_cost', 'landlord_charge',
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
    if (!('estimated_cost' in body) || body.estimated_cost === '' || body.estimated_cost == null) {
      const ct = certTypeOf(body.category, body.affected);
      if (ct) { const costs = await certCosts(p); if (costs[ct] != null) add('estimated_cost', costs[ct]); }
    }
    add('urgency', urgency); add('source', source); add('created_at', received); add('due_at', due); add('status', status);

    const r = await p.query('INSERT INTO jobs (' + cols.join(', ') + ') VALUES (' +
      cols.map(function (_, i) { return '$' + (i + 1); }).join(', ') + ') RETURNING id', vals);
    const id = r.rows[0].id;
    await p.query('INSERT INTO job_updates (job_id, kind, body) VALUES ($1, $2, $3)',
      [id, 'created', 'Job added by staff (' + source + ', ' + urgency + ').' +
        (str(body.assigned_to) ? ' Assigned to ' + str(body.assigned_to, 200) + '.' : '')]);
    if (str(body.landlord_name)) await ensureLandlord(p, body, body.property_address);
    await ensureTenant(p, body, body.property_address, true);
    res.json({ ok: true, id: id, ref: refFor(id) });
  }));

  app.post('/api/admin/jobs/:id/updates', withDb(async function (p, req, res) {
    const id = jobId(req);
    const text = str((req.body || {}).body, 5000);
    const kind = ['tenant_message', 'landlord_message', 'contractor_message', 'email'].indexOf((req.body || {}).kind) !== -1 ? req.body.kind : 'note';
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
