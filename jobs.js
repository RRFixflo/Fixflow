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
// The applicants' offer link, e.g. https://offers.residentialrealtors.co.uk (OFFER_ORIGIN setting).
const OFFER_ORIGIN = String(process.env.OFFER_ORIGIN || '').trim().replace(/\/+$/, '');
const INVOICE = {
  payee: process.env.INVOICE_PAYEE || '',
  sortCode: process.env.INVOICE_SORT_CODE || '',
  accountNumber: process.env.INVOICE_ACCOUNT_NUMBER || '',
  // For payments from abroad (optional).
  iban: process.env.INVOICE_IBAN || '',
  swift: process.env.INVOICE_SWIFT || '',
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
-- Notes from contractors: who wrote them, and when staff saw them.
ALTER TABLE job_updates ADD COLUMN IF NOT EXISTS author TEXT;
ALTER TABLE job_updates ADD COLUMN IF NOT EXISTS seen_at TIMESTAMPTZ;
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
-- A second contractor on the job, and which of the two has finished their part
-- first (the job completes when both have).
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS assigned_to_2 TEXT;
-- What the second contractor is doing (a different task on the same issue).
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS task_2 TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS part_done_by TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS part_done_at TIMESTAMPTZ;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS part_price NUMERIC(10,2);
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
ALTER TABLE landlords ADD COLUMN IF NOT EXISTS portal_token TEXT;
-- When their page link was last sent, and how.
ALTER TABLE landlords ADD COLUMN IF NOT EXISTS link_sent JSONB;
CREATE TABLE IF NOT EXISTS property_landlords (
  property_key TEXT PRIMARY KEY,
  address      TEXT,
  landlord_id  INTEGER NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Properties a landlord keeps on their page that we don't manage (their own records).
CREATE TABLE IF NOT EXISTS landlord_properties (
  id             SERIAL PRIMARY KEY,
  landlord_id    INTEGER NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  address        TEXT NOT NULL,
  data           JSONB NOT NULL DEFAULT '{}'::jsonb,
  epc            JSONB,
  epc_checked_at TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
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
-- An invoice for a tenancy (e.g. the renewal fee) rather than a repair job.
ALTER TABLE invoices ALTER COLUMN job_id DROP NOT NULL;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tenancy_id INTEGER;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS property_key TEXT;
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
-- Per-property details kept by the office: the number on the key tag, and notes
-- about the keys (how many, fobs, where they're kept).
CREATE TABLE IF NOT EXISTS property_info (
  property_key TEXT PRIMARY KEY,
  address      TEXT,
  key_number   TEXT,
  key_notes    TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE property_info ADD COLUMN IF NOT EXISTS licence JSONB;
CREATE TABLE IF NOT EXISTS licence_pool (
  id          SERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  address     TEXT NOT NULL,
  ref         TEXT,
  licence     JSONB NOT NULL,
  applied_key TEXT,
  applied_at  TIMESTAMPTZ
);
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
-- A property's licence document (the council's licence), when uploaded.
CREATE TABLE IF NOT EXISTS licence_docs (
  property_key TEXT PRIMARY KEY,
  name         TEXT,
  mime         TEXT,
  data         BYTEA NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Certificates a landlord uploads for a property of their own (not managed by us).
-- Offers from applicants (the online holding deposit / offer form), and each
-- tenant's ID documents. IDs are only ever shown to staff.
CREATE TABLE IF NOT EXISTS offers (
  id          SERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  property_address TEXT,
  property_key TEXT,
  lead_name   TEXT,
  lead_email  TEXT,
  lead_phone  TEXT,
  offer_pw    NUMERIC(10,2),
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  status      TEXT NOT NULL DEFAULT 'new',
  decided_at  TIMESTAMPTZ,
  paid_at     TIMESTAMPTZ,
  seen_at     TIMESTAMPTZ,
  log         JSONB NOT NULL DEFAULT '[]'::jsonb
);
-- A private link for the applicant to follow their offer.
ALTER TABLE offers ADD COLUMN IF NOT EXISTS track_token TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS offers_track_idx ON offers (track_token);
CREATE TABLE IF NOT EXISTS offer_docs (
  id         SERIAL PRIMARY KEY,
  offer_id   INTEGER NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  tenant_no  INTEGER NOT NULL,
  name       TEXT,
  mime       TEXT NOT NULL,
  data       BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS offer_docs_offer_idx ON offer_docs (offer_id, id);
CREATE TABLE IF NOT EXISTS landlord_property_docs (
  own_id     INTEGER NOT NULL,
  type       TEXT NOT NULL,
  name       TEXT,
  mime       TEXT,
  data       BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (own_id, type)
);
-- The certificate itself (PDF or photo), when uploaded.
CREATE TABLE IF NOT EXISTS certificate_docs (
  cert_id    INTEGER PRIMARY KEY REFERENCES property_certificates(id) ON DELETE CASCADE,
  name       TEXT,
  mime       TEXT,
  data       BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
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
-- Each 12-month anniversary: the rent review (new rent, or no increase), the
-- landlord and tenants asked/told, and whether the tenants are staying.
-- { "2027-09-24": { "new_rent": 1950, "rent_from": "2027-09-24", "asked_at": "...", "answer": "staying", "alerted_at": "..." } }
ALTER TABLE tenancies ADD COLUMN IF NOT EXISTS intention JSONB NOT NULL DEFAULT '{}'::jsonb;
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
-- Who a visit was, once known: from a report they sent, or a link we sent them.
ALTER TABLE site_sessions ADD COLUMN IF NOT EXISTS vid TEXT;
-- The visitor's internet (IP) address, as the connection arrived.
ALTER TABLE site_sessions ADD COLUMN IF NOT EXISTS ip TEXT;
ALTER TABLE site_sessions ADD COLUMN IF NOT EXISTS who TEXT;
ALTER TABLE site_sessions ADD COLUMN IF NOT EXISTS who_kind TEXT;
CREATE TABLE IF NOT EXISTS known_visitors (
  vid        TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  name       TEXT,
  detail     TEXT,
  job_id     INTEGER,
  first_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
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
-- 'offers' = a staff sign-in that can only use the Offers page; NULL = full access.
ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS role TEXT;
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
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS link_sent JSONB;
CREATE INDEX IF NOT EXISTS job_updates_created_idx ON job_updates (created_at);
`;

// ---------- Landlords and their properties ----------
// A property is identified by a tidied-up version of its address (postcode
// removed, case/punctuation ignored, Street -> st etc.). This must match
// propKey() in admin.html so both sides agree on which property is which.
const POSTCODE_RE = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i;
// Payment reference from an address: door number and building or road name, no
// spaces ("Flat 5, Dudley Court, Upper Berkeley Street" -> "5DudleyCourt"). Same
// rule as payRef in admin.html.
const REF_WORDS = /^(house|court|road|street|lane|avenue|close|place|way|gardens|terrace|mansions|apartments|lodge|tower|point|building|buildings|heights|square|crescent|drive|grove|walk|row|hill|mews|wharf|quay|parade|rise|green|park|view|yard|estate|block)$/i;
function addrPayRef(address) {
  const parts = String(address || '').replace(POSTCODE_RE, ' ').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const m = /(\d+[a-z]?(?:-\d+[a-z]?)*)/i.exec(parts[i]); if (!m) continue;
    let rest = parts[i].slice(m.index + m[0].length).replace(/^[\s,]+/, '');
    if (!rest.replace(/\b(flat|apartment|apt|unit|room|studio)\b/gi, '').trim()) rest = parts[i + 1] || '';
    const words = rest.split(/\s+/).filter(Boolean); let keep = words;
    if (words.length > 4) { keep = []; for (let w = 0; w < words.length; w++) { keep.push(words[w]); if (keep.length > 1 && REF_WORDS.test(words[w]) && !REF_WORDS.test(words[w + 1] || '')) break; } }
    if (keep.length > 2 && !keep.some(function (x) { return /\d/.test(x); }) && /^(road|rd|street|st|lane|ln|avenue|ave|close|way|drive|grove|place|terrace)$/i.test(keep[keep.length - 1])) keep = keep.slice(0, -1);
    return (m[1] + (/^\d/.test(keep[0] || '') ? '-' : '') + keep.join('')).replace(/[^A-Za-z0-9-]/g, '');
  }
  return (parts[0] || '').replace(/[^A-Za-z0-9-]/g, '');
}
const ADDR_WORDS = { street: 'st', road: 'rd', avenue: 'ave', lane: 'ln', drive: 'dr', close: 'cl', court: 'ct', place: 'pl', crescent: 'cres', gardens: 'gdns', apartment: 'flat', apt: 'flat' };
// Job addresses need at least a door number and a full postcode. The postcode
// is tidied to capitals with a single space (se16rw -> SE1 6RW).
// A booked visit: the day (YYYY-MM-DD) and a free-text time ("Morning", "10am").
// ---------- Calendar (.ics) ----------
// A booking's time as typed ("10am", "9-12", "2.30pm", "Morning", "anytime")
// becomes a start and end on the day; nothing clear means an all-day entry.
function apptWindow(date, time) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  if (!m) return null;
  const day = m[1] + m[2] + m[3];
  const t = String(time || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const hm = function (h, min, ap, hintPm) {
    h = parseInt(h, 10); min = parseInt(min || '0', 10);
    if (isNaN(h) || h > 23 || min > 59) return null;
    if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0;
    if (!ap && hintPm && h < 8) h += 12;          // "2" in "2-4" means 2pm
    return h * 60 + min;
  };
  const fmt = function (mins) { mins = Math.min(mins, 23 * 60 + 59); return day + 'T' + String(Math.floor(mins / 60)).padStart(2, '0') + String(mins % 60).padStart(2, '0') + '00'; };
  const named = { morning: [8, 12], am: [8, 12], afternoon: [12, 17], pm: [12, 17], evening: [17, 20], lunchtime: [12, 14], 'first thing': [8, 10] };
  const range = /(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\s*(?:-|–|—|to|till|until|and)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?/.exec(t);
  if (range) {
    const endAp = range[6], a = hm(range[1], range[2], range[3] || (endAp === 'pm' && parseInt(range[1], 10) < parseInt(range[4], 10) ? 'pm' : null), true), b = hm(range[4], range[5], endAp, true);
    if (a != null && b != null && b > a) return { allDay: false, start: fmt(a), end: fmt(b) };
  }
  const one = /(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?/.exec(t);
  if (one && (one[3] || one[2] || /^\d{1,2}$/.test(t) || /\b(at|from|around|approx)\b/.test(t))) {
    const a = hm(one[1], one[2], one[3], true);
    if (a != null) return { allDay: false, start: fmt(a), end: fmt(a + 60) };
  }
  for (const k of Object.keys(named)) if (new RegExp('\\b' + k + '\\b').test(t)) return { allDay: false, start: fmt(named[k][0] * 60), end: fmt(named[k][1] * 60) };
  const next = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + 1));
  return { allDay: true, start: day, end: next.toISOString().slice(0, 10).replace(/-/g, '') };
}
function icsText(v) { return String(v == null ? '' : v).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([;,])/g, '\\$1'); }
function icsFold(line) {
  const out = []; let s = line;
  while (Buffer.byteLength(s, 'utf8') > 74) { let n = 74; while (Buffer.byteLength(s.slice(0, n), 'utf8') > 74) n--; out.push(s.slice(0, n)); s = ' ' + s.slice(n); }
  out.push(s); return out.join('\r\n');
}
const ICS_LONDON = ['BEGIN:VTIMEZONE', 'TZID:Europe/London', 'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0000', 'TZOFFSETTO:+0100', 'TZNAME:BST', 'DTSTART:19700329T010000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0000', 'TZNAME:GMT', 'DTSTART:19701025T020000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD', 'END:VTIMEZONE'];
// A calendar file: name, and events {uid, window, summary, location, description, url, updated, cancelled}.
function icsCalendar(name, events) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Residential Realtors//Fixflow//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:' + icsText(name),
    'X-WR-TIMEZONE:Europe/London', 'REFRESH-INTERVAL;VALUE=DURATION:PT30M', 'X-PUBLISHED-TTL:PT30M'].concat(ICS_LONDON);
  events.forEach(function (e) {
    const w = e.window;
    lines.push('BEGIN:VEVENT', 'UID:' + e.uid, 'DTSTAMP:' + stamp,
      w.allDay ? 'DTSTART;VALUE=DATE:' + w.start : 'DTSTART;TZID=Europe/London:' + w.start,
      w.allDay ? 'DTEND;VALUE=DATE:' + w.end : 'DTEND;TZID=Europe/London:' + w.end,
      'SUMMARY:' + icsText(e.summary), 'LOCATION:' + icsText(e.location), 'DESCRIPTION:' + icsText(e.description));
    if (e.url) lines.push('URL:' + e.url);
    if (e.updated) lines.push('LAST-MODIFIED:' + new Date(e.updated).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'));
    lines.push('STATUS:' + (e.cancelled ? 'CANCELLED' : 'CONFIRMED'), 'TRANSP:OPAQUE');
    if (!w.allDay && !e.cancelled) lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsText(e.summary), 'TRIGGER:-PT1H', 'END:VALARM');
    lines.push('END:VEVENT');
  });
  lines.push('END:VCALENDAR');
  return lines.map(icsFold).join('\r\n') + '\r\n';
}
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
// A short form of an address for labels: "Flat 3 Chilham House" from the full one.
function shortAddrText(addr) {
  const a = String(addr || '').replace(POSTCODE_RE, ' ').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
  return a.length ? (a[0].length < 8 && a[1] ? a[0] + ' ' + a[1] : a[0]) : '';
}
function propKey(addr) {
  return String(addr || '').replace(POSTCODE_RE, ' ').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean)
    .map(function (w) { return ADDR_WORDS[w] || w; }).join(' ');
}

// Saves a landlord (matched to an existing one by id, name or email, whose
// details are topped up rather than wiped) and, given an address, records that
// the property is theirs. Returns the landlord id, or null without a name.
// A landlord is matched by email, phone, or name — titles ignored, and a
// shorter or fuller version of the same name ("Kuldip", "Mr K Singh",
// "Mr Kuldip Singh") counts — preferring the landlord already linked to the
// property. Details are topped up, never wiped; a fuller name replaces a
// shorter one.
function llWords(n) {
  return String(n || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9' -]+/g, ' ').split(/\s+/)
    .filter(function (x) { return x && ['mr', 'mrs', 'miss', 'ms', 'mx', 'dr', 'prof', 'and'].indexOf(x) === -1; });
}
// 2 = the same name (first and last name agree); 1 = compatible (one is a
// shorter form of the other: "Kuldip" / "K Singh" / "Kuldip Singh"); 0 = no.
function llNameMatch(a, b) {
  const A = llWords(a), B = llWords(b);
  if (!A.length || !B.length) return 0;
  if (A.join(' ') === B.join(' ') || (A.length > 1 && B.length > 1 && A[0] === B[0] && A[A.length - 1] === B[B.length - 1])) return 2;
  const S = A.length <= B.length ? A : B, L = S === A ? B : A;
  const same = function (x, y) { return x === y || (x.length === 1 && y[0] === x) || (y.length === 1 && x[0] === y); };
  if (S.length === 1) return S[0].length > 1 && S[0] === L[0] ? 1 : 0;   // a first name on its own
  if (!same(S[S.length - 1], L[L.length - 1]) || !same(S[0], L[0])) return 0;
  return 1;
}
async function findLandlord(p, name, email, phone, address) {
  const all = (await p.query('SELECT id, name, email, phone FROM landlords ORDER BY id')).rows;
  if (email) { const m = all.filter(function (x) { return x.email && x.email.toLowerCase() === email.toLowerCase(); }); if (m.length) return m[0].id; }
  const tail = phoneTail(phone);
  if (tail) { const m = all.filter(function (x) { return phoneTail(x.phone) === tail; }); if (m.length === 1) return m[0].id; }
  if (!name) return null;
  const key = propKey(address);
  if (key) {   // the landlord already on this property
    const cur = (await p.query('SELECT landlord_id FROM property_landlords WHERE property_key = $1', [key])).rows[0];
    const l = cur && all.filter(function (x) { return x.id === cur.landlord_id; })[0];
    if (l && llNameMatch(l.name, name)) return l.id;
  }
  const exact = all.filter(function (x) { return llNameMatch(x.name, name) === 2; });
  if (exact.length) return exact[0].id;
  const close = all.filter(function (x) { return llNameMatch(x.name, name) === 1; });
  return close.length === 1 ? close[0].id : null;
}
async function ensureLandlord(p, l, address) {
  const name = str(l.landlord_name || l.name, 200);
  if (!name) return null;
  const email = str(l.landlord_email || l.email, 200), phone = str(l.landlord_phone || l.phone, 50), addr = str(l.landlord_address || l.address, 500);
  let id = parseInt(l.landlord_id, 10) || null;
  if (!id) id = await findLandlord(p, name, email, phone, address);
  if (id) {
    const cur = (await p.query('SELECT name FROM landlords WHERE id = $1', [id])).rows[0];
    const fuller = cur && llWords(name).join(' ').length > llWords(cur.name).join(' ').length && llNameMatch(cur.name, name) ? name : null;
    await p.query(`UPDATE landlords SET name = coalesce($5, name), email = coalesce($2, email), phone = coalesce($3, phone), address = coalesce($4, address), updated_at = now() WHERE id = $1`,
      [id, email, phone, addr, fuller]);
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
// Landlords saved twice (same name ignoring titles, same email or same phone):
// merged into the older one, keeping every detail and property.
async function mergeDuplicateLandlords(p) {
  const all = (await p.query('SELECT id, name, email, phone, address, notes, portal_token FROM landlords ORDER BY id')).rows;
  const gone = new Set();
  for (let i = 0; i < all.length; i++) {
    const keep = all[i]; if (gone.has(keep.id)) continue;
    for (let j = i + 1; j < all.length; j++) {
      const d = all[j]; if (gone.has(d.id)) continue;
      const same = llNameMatch(keep.name, d.name) === 2 || (keep.email && d.email && keep.email.toLowerCase() === d.email.toLowerCase()) || (phoneTail(keep.phone) && phoneTail(keep.phone) === phoneTail(d.phone));
      if (!same) continue;
      const fuller = llWords(d.name).join(' ').length > llWords(keep.name).join(' ').length && llNameMatch(keep.name, d.name) ? d.name : keep.name;
      const notes = [keep.notes, d.notes].filter(Boolean).filter(function (v, k, a) { return a.indexOf(v) === k; }).join('\n') || null;
      await p.query('UPDATE property_landlords SET landlord_id = $1 WHERE landlord_id = $2', [keep.id, d.id]);
      await p.query(`UPDATE landlords SET name = $2, email = coalesce(email, $3), phone = coalesce(phone, $4), address = coalesce(address, $5), notes = $6, portal_token = coalesce(portal_token, $7), updated_at = now() WHERE id = $1`,
        [keep.id, fuller, d.email, d.phone, d.address, notes, d.portal_token]);
      await p.query('DELETE FROM landlords WHERE id = $1', [d.id]);
      keep.name = fuller; keep.email = keep.email || d.email; keep.phone = keep.phone || d.phone; keep.notes = notes;
      gone.add(d.id);
      console.log('Merged duplicate landlord ' + d.id + ' into ' + keep.id);
    }
  }
}

// ---------- Tenants ----------
// A tenant is matched by phone number (last 10 digits, so 07… and +44 7… agree),
// then email, then the same name at the same property. Details are topped up,
// never wiped, and the property is linked (a property can have many tenants).
function phoneTail(v) { const d = String(v || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : ''; }
const PLACEHOLDER_NAMES = ['', 'tenant', 'tenants', 'no name'];
// A name reduced to first + last name, without titles or punctuation, so
// "Miss Isobel May Parker", "isobel parker" and "Parker, Isobel" all match.
function nameKey(n) {
  let s = String(n || '').toLowerCase().replace(/[^a-z' -]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (/,/.test(String(n || ''))) { const parts = String(n).toLowerCase().split(','); if (parts.length === 2) s = (parts[1] + ' ' + parts[0]).replace(/[^a-z' -]+/g, ' ').replace(/\s+/g, ' ').trim(); }
  const w = s.split(' ').filter(function (x) { return x && ['mr', 'mrs', 'miss', 'ms', 'mx', 'dr', 'prof'].indexOf(x) === -1; });
  if (!w.length || PLACEHOLDER_NAMES.indexOf(w.join(' ')) !== -1) return '';
  return w.length === 1 ? w[0] : w[0] + ' ' + w[w.length - 1];
}
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
  // By name: someone at this property with the same name, or anyone anywhere
  // with the same name when there's only one of them and their phone/email
  // don't say it's someone else.
  const nk = nameKey(name);
  if (!row && nk) {
    const same = (await p.query(`SELECT t.id, t.name, t.phone, t.email, t.deleted_at,
        EXISTS (SELECT 1 FROM property_tenants pt WHERE pt.tenant_id = t.id AND pt.property_key = $1) AS here
      FROM tenants t WHERE t.deleted_at IS NULL`, [key || ''])).rows.filter(function (x) { return nameKey(x.name) === nk; });
    const fits = function (x) { return !(tail && phoneTail(x.phone) && phoneTail(x.phone) !== tail) && !(email && x.email && x.email.toLowerCase() !== email.toLowerCase()); };
    row = same.filter(function (x) { return x.here; })[0] || null;
    if (!row) { const ok = same.filter(fits); if (ok.length === 1) row = ok[0]; }
  }
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
// Tenants saved more than once (same phone number, same email, or the same
// name at the same property) are merged into the first record: contact
// details are filled in and every property link is kept.
async function mergeDuplicateTenants(p) {
  const rows = (await p.query('SELECT id, name, phone, email, notes FROM tenants WHERE deleted_at IS NULL ORDER BY id')).rows;
  const links = {};
  (await p.query('SELECT tenant_id, property_key FROM property_tenants')).rows.forEach(function (l) { (links[l.tenant_id] = links[l.tenant_id] || []).push(l.property_key); });
  const into = {}, root = function (id) { while (into[id]) id = into[id]; return id; };
  const byPhone = {}, byEmail = {}, byNameHere = {};
  const conflicts = function (a, b) {
    return (phoneTail(a.phone) && phoneTail(b.phone) && phoneTail(a.phone) !== phoneTail(b.phone)) ||
      (a.email && b.email && a.email.toLowerCase() !== b.email.toLowerCase());
  };
  const byId = {}; rows.forEach(function (r) { byId[r.id] = r; });
  let merged = 0;
  const join = function (keep, dup) {
    keep = root(keep); dup = root(dup);
    if (keep === dup) return;
    if (keep > dup) { const t = keep; keep = dup; dup = t; }
    into[dup] = keep; merged += 1;
    const k = byId[keep], d = byId[dup];
    if (PLACEHOLDER_NAMES.indexOf(String(k.name || '').trim().toLowerCase()) !== -1 || String(d.name || '').length > String(k.name || '').length && nameKey(d.name) === nameKey(k.name)) k.name = d.name || k.name;
    k.phone = k.phone || d.phone; k.email = k.email || d.email;
    if (d.notes && d.notes !== k.notes) k.notes = [k.notes, d.notes].filter(Boolean).join('\n');
  };
  rows.forEach(function (r) {
    const t = phoneTail(r.phone), e = String(r.email || '').toLowerCase();
    if (t) { if (byPhone[t]) join(byPhone[t], r.id); else byPhone[t] = r.id; }
    if (e) { if (byEmail[e] && !conflicts(byId[root(byEmail[e])], r)) join(byEmail[e], r.id); else if (!byEmail[e]) byEmail[e] = r.id; }
    const nk = nameKey(r.name);
    if (nk) (links[r.id] || []).forEach(function (pk) {
      const k = nk + '|' + pk;
      if (byNameHere[k] && !conflicts(byId[root(byNameHere[k])], r)) join(byNameHere[k], r.id); else if (!byNameHere[k]) byNameHere[k] = r.id;
    });
  });
  for (const dupId of Object.keys(into)) {
    const keep = root(Number(dupId)), k = byId[keep];
    await p.query(`INSERT INTO property_tenants (tenant_id, property_key, address, moved_out_at, created_at)
      SELECT $1, property_key, address, moved_out_at, created_at FROM property_tenants WHERE tenant_id = $2 ON CONFLICT (tenant_id, property_key) DO NOTHING`, [keep, Number(dupId)]);
    await p.query('DELETE FROM tenants WHERE id = $1', [Number(dupId)]);
    await p.query('UPDATE tenants SET name = $2, phone = $3, email = $4, notes = $5, updated_at = now() WHERE id = $1', [keep, k.name, k.phone, k.email, k.notes]);
  }
  if (merged) console.log('Tenants: merged ' + merged + ' duplicate record(s)');
  return merged;
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
  access_time, access_notes, key_permission, key_instructions, direct_contact, summary, appointment_date, appointment_time, assigned_to, assigned_to_2, task_2, part_done_by, next_steps,
  estimated_cost, actual_cost, landlord_charge, completed_at, completion_notes, photo_count, source,
  archived_at, archived_reason, (SELECT count(*)::int FROM job_photos ph WHERE ph.job_id = jobs.id) AS photos_saved,
  (SELECT array_agg(ph.id ORDER BY ph.id) FROM job_photos ph WHERE ph.job_id = jobs.id) AS photo_ids,
  (SELECT count(*)::int FROM job_updates u WHERE u.job_id = jobs.id AND u.kind = 'contractor_note' AND u.seen_at IS NULL) AS unread_notes,
  (SELECT u.body FROM job_updates u WHERE u.job_id = jobs.id AND u.kind = 'contractor_note' AND u.seen_at IS NULL ORDER BY u.id DESC LIMIT 1) AS last_note,
  (SELECT coalesce(sum(jp.cost), 0) FROM job_parts jp WHERE jp.job_id = jobs.id) AS parts_cost,
  (SELECT coalesce(sum(jp.charge), 0) FROM job_parts jp WHERE jp.job_id = jobs.id) AS parts_charge,
  (SELECT count(*)::int FROM job_parts jp WHERE jp.job_id = jobs.id) AS parts_count,
  landlord_name, landlord_email, landlord_phone, landlord_address, invoice_number, invoiced_at, invoice_total, contractor_paid_at, landlord_handles, landlord_contractor`;

function str(v, max) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max || 500) : null;
}

// Certificate dates written as lines, e.g. "gas safety expiry: 30/03/2026",
// "EICR expires 7/6/24", "EPC done 3 March 2025". UK day/month/year; 2-digit
// years are 20xx. The rest of the text (other lines) is taken as the property.
const CERT_LINE_MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
function ukDateIso(t) {
  let m = /\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2}|\d{4})\b/.exec(t), d, mo, y;
  if (m) { d = +m[1]; mo = +m[2]; y = +m[3]; }
  else if ((m = /\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?,?\s+(\d{2}|\d{4})\b/i.exec(t)) && CERT_LINE_MONTHS[m[2].toLowerCase().slice(0, m[2].toLowerCase().startsWith('sept') ? 4 : 3)]) { d = +m[1]; mo = CERT_LINE_MONTHS[m[2].toLowerCase().slice(0, m[2].toLowerCase().startsWith('sept') ? 4 : 3)]; y = +m[3]; }
  else return '';
  if (y < 100) y += 2000;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCDate() === d && dt.getUTCMonth() === mo - 1 ? dt.toISOString().slice(0, 10) : '';
}
function certLines(text) {
  const out = [], rest = [];
  String(text || '').split(/\r?\n|;/).forEach(function (line) {
    const l = line.trim(); if (!l) return;
    const t = /\b(gas(?:\s+safety)?(?:\s+cert(?:ificate)?)?|cp12|lgsr|eicr|electrical(?:\s+(?:safety|installation))?(?:\s+cert(?:ificate)?)?|epc|energy\s+performance(?:\s+cert(?:ificate)?)?)\b/i.exec(l);
    const iso = t ? ukDateIso(l) : '';
    if (!t || !iso) { rest.push(l); return; }
    const type = /gas|cp12|lgsr/i.test(t[1]) ? 'Gas' : /epc|energy/i.test(t[1]) ? 'EPC' : 'EICR';
    const done = /\b(done|issued|carried out|completed|dated|valid from|start(?:s|ed|ing)?|from)\b/i.test(l) && !/\b(expir\w*|exp|due|until|renew\w*|valid (?:until|to))\b/i.test(l);
    // What's left of the line after the certificate and date may be the address.
    const left = l.replace(t[0], ' ').replace(/\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2}|\d{4})\b|\b\d{1,2}(?:st|nd|rd|th)?\s+[a-z]{3,9}\.?,?\s+\d{2,4}\b/i, ' ')
      .replace(/\b(expir\w*|exp|due|until|renew\w*|valid|to|from|done|issued|on|at|for|cert(?:ificate)?|date|starts?|started|starting|dated|is|was|the)\b|[:\-–]/gi, ' ').replace(/\s+/g, ' ').trim().replace(/^(please\s+)?(add|update|record|save)\s+(an?\s+)?/i, '');
    out.push({ type: type, issued_on: done ? iso : '', expires_on: done ? '' : iso, address: left.length > 6 && /\d/.test(left) ? left : '' });
  });
  const addr = rest.join(', ').replace(/^(please\s+)?(add|update|record|save)\b[^,]*?(for|at)\s+/i, '').trim();
  out.forEach(function (c) { if (!c.address) c.address = addr; });
  return out;
}
// "£1,650.00 per calendar month" → 1650; "£380 pw" → 1646.67; "£19,800 per annum" → 1650.
function rentFromText(t) {
  const m = /£\s*([\d,]+(?:\.\d{1,2})?)/.exec(String(t || '')) || /\b([\d,]{3,}(?:\.\d{1,2})?)\b/.exec(String(t || ''));
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, '')); if (!isFinite(n) || n <= 0) return null;
  const after = String(t).slice(m.index).toLowerCase();
  const r = function (v) { return Math.round(v * 100) / 100; };
  if (/\b(p\.?\s?w|per\s+week|a\s+week|weekly|\/\s*w(?:ee)?k)\b/.test(after)) return r(n * 52 / 12);
  if (/\b(p\.?\s?a|per\s+(?:annum|year)|a\s+year|annual(?:ly)?|yearly|\/\s*y(?:ea)?r)\b/.test(after)) return r(n / 12);
  return r(n);
}
// A quick sanity check: a holding deposit is usually 1 week's rent and the
// deposit 5 (or 6) weeks'. Far off either suggests the rent was misread.
function rentCheck(rent, deposit, holding) {
  if (!rent) return '';
  const week = rent * 12 / 52, off = function (v, w) { return Math.abs(v - w) > Math.max(2, w * 0.05); };
  const depOk = deposit && (!off(deposit, week * 5) || !off(deposit, week * 6));
  if (depOk) return '';   // the deposit fits the rent: it's right
  const fromHold = holding ? Math.round(holding * 52 / 12 * 100) / 100 : 0, fromDep = deposit ? Math.round(deposit / 5 * 52 / 12 * 100) / 100 : 0;
  if (fromHold && off(holding, week) && (!fromDep || Math.abs(fromHold - fromDep) <= fromDep * 0.05))
    return 'The holding deposit (£' + holding.toFixed(2) + ') is usually one week’s rent, which would make the rent about £' + fromHold.toFixed(2) + ' a month' + (fromDep ? ' (the deposit agrees)' : '') + ' — please check the rent.';
  if (fromDep && deposit >= 100 && (!holding || off(holding, week)))
    return 'The deposit (£' + deposit.toFixed(2) + ') is usually five weeks’ rent, which would make the rent about £' + fromDep.toFixed(2) + ' a month — please check the rent.';
  return '';
}
// An address naming only a building (no flat / door number), e.g. a licence for
// "Brunlees House, Rockingham Estate, SE1 6QF": the one property on file in that
// building (same postcode, building name in its address), else as given.
function oneInBuilding(address, known) {
  const a = String(address || '');
  if (!a || doorNumKey(a)) return a;
  const pcOf = function (s) { const m = POSTCODE_RE.exec(String(s || '')); return m ? (m[1] + m[2]).toUpperCase() : ''; }, pc = pcOf(a);
  const STOP = ['flat', 'house', 'road', 'street', 'court', 'london', 'the', 'and', 'apartment', 'estate', 'terrace', 'block', 'building', 'tower', 'mansions', 'lane', 'avenue', 'close', 'place', 'gardens', 'square'];
  const lead = String(a.split(',')[0]).toLowerCase().replace(/[^a-z ]+/g, ' ').split(/\s+/).filter(function (w) { return w.length >= 4 && STOP.indexOf(w) === -1; });
  if (!lead.length) return a;
  const hits = (known || []).filter(function (k) { const kl = String(k).toLowerCase(), kpc = pcOf(k); return (!pc || !kpc || pc === kpc) && lead.every(function (w) { return kl.indexOf(w) !== -1; }); });
  return hits.length === 1 ? hits[0] : a;
}
// The door / flat numbers in an address (not the postcode): "Flat 2, 23 John
// Maurice Close, SE17 1PZ" → ["2", "23"].
function doorNumKey(a) { return (String(a || '').replace(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/gi, ' ').match(/\b\d+[a-z]?\b/gi) || []).map(function (x) { return x.toUpperCase(); }).sort().join(','); }
// An address matched to one on file keeps the numbers as written: if the match
// changed a door or flat number, it's a different property — use what was written.
function keepWrittenAddress(chosen, written) {
  const w = String(written || '').trim(); if (!w) return chosen;
  const wn = doorNumKey(w); if (!wn) return chosen;
  return doorNumKey(chosen) === wn ? chosen : w;
}
function money(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(/[£,\s]/g, ''));
  if (!isFinite(n) || n < 0 || n > 10000000) return undefined; // undefined = invalid
  return Math.round(n * 100) / 100;
}

// Photos arrive as data URLs from the browser. Only real images are kept, each
// under 12 MB (the tenant page shrinks them to a few hundred KB first). iPhone
// HEIC photos are accepted and turned into JPEGs before saving, so every
// browser (and the PDF) can show them.
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif'];
const MAX_PHOTOS_PER_UPLOAD = 30;
function decodePhotos(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const ph of list.slice(0, MAX_PHOTOS_PER_UPLOAD)) {
    const m = /^data:([a-z]*\/?[a-z0-9.+-]*);base64,([A-Za-z0-9+/=]+)$/i.exec(String((ph && ph.dataUrl) || ''));
    if (!m) continue;
    let mime = m[1].toLowerCase();
    const buf = Buffer.from(m[2], 'base64');
    // Some browsers don't label HEIC files: tell by the name or the file itself ("ftypheic").
    if (PHOTO_TYPES.indexOf(mime) === -1 && (/\.hei[cf]$/i.test(String(ph.name || '')) || /^ftyp(hei|hev|mif1|msf1)/.test(buf.slice(4, 12).toString('latin1')))) mime = 'image/heic';
    if (PHOTO_TYPES.indexOf(mime) === -1) continue;
    if (!buf.length || buf.length > 12 * 1024 * 1024) continue;
    out.push({ name: str(ph.name, 200), mime: mime, data: buf });
  }
  return out;
}
// Reads a repair report PDF made by the tenant page back into its details and
// photos. The page writes plain text lines ("PROPERTY", then the value) and the
// photos as images, so no PDF library is needed. Null if it isn't one of ours.
const PDF_LABELS = {
  'PROPERTY': 'address', 'REPORTED BY': 'reporter', 'ISSUE TYPE': 'category', "WHAT'S AFFECTED": 'affected',
  "WHAT'S HAPPENING": 'symptom', 'LOCATION IN PROPERTY': 'location', 'URGENCY': 'urgency', 'DESCRIPTION': 'description',
  'DAYS THAT WORK FOR ACCESS': 'accessDays', 'BEST TIME OF DAY': 'accessTime', 'ACCESS NOTES': 'accessNotes',
  'PERMISSION TO RELEASE KEYS TO A CONTRACTOR': 'keyPermission', 'CONTRACTOR INSTRUCTIONS': 'keyInstructions', 'PHOTOS': 'photos'
};
const PDF_HEADINGS = ['PROPERTY & REPORTED BY', 'ISSUE DETAILS', 'ACCESS & KEY PERMISSION', 'REPAIR REPORT'];
function readReportPdf(buf) {
  if (!buf || buf.length < 100 || buf.slice(0, 5).toString('latin1') !== '%PDF-') return null;
  const raw = buf.toString('latin1');
  const unesc = function (t) {
    return t.replace(/\\([0-7]{1,3}|.)/g, function (m, c) {
      if (/^[0-7]+$/.test(c)) return String.fromCharCode(parseInt(c, 8));
      return { n: '\n', r: '', t: '\t', b: '', f: '' }[c] !== undefined ? { n: '\n', r: '', t: '\t', b: '', f: '' }[c] : c;
    });
  };
  // WinAnsi characters the page uses (· – — ’ “ ”).
  const win = { '\x95': '•', '\x96': '–', '\x97': '—', '\x91': '‘', '\x92': '’', '\x93': '“', '\x94': '”', '\x85': '…' };
  const lines = [];
  const re = /\(((?:[^()\\]|\\[\s\S])*)\)\s*Tj|\[((?:[^\]\\]|\\[\s\S])*)\]\s*TJ/g;
  let m;
  while ((m = re.exec(raw))) {
    let t = m[1] !== undefined ? unesc(m[1]) : (m[2].match(/\(((?:[^()\\]|\\[\s\S])*)\)/g) || []).map(function (x) { return unesc(x.slice(1, -1)); }).join('');
    t = t.replace(/[\x85\x91-\x97]/g, function (c) { return win[c]; }).trim();
    if (t) lines.push(t);
  }
  const refLine = lines.filter(function (l) { return /^Ref RR-[A-Z0-9]+/.test(l); })[0];
  if (lines[0] !== 'Repair Report' || lines.indexOf('PROPERTY') === -1) return null;
  const out = {}, photoNames = [];
  let cur = null;
  lines.forEach(function (l) {
    if (/^Residential Realtors\s+·\s+(Ref |\d)/.test(l) || /^Page \d+ of \d+$/.test(l) || /^Ref RR-/.test(l) || PDF_HEADINGS.indexOf(l.toUpperCase()) !== -1 && l === l.toUpperCase()) return;
    if (PDF_LABELS[l]) { cur = PDF_LABELS[l]; return; }
    if (!cur) return;
    if (cur === 'photos') { photoNames.push(l); return; }
    out[cur] = out[cur] ? out[cur] + (cur === 'description' || cur === 'accessNotes' || cur === 'keyInstructions' ? ' ' : ' ') + l : l;
  });
  if (!out.address) return null;
  const who = String(out.reporter || '').split(/\s+·\s+/);
  const email = who.filter(function (x) { return /@/.test(x); })[0] || '';
  const phone = who.filter(function (x) { return /^[+\d][\d\s()-]{6,}$/.test(x); })[0] || '';
  const report = {
    name: who[0] || '', email: email, phone: phone, address: out.address, category: out.category || '', affected: out.affected || '',
    symptom: out.symptom || '', location: out.location || '', description: out.description === '—' ? '' : (out.description || ''),
    urgency: out.urgency || 'Routine', accessDays: out.accessDays || '', accessTime: out.accessTime || '', accessNotes: out.accessNotes || '',
    keyPermission: out.keyPermission === 'Not specified' ? '' : (out.keyPermission || ''), keyInstructions: out.keyInstructions || ''
  };
  // Photos: the JPEG (or original HEIC) image streams; the first image is our logo.
  const photos = [];
  const imgRe = /<<([^>]*?\/Subtype \/Image[\s\S]*?)>>\s*stream\r?\n/g;
  let im;
  while ((im = imgRe.exec(raw))) {
    const len = /\/Length (\d+)/.exec(im[1]);
    if (!len || !/\/Filter \/DCTDecode/.test(im[1])) continue;
    const data = buf.slice(im.index + im[0].length, im.index + im[0].length + parseInt(len[1], 10));
    const heic = /^ftyp(hei|hev|mif1|msf1)/.test(data.slice(4, 12).toString('latin1'));
    if (!heic && !(data[0] === 0xFF && data[1] === 0xD8)) continue;
    photos.push({ name: photoNames[photos.length] || 'photo-' + (photos.length + 1) + (heic ? '.heic' : '.jpg'), dataUrl: 'data:' + (heic ? 'image/heic' : 'image/jpeg') + ';base64,' + data.toString('base64') });
  }
  report.photoCount = photos.length;
  return { report: report, photos: photos, lines: lines, tenantRef: refLine ? /RR-[A-Z0-9]+/.exec(refLine)[0] : '' };
}
// The text of a Word document (.docx is a zip holding word/document.xml).
// Only what's needed to read the words, so no extra library.
function docxText(buf) {
  const zlib = require('zlib');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) { if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) return '';
  const count = buf.readUInt16LE(eocd + 10); let off = buf.readUInt32LE(eocd + 16);
  const parts = [];
  for (let n = 0; n < count && off + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10), csize = buf.readUInt32LE(off + 20), nlen = buf.readUInt16LE(off + 28), xlen = buf.readUInt16LE(off + 30), clen = buf.readUInt16LE(off + 32), local = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nlen).toString('utf8');
    off += 46 + nlen + xlen + clen;
    if (!/^word\/(document|header\d*|footer\d*)\.xml$/.test(name)) continue;
    const lnlen = buf.readUInt16LE(local + 26), lxlen = buf.readUInt16LE(local + 28), start = local + 30 + lnlen + lxlen;
    const raw = buf.slice(start, start + csize);
    let xml = '';
    try { xml = (method === 8 ? zlib.inflateRawSync(raw) : raw).toString('utf8'); } catch (e) { continue; }
    parts.push({ main: name === 'word/document.xml', text: xml.replace(/<w:tab\/>/g, '\t').replace(/<\/w:p>/g, '\n').replace(/<w:br[^>]*\/>/g, '\n').replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() });
  }
  return parts.sort(function (a, b) { return b.main - a.main; }).map(function (x) { return x.text; }).join('\n\n');
}
// HEIC → JPEG (pure JavaScript, loaded only when needed). If it can't be
// converted the original is kept, so nothing is lost.
async function heicToJpeg(ph) {
  if (ph.mime !== 'image/heic' && ph.mime !== 'image/heif') return ph;
  try {
    const convert = require('heic-convert');
    const out = Buffer.from(await convert({ buffer: ph.data, format: 'JPEG', quality: 0.82 }));
    return { name: String(ph.name || 'photo').replace(/\.hei[cf]$/i, '') + '.jpg', mime: 'image/jpeg', data: out };
  } catch (err) {
    console.error('HEIC photo could not be converted:', err.message);
    return ph;
  }
}
async function insertPhotos(p, jobIdValue, photos, addedBy) {
  for (const raw of photos) {
    const ph = await heicToJpeg(raw);
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
      var booked = d.jobs.filter(function(j){ return j.appointment_date && j.status !== 'Completed'; }).length;
      list.innerHTML = calBar(booked) + '<h2 style="font-size:1.05rem;margin:18px 0 8px">To do (' + open.length + ')</h2>' +
        (open.length ? open.map(card).join('') : '<p class="muted">No jobs waiting — thank you!</p>') +
        (done.length ? '<h2 style="font-size:1.05rem;margin:22px 0 8px">Completed in the last 30 days</h2>' + done.map(function(j){
          return '<div class="card"><div style="opacity:.75"><div class="ref">' + esc(j.ref) + ' · ✓ Completed ' + esc(day(j.completed_at)) + '</div><div>' + esc(j.property_address || '') + '</div><div class="muted">' + esc(j.summary || [j.category, j.affected, j.symptom].filter(Boolean).join(' · ')) + '</div></div>' + noteBox(j) + '</div>';
        }).join('') : '');
      Object.keys(picked).forEach(drawPicked);
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
      (j.my_task ? '<div style="font-weight:700">Your task: ' + esc(j.my_task) + '</div><div class="muted">Related to: ' + esc(j.summary || [j.category, j.affected, j.symptom].filter(Boolean).join(' · ')) + '</div>'
        : '<div>' + esc(j.summary || [j.category, j.affected, j.symptom].filter(Boolean).join(' · ')) + '</div>') +
      (j.with ? '<div class="muted" style="margin-top:4px">👷 ' + (j.other_task ? esc(j.with) + ' is also doing: ' + esc(j.other_task) : 'Working alongside ' + esc(j.with)) + ' — mark it completed when your part is done</div>' : '') +
      (j.status !== 'Completed' ? tenantBox(j) : '') +
      (j.appointment_date ? '<div style="margin:6px 0;font-weight:600">📅 Booked for ' + esc(day(j.appointment_date)) + (j.appointment_time ? ' at ' + esc(j.appointment_time) : '') +
        ' <a class="cal-add" href="/c/' + TOKEN + '/jobs/' + j.id + '/booking.ics">+ Add to my calendar</a></div>' : '') +
      '<details class="dt"><summary>Details and access</summary><div class="dbody">' +
        (j.description ? '<div class="desc">' + esc(j.description) + '</div>' : '') +
        item('📍', 'Where in the property', j.location) +
        item('🔑', 'Access', access) + item('🕒', 'Best times', j.access_time) + item('🗝️', 'Keys', keys) + item('📝', 'Access notes', j.access_notes) +
        item('📆', 'Reported', day(j.created_at)) +
      '</div></details>' +
      (j.has_report ? '<p style="margin:10px 0 0"><a href="/c/' + TOKEN + '/jobs/' + j.id + '/report.pdf" target="_blank" rel="noopener" style="font-weight:600">⬇ Tenant’s report (PDF)</a></p>' : '') +
      '<details class="dt"><summary>📅 ' + (j.appointment_date ? 'Change the booking' : 'Booked a visit? Say when') + '</summary>' +
        '<form class="stack" style="margin:10px 0 0" data-book="' + j.id + '">' +
          '<label class="muted">Date<input type="date" name="date" required value="' + esc(j.appointment_date || '') + '" style="display:block;width:100%;margin-top:4px"></label>' +
          '<label class="muted">Time<input name="time" placeholder="e.g. 10am or 9–12" value="' + esc(j.appointment_time || '') + '" style="display:block;width:100%;margin-top:4px"></label>' +
          '<input name="note" placeholder="Note (optional), e.g. tenant confirmed">' +
          '<button type="submit">Save booking</button>' +
        '</form></details>' +
      noteBox(j) +
      '<details class="dt"><summary style="color:#139A4B">✓ Mark completed</summary>' +
        '<form class="stack" style="margin:10px 0 0" data-done="' + j.id + '">' +
          '<textarea name="notes" rows="3" placeholder="What did you do? (optional)" style="padding:12px 14px;border:1px solid #d5d7dd;border-radius:12px;font:inherit"></textarea>' +
          '<input name="price" inputmode="decimal" placeholder="Your price £ (optional)">' +
          '<div class="muted">Parts or materials you bought (optional)</div><div class="parts" data-parts="' + j.id + '">' + partRow() + '</div>' +
          '<button type="button" class="linkbtn" data-addpart="' + j.id + '">+ Another part</button>' +
          (j.cert ? '<label class="muted" style="display:block">Date the ' + esc(j.cert) + ' was done<input type="date" name="cert_date" required value="' + new Date().toISOString().slice(0, 10) + '" style="display:block;width:100%;margin-top:4px"></label>' : '') +
          '<div class="muted">Photos of the finished work (optional, up to ' + MAXPH + ')</div><div class="phs" data-phs="' + j.id + '"></div>' +
          '<label class="phadd" data-phadd="' + j.id + '">📷 Add photo<input type="file" accept="image/*,.heic,.heif" multiple data-phin="' + j.id + '" style="display:none"></label>' +
          '<button type="submit" style="background:#139A4B">Mark ' + esc(j.ref) + ' completed</button>' +
        '</form></details>' +
    '</div>';
  }
  // The tenant's details, up front: name, phone, email, one-tap call, WhatsApp
  // and email, plus anyone else living there.
  function tenantBox(j){
    if (!j.tenant_name && !j.tenant_phone && !j.tenant_email) return '';
    var msg = 'Hi' + (first(j.tenant_name) ? ' ' + first(j.tenant_name) : '') + ', I’m the contractor from Residential Realtors for the repair at ' + (j.property_address || 'your property') + ' (' + j.ref + '). When would be a good time for me to come round?';
    var person = function(t, main){
      return '<div class="' + (main ? '' : 'muted') + '" style="margin-top:' + (main ? 2 : 8) + 'px"><span style="font-weight:600">' + esc(t.name || 'Tenant') + '</span>' +
        (t.phone ? ' · <a href="tel:' + esc(String(t.phone).replace(/[^0-9+]/g, '')) + '">' + esc(t.phone) + '</a>' : '') +
        (t.email ? ' · <a href="mailto:' + esc(t.email) + '">' + esc(t.email) + '</a>' : '') + '</div>';
    };
    return '<div class="tn" style="margin-top:10px"><div class="lb">Tenant' + (j.direct_contact === 'No' ? ' · the office arranges access' : ' · please contact them to arrange a time') + '</div>' +
      person({ name: j.tenant_name, phone: j.tenant_phone, email: j.tenant_email }, true) +
      '<div class="acts" style="margin-top:8px">' +
        (j.tenant_phone ? '<a class="abtn" href="tel:' + esc(String(j.tenant_phone).replace(/[^0-9+]/g, '')) + '">📞 Call</a>' : '') +
        (wa(j.tenant_phone) ? '<a class="abtn wa" target="_blank" rel="noopener" href="https://wa.me/' + wa(j.tenant_phone) + '?text=' + encodeURIComponent(msg) + '">WhatsApp</a>' : '') +
        (j.tenant_email ? '<a class="abtn" style="background:#2F5BEA" href="mailto:' + esc(j.tenant_email) + '?subject=' + encodeURIComponent('Repair at ' + (j.property_address || 'your property') + ' (' + j.ref + ')') + '&body=' + encodeURIComponent(msg) + '">✉️ Email</a>' : '') +
      '</div>' +
      ((j.other_tenants || []).length ? '<div class="lb" style="margin-top:10px">Also living there</div>' + j.other_tenants.map(function(t){ return person(t, false); }).join('') : '') +
    '</div>';
  }
  // Subscribe once and every booking shows in their own calendar, kept up to date.
  function calBar(booked){
    var https = location.origin + '/c/' + TOKEN + '/calendar.ics', webcal = https.replace(/^https?:/, 'webcal:');
    var enc = encodeURIComponent(https), name = encodeURIComponent('Residential Realtors jobs');
    return '<details class="dt calbar"' + ((function(){ try { return localStorage.getItem('rr_cal_seen'); } catch (x) { return null; } })() ? '' : ' open') + '><summary>📅 Put your bookings in your calendar' + (booked ? ' (' + booked + ' booked)' : '') + '</summary>' +
      '<p class="muted" style="margin:6px 0 10px">Do this once: every job you book here then appears in your calendar automatically, with the address, tenant and access details, and updates if a time changes.</p>' +
      '<div class="acts">' +
        '<a class="abtn" href="' + webcal + '" data-cal="1">📱 iPhone / Mac</a>' +
        '<a class="abtn" style="background:#0F6CBD" target="_blank" rel="noopener" href="https://outlook.office.com/calendar/0/addfromweb?url=' + enc + '&name=' + name + '" data-cal="1">Outlook (work)</a>' +
        '<a class="abtn" style="background:#0F6CBD" target="_blank" rel="noopener" href="https://outlook.live.com/calendar/0/addfromweb?url=' + enc + '&name=' + name + '" data-cal="1">Outlook.com / Hotmail</a>' +
        '<a class="abtn" style="background:#1A73E8" target="_blank" rel="noopener" href="https://calendar.google.com/calendar/r?cid=' + encodeURIComponent(webcal) + '" data-cal="1">Google / Android</a>' +
      '</div><p class="muted" style="margin:8px 0 0;font-size:.82rem">On iPhone tap <b>Subscribe</b> when asked. In Outlook desktop: Add calendar → From internet, and paste <span style="word-break:break-all">' + esc(https) + '</span></p></details>';
  }
  // Notes and questions for the office, with the ones already sent.
  function noteBox(j){
    var sent = (j.notes || []).map(function(n){ return '<div class="desc" style="font-size:.9rem"><span class="muted">' + esc(day(n.at)) + ':</span> ' + esc(n.body) + '</div>'; }).join('');
    return '<details class="dt"><summary>💬 Send a note to the office' + ((j.notes || []).length ? ' (' + j.notes.length + ' sent)' : '') + '</summary>' +
      '<form class="stack" style="margin:10px 0 0" data-note="' + j.id + '">' + sent +
        '<textarea name="note" rows="3" placeholder="e.g. Need a part, back on Friday · Tenant not home · Found another problem" style="padding:12px 14px;border:1px solid #d5d7dd;border-radius:12px;font:inherit"></textarea>' +
        '<label class="muted" style="display:block">Photos (optional)<input type="file" name="photos" accept="image/*,.heic,.heif" multiple style="display:block;margin-top:6px;padding:10px;background:#fff"></label>' +
        '<button type="submit">Send note</button>' +
      '</form></details>';
  }
  // Parts or materials the contractor bought: what it was and what it cost (up to 5).
  function partRow(){ return '<div class="prow"><input data-pd placeholder="e.g. Tap cartridge"><input data-pc inputmode="decimal" placeholder="£ cost"></div>'; }
  list.addEventListener('click', function(e){
    var a = e.target.closest('[data-addpart]'); if (!a) return;
    var box = document.querySelector('[data-parts="' + a.dataset.addpart + '"]'); if (!box) return;
    box.insertAdjacentHTML('beforeend', partRow()); if (box.children.length >= 5) a.style.display = 'none';
    box.lastChild.querySelector('[data-pd]').focus();
  });
  // Photos of the finished work: added one or several at a time (camera or library), up to
  // MAXPH, each shown as a thumbnail that can be removed before sending.
  var MAXPH = 5, picked = {};
  function drawPicked(id){
    var box = document.querySelector('[data-phs="' + id + '"]'), add = document.querySelector('[data-phadd="' + id + '"]'), list2 = picked[id] || [];
    if (!box) return;
    box.innerHTML = list2.map(function(f, i){
      var ok = /^image.(jpe?g|png|gif|webp)$/i.test(f.type || '');
      if (ok && !f._url) f._url = URL.createObjectURL(f);
      return '<div class="ph">' + (ok ? '<img src="' + f._url + '" alt="">' : '<span>📷<br>' + esc((f.name || 'photo').slice(0, 14)) + '</span>') + '<button type="button" data-phdel="' + id + '|' + i + '" aria-label="Remove">×</button></div>';
    }).join('');
    if (add) { add.style.display = list2.length >= MAXPH ? 'none' : ''; add.firstChild.nodeValue = list2.length ? '📷 Add another (' + list2.length + ' of ' + MAXPH + ')' : '📷 Add photo'; }
  }
  list.addEventListener('change', function(e){
    var inp = e.target.closest('[data-phin]'); if (!inp) return;
    var id = inp.dataset.phin, cur = picked[id] = picked[id] || [], added = Array.prototype.slice.call(inp.files || []);
    var room = MAXPH - cur.length; if (added.length > room) alert('Up to ' + MAXPH + ' photos — the first ' + room + ' were added.');
    added.slice(0, Math.max(0, room)).forEach(function(f){ cur.push(f); });
    inp.value = ''; drawPicked(id);
  });
  list.addEventListener('click', function(e){
    var d = e.target.closest('[data-phdel]'); if (!d) return;
    var a = d.dataset.phdel.split('|'), l2 = picked[a[0]] || [], gone = l2.splice(Number(a[1]), 1)[0];
    if (gone && gone._url) URL.revokeObjectURL(gone._url);
    drawPicked(a[0]);
  });
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
        // A photo this browser can't open (an iPhone HEIC, say) goes as it is; our server converts it.
        img.onerror = function(){ resolve(/hei[cf]$/i.test(file.name || '') || /hei[cf]/i.test(file.type || '') ? { name: file.name, dataUrl: String(fr.result).replace(/^data:[^;,]*;base64,/, 'data:image/heic;base64,') } : null); };
        img.src = fr.result;
      };
      fr.onerror = function(){ resolve(null); };
      fr.readAsDataURL(file);
    });
  }
  list.addEventListener('click', function(e){ if (e.target.closest('[data-cal]')) { try { localStorage.setItem('rr_cal_seen', '1'); } catch (x) {} } });
  list.addEventListener('submit', function(e){
    var nf = e.target.closest('[data-note]');
    if (nf) {
      e.preventDefault();
      var nb = nf.querySelector('button[type=submit]'), nfiles = Array.prototype.slice.call(nf.photos.files || [], 0, 10);
      if (!nf.note.value.trim() && !nfiles.length) { nf.note.focus(); return; }
      nb.disabled = true; nb.textContent = nfiles.length ? 'Uploading ' + nfiles.length + ' photo' + (nfiles.length === 1 ? '' : 's') + '…' : 'Sending…';
      Promise.all(nfiles.map(shrink)).then(function(ph){ return fetch('/api/c/' + TOKEN + '/jobs/' + nf.dataset.note + '/note', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: nf.note.value.trim(), photos: ph.filter(Boolean) }) }); })
        .then(function(r){ return r.json(); }).then(function(d){
          if (!d.ok) { nb.disabled = false; nb.textContent = 'Couldn’t send — try again'; return; }
          nb.textContent = '✓ Sent to the office'; setTimeout(load, 900);
        }).catch(function(){ nb.disabled = false; nb.textContent = 'Couldn’t send — try again'; });
      return;
    }
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
    var btn = f.querySelector('button[type=submit]'); btn.disabled = true; btn.textContent = 'Saving…';
    var price = f.price.value.replace(/[£,\\s]/g, '');
    var files = (picked[f.dataset.done] || []).slice(0, MAXPH), badPart = false;
    var parts = Array.prototype.slice.call(f.querySelectorAll('.prow')).map(function(r){
      var d = r.querySelector('[data-pd]').value.trim(), c = r.querySelector('[data-pc]').value.replace(/[£,]/g, '').trim();
      if (!d && !c) return null; if (!d || c === '' || isNaN(Number(c)) || Number(c) < 0) badPart = true;
      return { description: d, cost: c };
    }).filter(Boolean);
    if (badPart) { btn.disabled = false; btn.textContent = 'Give each part a name and a £ cost'; return; }
    if (files.length) btn.textContent = 'Uploading ' + files.length + ' photo' + (files.length === 1 ? '' : 's') + '…';
    Promise.all(files.map(shrink)).then(function(ph){ return fetch('/api/c/' + TOKEN + '/jobs/' + f.dataset.done + '/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: f.notes.value.trim(), price: price === '' ? null : price, cert_date: f.cert_date ? f.cert_date.value : undefined, photos: ph.filter(Boolean), parts: parts }) }); })
      .then(function(r){ return r.json(); }).then(function(d){
        if (!d.ok) { btn.disabled = false; btn.textContent = d.error === 'bad-price' ? 'Check the price and try again' : d.error === 'bad-part' ? 'Check the parts and try again' : 'Couldn’t save — try again'; return; }
        delete picked[f.dataset.done]; load();
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
      .then(function () { return mergeDuplicateTenants(pool).catch(function (err) { console.error('Tenant merge failed:', err.message); }); })
      .then(function () { return mergeDuplicateLandlords(pool).catch(function (err) { console.error('Landlord merge failed:', err.message); }); })
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
  // Offers-only staff sign-ins carry '.o' in the signed part: exp.sid.o.signature.
  function makeToken(sid, exp, role) {
    exp = exp || Date.now() + SESSION_DAYS * 86400 * 1000;
    const signed = exp + '.' + sid + (role === 'offers' ? '.o' : '');
    return signed + '.' + sign(signed);
  }
  function parseToken(tok) {
    if (!ADMIN_PASSWORD || !tok) return null;
    const parts = String(tok).split('.');
    if (!(Number(parts[0]) > Date.now())) return null;
    let signed, sig, sid = null, role = null;
    if (parts.length === 2) { signed = parts[0]; sig = parts[1]; }
    else if (parts.length === 3 && /^[a-f0-9]{16,64}$/.test(parts[1])) { signed = parts[0] + '.' + parts[1]; sig = parts[2]; sid = parts[1]; }
    else if (parts.length === 4 && /^[a-f0-9]{16,64}$/.test(parts[1]) && parts[2] === 'o') { signed = parts.slice(0, 3).join('.'); sig = parts[3]; sid = parts[1]; role = 'offers'; }
    else return null;
    const a = Buffer.from(sig), b = Buffer.from(sign(signed));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return { exp: Number(parts[0]), sid: sid, role: role };
  }
  function validToken(tok) { return !!parseToken(tok); }
  function sessionCookie(req, token, exp) {
    return 'rr_admin=' + token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + Math.max(0, Math.round((exp - Date.now()) / 1000)) + (req.secure ? '; Secure' : '');
  }
  const sessionCache = new Map();   // sid -> { revoked, touched }
  async function startSession(req, sid, role) {
    const p = await db();
    if (!p) return;
    await p.query('INSERT INTO admin_sessions (id, ip, user_agent, role) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING',
      [sid, str(req.ip, 100), str(req.get('user-agent'), 400), role || null]);
    sessionCache.set(sid, { revoked: false, touched: Date.now() });
  }
  // Is this sign-in still allowed? Also notes when it was last used (every few minutes).
  async function sessionOk(req, sid, role) {
    let c = sessionCache.get(sid);
    const p = await db();
    if (!p) return !role;   // staff sign-ins can't be checked without the database
    if (!c) {
      const row = (await p.query('SELECT revoked_at FROM admin_sessions WHERE id = $1', [sid])).rows[0];
      if (!row) { if (role) return false; await startSession(req, sid); return true; }
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

  // ---------- Offers-only staff sign-in ----------
  // A second password, set by the office on the Offers page, that signs staff in
  // to the Offers page only. Stored as a salted scrypt hash in app_settings.
  let staffPwCache = null;   // { salt, hash } | false (none set) | null (not loaded)
  async function staffPw() {
    if (staffPwCache !== null) return staffPwCache;
    const p = await db(); if (!p) return false;
    const row = (await p.query("SELECT value FROM app_settings WHERE key = 'offers_staff'")).rows[0];
    staffPwCache = row && row.value && row.value.hash ? row.value : false;
    return staffPwCache;
  }
  function scryptHex(pw, salt) { return crypto.scryptSync(String(pw || ''), salt, 32).toString('hex'); }
  async function staffPasswordMatches(given) {
    const s = await staffPw(); if (!s || !given) return false;
    const a = Buffer.from(scryptHex(given, s.salt), 'hex'), b = Buffer.from(s.hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  // What an offers-only sign-in may use (paths under /api/admin).
  function staffAllowed(method, path) {
    if (method === 'GET') return path === '/me' || path === '/offers' || /^\/offers\/\d+\/(pdf|doc\/\d+)$/.test(path);
    if (method === 'POST') return /^\/offers\/\d+(\/(track|rtr))?$/.test(path);
    return false;
  }

  app.post('/api/admin/login', async function (req, res) {
    if (!ADMIN_PASSWORD) return res.status(503).json({ ok: false, error: 'admin-not-configured' });
    if (!loginAllowed(req.ip)) return res.status(429).json({ ok: false, error: 'too-many-attempts' });
    const given = (req.body || {}).password;
    let role = null;
    if (!passwordMatches(given)) {
      let staff = false;
      try { staff = await staffPasswordMatches(given); } catch (err) { console.error('Staff sign-in check failed:', err.message); }
      if (!staff) return res.status(401).json({ ok: false, error: 'wrong-password' });
      role = 'offers';
    }
    loginAttempts.delete(req.ip); // only failed attempts count towards the limit
    const sid = crypto.randomBytes(16).toString('hex'), exp = Date.now() + SESSION_DAYS * 86400 * 1000;
    try { await startSession(req, sid, role); } catch (err) { console.error('Sign-in record failed:', err.message); if (role) return res.status(503).json({ ok: false, error: 'db' }); }
    res.setHeader('Set-Cookie', sessionCookie(req, makeToken(sid, exp, role), exp));
    res.json({ ok: true, role: role });
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
        if (!(await sessionOk(req, t.sid, t.role))) {
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
    } catch (err) { console.error('Sign-in check failed:', err.message); if (t.role) return res.status(503).json({ ok: false, error: 'db' }); }
    req.role = t.role || null;
    if (req.role === 'offers' && !staffAllowed(req.method, req.path)) return res.status(403).json({ ok: false, error: 'not-allowed' });
    if (req.method !== 'GET' && !req.is('application/json')) return res.status(415).json({ ok: false, error: 'json-only' });
    next();
  });

  // The office sets (or turns off) the offers staff password. Changing it signs
  // staff out everywhere.
  async function signOutStaff(p) {
    const r = await p.query("UPDATE admin_sessions SET revoked_at = now() WHERE role = 'offers' AND revoked_at IS NULL RETURNING id");
    r.rows.forEach(function (x) { sessionCache.set(x.id, { revoked: true, touched: Date.now() }); });
    return r.rows.length;
  }
  app.get('/api/admin/offers-staff', withDb(async function (p, req, res) {
    const row = (await p.query("SELECT updated_at FROM app_settings WHERE key = 'offers_staff'")).rows[0];
    const n = (await p.query(`SELECT count(*)::int AS n FROM admin_sessions WHERE role = 'offers' AND revoked_at IS NULL AND created_at > now() - interval '${SESSION_DAYS} days'`)).rows[0].n;
    res.json({ ok: true, set: !!(await staffPw()), updated_at: row ? row.updated_at : null, signed_in: n });
  }));
  app.post('/api/admin/offers-staff', withDb(async function (p, req, res) {
    const b = req.body || {};
    if (b.off === true) {
      await p.query("DELETE FROM app_settings WHERE key = 'offers_staff'"); staffPwCache = false;
      return res.json({ ok: true, signed_out: await signOutStaff(p) });
    }
    if (b.sign_out === true) return res.json({ ok: true, signed_out: await signOutStaff(p) });
    const pw = String(b.password || '');
    if (pw.length < 8 || pw.length > 200) return res.status(400).json({ ok: false, error: 'short' });
    if (passwordMatches(pw)) return res.status(400).json({ ok: false, error: 'same' });
    const salt = crypto.randomBytes(16).toString('hex'), v = { salt: salt, hash: scryptHex(pw, salt) };
    await p.query(`INSERT INTO app_settings (key, value) VALUES ('offers_staff', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`, [JSON.stringify(v)]);
    staffPwCache = v;
    res.json({ ok: true, signed_out: await signOutStaff(p) });
  }));

  // ---------- Where staff are signed in ----------
  app.get('/api/admin/sessions', withDb(async function (p, req, res) {
    const r = await p.query(`SELECT id, created_at, last_seen, ip, user_agent, role FROM admin_sessions
      WHERE revoked_at IS NULL AND created_at > now() - interval '${SESSION_DAYS} days' ORDER BY last_seen DESC LIMIT 200`);
    res.json({ ok: true, sessions: r.rows.map(function (x) { return { id: x.id, created_at: x.created_at, last_seen: x.last_seen, ip: x.ip, user_agent: x.user_agent, role: x.role, current: x.id === req.sessionId }; }) });
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
      const sid = String(b.sid || ''), ev = String(b.ev || ''), page = ['report', 'track', 'portal', 'landlord'].indexOf(b.page) !== -1 ? b.page : null;
      const vid = /^[a-z0-9]{8,40}$/i.test(String(b.vid || '')) ? String(b.vid) : null;
      if (!/^[a-z0-9]{8,40}$/i.test(sid) || VISIT_EVENTS.indexOf(ev) === -1 || !page) return;
      const v = b.v == null ? null : String(b.v).slice(0, 120);
      const p = await db(); if (!p) return;
      const ip = String(req.ip || '').replace(/^::ffff:/, '').slice(0, 64) || null;
      await p.query('INSERT INTO site_sessions (sid, landing, vid, ip) VALUES ($1, $2, $3, $4) ON CONFLICT (sid) DO UPDATE SET ip = coalesce(site_sessions.ip, excluded.ip)', [sid, page, vid, ip]);
      // Remember who this browser is (the latest thing we learnt), and label the visit.
      const recognise = async function (who) {
        if (vid && who) await p.query(`INSERT INTO known_visitors (vid, kind, name, detail, job_id) VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (vid) DO UPDATE SET kind = excluded.kind, name = excluded.name, detail = excluded.detail, job_id = coalesce(excluded.job_id, known_visitors.job_id), updated_at = now()`,
          [vid, who.kind, who.name, who.detail || null, who.job_id || null]);
        const known = who || (vid ? (await p.query('SELECT kind, name, detail FROM known_visitors WHERE vid = $1', [vid])).rows[0] : null);
        if (known) await p.query('UPDATE site_sessions SET who = $2, who_kind = $3, vid = coalesce(vid, $4) WHERE sid = $1',
          [sid, (known.name || '') + (known.detail ? ' (' + known.detail + ')' : ''), known.kind, vid]);
      };
      if (ev === 'view') {
        const u = uaInfo(ua), src = visitSource(b.ref, b.utm, String(req.get('host') || '').replace(/^www\./, '').split(':')[0]);
        let subject = null, jobIdV = null;
        const path = String(b.path || '');
        const tm = /^\/t\/([A-Za-z0-9_-]{10,})/.exec(path), cm = /^\/c\/([A-Za-z0-9_-]{20,})/.exec(path);
        const lm = /^\/l\/([A-Za-z0-9_-]{20,})/.exec(path), w = String(b.to || '');
        let who = null;
        if (tm) {
          const j = (await p.query('SELECT id, tenant_name, landlord_name, property_address FROM jobs WHERE track_token = $1', [tm[1]])).rows[0];
          if (j) {
            jobIdV = j.id; subject = 'Tracker for ' + refFor(j.id);
            // The link says who it was sent to: ?w=t (tenant) or ?w=l (landlord).
            if (w === 't' && j.tenant_name) who = { kind: 'tenant', name: j.tenant_name, detail: shortAddrText(j.property_address), job_id: j.id };
            if (w === 'l') {
              const ll = j.landlord_name || ((await p.query('SELECT l.name FROM property_landlords pl JOIN landlords l ON l.id = pl.landlord_id WHERE pl.property_key = $1 LIMIT 1', [propKey(j.property_address)])).rows[0] || {}).name;
              if (ll) who = { kind: 'landlord', name: ll, detail: shortAddrText(j.property_address), job_id: j.id };
            }
          }
        }
        else if (cm) { const c = (await p.query('SELECT name FROM contractors WHERE portal_token = $1', [cm[1]])).rows[0]; if (c) { subject = c.name + '’s job link'; who = { kind: 'contractor', name: c.name }; } }
        else if (lm) { const l = (await p.query('SELECT name FROM landlords WHERE portal_token = $1', [lm[1]])).rows[0]; if (l) { subject = l.name + '’s landlord page'; who = { kind: 'landlord', name: l.name }; } }
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
        await recognise(who);
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
      // A report sent from this browser: it's that tenant.
      if (ev === 'submit' && v && /^RR-0*(\d+)$/.test(v)) {
        const j = (await p.query('SELECT id, tenant_name, property_address FROM jobs WHERE id = $1', [Number(/^RR-0*(\d+)$/.exec(v)[1])])).rows[0];
        if (j && j.tenant_name) await recognise({ kind: 'tenant', name: j.tenant_name, detail: shortAddrText(j.property_address), job_id: j.id });
      }
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
    for (const [n, m] of list.entries()) {
      // The email service takes about 2 a second, so space them out.
      if (n) await new Promise(function (r) { setTimeout(r, 550); });
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
      : await p.query('SELECT id, created_at, subject, body, audience, property_keys, recipients, sent FROM tenant_notices ORDER BY id DESC LIMIT ' + (req.query.all ? 300 : 50));
    res.json({ ok: true, notices: r.rows });
  }));

  // For the Activity page: every visit in the period, summed up, plus the latest visits.
  app.get('/api/admin/site-sessions', withDb(async function (p, req, res) {
    const days = String(Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30)));
    const rows = (await p.query(`SELECT sid, started_at, last_at, landing, pages, device, browser, os, source, ref_host, screen, lang, tz, chosen_lang, steps, categories,
        subject, job_id, submitted_ref, views, events, ip, extract(epoch FROM last_at - started_at)::int AS secs,
        coalesce(who, (SELECT j.tenant_name || ' (' || split_part(coalesce(j.property_address, ''), ',', 1) || ')' FROM jobs j WHERE j.id = site_sessions.job_id AND site_sessions.submitted_ref IS NOT NULL)) AS who,
        coalesce(who_kind, CASE WHEN submitted_ref IS NOT NULL THEN 'tenant' END) AS who_kind,
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
    res.json({ ok: true, role: req.role || null, db: !!(await db()), canEmail: canEmail(), canAi: !!(opts.canAi && opts.canAi()), invoice: INVOICE, offerOrigin: OFFER_ORIGIN, statuses: STATUSES, urgencies: URGENCIES, dueHours: DUE_HOURS, sources: SOURCES, deployedAt: DEPLOYED_AT });
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
    const u = await p.query('SELECT id, created_at, kind, body, author, seen_at FROM job_updates WHERE job_id = $1 ORDER BY created_at DESC, id DESC', [id]);
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
    assigned_to_2: { clean: function (v) { return str(v, 200); }, label: 'Second contractor' },
    task_2: { clean: function (v) { return str(v, 500); }, label: 'Second contractor’s task' },
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
    // A contractor who'd finished their part and is no longer on the job: forget it.
    if ('assigned_to' in body || 'assigned_to_2' in body) {
      await p.query(`UPDATE jobs SET part_done_by = NULL, part_done_at = NULL, part_price = NULL WHERE id = $1 AND part_done_by IS NOT NULL
        AND lower(trim(part_done_by)) NOT IN (lower(trim(coalesce(assigned_to, ''))), lower(trim(coalesce(assigned_to_2, ''))))`, [id]);
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
    const auto = await autoJobInvoice(p, id);
    res.json({ ok: true, changed: true, invoice: auto });
  }));

  // ---------- Landlords ----------
  app.get('/api/admin/landlords', withDb(async function (p, req, res) {
    const l = await p.query('SELECT id, name, email, phone, address, notes, created_at, updated_at, link_sent FROM landlords ORDER BY lower(name)');
    const links = await p.query('SELECT property_key, address, landlord_id FROM property_landlords ORDER BY address');
    const own = await p.query('SELECT id, landlord_id, address, data, epc, created_at FROM landlord_properties ORDER BY address');
    res.json({ ok: true, landlords: l.rows, links: links.rows, own: own.rows });
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
  // ---------- Add a property (with its tenants, landlord and key number) ----------
  app.post('/api/admin/properties', withDb(async function (p, req, res) {
    const b = req.body || {};
    let address = tidyAddress(str(b.address, 500));
    if (!address || !propKey(address)) return res.status(400).json({ ok: false, error: 'address' });
    try { address = await canonicalAddress(p, address); } catch (e) { /* keep as typed */ }
    const key = propKey(address);
    await p.query(`INSERT INTO property_info (property_key, address, key_number, key_notes) VALUES ($1, $2, $3, $4)
      ON CONFLICT (property_key) DO UPDATE SET address = excluded.address, key_number = coalesce(excluded.key_number, property_info.key_number),
        key_notes = coalesce(excluded.key_notes, property_info.key_notes), updated_at = now()`, [key, address, str(b.key_number, 40), str(b.notes, 500)]);
    let tenants = 0;
    for (const t of (Array.isArray(b.tenants) ? b.tenants : []).slice(0, 12)) {
      if (!str(t && t.name) && !str(t && t.phone) && !str(t && t.email)) continue;
      await ensureTenant(p, { name: str(t.name, 200), phone: str(t.phone, 50), email: str(t.email, 200) }, address, true);
      tenants += 1;
    }
    let landlord = null;
    if (str(b.landlord_name)) {
      await ensureLandlord(p, { landlord_name: str(b.landlord_name, 200), landlord_phone: str(b.landlord_phone, 50), landlord_email: str(b.landlord_email, 200) }, address);
      landlord = str(b.landlord_name, 200);
    }
    const licence = await applyLicencePool(p).catch(function () { return 0; });   // a licence saved for it earlier
    res.json({ ok: true, address: address, key: key, tenants: tenants, landlord: landlord, licence: licence });
  }));

  // ---------- Key numbers ----------
  app.get('/api/admin/property-info', withDb(async function (p, req, res) {
    res.json({ ok: true, info: (await p.query('SELECT property_key, address, key_number, key_notes, licence, updated_at FROM property_info')).rows });
  }));
  app.put('/api/admin/property-info', withDb(async function (p, req, res) {
    const b = req.body || {}, address = str(b.address, 500), key = propKey(address);
    if (!key) return res.status(400).json({ ok: false, error: 'address' });
    const num = str(b.key_number, 40), notes = str(b.key_notes, 500);
    const before = (await p.query('SELECT key_number, key_notes FROM property_info WHERE property_key = $1', [key])).rows[0] || {};
    await p.query(`INSERT INTO property_info (property_key, address, key_number, key_notes) VALUES ($1, $2, $3, $4)
      ON CONFLICT (property_key) DO UPDATE SET address = excluded.address, key_number = excluded.key_number, key_notes = excluded.key_notes, updated_at = now()`, [key, address, num, notes]);
    // Another property already using this number (worth a second look, but allowed).
    const clash = num ? (await p.query('SELECT address FROM property_info WHERE property_key <> $1 AND lower(trim(key_number)) = lower(trim($2)) LIMIT 1', [key, num])).rows[0] : null;
    // Note it on the property's open jobs, so the history shows when it changed.
    if ((before.key_number || null) !== num) {
      const ids = (await p.query("SELECT id, property_address FROM jobs WHERE archived_at IS NULL AND status NOT IN ('Completed', 'Cancelled')")).rows.filter(function (r) { return propKey(r.property_address) === key; });
      for (const r of ids) await p.query("INSERT INTO job_updates (job_id, kind, body) VALUES ($1, 'change', $2)", [r.id, 'Key number: ' + (before.key_number || 'none') + ' → ' + (num || 'none')]);
    }
    res.json({ ok: true, clash: clash ? clash.address : null });
  }));

  // The property's licence (selective / additional / HMO), as checked on the
  // council's public register: whether it has one, its number and expiry.
  app.put('/api/admin/property-licence', withDb(async function (p, req, res) {
    const b = req.body || {}, out = await saveLicence(p, str(b.address, 500), b.licence || {}, b.doc);
    res.status(out.status || 200).json(out.json);
  }));
  // Save a property's licence (from the register, the office, a landlord, or an
  // uploaded licence document — kept so it can be opened).
  async function saveLicence(p, address, l, docIn) {
    const key = propKey(address);
    if (!key) return { status: 400, json: { ok: false, error: 'address' } };
    const day = function (v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null; };
    const lic = { status: ['licensed', 'none', 'not_needed', 'applied'].indexOf(l.status) !== -1 ? l.status : 'licensed', type: str(l.type, 60), number: str(l.number, 60), holder: str(l.holder, 200),
      starts: day(l.starts), expires: day(l.expires), notes: str(l.notes, 500), borough: str(l.borough, 80), url: /^https:\/\/\S+$/i.test(String(l.url || '')) ? str(l.url, 500) : null, checked_at: day(l.checked_at) || new Date().toISOString().slice(0, 10) };
    const cur = (await p.query('SELECT licence FROM property_info WHERE property_key = $1', [key])).rows[0];
    if (cur && cur.licence && cur.licence.expires === lic.expires) lic.alerted_for = cur.licence.alerted_for || null;   // same expiry: don't alert again
    if (l.max_occupants) lic.max_occupants = parseInt(l.max_occupants, 10) || null;
    const doc = docIn && typeof docIn.data === 'string' ? Buffer.from(docIn.data.replace(/^data:[^,]*,/, ''), 'base64') : null;
    if (doc && doc.length && doc.length <= 15 * 1024 * 1024) {
      const mime = /^(application\/pdf|image\/(jpeg|png|webp|heic|heif))$/.test(String(docIn.mime || '')) ? docIn.mime : 'application/pdf';
      await p.query(`INSERT INTO licence_docs (property_key, name, mime, data) VALUES ($1, $2, $3, $4)
        ON CONFLICT (property_key) DO UPDATE SET name = excluded.name, mime = excluded.mime, data = excluded.data, created_at = now()`, [key, str(docIn.name, 200) || 'licence.pdf', mime, doc]);
      lic.has_doc = true;
    } else if (cur && cur.licence && cur.licence.has_doc && (!cur.licence.expires || cur.licence.expires === lic.expires)) lic.has_doc = true;   // keep the document unless it's a new licence
    else await p.query('DELETE FROM licence_docs WHERE property_key = $1', [key]);
    await p.query(`INSERT INTO property_info (property_key, address, licence) VALUES ($1, $2, $3)
      ON CONFLICT (property_key) DO UPDATE SET licence = excluded.licence, address = coalesce(property_info.address, excluded.address), updated_at = now()`, [key, address, JSON.stringify(lic)]);
    return { json: { ok: true, licence: lic } };
  }
  async function sendLicenceDoc(p, key, res) {
    const d = (await p.query('SELECT name, mime, data FROM licence_docs WHERE property_key = $1', [key])).rows[0];
    if (!d) return res.status(404).send('Not found');
    res.setHeader('Content-Type', d.mime || 'application/pdf'); res.setHeader('X-Robots-Tag', 'noindex');
    res.setHeader('Content-Disposition', 'inline; filename="' + String(d.name || 'licence.pdf').replace(/[^a-zA-Z0-9.\-_ ]+/g, '-') + '"');
    res.send(d.data);
  }
  app.get('/api/admin/licence-doc', withDb(async function (p, req, res) { await sendLicenceDoc(p, String(req.query.key || ''), res); }));

  // Which council a postcode is in (postcodes.io, free and public), and each
  // council's licence register link (saved by staff; Southwark to start with).
  const boroughCache = {};
  app.get('/api/admin/borough', withDb(async function (p, req, res) {
    const pc = String(req.query.postcode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!/^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(pc)) return res.status(400).json({ ok: false, error: 'postcode' });
    if (!boroughCache[pc]) {
      try {
        const r = await fetch('https://api.postcodes.io/postcodes/' + pc, { signal: AbortSignal.timeout(8000) });
        const d = await r.json();
        if (!r.ok || !d.result) return res.json({ ok: false, error: 'not-found' });
        boroughCache[pc] = d.result.admin_district || '';
      } catch (e) { return res.status(502).json({ ok: false, error: 'lookup-failed' }); }
    }
    res.json({ ok: true, borough: boroughCache[pc] });
  }));
  const DEFAULT_REGISTERS = { Southwark: 'https://southwark.metastreet.co.uk/public-register' };
  app.get('/api/admin/licence-registers', withDb(async function (p, req, res) {
    const row = (await p.query("SELECT value FROM app_settings WHERE key = 'licence_registers'")).rows[0];
    res.json({ ok: true, registers: Object.assign({}, DEFAULT_REGISTERS, (row && row.value) || {}) });
  }));
  app.put('/api/admin/licence-registers', withDb(async function (p, req, res) {
    const b = req.body || {}, borough = str(b.borough, 80), url = str(b.url, 500);
    if (!borough) return res.status(400).json({ ok: false, error: 'borough' });
    if (url && !/^https:\/\/[^\s]+$/i.test(url)) return res.status(400).json({ ok: false, error: 'url' });
    const row = (await p.query("SELECT value FROM app_settings WHERE key = 'licence_registers'")).rows[0];
    const v = Object.assign({}, (row && row.value) || {}); if (url) v[borough] = url; else delete v[borough];
    await p.query(`INSERT INTO app_settings (key, value) VALUES ('licence_registers', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`, [JSON.stringify(v)]);
    res.json({ ok: true, registers: Object.assign({}, DEFAULT_REGISTERS, v) });
  }));

  // Results copied (or a screenshot) from the council's licence register after a
  // postcode search: every licence listed, for the dashboard to match to our
  // properties and save once confirmed.
  app.post('/api/admin/licence-read', withDb(async function (p, req, res) {
    if (!opts.askAi || !opts.canAi || !opts.canAi()) return res.status(503).json({ ok: false, error: 'ai-not-configured' });
    const b = req.body || {}, text = str(String(b.text || ''), 60000), files = [];
    if (b.file && b.file.data) {
      const mime = String(b.file.mime || '').toLowerCase(), buf = Buffer.from(String(b.file.data), 'base64');
      if (!buf.length || buf.length > 15 * 1024 * 1024) return res.status(400).json({ ok: false, error: 'file-too-big' });
      if (mime === 'application/pdf' || /^image\/(jpeg|png|webp|heic|heif)$/.test(mime)) files.push({ mime: mime, data: buf.toString('base64') });
      else return res.status(400).json({ ok: false, error: 'file-type' });
    }
    if (!text && !files.length) return res.status(400).json({ ok: false, error: 'nothing' });
    const prompt = 'Below is ' + (files.length ? 'a screenshot or PDF of ' : 'text copied from ') + 'a UK council\'s public register of property licences (selective, additional HMO or mandatory HMO licensing), usually the results of a postcode search.' +
      (text ? '\n----\n' + text + '\n----\n' : '\n') +
      'List every licence (or licence application) shown. Reply with ONLY JSON: {"licences": [{"address": "", "postcode": "", "type": "", "number": "", "status": "", "holder": "", "starts": "", "expires": ""}]}. ' +
      'address: the licensed property address as shown (keep flat/house numbers exactly). type: "Selective", "Additional (HMO)" or "Mandatory HMO" (as shown, else ""). number: the licence/reference number. status: "licensed" if the licence has been granted/issued, "applied" if it has been submitted/applied for but not yet issued (e.g. "application received", "pending", "under consideration", "draft licence"), "" if unclear. holder: the licence holder name if shown. starts and expires: YYYY-MM-DD ("" if not shown; UK dates are day/month/year). Never invent anything.';
    const result = await opts.askAi(prompt, true, files);
    if (!result.ok) return res.status(502).json({ ok: false, error: 'ai-failed' });
    let parsed = null;
    try { parsed = JSON.parse(result.text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()); } catch (e) { parsed = null; }
    if (!parsed) return res.status(502).json({ ok: false, error: 'ai-bad-reply' });
    const day = function (v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : ''; };
    const licences = (Array.isArray(parsed.licences) ? parsed.licences : []).slice(0, 300).map(function (l) {
      return { address: str(l && l.address, 300) || '', postcode: str(l && l.postcode, 12) || '', type: str(l && l.type, 60) || '', number: str(l && l.number, 60) || '',
        status: l && l.status === 'applied' ? 'applied' : 'licensed', holder: str(l && l.holder, 200) || '', starts: day(l && l.starts), expires: day(l && l.expires) };
    }).filter(function (l) { return l.address; });
    res.json({ ok: true, licences: licences });
  }));

  // Licences from the register for properties not on Fixflow yet: kept here and
  // applied automatically once the property is added (by any route).
  function sameAddr(a, b) {
    const ka = propKey(a), kb = propKey(b); if (!ka || !kb) return false; if (ka === kb) return true;
    const nums = function (k) { return k.split(' ').filter(function (w) { return /\d/.test(w); }); };
    const words = function (k) { return k.split(' ').filter(function (w) { return w.length >= 3 && !/\d/.test(w) && ['flat', 'house', 'road', 'street', 'court', 'london', 'the', 'and', 'apartment', 'estate', 'maisonette'].indexOf(w) === -1; }); };
    const within = function (x, y) { const xn = nums(x), xw = words(x), yn = nums(y), yw = words(y); return xn.length && xw.length && xn.every(function (n) { return yn.indexOf(n) !== -1; }) && xw.every(function (w) { return yw.indexOf(w) !== -1; }); };
    const pc = function (a) { const m = POSTCODE_RE.exec(String(a || '')); return m ? String(m[0]).replace(/\s+/g, '').toUpperCase() : ''; };
    if (pc(a) && pc(b) && pc(a) !== pc(b)) return false;   // different postcodes: never the same place
    return within(ka, kb) || within(kb, ka);
  }
  function cleanPoolLicence(l, borough) {
    const day = function (v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null; };
    return { status: l && l.status === 'applied' ? 'applied' : 'licensed', type: str(l && l.type, 60), number: str(l && l.number, 60), holder: str(l && l.holder, 200),
      starts: day(l && l.starts), expires: day(l && l.expires), borough: str((l && l.borough) || borough, 80), checked_at: new Date().toISOString().slice(0, 10) };
  }
  async function applyLicencePool(p) {
    const pool = (await p.query('SELECT id, address, licence FROM licence_pool WHERE applied_at IS NULL')).rows;
    if (!pool.length) return 0;
    const props = (await allProperties(p)).concat((await p.query('SELECT address FROM tenancies WHERE address IS NOT NULL')).rows.map(function (r) { return { key: propKey(r.address), address: r.address }; }));
    let n = 0;
    for (const row of pool) {
      const hit = props.filter(function (x) { return x.key && sameAddr(x.address, row.address); })[0]; if (!hit) continue;
      await p.query(`INSERT INTO property_info (property_key, address, licence) VALUES ($1, $2, $3)
        ON CONFLICT (property_key) DO UPDATE SET licence = excluded.licence, updated_at = now()`, [hit.key, hit.address, JSON.stringify(row.licence)]);
      await p.query('UPDATE licence_pool SET applied_key = $2, applied_at = now() WHERE id = $1', [row.id, hit.key]);
      n++;
    }
    if (n) console.log('Licences applied from the saved list: ' + n);
    return n;
  }
  app.get('/api/admin/licence-pool', withDb(async function (p, req, res) {
    await applyLicencePool(p);
    res.json({ ok: true, pool: (await p.query('SELECT id, created_at, address, ref, licence FROM licence_pool WHERE applied_at IS NULL ORDER BY address')).rows });
  }));
  app.post('/api/admin/licence-pool', withDb(async function (p, req, res) {
    const b = req.body || {}, list = (Array.isArray(b.licences) ? b.licences : []).slice(0, 500);
    let saved = 0;
    for (const l of list) {
      const address = str(l && l.address, 300); if (!address) continue;
      const lic = cleanPoolLicence(l, b.borough), ref = lic.number || null;
      // The same licence (by reference, else address) is updated, not added twice.
      const cur = (await p.query('SELECT id FROM licence_pool WHERE applied_at IS NULL AND ((ref IS NOT NULL AND ref = $1) OR lower(address) = lower($2)) LIMIT 1', [ref, address])).rows[0];
      if (cur) await p.query('UPDATE licence_pool SET address = $2, ref = $3, licence = $4, updated_at = now() WHERE id = $1', [cur.id, address, ref, JSON.stringify(lic)]);
      else await p.query('INSERT INTO licence_pool (address, ref, licence) VALUES ($1, $2, $3)', [address, ref, JSON.stringify(lic)]);
      saved++;
    }
    const applied = await applyLicencePool(p);
    res.json({ ok: true, saved: saved, applied: applied });
  }));
  app.delete('/api/admin/licence-pool/:id', withDb(async function (p, req, res) {
    await p.query('DELETE FROM licence_pool WHERE id = $1', [jobId(req)]);
    res.json({ ok: true });
  }));

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
      '1. The issue: what it is, where in the property, when, how urgent, and anything already done — say it was reported by the tenant only if "How it came in" says so (a certificate renewal or inspection was raised by us; a landlord request came from them). ' +
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
      fact('Reported', when(j.created_at)) + fact('How it came in', j.source === 'Online report' ? 'Reported by the tenant online' : j.source === 'Landlord request' ? 'Requested by the landlord'
        : j.source === 'Inspection' ? 'Found at our inspection' : /^(gas safety|eicr|epc)$/i.test(String(j.category || '').trim()) && /\b(expires|expired) on\b/i.test(String(j.description || '')) ? 'Raised by us: the certificate is due for renewal (not reported by the tenant)'
        : ['Phone call', 'Text / WhatsApp', 'In person'].indexOf(j.source) !== -1 ? 'Reported by the tenant (' + j.source.toLowerCase() + ')' : 'Raised by us') + fact('Deadline', when(j.due_at)) + fact('Completed', when(j.completed_at)) +
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
    const r = await p.query(`SELECT i.id, i.job_id, i.tenancy_id, i.created_at, i.number, i.total, i.landlord_name, i.landlord_email, i.paid_at,
        i.data->>'due' AS due, i.data->>'landlordPhone' AS landlord_phone, i.data->>'title' AS title, coalesce(j.property_address, i.address) AS property_address, j.archived_at
      FROM invoices i LEFT JOIN jobs j ON j.id = i.job_id WHERE i.job_id IS NULL OR j.id IS NOT NULL ORDER BY i.id DESC LIMIT 5000`);
    res.json({ ok: true, invoices: r.rows.map(function (x) { x.ref = x.job_id ? refFor(x.job_id) : (x.title || 'Tenancy'); return x; }) });
  }));

  // A new invoice to a landlord, not tied to a repair job: any charge for a
  // property (e.g. the move-in fees a Tenant Find landlord owes us), optionally
  // for a tenancy. Lines are before VAT; VAT added unless off.
  app.post('/api/admin/invoices', withDb(async function (p, req, res) {
    const b = req.body || {}, address = str(b.address, 500) || '', key = propKey(address);
    if (!key) return res.status(400).json({ ok: false, error: 'address' });
    const lines = (Array.isArray(b.lines) ? b.lines : []).slice(0, 30).map(function (l) { const x = { desc: str(l && l.desc, 300) || '', amount: money(l && l.amount) }; if (l && l.novat === true && b.vat !== false) x.novat = true; return x; }).filter(function (l) { return l.desc && l.amount; });
    if (!lines.length) return res.status(400).json({ ok: false, error: 'lines' });
    const r2 = function (v) { return Math.round(v * 100) / 100; };
    // VAT on each line except those marked "No VAT".
    const sub = r2(lines.reduce(function (a, l) { return a + l.amount; }, 0)), vat = b.vat === false ? 0 : r2(lines.reduce(function (a, l) { return a + (l.novat ? 0 : l.amount); }, 0) * 0.2), total = r2(sub + vat);
    const tid = parseInt(b.tenancy_id, 10) || null;
    let ll = (await p.query('SELECT l.id, l.name, l.email, l.phone, l.address, l.portal_token FROM property_landlords pl JOIN landlords l ON l.id = pl.landlord_id WHERE pl.property_key = $1', [key])).rows[0] || {};
    const name = str(b.landlord_name, 200) || ll.name || '', email = str(b.landlord_email, 200) || ll.email || '';
    const today = new Date().toISOString().slice(0, 10), due = isoDay(b.due) || new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
    const ins = await p.query('INSERT INTO invoices (job_id, tenancy_id, address, property_key, total, landlord_name, landlord_email) VALUES (NULL, $1, $2, $3, $4, $5, $6) RETURNING id',
      [tid, address, key, total, name || null, email || null]);
    const id = ins.rows[0].id, number = 'INV-' + String(id).padStart(5, '0');
    const data = { number: number, title: str(b.title, 120) || 'Invoice', date: today, due: due, ref: str(b.ref, 40) || number, landlord: name, landlordEmail: email, landlordPhone: str(b.landlord_phone, 50) || ll.phone || '',
      landlordAddress: str(b.landlord_address, 500) || ll.address || '', lines: lines, sub: sub, vat: vat, total: total, kind: str(b.kind, 30) || '' };
    await p.query('UPDATE invoices SET number = $2, data = $3 WHERE id = $1', [id, number, JSON.stringify(data)]);
    if (tid) {
      await p.query('UPDATE tenancies SET log = log || $2::jsonb' + (b.kind === 'move_in' ? ", data = data || jsonb_build_object('fees_invoice_id', $3::int)" : '') + ' WHERE id = $1',
        b.kind === 'move_in' ? [tid, JSON.stringify([{ at: new Date().toISOString(), text: 'Invoice ' + number + ' raised to the landlord for ' + gbp(total) + ' — ' + data.title }]), id]
          : [tid, JSON.stringify([{ at: new Date().toISOString(), text: 'Invoice ' + number + ' raised to the landlord for ' + gbp(total) + ' — ' + data.title }])]);
    }
    // A link the landlord can open, for the email.
    let url = '';
    if (ll.id) {
      let token = ll.portal_token;
      if (!token) { token = crypto.randomBytes(18).toString('base64url'); await p.query('UPDATE landlords SET portal_token = $2, updated_at = now() WHERE id = $1', [ll.id, token]); }
      const siteUrl = process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : req.protocol + '://' + req.get('host'));
      url = siteUrl + '/l/' + token + '/invoice/' + id;
    }
    res.json({ ok: true, id: id, number: number, total: total, url: url, landlord_email: email, landlord_name: name });
  }));
  // The landlord paid what a tenancy owed us without an invoice (or hasn't).
  app.post('/api/admin/tenancies/:id/fees-paid', withDb(async function (p, req, res) {
    const paid = (req.body || {}).paid !== false, amount = money((req.body || {}).amount);
    const r = await p.query("UPDATE tenancies SET data = data || jsonb_build_object('fees_paid', $2::jsonb), log = log || $3::jsonb, updated_at = now() WHERE id = $1 RETURNING data",
      [jobId(req), paid ? JSON.stringify({ at: new Date().toISOString(), amount: amount || null }) : 'null', JSON.stringify([{ at: new Date().toISOString(), text: paid ? 'Landlord paid what they owed us' + (amount ? ' (' + gbp(amount) + ')' : '') : 'Marked as not paid by the landlord' }])]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'not-found' });
    res.json({ ok: true, data: r.rows[0].data });
  }));
  // Mark an invoice as paid by the landlord (or not paid).
  app.post('/api/admin/invoices/:id/paid', withDb(async function (p, req, res) {
    const paid = (req.body || {}).paid !== false;
    const r = await p.query('UPDATE invoices SET paid_at = ' + (paid ? 'coalesce(paid_at, now())' : 'NULL') + ' WHERE id = $1 RETURNING job_id, tenancy_id, number, total, landlord_name', [jobId(req)]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'not-found' });
    const x = r.rows[0];
    await invoiceNote(p, x, paid ? 'Invoice ' + x.number + ' paid' + (x.landlord_name ? ' by ' + x.landlord_name : '') + ' (' + gbp(x.total) + ').' : 'Invoice ' + x.number + ' marked as not paid.', 'change');
    res.json({ ok: true });
  }));

  // A note about an invoice: on its job's history, or its tenancy's.
  async function invoiceNote(p, x, text, kind) {
    if (x.job_id) await p.query('INSERT INTO job_updates (job_id, kind, body) VALUES ($1, $2, $3)', [x.job_id, kind || 'change', text]);
    else if (x.tenancy_id) await p.query('UPDATE tenancies SET log = log || $2::jsonb WHERE id = $1', [x.tenancy_id, JSON.stringify([{ at: new Date().toISOString(), text: text }])]);
  }
  // Delete an invoice (e.g. raised by mistake). The job's "invoiced" details fall
  // back to its latest remaining invoice, or are cleared; noted in the history.
  // A completed job with a landlord price gets its invoice automatically: the
  // repair at the job's charge to the landlord plus each part's charge (as the
  // invoice button would make it). When the price or parts change, that invoice
  // follows — until it's paid, or if staff made or edited an invoice themselves
  // (then it's theirs and is left alone).
  async function autoJobInvoice(p, jid) {
    try {
      const j = (await p.query(`SELECT id, status, archived_at, category, affected, symptom, location, completion_notes, landlord_charge, property_address,
          landlord_name, landlord_email, landlord_phone, landlord_address FROM jobs WHERE id = $1`, [jid])).rows[0];
      if (!j || j.status !== 'Completed' || j.archived_at) return null;
      const r2 = function (v) { return Math.round(v * 100) / 100; };
      const issue = [j.category, j.affected, j.symptom].filter(Boolean).join(' – ') || 'Repair';
      const lines = [];
      if (Number(j.landlord_charge) > 0) lines.push({ desc: issue + (j.location ? ' (' + j.location + ')' : '') + (j.completion_notes ? '. Work carried out: ' + String(j.completion_notes).replace(/\s+/g, ' ').slice(0, 600) : ''), amount: r2(Number(j.landlord_charge)) });
      (await p.query('SELECT description, charge FROM job_parts WHERE job_id = $1 ORDER BY id', [jid])).rows.forEach(function (x) { if (Number(x.charge) > 0) lines.push({ desc: 'Parts: ' + x.description, amount: r2(Number(x.charge)) }); });
      const total = r2(lines.reduce(function (a, l) { return a + l.amount; }, 0));
      const invs = (await p.query('SELECT id, number, total, paid_at, data FROM invoices WHERE job_id = $1 ORDER BY id', [jid])).rows;
      const auto = invs.filter(function (i) { return i.data && i.data.auto; }).pop();
      if (invs.length && !auto) return null;                    // staff's own invoice
      if (!lines.length || total <= 0) return null;             // no price yet
      const ref = refFor(jid);
      if (auto) {
        if (auto.paid_at) return null;
        const same = Number(auto.total) === total && JSON.stringify((auto.data.lines || []).map(function (l) { return [l.desc, Number(l.amount)]; })) === JSON.stringify(lines.map(function (l) { return [l.desc, l.amount]; }));
        if (same) return null;
        const data = Object.assign({}, auto.data, { lines: lines, sub: total, vat: 0, total: total });
        await p.query('UPDATE invoices SET total = $2, data = $3 WHERE id = $1', [auto.id, total, JSON.stringify(data)]);
        await refreshJobInvoice(p, jid);
        await p.query('INSERT INTO job_updates (job_id, kind, body) VALUES ($1, $2, $3)', [jid, 'change', 'Invoice ' + auto.number + ' updated automatically: ' + gbp(auto.total) + ' → ' + gbp(total) + '.']);
        return { id: auto.id, updated: true };
      }
      // The landlord: on the job, else the one linked to the property.
      const ll = (await p.query('SELECT l.name, l.email, l.phone, l.address FROM property_landlords pl JOIN landlords l ON l.id = pl.landlord_id WHERE pl.property_key = $1', [propKey(j.property_address || '')])).rows[0] || {};
      const today = londonDay(), number = 'INV-' + ref;
      const data = { number: number, title: 'Repair ' + ref, date: today, due: addDaysIso(today, INVOICE.paymentDays || 14), ref: number,
        landlord: j.landlord_name || ll.name || '', landlordEmail: j.landlord_email || ll.email || '', landlordPhone: j.landlord_phone || ll.phone || '', landlordAddress: j.landlord_address || ll.address || '',
        lines: lines, sub: total, vat: 0, total: total, auto: true };
      const id = (await p.query('INSERT INTO invoices (job_id, number, total, landlord_name, landlord_email, data) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [jid, number, total, data.landlord || null, data.landlordEmail || null, JSON.stringify(data)])).rows[0].id;
      await refreshJobInvoice(p, jid);
      await p.query('INSERT INTO job_updates (job_id, kind, body) VALUES ($1, $2, $3)', [jid, 'change', 'Invoice ' + number + ' created automatically for ' + gbp(total) + (data.landlord ? ' to ' + data.landlord : '') + ' — check it and send it from the Money tab.']);
      return { id: id, created: true };
    } catch (err) { console.error('Automatic invoice failed:', err.message); return null; }
  }
  async function refreshJobInvoice(p, jid) {
    const last = (await p.query('SELECT number, total, created_at FROM invoices WHERE job_id = $1 ORDER BY id DESC LIMIT 1', [jid])).rows[0];
    await p.query('UPDATE jobs SET invoice_number = $2, invoice_total = $3, invoiced_at = $4, updated_at = now() WHERE id = $1',
      [jid, last ? last.number : null, last ? last.total : null, last ? last.created_at : null]);
  }
  app.delete('/api/admin/invoices/:id', withDb(async function (p, req, res) {
    const r = await p.query('DELETE FROM invoices WHERE id = $1 RETURNING job_id, tenancy_id, number, total, landlord_name, paid_at', [jobId(req)]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'not-found' });
    const x = r.rows[0];
    if (x.job_id) await refreshJobInvoice(p, x.job_id);
    await invoiceNote(p, x, 'Invoice ' + (x.number || '') + ' deleted (' + gbp(x.total) + (x.landlord_name ? ', ' + x.landlord_name : '') + (x.paid_at ? ', was marked paid' : '') + ').', 'change');
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
    const cur = await p.query('SELECT i.id, i.job_id, i.tenancy_id, i.number, i.total, coalesce(j.property_address, i.address) AS property_address FROM invoices i LEFT JOIN jobs j ON j.id = i.job_id WHERE i.id = $1', [jobId(req)]);
    if (!cur.rows.length) return res.status(404).json({ ok: false, error: 'not-found' });
    const inv = cur.rows[0];
    const number = str(b.invoice_number, 50) || inv.number;
    const clean = cleanInvoiceData(b.data, number, total);
    await p.query('UPDATE invoices SET number = $2, total = $3, landlord_name = $4, landlord_email = $5, data = $6 WHERE id = $1',
      [inv.id, number, total, clean.landlord, clean.landlordEmail, JSON.stringify(clean)]);
    // Keep the job's invoice summary in step when this is its latest invoice.
    const latest = inv.job_id ? await p.query('SELECT max(id) AS id FROM invoices WHERE job_id = $1', [inv.job_id]) : { rows: [{}] };
    if (inv.job_id && latest.rows[0].id === inv.id) await p.query('UPDATE jobs SET invoice_number = $2, invoice_total = $3, updated_at = now() WHERE id = $1', [inv.job_id, number, total]);
    if (str(b.landlord_name)) await ensureLandlord(p, b, inv.property_address);
    const changes = [];
    if (number !== inv.number) changes.push('number ' + inv.number + ' → ' + number);
    if (Number(inv.total) !== total) changes.push('total ' + gbp(inv.total) + ' → ' + gbp(total));
    await invoiceNote(p, inv, 'Invoice ' + number + ' edited' + (changes.length ? ' (' + changes.join(', ') + ')' : '') + '.', 'email');
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

  // A file shared from Google Drive ("Anyone with the link"): Google Docs are
  // downloaded as PDF, other files as they are. Only the file ID is taken from
  // the link; the download address is always Google's own.
  async function fetchDriveFile(link) {
    link = String(link || '').trim();
    let u; try { u = new URL(link); } catch (e) { return { error: 'drive-link' }; }
    if (!/(^|\.)(drive|docs)\.google\.com$/i.test(u.hostname)) return { error: 'drive-link' };
    const m = /\/(document|spreadsheets|presentation|file)\/d\/([\w-]{10,})/.exec(u.pathname), id = (m && m[2]) || (/^[\w-]{10,}$/.test(u.searchParams.get('id') || '') ? u.searchParams.get('id') : '');
    if (!id) return { error: 'drive-link' };
    const kind = m ? m[1] : 'file';
    const url = kind === 'document' ? 'https://docs.google.com/document/d/' + id + '/export?format=pdf'
      : kind === 'file' ? 'https://drive.google.com/uc?export=download&id=' + id : null;
    if (!url) return { error: 'drive-type' };
    let r;
    try { r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30000) }); } catch (e) { return { error: 'drive-fetch' }; }
    const type = String(r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!r.ok || type === 'text/html') return { error: 'drive-private' };   // a sign-in page: not shared with "Anyone with the link"
    const len = parseInt(r.headers.get('content-length') || '0', 10);
    if (len > 15 * 1024 * 1024) return { error: 'file-too-big' };
    const buf = Buffer.from(await r.arrayBuffer());
    const cd = String(r.headers.get('content-disposition') || '');
    let name = ''; const n1 = /filename\*=UTF-8''([^;]+)/i.exec(cd), n2 = /filename="([^"]+)"/i.exec(cd);
    try { name = n1 ? decodeURIComponent(n1[1]) : n2 ? n2[1] : ''; } catch (e) { name = n2 ? n2[1] : ''; }
    if (!name) name = kind === 'document' ? 'Google Doc.pdf' : 'Drive file';
    let mime = type;
    if (!mime || mime === 'application/octet-stream') mime = /\.pdf$/i.test(name) ? 'application/pdf' : /\.docx$/i.test(name) ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : /\.jpe?g$/i.test(name) ? 'image/jpeg' : /\.png$/i.test(name) ? 'image/png' : mime;
    return { buf: buf, name: name, mime: mime };
  }

  // ---------- Assistant: plain-English (or spoken) commands ----------
  // Turns something like "add a gas safety for 6 Whitworth House" into a
  // structured job draft. Nothing is created here: the dashboard matches the
  // property, tenant and contractor and shows the draft for staff to confirm.
  app.post('/api/admin/assistant', withDb(async function (p, req, res) {
    if (!opts.askAi || !opts.canAi || !opts.canAi()) return res.status(503).json({ ok: false, error: 'ai-not-configured' });
    // Pasted messages can carry invisible direction marks around phone numbers.
    let text = str(String((req.body || {}).text || '').replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, ''), 6000);
    // An attached document (e.g. a Terms of Let): Word files are read here;
    // PDFs and photos go to the AI as they are.
    // Attached documents (e.g. a Terms of Let, and the landlord statement with
    // its charges): Word files are read here; PDFs and photos go to the AI as
    // they are; Google Drive / Docs share links are fetched from Google first.
    const body = req.body || {};
    const given = (Array.isArray(body.files) ? body.files : body.file ? [body.file] : []).slice(0, 5);
    const files = [], names = [], txtNames = [];
    let fileNote = '';
    for (let fi = 0; fi < given.length; fi++) {
      let file = given[fi];
      if (!file) continue;
      if (file.drive) {
        const got = await fetchDriveFile(file.drive);
        if (got.error) return res.status(400).json({ ok: false, error: got.error, file_index: fi });
        file = got;
      }
      if (!file.data && !file.buf) continue;
      const buf = file.buf || Buffer.from(String(file.data), 'base64'), fname = str(String(file.name || 'document'), 200), mime = String(file.mime || '').toLowerCase();
      if (!buf.length || buf.length > 15 * 1024 * 1024) return res.status(400).json({ ok: false, error: 'file-too-big' });
      if (/\.docx$/i.test(fname) || /wordprocessingml/.test(mime)) {
        const words = docxText(buf);
        if (!words) return res.status(400).json({ ok: false, error: 'file-unreadable' });
        fileNote += '\n\nAttached document "' + fname + '":\n' + words.slice(0, 40000);
      } else if (mime === 'application/pdf' || /\.pdf$/i.test(fname)) { files.push({ mime: 'application/pdf', data: buf.toString('base64') }); names.push(fname); }
      // A plain text file (e.g. the tenants' names, numbers and emails sent with a Terms of Let).
      else if (/^text\/plain/.test(mime) || /\.txt$/i.test(fname)) {
        const words = buf.toString('utf8').replace(/^\uFEFF/, '').replace(/\r/g, '').slice(0, 20000).trim();
        if (!words) return res.status(400).json({ ok: false, error: 'file-unreadable' });
        txtNames.push(fname);
        fileNote += '\n\nAttached text file "' + fname + '":\n' + words;
      }
      else if (/^image\/(jpeg|png|webp|heic|heif)$/.test(mime)) { files.push({ mime: mime, data: buf.toString('base64') }); names.push(fname); }
      else return res.status(400).json({ ok: false, error: 'file-type' });
    }
    if (given.length) {
      if (!text) text = 'Work out what the attached document' + (given.length > 1 ? 's are' : ' is') + ': a Terms of Let / tenancy details for a new let (create the tenancy' + (given.length > 1 ? ', with the landlord statement for it if there is one' : '') + '), or a gas safety record (CP12 / landlord gas safety record), EICR (electrical installation condition report) or EPC (record the certificate for the property it is for).';
      // Started from a property already on file: the tenancy is for that property.
      const forProp = str(body.for_property, 300);
      if (forProp) text += '\n\nThis tenancy is for the property already on file: ' + forProp + ' — use exactly this address for it.';
      // Every document by name, in order, so each can be identified.
      if (given.length > 1) fileNote += '\n\n(Attached documents, in order: ' + given.map(function (g, i) { return (i + 1) + '. "' + str(String((g && g.name) || (g && g.drive ? 'Google Drive file' : 'document')), 120) + '"'; }).join(', ') + '. Work out what each one is — the Terms of Let, a landlord statement, a tenant contact sheet, a certificate — and use them all together for the same tenancy.)';
      // A text file sent with a Terms of Let: the tenants for that same let.
      if (txtNames.length && given.length > txtNames.length) fileNote += '\n\n(The text file' + (txtNames.length > 1 ? 's' : '') + ' ' + txtNames.map(function (n) { return '"' + n + '"'; }).join(', ') + ' came with the other document' + (given.length - txtNames.length > 1 ? 's' : '') + ': unless it clearly says otherwise, the people in it are the TENANTS (and any guarantors) of the property in the Terms of Let — put them, with their phone numbers and emails, in that tenancy\'s tenants (merged with any already named there, no duplicates). Do not make contacts, a property or another tenancy from them.)';
      if (names.length) fileNote += '\n\n(' + (names.length > 1 ? 'The documents ' + names.map(function (n) { return '"' + n + '"'; }).join(', ') + ' are' : 'The document "' + names[0] + '" is') + ' attached; read ' + (names.length > 1 ? 'them' : 'it') + ' in full.)';
    }
    if (!text) return res.status(400).json({ ok: false, error: 'no-text' });
    const said = text;
    text = text + fileNote;
    const trades = (await p.query('SELECT name, trade FROM contractors WHERE active ORDER BY name')).rows
      .map(function (c) { return c.name + (c.trade ? ' (' + c.trade + ')' : ''); }).join('; ');
    const fromEmail = (req.body || {}).mode === 'email';
    // Our properties, so a mis-heard or shortened address ("36 Balin house") becomes the one on file.
    const known = (await allProperties(p)).map(function (x) { return x.address; }).filter(Boolean).slice(0, 500);
    const prompt = fromEmail ? emailPrompt(text, trades) : 'You turn instructions from a UK letting agent\'s maintenance manager into repair jobs for their job system.\n\n' +
      'Instruction (spoken via speech-to-text, so allow for mis-heard words, or a pasted message that may list several properties, each with its tasks and tenant contacts, or an attached document such as a Terms of Let), between the ---- lines:\n----\n' + text + '\n----\n\n' +
      'Their contractors: ' + (trades || 'none listed') + '.\n\n' +
      (known.length ? 'Their properties (use the exact address from this list when the one said is clearly one of these, allowing for mis-heard or shortened names and a missing "Flat"; the door number and flat number must match EXACTLY — "23 John Maurice Close" is NOT "21 John Maurice Close", a different number on the same street or building is a different property, so then give the address as written; but when a document gives only a building name with no flat or door number — e.g. a licence for "Brunlees House, Rockingham Estate, SE1 6QF" — and exactly one of their properties is in that building, use that property): ' + known.join(' | ') + '\n\n' : '') +
      'For every job, property, tenancy and certificate also give "address_written": the address exactly as it appears in the instruction or document (before any matching to their list).\n\n' +
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
      'The instruction may instead (or also) ask to ADD A PROPERTY, usually with the tenants who live there (e.g. "add 36 Balin House, tenants Sarah Jones 07700 900123 and Tom Lee", "new property Flat 2, 10 Long Lane SE1 4PA, landlord Mr Khan, key 12"). ' +
      'Do not make a job for that, and do not also list those tenants or that landlord in "contacts". Put each in "properties" with: address (full as given, or the exact one from their property list if it clearly matches; keep flat/house number and postcode), ' +
      'tenants ([{"name": "", "phone": "", "email": ""}] exactly as given), landlord (name as given, else ""), key_number (the office key tag number if given, else ""), notes (anything else useful, else "").\n' +
      'The instruction may instead be the details of a NEW TENANCY (a new let: property, tenants, rent, start date, landlord, deposit, fees — e.g. a pasted offer, Terms of Let or notes). ' +
      'Do not make a job or contacts for that — its tenants, guarantors and landlord go inside the tenancy, never also in "contacts". Put it in "tenancies" with: address (full, keep flat/house number and postcode), start_date (the tenancy start date — on a Terms of Let often called the "move-in date" or "move in"; they are the same date), move_in_due (the deadline for paying the move-in monies / first rent and deposit — not the move-in date; "" if no separate deadline is given), date_taken (the date the holding deposit was paid — the same as holding_date), checkin_date (all YYYY-MM-DD; today is ' + new Date().toISOString().slice(0, 10) + '; "" if not given), ' +
      'checkin_time ("HH:MM" or ""), checkin_type ("clerk" if an inventory clerk / check-in is booked, "diy" for a DIY check-in / tenant\'s own inventory, "" if not said), term_months, break_months, rent_pcm (the RENT for the property in pounds per calendar month — the agreed rent itself, NOT the first payment, balance due, move-in monies, total, rent less the holding deposit, deposit, or any fee; if the rent is given per week, rent_pcm = weekly × 52 / 12; if per year, ÷ 12), ' +
      'rent_text (the rent copied EXACTLY as printed in the document, with its amount and period, e.g. "£1,650.00 per calendar month" or "£380 pw"; "" if none), deposit, holding (holding deposit / reservation fee paid) — numbers or null if not given, holding_date (when the holding deposit was paid, YYYY-MM-DD or ""), ' +
      'deposit_by ("agent" if we/the agent register it, "landlord" if the landlord does, "" if not said), deposit_scheme, negotiator, service ("Tenant Find", "Rent Collection", "Fully Managed" or "Rent4Rent" — rent-to-rent, where a company rents the property to sublet it), ' +
      'find_pct, collect_pct, manage_pct (percentages as numbers, or null), find_basis and manage_basis ("upfront" or "monthly"). How fees work at this agency: Tenant Find — the letting fee (find_pct) is a % of the annual rent taken up front (find_basis "upfront"); Rent Collection — the same letting % split monthly (find_pct with find_basis "monthly"; collect_pct only if a separate extra collection fee is stated); Fully Managed — the management % (manage_pct) taken monthly or up front as agreed (manage_basis), sometimes with a letting fee as well (find_pct and find_basis, only if one is stated); Rent4Rent — the agency rents the property from the landlord and re-lets it, no VAT (vat false). ' +
      'tenants and guarantors (each [{"name": "", "email": "", "phone": ""}], names with titles as given), landlord ({"name": "", "email": "", "phone": "", "line1": "", "line2": "", "country": "", "postcode": ""} — their own address), ' +
      'fees (other fees charged to the landlord: [{"label": "", "amount": 0, "novat": false}] — "novat": true when that charge has no VAT on it, e.g. the statement shows £0.00 VAT against it or says no VAT / exempt / at cost), credits (money IN for the landlord shown on a landlord statement income other than the rent and deposit, e.g. a refund: [{"label": "B&Q refund", "amount": 0}]), notes (anything else useful).\n' +
      'When SEVERAL DOCUMENTS come together, first work out what each one is: the TERMS OF LET (the tenancy details); a LANDLORD STATEMENT (statement of account / landlord statement / invoice or breakdown of what is deducted from the landlord — its charges go in that tenancy\'s fees as below); a TENANT CONTACT SHEET (names, phone numbers and emails of the tenants and any guarantors — they go in that tenancy\'s tenants / guarantors, merged with any already named, never in "contacts"); or a certificate. All of them are for the same tenancy unless they clearly show a different property. ' +
      'Also return "documents": one entry per attached document, [{"name": "the file name", "kind": "terms_of_let" | "landlord_statement" | "tenant_contacts" | "certificate" | "other"}]. ' +
      'If a LANDLORD STATEMENT (statement of account to the landlord) is attached with it, add every charge or deduction made to the landlord for this let to that tenancy\'s fees, labelled as on the statement (e.g. "Inventory", "Tenancy agreement", "Deposit registration", "Referencing", "Gas safety certificate"), with the amount BEFORE VAT (if the statement shows VAT separately, use the net figure; if it says the amount includes VAT, divide by 1.2). Look at the VAT on EACH line: statements often have a VAT column, and some charges (e.g. a council licence fee passed on at cost) show £0.00 VAT — give those "novat": true and their full amount; when the VAT column shows VAT on a line, leave novat false. ' +
      'Do not put in fees: rent received, deposits or holding deposits, money paid to the landlord, a VAT line on its own, or the main tenant find / letting / management commission — give that as find_pct / collect_pct / manage_pct (and find_basis) instead, unless only a £ amount is shown for it with no percentage, in which case put it in fees. Fill in any other tenancy details the statement gives that the Terms of Let leaves out.\n' +
      'The instruction may instead (or also) RECORD A CERTIFICATE the property already has — a gas safety certificate, EICR or EPC with a date it was done, starts, is valid from, issued or expires ' +
      '(e.g. "add a gas safety for 134 Regina Road starting on 22/5/26", "EICR at 9 Park Road done 3 March 2025", "gas cert for Flat 2 expires 1/6/27", or a list such as "gas safety expiry: 30/03/2026 / eicr expiry: 7/6/24" with the property on another line — one certificate each, all for that property). ' +
      'That is NOT a job (a job is when a check needs booking or doing, with no date it was done) — even when the expiry date given has already passed, record it as a certificate, not a job. ' +
      'Put each in "certificates" with: address (as said, or the exact one from their property list if it clearly matches), type ("Gas", "EICR" or "EPC"), issued_on (the date done / started / valid from, YYYY-MM-DD, UK dates are day/month/year, 2-digit years are 20xx; "" if only an expiry is given), ' +
      'expires_on (YYYY-MM-DD if an expiry is given, else ""), reference (certificate number if given, else ""), rating (EPC rating letter if given, else ""), document (the number of the attached document it was read from — 1 for the first attached, 2 for the second — or 0 if from the text).\n' +
      'A council PROPERTY LICENCE (selective / additional HMO / mandatory HMO licence, e.g. "Property licence under section 64 of the Housing Act 2004") attached or described is recorded in "certificates" too, with type "Licence", issued_on = valid from, expires_on = expiry date, reference = licence reference, plus licence_type ("Selective", "Additional (HMO)" or "Mandatory HMO" — a House in Multiple Occupation licence is "Additional (HMO)" unless it says mandatory), holder (licence holder) and council. ' +
      'An ATTACHED CERTIFICATE (gas safety record / CP12 / LGSR, EICR, or EPC) is recorded the same way: address = the address of the property inspected (the installation / site / premises address — NOT the landlord\'s, agent\'s or engineer\'s company address), ' +
      'type, issued_on = the inspection / check date (or date of assessment for an EPC), expires_on = the date the next check is due if printed ("next inspection due", "recommended date for next inspection", "valid until"; else ""), reference = the certificate / report / serial number. Do not make a job for it.\n' +
      'Reply with ONLY JSON: {"jobs": [{"address": "", "category": "", "title": "", "description": "", "urgency": "Routine", "contractor": "", "send": false, "tenants": [], "warning": ""}], ' +
      '"certificates": [{"address": "", "type": "Gas", "issued_on": "", "expires_on": "", "reference": "", "rating": "", "document": 0}], ' +
      '"documents": [], "contacts": [{"type": "contractor", "name": "", "company": "", "trade": "", "phone": "", "email": "", "address": "", "property": "", "notes": ""}], "properties": [{"address": "", "tenants": [], "landlord": "", "key_number": "", "notes": ""}], "tenancies": [], "understood": true}. ' +
      'Use [] for jobs, certificates, contacts, properties or tenancies when there are none. If the instruction is none of these, reply {"jobs": [], "certificates": [], "contacts": [], "properties": [], "tenancies": [], "understood": false}.';
    const result = await opts.askAi(prompt, true, files);
    if (!result.ok) return res.status(502).json({ ok: false, error: 'ai-failed' });
    let parsed = null;
    try { parsed = JSON.parse(result.text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()); } catch (e) { parsed = null; }
    if (!parsed) return res.status(502).json({ ok: false, error: 'ai-bad-reply' });
    const jobs = (Array.isArray(parsed.jobs) ? parsed.jobs : []).slice(0, 20).map(function (j) {
      return {
        address: keepWrittenAddress(str(j.address, 300) || '', str(j.address_written, 300)), category: str(j.category, 100) || '', title: str(j.title, 200) || '',
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
      if (t && t.address_written) t.address = keepWrittenAddress(t.address, str(t.address_written, 300));
      const d = cleanTenancy(t || {});
      if (!(t && t.break_months)) d.break_months = 0;
      if (!(t && (t.deposit_by === 'agent' || t.deposit_by === 'landlord'))) d.deposit_by = null;
      if (!(t && (t.find_basis === 'upfront' || t.find_basis === 'monthly'))) d.find_basis = null;
      if (!(t && (t.manage_basis === 'upfront' || t.manage_basis === 'monthly'))) d.manage_basis = null;
      if (t && (t.vat === false || /rent\s*4\s*rent/i.test(String(t.service || '')))) d.vat = false;
      // The rent as printed decides: its amount and period (per month / week / year)
      // give the monthly rent, in case the reply took the wrong figure or period.
      const rt = str(t && t.rent_text, 120) || '', fromText = rentFromText(rt);
      if (fromText && Math.abs(fromText - (Number(d.rent_pcm) || 0)) > 1) d.rent_pcm = fromText;
      d.rent_text = rt;
      d.rent_check = rentCheck(Number(d.rent_pcm) || 0, Number(d.deposit) || 0, Number(d.holding) || 0);
      return d;
    }).filter(function (d) { return d.address || d.tenants.length; });
    const properties = (Array.isArray(parsed.properties) ? parsed.properties : []).slice(0, 10).map(function (x) {
      return {
        address: keepWrittenAddress(str(x && x.address, 500) || '', str(x && x.address_written, 500)), landlord: str(x && x.landlord, 200) || '', key_number: str(x && x.key_number, 40) || '', notes: str(x && x.notes, 500) || '',
        tenants: (Array.isArray(x && x.tenants) ? x.tenants : []).slice(0, 12).map(function (t) { return { name: str(t && t.name, 200) || '', phone: str(t && t.phone, 50) || '', email: str(t && t.email, 200) || '' }; })
          .filter(function (t) { return t.name || t.phone || t.email; })
      };
    }).filter(function (x) { return x.address; });
    // People from a text file sent with a Terms of Let belong to that tenancy:
    // any the reply put in contacts as tenants are moved into its tenants.
    const docs = (Array.isArray(parsed.documents) ? parsed.documents : []).slice(0, 5).map(function (x) {
      return { name: str(x && x.name, 120) || '', kind: ['terms_of_let', 'landlord_statement', 'tenant_contacts', 'certificate', 'other'].indexOf(x && x.kind) !== -1 ? x.kind : 'other' };
    });
    if (tenancies.length === 1 && docs.length) {
      const tc = tenancies[0], fees = (tc.fees || []).filter(function (f) { return f && f.label; });
      tc.docs_read = docs;
      // A landlord statement came, but no charges were taken from it: say so on the card.
      if (docs.some(function (x) { return x.kind === 'landlord_statement'; }) && !fees.length) tc.fees_check = 'A landlord statement was attached but no charges were read from it — please check the fees.';
    } else if (tenancies.length === 1 && given.length > 1 && !(tenancies[0].fees || []).some(function (f) { return f && f.label; }) && given.some(function (g) { return /statement/i.test(String((g && g.name) || '')); })) {
      tenancies[0].fees_check = 'A landlord statement seems to be attached but no charges were read from it — please check the fees.';
    }
    if ((txtNames.length || docs.some(function (x) { return x.kind === 'tenant_contacts'; })) && tenancies.length === 1) {
      const tc = tenancies[0], tail = function (v) { return String(v || '').replace(/\D/g, '').slice(-10); };
      for (let i = contacts.length - 1; i >= 0; i--) {
        const c = contacts[i]; if (c.type !== 'tenant') continue;
        const dup = (tc.tenants || []).filter(function (t) { return (c.phone && tail(t.phone) === tail(c.phone)) || (c.email && String(t.email || '').toLowerCase() === c.email.toLowerCase()) || (c.name && String(t.name || '').toLowerCase() === c.name.toLowerCase()); })[0];
        if (dup) { if (!dup.phone) dup.phone = c.phone; if (!dup.email) dup.email = c.email; }
        else (tc.tenants = tc.tenants || []).push({ name: c.name, email: c.email, phone: c.phone });
        contacts.splice(i, 1);
      }
    }
    // Certificates the property already has (date done / expiry): saved after staff check them.
    const certificates = (Array.isArray(parsed.certificates) ? parsed.certificates : []).slice(0, 10).map(function (c) {
      const type = c && (CERT_TYPES[c.type] || c.type === 'Licence') ? c.type : null;
      const doc = parseInt(c && c.document, 10);
      return { licence_type: str(c && c.licence_type, 60) || '', holder: str(c && c.holder, 200) || '', council: str(c && c.council, 80) || '',
        address: oneInBuilding(keepWrittenAddress(str(c && c.address, 500) || '', str(c && c.address_written, 500)), known), type: type, issued_on: isoDay(c && c.issued_on) || '', expires_on: isoDay(c && c.expires_on) || '', reference: str(c && c.reference, 100) || '', rating: str(c && c.rating, 5) || '',
        document: doc >= 1 && doc <= given.length ? doc : (given.length === 1 && !certLines(said).length ? 1 : 0) };
    }).filter(function (c) { return c.address && c.type && (c.issued_on || c.expires_on); });
    // Certificate lines read straight from the text, in case the reply missed one
    // or took a past expiry for a job to book: their dates are taken as written.
    const lines = fromEmail ? [] : certLines(said);
    lines.forEach(function (c) {
      const have = certificates.filter(function (x) { return x.type === c.type; })[0];
      if (have) { if (c.expires_on) have.expires_on = c.expires_on; if (c.issued_on) have.issued_on = c.issued_on; if (!have.address) have.address = c.address; return; }
      const addr = (certificates[0] && certificates[0].address) || (jobs[0] && jobs[0].address) || (properties[0] && properties[0].address) || c.address;
      if (addr) certificates.push({ address: addr, type: c.type, issued_on: c.issued_on, expires_on: c.expires_on, reference: '', rating: '' });
    });
    if (lines.length) {
      const re = { Gas: /gas|cp12/i, EICR: /eicr|electric/i, EPC: /\bepc\b|energy performance/i };
      for (let i = jobs.length - 1; i >= 0; i--) if (lines.some(function (c) { return re[c.type].test(jobs[i].title + ' ' + jobs[i].category); })) jobs.splice(i, 1);
    }
    res.json({ ok: true, jobs: jobs, certificates: certificates, contacts: contacts, properties: properties, tenancies: tenancies, understood: (parsed.understood !== false || certificates.length > 0) && (jobs.length > 0 || certificates.length > 0 || contacts.length > 0 || properties.length > 0 || tenancies.length > 0) });
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

  // ---------- The landlord's own page (/l/<token>) ----------
  // Their properties, every repair (open and completed) with what it cost them,
  // invoices and certificates. Never shows our costs or profit, contractor
  // names or tenants' contact details.
  // Their page / job link was sent (WhatsApp or email): remember when and how.
  app.post('/api/admin/:who(landlords|contractors)/:id/link-sent', withDb(async function (p, req, res) {
    const how = str((req.body || {}).how, 20) || 'message', table = req.params.who === 'landlords' ? 'landlords' : 'contractors';
    const sent = { how: how, at: new Date().toISOString() };
    const r = await p.query('UPDATE ' + table + ' SET link_sent = $2 WHERE id = $1 RETURNING id', [parseInt(req.params.id, 10) || 0, JSON.stringify(sent)]);
    res.json({ ok: r.rowCount > 0, sent: sent });
  }));
  app.post('/api/admin/landlords/:id/portal-link', withDb(async function (p, req, res) {
    const id = jobId(req), fresh = !!(req.body || {}).fresh;
    const l = (await p.query('SELECT id, portal_token FROM landlords WHERE id = $1', [id])).rows[0];
    if (!l) return res.status(404).json({ ok: false, error: 'not-found' });
    let token = l.portal_token;
    if (!token || fresh) {
      token = crypto.randomBytes(18).toString('base64url');
      await p.query('UPDATE landlords SET portal_token = $2, updated_at = now() WHERE id = $1', [id, token]);
    }
    const siteUrl = process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : req.protocol + '://' + req.get('host'));
    res.json({ ok: true, url: siteUrl + '/l/' + token });
  }));
  // A landlord (by their link) and the property keys that are theirs.
  async function landlordByToken(p, token) {
    token = String(token || '');
    const l = /^[A-Za-z0-9_-]{20,}$/.test(token) ? (await p.query('SELECT id, name FROM landlords WHERE portal_token = $1', [token])).rows[0] : null;
    if (!l) return null;
    const keys = {};
    (await p.query('SELECT property_key, address FROM property_landlords WHERE landlord_id = $1', [l.id])).rows.forEach(function (r) { keys[r.property_key] = r.address; });
    return { l: l, keys: keys };
  }
  // Every charge to the landlord, for their accounts (CSV).
  app.get('/l/:token/costs.csv', withDb(async function (p, req, res) {
    const who = await landlordByToken(p, req.params.token);
    if (!who) return res.status(404).send('Not found');
    const rows = (await p.query(`SELECT id, status, created_at, completed_at, category, affected, symptom, summary, property_address, landlord_charge,
        (SELECT coalesce(sum(jp.charge), 0) FROM job_parts jp WHERE jp.job_id = jobs.id) AS parts_charge,
        (SELECT string_agg(jp.description, '; ' ORDER BY jp.id) FROM job_parts jp WHERE jp.job_id = jobs.id AND jp.charge IS NOT NULL) AS parts,
        (SELECT i.number FROM invoices i WHERE i.job_id = jobs.id ORDER BY i.id DESC LIMIT 1) AS inv_no,
        (SELECT i.created_at FROM invoices i WHERE i.job_id = jobs.id ORDER BY i.id DESC LIMIT 1) AS inv_at,
        (SELECT i.total FROM invoices i WHERE i.job_id = jobs.id ORDER BY i.id DESC LIMIT 1) AS inv_total,
        (SELECT i.paid_at FROM invoices i WHERE i.job_id = jobs.id ORDER BY i.id DESC LIMIT 1) AS inv_paid
      FROM jobs WHERE archived_at IS NULL AND status <> 'Cancelled' ORDER BY coalesce(completed_at, created_at)`)).rows
      .filter(function (j) { return who.keys[propKey(j.property_address)] !== undefined; });
    const d = function (v) { return v ? new Date(v).toISOString().slice(0, 10) : ''; };
    const q = function (v) { const t = String(v == null ? '' : v); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
    const n = function (v) { return v == null || v === '' ? '' : Number(v).toFixed(2); };
    const lines = [['Reference', 'Property', 'Repair', 'Status', 'Reported', 'Completed', 'Work charge', 'Parts', 'Parts charge', 'Total', 'Invoice', 'Invoice date', 'Invoice total', 'Paid'].join(',')];
    rows.forEach(function (j) {
      const tot = (j.landlord_charge == null ? 0 : Number(j.landlord_charge)) + Number(j.parts_charge || 0);
      lines.push([refFor(j.id), j.property_address, j.summary || [j.affected, j.symptom].filter(Boolean).join(' – ') || j.category, j.status, d(j.created_at), d(j.completed_at),
        n(j.landlord_charge), j.parts || '', Number(j.parts_charge) ? n(j.parts_charge) : '', j.landlord_charge == null && !Number(j.parts_charge) ? '' : n(tot),
        j.inv_no || '', d(j.inv_at), n(j.inv_total), j.inv_no ? (j.inv_paid ? 'Paid ' + d(j.inv_paid) : 'Not yet') : ''].map(q).join(','));
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="repair-costs.csv"');
    res.setHeader('X-Robots-Tag', 'noindex');
    res.send('\ufeff' + lines.join('\r\n'));
  }));
  // One of their invoices, as issued, with how to pay.
  // A repair reported by the landlord from their page: arranged by us, or by them.
  app.post('/l/:token/jobs', withDb(async function (p, req, res) {
    if (portalLimited(req)) return res.status(429).json({ ok: false, error: 'rate-limited' });
    const who = await landlordByToken(p, req.params.token);
    if (!who) return res.status(404).json({ ok: false, error: 'not-found' });
    const b = req.body || {}, k = String(b.key || ''), title = str(b.title, 200), details = str(b.details, 3000);
    if (who.keys[k] === undefined) return res.status(404).json({ ok: false, error: 'not-your-property' });
    if (!title) return res.status(400).json({ ok: false, error: 'title-required' });
    const l = who.l, self = b.who === 'self', urgency = URGENCIES.indexOf(b.urgency) !== -1 ? b.urgency : 'Routine';
    const address = (await allProperties(p)).filter(function (x) { return x.key === k; }).map(function (x) { return x.address; })[0] || who.keys[k] || k;
    const t = (await p.query(`SELECT t.name, t.phone, t.email FROM property_tenants pt JOIN tenants t ON t.id = pt.tenant_id WHERE pt.property_key = $1 AND pt.moved_out_at IS NULL AND t.deleted_at IS NULL ORDER BY t.updated_at DESC LIMIT 1`, [k])).rows[0] || {};
    const due = new Date(Date.now() + DUE_HOURS[urgency] * 3600 * 1000);
    const r = await p.query(`INSERT INTO jobs (property_address, category, summary, description, urgency, source, status, due_at, tenant_name, tenant_phone, tenant_email, landlord_name, landlord_email, landlord_phone, landlord_handles)
      VALUES ($1, $2, $3, $4, $5, 'Landlord request', 'New', $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [address, 'General repair', title, details || title, urgency, due, t.name || null, t.phone || null, t.email || null, l.name || null, l.email || null, l.phone || null, self ? 'self' : null]);
    const id = r.rows[0].id;
    await ensureTrackToken(p, id);
    await p.query('INSERT INTO job_updates (job_id, kind, body) VALUES ($1, $2, $3)', [id, 'change', 'Reported by the landlord, ' + (l.name || '') + ' (landlord page)' + (self ? ' — they are arranging it themselves.' : ' — asked us to arrange it.')]);
    ntfy({ title: (self ? 'Landlord arranging repair: ' : 'Landlord reported repair: ') + refFor(id), message: (l.name || 'A landlord') + ' — ' + address + ': ' + title + (self ? ' (they’re arranging it)' : '') + '. Open Fixflow.', tags: ['house'] }).catch(function () {});
    res.json({ ok: true, id: id, ref: refFor(id) });
  }));
  // The landlord books the visit for a repair they're arranging themselves.
  app.post('/l/:token/jobs/:id/book', withDb(async function (p, req, res) {
    if (portalLimited(req)) return res.status(429).json({ ok: false, error: 'rate-limited' });
    const who = await landlordByToken(p, req.params.token);
    if (!who) return res.status(404).json({ ok: false, error: 'not-found' });
    const b = req.body || {}, date = apptDay(b.date) ? String(b.date) : null, time = str(b.time, 60), visitor = str(b.who, 120);
    if (!date) return res.status(400).json({ ok: false, error: 'date-required' });
    const j = (await p.query("SELECT id, property_address, landlord_handles, status FROM jobs WHERE id = $1 AND archived_at IS NULL", [jobId(req)])).rows[0];
    if (!j || who.keys[propKey(j.property_address)] === undefined || !j.landlord_handles || j.status === 'Completed' || j.status === 'Cancelled') return res.status(404).json({ ok: false, error: 'not-found' });
    await p.query("UPDATE jobs SET appointment_date = $2, appointment_time = $3, status = CASE WHEN status IN ('New', 'Assigned') THEN 'Contractor booked' ELSE status END, updated_at = now() WHERE id = $1", [j.id, date, time]);
    await p.query('INSERT INTO job_updates (job_id, kind, body) VALUES ($1, $2, $3)', [j.id, 'change', 'Visit booked by the landlord: ' + apptDay(date) + (time ? ' ' + time : '') + (visitor ? ' — ' + visitor : '') + '.']);
    res.json({ ok: true });
  }));
  // ---------- The landlord's own properties (not managed by us) ----------
  // Kept on their page so all their properties are in one place. The EPC is
  // looked up on the register when saved, and re-checked daily (see autoEpcAll).
  function cleanOwnData(b) {
    const lic = b.licence || {};
    return {
      rent: money(b.rent), tenancy_start: isoDay(b.tenancy_start) || '', gas: isoDay(b.gas) || '', eicr: isoDay(b.eicr) || '',
      licence: { status: ['licensed', 'applied', 'not_needed', 'unknown'].indexOf(lic.status) !== -1 ? lic.status : 'unknown', number: str(lic.number, 80) || '', expires: isoDay(lic.expires) || '' },
      tenants: (Array.isArray(b.tenants) ? b.tenants : []).slice(0, 8).map(function (t) { return { name: str(t && t.name, 120) || '', phone: str(t && t.phone, 40) || '', email: str(t && t.email, 160) || '' }; }).filter(function (t) { return t.name || t.phone || t.email; }),
      notes: str(b.notes, 2000) || ''
    };
  }
  async function ownEpc(p, row) {
    const m = POSTCODE_RE.exec(row.address || ''); if (!m) return null;
    let hit = null;
    try { hit = epcMatch(row.address, (await epcSearch((m[1] + ' ' + m[2]).toUpperCase())).results); } catch (err) { console.error('EPC lookup failed for own property ' + row.id + ':', err.message); return null; }
    const epc = hit ? { expires_on: hit.expires_on, rating: hit.rating || '', reference: hit.reference || '' } : null;
    if (epc) await p.query('UPDATE landlord_properties SET epc = $2, epc_checked_at = now() WHERE id = $1', [row.id, JSON.stringify(epc)]);
    else await p.query('UPDATE landlord_properties SET epc_checked_at = now() WHERE id = $1', [row.id]);
    return epc;
  }
  async function ownEpcAll(p) {
    const soon = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
    const rows = (await p.query(`SELECT id, address FROM landlord_properties WHERE epc_checked_at IS NULL
      OR (epc IS NULL AND epc_checked_at < now() - interval '30 days')
      OR (epc->>'expires_on' <= $1 AND epc_checked_at < now() - interval '7 days') ORDER BY id LIMIT 200`, [soon])).rows;
    for (const r of rows) { await ownEpc(p, r); await new Promise(function (res) { setTimeout(res, 1200); }); }
  }
  app.post('/l/:token/own', withDb(async function (p, req, res) {
    if (portalLimited(req)) return res.status(429).json({ ok: false, error: 'rate-limited' });
    const who = await landlordByToken(p, req.params.token);
    if (!who) return res.status(404).json({ ok: false, error: 'not-found' });
    const b = req.body || {}, address = tidyAddress(str(b.address, 300) || '');
    if (!address || !POSTCODE_RE.test(address)) return res.status(400).json({ ok: false, error: 'Please give the full address with its postcode.' });
    if (who.keys[propKey(address)] !== undefined) return res.status(400).json({ ok: false, error: 'We already manage this property — it’s on your page.' });
    const n = (await p.query('SELECT count(*)::int AS n FROM landlord_properties WHERE landlord_id = $1', [who.l.id])).rows[0].n;
    if (n >= 100) return res.status(400).json({ ok: false, error: 'too-many' });
    const r = await p.query('INSERT INTO landlord_properties (landlord_id, address, data) VALUES ($1, $2, $3) RETURNING id, address', [who.l.id, address, JSON.stringify(cleanOwnData(b))]);
    const epc = await ownEpc(p, r.rows[0]);
    ntfy({ title: 'Landlord added their own property', message: (who.l.name || 'A landlord') + ' added ' + address + ' to their page (not managed by us).', tags: ['house'] }).catch(function () {});
    res.json({ ok: true, id: r.rows[0].id, epc: epc });
  }));
  app.put('/l/:token/own/:id', withDb(async function (p, req, res) {
    if (portalLimited(req)) return res.status(429).json({ ok: false, error: 'rate-limited' });
    const who = await landlordByToken(p, req.params.token);
    if (!who) return res.status(404).json({ ok: false, error: 'not-found' });
    const b = req.body || {}, address = tidyAddress(str(b.address, 300) || '');
    if (!address || !POSTCODE_RE.test(address)) return res.status(400).json({ ok: false, error: 'Please give the full address with its postcode.' });
    const cur = (await p.query('SELECT id, address FROM landlord_properties WHERE id = $1 AND landlord_id = $2', [parseInt(req.params.id, 10) || 0, who.l.id])).rows[0];
    if (!cur) return res.status(404).json({ ok: false, error: 'not-found' });
    await p.query('UPDATE landlord_properties SET address = $2, data = $3, updated_at = now()' + (address !== cur.address ? ', epc = NULL, epc_checked_at = NULL' : '') + ' WHERE id = $1', [cur.id, address, JSON.stringify(cleanOwnData(b))]);
    if (address !== cur.address) await ownEpc(p, { id: cur.id, address: address });
    res.json({ ok: true });
  }));
  app.delete('/l/:token/own/:id', withDb(async function (p, req, res) {
    const who = await landlordByToken(p, req.params.token);
    if (!who) return res.status(404).json({ ok: false, error: 'not-found' });
    const r = await p.query('DELETE FROM landlord_properties WHERE id = $1 AND landlord_id = $2', [parseInt(req.params.id, 10) || 0, who.l.id]);
    res.json({ ok: r.rowCount > 0 });
  }));
  // "Would you manage this for me?" — a phone alert to the office.
  app.post('/l/:token/own/:id/manage', withDb(async function (p, req, res) {
    if (portalLimited(req)) return res.status(429).json({ ok: false, error: 'rate-limited' });
    const who = await landlordByToken(p, req.params.token);
    const row = who ? (await p.query('SELECT id, address FROM landlord_properties WHERE id = $1 AND landlord_id = $2', [parseInt(req.params.id, 10) || 0, who.l.id])).rows[0] : null;
    if (!row) return res.status(404).json({ ok: false, error: 'not-found' });
    await p.query("UPDATE landlord_properties SET data = data || jsonb_build_object('manage_asked', now()::text) WHERE id = $1", [row.id]);
    ntfy({ title: 'Landlord wants us to manage a property', message: (who.l.name || 'A landlord') + ' asked about us managing ' + row.address + '. Give them a call.', tags: ['house', 'star'] }).catch(function () {});
    res.json({ ok: true });
  }));

  // The tenant's original repair report (PDF), for a job at one of the landlord's properties.
  app.get('/l/:token/report/:id', withDb(async function (p, req, res) {
    res.setHeader('X-Robots-Tag', 'noindex'); res.setHeader('Referrer-Policy', 'no-referrer');
    const who = await landlordByToken(p, req.params.token);
    const r = who ? (await p.query('SELECT id, property_address, pdf, pdf_filename FROM jobs WHERE id = $1 AND archived_at IS NULL', [parseInt(req.params.id, 10) || 0])).rows[0] : null;
    if (!r || !r.pdf || who.keys[propKey(r.property_address)] === undefined) return res.status(404).type('html').send(trackShell('Report not found', '<h1>Report not found</h1>', true));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="' + ('Tenant-report-' + refFor(r.id) + '.pdf').replace(/[^a-zA-Z0-9.\-_]+/g, '-') + '"');
    res.send(r.pdf);
  }));
  // ---------- Landlords upload certificates ----------
  // The file is read for the type, dates, number and address; the landlord
  // checks them, then saves — to the property's certificates (ours), or to their
  // own property's record.
  const certFile = function (f) {
    if (!f || typeof f.data !== 'string') return null;
    const buf = Buffer.from(f.data.replace(/^data:[^,]*,/, ''), 'base64'), mime = String(f.mime || '').toLowerCase();
    if (!buf.length || buf.length > 15 * 1024 * 1024) return null;
    const m = mime === 'application/pdf' || /\.pdf$/i.test(String(f.name || '')) ? 'application/pdf' : /^image\/(jpeg|png|webp|heic|heif)$/.test(mime) ? mime : null;
    return m ? { buf: buf, mime: m, name: str(f.name, 200) || 'certificate.pdf' } : null;
  };
  async function landlordTarget(p, who, b) {
    if (b.own_id) {
      const o = (await p.query('SELECT id, address, data FROM landlord_properties WHERE id = $1 AND landlord_id = $2', [parseInt(b.own_id, 10) || 0, who.l.id])).rows[0];
      return o ? { own: o, address: o.address } : null;
    }
    const k = String(b.key || '');
    if (who.keys[k] === undefined) return null;
    const address = (await allProperties(p)).filter(function (x) { return x.key === k; }).map(function (x) { return x.address; })[0] || who.keys[k] || k;
    return { key: k, address: address };
  }
  // Read a certificate file (gas safety / EICR / EPC) for its type, dates,
  // number and the address inspected; warn if it looks like another property.
  async function readCertDoc(f, expectAddress) {
    const t = { address: expectAddress || '' };
    let got = {};
    if (opts.askAi && opts.canAi && opts.canAi()) {
      const r = await opts.askAi('This is a UK property document: a gas safety record (CP12 / LGSR), an EICR (electrical installation condition report), an EPC, or a council PROPERTY LICENCE (selective, additional HMO or mandatory HMO licence under the Housing Act 2004). Read it and reply with ONLY JSON: ' +
        '{"type": "Gas" | "EICR" | "EPC" | "Licence" | "", "address": "the address of the property inspected / licensed (not the landlord\'s, agent\'s, licence holder\'s or engineer\'s address)", "issued_on": "inspection / assessment date, or for a licence the date it is valid from, YYYY-MM-DD", ' +
        '"expires_on": "next inspection due / recommended next inspection / valid until / licence expiry date, YYYY-MM-DD, or \"\" if not printed", "reference": "certificate / report / licence reference number", "rating": "EPC rating letter or \"\"", ' +
        '"licence_type": "for a licence: \"Selective\", \"Additional (HMO)\" or \"Mandatory HMO\" (a House in Multiple Occupation licence under section 64 is HMO: \"Additional (HMO)\" unless it says mandatory), else \"\"", "holder": "licence holder name or \"\"", "council": "the council that issued it, e.g. Southwark, or \"\"", "max_occupants": "licence maximum number of people as a number, or null"}. UK dates are day/month/year.',
        true, [{ mime: f.mime, data: f.buf.toString('base64') }]).catch(function () { return { ok: false }; });
      if (r && r.ok) { try { got = JSON.parse(String(r.text).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()) || {}; } catch (e) { got = {}; } }
    }
    const type = CERT_TYPES[got.type] || got.type === 'Licence' ? got.type : '';
    let issued = isoDay(got.issued_on) || '', expires = isoDay(got.expires_on) || '';
    if (!expires && issued && CERT_TYPES[type]) { const d = new Date(issued + 'T12:00:00Z'); d.setUTCFullYear(d.getUTCFullYear() + CERT_TYPES[type].years); expires = d.toISOString().slice(0, 10); }
    const addr = str(got.address, 300) || '';
    // A certificate that looks like it's for somewhere else: say so.
    const pc = function (a) { const m = POSTCODE_RE.exec(String(a || '')); return m ? (m[1] + m[2]).toUpperCase() : ''; };
    const other = addr && t.address && ((pc(addr) && pc(t.address) && pc(addr) !== pc(t.address)) || (doorNumKey(addr) && doorNumKey(t.address) && doorNumKey(addr) !== doorNumKey(t.address)));
    return { read: !!type, type: type, issued_on: issued, expires_on: expires, reference: str(got.reference, 100) || '', rating: str(got.rating, 5) || '', address: addr,
      licence_type: str(got.licence_type, 60) || '', holder: str(got.holder, 200) || '', council: str(got.council, 80) || '', max_occupants: parseInt(got.max_occupants, 10) || null,
      warning: other ? 'This certificate seems to be for ' + addr + ', not ' + t.address + '. Please check it’s the right one.' : '' };
  }
  // A licence read from a document, as the property's licence.
  function licenceFromRead(d) {
    return { status: 'licensed', type: d.licence_type || '', number: d.reference || '', holder: d.holder || '', starts: d.issued_on || null, expires: d.expires_on || null, borough: d.council || '', max_occupants: d.max_occupants || null };
  }
  // The office drops a certificate on a property or tenancy: read it.
  app.post('/api/admin/certificates/read', withDb(async function (p, req, res) {
    const b = req.body || {}, f = certFile(b.file);
    if (!f) return res.status(400).json({ ok: false, error: 'Please use a PDF or a photo of the certificate (15 MB max).' });
    res.json(Object.assign({ ok: true }, await readCertDoc(f, str(b.address, 500) || '')));
  }));
  app.post('/l/:token/cert-read', withDb(async function (p, req, res) {
    if (portalLimited(req)) return res.status(429).json({ ok: false, error: 'rate-limited' });
    const who = await landlordByToken(p, req.params.token);
    if (!who) return res.status(404).json({ ok: false, error: 'not-found' });
    const b = req.body || {}, t = await landlordTarget(p, who, b), f = certFile(b.file);
    if (!t) return res.status(404).json({ ok: false, error: 'not-your-property' });
    if (!f) return res.status(400).json({ ok: false, error: 'Please choose a PDF or a photo of the certificate (15 MB max).' });
    res.json(Object.assign({ ok: true }, await readCertDoc(f, t.address)));
  }));
  app.post('/l/:token/cert-save', withDb(async function (p, req, res) {
    if (portalLimited(req)) return res.status(429).json({ ok: false, error: 'rate-limited' });
    const who = await landlordByToken(p, req.params.token);
    if (!who) return res.status(404).json({ ok: false, error: 'not-found' });
    const b = req.body || {}, t = await landlordTarget(p, who, b), f = certFile(b.file), type = CERT_TYPES[b.type] || b.type === 'Licence' ? b.type : null;
    if (!t) return res.status(404).json({ ok: false, error: 'not-your-property' });
    if (!type) return res.status(400).json({ ok: false, error: 'Please choose which certificate it is.' });
    const issued = isoDay(b.issued_on) || '', expires = isoDay(b.expires_on) || '';
    if (!expires) return res.status(400).json({ ok: false, error: 'Please enter the expiry date.' });
    if (type === 'Licence' && !t.own) {
      const out = await saveLicence(p, t.address, { status: 'licensed', type: str(b.licence_type, 60) || '', number: str(b.reference, 60) || '', holder: str(b.holder, 200) || '', starts: issued || null, expires: expires, borough: str(b.council, 80) || '' },
        f ? { data: f.buf.toString('base64'), name: f.name, mime: f.mime } : undefined);
      if (!out.json.ok) return res.status(out.status || 400).json(out.json);
      ntfy({ title: 'Landlord uploaded a property licence', message: (who.l.name || 'A landlord') + ' uploaded the licence for ' + t.address + ' — expires ' + certDay(expires) + '. Check it in Fixflow.', tags: ['page_facing_up'] }).catch(function () {});
      return res.json({ ok: true });
    }
    if (t.own) {
      // Their own property: gas and EICR dates go on its record (the EPC is looked up automatically).
      const d = Object.assign({}, t.own.data || {});
      if (type === 'Gas') d.gas = expires; else if (type === 'EICR') d.eicr = expires;
      else if (type === 'Licence') d.licence = { status: 'licensed', number: str(b.reference, 80) || '', expires: expires };
      await p.query('UPDATE landlord_properties SET data = $2, updated_at = now()' + (type === 'EPC' ? ", epc = jsonb_build_object('expires_on', $3::text, 'rating', $4::text, 'reference', $5::text)" : '') + ' WHERE id = $1',
        type === 'EPC' ? [t.own.id, JSON.stringify(d), expires, str(b.rating, 5) || '', str(b.reference, 100) || ''] : [t.own.id, JSON.stringify(d)]);
      if (f) await p.query(`INSERT INTO landlord_property_docs (own_id, type, name, mime, data) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (own_id, type) DO UPDATE SET name = excluded.name, mime = excluded.mime, data = excluded.data, created_at = now()`, [t.own.id, type, f.name, f.mime, f.buf]);
      return res.json({ ok: true });
    }
    const out = await saveCertificate(p, { address: t.address, type: type, issued_on: issued, expires_on: expires, reference: str(b.reference, 100) || '', rating: str(b.rating, 5) || '',
      notes: 'Uploaded by the landlord', doc: f ? { data: f.buf.toString('base64'), name: f.name, mime: f.mime } : undefined });
    if (!out.json.ok) return res.status(out.status || 400).json(out.json);
    ntfy({ title: 'Landlord uploaded a certificate', message: (who.l.name || 'A landlord') + ' uploaded the ' + CERT_TYPES[type].name.toLowerCase() + ' for ' + t.address + ' — expires ' + certDay(expires) + '. Check it in Fixflow.', tags: ['page_facing_up'] }).catch(function () {});
    res.json({ ok: true });
  }));
  app.get('/l/:token/own/:id/doc/:type', withDb(async function (p, req, res) {
    const who = await landlordByToken(p, req.params.token);
    const d = who ? (await p.query(`SELECT d.name, d.mime, d.data FROM landlord_property_docs d JOIN landlord_properties o ON o.id = d.own_id
      WHERE d.own_id = $1 AND d.type = $2 AND o.landlord_id = $3`, [parseInt(req.params.id, 10) || 0, String(req.params.type), who.l.id])).rows[0] : null;
    if (!d) return res.status(404).send('Not found');
    res.setHeader('Content-Type', d.mime || 'application/pdf'); res.setHeader('X-Robots-Tag', 'noindex');
    res.setHeader('Content-Disposition', 'inline; filename="' + String(d.name || 'certificate.pdf').replace(/[^a-zA-Z0-9.\-_ ]+/g, '-') + '"');
    res.send(d.data);
  }));
  // A property licence document for one of the landlord's properties.
  app.get('/l/:token/licence/:key', withDb(async function (p, req, res) {
    const who = await landlordByToken(p, req.params.token), k = String(req.params.key || '');
    if (!who || who.keys[k] === undefined) return res.status(404).send('Not found');
    await sendLicenceDoc(p, k, res);
  }));
  // A certificate document for one of the landlord's properties.
  app.get('/l/:token/cert/:id', withDb(async function (p, req, res) {
    const who = await landlordByToken(p, req.params.token);
    const c = who ? (await p.query('SELECT id, property_key FROM property_certificates WHERE id = $1', [parseInt(req.params.id, 10) || 0])).rows[0] : null;
    if (!c || who.keys[c.property_key] === undefined) return res.status(404).send('Not found');
    await sendCertDoc(p, c.id, res);
  }));
  app.get('/l/:token/invoice/:id', withDb(async function (p, req, res) {
    res.setHeader('X-Robots-Tag', 'noindex'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const who = await landlordByToken(p, req.params.token);
    const inv = who ? await invoiceRow(p, req.params.id) : null;
    if (!inv || who.keys[propKey(inv.property_address)] === undefined) return res.status(404).send(trackShell('Invoice not found', '<h1>Invoice not found</h1>', true));
    res.send(invoicePage(inv, '/l/' + htmlEsc(req.params.token), '← Your properties'));
  }));
  // The office's view of an invoice (e.g. a tenancy's renewal fee).
  app.get('/api/admin/invoices/:id/view', withDb(async function (p, req, res) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const inv = await invoiceRow(p, req.params.id);
    if (!inv) return res.status(404).send(trackShell('Invoice not found', '<h1>Invoice not found</h1>', true));
    res.send(invoicePage(inv, '/admin', '← Back to Fixflow'));
  }));
  async function invoiceRow(p, id) {
    return (await p.query(`SELECT i.id, i.number, i.total, i.created_at, i.paid_at, i.data, i.job_id, coalesce(j.property_address, i.address) AS property_address FROM invoices i
      LEFT JOIN jobs j ON j.id = i.job_id WHERE i.id = $1 AND (i.job_id IS NULL OR j.archived_at IS NULL) AND (i.job_id IS NULL OR j.id IS NOT NULL)`, [parseInt(id, 10) || 0])).rows[0] || null;
  }
  function invoicePage(inv, back, backText) {
    const dt = inv.data || {}, day = function (v) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || '')); return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : ''; };
    const money = function (v) { return v == null ? '' : '£' + Number(v).toFixed(2); };
    const overdue = !inv.paid_at && dt.due && dt.due < new Date().toISOString().slice(0, 10);
    const pay = INVOICE.payee && INVOICE.accountNumber ? '<div class="card"><h3 style="margin:0 0 6px">How to pay</h3><div>' + htmlEsc(INVOICE.payee) + '</div><div>Sort code ' + htmlEsc(INVOICE.sortCode) + ' · Account ' + htmlEsc(INVOICE.accountNumber) + '</div><div class="muted">Please use the reference ' + htmlEsc(dt.ref || inv.number) + '</div></div>' : '';
    return trackShell('Invoice ' + inv.number, '<style>table{width:100%;border-collapse:collapse}td{padding:8px 0;border-bottom:1px solid var(--line);vertical-align:top}td.a{text-align:right;white-space:nowrap;padding-left:12px}tr.t td{font-weight:800;border-bottom:0;font-size:1.05rem}.st{display:inline-block;padding:3px 10px;border-radius:999px;font-weight:700;font-size:.8rem}.st.ok{background:var(--ok);color:#fff}.st.due{background:var(--ambert);color:var(--amber)}.st.late{background:#fdecec;color:var(--red)}@media print{header,.noprint{display:none}}</style>' +
      '<p class="noprint"><a href="' + back + '" style="color:var(--blue);font-weight:600;text-decoration:none">' + backText + '</a></p>' +
      '<h1>Invoice ' + htmlEsc(inv.number) + '</h1><p class="sub">' + htmlEsc(inv.property_address || '') + (inv.job_id ? ' · repair ' + htmlEsc(refFor(inv.job_id)) : dt.title ? ' · ' + htmlEsc(dt.title) : '') + '</p>' +
      '<div class="card"><div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap"><div><div class="muted">Issued</div><b>' + htmlEsc(day(dt.date) || day(inv.created_at.toISOString())) + '</b></div>' +
        (dt.due ? '<div><div class="muted">Due</div><b>' + htmlEsc(day(dt.due)) + '</b></div>' : '') +
        '<div><div class="muted">Status</div>' + (inv.paid_at ? '<span class="st ok">Paid ' + htmlEsc(day(inv.paid_at.toISOString())) + '</span>' : overdue ? '<span class="st late">Overdue</span>' : '<span class="st due">Awaiting payment</span>') + '</div></div></div>' +
      '<div class="card"><table>' + (dt.lines || []).map(function (x) { return '<tr><td>' + htmlEsc(x.desc) + (x.novat && dt.vat ? ' <span style="color:#6b7280">(no VAT)</span>' : '') + '</td><td class="a">' + money(x.amount) + '</td></tr>'; }).join('') +
        (dt.vat ? '<tr><td>Subtotal</td><td class="a">' + money(dt.sub) + '</td></tr><tr><td>VAT</td><td class="a">' + money(dt.vat) + '</td></tr>' : '') +
        '<tr class="t"><td>Total</td><td class="a">' + money(inv.total) + '</td></tr></table></div>' + (inv.paid_at ? '' : pay) +
      '<p class="noprint" style="text-align:center"><button onclick="window.print()">Print or save as PDF</button></p>', true);
  }
  app.get('/l/:token', withDb(async function (p, req, res) {
    res.setHeader('X-Robots-Tag', 'noindex'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const token = String(req.params.token || '');
    const who = await landlordByToken(p, token);
    if (!who) return res.status(404).send(trackShell('Link not available', '<h1>Link not available</h1><p class="sub">This link is no longer active. Please contact Residential Realtors for a new one.</p>', true));
    const l = who.l, keys = who.keys;
    const all = (await p.query(`SELECT id, status, urgency, created_at, completed_at, category, affected, symptom, location, summary, property_address,
        appointment_date, appointment_time, landlord_charge, completion_notes, landlord_handles, track_token, task_2, (pdf IS NOT NULL) AS has_report,
        (SELECT coalesce(sum(jp.charge), 0) FROM job_parts jp WHERE jp.job_id = jobs.id) AS parts_charge
      FROM jobs WHERE archived_at IS NULL AND status <> 'Cancelled' ORDER BY created_at DESC`)).rows.filter(function (j) { return keys[propKey(j.property_address)] !== undefined; });
    for (const j of all) { if (!j.track_token) j.track_token = await ensureTrackToken(p, j.id); }
    const ids = all.map(function (j) { return j.id; });
    // Photos: the problem (tenant and office) and the finished work (contractor).
    const photos = {};
    if (ids.length) (await p.query('SELECT id, job_id, added_by FROM job_photos WHERE job_id = ANY($1::int[]) ORDER BY id', [ids])).rows
      .forEach(function (ph) { (photos[ph.job_id] = photos[ph.job_id] || []).push(ph); });
    for (const j of all) {
      if (!photos[j.id]) continue;
      let t = (await p.query('SELECT photo_token FROM jobs WHERE id = $1', [j.id])).rows[0].photo_token;
      if (!t) {
        await p.query('UPDATE jobs SET photo_token = $2 WHERE id = $1 AND photo_token IS NULL', [j.id, crypto.randomBytes(18).toString('base64url')]);
        t = (await p.query('SELECT photo_token FROM jobs WHERE id = $1', [j.id])).rows[0].photo_token;
      }
      j.photo_token = t;
    }
    const invs = (await p.query("SELECT id, job_id, number, total, created_at, paid_at, property_key, data->>'due' AS due, data->>'date' AS date, data->>'title' AS title FROM invoices WHERE job_id = ANY($1::int[]) OR (job_id IS NULL AND property_key = ANY($2::text[])) ORDER BY id", [ids, Object.keys(keys)])).rows;
    // Which property an invoice is for: its repair's, or (a tenancy invoice) its own.
    const invKey = function (i) { const j = all.filter(function (x) { return x.id === i.job_id; })[0]; return j ? propKey(j.property_address) : i.property_key; };
    const parts = {};
    if (ids.length) (await p.query('SELECT job_id, description, charge, status FROM job_parts WHERE job_id = ANY($1::int[]) ORDER BY id', [ids])).rows
      .forEach(function (x) { (parts[x.job_id] = parts[x.job_id] || []).push(x); });
    const certs = Object.keys(keys).length ? (await p.query("SELECT id, property_key, address, type, expires_on, not_required, reference, EXISTS (SELECT 1 FROM certificate_docs d WHERE d.cert_id = property_certificates.id) AS has_doc FROM property_certificates WHERE property_key = ANY($1::text[])", [Object.keys(keys)])).rows : [];
    // Where to see the certificate itself: the EPC on the government register (by
    // its number, else a postcode search), the licence on the council register.
    const pcOf = function (a) { const m = /([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i.exec(String(a || '')); return m ? (m[1] + ' ' + m[2]).toUpperCase() : ''; };
    const epcLink = function (c, addr) {
      return /^\d{4}-\d{4}-\d{4}-\d{4}-\d{4}$/.test(c.reference || '') ? 'https://find-energy-certificate.service.gov.uk/energy-certificate/' + c.reference
        : 'https://find-energy-certificate.service.gov.uk/find-a-certificate/search-by-postcode?lang=en&property_type=domestic' + (pcOf(c.address || addr) ? '&postcode=' + encodeURIComponent(pcOf(c.address || addr)) : '');
    };
    const regRow = (await p.query("SELECT value FROM app_settings WHERE key = 'licence_registers'")).rows[0];
    const registers = Object.assign({ Southwark: 'https://southwark.metastreet.co.uk/public-register' }, (regRow && regRow.value) || {});
    const licLink = function (l, addr) {
      if (l.url && /^https:\/\//i.test(l.url)) return l.url;
      const reg = l.borough && registers[l.borough]; if (!reg) return '';
      return /metastreet\.co\.uk/i.test(reg) && pcOf(addr) ? reg.replace(/\?.*$/, '') + '?search%5Bquery%5D=' + encodeURIComponent(pcOf(addr)) : reg;
    };
    const names = (await p.query("SELECT name FROM contractors WHERE coalesce(trim(name), '') <> ''")).rows.map(function (r) { return r.name.trim(); }).sort(function (a, b) { return b.length - a.length; });
    const reEsc = function (t) { return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
    const scrub = function (t) {
      let s = String(t || '').replace(/Their price:\s*£?\s*[\d,]+(?:\.\d+)?\.?/gi, '').replace(/^[^:\n]{2,40}:\s*/gm, '');
      names.forEach(function (n) { s = s.replace(new RegExp('\\b' + reEsc(n) + '\\b', 'gi'), 'our contractor'); });
      return s.replace(/\s+/g, ' ').trim();
    };
    const day = function (v) { return v ? new Date(v).toLocaleDateString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric' }) : ''; };
    const money = function (n) { return '£' + Number(n).toFixed(2); };
    const charge = function (j) { const c = (j.landlord_charge == null ? 0 : Number(j.landlord_charge)) + Number(j.parts_charge || 0); return j.landlord_charge == null && !Number(j.parts_charge) ? null : c; };
    const issue = function (j) { return String(j.summary || [j.affected, j.symptom].filter(Boolean).join(' – ') || j.category || 'Repair').trim(); };
    const yearAgo = Date.now() - 365 * 86400000;
    const done = all.filter(function (j) { return j.status === 'Completed'; }), open = all.filter(function (j) { return j.status !== 'Completed'; });
    const spent = done.filter(function (j) { return new Date(j.completed_at || j.created_at).getTime() > yearAgo; }).reduce(function (t, j) { return t + (charge(j) || 0); }, 0);
    const unpaid = invs.filter(function (i) { return !i.paid_at; });
    const jobCard = function (j) {
      const c = charge(j), inv = invs.filter(function (i) { return i.job_id === j.id; }).slice(-1)[0], isDone = j.status === 'Completed';
      const notes = isDone ? scrub(j.completion_notes) : '';
      return '<div class="lj' + (isDone ? ' done' : '') + '"><div class="lj-top"><span class="ref">' + htmlEsc('RR-' + String(j.id).padStart(5, '0')) + '</span>' +
          (isDone ? '<span class="pill ok">✓ Completed ' + htmlEsc(day(j.completed_at)) + '</span>' : '<span class="pill">' + htmlEsc(j.status === 'New' ? 'Reported' : j.status) + '</span>') + '</div>' +
        '<div class="lj-issue">' + htmlEsc(issue(j)) + (j.location ? ' <span class="muted">· ' + htmlEsc(j.location) + '</span>' : '') + '</div>' +
        (j.task_2 ? '<div class="muted">Also being done: ' + htmlEsc(j.task_2) + '</div>' : '') +
        '<div class="muted">Reported ' + htmlEsc(day(j.created_at)) + (!isDone && j.appointment_date ? ' · Visit booked ' + htmlEsc(day(j.appointment_date)) + (j.appointment_time ? ' ' + htmlEsc(j.appointment_time) : '') : '') +
          (j.landlord_handles ? ' · Arranged by you' : '') + '</div>' +
        (notes ? '<div class="lj-notes">' + htmlEsc(notes.slice(0, 300)) + '</div>' : '') +
        photoStrip(j) +
        // A repair the landlord is arranging: they book the visit here, then tell the tenants.
        (j.landlord_handles && !isDone ? '<details class="lb"' + (j.appointment_date ? '' : ' open') + '><summary>📅 ' + (j.appointment_date ? 'Change the visit' : 'Book the visit') + '</summary><form class="lb-f" data-id="' + j.id + '" data-k="' + htmlEsc(propKey(j.property_address)) + '" data-issue="' + htmlEsc(issue(j)) + '" data-track="/t/' + htmlEsc(j.track_token) + '">' +
          '<input type="date" name="date" required value="' + htmlEsc(j.appointment_date || '') + '"><input name="time" maxlength="60" placeholder="Time, e.g. 10am or 9–12" value="' + htmlEsc(j.appointment_time || '') + '">' +
          '<input name="who" maxlength="120" placeholder="Who’s coming (optional), e.g. my plumber Dave">' +
          '<button type="submit">Save the visit</button><p class="lb-msg muted"></p></form></details>' : '') +
        costBox(j, c, inv) +
        '<div class="lj-foot">' + (j.has_report ? '<a href="/l/' + htmlEsc(token) + '/report/' + j.id + '" target="_blank" rel="noopener">⬇ Tenant’s report (PDF)</a>' : '<span></span>') + '<a href="/t/' + htmlEsc(j.track_token) + '">Progress and details ›</a></div></div>';
    };
    // What the repair costs them: the work, each part, the total, and the invoice.
    const costBox = function (j, c, inv) {
      const ps = (parts[j.id] || []).filter(function (x) { return x.charge != null && Number(x.charge); });
      const isDone = j.status === 'Completed';
      if (c == null && !inv) return '<div class="cost none">' + (isDone ? 'No charge recorded for this repair.' : 'Cost not confirmed yet — we’ll let you know before any charge.') + '</div>';
      const row = function (a, b, cls) { return '<div class="cr' + (cls ? ' ' + cls : '') + '"><span>' + a + '</span><span>' + b + '</span></div>'; };
      const overdue = inv && !inv.paid_at && inv.due && inv.due < new Date().toISOString().slice(0, 10);
      return '<div class="cost">' +
        (j.landlord_charge != null ? row('Labour and work', money(j.landlord_charge)) : '') +
        ps.map(function (x) { return row('Part: ' + htmlEsc(x.description) + (x.status && !isDone ? ' <span class="muted">(' + htmlEsc(String(x.status).toLowerCase()) + ')</span>' : ''), money(x.charge)); }).join('') +
        (c != null ? row(isDone ? 'Total cost to you' : 'Expected cost to you', money(c), 'tot') : '') +
        (inv ? '<div class="ci">Invoice <b>' + htmlEsc(inv.number || '') + '</b> · ' + money(inv.total) + ' · ' +
          (inv.paid_at ? '<span class="paid">Paid ' + htmlEsc(day(inv.paid_at)) + '</span>' : overdue ? '<span class="late">Overdue since ' + htmlEsc(day(inv.due)) + '</span>' : '<span class="due">Due ' + htmlEsc(inv.due ? day(inv.due) : 'now') + '</span>') +
          ' · <a href="/l/' + htmlEsc(token) + '/invoice/' + inv.id + '">View invoice</a></div>' : '') +
      '</div>';
    };
    const photoStrip = function (j) {
      const list = photos[j.id] || [];
      if (!list.length || !j.photo_token) return '';
      const group = function (label, ps) {
        if (!ps.length) return '';
        return '<div class="ph-lb">' + label + ' (' + ps.length + ')</div><div class="ph">' + ps.slice(0, 6).map(function (ph) {
          const u = '/p/' + htmlEsc(j.photo_token) + '/' + ph.id;
          return '<a href="' + u + '" target="_blank" rel="noopener"><img loading="lazy" src="' + u + '" alt="Photo"></a>';
        }).join('') + (ps.length > 6 ? '<a class="more" href="/p/' + htmlEsc(j.photo_token) + '" target="_blank" rel="noopener">+' + (ps.length - 6) + '</a>' : '') + '</div>';
      };
      return group('Photos of the problem', list.filter(function (ph) { return ph.added_by !== 'contractor'; })) +
        group('Photos of the finished work', list.filter(function (ph) { return ph.added_by === 'contractor'; }));
    };
    const certName = { EPC: 'EPC', Gas: 'Gas safety', EICR: 'Electrical (EICR)' };
    const yr = new Date().getFullYear();
    const when = function (j) { return new Date(j.completed_at || j.created_at); };
    const sumOf = function (list) { return list.reduce(function (t, j) { return t + (charge(j) || 0); }, 0); };
    const doneC = all.filter(function (j) { return j.status === 'Completed' && charge(j) != null; });
    const thisYr = doneC.filter(function (j) { return when(j).getFullYear() === yr; }), lastYr = doneC.filter(function (j) { return when(j).getFullYear() === yr - 1; });
    const expected = all.filter(function (j) { return j.status !== 'Completed' && charge(j) != null; });
    const byType = {};
    doneC.forEach(function (j) { const k = String(j.category || 'Other').trim() || 'Other'; byType[k] = (byType[k] || 0) + charge(j); });
    const types = Object.keys(byType).sort(function (a, b) { return byType[b] - byType[a]; });
    const maxT = types.length ? byType[types[0]] : 0;
    const spendCard = '<section class="card" id="spending"><h2>Spending &amp; invoices</h2><div class="sp">' +
        '<div><span>This year (' + yr + ')</span><b>' + money(sumOf(thisYr)) + '</b><small>' + thisYr.length + ' repair' + (thisYr.length === 1 ? '' : 's') + '</small></div>' +
        '<div><span>Last year (' + (yr - 1) + ')</span><b>' + money(sumOf(lastYr)) + '</b><small>' + lastYr.length + ' repair' + (lastYr.length === 1 ? '' : 's') + '</small></div>' +
        '<div><span>All time</span><b>' + money(sumOf(doneC)) + '</b><small>' + doneC.length + ' repair' + (doneC.length === 1 ? '' : 's') + '</small></div>' +
        (expected.length ? '<div><span>Expected (open repairs)</span><b>' + money(sumOf(expected)) + '</b><small>' + expected.length + ' repair' + (expected.length === 1 ? '' : 's') + '</small></div>' : '') + '</div>' +
      (types.length ? '<h3>By type of repair</h3>' + types.slice(0, 8).map(function (t) { return '<div class="bt"><span>' + htmlEsc(t) + '</span><i style="width:' + Math.max(4, Math.round(byType[t] / maxT * 100)) + '%"></i><b>' + money(byType[t]) + '</b></div>'; }).join('') : '') +
      (doneC.length || invs.length ? '<h3>Maintenance cost by property</h3><div class="bpt"><div class="bpr bph"><span>Property</span><span>This year</span><span>All time</span><span>Unpaid</span></div>' + Object.keys(keys).map(function (k) {
          const pj = doneC.filter(function (j) { return propKey(j.property_address) === k; });
          const pi = invs.filter(function (i) { return invKey(i) === k; });
          const un = pi.filter(function (i) { return !i.paid_at; }).reduce(function (t, i) { return t + Number(i.total || 0); }, 0);
          if (!pj.length && !pi.length) return '';
          const addr = (pj[0] && pj[0].property_address) || keys[k];
          return '<a class="bpr" href="#p-' + htmlEsc(k.replace(/[^a-z0-9]+/g, '-')) + '"><span>' + htmlEsc(addr) + '</span><span>' + money(sumOf(pj.filter(function (j) { return when(j).getFullYear() === yr; }))) + '</span><span><b>' + money(sumOf(pj)) + '</b></span><span' + (un ? ' class="due"' : '') + '>' + (un ? money(un) : '—') + '</span></a>';
        }).join('') + '</div>' : '') +
      '<p style="margin:12px 0 0"><a class="dl" href="/l/' + htmlEsc(token) + '/costs.csv">⬇ Download all costs (spreadsheet)</a></p></section>';
    // Every invoice across their properties: what's to pay first (overdue at the
    // top), then the paid ones folded away.
    const todayIso0 = new Date().toISOString().slice(0, 10);
    const invRow = function (i) {
      const j = all.filter(function (x) { return x.id === i.job_id; })[0] || {}, od = !i.paid_at && i.due && i.due < todayIso0, k = invKey(i);
      return '<a class="iv" href="/l/' + htmlEsc(token) + '/invoice/' + i.id + '"><div><b>' + htmlEsc(i.number || '') + '</b> · ' + htmlEsc(j.id ? issue(j) : i.title || 'Invoice') + '<div class="muted">' + htmlEsc((j.property_address || keys[k] || '') ) + ' · issued ' + htmlEsc(day(i.date || i.created_at)) + '</div></div>' +
        '<div style="text-align:right"><b>' + money(i.total) + '</b><div>' + (i.paid_at ? '<span class="paid">Paid ' + htmlEsc(day(i.paid_at)) + '</span>' : od ? '<span class="late">Overdue</span>' : '<span class="due">Due ' + htmlEsc(i.due ? day(i.due) : 'now') + '</span>') + '</div></div></a>';
    };
    const unpaidInv = invs.filter(function (i) { return !i.paid_at; }).sort(function (x, y) { return String(x.due || '9').localeCompare(String(y.due || '9')); }), paidInv = invs.filter(function (i) { return i.paid_at; }).reverse();
    const toPay = unpaidInv.reduce(function (t, i) { return t + Number(i.total || 0); }, 0);
    const invCard = invs.length ? '<section class="card" id="invoices"><h2>Invoices</h2>' +
      (unpaidInv.length ? '<p class="muted" style="margin:-4px 0 6px"><b>' + money(toPay) + '</b> to pay across ' + unpaidInv.length + ' invoice' + (unpaidInv.length === 1 ? '' : 's') + ' — tap one to see it and how to pay.</p>' + unpaidInv.map(invRow).join('') : '<p class="muted" style="margin:-4px 0 6px">✓ All paid — nothing to pay.</p>') +
      (paidInv.length ? '<details' + (unpaidInv.length ? '' : ' open') + '><summary>Paid invoices (' + paidInv.length + ')</summary>' + paidInv.map(invRow).join('') + '</details>' : '') + '</section>' : '';
    // The tenancy at each property: the tenants' names and phone numbers, when
    // it started and when the fixed term ends (it rolls on after that).
    const tcys = Object.keys(keys).length ? (await p.query("SELECT id, address, property_key, start_date, data, intention FROM tenancies WHERE property_key = ANY($1::text[]) AND start_date IS NOT NULL ORDER BY start_date DESC", [Object.keys(keys)])).rows : [];
    // Everyone living at each property (the tenancy's tenants and those saved there), for the landlord to contact.
    const saved = Object.keys(keys).length ? (await p.query(`SELECT pt.property_key, t.name, t.phone, t.email FROM property_tenants pt JOIN tenants t ON t.id = pt.tenant_id
      WHERE pt.property_key = ANY($1::text[]) AND pt.moved_out_at IS NULL AND t.deleted_at IS NULL ORDER BY t.updated_at DESC`, [Object.keys(keys)])).rows : [];
    const peopleAt = function (k) {
      const t = tcys.filter(function (x) { return x.property_key === k; })[0], out = [];
      const tail = function (v) { return String(v || '').replace(/\D/g, '').slice(-10); };
      const add = function (x) { if (!x || !(x.name || x.phone || x.email)) return; if (out.some(function (o) { return (x.phone && tail(o.phone) === tail(x.phone)) || (x.email && o.email && o.email.toLowerCase() === String(x.email).toLowerCase()) || (x.name && o.name && o.name.toLowerCase() === String(x.name).toLowerCase()); })) return; out.push({ name: str(x.name, 120) || '', phone: str(x.phone, 40) || '', email: str(x.email, 160) || '' }); };
      ((t && t.data && t.data.tenants) || []).forEach(add);
      saved.filter(function (x) { return x.property_key === k; }).forEach(add);
      return out.slice(0, 8);
    };
    const isoOf = function (v) { return v instanceof Date ? v.toISOString().slice(0, 10) : String(v || '').slice(0, 10); };
    const addMonths = function (iso, n) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso); if (!m) return ''; const d = new Date(Date.UTC(+m[1], +m[2] - 1 + n, +m[3])); if (d.getUTCDate() !== +m[3]) d.setUTCDate(0); return d.toISOString().slice(0, 10); };
    const tcyBox = function (k) {
      const t = tcys.filter(function (x) { return x.property_key === k; })[0]; if (!t) return '';
      const d = t.data || {}, start = isoOf(d.start_date || t.start_date), months = parseInt(d.term_months, 10) || 12, today = new Date().toISOString().slice(0, 10);
      const endD = new Date(Date.UTC(+addMonths(start, months).slice(0, 4), +addMonths(start, months).slice(5, 7) - 1, +addMonths(start, months).slice(8, 10) - 1)).toISOString().slice(0, 10);   // the day before
      const next = today >= start ? nextTermEnd(start, 12, today) : '';
      // The rent now: the latest agreed increase that has started, else the rent the tenancy began at.
      let rent = Number(d.rent_pcm) || 0, upcoming = null;
      Object.keys(t.intention || {}).sort().forEach(function (k2) { const it = t.intention[k2] || {}; const nr = Number(it.new_rent); if (!nr || it.no_increase) return; const from = it.rent_from || k2; if (from <= today) rent = nr; else if (!upcoming || from < upcoming.from) upcoming = { rent: nr, from: from }; });
      return '<div class="tcy"><h3>Tenancy</h3>' +
        '<div class="tcy-facts">' + (rent ? '<div><span>Rent now</span><b>£' + rent.toFixed(2) + '</b><small>a month</small></div>' : '') +
          '<div><span>' + (start > today ? 'Starts' : 'Started') + '</span><b>' + htmlEsc(day(start)) + '</b><small>' + months + '-month term ' + (endD < today ? 'ended ' + htmlEsc(day(endD)) + ', now rolling' : 'to ' + htmlEsc(day(endD))) + '</small></div>' +
          (next ? '<div><span>Next anniversary</span><b>' + htmlEsc(day(next)) + '</b><small>rent review</small></div>' : '') + '</div>' +
        (upcoming ? '<div class="muted lc-up" style="margin-top:6px">New rent of <b>£' + upcoming.rent.toFixed(2) + '</b> a month from ' + htmlEsc(day(upcoming.from)) + '. <a href="#" class="lc-x" data-id="' + t.id + '" data-k="' + htmlEsc(t.property_key) + '" data-was="' + htmlEsc('£' + upcoming.rent.toFixed(2) + ' a month from ' + day(upcoming.from)) + '">Cancel this increase</a><span class="lc-msg"></span></div>' : '') +
        f4aForm(t, start, today) + '</div>';
    };
    // Propose a rent increase on the official Form 4A, filled in for them.
    const f4aForm = function (t, start, today) {
      if (start > today) return '';
      const plan = form4aPlan(t); if (!plan.ok) return '';
      const svc = String((t.data || {}).service || ''), agentOn = !/tenant find/i.test(svc) || !svc;
      if (!plan.open) return '<p class="muted" style="margin:8px 0 0">📝 You can propose a rent increase (Form 4A) from <b>' + htmlEsc(day(plan.opensOn)) + '</b> — rent can go up once every 12 months, with 2 months’ notice.</p>';
      return '<details class="lf"><summary>📝 Propose a rent increase (Form 4A)</summary><form class="lf-f" data-id="' + t.id + '" data-k="' + htmlEsc(t.property_key) + '">' +
        '<p class="muted" style="margin:6px 0">Current rent <b>£' + plan.rent.toFixed(2) + '</b> a month. The earliest the new rent can start is <b>' + htmlEsc(day(plan.earliest)) + '</b> — the notice must be served at least 2 months before, the first increase can’t start until 52 weeks after the tenancy began (or the last increase), and it starts on a rent day.</p>' +
        '<div class="lf-two"><label>Increase by (%)<input name="pct" inputmode="decimal" placeholder="e.g. 5"></label><label>or new rent (£ a month)<input name="new_rent" inputmode="decimal" required data-base="' + plan.rent + '" placeholder="e.g. ' + Math.round(plan.rent * 1.05) + '"></label></div><p class="muted lf-calc" style="margin:2px 0 0"></p>' +
        '<label>New rent starts on<input type="date" name="start" required min="' + plan.earliest + '" value="' + plan.earliest + '"></label>' +
        '<label>Signed by (print name)<input name="signer" required maxlength="120" value="' + htmlEsc(String(l.name || '').trim()) + '"></label>' +
        '<label class="lr-o"><input type="checkbox" name="sign" checked> Sign it electronically with this name</label>' +
        '<label class="lr-o"><input type="checkbox" name="agent"' + (agentOn ? ' checked' : '') + '> Include Residential Realtors as my agent</label>' +
        '<label class="lr-o"><input type="checkbox" name="landlord_email"> Add my email address (the tenant may then use it to serve documents)</label>' +
        '<button type="submit">Create the Form 4A (PDF)</button><p class="lf-msg muted"></p></form></details>';
    };
    // The landlord's own tools at each property: contact the tenants (call, WhatsApp,
    // email, templates), report a repair, and — on repairs they arrange — book a visit.
    const contactBox = function (k, addr) {
      const ppl = peopleAt(k); if (!ppl.length) return '';
      return '<div class="lt" data-k="' + htmlEsc(k) + '" data-addr="' + htmlEsc(addr) + '" data-people="' + htmlEsc(JSON.stringify(ppl)) + '"><h3>Your tenants</h3>' +
        ppl.map(function (x) {
          return '<div class="lt-p"><b>' + htmlEsc(x.name || 'Tenant') + '</b><span class="lt-a">' +
            (x.phone ? '<a href="tel:' + htmlEsc(String(x.phone).replace(/[^\d+]/g, '')) + '">📞 Call</a><a href="#" data-wa="' + htmlEsc(x.phone) + '" data-name="' + htmlEsc(x.name || '') + '">💬 WhatsApp</a>' : '') +
            (x.email ? '<a href="mailto:' + htmlEsc(x.email) + '">✉️ Email</a>' : '') + '</span>' +
            '<small>' + htmlEsc([x.phone, x.email].filter(Boolean).join(' · ')) + '</small></div>';
        }).join('') +
        '<details class="lt-msg"><summary>💬 Send a message with a template</summary>' +
          '<select class="lt-tpl"></select>' +
          '<div class="lt-when"><input type="date" class="lt-date"><input class="lt-time" placeholder="Time, e.g. 10am"></div>' +
          '<textarea class="lt-text" rows="6"></textarea>' +
          '<div class="lt-send"></div></details></div>';
    };
    const repairForm = function (k, addr) {
      return '<details class="lr"><summary>🛠 Report a repair</summary><form class="lr-f" data-k="' + htmlEsc(k) + '">' +
        '<input name="title" required maxlength="200" placeholder="What’s wrong? e.g. Kitchen tap dripping">' +
        '<textarea name="details" rows="3" maxlength="3000" placeholder="Details (where, since when, anything we should know)"></textarea>' +
        '<select name="urgency"><option>Routine</option><option>Urgent</option><option>Emergency</option></select>' +
        '<label class="lr-o"><input type="radio" name="who" value="us" checked> Please arrange it for me</label>' +
        '<label class="lr-o"><input type="radio" name="who" value="self"> I’ll arrange it myself (I’ll book the visit here)</label>' +
        '<button type="submit">Send repair</button><p class="lr-msg muted"></p></form></details>';
    };
    // Each property's licence (selective / HMO), as checked on the council register.
    const lics = {}, licAddr = {};
    if (Object.keys(keys).length) (await p.query('SELECT property_key, address, licence FROM property_info WHERE property_key = ANY($1::text[]) AND licence IS NOT NULL', [Object.keys(keys)])).rows
      .forEach(function (r) { lics[r.property_key] = r.licence; licAddr[r.property_key] = r.address; });
    const licBox = function (k) {
      const l = lics[k]; if (!l) return '';
      const today = new Date().toISOString().slice(0, 10), soon = new Date(Date.now() + 61 * 86400000).toISOString().slice(0, 10);
      const what = l.type ? l.type + ' licence' : 'Property licence';
      const st = l.status === 'not_needed' ? { c: 'ok', t: 'No property licence needed' }
        : l.status === 'none' ? { c: 'late', t: 'No property licence found on the council register — we’ll be in touch' }
        : l.status === 'applied' ? { c: 'soon', t: what + ' — application submitted, not yet issued by the council' }
        : !l.expires ? { c: 'ok', t: what + ' — licensed' }
        : l.expires < today ? { c: 'late', t: what + ' — expired ' + day(l.expires) }
        : l.expires <= soon ? { c: 'soon', t: what + ' — expires ' + day(l.expires) }
        : { c: 'ok', t: what + ' — valid until ' + day(l.expires) };
      const href = l.has_doc ? '/l/' + token + '/licence/' + encodeURIComponent(k) : l.status !== 'not_needed' ? licLink(l, licAddr[k] || keys[k]) : '';
      return '<div class="lic ' + st.c + '">📜 ' + htmlEsc(st.t) + (l.borough ? ' <span class="muted">· ' + htmlEsc(l.borough) + '</span>' : '') +
        (l.number && l.status !== 'not_needed' && l.status !== 'none' ? '<div class="lic-ref">Licence reference: <b>' + htmlEsc(l.number) + '</b></div>' : '') + (href ? ' · <a href="' + htmlEsc(href) + '" target="_blank" rel="noopener">' + (l.has_doc ? '📎 View licence' : l.url ? 'View licence' : 'View on the council register') + ' ↗</a>' : '') + '</div>';
    };
  const ownScript = String.raw`<script>(function(){
var TOKEN = document.body.getAttribute('data-lt'), ME = document.body.getAttribute('data-me') || 'Your landlord';
var esc = function(v){ return String(v == null ? '' : v).replace(/[&<>"]/g, function(c){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
var TPL = [
  ['General message', 'Hi {first},\n\n\n\nThanks,\n{me}'],
  ['Visit / appointment', 'Hi {first},\n\nSomeone will be visiting {address} on {date}{at} to [what they are doing]. Please let me know if this doesn’t suit, or if they’ll need a key to get in.\n\nThanks,\n{me}'],
  ['Inspection', 'Hi {first},\n\nI’d like to carry out a routine inspection at {address} on {date}{at}. It takes about 15–20 minutes. Please let me know if this doesn’t suit.\n\nThanks,\n{me}'],
  ['Repair update', 'Hi {first},\n\nA quick update on the repair at {address}: [update].\n\nThanks,\n{me}'],
  ['Gas safety check', 'Hi {first},\n\nThe annual gas safety check at {address} is booked for {date}{at}. Please make sure the engineer can get in — the check is a legal requirement.\n\nThanks,\n{me}'],
  ['Rent', 'Hi {first},\n\nA quick note about the rent for {address}: [message].\n\nThanks,\n{me}']
];
var waNum = function(v){ var d = String(v || '').replace(/[^\d+]/g, ''); if (/^\+/.test(d)) d = d.slice(1); else if (/^00/.test(d)) d = d.slice(2); else if (/^0/.test(d)) d = '44' + d.slice(1); return d.length >= 10 ? d : ''; };
var first = function(n){ var w = String(n || '').replace(/^(mr|mrs|miss|ms|mx|dr)\.?\s+/i, '').trim().split(/\s+/)[0]; return w || 'there'; };
var longDate = function(v){ var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) : '[day, date]'; };
var openWa = function(phone, text){ var n = waNum(phone); if (n) window.open('https://wa.me/' + n + '?text=' + encodeURIComponent(text), '_blank', 'noopener'); };
var sendButtons = function(ppl, getText){
  var h = ppl.map(function(x, i){ return waNum(x.phone) ? '<button type="button" data-i="' + i + '">💬 WhatsApp ' + esc(first(x.name)) + '</button>' : ''; }).join('');
  var mails = ppl.filter(function(x){ return x.email; }).map(function(x){ return x.email; });
  if (mails.length) h += '<button type="button" data-mail="1" class="sec">✉️ Email ' + (mails.length > 1 ? 'all' : esc(first(ppl.filter(function(x){ return x.email; })[0].name))) + '</button>';
  return { html: h || '<span class="muted">No phone number or email saved for them.</span>', click: function(e){
    var b = e.target.closest('button'); if (!b) return;
    if (b.getAttribute('data-mail')) { var t = getText('there'); window.location.href = 'mailto:' + mails.join(',') + '?subject=' + encodeURIComponent((t.split('\n').filter(Boolean)[1] || 'A message about your home').slice(0, 80)) + '&body=' + encodeURIComponent(t.replace(/^Hi there,/, 'Hi all,')); return; }
    var x = ppl[+b.getAttribute('data-i')]; openWa(x.phone, getText(first(x.name))); b.textContent = '✓ ' + b.textContent.replace(/^✓ /, '');
  } };
};
// Contact the tenants: one-tap WhatsApp per person, and messages from templates.
document.querySelectorAll('.lt').forEach(function(box){
  var ppl = JSON.parse(box.getAttribute('data-people') || '[]'), addr = box.getAttribute('data-addr');
  box.querySelectorAll('[data-wa]').forEach(function(a){ a.addEventListener('click', function(e){ e.preventDefault(); openWa(a.getAttribute('data-wa'), 'Hi ' + first(a.getAttribute('data-name')) + ', '); }); });
  var sel = box.querySelector('.lt-tpl'), txt = box.querySelector('.lt-text'), date = box.querySelector('.lt-date'), time = box.querySelector('.lt-time'), send = box.querySelector('.lt-send');
  if (!sel) return;
  sel.innerHTML = TPL.map(function(t, i){ return '<option value="' + i + '">' + esc(t[0]) + '</option>'; }).join('');
  var fill = function(){ var t = TPL[+sel.value][1]; box.querySelector('.lt-when').style.display = /\{date\}/.test(t) ? '' : 'none';
    txt.value = t.replace(/\{address\}/g, addr).replace(/\{date\}/g, longDate(date.value)).replace(/\{at\}/g, time.value.trim() ? ' at ' + time.value.trim() : '').replace(/\{me\}/g, ME); };
  sel.addEventListener('change', fill); date.addEventListener('change', fill); time.addEventListener('input', fill); fill();
  var sb = sendButtons(ppl, function(name){ return txt.value.replace(/\{first\}/g, name); });
  send.innerHTML = sb.html; send.addEventListener('click', sb.click);
});
// Report a repair.
document.querySelectorAll('.lr-f').forEach(function(f){
  f.addEventListener('submit', function(e){
    e.preventDefault(); var btn = f.querySelector('button'), msg = f.querySelector('.lr-msg'); btn.disabled = true; btn.textContent = 'Sending…';
    fetch('/l/' + TOKEN + '/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: f.getAttribute('data-k'), title: f.elements.title.value, details: f.elements.details.value, urgency: f.elements.urgency.value, who: (f.querySelector('[name=who]:checked') || {}).value }) })
      .then(function(r){ return r.json(); }).then(function(d){
        if (!d.ok) { btn.disabled = false; btn.textContent = 'Send repair'; msg.textContent = 'Couldn’t send that — please try again.'; return; }
        msg.innerHTML = '✓ Sent — reference <b>' + esc(d.ref) + '</b>. ' + ((f.querySelector('[name=who]:checked') || {}).value === 'self' ? 'You can book the visit on it below.' : 'We’ll be in touch.');
        setTimeout(function(){ location.reload(); }, 1600);
      }).catch(function(){ btn.disabled = false; btn.textContent = 'Send repair'; msg.textContent = 'Couldn’t send that — please try again.'; });
  });
});
// Form 4A: filled in on the server, downloaded, then how to serve it.
document.querySelectorAll('.lf-f').forEach(function(f){
  // A % increase or a new amount — each fills in the other.
  var base = +f.elements.new_rent.getAttribute('data-base') || 0, calc = f.querySelector('.lf-calc');
  var show = function(){ var nr = +f.elements.new_rent.value; calc.textContent = base && nr ? (nr > base ? 'Up £' + (nr - base).toFixed(2) + ' a month (' + (Math.round((nr / base - 1) * 1000) / 10) + '%) on £' + base.toFixed(2) : 'The new rent must be more than £' + base.toFixed(2)) : ''; };
  f.elements.pct.addEventListener('input', function(){ var pc = parseFloat(f.elements.pct.value); if (base && isFinite(pc)) f.elements.new_rent.value = (Math.round(base * (1 + pc / 100) * 100) / 100).toFixed(2); show(); });
  f.elements.new_rent.addEventListener('input', function(){ var nr = parseFloat(f.elements.new_rent.value); f.elements.pct.value = base && isFinite(nr) ? String(Math.round((nr / base - 1) * 1000) / 10) : ''; show(); });
  f.addEventListener('submit', function(e){
    e.preventDefault(); var btn = f.querySelector('button'), msg = f.querySelector('.lf-msg'); btn.disabled = true; btn.textContent = 'Filling in the form…';
    var body = { new_rent: f.elements.new_rent.value, start: f.elements.start.value, signer: f.elements.signer.value, sign: f.elements.sign.checked, agent: f.elements.agent.checked, landlord_email: f.elements.landlord_email.checked };
    fetch('/l/' + TOKEN + '/tenancies/' + f.getAttribute('data-id') + '/form4a', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function(r){ return r.headers.get('content-type') && r.headers.get('content-type').indexOf('pdf') !== -1 ? r.blob().then(function(b){ return { pdf: b }; }) : r.json(); })
      .then(function(d){
        btn.disabled = false; btn.textContent = 'Create the Form 4A (PDF)';
        if (!d.pdf) { msg.textContent = (d && d.error) || 'Couldn’t create the form — please try again.'; return; }
        var a = document.createElement('a'); a.href = URL.createObjectURL(d.pdf); a.download = 'Form-4A.pdf'; document.body.appendChild(a); a.click(); setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 4000);
        var box = document.querySelector('.lt[data-k="' + f.getAttribute('data-k') + '"]'), ppl = box ? JSON.parse(box.getAttribute('data-people') || '[]') : [], addr = box ? box.getAttribute('data-addr') : '';
        var when = longDate(body.start), amt = '£' + Number(body.new_rent).toFixed(2);
        var sb = sendButtons(ppl, function(name){ return 'Hi ' + name + ',\n\nPlease find attached a notice (Form 4A) proposing a new rent for ' + addr + ' of ' + amt + ' a month, starting on ' + when + '. The notice explains your options. Please get in touch if you have any questions.\n\nThanks,\n' + ME; });
        msg.innerHTML = '✓ Form 4A downloaded (new rent ' + esc(amt) + ' from ' + esc(when) + ').<br><b>Now serve it on your tenants</b> at least 2 months before that date: hand it to them, post it (recorded delivery), or use a method your tenancy agreement allows (e.g. email). Keep proof of how and when you served it. If you send it by WhatsApp or email, attach the PDF:<div class="lt-send">' + sb.html + '</div>';
        msg.querySelector('.lt-send').addEventListener('click', sb.click);
      }).catch(function(){ btn.disabled = false; btn.textContent = 'Create the Form 4A (PDF)'; msg.textContent = 'Couldn’t create the form — please try again.'; });
  });
});
// Cancel a proposed rent increase, then let the tenants know it's withdrawn.
document.querySelectorAll('.lc-x').forEach(function(a){
  a.addEventListener('click', function(e){
    e.preventDefault();
    if (!confirm('Cancel the proposed new rent of ' + a.getAttribute('data-was') + '? If the notice has already been given to your tenants, let them know it is withdrawn.')) return;
    var msg = a.parentNode.querySelector('.lc-msg'); a.textContent = 'Cancelling…';
    fetch('/l/' + TOKEN + '/tenancies/' + a.getAttribute('data-id') + '/cancel-increase', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(function(r){ return r.json(); }).then(function(d){
        if (!d.ok) { a.textContent = 'Cancel this increase'; msg.textContent = ' ' + (d.error || 'Couldn’t cancel — please try again.'); return; }
        var box = document.querySelector('.lt[data-k="' + a.getAttribute('data-k') + '"]'), ppl = box ? JSON.parse(box.getAttribute('data-people') || '[]') : [], addr = box ? box.getAttribute('data-addr') : '';
        var sb = sendButtons(ppl, function(name){ return 'Hi ' + name + ',\n\nPlease note the proposed rent increase for ' + addr + ' (' + a.getAttribute('data-was') + ') has been withdrawn. Your rent stays the same.\n\nThanks,\n' + ME; });
        var holder = a.parentNode;
        holder.innerHTML = '✓ Proposed increase cancelled — your rent stays the same. If you gave your tenants the notice, let them know:<div class="lt-send">' + sb.html + '</div>';
        holder.querySelector('.lt-send').addEventListener('click', sb.click);
      }).catch(function(){ a.textContent = 'Cancel this increase'; msg.textContent = ' Couldn’t cancel — please try again.'; });
  });
});
// Book the visit on a repair the landlord is arranging, then tell the tenants.
document.querySelectorAll('.lb-f').forEach(function(f){
  f.addEventListener('submit', function(e){
    e.preventDefault(); var btn = f.querySelector('button'), msg = f.querySelector('.lb-msg'); btn.disabled = true; btn.textContent = 'Saving…';
    fetch('/l/' + TOKEN + '/jobs/' + f.getAttribute('data-id') + '/book', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: f.date.value, time: f.time.value, who: f.who.value }) })
      .then(function(r){ return r.json(); }).then(function(d){
        btn.disabled = false; btn.textContent = 'Save the visit';
        if (!d.ok) { msg.textContent = 'Couldn’t save that — please try again.'; return; }
        var box = document.querySelector('.lt[data-k="' + f.getAttribute('data-k') + '"]'), ppl = box ? JSON.parse(box.getAttribute('data-people') || '[]') : [], addr = box ? box.getAttribute('data-addr') : '';
        var text = function(name){ return 'Hi ' + name + ',\n\nA visit has been booked at ' + addr + ' on ' + longDate(f.date.value) + (f.time.value.trim() ? ' at ' + f.time.value.trim() : '') + ' for: ' + f.getAttribute('data-issue') + (f.who.value.trim() ? ' (' + f.who.value.trim() + ')' : '') + '. Please make sure they can get in, and let me know if this time doesn’t suit.\n\nYou can follow the repair here: ' + location.origin + f.getAttribute('data-track') + '\n\nThanks,\n' + ME; };
        var sb = sendButtons(ppl, text);
        msg.innerHTML = '✓ Visit saved. Let your tenants know:<div class="lt-send">' + sb.html + '</div>';
        msg.querySelector('.lt-send').addEventListener('click', sb.click);
      }).catch(function(){ btn.disabled = false; btn.textContent = 'Save the visit'; msg.textContent = 'Couldn’t save that — please try again.'; });
  });
});
})();</script>`;
    // Their own properties (not managed by us), kept here so everything is in one place.
    const owns = (await p.query('SELECT id, address, data, epc FROM landlord_properties WHERE landlord_id = $1 ORDER BY address', [l.id])).rows;
    const ownDocs = {};
    if (owns.length) (await p.query('SELECT own_id, type FROM landlord_property_docs WHERE own_id = ANY($1::int[])', [owns.map(function (o) { return o.id; })])).rows.forEach(function (r) { ownDocs[r.own_id + '|' + r.type] = 1; });
    // Upload a certificate: read, checked by the landlord, then saved.
    const certUp = function (attr) {
      return '<div class="lcu" ' + attr + '><button type="button" class="lcu-b">📎 Upload a certificate</button><span class="muted lcu-h">Gas safety, EICR, EPC or property licence — PDF or photo, or drag and drop it here. We’ll read the dates for you.</span>' +
        '<form class="lcu-f" hidden><p class="lcu-w"></p><div class="lf-two"><label>Certificate<select name="type"><option value="Gas">Gas safety</option><option value="EICR">Electrical (EICR)</option><option value="EPC">EPC</option><option value="Licence">Property licence</option></select></label><label>Certificate no.<input name="reference" maxlength="100"></label></div>' +
        '<div class="lf-two"><label>Date done<input type="date" name="issued_on"></label><label>Expires<input type="date" name="expires_on" required></label></div>' +
        '<button type="submit">Save certificate</button> <button type="button" class="lcu-x sec2">Cancel</button><p class="lcu-m muted"></p></form></div>';
    };
    const todayI = new Date().toISOString().slice(0, 10), soonI = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
    const waLink = function (v) { let d = String(v || '').replace(/[^\d+]/g, ''); if (/^\+/.test(d)) d = d.slice(1); else if (/^00/.test(d)) d = d.slice(2); else if (/^0/.test(d)) d = '44' + d.slice(1); return d; };
    const expState = function (d) { return !d ? '' : d < todayI ? 'bad' : d <= soonI ? 'warn' : 'ok'; };
    const ownChips = function (o) {
      const d = o.data || {}, e = o.epc || {}, out = [];
      [['EPC', e.expires_on], ['Gas safety', d.gas], ['EICR', d.eicr], ['Licence', d.licence && d.licence.status === 'licensed' ? d.licence.expires : '']].forEach(function (c) {
        const st = expState(c[1]); if (st === 'bad') out.push('<span class="chip bad">' + c[0] + ' expired</span>'); else if (st === 'warn') out.push('<span class="chip warn">' + c[0] + ' due ' + htmlEsc(day(c[1])) + '</span>');
      });
      return out.join('') || '<span class="chip">Your own records</span>';
    };
    const ownRows = owns.map(function (o) { return '<a class="qrow" href="#o-' + o.id + '" data-find="' + htmlEsc(String(o.address).toLowerCase()) + '"><span class="qa">' + htmlEsc(o.address) + '</span><span class="qc">' + ownChips(o) + '</span><span class="qgo">›</span></a>'; });
    const ownViews = owns.map(function (o) {
      const d = o.data || {}, e = o.epc, lic = d.licence || {};
      const row = function (label, val, st) { return '<div class="ocr' + (st ? ' ' + st : '') + '"><span>' + label + '</span><b>' + val + '</b></div>'; };
      const exp = function (v) { return v ? (v < todayI ? 'Expired ' : 'Until ') + htmlEsc(day(v)) : '<span class="muted">Not added</span>'; };
      const licTxt = lic.status === 'not_needed' ? 'Not needed' : lic.status === 'applied' ? 'Applied, not yet issued' : lic.status === 'licensed' ? 'Licensed' + (lic.expires ? ' · ' + (lic.expires < todayI ? 'expired ' : 'until ') + htmlEsc(day(lic.expires)) : '') : '<span class="muted">Not added</span>';
      const ten = d.tenants || [];
      return '<section class="lview pv ov" id="o-' + o.id + '" hidden data-own="' + htmlEsc(JSON.stringify({ id: o.id, address: o.address, data: d })) + '"><a class="lback" href="#">← All properties</a>' +
        '<div class="card"><h2 class="pv-h">' + htmlEsc(o.address) + '</h2><div class="qc"><span class="chip">Your own records — not managed by us</span></div>' +
          '<div class="pacts"><button type="button" class="o-edit sec2">✏️ Edit</button>' + (d.manage_asked ? '<button type="button" disabled class="sec2">✓ We’ll be in touch about managing it</button>' : '<button type="button" class="o-manage">Ask us to manage it</button>') + '</div></div>' +
        '<div class="card"><h3 style="margin-top:0">Certificates</h3>' +
          row('EPC <small class="muted">(checked automatically)</small>', e && e.expires_on ? (e.rating ? 'Rating ' + htmlEsc(e.rating) + ' · ' : '') + exp(e.expires_on) + ' · <a href="' + htmlEsc(epcLink({ reference: e.reference, address: o.address }, o.address)) + '" target="_blank" rel="noopener">View ↗</a>' : '<span class="muted">None found on the register yet — we check daily</span>', e && expState(e.expires_on)) +
          row('Gas safety', exp(d.gas) + (ownDocs[o.id + '|Gas'] ? ' · <a href="/l/' + htmlEsc(token) + '/own/' + o.id + '/doc/Gas" target="_blank" rel="noopener">📎 View</a>' : ''), expState(d.gas)) +
          row('Electrical (EICR)', exp(d.eicr) + (ownDocs[o.id + '|EICR'] ? ' · <a href="/l/' + htmlEsc(token) + '/own/' + o.id + '/doc/EICR" target="_blank" rel="noopener">📎 View</a>' : ''), expState(d.eicr)) +
          row('Property licence', licTxt + (lic.number ? '<div class="muted">Ref ' + htmlEsc(lic.number) + '</div>' : '') + (ownDocs[o.id + '|Licence'] ? '<div><a href="/l/' + htmlEsc(token) + '/own/' + o.id + '/doc/Licence" target="_blank" rel="noopener">📎 View</a></div>' : ''), lic.status === 'licensed' ? expState(lic.expires) : '') + certUp('data-own="' + o.id + '"') + '</div>' +
        '<div class="card"><h3 style="margin-top:0">Tenancy</h3>' +
          row('Rent', d.rent ? '£' + Number(d.rent).toFixed(2) + ' a month' : '<span class="muted">Not added</span>') + row('Tenancy started', d.tenancy_start ? htmlEsc(day(d.tenancy_start)) : '<span class="muted">Not added</span>') +
          (ten.length ? ten.map(function (t) {
            return '<div class="lt-p"><b>' + htmlEsc(t.name || 'Tenant') + '</b><span class="lt-a">' + (t.phone ? '<a href="tel:' + htmlEsc(String(t.phone).replace(/[^\d+]/g, '')) + '">📞 Call</a><a href="https://wa.me/' + htmlEsc(waLink(t.phone)) + '" target="_blank" rel="noopener">💬 WhatsApp</a>' : '') + (t.email ? '<a href="mailto:' + htmlEsc(t.email) + '">✉️ Email</a>' : '') + '</span><small>' + htmlEsc([t.phone, t.email].filter(Boolean).join(' · ')) + '</small></div>';
          }).join('') : '<p class="muted" style="margin:6px 0 0">No tenants added.</p>') + '</div>' +
        (d.notes ? '<div class="card"><h3 style="margin-top:0">Notes</h3><p style="white-space:pre-line;margin:0">' + htmlEsc(d.notes) + '</p></div>' : '') +
        '<p style="text-align:center"><a href="#" class="o-del" style="color:var(--red)">Remove this property</a></p></section>';
    }).join('');
    const ownForm = '<section class="lview" id="add" hidden><a class="lback" href="#">← Back</a><div class="card"><h2 id="oTitle">Add a property</h2>' +
      '<p class="muted" style="margin-top:-4px">For a property we don’t manage — so all your properties are in one place. Only you (and our office) can see it. We’ll find its EPC automatically.</p>' +
      '<form id="oForm"><label>Postcode<div class="o-pc"><input name="pc" placeholder="e.g. SE1 6RW" autocomplete="postal-code"><button type="button" id="oFind">Find</button></div></label><select id="oPick" hidden></select>' +
      '<label>Address<input name="address" required maxlength="300" placeholder="e.g. Flat 2, 10 High Street, London SE1 6RW"></label>' +
      '<div class="lf-two"><label>Rent (£ a month)<input name="rent" inputmode="decimal"></label><label>Tenancy started<input name="tenancy_start" type="date"></label></div>' +
      '<h3>Tenants</h3><div id="oTen"></div><a href="#" id="oTenAdd">+ Another tenant</a>' +
      '<h3>Certificates</h3><div class="lf-two"><label>Gas safety expires<input name="gas" type="date"></label><label>EICR expires<input name="eicr" type="date"></label></div>' +
      '<label>Property licence<select name="lic_status"><option value="unknown">Not sure / not added</option><option value="licensed">Licensed</option><option value="applied">Applied, not yet issued</option><option value="not_needed">Not needed</option></select></label>' +
      '<div class="lf-two"><label>Licence number<input name="lic_number" maxlength="80"></label><label>Licence expires<input name="lic_expires" type="date"></label></div>' +
      '<label>Notes<textarea name="notes" rows="3" maxlength="2000" placeholder="Anything to keep a note of — mortgage, insurance, deposit scheme…"></textarea></label>' +
      '<button type="submit">Save property</button><p class="o-msg muted"></p></form></div></section>';
  // The landlord's own properties: add, edit, remove, and "ask us to manage it".
  const ownPropScript = String.raw`<script>(function(){
var TOKEN = document.body.getAttribute('data-lt'), f = document.getElementById('oForm'); if (!f) return;
var editing = null, ten = document.getElementById('oTen');
var tenRow = function(t){ t = t || {}; var d = document.createElement('div'); d.className = 'o-t';
  ['name', 'phone', 'email'].forEach(function(k){ var i = document.createElement('input'); i.setAttribute('data-k', k); i.placeholder = { name: 'Name', phone: 'Phone', email: 'Email' }[k]; if (k === 'phone') i.type = 'tel'; if (k === 'email') i.type = 'email'; i.value = t[k] || ''; d.appendChild(i); });
  ten.appendChild(d); };
var fill = function(o){
  editing = o ? o.id : null; var d = (o && o.data) || {}, lic = d.licence || {};
  document.getElementById('oTitle').textContent = o ? 'Edit property' : 'Add a property';
  f.reset(); f.elements.address.value = o ? o.address : ''; f.elements.rent.value = d.rent || ''; f.elements.tenancy_start.value = d.tenancy_start || '';
  f.elements.gas.value = d.gas || ''; f.elements.eicr.value = d.eicr || ''; f.elements.lic_status.value = lic.status || 'unknown'; f.elements.lic_number.value = lic.number || ''; f.elements.lic_expires.value = lic.expires || ''; f.elements.notes.value = d.notes || '';
  ten.innerHTML = ''; (d.tenants && d.tenants.length ? d.tenants : [{}]).forEach(tenRow);
  document.getElementById('oPick').hidden = true; f.querySelector('.o-msg').textContent = '';
};
fill(null);
window.addEventListener('hashchange', function(){ if (location.hash === '#add' && !editing) fill(null); if (location.hash !== '#add') editing = null; });
document.getElementById('oTenAdd').addEventListener('click', function(e){ e.preventDefault(); tenRow(); });
// Postcode lookup: every home at the postcode, from the EPC register.
document.getElementById('oFind').addEventListener('click', function(){
  var pc = f.elements.pc.value.trim(), pick = document.getElementById('oPick'), b = this; if (!pc) return;
  b.disabled = true; b.textContent = '…';
  fetch('/api/address/postcode?postcode=' + encodeURIComponent(pc)).then(function(r){ return r.json(); }).then(function(d){
    b.disabled = false; b.textContent = 'Find';
    if (!d.ok || !d.addresses.length) { f.querySelector('.o-msg').textContent = 'No addresses found — type the address below.'; pick.hidden = true; return; }
    pick.innerHTML = '<option value="">Choose the address (' + d.addresses.length + ')…</option>' + d.addresses.map(function(a){ return '<option>' + a.replace(/[&<>"]/g, function(c){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }) + '</option>'; }).join('');
    pick.hidden = false; pick.focus();
  }).catch(function(){ b.disabled = false; b.textContent = 'Find'; });
});
document.getElementById('oPick').addEventListener('change', function(){ if (this.value) f.elements.address.value = this.value; });
f.addEventListener('submit', function(e){
  e.preventDefault(); var btn = f.querySelector('button[type=submit]'), msg = f.querySelector('.o-msg');
  var body = { address: f.elements.address.value, rent: f.elements.rent.value, tenancy_start: f.elements.tenancy_start.value, gas: f.elements.gas.value, eicr: f.elements.eicr.value,
    licence: { status: f.elements.lic_status.value, number: f.elements.lic_number.value, expires: f.elements.lic_expires.value }, notes: f.elements.notes.value,
    tenants: [].map.call(ten.querySelectorAll('.o-t'), function(r){ var o = {}; r.querySelectorAll('input').forEach(function(i){ o[i.getAttribute('data-k')] = i.value; }); return o; }) };
  btn.disabled = true; btn.textContent = editing ? 'Saving…' : 'Saving and finding the EPC…';
  fetch('/l/' + TOKEN + '/own' + (editing ? '/' + editing : ''), { method: editing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(function(r){ return r.json(); }).then(function(d){
      btn.disabled = false; btn.textContent = 'Save property';
      if (!d.ok) { msg.textContent = d.error && d.error.length > 12 ? d.error : 'Couldn’t save that — please check the address and try again.'; return; }
      location.hash = '#o-' + (editing || d.id); location.reload();
    }).catch(function(){ btn.disabled = false; btn.textContent = 'Save property'; msg.textContent = 'Couldn’t save that — please try again.'; });
});
document.querySelectorAll('.ov').forEach(function(v){
  var o = JSON.parse(v.getAttribute('data-own'));
  v.querySelector('.o-edit').addEventListener('click', function(){ fill(o); location.hash = '#add'; });
  var m = v.querySelector('.o-manage');
  if (m) m.addEventListener('click', function(){ m.disabled = true; fetch('/l/' + TOKEN + '/own/' + o.id + '/manage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(function(r){ return r.json(); }).then(function(d){ m.textContent = d.ok ? '✓ Thanks — we’ll be in touch' : 'Please try again'; if (!d.ok) m.disabled = false; }); });
  v.querySelector('.o-del').addEventListener('click', function(e){ e.preventDefault(); if (!confirm('Remove ' + o.address + ' from your page?')) return;
    fetch('/l/' + TOKEN + '/own/' + o.id, { method: 'DELETE' }).then(function(r){ return r.json(); }).then(function(d){ if (d.ok) { location.hash = ''; location.reload(); } }); });
});
})();</script>`;
  const certUpScript = String.raw`<script>(function(){
var TOKEN = document.body.getAttribute('data-lt');
document.querySelectorAll('.lcu').forEach(function(box){
  var f = box.querySelector('.lcu-f'), b = box.querySelector('.lcu-b'), m = box.querySelector('.lcu-m'), w = box.querySelector('.lcu-w'), file = null;
  var where = box.getAttribute('data-own') ? { own_id: box.getAttribute('data-own') } : { key: box.getAttribute('data-key') };
  var handle = function(x){
      if (!x) return;
      if (!/\.pdf$/i.test(x.name) && !/^(image\/|application\/pdf)/.test(x.type || '')) { alert('Please use a PDF or a photo of the certificate.'); return; }
      if (x.size > 15 * 1024 * 1024) { alert('That file is too big (15 MB max).'); return; }
      var r = new FileReader();
      r.onload = function(){
        file = { name: x.name, mime: x.type || (/\.pdf$/i.test(x.name) ? 'application/pdf' : ''), data: String(r.result).replace(/^data:[^,]*,/, '') };
        b.disabled = true; b.textContent = 'Reading the certificate…';
        fetch('/l/' + TOKEN + '/cert-read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ file: file }, where)) })
          .then(function(res){ return res.json(); }).then(function(d){
            b.disabled = false; b.textContent = '📎 Upload a different certificate';
            if (!d.ok) { alert(d.error && d.error.length > 12 ? d.error : 'Couldn’t read that file — please try again.'); return; }
            if (d.type) f.elements.type.value = d.type;
            f.elements.issued_on.value = d.issued_on || ''; f.elements.expires_on.value = d.expires_on || ''; f.elements.reference.value = d.reference || '';
            f.setAttribute('data-rating', d.rating || ''); f.setAttribute('data-lic', JSON.stringify({ licence_type: d.licence_type || '', holder: d.holder || '', council: d.council || '' }));
            w.textContent = d.warning || (d.read ? '✓ Read ' + x.name + ' — please check the details, then save.' : 'We couldn’t read the details from ' + x.name + ' — please fill them in.');
            w.className = 'lcu-w' + (d.warning ? ' bad' : ''); f.hidden = false; m.textContent = '';
          }).catch(function(){ b.disabled = false; b.textContent = '📎 Upload a certificate'; alert('Couldn’t read that file — please try again.'); });
      };
      r.readAsDataURL(x);
  };
  b.addEventListener('click', function(){
    var inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.pdf,application/pdf,image/*';
    inp.addEventListener('change', function(){ handle(inp.files && inp.files[0]); });
    inp.click();
  });
  // Drag and drop: onto the box, or anywhere on its certificates card.
  var zone = box.closest('.card') || box;
  var isFile = function(e){ return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') !== -1; };
  ['dragenter', 'dragover'].forEach(function(t){ zone.addEventListener(t, function(e){ if (!isFile(e)) return; e.preventDefault(); box.classList.add('on'); }); });
  zone.addEventListener('dragleave', function(e){ if (!zone.contains(e.relatedTarget)) box.classList.remove('on'); });
  zone.addEventListener('drop', function(e){ if (!isFile(e)) return; e.preventDefault(); box.classList.remove('on'); handle(e.dataTransfer.files[0]); });
  box.querySelector('.lcu-x').addEventListener('click', function(){ f.hidden = true; file = null; b.textContent = '📎 Upload a certificate'; });
  f.addEventListener('submit', function(e){
    e.preventDefault(); var s = f.querySelector('button[type=submit]'); s.disabled = true; s.textContent = 'Saving…';
    fetch('/l/' + TOKEN + '/cert-save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ file: file, type: f.elements.type.value, issued_on: f.elements.issued_on.value, expires_on: f.elements.expires_on.value, reference: f.elements.reference.value, rating: f.getAttribute('data-rating') || '' }, JSON.parse(f.getAttribute('data-lic') || '{}'), where)) })
      .then(function(res){ return res.json(); }).then(function(d){
        s.disabled = false; s.textContent = 'Save certificate';
        if (!d.ok) { m.textContent = d.error && d.error.length > 12 ? d.error : 'Couldn’t save — please try again.'; return; }
        m.textContent = '✓ Saved — thank you.'; setTimeout(function(){ location.reload(); }, 900);
      }).catch(function(){ s.disabled = false; s.textContent = 'Save certificate'; m.textContent = 'Couldn’t save — please try again.'; });
  });
});
})();</script>`;
    const quick = [];
    const propBlocks = Object.keys(keys).map(function (k) {
      const js = all.filter(function (j) { return propKey(j.property_address) === k; });
      const addr = (js[0] && js[0].property_address) || keys[k] || '';
      const cs = certs.filter(function (c) { return c.property_key === k && !c.not_required && c.expires_on; }).map(function (c) {
        const past = new Date(c.expires_on) < new Date();
        const label = htmlEsc(certName[c.type] || c.type) + ' ' + (past ? 'expired ' : 'until ') + htmlEsc(day(c.expires_on));
        return c.has_doc ? '<a class="cert' + (past ? ' late' : '') + '" href="/l/' + htmlEsc(token) + '/cert/' + c.id + '" target="_blank" rel="noopener">📎 ' + label + '</a>'
          : c.type === 'EPC' ? '<a class="cert' + (past ? ' late' : '') + '" href="' + htmlEsc(epcLink(c, addr)) + '" target="_blank" rel="noopener">' + label + ' ↗</a>' : '<span class="cert' + (past ? ' late' : '') + '">' + label + '</span>';
      }).join('');
      const o = js.filter(function (j) { return j.status !== 'Completed'; }), d = js.filter(function (j) { return j.status === 'Completed'; });
      const pSpent = sumOf(js.filter(function (j) { return j.status === 'Completed' && charge(j) != null; }));
      const pYr = sumOf(js.filter(function (j) { return j.status === 'Completed' && charge(j) != null && when(j).getFullYear() === yr; }));
      // This property's invoices, with what's been invoiced and what's still to pay.
      const pInv = invs.filter(function (i) { return invKey(i) === k; }).slice().reverse();
      const pUn = pInv.filter(function (i) { return !i.paid_at; }).reduce(function (t, i) { return t + Number(i.total || 0); }, 0), pAll = pInv.reduce(function (t, i) { return t + Number(i.total || 0); }, 0);
      const invBox = pInv.length ? '<details class="pinv" open><summary>🧾 Invoices for this property (' + pInv.length + ') · ' + money(pAll) + (pUn ? ' · <span class="due">' + money(pUn) + ' to pay</span>' : ' · all paid') + '</summary>' + pInv.map(function (i) {
          const j = all.filter(function (x) { return x.id === i.job_id; })[0] || {}, od = !i.paid_at && i.due && i.due < new Date().toISOString().slice(0, 10);
          return '<a class="iv" href="/l/' + htmlEsc(token) + '/invoice/' + i.id + '"><div><b>' + htmlEsc(i.number || '') + '</b> · ' + htmlEsc(j.id ? issue(j) : i.title || 'Tenancy') + '<div class="muted">Issued ' + htmlEsc(day(i.date || i.created_at)) + '</div></div>' +
            '<div style="text-align:right"><b>' + money(i.total) + '</b><div>' + (i.paid_at ? '<span class="paid">Paid</span>' : od ? '<span class="late">Overdue</span>' : '<span class="due">Due ' + htmlEsc(i.due ? day(i.due) : '') + '</span>') + '</div></div></a>';
        }).join('') + '</details>' : '';
      // Status chips: what needs attention at this property, at a glance.
      const todayIso = new Date().toISOString().slice(0, 10);
      const certLate = certs.filter(function (c) { return c.property_key === k && !c.not_required && c.expires_on && isoOf(c.expires_on) < todayIso; }).length;
      const lic = lics[k], licBad = lic && (lic.status === 'none' || (lic.status === 'licensed' && lic.expires && lic.expires < todayIso));
      const chips = [o.length ? '<span class="chip warn">' + o.length + ' open repair' + (o.length === 1 ? '' : 's') + '</span>' : '<span class="chip ok">No open repairs</span>',
        pUn ? '<span class="chip warn">' + money(pUn) + ' to pay</span>' : '', certLate ? '<span class="chip bad">' + certLate + ' certificate' + (certLate === 1 ? '' : 's') + ' expired</span>' : '',
        licBad ? '<span class="chip bad">Licence needs attention</span>' : ''].filter(Boolean).join('');
      const pid = 'p-' + k.replace(/[^a-z0-9]+/g, '-');
      quick.push('<a class="qrow" href="#' + htmlEsc(pid) + '" data-find="' + htmlEsc(String(addr).toLowerCase()) + '"><span class="qa">' + htmlEsc(addr) + '</span><span class="qc">' + chips + '</span><span class="qgo">›</span></a>');
      // One property at a time, split into tabs so only one thing shows at once.
      const tcyHtml = tcyBox(k) + contactBox(k, addr), docHtml = (cs ? '<div class="certs">' + cs + '</div>' : '') + licBox(k);
      const tabs = [['rep', 'Repairs' + (o.length ? ' (' + o.length + ')' : ''),
          repairForm(k, addr) + (o.length ? '<h3>Open repairs</h3>' + o.map(jobCard).join('') : '<p class="muted">No open repairs.</p>') +
          (d.length ? '<details class="ldone"><summary>✓ Completed repairs (' + d.length + ')</summary>' + d.map(jobCard).join('') + '</details>' : '')],
        tcyHtml ? ['tcy', 'Tenancy', tcyHtml] : null,
        ['doc', 'Certificates', docHtml + certUp('data-key="' + htmlEsc(k) + '"')],
        pInv.length || pSpent ? ['inv', 'Costs', (pSpent ? '<div class="muted" style="margin:0 0 8px">Spent on repairs: <b>' + money(pYr) + '</b> this year · <b>' + money(pSpent) + '</b> in total</div>' : '') + invBox] : null].filter(Boolean);
      const ppl = peopleAt(k).length;
      return '<section class="lview pv" id="' + htmlEsc(pid) + '" hidden>' + (Object.keys(keys).length > 1 ? '<a class="lback" href="#">← All properties</a>' : '') +
        '<div class="card"><h2 class="pv-h">' + htmlEsc(addr) + '</h2><div class="qc">' + chips + '</div>' +
        '<div class="pacts"><button type="button" class="go-rep">🛠 Report a repair</button>' + (ppl ? '<button type="button" class="go-msg sec">💬 Message tenants</button>' : '') + '</div></div>' +
        '<div class="ptabs" role="tablist">' + tabs.map(function (t, i) { return '<button type="button" role="tab" data-t="' + t[0] + '"' + (i ? '' : ' class="on"') + '>' + t[1] + '</button>'; }).join('') + '</div>' +
        tabs.map(function (t, i) { return '<div class="card ppane" data-p="' + t[0] + '"' + (i ? ' hidden' : '') + '>' + t[2] + '</div>'; }).join('') + '</section>';
    }).join('');
    const homeView = Object.keys(keys).length !== 1 || owns.length > 0;
    const css = '<style>.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;margin:0 0 14px}.tile{background:#fff;border:1px solid var(--line);border-radius:14px;padding:12px}.tile b{display:block;font-size:1.3rem}.tile span{font-size:.78rem;color:var(--soft)}' +
      'h2{font-size:1.05rem;margin:0 0 8px}h3{font-size:.85rem;text-transform:uppercase;letter-spacing:.05em;color:var(--soft);margin:14px 0 6px}' +
      '.lj{border:1px solid var(--line);border-radius:14px;padding:12px;margin-top:8px}.lj.done{background:var(--okt);border-color:#cdebd9}.lj-top{display:flex;justify-content:space-between;gap:8px;align-items:center}' +
      '.pill{font-size:.75rem;font-weight:700;padding:3px 9px;border-radius:999px;background:var(--bluet);color:var(--blue)}.pill.ok{background:var(--ok);color:#fff;text-transform:uppercase;letter-spacing:.04em}.lj.done{border-left:5px solid var(--ok)}.lj-issue{font-weight:600;margin:4px 0 2px}' +
      '.lj-notes{font-size:.88rem;margin-top:6px;white-space:pre-line}.lj-foot{display:flex;justify-content:space-between;gap:8px;align-items:center;margin-top:8px;font-size:.9rem;flex-wrap:wrap}.lj-foot a{color:var(--blue);font-weight:600;text-decoration:none}' +
      '.paid{color:var(--ok);font-weight:700}.due{color:var(--amber);font-weight:700}.certs{display:flex;flex-wrap:wrap;gap:6px}.lt,.lr{margin:12px 0 0;padding:12px 14px;border-radius:12px;background:#f6f8fc}.lt h3{margin:0 0 6px}.lt-p{display:grid;gap:2px;padding:6px 0;border-bottom:1px solid #e6e9f0}.lt-p:last-of-type{border-bottom:0}.lt-a{display:flex;gap:10px;flex-wrap:wrap;font-size:.9rem}.lt-a a{color:var(--blue);font-weight:600;text-decoration:none}.lt-p small{color:var(--soft)}.lt-msg,.lr{margin-top:8px}.lt-msg summary,.lr summary,.lb summary{color:var(--blue)!important;font-weight:700;margin-top:6px}.lt-msg select,.lt-msg textarea,.lt-msg input,.lr-f input,.lr-f textarea,.lr-f select,.lb-f input{display:block;width:100%;margin:6px 0;padding:10px 12px;border:1px solid var(--line);border-radius:10px;font:inherit;background:#fff}.lt-when{display:flex;gap:6px}.lt-send{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}.lt-send button,.lr-f button,.lb-f button{padding:10px 14px;border:0;border-radius:10px;background:#25D366;color:#fff;font:inherit;font-weight:700;cursor:pointer}.lt-send button.sec,.lr-f button,.lb-f button{background:var(--ink)}.lr-o{display:flex;gap:8px;align-items:center;margin:4px 0;font-size:.92rem}.lr-o input{width:auto;margin:0}.lr-f{display:block;margin:0}.lb{margin-top:8px}.lb-f{display:block;margin:0}.lf-two{display:grid;grid-template-columns:1fr 1fr;gap:8px}.lf{margin-top:8px}.lf summary{color:var(--blue)!important;font-weight:700}.lf-f{display:block;margin:0}.lf-f label{display:block;font-size:.85rem;color:var(--soft);margin-top:6px}.lf-f input:not([type=checkbox]){display:block;width:100%;margin:4px 0;padding:10px 12px;border:1px solid var(--line);border-radius:10px;font:inherit;background:#fff;color:var(--ink)}.lf-f label.lr-o{color:var(--ink)}.lf-f button{margin-top:8px;padding:10px 14px;border:0;border-radius:10px;background:var(--ink);color:#fff;font:inherit;font-weight:700;cursor:pointer}.tcy-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px}.tcy-facts div{background:#fff;border:1px solid var(--line);border-radius:10px;padding:8px 10px}.tcy-facts span{display:block;font-size:.72rem;color:var(--soft)}.tcy-facts b{display:block}.tcy-facts small{color:var(--soft);font-size:.75rem}a.tile{color:inherit;text-decoration:none}html{scroll-behavior:smooth;scroll-padding-top:64px}.lnav{position:sticky;top:0;z-index:5;display:flex;gap:6px;overflow-x:auto;margin:0 -16px 12px;padding:8px 16px;background:rgba(244,245,247,.94);backdrop-filter:blur(6px);border-bottom:1px solid var(--line)}.lnav a{flex:none;padding:7px 12px;border-radius:999px;background:#fff;border:1px solid var(--line);color:var(--ink);text-decoration:none;font-weight:600;font-size:.88rem}#lfind{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:12px;font:inherit;margin:0 0 8px}.qlist{display:grid}.qrow{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 10px;align-items:center;padding:10px 0;border-bottom:1px solid var(--line);color:inherit;text-decoration:none}.qrow:last-child{border-bottom:0}.qa{font-weight:600}.qgo{grid-row:1/3;grid-column:2;color:var(--faint);font-size:1.3rem}.qc{display:flex;flex-wrap:wrap;gap:4px}.chip{font-size:.72rem;font-weight:700;padding:2px 8px;border-radius:999px;background:#f1f2f5;color:var(--soft)}.chip.ok{background:var(--okt);color:var(--ok)}.chip.warn{background:var(--ambert);color:var(--amber)}.chip.bad{background:#fdecec;color:var(--red)}.pcard>details>summary{list-style:none;cursor:pointer;margin:0;color:inherit;font-weight:inherit}.pcard>details>summary::-webkit-details-marker{display:none}.pcard>details>summary h2{display:flex;justify-content:space-between;gap:8px;margin-bottom:6px}.pcard>details>summary h2::after{content:"▾";color:var(--faint);transition:transform .2s}.pcard>details:not([open])>summary h2::after{transform:rotate(-90deg)}.totop{text-align:right;margin:10px 0 0;font-size:.85rem}.totop a{color:var(--soft)}.fab{position:fixed;right:16px;bottom:16px;width:44px;height:44px;border-radius:50%;background:var(--ink);color:#fff;display:grid;place-items:center;text-decoration:none;font-size:1.2rem;box-shadow:var(--shadow);opacity:0;pointer-events:none;transition:opacity .2s}.bpt{display:grid;gap:2px;font-size:.9rem}.bpr{display:grid;grid-template-columns:minmax(0,2.2fr) 1fr 1fr 1fr;gap:8px;padding:7px 0;border-bottom:1px solid #eef0f3;color:inherit;text-decoration:none}.bpr span:not(:first-child){text-align:right}.bph{font-size:.75rem;color:#6b7280;font-weight:600;text-transform:uppercase}.pinv{margin:12px 0 4px}.pinv summary{cursor:pointer;font-weight:600}a.cert{color:inherit;text-decoration:none;border:1px solid #d9dce3}.lic{margin:10px 0 0;padding:8px 12px;border-radius:10px;font-size:.9rem;background:#eef8f1}.lic.soon{background:#fff4e0}.lic-ref{margin-top:3px;font-size:.85rem}.lic.late{background:#fdecec}.tcy{margin:12px 0 4px;padding:12px 14px;border-radius:12px;background:#f6f8fc}.tcy h3{margin:0 0 6px}.tcy-ppl{display:grid;gap:3px;margin-bottom:6px}.tcy a{color:inherit}.cert{font-size:.78rem;padding:3px 9px;border-radius:999px;background:#f1f2f5}.cert.late{background:#fdecec;color:var(--red);font-weight:700}' +
      'details summary{cursor:pointer;font-weight:700;color:var(--ok);margin-top:14px}' +
      '.cost{margin-top:10px;background:#fafafb;border:1px solid var(--line);border-radius:12px;padding:10px 12px;font-size:.9rem}.lj.done .cost{background:#fff}.cost.none{color:var(--soft)}.cr{display:flex;justify-content:space-between;gap:10px;padding:2px 0}.cr.tot{border-top:1px solid var(--line);margin-top:4px;padding-top:6px;font-weight:800}.ci{margin-top:6px;font-size:.85rem}.ci a{color:var(--blue);font-weight:600;text-decoration:none}.late{color:var(--red);font-weight:700}' +
      '.sp{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px}.sp div{background:#fafafb;border:1px solid var(--line);border-radius:12px;padding:10px}.sp span{display:block;font-size:.75rem;color:var(--soft)}.sp b{display:block;font-size:1.15rem}.sp small{color:var(--soft)}' +
      '.bt{display:grid;grid-template-columns:120px 1fr auto;gap:8px;align-items:center;font-size:.88rem;margin:4px 0}.bt i{display:block;height:8px;border-radius:8px;background:var(--blue)}.bp{display:flex;justify-content:space-between;gap:8px;font-size:.88rem;padding:4px 0;border-bottom:1px solid var(--line)}' +
      '.dl{display:inline-block;padding:10px 14px;border-radius:12px;background:var(--ink);color:#fff;text-decoration:none;font-weight:600}.iv{display:flex;justify-content:space-between;gap:10px;padding:10px 0;border-bottom:1px solid var(--line);color:inherit;text-decoration:none}.iv:last-child{border-bottom:0}' +
      '.ph-lb{font-size:.75rem;color:var(--soft);font-weight:600;margin-top:10px}.ph{display:flex;gap:6px;flex-wrap:wrap;margin-top:4px}.ph a{display:block;width:64px;height:64px;border-radius:10px;overflow:hidden;background:#eee}.ph img{width:100%;height:100%;object-fit:cover;display:block}' +
      '.ph a.more{display:grid;place-items:center;font-weight:700;color:var(--soft);text-decoration:none}' +
      '.lback{display:inline-block;margin:0 0 10px;color:var(--blue);font-weight:700;text-decoration:none}.pv-h{font-size:1.2rem;margin:0 0 6px}.pacts{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.pacts button{flex:1 1 160px;padding:12px 14px;border:0;border-radius:12px;background:var(--ink);color:#fff;font:inherit;font-weight:700;cursor:pointer}.pacts button.sec{background:#25D366}.pacts button{text-transform:none;letter-spacing:normal;font-size:1rem}' +
      '.ptabs{display:flex;gap:6px;overflow-x:auto;margin:4px 0 10px;padding-bottom:2px}.ptabs button{flex:none;padding:9px 14px;border-radius:999px;border:1px solid var(--line);background:#fff;color:var(--ink);font:inherit;font-weight:600;cursor:pointer}.ptabs button.on{background:var(--ink);border-color:var(--ink);color:#fff}' +
      '.ppane .lr:not([open]){display:none}.ppane>.lr{margin-top:0}.ppane>.tcy{margin-top:0}.ppane>h3:first-child,.ppane>.lr+h3{margin-top:0}.lspend{display:grid;grid-template-columns:1fr auto;margin-top:12px;padding:14px 16px}.tiles{grid-template-columns:repeat(3,minmax(0,1fr))}.tile b{font-size:1.1rem}.tiles[hidden]{display:none}' +
      '.lcu{margin-top:12px;padding:12px 14px;border:1.5px dashed var(--line);border-radius:12px}.lcu.on{border-color:var(--ink);background:#f6f8fc}.lcu-b{padding:10px 14px;border:0;border-radius:10px;background:var(--ink);color:#fff;font:inherit;font-weight:700;cursor:pointer;text-transform:none;letter-spacing:normal}.lcu-h{display:block;font-size:.82rem;margin-top:6px}.lcu-f label{display:block;font-size:.85rem;color:var(--soft);margin-top:8px}.lcu-f input,.lcu-f select{display:block;width:100%;margin:4px 0;padding:10px 12px;border:1px solid var(--line);border-radius:10px;font:inherit;background:#fff;color:var(--ink)}.lcu-f button{margin-top:10px;padding:10px 14px;border:0;border-radius:10px;background:var(--ink);color:#fff;font:inherit;font-weight:700;cursor:pointer;text-transform:none;letter-spacing:normal}.lcu-f button.sec2{background:#fff;color:var(--ink);border:1px solid var(--line)}.lcu-w{margin:10px 0 0;font-size:.9rem}.lcu-w.bad{color:var(--red);font-weight:700}' +
      '.o-add{display:block;margin-top:10px;padding:12px;border:1.5px dashed var(--line);border-radius:12px;text-align:center;color:var(--blue);font-weight:700;text-decoration:none}.ocr{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;padding:8px 0;border-bottom:1px solid #eef0f3;font-size:.92rem}.ocr b{text-align:right;font-weight:600}.ocr.bad b{color:var(--red)}.ocr.warn b{color:var(--amber)}.ocr a{color:var(--blue)}' +
      '#oForm{display:block;margin:0}#oForm [hidden]{display:none!important}#oForm h3{margin:22px 0 4px;font-size:.78rem;letter-spacing:.06em;text-transform:uppercase;color:var(--faint)}#oForm .o-msg{margin:8px 0 0}#oForm textarea{resize:vertical;min-height:80px}#oPick{margin-top:6px}#oTen .o-t{margin-bottom:6px}' +
      '#oForm label{display:block;font-size:.85rem;color:var(--soft);margin-top:10px;font-weight:600}#oForm input,#oForm select,#oForm textarea{display:block;width:100%;margin:4px 0;padding:10px 12px;border:1px solid var(--line);border-radius:10px;font:inherit;background:#fff;color:var(--ink)}#oForm button{padding:10px 14px;border:0;border-radius:10px;background:var(--ink);color:#fff;font:inherit;font-weight:700;cursor:pointer}#oForm button[type=submit]{margin-top:14px;width:100%;padding:13px}.o-pc{display:flex;gap:6px}.o-pc input{flex:1}.o-t{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px}#oTenAdd{color:var(--blue);font-weight:600;font-size:.9rem}.pacts button.sec2{background:#fff;color:var(--ink);border:1px solid var(--line)}.pacts button:disabled{opacity:.7;cursor:default}@media(max-width:520px){.o-t{grid-template-columns:1fr}.o-t input:first-child{margin-top:10px}}</style>';
    res.send(trackShell('Your properties', css + '<script>document.body.setAttribute("data-lt", ' + JSON.stringify(token).replace(/</g, '\\u003c') + ');document.body.setAttribute("data-me", ' + JSON.stringify(String(l.name || '').trim() || 'Your landlord').replace(/</g, '\\u003c') + ');</script><div id="top"></div><h1>Hi ' + htmlEsc(String(l.name || '').trim() || 'there') + '</h1><p class="sub">Your properties with Residential Realtors.</p>' +
      // Home: a few numbers, then every property — tap one to open it.
      (!Object.keys(keys).length ? '' : '<div class="tiles"><div class="tile"><b>' + open.length + '</b><span>Open repair' + (open.length === 1 ? '' : 's') + '</span></div>' +
        '<a class="tile" href="#spending"><b>' + money(unpaid.reduce(function (t, i) { return t + Number(i.total || 0); }, 0)) + '</b><span>To pay' + (unpaid.length ? ' (' + unpaid.length + ' invoice' + (unpaid.length === 1 ? '' : 's') + ')' : '') + '</span></a>' +
        '<a class="tile" href="#spending"><b>' + money(sumOf(thisYr)) + '</b><span>Spent on repairs in ' + yr + '</span></a></div>') +
      (homeView ? '<section class="lview" id="home">' + (quick.length ? '<div class="card"><h2>' + (owns.length ? 'Managed by us' : 'Your properties') + '</h2><p class="muted" style="margin:-4px 0 6px">Tap a property to see its repairs, tenancy, certificates and costs.</p>' +
        (quick.length + owns.length > 4 ? '<input id="lfind" type="search" placeholder="Find a property…" autocomplete="off">' : '') + '<div class="qlist">' + quick.join('') + '</div></div>' : '') +
        '<div class="card"><h2>' + (quick.length ? 'Your other properties' : 'Your properties') + '</h2>' + (owns.length ? '<div class="qlist">' + ownRows.join('') + '</div>' : '<p class="muted" style="margin:-4px 0 6px">Keep all your properties in one place — even ones we don’t manage. We’ll find each EPC automatically.</p>') +
          '<a class="o-add" href="#add">＋ Add a property</a></div>' +
        (quick.length ? '<a class="card qrow lspend" href="#spending"><span class="qa">🧾 Invoices &amp; spending' + (unpaidInv.length ? ' · <span class="due">' + money(toPay) + ' to pay</span>' : invs.length ? ' · all paid' : '') + '</span><span class="qgo">›</span></a>' : '') + '</section>' : '') +
      propBlocks + ownViews + ownForm +
      (!homeView ? '<div class="lone"><a class="card qrow lspend" href="#spending"><span class="qa">🧾 Invoices &amp; spending' + (unpaidInv.length ? ' · <span class="due">' + money(toPay) + ' to pay</span>' : invs.length ? ' · all paid' : '') + '</span><span class="qgo">›</span></a><a class="card qrow lspend" href="#add"><span class="qa">＋ Add a property we don’t manage</span><span class="qgo">›</span></a></div>' : '') +
      '<section class="lview" id="spending" hidden><a class="lback" href="#">← Back</a>' + invCard + spendCard.replace(' id="spending"', '') + '</section>' +
      ownScript + ownPropScript + certUpScript +
      '<script>(function(){var f=document.getElementById("lfind");if(f)f.addEventListener("input",function(){var q=f.value.trim().toLowerCase();document.querySelectorAll(".qrow[data-find]").forEach(function(el){el.style.display=!q||el.getAttribute("data-find").indexOf(q)!==-1?"":"none";});});' +
        // One view at a time, chosen by the address bar (so Back works).
        'var views=[].slice.call(document.querySelectorAll(".lview")),lone=document.querySelector(".lone");' +
        'var route=function(){var h=decodeURIComponent(location.hash.slice(1)),t=h&&document.getElementById(h);if(!t||!t.classList.contains("lview"))t=views[0];views.forEach(function(v){v.hidden=v!==t;});if(lone)lone.hidden=!t.classList.contains("pv");var ti=document.querySelector(".tiles");if(ti)ti.hidden=t.classList.contains("pv")&&views.length>2;window.scrollTo(0,0);};' +
        'window.addEventListener("hashchange",route);route();' +
        'var pick=function(pv,name){pv.querySelectorAll(".ptabs button").forEach(function(b){b.classList.toggle("on",b.getAttribute("data-t")===name);});pv.querySelectorAll(".ppane").forEach(function(p){p.hidden=p.getAttribute("data-p")!==name;});};' +
        'document.querySelectorAll(".pv:not(.ov)").forEach(function(pv){pv.querySelector(".ptabs").addEventListener("click",function(e){var b=e.target.closest("button");if(b)pick(pv,b.getAttribute("data-t"));});' +
          'var r=pv.querySelector(".go-rep");if(r)r.addEventListener("click",function(){pick(pv,"rep");var d=pv.querySelector(".lr");if(d){d.open=true;d.scrollIntoView({behavior:"smooth",block:"start"});var i=d.querySelector("input");if(i)setTimeout(function(){i.focus();},300);}});' +
          'var m=pv.querySelector(".go-msg");if(m)m.addEventListener("click",function(){pick(pv,"tcy");var d=pv.querySelector(".lt-msg");if(d){d.open=true;d.scrollIntoView({behavior:"smooth",block:"start"});}});});' +
      '})();</script>' +
      '<p class="muted" style="text-align:center;margin-top:18px">Questions? Reply to our message or call the office.</p>', true));
  }));

  // The tenant page sends its photos here one at a time, straight after the
  // report itself is saved, so a slow connection never loses the whole report.
  // Only for a couple of hours after the report, and up to 30 photos.
  app.post('/api/t/:token/photo', withDb(async function (p, req, res) {
    const token = String(req.params.token || '');
    if (!/^[A-Za-z0-9_-]{20,}$/.test(token)) return res.status(404).json({ ok: false });
    const j = (await p.query(`SELECT id FROM jobs WHERE track_token = $1 AND archived_at IS NULL AND created_at > now() - interval '3 hours'`, [token])).rows[0];
    if (!j) return res.status(404).json({ ok: false, error: 'not-found' });
    const photos = decodePhotos([(req.body || {}).photo]);
    if (!photos.length) return res.status(400).json({ ok: false, error: 'no-photo' });
    const n = parseInt((await p.query("SELECT count(*) FROM job_photos WHERE job_id = $1 AND added_by = 'tenant'", [j.id])).rows[0].count, 10);
    if (n >= MAX_PHOTOS_PER_UPLOAD) return res.status(409).json({ ok: false, error: 'too-many' });
    await insertPhotos(p, j.id, photos, 'tenant');
    await p.query('UPDATE jobs SET photo_count = GREATEST(photo_count, $2) WHERE id = $1', [j.id, n + 1]);
    res.json({ ok: true });
  }));

  app.get('/t/:token', withDb(async function (p, req, res) {
    countVisit(req, 'track').catch(function () {});
    res.setHeader('X-Robots-Tag', 'noindex'); res.setHeader('Referrer-Policy', 'no-referrer');
    const token = String(req.params.token || '');
    if (!/^[A-Za-z0-9_-]{20,}$/.test(token)) return res.status(404).send('Not found');
    const j = (await p.query(`SELECT id, status, urgency, created_at, updated_at, completed_at, category, affected, symptom, location, property_address, direct_contact, appointment_date, appointment_time, assigned_to, assigned_to_2, landlord_handles
      FROM jobs WHERE track_token = $1 AND archived_at IS NULL`, [token])).rows[0];
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (!j) return res.status(404).send(trackShell('Repair not found', '<h1>Repair not found</h1><p class="sub">This link is no longer available. <a class="more" href="/track">Look up a repair</a></p>'));
    const u = (await p.query(`SELECT created_at, body FROM job_updates WHERE job_id = $1 AND kind = 'tenant_message' ORDER BY created_at DESC LIMIT 10`, [j.id])).rows;
    // Contractor names never show here (this link also goes to landlords).
    const names = (await p.query("SELECT name FROM contractors WHERE coalesce(trim(name), '') <> ''")).rows.map(function (r) { return r.name.trim(); });
    [j.assigned_to, j.assigned_to_2].forEach(function (n) { if (n && n.trim() && names.indexOf(n.trim()) === -1) names.push(n.trim()); });
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
    const auto = await autoJobInvoice(p, id);
    res.json({ ok: true, part: r.rows[0], invoice: auto });
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
    const auto = await autoJobInvoice(p, cur.job_id);
    res.json({ ok: true, invoice: auto });
  }));
  app.delete('/api/admin/parts/:id', withDb(async function (p, req, res) {
    const r = await p.query('DELETE FROM job_parts WHERE id = $1 RETURNING *', [jobId(req)]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'not-found' });
    await p.query('INSERT INTO job_updates (job_id, kind, body) VALUES ($1, $2, $3)', [r.rows[0].job_id, 'change', 'Part removed: ' + r.rows[0].description]);
    const auto = await autoJobInvoice(p, r.rows[0].job_id);
    res.json({ ok: true, invoice: auto });
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

  // ---------- A report PDF added by staff ----------
  // A PDF from the tenant page that never reached us (e.g. the tenant emailed
  // or WhatsApped it): read its details and photos and save it as a job.
  // Shared with the one-off imports below. The job keeps the time the tenant
  // made the PDF (its "RR-…" reference is that time, written in base 36).
  async function importReportPdf(p, pdf, filename) {
    const r = readReportPdf(pdf);
    if (!r) return { error: 'not-a-report' };
    if (r.tenantRef) {
      const had = (await p.query("SELECT job_id FROM job_updates WHERE kind = 'created' AND body LIKE $1 LIMIT 1", ['%(tenant’s reference ' + r.tenantRef + ')%'])).rows[0];
      if (had) return { error: 'already-added', id: had.job_id, ref: refFor(had.job_id) };
    }
    const saved = await saveReport(r.report, pdf.toString('base64'), String(filename || 'Repair-Report.pdf').replace(/[^a-zA-Z0-9.\-_]+/g, '-'), r.lines.join('\n'), r.photos);
    if (!saved) return { error: 'no-db' };
    await p.query("UPDATE job_updates SET body = body || $2 WHERE job_id = $1 AND kind = 'created'",
      [saved.id, ' Added from the tenant’s PDF' + (r.tenantRef ? ' (tenant’s reference ' + r.tenantRef + ')' : '') + '.']);
    const made = r.tenantRef ? parseInt(r.tenantRef.slice(3), 36) : NaN;
    if (made > Date.now() - 90 * 86400000 && made <= Date.now()) {
      await p.query('UPDATE jobs SET created_at = $2 WHERE id = $1', [saved.id, new Date(made)]);
      await p.query("UPDATE job_updates SET created_at = $2 WHERE job_id = $1 AND kind = 'created'", [saved.id, new Date(made)]);
    }
    return { id: saved.id, ref: saved.ref, photos: r.photos.length };
  }
  app.post('/api/admin/import-report', withDb(async function (p, req, res) {
    const out = await importReportPdf(p, Buffer.from(String((req.body || {}).pdfBase64 || ''), 'base64'), (req.body || {}).filename);
    if (out.error) return res.status(out.error === 'already-added' ? 409 : out.error === 'not-a-report' ? 400 : 500).json(Object.assign({ ok: false }, out));
    res.json(Object.assign({ ok: true }, out));
  }));
  // Reports that never reached us, added once on start-up. Each file in
  // imports/ is a tenant's PDF locked with IMPORT_KEY (AES-256-GCM: 12-byte IV,
  // 16-byte tag, then the data), so no tenant details are readable in the code.
  setTimeout(function () {
    const key = /^[0-9a-f]{64}$/i.test(process.env.IMPORT_KEY || '') ? Buffer.from(process.env.IMPORT_KEY, 'hex') : null;
    const dir = require('path').join(__dirname, 'imports');
    if (!key || !require('fs').existsSync(dir)) return;
    db().then(async function (p) {
      if (!p) return;
      for (const f of require('fs').readdirSync(dir).filter(function (n) { return /\.enc$/.test(n); })) {
        try {
          const blob = require('fs').readFileSync(require('path').join(dir, f));
          const d = require('crypto').createDecipheriv('aes-256-gcm', key, blob.slice(0, 12));
          d.setAuthTag(blob.slice(12, 28));
          const pdf = Buffer.concat([d.update(blob.slice(28)), d.final()]);
          const out = await importReportPdf(p, pdf, 'Repair-Report.pdf');
          console.log('Report import ' + f + ': ' + (out.error ? out.error + (out.ref ? ' (' + out.ref + ')' : '') : 'added as ' + out.ref + ' with ' + out.photos + ' photo(s)'));
        } catch (err) { console.error('Report import ' + f + ' failed:', err.message); }
      }
    }).catch(function (err) { console.error('Report import failed:', err.message); });
  }, 30 * 1000);

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
    if (toKey !== fromKey) await p.query('DELETE FROM property_info WHERE property_key = $1 AND EXISTS (SELECT 1 FROM property_info x WHERE x.property_key = $2 AND coalesce(x.key_number, x.key_notes) IS NOT NULL)', [fromKey, toKey]);
    if (toKey !== fromKey) await p.query('DELETE FROM property_info WHERE property_key = $2 AND EXISTS (SELECT 1 FROM property_info x WHERE x.property_key = $1)', [fromKey, toKey]);
    await p.query('UPDATE property_info SET property_key = $2, address = $3, updated_at = now() WHERE property_key = $1', [fromKey, toKey, to]);
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
  // One-off repair: an EPC check once renamed properties to the register's
  // shorter spelling, dropping part of the address ("Flat 5 Windsor Court 23
  // Coopers Road" became "Flat 5, Windsor Court"). Put the full address back
  // wherever a change only removed numbers and the property still has the
  // shorter address.
  async function restoreDroppedNumbers(p) {
    if ((await p.query("SELECT 1 FROM app_settings WHERE key = 'restore_numbers_v1'")).rows.length) return;
    const nums = function (s) { return (String(s).replace(POSTCODE_RE, ' ').match(/\b\d+[a-z]?\b/gi) || []).map(function (x) { return x.toUpperCase(); }); };
    const code = function (s) { const m = POSTCODE_RE.exec(String(s)); return m ? (m[1] + m[2]).toUpperCase() : ''; };
    const seen = {};
    const logs = (await p.query("SELECT body FROM job_updates WHERE kind = 'change' AND body LIKE 'Property: % → %' ORDER BY created_at DESC")).rows;
    for (const r of logs) {
      const m = /^Property: ([\s\S]+?) → ([\s\S]+)$/.exec(r.body);
      if (!m || seen[m[1] + '|' + m[2]]) continue;
      seen[m[1] + '|' + m[2]] = true;
      const from = m[1].trim(), to = m[2].trim(), fn = nums(from), tn = nums(to);
      if (!code(from) || code(from) !== code(to)) continue;
      if (!tn.every(function (n) { return fn.indexOf(n) !== -1; }) || fn.length <= tn.length) continue;
      const toKey = propKey(to);
      if (!(await allProperties(p)).some(function (x) { return x.key === toKey; })) continue;
      await renameProperty(p, toKey, from);
      console.log('Address restored: ' + to + ' → ' + from);
    }
    await p.query(`INSERT INTO app_settings (key, value) VALUES ('restore_numbers_v1', 'true') ON CONFLICT (key) DO NOTHING`);
  }
  setTimeout(function () { db().then(function (p) { return p && restoreDroppedNumbers(p); }).catch(function (err) { console.error('Address restore failed:', err.message); }); }, 25 * 1000);

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
  // A gas safety, EICR or EPC job completed: the property's certificate is
  // renewed from the date it was done (expiry worked out from how long it lasts).
  async function recordCertFromJob(p, jobId, date, by) {
    const j = (await p.query('SELECT id, property_address, category, affected FROM jobs WHERE id = $1', [jobId])).rows[0];
    const type = j && certTypeOf(j.category, j.affected), issued = isoDay(date);
    if (!type || !issued || !j.property_address) return null;
    const key = propKey(j.property_address); if (!key) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(issued), def = CERT_TYPES[type];
    const ex = new Date(Date.UTC(+m[1] + def.years, +m[2] - 1, +m[3] - 1)).toISOString().slice(0, 10);   // e.g. 1 Oct 2026 → 30 Sep 2027
    await p.query(`INSERT INTO property_certificates (property_key, address, type, issued_on, expires_on, not_required)
      VALUES ($1, $2, $3, $4, $5, false)
      ON CONFLICT (property_key, type) DO UPDATE SET address = coalesce(property_certificates.address, excluded.address), issued_on = excluded.issued_on, expires_on = excluded.expires_on,
        not_required = false, reminded_at = NULL, job_id = NULL, updated_at = now()`, [key, j.property_address, type, issued, ex]);
    await p.query('INSERT INTO job_updates (job_id, kind, body) VALUES ($1, $2, $3)', [j.id, 'note', def.name + ' recorded' + (by ? ' by ' + by : '') + ': done ' + certDay(issued) + ', expires ' + certDay(ex) + '. Certificates updated.']);
    return { type: type, issued: issued, expires: ex };
  }
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
      manage_basis: b.manage_basis === 'upfront' ? 'upfront' : 'monthly', find_unit: b.find_unit === 'gbp' ? 'gbp' : 'pct', collect_unit: b.collect_unit === 'gbp' ? 'gbp' : 'pct', manage_unit: b.manage_unit === 'gbp' ? 'gbp' : 'pct', collect_pct: amt(b.collect_pct), manage_pct: amt(b.manage_pct),
      credits: (Array.isArray(b.credits) ? b.credits : []).slice(0, 20).map(function (f) { return { label: s(f && f.label, 200), amount: amt(f && f.amount) }; }).filter(function (f) { return f.label && f.amount; }),
      fees: (Array.isArray(b.fees) ? b.fees : []).slice(0, 30).map(function (f) { const x = { label: s(f && f.label, 200), amount: amt(f && f.amount) }; if (f && f.novat === true) x.novat = true; return x; }).filter(function (f) { return f.label; }),
      vat: b.vat !== false, statement_date: day(b.statement_date), notes: s(b.notes, 4000),
      // Banking trail: each payment received.
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
    const r = await p.query('SELECT id, property_key, address, start_date, data, log, intention, created_at, updated_at FROM tenancies ORDER BY start_date DESC NULLS LAST, id DESC');
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
    // Kept from the saved tenancy: its move-in fees invoice and whether the landlord paid.
    const r = await p.query(`UPDATE tenancies SET property_key = $2, address = $3, start_date = $4,
        data = $5::jsonb || jsonb_strip_nulls(jsonb_build_object('fees_invoice_id', data->'fees_invoice_id', 'fees_paid', data->'fees_paid', 'stmt_sent', data->'stmt_sent', 'month_costs', data->'month_costs')), updated_at = now() WHERE id = $1 RETURNING id`,
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
  // ---------- Form 4A: landlord's notice proposing a new rent (Housing Act 1988 s.13(2)) ----------
  // The official form is filled in from the tenancy (and kept editable). The new rent
  // must start: at least 2 months after the notice is served; no sooner than 52 weeks
  // after the tenancy began (or the last increase); and on a rent day (Note A).
  const isoD = function (v) { return v instanceof Date ? v.toISOString().slice(0, 10) : (/^\d{4}-\d{2}-\d{2}/.test(String(v || '')) ? String(v).slice(0, 10) : ''); };
  const addDaysIso = function (iso, n) { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const addMonthsIso = function (iso, n) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso); if (!m) return ''; const d = new Date(Date.UTC(+m[1], +m[2] - 1 + n, +m[3])); if (d.getUTCDate() !== +m[3]) d.setUTCDate(0); return d.toISOString().slice(0, 10); };
  // The first rent day (same day of the month as the tenancy began) on or after `iso`.
  const rentDayOnOrAfter = function (iso, startIso) {
    const sd = +startIso.slice(8, 10);
    for (let k = 0; k < 3; k++) {
      const d = new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1 + k, 1)), last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      const c = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), Math.min(sd, last))).toISOString().slice(0, 10);
      if (c >= iso) return c;
    }
    return iso;
  };
  function form4aPlan(t, served) {
    const d = t.data || {}, start = isoD(d.start_date || t.start_date), today = served || new Date().toISOString().slice(0, 10);
    const incs = Object.keys(t.intention || {}).map(function (k) { const it = t.intention[k] || {}; return Number(it.new_rent) && !it.no_increase ? { rent: Number(it.new_rent), from: it.rent_from || k } : null; })
      .filter(Boolean).sort(function (a, b) { return a.from < b.from ? -1 : 1; });
    const done = incs.filter(function (x) { return x.from <= today; });
    const last = done.length ? done[done.length - 1] : null, firstInc = incs.length ? incs[0].from : '';
    const rent = last ? last.rent : Number(d.rent_pcm) || 0;
    if (!start) return { ok: false, error: 'no-start-date' };
    const earliest = rentDayOnOrAfter([addMonthsIso(today, 2), addDaysIso(last ? last.from : start, 364)].sort().pop(), start);
    // Rent goes up at most every 12 months, with 2 months' notice: the notice can be
    // prepared from month 10 (10 months after the tenancy began, or the last increase).
    const opensOn = addMonthsIso(last ? last.from : start, 10);
    return { ok: true, start: start, rent: rent, lastIncrease: last ? last.from : '', firstIncrease: firstInc && firstInc <= today ? firstInc : '', earliest: earliest, served: today, rentDay: +start.slice(8, 10), opensOn: opensOn, open: today >= opensOn };
  }
  function f4aCheck(plan, newStart) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(newStart || '')) return 'Choose the date the new rent starts.';
    if (newStart < addMonthsIso(plan.served, 2)) return 'The notice must be served at least 2 months before the new rent starts — the earliest is ' + certDay(plan.earliest) + '.';
    if (newStart < addDaysIso(plan.lastIncrease || plan.start, 364)) return 'The new rent can’t start until 52 weeks after ' + (plan.lastIncrease ? 'the last increase' : 'the tenancy began') + ' — the earliest is ' + certDay(plan.earliest) + '.';
    if (+newStart.slice(8, 10) !== plan.rentDay && !(plan.rentDay > 28 && newStart === rentDayOnOrAfter(newStart.slice(0, 8) + '01', plan.start))) return 'The new rent must start on a rent day (the ' + plan.rentDay + (plan.rentDay % 10 === 1 && plan.rentDay !== 11 ? 'st' : plan.rentDay % 10 === 2 && plan.rentDay !== 12 ? 'nd' : plan.rentDay % 10 === 3 && plan.rentDay !== 13 ? 'rd' : 'th') + ' of the month).';
    return null;
  }
  // "Flat 9, Picker Court, London SE1 9ZZ" → first line, second line, town, postcode.
  function addrLines(a) {
    const m = POSTCODE_RE.exec(String(a || '')), pc = m ? (m[1] + ' ' + m[2]).toUpperCase() : '';
    const parts = String(a || '').replace(POSTCODE_RE, '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    const town = parts.length > 1 ? parts.pop() : '';
    return { l1: parts.length > 1 ? parts.slice(0, -1).join(', ') : (parts[0] || ''), l2: parts.length > 1 ? parts[parts.length - 1] : '', town: town, pc: pc };
  }
  const ukD = function (iso) { return iso ? iso.slice(8, 10) + iso.slice(5, 7) + iso.slice(0, 4) : ''; };   // the form's date boxes: DDMMYYYY, one digit per square
  async function fillForm4a(t, o) {
    const { PDFDocument } = require('pdf-lib');
    const doc = await PDFDocument.load(require('fs').readFileSync(require('path').join(__dirname, 'forms', 'form-4a.pdf')));
    const form = doc.getForm(), d = t.data || {}, plan = o.plan;
    const set = function (name, v) { try { form.getTextField(name).setText(v == null ? '' : String(v)); } catch (e) { /* field missing */ } };
    const tick = function (name, on) { try { const c = form.getCheckBox(name); if (on) c.check(); else c.uncheck(); } catch (e) {} };
    const prop = addrLines(d.address || t.address);
    set('Text Field 109', (d.tenants || []).map(function (x) { return x && x.name; }).filter(Boolean).join(', '));
    set('Text Field 93', prop.l1); set('Text Field 92', prop.l2); set('Text Field 91', prop.town); set('Text Field 90', ''); set('Text Field 1018', prop.pc);
    // The landlord: their own address, else care of the agent (where the tenant can serve documents).
    const ll = o.landlord || {}, la = ll.l1 || POSTCODE_RE.test(ll.pc || '') ? ll : (o.agent ? Object.assign({}, addrLines(INVOICE.address), { l1: 'c/o ' + INVOICE.from + ', ' + addrLines(INVOICE.address).l1 }) : {});
    set('Text Field 95', ll.name || ''); set('Text Field 107', la.l1 || ''); set('Text Field 106', la.l2 || ''); set('Text Field 105', la.town || ''); set('Text Field 104', ''); set('Text Field 103', la.pc || '');
    set('Text Field 99', ll.phone || ''); set('Text Field 100', o.landlordEmail ? ll.email || '' : '');
    if (o.agent) {
      const ag = addrLines(INVOICE.address);
      set('Text Field 128', INVOICE.from); set('Text Field 1017', ag.l1); set('Text Field 1016', ag.l2); set('Text Field 1015', ag.town); set('Text Field 1011', ''); set('Text Field 1010', ag.pc);
      set('Text Field 127', process.env.OFFICE_PHONE || ''); set('Text Field 101', process.env.OFFICE_EMAIL || '');
    }
    set('Text Field 114', plan.rent ? plan.rent.toFixed(2) : ''); set('Text Field 113', 'per month');
    set('Text Field 102', ukD(plan.start)); set('Text Field 1014', ukD(plan.lastIncrease)); set('Text Field 1012', ukD(plan.firstIncrease));
    set('Text Field 116', Number(o.newRent).toFixed(2)); set('Text Field 115', 'per month'); set('Text Field 108', ukD(o.newStart));
    ['129', '130', '131', '132', '133', '134', '135', '136', '137', '138'].forEach(function (n) { set('Text Field ' + n, 'nil'); });   // bills in the rent: none unless changed
    tick('Check Box 37', o.as !== 'agent'); tick('Check Box 36', o.as === 'agent');
    set('Text Field 111', o.sign ? o.signer : ''); set('Text Field 112', o.signer || ''); set('Text Field 1013', ukD(plan.served));
    return Buffer.from(await doc.save());
  }
  // What the form needs from the request, checked; the tenancy's intention is updated so the new rent shows everywhere.
  async function form4aFor(p, t, b, who) {
    const plan = form4aPlan(t, isoDay(b.served) || null);
    if (!plan.ok) return { error: 'This tenancy has no start date.' };
    if (!plan.open) return { error: 'A rent increase notice can be prepared from ' + certDay(plan.opensOn) + ' — 10 months after ' + (plan.lastIncrease ? 'the last increase' : 'the tenancy began') + ', so the new rent starts 12 months on with 2 months’ notice.' };
    const pct = b.pct === undefined || b.pct === '' ? null : Number(String(b.pct).replace(/[%\s]/g, ''));
    const newRent = money(b.new_rent) || (pct && isFinite(pct) && pct > 0 ? Math.round(plan.rent * (1 + pct / 100) * 100) / 100 : null);
    if (!newRent) return { error: 'Enter the new rent.' };
    if (newRent <= plan.rent) return { error: 'The new rent must be more than the current rent (£' + plan.rent.toFixed(2) + ').' };
    const newStart = String(b.start || plan.earliest), bad = f4aCheck(plan, newStart);
    if (bad) return { error: bad };
    const signer = str(b.signer, 120) || '';
    if (!signer) return { error: 'Enter the name of the person signing.' };
    const pdf = await fillForm4a(t, { plan: plan, newRent: newRent, newStart: newStart, signer: signer, sign: !!b.sign, as: who.as, agent: who.agent, landlord: who.landlord, landlordEmail: !!b.landlord_email });
    // Recorded against the anniversary it belongs to.
    const key = nextTermEnd(plan.start, 12, plan.served) || newStart;
    await p.query(`UPDATE tenancies SET intention = intention || jsonb_build_object($2::text, coalesce(intention->$2, '{}'::jsonb) || jsonb_build_object('new_rent', $3::numeric, 'rent_from', $4::text, 'no_increase', false, 'form4a_at', $5::text, 'form4a_by', $6::text)) WHERE id = $1`,
      [t.id, key, newRent, newStart, new Date().toISOString(), who.by]);
    await p.query('UPDATE tenancies SET log = log || $2::jsonb, updated_at = now() WHERE id = $1',
      [t.id, JSON.stringify([{ at: new Date().toISOString(), text: 'Form 4A rent increase notice prepared by ' + who.by + ': £' + newRent.toFixed(2) + ' a month from ' + certDay(newStart) + '.' }])]);
    return { pdf: pdf, newRent: newRent, newStart: newStart, plan: plan };
  }
  function landlordFromTenancy(t, lrec) {
    const l = (t.data || {}).landlord || {}, a = l.line1 || POSTCODE_RE.test(l.postcode || '') ? { l1: l.line1 || '', l2: l.line2 || '', town: '', pc: POSTCODE_RE.test(l.postcode || '') ? l.postcode : '' } : addrLines((lrec && lrec.address) || '');
    return Object.assign({ name: l.name || (lrec && lrec.name) || '', phone: l.phone || (lrec && lrec.phone) || '', email: l.email || (lrec && lrec.email) || '' }, a);
  }
  app.get('/api/admin/tenancies/:id/form4a-plan', withDb(async function (p, req, res) {
    const t = (await p.query('SELECT id, address, start_date, data, intention FROM tenancies WHERE id = $1', [jobId(req)])).rows[0];
    if (!t) return res.status(404).json({ ok: false, error: 'not-found' });
    res.json(form4aPlan(t));
  }));
  app.post('/api/admin/tenancies/:id/form4a', withDb(async function (p, req, res) {
    const t = (await p.query('SELECT id, address, start_date, data, intention FROM tenancies WHERE id = $1', [jobId(req)])).rows[0];
    if (!t) return res.status(404).json({ ok: false, error: 'not-found' });
    const lrec = (await p.query('SELECT l.name, l.email, l.phone, l.address FROM property_landlords pl JOIN landlords l ON l.id = pl.landlord_id WHERE pl.property_key = $1', [propKey(t.address)])).rows[0];
    const r = await form4aFor(p, t, req.body || {}, { as: 'agent', agent: true, landlord: landlordFromTenancy(t, lrec), by: 'Residential Realtors' });
    if (r.error) return res.status(400).json({ ok: false, error: r.error });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="Form-4A-' + (addrLines(t.address).l1 || 'rent-increase').replace(/[^A-Za-z0-9]+/g, '-') + '.pdf"');
    res.send(r.pdf);
  }));
  app.post('/l/:token/tenancies/:id/form4a', withDb(async function (p, req, res) {
    if (portalLimited(req)) return res.status(429).json({ ok: false, error: 'rate-limited' });
    const who = await landlordByToken(p, req.params.token);
    if (!who) return res.status(404).json({ ok: false, error: 'not-found' });
    const t = (await p.query('SELECT id, address, property_key, start_date, data, intention FROM tenancies WHERE id = $1', [jobId(req)])).rows[0];
    if (!t || who.keys[t.property_key] === undefined) return res.status(404).json({ ok: false, error: 'not-found' });
    const b = req.body || {}, svc = String((t.data || {}).service || '');
    const r = await form4aFor(p, t, b, { as: 'landlord', agent: b.agent === undefined ? !/tenant find/i.test(svc) || !svc : !!b.agent, landlord: landlordFromTenancy(t, who.l), by: 'the landlord, ' + (who.l.name || '') });
    if (r.error) return res.status(400).json({ ok: false, error: r.error });
    ntfy({ title: 'Landlord prepared a rent increase notice', message: (who.l.name || 'A landlord') + ' — ' + t.address + ': Form 4A, new rent £' + r.newRent.toFixed(2) + ' a month from ' + certDay(r.newStart) + '.', tags: ['page_facing_up'] }).catch(function () {});
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="Form-4A-' + (addrLines(t.address).l1 || 'rent-increase').replace(/[^A-Za-z0-9]+/g, '-') + '.pdf"');
    res.send(r.pdf);
  }));

  // Cancel a proposed rent increase that hasn't started yet: the new rent comes off
  // the tenancy (so a fresh one can be proposed) and the history notes it.
  async function cancelIncrease(p, t, by) {
    const today = new Date().toISOString().slice(0, 10), it = t.intention || {};
    const keys = Object.keys(it).filter(function (k) { const x = it[k] || {}; return Number(x.new_rent) && !x.no_increase && (x.rent_from || k) > today; });
    if (!keys.length) return { error: 'There’s no proposed increase to cancel (one that has already started can’t be cancelled here).' };
    const was = keys.map(function (k) { return '£' + Number(it[k].new_rent).toFixed(2) + ' from ' + certDay(it[k].rent_from || k); }).join(', ');
    for (const k of keys) {
      await p.query(`UPDATE tenancies SET intention = jsonb_set(intention, ARRAY[$2::text], (intention->$2) - 'new_rent' - 'rent_from' - 'form4a_at' - 'form4a_by' - 'notice_served' - 'notice_how' || jsonb_build_object('increase_cancelled_at', $3::text, 'increase_cancelled_by', $4::text)) WHERE id = $1`,
        [t.id, k, new Date().toISOString(), by]);
    }
    await p.query('UPDATE tenancies SET log = log || $2::jsonb, updated_at = now() WHERE id = $1', [t.id, JSON.stringify([{ at: new Date().toISOString(), text: 'Proposed rent increase cancelled by ' + by + ' (was ' + was + ').' }])]);
    return { ok: true, was: was };
  }
  app.post('/api/admin/tenancies/:id/cancel-increase', withDb(async function (p, req, res) {
    const t = (await p.query('SELECT id, address, intention FROM tenancies WHERE id = $1', [jobId(req)])).rows[0];
    if (!t) return res.status(404).json({ ok: false, error: 'not-found' });
    const r = await cancelIncrease(p, t, 'Residential Realtors');
    if (r.error) return res.status(400).json({ ok: false, error: r.error });
    res.json(r);
  }));
  app.post('/l/:token/tenancies/:id/cancel-increase', withDb(async function (p, req, res) {
    if (portalLimited(req)) return res.status(429).json({ ok: false, error: 'rate-limited' });
    const who = await landlordByToken(p, req.params.token);
    if (!who) return res.status(404).json({ ok: false, error: 'not-found' });
    const t = (await p.query('SELECT id, address, property_key, intention FROM tenancies WHERE id = $1', [jobId(req)])).rows[0];
    if (!t || who.keys[t.property_key] === undefined) return res.status(404).json({ ok: false, error: 'not-found' });
    const r = await cancelIncrease(p, t, 'the landlord, ' + (who.l.name || ''));
    if (r.error) return res.status(400).json({ ok: false, error: r.error });
    ntfy({ title: 'Landlord cancelled a rent increase', message: (who.l.name || 'A landlord') + ' — ' + t.address + ': cancelled the proposed new rent (' + r.was + ').', tags: ['x'] }).catch(function () {});
    res.json(r);
  }));

  // The tenants' plans for the end of this term: asked (how) and/or their answer.
  app.post('/api/admin/tenancies/:id/intention', withDb(async function (p, req, res) {
    const b = req.body || {}, end = String(b.period_end || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) return res.status(400).json({ ok: false, error: 'bad-date' });
    const cur = (await p.query('SELECT intention FROM tenancies WHERE id = $1', [jobId(req)])).rows[0];
    if (!cur) return res.status(404).json({ ok: false, error: 'not-found' });
    const it = Object.assign({}, (cur.intention || {})[end] || {}), notes = [];
    if (b.asked) { it.asked_at = new Date().toISOString(); it.how = str(b.asked, 40); notes.push('Asked the tenants their plans for the anniversary on ' + end + ' (' + it.how + ')'); }
    if (b.answer !== undefined) {
      it.answer = ['staying', 'leaving', 'undecided'].indexOf(b.answer) !== -1 ? b.answer : null; it.answered_at = new Date().toISOString();
      if (it.answer) notes.push('Tenants’ plans for ' + end + ': ' + { staying: 'staying on', leaving: 'moving out', undecided: 'not decided yet' }[it.answer]);
    }
    if (b.note !== undefined) it.note = str(b.note, 1000);
    if (b.new_rent !== undefined) {
      const v = money(b.new_rent);
      if (v) { it.new_rent = v; it.no_increase = false; it.rent_from = /^\d{4}-\d{2}-\d{2}$/.test(String(b.rent_from || '')) ? b.rent_from : end; notes.push('Rent review: ' + gbp(v) + ' a month from ' + it.rent_from); }
    }
    if (b.no_increase) { it.no_increase = true; it.new_rent = null; notes.push('Rent review for ' + end + ': no increase'); }
    if (b.asked_landlord) { it.ll_asked_at = new Date().toISOString(); it.ll_how = str(b.asked_landlord, 40); notes.push('Asked the landlord about a rent increase (' + it.ll_how + ')'); }
    if (b.notice_served !== undefined) {
      const on = String(b.notice_served || '');
      if (/^\d{4}-\d{2}-\d{2}$/.test(on)) { it.notice_served = on; it.notice_how = str(b.notice_how, 40); notes.push('Rent increase notice (Form 4A) served on ' + on + (it.notice_how ? ' by ' + it.notice_how : '')); }
    }
    if (b.told) { it.told_at = new Date().toISOString(); it.told_how = str(b.told, 40); notes.push('Told the tenants the rent from ' + end + ' (' + it.told_how + ')'); }
    await p.query(`UPDATE tenancies SET intention = intention || jsonb_build_object($2::text, $3::jsonb), log = log || $4::jsonb, updated_at = now() WHERE id = $1`,
      [jobId(req), end, JSON.stringify(it), JSON.stringify(notes.map(function (t) { return { at: new Date().toISOString(), text: t }; }))]);
    res.json({ ok: true, intention: it });
  }));
  // Something done with a tenancy (emails sent, documents made), for its history.
  // A payment received from the tenants, added while the tenancy is locked
  // (removing one still needs "Edit tenancy").
  app.post('/api/admin/tenancies/:id/receipts', withDb(async function (p, req, res) {
    const b = req.body || {}, amount = money(b.amount);
    if (!amount) return res.status(400).json({ ok: false, error: 'amount' });
    const rc = { desc: str(b.desc, 120) || 'Payment', date: isoDay(b.date) || new Date().toISOString().slice(0, 10), receipt: str(b.receipt, 40) || '', method: str(b.method, 12) || 'TRNF', amount: amount };
    const r = await p.query(`UPDATE tenancies SET data = jsonb_set(data, '{receipts}', coalesce(data->'receipts', '[]'::jsonb) || $2::jsonb),
        log = log || $3::jsonb, updated_at = now() WHERE id = $1 RETURNING data`,
      [jobId(req), JSON.stringify([rc]), JSON.stringify([{ at: new Date().toISOString(), text: 'Payment received: ' + gbp(amount) + ' — ' + rc.desc + ' (' + rc.date + ', ' + rc.method + ')' }])]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'not-found' });
    res.json({ ok: true, data: r.rows[0].data });
  }));
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
    const r = await p.query(`SELECT id, property_key, address, type, issued_on, expires_on, reference, rating, notes, not_required, job_id, reminded_at, updated_at,
      EXISTS (SELECT 1 FROM certificate_docs d WHERE d.cert_id = property_certificates.id) AS has_doc FROM property_certificates ORDER BY expires_on NULLS LAST`);
    const s = (await p.query("SELECT value FROM app_settings WHERE key = 'cert_contractors'")).rows[0];
    res.json({ ok: true, certificates: r.rows, contractors: (s && s.value) || {}, costs: await certCosts(p), remind_days: REMIND_DAYS });
  }));
  app.put('/api/admin/certificates', withDb(async function (p, req, res) {
    const out = await saveCertificate(p, req.body || {});
    res.status(out.status || 200).json(out.json);
  }));
  // Save a property's certificate (and its document, if one is sent): used by
  // the office and by landlords on their page.
  async function saveCertificate(p, b) {
    const key = propKey(b.address), type = CERT_TYPES[b.type] ? b.type : null;
    if (!key) return { status: 400, json: { ok: false, error: 'address-required' } };
    if (!type) return { status: 400, json: { ok: false, error: 'bad-type' } };
    const issued = b.issued_on ? isoDay(b.issued_on) : null, expires = b.expires_on ? isoDay(b.expires_on) : null;
    if ((b.issued_on && !issued) || (b.expires_on && !expires)) return { status: 400, json: { ok: false, error: 'bad-date' } };
    const notRequired = !!b.not_required;
    if (!expires && !notRequired) return { status: 400, json: { ok: false, error: 'expiry-required' } };
    const cur = (await p.query('SELECT id, expires_on, job_id FROM property_certificates WHERE property_key = $1 AND type = $2', [key, type])).rows[0];
    const renewed = !cur || cur.expires_on !== expires;
    const r = await p.query(`INSERT INTO property_certificates (property_key, address, type, issued_on, expires_on, reference, rating, notes, not_required)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (property_key, type) DO UPDATE SET address = excluded.address, issued_on = excluded.issued_on, expires_on = excluded.expires_on,
        reference = excluded.reference, rating = excluded.rating, notes = excluded.notes, not_required = excluded.not_required, updated_at = now()` +
        (renewed ? ', reminded_at = NULL, job_id = NULL' : '') + ' RETURNING id',
      [key, str(b.address, 500), type, notRequired ? null : issued, notRequired ? null : expires, str(b.reference, 100), str(b.rating, 5), str(b.notes, 1000), notRequired]);
    // The certificate document, when one is uploaded with it; a renewal without
    // one drops the old document (it would be out of date).
    const doc = b.doc && typeof b.doc.data === 'string' ? Buffer.from(b.doc.data.replace(/^data:[^,]*,/, ''), 'base64') : null;
    if (doc && doc.length && doc.length <= 15 * 1024 * 1024) {
      const mime = /^(application\/pdf|image\/(jpeg|png|webp|heic|heif))$/.test(String(b.doc.mime || '')) ? b.doc.mime : 'application/pdf';
      await p.query(`INSERT INTO certificate_docs (cert_id, name, mime, data) VALUES ($1, $2, $3, $4)
        ON CONFLICT (cert_id) DO UPDATE SET name = excluded.name, mime = excluded.mime, data = excluded.data, created_at = now()`, [r.rows[0].id, str(b.doc.name, 200) || 'certificate.pdf', mime, doc]);
    } else if (renewed && cur) await p.query('DELETE FROM certificate_docs WHERE cert_id = $1', [r.rows[0].id]);
    // Note it on the booked job, if there was one.
    if (cur && cur.job_id && renewed && expires) await p.query('INSERT INTO job_updates (job_id, kind, body) VALUES ($1, $2, $3)', [cur.job_id, 'note', CERT_TYPES[type].name + ' renewed — now expires ' + certDay(expires) + '.']);
    // An EPC picked from the register: use its exact address for the property.
    let renamedTo = null;
    if (type === 'EPC' && b.register_address) renamedTo = await adoptRegisterAddress(p, key, str(b.address, 500), b.register_address);
    // Already within 10 days? Raise the renewal job now rather than at the next check.
    if (expires && renewed) raiseCertificateJobs().catch(function (err) { console.error('Certificate jobs failed:', err.message); });
    return { json: { ok: true, id: r.rows[0].id, address: renamedTo } };
  }
  async function sendCertDoc(p, id, res) {
    const d = (await p.query('SELECT name, mime, data FROM certificate_docs WHERE cert_id = $1', [id])).rows[0];
    if (!d) return res.status(404).send('Not found');
    res.setHeader('Content-Type', d.mime || 'application/pdf'); res.setHeader('X-Robots-Tag', 'noindex');
    res.setHeader('Content-Disposition', 'inline; filename="' + String(d.name || 'certificate.pdf').replace(/[^a-zA-Z0-9.\-_ ]+/g, '-') + '"');
    res.send(d.data);
  }
  app.get('/api/admin/certificates/:id/doc', withDb(async function (p, req, res) { await sendCertDoc(p, jobId(req), res); }));
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
    // Whatever the building is called ("Galleons View", "Baltic Quay"): the words
    // between the flat number and the building's street number.
    const m = /\b\d+[a-z]?\b[\s,]+([a-z][a-z' ]*?[a-z])[\s,]+\d+[a-z]?\b/i.exec(String(s).replace(POSTCODE_RE, ' '));
    if (m) { const name = m[1].toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim(); if (name.split(' ').some(function (w) { return w.length >= 4 && EPC_STOP.indexOf(w) === -1; })) out.push(name); }
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
    // Never drop part of the address: when the register leaves something out
    // (e.g. "23 Coopers Road" when it just says "Flat 5, Windsor Court"), that
    // part is put back into the register's spelling.
    const merged = mergeMissingParts(to, current);
    if (!merged || merged === current) return null;
    await renameProperty(p, key, merged);
    return merged;
  }
  // The register's address with any numbered part of ours it lacks put back,
  // after the part it follows ("Flat 5, Windsor Court, 23 Coopers Road, London,
  // SE1 5JA"). Null when that can't be done cleanly.
  function mergeMissingParts(reg, ours) {
    const nums = function (s) { return (String(s).replace(POSTCODE_RE, ' ').match(/\b\d+[a-z]?\b/gi) || []).map(function (x) { return x.toUpperCase(); }); };
    const plain = function (s) { return String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); };
    let out = reg;
    for (const n of nums(ours)) {
      if (nums(out).indexOf(n) !== -1) continue;
      const body = String(ours).replace(POSTCODE_RE, ' ');
      const at = body.search(new RegExp('\\b' + n + '\\b', 'i'));
      if (at < 0) return null;
      // The missing part: the number and the words after it, up to a comma,
      // another number or a word the register already has (e.g. the town).
      const regWords = plain(out).split(' ');
      const words = body.slice(at).split(/\s+/), part = [words[0]];
      for (const w of words.slice(1)) {
        if (!w || /,$/.test(part[part.length - 1]) || /\d/.test(w) || regWords.indexOf(plain(w)) !== -1) break;
        part.push(w);
      }
      const segs = out.split(/\s*,\s*/);
      // Just the number, and the register has the street it belongs to
      // ("Windsor Court, Coopers Road"): put the number in front of the street.
      const next = words[1] ? plain(words[1]) : '';
      const street = part.length === 1 && next ? segs.findIndex(function (sg) { return plain(sg).split(' ')[0] === next && !POSTCODE_RE.test(sg); }) : -1;
      if (street !== -1) { segs[street] = part[0].replace(/,$/, '') + ' ' + segs[street]; out = tidyAddress(segs.join(', ')); continue; }
      const piece = registerAddress(part.join(' ').replace(/,$/, ''));
      // Put it after the last register part found in the text before it.
      const before = ' ' + plain(body.slice(0, at)) + ' ';
      let after = -1;
      segs.forEach(function (sg, i) { const t = plain(sg); if (t && !POSTCODE_RE.test(sg) && before.indexOf(' ' + t + ' ') !== -1) after = i; });
      segs.splice(after + 1, 0, piece);
      out = tidyAddress(segs.join(', '));
    }
    return nums(ours).every(function (n) { return nums(out).indexOf(n) !== -1; }) ? out : null;
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
      UNION SELECT address FROM property_landlords WHERE address IS NOT NULL UNION SELECT address FROM property_certificates WHERE address IS NOT NULL
      UNION SELECT address FROM property_info WHERE address IS NOT NULL UNION SELECT address FROM property_tenants WHERE address IS NOT NULL AND moved_out_at IS NULL`)).rows;
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
    db().then(function (p) { return p ? autoEpc(p, null, 1000).then(function (r) { return ownEpcAll(p).then(function () { return r; }); }) : null; })
      .then(function (r) { if (r && (r.checked || r.found)) console.log('EPC register: checked ' + r.checked + ', filled in ' + r.found); })
      .catch(function (err) { console.error('EPC register check failed:', err.message); })
      .then(function () { epcRunning = false; });
  }
  // When the matching improves, look again at properties it couldn't place.
  // (5: every property takes the register's full address again, keeping any part it lacks.)
  // (6: building names not ending in House/Court… — e.g. "Galleons View" — are recognised.)
  const EPC_MATCH_VERSION = '6';
  setTimeout(function () {
    db().then(async function (p) {
      if (!p) return;
      const v = (await p.query("SELECT value FROM app_settings WHERE key = 'epc_match_version'")).rows[0];
      if (v && String(v.value).replace(/"/g, '') === EPC_MATCH_VERSION) return;
      await p.query(`DELETE FROM epc_checks c WHERE c.found = false OR EXISTS (SELECT 1 FROM property_certificates pc
        WHERE pc.property_key = c.property_key AND pc.type = 'EPC' AND pc.expires_on <= to_char(now() + interval '60 days', 'YYYY-MM-DD'))`);
      await p.query('UPDATE epc_checks SET address_synced = false');
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
  // A tenancy carries on; every 12 months from the start is its anniversary,
  // when the rent can be reviewed. A rent increase needs the government notice
  // (Form 4A) served at least 2 months before, so about 3 months before each
  // anniversary: a phone alert (once) unless the review is already under way,
  // and another on the day it's 2 months to go if no notice is recorded.
  function nextTermEnd(start, months, today) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(start || '')); if (!m) return null;
    months = parseInt(months, 10) || 12;
    for (let k = 1; k < 200; k++) {
      const d = new Date(Date.UTC(+m[1], +m[2] - 1 + k * months, +m[3]));
      if (d.getUTCDate() !== +m[3]) d.setUTCDate(0);   // 31 Jan + 1 month → 28/29 Feb
      const iso = d.toISOString().slice(0, 10);
      if (iso >= today) return iso;
    }
    return null;
  }
  async function tenancyEndAlerts() {
    const p = await db(); if (!p) return;
    const today = new Date().toISOString().slice(0, 10), soon = new Date(Date.now() + 92 * 86400000).toISOString().slice(0, 10);
    for (const t of (await p.query('SELECT id, address, data, intention FROM tenancies WHERE start_date IS NOT NULL')).rows) {
      const d = t.data || {}; if (!d.start_date || d.start_date > today) continue;
      const end = nextTermEnd(d.start_date, 12, today); if (!end || end > soon) continue;
      const it = (t.intention || {})[end] || {};
      const bd = new Date(Date.UTC(+end.slice(0, 4), +end.slice(5, 7) - 3, +end.slice(8, 10)));
      if (bd.getUTCDate() !== +end.slice(8, 10)) bd.setUTCDate(0);   // 31 Dec − 2 months → 31 Oct; 30 Apr → 28/29 Feb
      const by = bd.toISOString().slice(0, 10);   // 2 months before
      const names = (d.tenants || []).map(function (x) { return x && x.name; }).filter(Boolean).join(' & ');
      // A second alert on the day it's 2 months to go (the last day to serve the
      // notice for the anniversary), unless the notice is served or no increase.
      if (by <= today && !it.alerted2_at && !it.notice_served && !it.no_increase && it.answer !== 'leaving') {
        const sent2 = await ntfy({ title: '2 months to tenancy anniversary: ' + shortAddrText(t.address), message: (names ? names + ' — ' : '') + t.address + '. Anniversary on ' + apptDay(end) + (by === today ? ' — 2 months to go today: serve the Form 4A notice today to raise the rent from the anniversary.' : ' — now under 2 months to go and no rent increase notice recorded.') + ' Open Tenancies in Fixflow.', tags: ['alarm_clock'] }).catch(function () { return false; });
        await p.query(`UPDATE tenancies SET intention = intention || jsonb_build_object($2::text, coalesce(intention->$2, '{}'::jsonb) || jsonb_build_object('alerted2_at', $3::text, 'alerted_at', coalesce(intention->$2->>'alerted_at', $3::text))) WHERE id = $1`, [t.id, end, new Date().toISOString()]);
        if (sent2) console.log('Tenancy 2-month alert: ' + t.address + ' (' + end + ')');
        continue;
      }
      if (it.alerted_at || it.asked_at || it.answer || it.new_rent || it.no_increase || it.ll_asked_at || it.notice_served) continue;
      const sent = await ntfy({ title: 'Tenancy anniversary: ' + shortAddrText(t.address), message: (names ? names + ' — ' : '') + t.address + '. Anniversary on ' + apptDay(end) + ' — for a rent increase, serve the Form 4A notice by ' + apptDay(by) + '. Open Tenancies in Fixflow.', tags: ['house'] }).catch(function () { return false; });
      await p.query(`UPDATE tenancies SET intention = intention || jsonb_build_object($2::text, coalesce(intention->$2, '{}'::jsonb) || jsonb_build_object('alerted_at', $3::text)) WHERE id = $1`, [t.id, end, new Date().toISOString()]);
      if (sent) console.log('Tenancy anniversary alert: ' + t.address + ' (' + end + ')');
    }
  }
  setTimeout(function () { tenancyEndAlerts().catch(function (err) { console.error('Tenancy alerts failed:', err.message); }); }, 90 * 1000);
  // A property licence expiring within 2 months (or expired): a phone alert, once per expiry date.
  async function licenceAlerts() {
    const p = await db(); if (!p) return;
    await applyLicencePool(p).catch(function (err) { console.error('Licence pool failed:', err.message); });
    const soon = new Date(Date.now() + 61 * 86400000).toISOString().slice(0, 10);
    for (const r of (await p.query("SELECT property_key, address, licence FROM property_info WHERE licence->>'status' = 'licensed' AND licence->>'expires' IS NOT NULL")).rows) {
      const l = r.licence || {}; if (!l.expires || l.expires > soon || l.alerted_for === l.expires) continue;
      const past = l.expires < new Date().toISOString().slice(0, 10);
      await ntfy({ title: 'Property licence ' + (past ? 'expired' : 'expiring') + ': ' + shortAddrText(r.address || r.property_key), message: (l.type ? l.type + ' licence' : 'Licence') + (l.number ? ' ' + l.number : '') + ' for ' + (r.address || r.property_key) + (past ? ' expired on ' : ' expires on ') + apptDay(l.expires) + '. Renew it on the council’s licensing site.', tags: ['page_facing_up'] }).catch(function () {});
      await p.query("UPDATE property_info SET licence = licence || jsonb_build_object('alerted_for', $2::text) WHERE property_key = $1", [r.property_key, l.expires]);
    }
  }
  setTimeout(function () { licenceAlerts().catch(function (err) { console.error('Licence alerts failed:', err.message); }); }, 120 * 1000);
  setInterval(function () { licenceAlerts().catch(function (err) { console.error('Licence alerts failed:', err.message); }); }, 6 * 3600 * 1000).unref();
  setInterval(function () { tenancyEndAlerts().catch(function (err) { console.error('Tenancy alerts failed:', err.message); }); }, 6 * 3600 * 1000).unref();
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
    const r = await p.query('SELECT id, name, trade, phone, email, escalation_email, notes, active, portal_on, portal_token, link_sent FROM contractors ORDER BY active DESC, lower(name)');
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
      await p.query(`UPDATE jobs SET assigned_to_2 = $1 WHERE assigned_to_2 = $2 AND status NOT IN ('Completed', 'Cancelled')`,
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
        tenant_name, tenant_phone, tenant_email, access_time, access_notes, key_permission, key_instructions, direct_contact, appointment_date, appointment_time, completion_notes,
        assigned_to, assigned_to_2, task_2, part_done_by, part_done_at, (pdf IS NOT NULL) AS has_report
      FROM jobs WHERE archived_at IS NULL AND (lower(trim(assigned_to)) = lower(trim($1)) OR lower(trim(assigned_to_2)) = lower(trim($1)))
        AND (status NOT IN ('Completed', 'Cancelled') OR (status = 'Completed' AND completed_at > now() - interval '30 days'))
      ORDER BY (status = 'Completed'), created_at DESC LIMIT 200`, [c.name]);
    const me = c.name.trim().toLowerCase();
    // The tenants living there (from our tenant records), to fill in what a job
    // is missing and to show anyone else at the property.
    const living = {};
    if (r.rows.length) (await p.query(`SELECT pt.property_key, t.name, t.phone, t.email FROM property_tenants pt JOIN tenants t ON t.id = pt.tenant_id
        WHERE pt.moved_out_at IS NULL AND t.deleted_at IS NULL ORDER BY t.updated_at DESC`)).rows
      .forEach(function (t) { (living[t.property_key] = living[t.property_key] || []).push({ name: t.name || '', phone: t.phone || '', email: t.email || '' }); });
    r.rows.forEach(function (j) {
      const here = living[propKey(j.property_address)] || [];
      const tail = function (v) { return String(v || '').replace(/[^0-9]/g, '').slice(-9); };
      const same = function (t) { return (j.tenant_phone && tail(t.phone) === tail(j.tenant_phone)) || (j.tenant_email && t.email && t.email.toLowerCase() === String(j.tenant_email).toLowerCase()) || (!j.tenant_phone && !j.tenant_email && j.tenant_name && t.name && t.name.toLowerCase() === j.tenant_name.toLowerCase()); };
      const me2 = here.filter(same)[0] || (!j.tenant_phone && !j.tenant_email ? here[0] : null);
      if (me2) { j.tenant_name = j.tenant_name || me2.name; j.tenant_phone = j.tenant_phone || me2.phone; j.tenant_email = j.tenant_email || me2.email; }
      j.other_tenants = here.filter(function (t) { return t !== me2 && !same(t) && (t.phone || t.email); }).slice(0, 4);
    });
    const mineNotes = {};
    if (r.rows.length) (await p.query(`SELECT job_id, created_at, body FROM job_updates WHERE kind = 'contractor_note' AND job_id = ANY($1::int[])
        AND lower(trim(author)) = lower(trim($2)) ORDER BY id`, [r.rows.map(function (j) { return j.id; }), c.name])).rows
      .forEach(function (n) { (mineNotes[n.job_id] = mineNotes[n.job_id] || []).push({ at: n.created_at, body: n.body.replace(/^[^:]*:\s*/, '') }); });
    res.json({ ok: true, name: c.name, jobs: r.rows.map(function (j) {
      // Their part is done while the other contractor's isn't: show it as done for them.
      if (j.status !== 'Completed' && j.part_done_by && j.part_done_by.trim().toLowerCase() === me) { j.status = 'Completed'; j.completed_at = j.part_done_at; }
      // Working alongside another contractor (their name only, never contact details).
      const other = [j.assigned_to, j.assigned_to_2].filter(function (n) { return n && n.trim() && n.trim().toLowerCase() !== me; })[0];
      const ct = certTypeOf(j.category, j.affected);
      const out = { ref: refFor(j.id), with: other ? other.trim() : '', notes: (mineNotes[j.id] || []).slice(-5), cert: ct ? CERT_TYPES[ct].long : '' };
      // The second contractor's own task: theirs to do, or what the other one is doing.
      const second = j.assigned_to_2 && j.assigned_to_2.trim().toLowerCase() === me;
      if (j.task_2) { if (second) out.my_task = j.task_2; else if (other) out.other_task = j.task_2; }
      Object.keys(j).forEach(function (k) { if (['assigned_to', 'assigned_to_2', 'task_2', 'part_done_by', 'part_done_at'].indexOf(k) === -1) out[k] = j[k]; });
      return out;
    }) });
  }));
  app.post('/api/c/:token/jobs/:id/complete', withDb(async function (p, req, res) {
    if (portalLimited(req)) return res.status(429).json({ ok: false, error: 'rate-limited' });
    const c = await portalContractor(p, req.params.token);
    if (!c) return res.status(404).json({ ok: false, error: 'not-found' });
    const b = req.body || {}, notes = str(b.notes, 3000), price = money(b.price), photos = decodePhotos(b.photos).slice(0, 5);
    if (price === undefined) return res.status(400).json({ ok: false, error: 'bad-price' });
    // Parts the contractor bought: added to the job's parts (cost, and charged on to the landlord at cost
    // unless the office changes it).
    const parts = (Array.isArray(b.parts) ? b.parts : []).slice(0, 5).map(function (x) { return { description: str(x && x.description, 300), cost: money(x && x.cost) }; });
    if (parts.some(function (x) { return !x.description || x.cost === undefined || x.cost === null; })) return res.status(400).json({ ok: false, error: 'bad-part' });
    const addParts = async function (id) {
      for (const x of parts) await p.query("INSERT INTO job_parts (job_id, description, supplier, cost, charge, status) VALUES ($1, $2, $3, $4, $4, 'Fitted')", [id, x.description, c.name, x.cost]);
    };
    const partsText = parts.length ? ' Parts: ' + parts.map(function (x) { return x.description + ' ' + gbp(x.cost); }).join(', ') + '.' : '';
    const mine = `archived_at IS NULL AND (lower(trim(assigned_to)) = lower(trim($2)) OR lower(trim(assigned_to_2)) = lower(trim($2))) AND status NOT IN ('Completed', 'Cancelled')`;
    const cur = (await p.query(`SELECT id, property_address, assigned_to, assigned_to_2, part_done_by FROM jobs WHERE id = $1 AND ` + mine, [jobId(req), c.name])).rows[0];
    if (!cur) return res.status(404).json({ ok: false, error: 'not-found' });
    const ref = refFor(cur.id), me = c.name.trim().toLowerCase();
    const note = notes ? c.name + ': ' + notes : null;
    // Two contractors and the other hasn't finished yet: their part is done, the job stays open.
    const others = [cur.assigned_to, cur.assigned_to_2].filter(function (n) { return n && n.trim() && n.trim().toLowerCase() !== me; });
    const otherDone = cur.part_done_by && cur.part_done_by.trim().toLowerCase() !== me;
    if (cur.part_done_by && !otherDone) return res.json({ ok: true, part: true });   // their part is already done
    if (others.length && !otherDone) {
      await p.query(`UPDATE jobs SET part_done_by = $2, part_done_at = now(), part_price = $3, updated_at = now(),
          completion_notes = CASE WHEN $4::text IS NULL THEN completion_notes ELSE concat_ws(E'\n', completion_notes, $4::text) END WHERE id = $1`,
        [cur.id, c.name, price, note]);
      if (photos.length) await insertPhotos(p, cur.id, photos, 'contractor');
      await addParts(cur.id);
      await p.query('INSERT INTO job_updates (job_id, kind, body) VALUES ($1, $2, $3)', [cur.id, 'change',
        c.name + ' finished their part (contractor job link) — waiting for ' + others[0].trim() + '.' + (notes ? ' Notes: ' + notes.replace(/[.\s]*$/, '') + '.' : '') + (price != null ? ' Their price: ' + gbp(price) + '.' : '') + partsText +
        (photos.length ? ' ' + photos.length + ' photo' + (photos.length === 1 ? '' : 's') + ' added.' : '')]);
      ntfy({ title: 'Part done: ' + ref, message: c.name + ' finished their part of ' + ref + ' — ' + (cur.property_address || '') + '. Waiting for ' + others[0].trim() + '.', tags: ['hammer'] }).catch(function () {});
      return res.json({ ok: true, part: true });
    }
    // The last (or only) contractor: the job is complete. With two, their prices add up.
    const r = await p.query(`UPDATE jobs SET status = 'Completed', completed_at = now(), updated_at = now(),
        completion_notes = CASE WHEN $3::text IS NULL THEN completion_notes ELSE concat_ws(E'\n', completion_notes, $3::text) END,
        actual_cost = coalesce(actual_cost, CASE WHEN $4::numeric IS NULL AND part_price IS NULL THEN NULL ELSE coalesce(part_price, 0) + coalesce($4::numeric, 0) END)
      WHERE id = $1 AND ` + mine + ` RETURNING id, property_address`, [cur.id, c.name, others.length ? note : notes, price]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'not-found' });
    if (photos.length) await insertPhotos(p, r.rows[0].id, photos, 'contractor');
    await addParts(r.rows[0].id);
    await p.query('INSERT INTO job_updates (job_id, kind, body) VALUES ($1, $2, $3)', [r.rows[0].id, 'completed',
      'Marked completed by ' + c.name + ' (contractor job link).' + (others.length ? ' Both contractors have now finished.' : '') + (notes ? ' Notes: ' + notes.replace(/[.\s]*$/, '') + '.' : '') + (price != null ? ' Their price: ' + gbp(price) + '.' : '') + partsText +
      (photos.length ? ' ' + photos.length + ' photo' + (photos.length === 1 ? '' : 's') + ' added.' : '')]);
    // A certificate job: the date the contractor gave (else today) renews the certificate.
    const cert = await recordCertFromJob(p, r.rows[0].id, isoDay(b.cert_date) || new Date().toISOString().slice(0, 10), c.name);
    await autoJobInvoice(p, r.rows[0].id);
    ntfy({ title: 'Job completed: ' + ref, message: c.name + ' marked ' + ref + ' completed — ' + (r.rows[0].property_address || '') + '.' + (cert ? ' ' + CERT_TYPES[cert.type].name + ' updated: expires ' + certDay(cert.expires) + '.' : '') + ' Open the job in Fixflow to tell the tenant and landlord.', tags: ['white_check_mark'] }).catch(function () {});
    res.json({ ok: true });
  }));
  // A note or question from the contractor for the office (with photos if they
  // like). Staff see it on the job and get a phone alert.
  app.post('/api/c/:token/jobs/:id/note', withDb(async function (p, req, res) {
    if (portalLimited(req)) return res.status(429).json({ ok: false, error: 'rate-limited' });
    const c = await portalContractor(p, req.params.token);
    if (!c) return res.status(404).json({ ok: false, error: 'not-found' });
    const b = req.body || {}, note = str(b.note, 3000), photos = decodePhotos(b.photos).slice(0, 10);
    if (!note && !photos.length) return res.status(400).json({ ok: false, error: 'empty' });
    const j = (await p.query(`SELECT id, property_address FROM jobs WHERE id = $1 AND archived_at IS NULL
        AND (lower(trim(assigned_to)) = lower(trim($2)) OR lower(trim(assigned_to_2)) = lower(trim($2)))
        AND (status <> 'Completed' OR completed_at > now() - interval '30 days')`, [jobId(req), c.name])).rows[0];
    if (!j) return res.status(404).json({ ok: false, error: 'not-found' });
    if (photos.length) await insertPhotos(p, j.id, photos, 'contractor');
    const body = c.name + ': ' + (note || '(photos)') + (photos.length ? ' [' + photos.length + ' photo' + (photos.length === 1 ? '' : 's') + ' added]' : '');
    await p.query("INSERT INTO job_updates (job_id, kind, body, author) VALUES ($1, 'contractor_note', $2, $3)", [j.id, body, c.name]);
    await p.query('UPDATE jobs SET updated_at = now() WHERE id = $1', [j.id]);
    const ref = refFor(j.id);
    ntfy({ title: 'Note from ' + c.name + ': ' + ref, message: (note || photos.length + ' photo(s) added').slice(0, 300) + ' — ' + (j.property_address || ''), tags: ['speech_balloon'] }).catch(function () {});
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
      WHERE id = $1 AND archived_at IS NULL AND (lower(trim(assigned_to)) = lower(trim($2)) OR lower(trim(assigned_to_2)) = lower(trim($2))) AND status NOT IN ('Completed', 'Cancelled')
      RETURNING id, property_address`, [jobId(req), c.name, date, time]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'not-found' });
    const ref = refFor(r.rows[0].id), when = apptDay(date) + (time ? ', ' + time : '');
    await p.query('INSERT INTO job_updates (job_id, kind, body) VALUES ($1, $2, $3)', [r.rows[0].id, 'change',
      'Booked by ' + c.name + ' for ' + when + ' (contractor job link).' + (note ? ' Note: ' + note : '')]);
    ntfy({ title: 'Job booked: ' + ref, message: c.name + ' booked ' + ref + ' for ' + when + ' — ' + (r.rows[0].property_address || ''), tags: ['date'] }).catch(function () {});
    res.json({ ok: true, when: when });
  }));
  // The contractor's bookings as a calendar: subscribe once (iPhone, Outlook,
  // Google) and every booked job appears and stays up to date; or add one.
  async function contractorEvents(p, c, req, onlyId) {
    const rows = (await p.query(`SELECT id, status, category, affected, symptom, summary, location, description, property_address, appointment_date, appointment_time,
        tenant_name, tenant_phone, direct_contact, key_permission, key_instructions, access_notes, assigned_to, assigned_to_2, task_2, updated_at
      FROM jobs WHERE archived_at IS NULL AND appointment_date IS NOT NULL AND (lower(trim(assigned_to)) = lower(trim($1)) OR lower(trim(assigned_to_2)) = lower(trim($1)))
        AND (status <> 'Completed' OR completed_at > now() - interval '60 days')` + (onlyId ? ' AND id = $2' : ''), onlyId ? [c.name, onlyId] : [c.name])).rows;
    const site = baseUrl(req), me = c.name.trim().toLowerCase();
    return rows.map(function (j) {
      const w = apptWindow(j.appointment_date, j.appointment_time); if (!w) return null;
      const mine = j.assigned_to_2 && j.assigned_to_2.trim().toLowerCase() === me && j.task_2 ? j.task_2 : '';
      const issue = mine || j.summary || [j.affected, j.symptom].filter(Boolean).join(' – ') || j.category || 'Repair';
      return {
        uid: 'fixflow-' + j.id + '-' + c.id + '@residentialrealtors', window: w, updated: j.updated_at, cancelled: j.status === 'Cancelled',
        summary: refFor(j.id) + ' · ' + issue + ' – ' + shortAddrText(j.property_address),
        location: j.property_address || '',
        description: [issue + (mine ? ' (part of: ' + (j.summary || j.category || 'the repair') + ')' : ''), j.location ? 'Where: ' + j.location : '', j.description ? 'Tenant says: ' + j.description : '',
          j.tenant_name || j.tenant_phone ? 'Tenant: ' + [j.tenant_name, j.tenant_phone].filter(Boolean).join(' – ') : '',
          j.direct_contact === 'No' ? 'Access: arranged by Residential Realtors' : 'Access: contact the tenant directly',
          j.key_permission ? 'Keys: ' + j.key_permission + (j.key_instructions ? ' – ' + j.key_instructions : '') : '', j.access_notes ? 'Access notes: ' + j.access_notes : '',
          j.appointment_time ? 'Booked: ' + j.appointment_time : '', j.status === 'Completed' ? 'Completed' : ''].filter(Boolean).join('\n') + '\n\nYour jobs: ' + site + '/c/' + req.params.token,
        url: site + '/c/' + req.params.token
      };
    }).filter(Boolean);
  }
  app.get('/c/:token/calendar.ics', withDb(async function (p, req, res) {
    const c = await portalContractor(p, req.params.token);
    if (!c) return res.status(404).send('Not found');
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="residential-realtors-jobs.ics"');
    res.setHeader('Cache-Control', 'no-cache'); res.setHeader('X-Robots-Tag', 'noindex');
    res.send(icsCalendar('Residential Realtors jobs', await contractorEvents(p, c, req)));
  }));
  // The tenant's original report (PDF), for a job assigned to this contractor.
  app.get('/c/:token/jobs/:id/report.pdf', withDb(async function (p, req, res) {
    res.setHeader('X-Robots-Tag', 'noindex'); res.setHeader('Referrer-Policy', 'no-referrer');
    const c = await portalContractor(p, req.params.token);
    if (!c) return res.status(404).send('Not found');
    const r = (await p.query(`SELECT id, pdf FROM jobs WHERE id = $1 AND archived_at IS NULL AND pdf IS NOT NULL
      AND (lower(trim(assigned_to)) = lower(trim($2)) OR lower(trim(assigned_to_2)) = lower(trim($2)))`, [jobId(req), c.name])).rows[0];
    if (!r) return res.status(404).send('No report for this job');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="Tenant-report-' + refFor(r.id) + '.pdf"');
    res.send(r.pdf);
  }));
  app.get('/c/:token/jobs/:id/booking.ics', withDb(async function (p, req, res) {
    const c = await portalContractor(p, req.params.token);
    if (!c) return res.status(404).send('Not found');
    const ev = await contractorEvents(p, c, req, jobId(req));
    if (!ev.length) return res.status(404).send('No booking for this job yet');
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="' + refFor(jobId(req)) + '-booking.ics"');
    res.setHeader('X-Robots-Tag', 'noindex');
    res.send(icsCalendar('Residential Realtors job', ev));
  }));
  app.get('/c/:token', withDb(async function (p, req, res) {
    res.setHeader('X-Robots-Tag', 'noindex'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const c = await portalContractor(p, req.params.token);
    if (!c) return res.status(404).send(trackShell('Link not available', '<h1>Link not available</h1><p class="sub">This job link is no longer active. Please contact Residential Realtors.</p>', true));
    res.send(trackShell('Your jobs', '<h1>Hi ' + htmlEsc(c.name) + '</h1><p class="sub">Jobs from Residential Realtors. Tap a job for the details, and mark it completed when it’s done.</p>' +
      '<style>' +
        '.phs{display:grid;grid-template-columns:repeat(5,1fr);gap:6px}.phs:empty{display:none}.ph{position:relative;aspect-ratio:1;border-radius:10px;overflow:hidden;background:#f1f2f4;display:flex;align-items:center;justify-content:center;font-size:.72rem;text-align:center;color:#666}.ph img{width:100%;height:100%;object-fit:cover}.ph button{position:absolute;top:3px;right:3px;width:24px;height:24px;padding:0;border-radius:50%;background:rgba(0,0,0,.6);color:#fff;font-size:15px;line-height:24px;border:0}' +
        '.prow{display:grid;grid-template-columns:1fr 110px;gap:6px;margin-bottom:6px}.linkbtn{background:none;border:0;color:#2563eb;font-weight:600;padding:2px 0;text-align:left;cursor:pointer;font:inherit;font-weight:600}' +
        '.phadd{display:block;text-align:center;padding:12px;border:1.5px dashed #c9ccd3;border-radius:12px;font-weight:600;cursor:pointer;color:#333}' +
        '.dt{margin-top:10px;border-top:1px solid #eee;padding-top:8px}.dt summary{cursor:pointer;font-weight:600;padding:6px 0;list-style:none}.dt summary::-webkit-details-marker{display:none}.dt summary:before{content:"▸ ";color:#888}.dt[open] summary:before{content:"▾ "}' +
        '.dbody{display:flex;flex-direction:column;gap:10px;margin-top:6px}.desc{white-space:pre-wrap;background:#f6f6f8;border-radius:12px;padding:10px 12px;font-size:.95rem}' +
        '.it{display:flex;gap:10px;align-items:flex-start}.it .ic{width:28px;text-align:center;font-size:1.1rem;flex:none}.lb{font-size:.78rem;color:#5b616e;text-transform:uppercase;letter-spacing:.03em}.vl{font-size:.98rem;word-break:break-word}' +
        '.tn{border:1px solid #e6e7eb;border-radius:14px;padding:12px}.acts{display:grid;grid-template-columns:1fr 1fr;gap:8px}.abtn{display:block;text-align:center;padding:12px;border-radius:12px;background:#0b0c0f;color:#fff;text-decoration:none;font-weight:600}.abtn.wa{background:#25D366;color:#fff}' +
        'details>summary{min-height:32px}' +
        '.cal-add{display:inline-block;margin-left:6px;font-size:.85rem;font-weight:600;color:#2F5BEA;text-decoration:none;white-space:nowrap}.calbar{background:#fff;border:1px solid #e6e7eb;border-radius:14px;padding:10px 14px;margin-top:10px}.calbar .acts{grid-template-columns:1fr 1fr}' +
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

  app.post('/api/admin/jobs/:id/notes-seen', withDb(async function (p, req, res) {
    const r = await p.query("UPDATE job_updates SET seen_at = now() WHERE job_id = $1 AND kind = 'contractor_note' AND seen_at IS NULL", [jobId(req)]);
    res.json({ ok: true, seen: r.rowCount });
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
    const cert = (req.body || {}).cert_date ? await recordCertFromJob(p, id, req.body.cert_date) : null;
    const auto = await autoJobInvoice(p, id);
    res.json({ ok: true, cert: cert, invoice: auto });
  }));

  app.post('/api/admin/jobs/:id/reopen', withDb(async function (p, req, res) {
    const id = jobId(req);
    const r = await p.query(
      `UPDATE jobs SET status = 'Assigned', completed_at = NULL, part_done_by = NULL, part_done_at = NULL, part_price = NULL, updated_at = now() WHERE id = $1 RETURNING id`, [id]);
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

  // ---------- Recover landlord charges from the rent ----------
  // On each tenancy's rent day, any unpaid invoices for that property are listed
  // (and a phone alert sent) so the money can be taken from the rent we pass on.
  // Only where we collect the rent (not Tenant Find). Shown for 7 days after the
  // rent day until marked recovered or skipped.
  const rentDateIn = function (day, y, m) { const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); return new Date(Date.UTC(y, m, Math.min(day, last))).toISOString().slice(0, 10); };
  async function rentRecoveries(p) {
    const today = londonDay(), y = +today.slice(0, 4), m = +today.slice(5, 7) - 1;
    const st = ((await p.query("SELECT value FROM app_settings WHERE key = 'rent_recover'")).rows[0] || {}).value || {};
    const tcys = (await p.query("SELECT id, property_key, address, start_date, data FROM tenancies WHERE start_date IS NOT NULL AND start_date <= $1 ORDER BY start_date DESC", [today])).rows;
    const seen = {}, out = [];
    const invs = (await p.query(`SELECT i.id, i.number, i.total, i.created_at, i.landlord_name, coalesce(j.property_address, i.address) AS property_address FROM invoices i LEFT JOIN jobs j ON j.id = i.job_id
      WHERE i.paid_at IS NULL AND (i.job_id IS NULL OR (j.id IS NOT NULL AND j.archived_at IS NULL)) ORDER BY i.id`)).rows;
    const lls = {};
    (await p.query('SELECT pl.property_key, l.name FROM property_landlords pl JOIN landlords l ON l.id = pl.landlord_id')).rows.forEach(function (r) { lls[r.property_key] = r.name; });
    for (const t of tcys) {
      if (!t.property_key || seen[t.property_key]) continue;
      seen[t.property_key] = 1;   // the latest tenancy at each property is the current one
      const d = t.data || {};
      if (/tenant find/i.test(String(d.service || ''))) continue;
      const base = /^\d{4}-\d{2}-\d{2}$/.test(d.so_start || '') ? d.so_start : String(t.start_date).slice(0, 10);
      const day = +base.slice(8, 10); if (!day) continue;
      let rd = rentDateIn(day, y, m);
      if (rd > today) rd = rentDateIn(day, m ? y : y - 1, m ? m - 1 : 11);
      if (rd < base || rd < addDaysIso(today, -7)) continue;
      const k = t.id + '|' + rd;
      if (st[k] === 'done' || st[k] === 'skip') continue;
      const list = invs.filter(function (i) { return propKey(i.property_address) === t.property_key && new Date(i.created_at).toISOString().slice(0, 10) <= rd; });
      if (!list.length) continue;
      out.push({ key: k, tenancy_id: t.id, property_key: t.property_key, address: d.address || t.address || list[0].property_address, landlord: lls[t.property_key] || list[0].landlord_name || '',
        rent_day: rd, today: rd === today, rent: Number(d.rent_pcm) || null, total: Math.round(list.reduce(function (a, i) { return a + Number(i.total || 0); }, 0) * 100) / 100,
        invoices: list.map(function (i) { return { id: i.id, number: i.number, total: Number(i.total) }; }), alerted: !!st[k + '|alerted'] });
    }
    return { today: today, items: out };
  }
  async function setRecoverState(p, patch) {
    await p.query(`INSERT INTO app_settings (key, value) VALUES ('rent_recover', $1::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = app_settings.value || excluded.value, updated_at = now()`, [JSON.stringify(patch)]);
  }
  app.get('/api/admin/rent-recoveries', withDb(async function (p, req, res) {
    res.json(Object.assign({ ok: true }, await rentRecoveries(p)));
  }));
  // Taken from the rent: the invoices are marked paid, noted on each job.
  app.post('/api/admin/rent-recoveries/:key', withDb(async function (p, req, res) {
    const key = str(req.params.key, 60), how = (req.body || {}).action === 'skip' ? 'skip' : 'done';
    const item = (await rentRecoveries(p)).items.filter(function (x) { return x.key === key; })[0];
    if (!item) return res.status(404).json({ ok: false, error: 'not-found' });
    // Only the invoices ticked (when charges are more than one month's rent); the rest come back next rent day.
    const pick = Array.isArray((req.body || {}).invoice_ids) ? req.body.invoice_ids.map(Number) : null;
    if (how === 'done') {
      for (const i of item.invoices.filter(function (x) { return !pick || pick.indexOf(x.id) !== -1; })) {
        const r = await p.query('UPDATE invoices SET paid_at = coalesce(paid_at, now()) WHERE id = $1 RETURNING job_id, tenancy_id', [i.id]);
        if (r.rows[0]) await invoiceNote(p, r.rows[0], 'Invoice ' + i.number + ' (' + gbp(i.total) + ') recovered from the rent due ' + item.rent_day + '.', 'change');
        await addMonthCost(p, item.tenancy_id, item.rent_day, { label: 'Invoice ' + i.number + ' (repairs, inc. VAT)', amount: i.total, novat: true, invoice_id: i.id });
      }
    }
    await setRecoverState(p, { [key]: how });
    res.json({ ok: true });
  }));
  // Phone alert on the rent day itself (from 8am), once per tenancy and rent day.
  async function alertRentRecoveries() {
    const p = await db(); if (!p) return;
    const hour = +new Date().toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hour12: false });
    if (hour < 8) return;
    const r = await rentRecoveries(p);
    for (const x of r.items.filter(function (i) { return i.today && !i.alerted; })) {
      await ntfy({ title: 'Rent day: recover ' + gbp(x.total) + ' from ' + (x.landlord || 'the landlord'), message: shortAddrText(x.address) + ' — rent due today. Unpaid invoice' + (x.invoices.length === 1 ? ' ' : 's ') + x.invoices.map(function (i) { return i.number; }).join(', ') + '. Take it from the rent, then mark it recovered in Fixflow.', tags: ['moneybag'] }).catch(function () {});
      await setRecoverState(p, { [x.key + '|alerted']: new Date().toISOString() });
    }
  }
  setTimeout(function () { alertRentRecoveries().catch(function (err) { console.error('Rent recovery alert failed:', err.message); }); }, 90 * 1000);
  setInterval(function () { alertRentRecoveries().catch(function (err) { console.error('Rent recovery alert failed:', err.message); }); }, 3600 * 1000).unref();

  // ---------- Renewal fee on tenancies that pay the fee up front ----------
  // From the start of month 12 (11 months after the start or the last
  // anniversary) to 30 days after the anniversary: prompt to charge the next
  // year's up-front fee on the rent for that year. Phone alert once.
  function renewalFeeFor(d, intention, anniv) {
    let rent = Number(d.rent_pcm) || 0;
    Object.keys(intention || {}).sort().forEach(function (k) { const it = intention[k] || {}; const nr = Number(it.new_rent); if (nr && !it.no_increase && (it.rent_from || k) <= anniv) rent = nr; });
    const monthly = function (v, unit) { const x = Number(v) || 0; return !x ? 0 : unit === 'gbp' ? x : rent * x / 100; };
    const lines = [];
    if (d.find_basis === 'upfront') { const fm = monthly(d.find_pct, d.find_unit); if (fm) lines.push({ label: 'Tenant Find renewal (' + (d.find_unit === 'gbp' ? gbp(d.find_pct) + ' pm × 12' : d.find_pct + '% of annual rent ' + gbp(rent * 12)) + ')', amount: Math.round(fm * 12 * 100) / 100 }); }
    if (d.manage_basis === 'upfront') { const mm = monthly(d.manage_pct, d.manage_unit); if (mm) lines.push({ label: 'Management fee renewal (' + (d.manage_unit === 'gbp' ? gbp(d.manage_pct) + ' pm × 12' : d.manage_pct + '% of annual rent ' + gbp(rent * 12)) + ', up front)', amount: Math.round(mm * 12 * 100) / 100 }); }
    const sub = Math.round(lines.reduce(function (a, l) { return a + l.amount; }, 0) * 100) / 100, vat = d.vat === false || /rent\s*4\s*rent/i.test(String(d.service || '')) ? 0 : Math.round(sub * 20) / 100;
    return { rent: rent, lines: lines, sub: sub, vat: vat, total: Math.round((sub + vat) * 100) / 100 };
  }
  async function renewalFees(p) {
    const today = londonDay();
    const tcys = (await p.query('SELECT id, property_key, address, start_date, data, intention FROM tenancies WHERE start_date IS NOT NULL ORDER BY start_date DESC')).rows;
    const lls = {};
    (await p.query('SELECT pl.property_key, l.name, l.email, l.phone FROM property_landlords pl JOIN landlords l ON l.id = pl.landlord_id')).rows.forEach(function (r) { lls[r.property_key] = r; });
    const seen = {}, out = [];
    for (const t of tcys) {
      if (!t.property_key || seen[t.property_key]) continue;
      seen[t.property_key] = 1;   // the latest tenancy at the property is the current one
      const d = t.data || {}, start = String(d.start_date || t.start_date).slice(0, 10);
      // Only fees taken up front renew yearly: not monthly Tenant Find, and never Rent4Rent.
      if (/rent\s*4\s*rent/i.test(String(d.service || ''))) continue;
      if (d.find_basis !== 'upfront' && d.manage_basis !== 'upfront') continue;
      for (let n = 1; n < 30; n++) {
        const anniv = addMonthsIso(start, 12 * n); if (!anniv) break;
        const from = addMonthsIso(start, 12 * n - 1);
        if (from > today) break;
        if (addDaysIso(anniv, 30) < today) continue;
        const it = (t.intention || {})[anniv] || {};
        if (it.renewal_fee || it.answer === 'leaving') continue;
        const fee = renewalFeeFor(d, t.intention, anniv); if (!fee.total) continue;
        const ll = lls[t.property_key] || {};
        out.push({ key: t.id + '|' + anniv, tenancy_id: t.id, address: d.address || t.address, anniv: anniv, year: n + 1, service: d.service || '', landlord: (d.landlord && d.landlord.name) || ll.name || '',
          landlord_email: (d.landlord && d.landlord.email) || ll.email || '', landlord_phone: (d.landlord && d.landlord.phone) || ll.phone || '', fee: fee, alerted: !!it.renewal_alerted });
      }
    }
    return { today: today, items: out };
  }
  async function setIntention(p, id, anniv, patch, logText) {
    await p.query(`UPDATE tenancies SET intention = jsonb_set(coalesce(intention, '{}'::jsonb), ARRAY[$2::text], coalesce(intention->$2, '{}'::jsonb) || $3::jsonb)` +
      (logText ? ', log = log || $4::jsonb' : '') + ', updated_at = now() WHERE id = $1',
      logText ? [id, anniv, JSON.stringify(patch), JSON.stringify([{ at: new Date().toISOString(), text: logText }])] : [id, anniv, JSON.stringify(patch)]);
  }
  app.get('/api/admin/renewal-fees', withDb(async function (p, req, res) { res.json(Object.assign({ ok: true }, await renewalFees(p))); }));
  app.post('/api/admin/renewal-fees', withDb(async function (p, req, res) {
    const b = req.body || {}, key = str(b.key, 60);
    const item = (await renewalFees(p)).items.filter(function (x) { return x.key === key; })[0];
    if (!item) return res.status(404).json({ ok: false, error: 'not-found' });
    const charged = b.action !== 'skip', amount = money(b.amount) || item.fee.total;
    let inv = null;
    if (charged) {
      // The invoice to the landlord: the fee lines (scaled if the amount was changed), VAT, total.
      const scale = item.fee.total ? amount / item.fee.total : 1, r2 = function (v) { return Math.round(v * 100) / 100; };
      const lines = item.fee.lines.map(function (l) { return { desc: l.label + ' — year from ' + certDay(item.anniv), amount: r2(l.amount * scale) }; });
      const sub = r2(lines.reduce(function (a, l) { return a + l.amount; }, 0)), vat = r2(amount - sub);
      const today = new Date().toISOString().slice(0, 10), due = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
      const number = 'INV-RF-' + String(item.tenancy_id).padStart(5, '0') + '-' + item.year;
      const data = { number: number, title: 'Tenancy renewal fee', date: today, due: due, ref: str(b.ref, 40) || number, landlord: item.landlord, landlordEmail: item.landlord_email, landlordPhone: item.landlord_phone,
        landlordAddress: str(b.landlord_address, 500) || '', lines: lines, sub: sub, vat: vat, total: amount };
      const k = propKey(item.address);
      inv = (await p.query('INSERT INTO invoices (job_id, tenancy_id, address, property_key, number, total, landlord_name, landlord_email, data) VALUES (NULL, $1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
        [item.tenancy_id, item.address, k, number, amount, item.landlord || null, item.landlord_email || null, JSON.stringify(data)])).rows[0];
      inv.number = number;
      // Already paid by the landlord: the invoice is recorded as paid straight away.
      if (b.paid === true) { await p.query('UPDATE invoices SET paid_at = now() WHERE id = $1', [inv.id]); inv.paid = true; }
      // A link the landlord can open (their page), for the email.
      const ll = (await p.query('SELECT l.id, l.portal_token FROM property_landlords pl JOIN landlords l ON l.id = pl.landlord_id WHERE pl.property_key = $1', [k])).rows[0];
      if (ll) {
        let token = ll.portal_token;
        if (!token) { token = crypto.randomBytes(18).toString('base64url'); await p.query('UPDATE landlords SET portal_token = $2, updated_at = now() WHERE id = $1', [ll.id, token]); }
        const siteUrl = process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : req.protocol + '://' + req.get('host'));
        inv.url = siteUrl + '/l/' + token + '/invoice/' + inv.id;
      }
    }
    await setIntention(p, item.tenancy_id, item.anniv, { renewal_fee: charged ? { amount: amount, at: new Date().toISOString(), invoice_id: inv.id, number: inv.number } : { skipped: true, at: new Date().toISOString() } },
      charged ? 'Renewal fee charged for the year from ' + item.anniv + ': ' + gbp(amount) + (item.fee.vat ? ' (inc. VAT)' : '') + ' — invoice ' + inv.number + (inv.paid ? ' (paid)' : '') : 'No renewal fee charged for the year from ' + item.anniv);
    res.json({ ok: true, invoice: inv });
  }));
  async function alertRenewalFees() {
    const p = await db(); if (!p) return;
    const hour = +new Date().toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hour12: false });
    if (hour < 8) return;
    for (const x of (await renewalFees(p)).items.filter(function (i) { return !i.alerted; })) {
      await ntfy({ title: 'Renewal fee due: ' + gbp(x.fee.total) + ' — ' + shortAddrText(x.address), message: (x.landlord || 'The landlord') + ' — the tenancy reaches ' + certDay(x.anniv) + ' (start of year ' + x.year + '). The fee is paid up front: charge the renewal fee. Open Fixflow.', tags: ['receipt'] }).catch(function () {});
      await setIntention(p, x.tenancy_id, x.anniv, { renewal_alerted: new Date().toISOString() });
    }
  }
  setTimeout(function () { alertRenewalFees().catch(function (err) { console.error('Renewal fee alert failed:', err.message); }); }, 100 * 1000);
  setInterval(function () { alertRenewalFees().catch(function (err) { console.error('Renewal fee alert failed:', err.message); }); }, 3600 * 1000).unref();

  // ---------- Offers (applicants' online offer / holding deposit form) ----------
  // The public form at /offer posts here: the offer, each tenant's details and
  // their ID (photo or PDF). Staff get a phone alert; the applicant is told how
  // to pay the holding deposit (one week's rent).
  const OFFER_DOC_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'];
  const offerHits = new Map();
  function offerLimited(req) {
    const now = Date.now(), e = offerHits.get(req.ip);
    if (!e || now - e.start > 60 * 60 * 1000) { offerHits.set(req.ip, { start: now, n: 1 }); return false; }
    if (offerHits.size > 5000) offerHits.clear();
    return ++e.n > 12;
  }
  function offerMoney(pw) {
    const r2 = function (v) { return Math.round(v * 100) / 100; };
    const pcm = r2(pw * 52 / 12), holding = r2(pw), deposit = r2(pw * 5);
    return { pw: r2(pw), pcm: pcm, holding: holding, deposit: deposit, rent: pcm, total: r2(pcm + deposit), balance: r2(pcm + deposit - holding) };
  }
  app.post('/api/offers', withDb(async function (p, req, res) {
    if (offerLimited(req)) return res.status(429).json({ ok: false, error: 'rate-limited' });
    const b = req.body || {};
    if (b.website) return res.json({ ok: true });   // a robot filled the hidden box
    const s = function (v, n) { return str(v, n || 200) || ''; };
    const address = s(b.property, 400), lead = s(b.lead_name), phone = s(b.lead_phone, 40), email = s(b.lead_email);
    const amt = money(b.offer), maxAmt = money(b.max_offer), per = b.per === 'pcm' ? 'pcm' : 'pw';
    if (!address || !lead || !(phone || email)) return res.status(400).json({ ok: false, error: 'details' });
    if (!amt) return res.status(400).json({ ok: false, error: 'offer' });
    if (!s(b.signature) || b.agree !== true) return res.status(400).json({ ok: false, error: 'sign' });
    // Each of the six non-refundable points ticked.
    if (!Array.isArray(b.terms) || b.terms.length !== 6 || b.terms.some(function (x) { return x !== true; })) return res.status(400).json({ ok: false, error: 'terms' });
    // The drawn signature (a small PNG), kept with the ID documents as "tenant 0".
    const sm = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(b.signature_png || ''));
    const sigBuf = sm ? Buffer.from(sm[1], 'base64') : null;
    if (!sigBuf || sigBuf.length < 200 || sigBuf.length > 600 * 1024) return res.status(400).json({ ok: false, error: 'sign' });
    const pw = per === 'pcm' ? Math.round(amt * 12 / 52 * 100) / 100 : amt, maxPw = maxAmt ? (per === 'pcm' ? Math.round(maxAmt * 12 / 52 * 100) / 100 : maxAmt) : null;
    const FIELDS = ['name', 'phone', 'email', 'dob', 'income_type', 'employment_type', 'company', 'position', 'salary', 'start_date', 'other_income',
      'university', 'course', 'academic_year', 'current_address', 'residency_status', 'current_rent', 'landlord_name', 'landlord_email', 'landlord_phone', 'tenancy_start', 'tenancy_end',
      'g_name', 'g_relation', 'g_email', 'g_phone', 'g_company', 'g_position', 'g_salary', 'g_homeowner', 'g_home_address', 'g_other', 'uk_passport', 'share_code'];
    const tenants = (Array.isArray(b.tenants) ? b.tenants : []).slice(0, 8).map(function (t) { const o = {}; FIELDS.forEach(function (f) { o[f] = s(t && t[f], f === 'current_address' || f === 'g_home_address' || f === 'other_income' || f === 'g_other' ? 500 : 200); }); o._ids = t && t.ids; return o; });
    if (!tenants.length || tenants.some(function (t) { return !t.name; })) return res.status(400).json({ ok: false, error: 'tenants' });
    // Company name: required for anyone employed or self-employed.
    if (tenants.some(function (t) { return (t.income_type === 'Employed' || t.income_type === 'Self-employed') && !t.company; })) return res.status(400).json({ ok: false, error: 'company' });
    // Gross annual salary: required (students who don't work have a guarantor instead).
    if (tenants.some(function (t) { return t.income_type !== 'Student' && !(parseFloat(String(t.salary || '').replace(/[£,\s]/g, '')) > 0); })) return res.status(400).json({ ok: false, error: 'salary' });
    // Guarantors: students always need one, and there must be as many complete
    // guarantors as the applicant said. A started guarantor section must be complete.
    const guaDone = function (t) { return !!(t.g_name && t.g_relation && t.g_email && t.g_phone && parseFloat(String(t.g_salary || '').replace(/[£,\s]/g, '')) > 0 && t.g_homeowner && (t.g_homeowner !== 'Yes' || t.g_home_address)); };
    const guaStarted = function (t) { return ['g_name', 'g_relation', 'g_email', 'g_phone', 'g_company', 'g_position', 'g_salary', 'g_homeowner', 'g_home_address', 'g_other'].some(function (k) { return t[k]; }); };
    const guaN = Math.max(0, Math.min(parseInt(b.guarantors_count, 10) || 0, tenants.length));
    if (tenants.some(function (t) { return (t.income_type === 'Student' || guaStarted(t)) && !guaDone(t); }) || tenants.filter(guaDone).length < guaN) return res.status(400).json({ ok: false, error: 'guarantor' });
    // No UK or Irish passport: a right to rent share code (9 letters/numbers) is needed.
    for (const t of tenants) { t.share_code = String(t.share_code || '').toUpperCase().replace(/\s+/g, ''); if (t.uk_passport === 'No' && !/^[A-Z0-9]{9}$/.test(t.share_code)) return res.status(400).json({ ok: false, error: 'share_code' }); if (t.uk_passport !== 'No') t.share_code = ''; }
    // Each tenant's ID: required, photos or PDFs, up to 4 files of 12 MB each.
    const docs = [];
    for (let i = 0; i < tenants.length; i++) {
      const files = (Array.isArray(tenants[i]._ids) ? tenants[i]._ids : []).slice(0, 4);
      let n = 0;
      for (const f of files) {
        const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(String((f && f.dataUrl) || ''));
        if (!m) continue;
        let mime = m[1].toLowerCase(); const buf = Buffer.from(m[2], 'base64');
        if (OFFER_DOC_TYPES.indexOf(mime) === -1 && /\.hei[cf]$/i.test(String(f.name || ''))) mime = 'image/heic';
        if (OFFER_DOC_TYPES.indexOf(mime) === -1 || !buf.length || buf.length > 12 * 1024 * 1024) continue;
        docs.push({ tenant_no: i + 1, name: s(f.name, 150) || 'ID', mime: mime, data: buf }); n++;
      }
      if (!n) return res.status(400).json({ ok: false, error: 'ids', tenant: i + 1 });
      delete tenants[i]._ids;
    }
    const data = {
      per: per, offer_entered: amt, max_entered: maxAmt || null, max_pw: maxPw, tenants_count: parseInt(b.tenants_count, 10) || tenants.length, guarantors_count: parseInt(b.guarantors_count, 10) || 0,
      move_in: isoDay(b.move_in) || null, stay: s(b.stay, 80), rent_frequency: 'Monthly', negotiate: s(b.negotiate, 2000), about: s(b.about, 3000),
      tenants: tenants, signature: s(b.signature), signed_at: new Date().toISOString(), terms_ticked: 6, money: offerMoney(pw), ip: String(req.ip || '').slice(0, 60)
    };
    const token = crypto.randomBytes(16).toString('base64url');
    const ins = await p.query('INSERT INTO offers (property_address, property_key, lead_name, lead_email, lead_phone, offer_pw, data, log, track_token) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id',
      [address, propKey(address), lead, email || null, phone || null, pw, JSON.stringify(data), JSON.stringify([{ at: new Date().toISOString(), text: 'Offer submitted online by ' + lead }]), token]);
    const id = ins.rows[0].id;
    for (const d of docs) await p.query('INSERT INTO offer_docs (offer_id, tenant_no, name, mime, data) VALUES ($1, $2, $3, $4, $5)', [id, d.tenant_no, d.name, d.mime, d.data]);
    await p.query("INSERT INTO offer_docs (offer_id, tenant_no, name, mime, data) VALUES ($1, 0, 'signature.png', 'image/png', $2)", [id, sigBuf]);
    const ref = 'OF' + String(id).padStart(4, '0');
    ntfy({ title: 'New offer: ' + gbp(pw) + ' pw — ' + shortAddrText(address), message: lead + ' · ' + tenants.length + ' tenant' + (tenants.length === 1 ? '' : 's') + (data.move_in ? ' · move in ' + certDay(data.move_in) : '') + (data.stay ? ' · stay ' + data.stay : '') + '. Open Offers in Fixflow.', tags: ['house'] }).catch(function () {});
    // How to pay the holding deposit (bank details from the settings, never in the code).
    const bank = INVOICE.payee && INVOICE.accountNumber ? { payee: INVOICE.payee, sort_code: INVOICE.sortCode, account: INVOICE.accountNumber, iban: INVOICE.iban, swift: INVOICE.swift } : null;
    res.json({ ok: true, ref: ref, money: data.money, bank: bank, reference: offerPayRef(address, ref), track: '/offer/track/' + token });
  }));
  function offerPayRef(address, ref) { return (addrPayRef(address) || ref).slice(0, 18); }
  // The applicant withdraws their offer (only once we've confirmed their holding
  // deposit arrived). As the terms say, the holding deposit isn't refunded.
  app.post('/api/offers/track/:token/withdraw', withDb(async function (p, req, res) {
    if (portalLimited(req)) return res.status(429).json({ ok: false, error: 'rate-limited' });
    const t = String(req.params.token || '');
    if (!/^[\w-]{16,40}$/.test(t) || (req.body || {}).confirm !== true) return res.status(400).json({ ok: false, error: 'confirm' });
    const reason = str((req.body || {}).reason, 100) || 'Not given', more = str((req.body || {}).more, 1000) || '';
    const r = await p.query(`UPDATE offers SET status = 'withdrawn', decided_at = now(), log = log || $2::jsonb,
        data = data || jsonb_build_object('withdraw_reason', $3::text, 'withdraw_more', $4::text)
      WHERE track_token = $1 AND paid_at IS NOT NULL AND status IN ('new', 'accepted') RETURNING id, property_address, lead_name, offer_pw`,
      [t, JSON.stringify([{ at: new Date().toISOString(), text: 'Offer withdrawn by the applicant online (reason: ' + reason + (more ? ' — ' + more : '') + ') — told the holding deposit is not refundable, as per the terms' }]), reason, more]);
    if (!r.rows.length) return res.status(409).json({ ok: false, error: 'not-allowed' });
    const o = r.rows[0];
    ntfy({ title: 'Offer withdrawn: ' + shortAddrText(o.property_address), message: (o.lead_name || 'The applicant') + ' withdrew their offer (OF' + String(o.id).padStart(4, '0') + ') — ' + reason + '. Holding deposit not refundable as per the terms.', tags: ['x'] }).catch(function () {});
    res.json({ ok: true });
  }));
  // The applicant says they've paid the holding deposit, so we can check the bank.
  app.post('/api/offers/track/:token/paid', withDb(async function (p, req, res) {
    if (portalLimited(req)) return res.status(429).json({ ok: false, error: 'rate-limited' });
    const t = String(req.params.token || ''), b = req.body || {}, when = isoDay(b.date) || londonDay(), from = str(b.from, 120) || '';
    const r = await p.query(`UPDATE offers SET data = data || jsonb_build_object('paid_claim', $2::jsonb), log = log || $3::jsonb
      WHERE track_token = $1 AND paid_at IS NULL AND status IN ('new', 'accepted') RETURNING id, property_address, lead_name, data`,
      [t, JSON.stringify({ at: new Date().toISOString(), date: when, from: from }), JSON.stringify([{ at: new Date().toISOString(), text: 'Applicant says they paid the holding deposit on ' + certDay(when) + (from ? ' from ' + from : '') }])]);
    if (!r.rows.length) return res.status(409).json({ ok: false, error: 'not-allowed' });
    const o = r.rows[0];
    ntfy({ title: 'Holding deposit paid? ' + shortAddrText(o.property_address), message: (o.lead_name || 'The applicant') + ' says they paid ' + gbp((o.data.money || {}).holding) + ' on ' + certDay(when) + (from ? ' from ' + from : '') + ' (ref ' + offerPayRef(o.property_address, 'OF' + String(o.id).padStart(4, '0')) + '). Check the bank, then mark it received in Fixflow.', tags: ['moneybag'] }).catch(function () {});
    res.json({ ok: true });
  }));
  // Rejected after paying: the applicant gives the account for their refund. It must
  // be in the name of the applicant who paid.
  app.post('/api/offers/track/:token/refund', withDb(async function (p, req, res) {
    if (portalLimited(req)) return res.status(429).json({ ok: false, error: 'rate-limited' });
    const t = String(req.params.token || ''), b = req.body || {};
    const name = str(b.name, 120), sort = String(b.sort_code || '').replace(/\D/g, ''), account = String(b.account || '').replace(/\D/g, ''), iban = String(b.iban || '').toUpperCase().replace(/\s+/g, '');
    if (!name || !((sort.length === 6 && account.length === 8) || /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban))) return res.status(400).json({ ok: false, error: 'details' });
    if (b.confirm !== true) return res.status(400).json({ ok: false, error: 'confirm' });
    const refund = { name: name, sort_code: sort ? sort.replace(/^(\d\d)(\d\d)(\d\d)$/, '$1-$2-$3') : '', account: account, iban: iban, at: new Date().toISOString() };
    const r = await p.query(`UPDATE offers SET data = data || jsonb_build_object('refund', $2::jsonb), log = log || $3::jsonb
      WHERE track_token = $1 AND status = 'rejected' AND paid_at IS NOT NULL RETURNING id, property_address, lead_name, data`,
      [t, JSON.stringify(refund), JSON.stringify([{ at: new Date().toISOString(), text: 'Refund account details given by the applicant (' + name + ')' }])]);
    if (!r.rows.length) return res.status(409).json({ ok: false, error: 'not-allowed' });
    const o = r.rows[0];
    ntfy({ title: 'Refund details in: ' + shortAddrText(o.property_address), message: (o.lead_name || 'The applicant') + ' gave their account for the holding deposit refund (' + gbp((o.data.money || {}).holding) + '). Open Offers in Fixflow.', tags: ['moneybag'] }).catch(function () {});
    res.json({ ok: true });
  }));
  // The applicant's own view of their offer (by its private link): where it's up to.
  app.get('/api/offers/track/:token', withDb(async function (p, req, res) {
    if (portalLimited(req)) return res.status(429).json({ ok: false, error: 'rate-limited' });
    const t = String(req.params.token || '');
    if (!/^[\w-]{16,40}$/.test(t)) return res.status(404).json({ ok: false, error: 'not-found' });
    const o = (await p.query('SELECT id, created_at, property_address, lead_name, offer_pw, data, status, decided_at, paid_at FROM offers WHERE track_token = $1', [t])).rows[0];
    if (!o) return res.status(404).json({ ok: false, error: 'not-found' });
    const d = o.data || {}, ref = 'OF' + String(o.id).padStart(4, '0');
    const bank = !o.paid_at && o.status !== 'rejected' && INVOICE.payee && INVOICE.accountNumber ? { payee: INVOICE.payee, sort_code: INVOICE.sortCode, account: INVOICE.accountNumber, iban: INVOICE.iban, swift: INVOICE.swift } : null;
    res.json({ ok: true, ref: ref, property: o.property_address, name: String(o.lead_name || '').split(/\s+/)[0], created_at: o.created_at, status: o.status, decided_at: o.decided_at, paid_at: o.paid_at,
      offer_pw: Number(o.offer_pw), money: d.money || {}, move_in: d.move_in || null, stay: d.stay || '', tenants: (d.tenants || []).length, bank: bank, reference: offerPayRef(o.property_address, ref),
      refund: d.refund ? { given_at: d.refund.at, name: d.refund.name } : null, refunded_at: d.refunded_at || null, paid_claim: d.paid_claim || null });
  }));
  app.get('/api/admin/offers', withDb(async function (p, req, res) {
    const r = await p.query(`SELECT o.id, o.created_at, o.property_address, o.property_key, o.lead_name, o.lead_email, o.lead_phone, o.offer_pw, o.data, o.status, o.decided_at, o.paid_at, o.seen_at, o.log, o.track_token,
        coalesce((SELECT json_agg(json_build_object('id', d.id, 'tenant_no', d.tenant_no, 'name', d.name, 'mime', d.mime, 'size', length(d.data)) ORDER BY d.id) FROM offer_docs d WHERE d.offer_id = o.id), '[]') AS docs
      FROM offers o ORDER BY o.id DESC LIMIT 500`);
    res.json({ ok: true, offers: r.rows.map(function (o) { o.ref = 'OF' + String(o.id).padStart(4, '0'); if (o.data) delete o.data.ip; return o; }) });
  }));
  // A tracking link for an offer made before links existed (made on first ask).
  app.post('/api/admin/offers/:id/track', withDb(async function (p, req, res) {
    const r = await p.query('UPDATE offers SET track_token = coalesce(track_token, $2) WHERE id = $1 RETURNING track_token', [jobId(req), crypto.randomBytes(16).toString('base64url')]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'not-found' });
    res.json({ ok: true, track: '/offer/track/' + r.rows[0].track_token });
  }));
  app.get('/api/admin/offers/:id/doc/:doc', withDb(async function (p, req, res) {
    const r = await p.query('SELECT name, mime, data FROM offer_docs WHERE id = $2 AND offer_id = $1', [jobId(req), parseInt(req.params.doc, 10) || 0]);
    if (!r.rows.length) return res.status(404).send('Not found');
    res.setHeader('Content-Type', r.rows[0].mime); res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', 'inline; filename="' + String(r.rows[0].name || 'id').replace(/[^\w.\- ]+/g, '_') + '"');
    res.end(r.rows[0].data);
  }));
  // Accept / reject (or back to new), payment received (or not), seen.
  app.post('/api/admin/offers/:id', withDb(async function (p, req, res) {
    const b = req.body || {}, id = jobId(req), sets = [], vals = [id], notes = [];
    if (['new', 'accepted', 'rejected', 'withdrawn'].indexOf(b.status) !== -1) { vals.push(b.status); sets.push('status = $' + vals.length, "decided_at = CASE WHEN $" + vals.length + " = 'new' THEN NULL ELSE now() END"); notes.push(b.status === 'accepted' ? 'Offer accepted' : b.status === 'rejected' ? 'Offer rejected' : b.status === 'withdrawn' ? 'Marked as withdrawn' : 'Decision undone'); }
    if (typeof b.paid === 'boolean') { sets.push('paid_at = ' + (b.paid ? 'coalesce(paid_at, now())' : 'NULL')); notes.push(b.paid ? 'Holding deposit received' : 'Holding deposit marked not received'); }
    if (b.seen === true) sets.push('seen_at = coalesce(seen_at, now())');
    if (str(b.note, 300)) notes.push(str(b.note, 300));
    if (typeof b.refunded === 'boolean') { sets.push("data = data || jsonb_build_object('refunded_at', " + (b.refunded ? 'to_jsonb(now())' : "'null'::jsonb") + ')'); notes.push(b.refunded ? 'Holding deposit refund sent' : 'Refund marked as not sent'); }
    if (!sets.length) return res.status(400).json({ ok: false, error: 'nothing' });
    if (notes.length) { vals.push(JSON.stringify(notes.map(function (t) { return { at: new Date().toISOString(), text: t + (req.role === 'offers' ? ' (offers staff)' : '') }; }))); sets.push('log = log || $' + vals.length + '::jsonb'); }
    const r = await p.query('UPDATE offers SET ' + sets.join(', ') + ' WHERE id = $1 RETURNING id', vals);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'not-found' });
    res.json({ ok: true });
  }));
  // Right to rent: the office runs the check on GOV.UK (it needs their sign-in and
  // a person to match the photo to the tenant), then records the outcome here,
  // optionally with the result saved from GOV.UK. Result files are kept with
  // tenant_no = -(tenant number) so they don't count as the applicant's IDs.
  app.post('/api/admin/offers/:id/rtr', withDb(async function (p, req, res) {
    const b = req.body || {}, id = jobId(req), n = parseInt(b.tenant, 10) || 0;
    const o = (await p.query('SELECT data FROM offers WHERE id = $1', [id])).rows[0];
    if (!o) return res.status(404).json({ ok: false, error: 'not-found' });
    const ts = (o.data || {}).tenants || [];
    if (n < 1 || n > ts.length) return res.status(400).json({ ok: false, error: 'tenant' });
    const day = function (v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : ''; };
    const rtr = Object.assign({}, (o.data || {}).rtr || {});
    let note;
    if (b.clear === true) { delete rtr[n]; note = 'Right to rent check removed for ' + ts[n - 1].name; }
    else {
      const RES = { passport: 'UK or Irish passport seen', unlimited: 'Unlimited right to rent', limited: 'Time-limited right to rent', none: 'No right to rent' };
      if (!RES[b.result]) return res.status(400).json({ ok: false, error: 'result' });
      const until = b.result === 'limited' ? day(b.until) : '';
      if (b.result === 'limited' && !until) return res.status(400).json({ ok: false, error: 'until' });
      const rec = { result: b.result, until: until, checked: day(b.checked) || new Date().toISOString().slice(0, 10), by: str(b.by, 80), note: str(b.note, 300), at: new Date().toISOString() };
      const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(String((b.file && b.file.dataUrl) || ''));
      if (m) {
        const mime = m[1].toLowerCase(), buf = Buffer.from(m[2], 'base64');
        if (['application/pdf', 'image/jpeg', 'image/png'].indexOf(mime) === -1 || !buf.length || buf.length > 12 * 1024 * 1024) return res.status(400).json({ ok: false, error: 'file' });
        await p.query('DELETE FROM offer_docs WHERE offer_id = $1 AND tenant_no = $2', [id, -n]);
        rec.doc = (await p.query('INSERT INTO offer_docs (offer_id, tenant_no, name, mime, data) VALUES ($1, $2, $3, $4, $5) RETURNING id', [id, -n, str(b.file.name, 150) || 'right-to-rent-check', mime, buf])).rows[0].id;
      } else if (rtr[n] && rtr[n].doc) rec.doc = rtr[n].doc;
      rtr[n] = rec;
      note = 'Right to rent checked for ' + ts[n - 1].name + ': ' + RES[b.result] + (until ? ' until ' + until.split('-').reverse().join('/') : '');
    }
    if (!rtr[n]) await p.query('DELETE FROM offer_docs WHERE offer_id = $1 AND tenant_no = $2', [id, -n]);
    await p.query("UPDATE offers SET data = data || jsonb_build_object('rtr', $2::jsonb), log = log || $3::jsonb WHERE id = $1",
      [id, JSON.stringify(rtr), JSON.stringify([{ at: new Date().toISOString(), text: note + (req.role === 'offers' ? ' (offers staff)' : '') }])]);
    res.json({ ok: true, rtr: rtr });
  }));
  app.delete('/api/admin/offers/:id', withDb(async function (p, req, res) {
    if ((req.body || {}).confirm !== true) return res.status(400).json({ ok: false, error: 'confirm' });
    const r = await p.query('DELETE FROM offers WHERE id = $1 RETURNING id', [jobId(req)]);
    res.json({ ok: !!r.rows.length });
  }));

  // ---------- The offer as a PDF, laid out like the office's holding deposit form ----------
  // Information sheet, offer receipt (money and bank details, declaration and
  // signature), a page per tenant, their ID copies, and a signing record.
  async function offerPdf(p, id) {
    const o = (await p.query('SELECT * FROM offers WHERE id = $1', [id])).rows[0]; if (!o) return null;
    const docs = (await p.query('SELECT id, tenant_no, name, mime, data FROM offer_docs WHERE offer_id = $1 ORDER BY tenant_no, id', [id])).rows;
    const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
    const pdf = await PDFDocument.create();
    const F = await pdf.embedFont(StandardFonts.Helvetica), B = await pdf.embedFont(StandardFonts.HelveticaBold);
    const W = 595.28, H = 841.89, M = 48, ink = rgb(0.06, 0.07, 0.09), soft = rgb(0.38, 0.4, 0.45), line = rgb(0.86, 0.87, 0.9), red = rgb(0.85, 0.15, 0.18), band = rgb(0.96, 0.96, 0.97);
    const d = o.data || {}, m = d.money || {}, ts = d.tenants || [], ref = 'OF' + String(o.id).padStart(4, '0');
    // Only characters the standard PDF font has.
    const safe = function (t) { return String(t == null ? '' : t).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...').replace(/[^\x20-\x7E\xA3\xA0-\xFF\n]/g, ''); };
    const money = function (v) { return '\xA3' + (Number(v) || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
    const dayOf = function (v) { return v ? new Date(String(v).length === 10 ? v + 'T12:00:00Z' : v).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/London' }) : ''; };
    const stamp = function (v) { return v ? new Date(v).toLocaleString('en-GB', { timeZone: 'Europe/London', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''; };
    const wrap = function (text, font, size, width) {
      const out = [];
      safe(text).split('\n').forEach(function (para) {
        let cur = '';
        para.split(/\s+/).forEach(function (w) { const t = cur ? cur + ' ' + w : w; if (font.widthOfTextAtSize(t, size) > width && cur) { out.push(cur); cur = w; } else cur = t; });
        out.push(cur);
      });
      return out;
    };
    let logo = null;
    try { logo = await pdf.embedPng(require('fs').readFileSync(require('path').join(__dirname, 'logo-ink.png'))); } catch (e) {}
    let page, y;
    const footer = function () {
      page.drawLine({ start: { x: M, y: 46 }, end: { x: W - M, y: 46 }, thickness: 0.6, color: line });
      page.drawText(safe('Residential Realtors - Trading name of Estallion Investments Limited - Registered in England No. ' + (INVOICE.companyNo || '08760284') + ' - ' + (INVOICE.address || '28-30 Harper Road, London, SE1 6AD')), { x: M, y: 32, size: 7, font: F, color: soft });
      page.drawText(safe(ref), { x: W - M - F.widthOfTextAtSize(ref, 7), y: 32, size: 7, font: B, color: soft });
    };
    const newPage = function (title) {
      page = pdf.addPage([W, H]); y = H - M;
      if (logo) { const h = 34, w = logo.width * h / logo.height; page.drawImage(logo, { x: M, y: y - h + 6, width: w, height: h }); }
      page.drawText(safe(title), { x: W - M - B.widthOfTextAtSize(safe(title), 15), y: y - 18, size: 15, font: B, color: ink });
      y -= 52; page.drawLine({ start: { x: M, y: y }, end: { x: W - M, y: y }, thickness: 1.2, color: red }); y -= 22;
      footer();
    };
    const ensure = function (need, title) { if (y - need < 70) newPage(title); };
    const para = function (text, opts) {
      opts = opts || {}; const size = opts.size || 9.5, font = opts.bold ? B : F, x = M + (opts.indent || 0), width = W - M * 2 - (opts.indent || 0);
      wrap(text, font, size, width).forEach(function (ln) { ensure(size + 6, opts.title || ''); page.drawText(ln, { x: x, y: y, size: size, font: font, color: opts.color || ink }); y -= size + 4; });
      y -= opts.after == null ? 6 : opts.after;
    };
    const heading = function (text, title) { ensure(40, title); y -= 4; page.drawRectangle({ x: M, y: y - 6, width: W - M * 2, height: 20, color: band }); page.drawText(safe(text), { x: M + 8, y: y, size: 10.5, font: B, color: ink }); y -= 26; };
    // A label / value row (value wraps), like the form's boxes.
    const row = function (label, value, title) {
      const lw = 190, vx = M + lw, vw = W - M - vx, vs = wrap(value || '', F, 9.5, vw - 6);
      const h = Math.max(1, vs.length) * 13.5 + 8; ensure(h + 2, title);
      page.drawText(safe(label), { x: M + 2, y: y - 2, size: 8.5, font: B, color: soft });
      vs.forEach(function (ln, i) { page.drawText(ln, { x: vx, y: y - 2 - i * 13.5, size: 9.5, font: F, color: ink }); });
      y -= h; page.drawLine({ start: { x: M, y: y + 4 }, end: { x: W - M, y: y + 4 }, thickness: 0.5, color: line });
    };

    // 1. Information sheet
    newPage('Offer Form: Information Sheet');
    para('Residential Realtors take a one week\'s rent holding deposit from the tenant(s) to reserve a property while reference checks and preparation for a tenancy agreement are carried out. Your holding deposit does not imply tenancy; this will only be created once all parties have signed the tenancy agreement.');
    para('If the landlord formally rejects your maximum offer or withdraws the property from the market for any reason other than the reasons mentioned below, your holding deposit will be returned to you within 24 hours. Your holding deposit confirms your commitment to rent the property. It is accepted that your holding deposit will be non-refundable should at least one of the following points occur:');
    ['Withdrawal of offer from the property (whether the offer has been made to the landlord or not).', 'Failure to submit completed referencing application forms by all tenants/guarantors within 24 hours of receiving the application form.', 'Failure to satisfy the right to rent check.', 'Providing false, inaccurate or misleading references.', 'Failure to submit signed tenancy agreements and pay the remaining balance within 48 hours of receiving the documents.', 'Failure to take all reasonable steps to enter into a tenancy agreement.']
      .forEach(function (t) { para('[x]  ' + t + (d.terms_ticked ? '   (ticked by the applicant)' : ''), { indent: 10, after: 2 }); });
    y -= 6; para('Once your offer is accepted, your holding deposit will be used as the initial payment of your first month\'s rent.');
    heading('References'); para('Prior to the tenancy being offered, you must satisfy our minimum creditworthiness requirements; to satisfy this we will verify credit, income, previous landlord and bank statements. Applicants\' and/or guarantors\' income must be at least three times the annual rent over the duration of the tenancy, with no county court judgements against their names. Any offer of a tenancy is subject to satisfactory references being passed. You must supply proof/visa confirming your right to rent in the UK.');
    heading('Deadline for Agreement'); para('Residential Realtors are committed to providing a fast and efficient service; in the majority of tenancies we conclude within 5-14 days from the date your holding deposit has been received. However, due to circumstances beyond our control (e.g. landlord/employer reference response times, international bank transfers), you agree the deadline for agreement can take up to 28 days.');

    // 2. Receipt
    const T2 = 'Offer Form: Receipt';
    newPage(T2);
    row('Full Name', o.lead_name, T2); row('Property Address', o.property_address, T2); row('Mobile', o.lead_phone || '', T2); row('E-mail', o.lead_email || '', T2);
    row('Number of Tenants', String(ts.length), T2); row('Number of Guarantors', String(d.guarantors_count || 0), T2);
    row('Offer rental price (PW)', money(o.offer_pw) + '   (' + money(m.pcm) + ' PCM)', T2); row('Maximum offer rental price (PW)', d.max_pw ? money(d.max_pw) : '-', T2);
    y -= 4; para('Your maximum offer is binding subject to contract, references and the terms stipulated in the Offer Form: Information Sheet above.', { size: 8.5, color: soft });
    row('Move In Date', dayOf(d.move_in), T2); row('How long they would like to stay', d.stay || '', T2); row('Rent Frequency', 'Monthly', T2);
    row('Conditions to be agreed with the landlord', d.negotiate || 'None given', T2); row('About the tenants', d.about || '-', T2);
    heading('Breakdown of total monies required before moving in', T2);
    row('One week\'s holding deposit', money(m.holding), T2); row('Rent in advance', money(m.rent || m.pcm), T2); row('Five weeks\' deposit', money(m.deposit), T2);
    row('Move-in balance', money(m.total), T2); row('Move-in balance minus holding deposit', money(m.balance), T2);
    heading('Bank Transfer Details', T2);
    row('Account Name', INVOICE.payee || '-', T2); row('Sort Code', INVOICE.sortCode || '-', T2); row('Account Number', INVOICE.accountNumber || '-', T2);
    if (INVOICE.iban) row('IBAN', INVOICE.iban, T2); if (INVOICE.swift) row('SWIFT / BIC', INVOICE.swift, T2);
    if (d.refund) { heading('Refund account (given by the applicant)', T2); row('Account name', d.refund.name, T2); row('Sort code', d.refund.sort_code || '-', T2); row('Account number', d.refund.account || '-', T2); if (d.refund.iban) row('IBAN', d.refund.iban, T2); row('Refund sent', d.refunded_at ? stamp(d.refunded_at) : 'Not yet', T2); }
    row('Payment reference', offerPayRef(o.property_address, ref), T2);
    y -= 4; para('Please note the move-in monies are a holding deposit and will only be considered as part of the deposit once the tenancy has commenced.', { size: 8.5, color: soft });
    para('I confirm that the information provided is fully accurate, that I have read and understood the Holding Deposit: Information Sheet, and I am authorised to make decisions and sign on behalf of all tenants.', { size: 9 });
    ensure(110, T2);
    page.drawText('Signed on behalf of the tenant:', { x: M, y: y, size: 9.5, font: B, color: ink }); y -= 10;
    const sig = docs.filter(function (x) { return x.tenant_no === 0; })[0];
    if (sig) { try { const im = await pdf.embedPng(sig.data); const h = 56, w = Math.min(230, im.width * h / im.height); page.drawImage(im, { x: M, y: y - h, width: w, height: h }); } catch (e) {} }
    y -= 62; page.drawLine({ start: { x: M, y: y }, end: { x: M + 250, y: y }, thickness: 0.7, color: ink }); y -= 12;
    page.drawText(safe((d.signature || o.lead_name || '') + '  (' + stamp(d.signed_at || o.created_at) + ' UK time)'), { x: M, y: y, size: 9, font: F, color: ink }); y -= 20;

    // 3. A page per tenant
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i], TT = 'Offer Form: Tenant Details'; newPage(TT);
      page.drawText(safe('Tenant ' + (i + 1) + (i === 0 ? ' (Lead Tenant)' : '')), { x: M, y: y, size: 12.5, font: B, color: ink }); y -= 22;
      heading('Tenant Details', TT); row('Full Name', t.name, TT); row('Contact Number', t.phone, TT); row('Email Address', t.email, TT); row('Date of Birth', dayOf(t.dob), TT);
      heading('Type of Employment / Income Source', TT); row('Income source', t.income_type, TT); row('Employment Type', t.employment_type, TT); row('Company Name', t.company, TT); row('Current Position', t.position, TT);
      row('Gross Annual Salary', t.salary ? '\xA3' + t.salary : '', TT); row('Start Date', dayOf(t.start_date), TT); row('Any Additional Income', t.other_income, TT);
      if (t.university || t.course || t.academic_year) { heading('Study Details', TT); row('University Name', t.university, TT); row('Full Course Name', t.course, TT); row('Academic Year', t.academic_year, TT); }
      heading('Residency Details', TT); row('Current Address', t.current_address, TT); row('Status', t.residency_status, TT); row('Rental Amount', t.current_rent ? '\xA3' + t.current_rent + ' a month' : '', TT);
      row('Landlord/Agent Name', t.landlord_name, TT); row('Landlord E-mail Address', t.landlord_email, TT); row('Landlord Contact Number', t.landlord_phone, TT); row('Tenancy Start Date', dayOf(t.tenancy_start), TT); row('Tenancy End Date', dayOf(t.tenancy_end), TT);
      heading('Right to Rent', TT); row('UK or Irish passport', t.uk_passport, TT); if (t.share_code) row('Right to rent share code', t.share_code.replace(/^(.{3})(.{3})(.{3})$/, '$1 $2 $3'), TT);
      row('Passport / visa / proof of residency', docs.filter(function (x) { return x.tenant_no === i + 1; }).length + ' file(s) attached at the end of this document', TT);
      const rc = (d.rtr || {})[i + 1];
      if (rc) { row('Right to rent check', { passport: 'UK or Irish passport seen', unlimited: 'Unlimited right to rent', limited: 'Time-limited right to rent until ' + dayOf(rc.until), none: 'No right to rent' }[rc.result] || rc.result, TT);
        row('Checked on', dayOf(rc.checked) + (rc.by ? ' by ' + rc.by : '') + (rc.doc ? ' - GOV.UK result attached' : ''), TT); if (rc.note) row('Check notes', rc.note, TT); }
      else row('Right to rent check', 'Not recorded yet', TT);
      if (t.g_name) { heading('Guarantor Details', TT); row('Full Name', t.g_name, TT); row('Relation', t.g_relation, TT); row('Email Address', t.g_email, TT); row('Contact Number', t.g_phone, TT); row('Company', t.g_company, TT);
        row('Current Position', t.g_position, TT); row('Gross Annual Salary', t.g_salary ? '\xA3' + t.g_salary : '', TT); row('UK home owner', t.g_homeowner + (t.g_home_address ? ' - ' + t.g_home_address : ''), TT); row('Additional Income / Savings', t.g_other, TT); }
    }

    // 4. ID documents (photos on a page each; PDFs added as they are)
    for (const x of docs.filter(function (q) { return q.tenant_no !== 0; }).sort(function (a, b) { return Math.abs(a.tenant_no) - Math.abs(b.tenant_no) || b.tenant_no - a.tenant_no; })) {
      const tn = Math.abs(x.tenant_no), label = 'Tenant ' + tn + ' (' + (ts[tn - 1] || {}).name + ') - ' + (x.tenant_no < 0 ? 'Right to rent check result: ' : '') + (x.name || 'ID');
      try {
        if (x.mime === 'application/pdf') {
          const src = await PDFDocument.load(x.data, { ignoreEncryption: true });
          (await pdf.copyPages(src, src.getPageIndices())).forEach(function (pg) { pdf.addPage(pg); });
          continue;
        }
        if (!/jpe?g|png/.test(x.mime)) continue;
        const im = /png/.test(x.mime) ? await pdf.embedPng(x.data) : await pdf.embedJpg(x.data);
        newPage('Supporting document'); page.drawText(safe(label), { x: M, y: y, size: 10, font: B, color: ink }); y -= 16;
        const maxW = W - M * 2, maxH = y - 70, k = Math.min(maxW / im.width, maxH / im.height, 1);
        page.drawImage(im, { x: M + (maxW - im.width * k) / 2, y: y - im.height * k, width: im.width * k, height: im.height * k });
      } catch (e) { console.error('Offer PDF: could not add', x.name, e.message); }
    }

    // 5. Signing record
    const TA = 'Signing Record'; newPage(TA);
    row('Document', 'Holding Deposit / Offer Form - ' + ref, TA); row('Property', o.property_address, TA);
    row('Submitted online', stamp(o.created_at) + ' UK time', TA); row('Signed by', (d.signature || '') + ' (' + (o.lead_email || o.lead_phone || '') + ')', TA);
    row('Signature', sig ? 'Drawn by the applicant on screen' : 'Typed name', TA); row('Holding deposit terms', d.terms_ticked ? 'All 6 non-refundable points ticked individually' : '-', TA);
    row('Declaration', 'Ticked: information accurate, information sheet read, authorised to sign for all tenants', TA);
    row('IDs uploaded', String(docs.filter(function (q) { return q.tenant_no > 0; }).length) + ' file(s)', TA);
    row('Holding deposit', o.paid_at ? 'Received ' + stamp(o.paid_at) : 'Not received yet', TA);
    row('Status', { new: 'Awaiting decision', accepted: 'Accepted', rejected: 'Not accepted', withdrawn: 'Withdrawn by the applicant' }[o.status] + (o.decided_at ? ' (' + stamp(o.decided_at) + ')' : ''), TA);
    (o.log || []).forEach(function (l) { row(stamp(l.at), l.text, TA); });
    return { bytes: await pdf.save(), name: 'Holding Deposit Form - ' + ref + ' - ' + String(o.property_address || '').replace(/[^\w ,.-]+/g, ' ').slice(0, 60) + '.pdf' };
  }
  // Accepted offer: every applicant saved as a tenant at the property.
  app.post('/api/admin/offers/:id/tenants', withDb(async function (p, req, res) {
    const o = (await p.query('SELECT id, property_address, data FROM offers WHERE id = $1', [jobId(req)])).rows[0];
    if (!o) return res.status(404).json({ ok: false, error: 'not-found' });
    let n = 0;
    for (const t of ((o.data || {}).tenants || [])) { if (await ensureTenant(p, { name: t.name, phone: t.phone, email: t.email }, o.property_address)) n++; }
    await p.query('UPDATE offers SET data = data || jsonb_build_object(\'tenants_added_at\', $2::text), log = log || $3::jsonb WHERE id = $1',
      [o.id, new Date().toISOString(), JSON.stringify([{ at: new Date().toISOString(), text: n + ' applicant' + (n === 1 ? '' : 's') + ' added as tenants at the property' }])]);
    res.json({ ok: true, added: n });
  }));
  // The applicant's receipt for their holding deposit (once we've marked it received).
  app.get('/api/offers/track/:token/receipt.pdf', withDb(async function (p, req, res) {
    if (portalLimited(req)) return res.status(429).send('Too many requests');
    const t = String(req.params.token || '');
    const o = /^[\w-]{16,40}$/.test(t) ? (await p.query('SELECT * FROM offers WHERE track_token = $1 AND paid_at IS NOT NULL', [t])).rows[0] : null;
    if (!o) return res.status(404).send('No receipt yet');
    const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
    const pdf = await PDFDocument.create(), page = pdf.addPage([595.28, 841.89]);
    const F = await pdf.embedFont(StandardFonts.Helvetica), B = await pdf.embedFont(StandardFonts.HelveticaBold);
    const ink = rgb(0.06, 0.07, 0.09), soft = rgb(0.38, 0.4, 0.45), line = rgb(0.86, 0.87, 0.9), red = rgb(0.85, 0.15, 0.18), okc = rgb(0.07, 0.57, 0.29);
    const safe = function (x) { return String(x == null ? '' : x).replace(/[\u2018\u2019]/g, "'").replace(/[\u2013\u2014]/g, '-').replace(/[^\x20-\x7E\xA3\xA0-\xFF]/g, ''); };
    const d = o.data || {}, m = d.money || {}, ref = 'OF' + String(o.id).padStart(4, '0'), M = 56;
    const amount = '\xA3' + (Number(m.holding) || Number(o.offer_pw) || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const when = function (v) { return new Date(v).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' }); };
    try { const logo = await pdf.embedPng(require('fs').readFileSync(require('path').join(__dirname, 'logo-ink.png'))); page.drawImage(logo, { x: M, y: 760, width: logo.width * 40 / logo.height, height: 40 }); } catch (e) {}
    page.drawText('RECEIPT', { x: 595.28 - M - B.widthOfTextAtSize('RECEIPT', 22), y: 772, size: 22, font: B, color: ink });
    page.drawLine({ start: { x: M, y: 742 }, end: { x: 595.28 - M, y: 742 }, thickness: 1.2, color: red });
    let y = 708;
    page.drawText('Holding deposit received', { x: M, y: y, size: 16, font: B, color: ink }); y -= 22;
    page.drawText(safe('Thank you - we have received your holding deposit for the property below.'), { x: M, y: y, size: 10.5, font: F, color: soft }); y -= 40;
    page.drawText(amount, { x: M, y: y, size: 30, font: B, color: okc }); y -= 34;
    const rows = [['Receipt for', 'Holding deposit (one week\'s rent)'], ['Offer reference', ref], ['Property', o.property_address], ['Received from', o.lead_name + (d.tenants && d.tenants.length > 1 ? ' (on behalf of ' + d.tenants.length + ' tenants)' : '')],
      ['Date received', when(o.paid_at)], ['Payment reference', (addrPayRef(o.property_address) || ref)], ['Offer', '\xA3' + Number(o.offer_pw).toFixed(2) + ' a week (\xA3' + Number(m.pcm || 0).toFixed(2) + ' a month)'], ['Move-in date', d.move_in ? when(d.move_in + 'T12:00:00Z') : '-']];
    rows.forEach(function (r) { page.drawText(safe(r[0]), { x: M, y: y, size: 9.5, font: B, color: soft }); page.drawText(safe(r[1]).slice(0, 80), { x: M + 150, y: y, size: 10.5, font: F, color: ink }); y -= 10; page.drawLine({ start: { x: M, y: y }, end: { x: 595.28 - M, y: y }, thickness: 0.5, color: line }); y -= 16; });
    y -= 10;
    ['This holding deposit reserves the property while references and the tenancy agreement are prepared. It does not create a tenancy.', 'Once your offer is accepted it goes towards your first month\'s rent. The rest of the move-in money is due when you sign the tenancy agreement.',
      'It is returned within 24 hours if the landlord rejects your maximum offer or withdraws the property, and is not refundable in the cases set out in the information sheet you agreed to.']
      .forEach(function (tx) { const words = tx.split(' '); let cur = ''; words.forEach(function (w) { const tt = cur ? cur + ' ' + w : w; if (F.widthOfTextAtSize(tt, 9.5) > 595.28 - M * 2) { page.drawText(safe(cur), { x: M, y: y, size: 9.5, font: F, color: soft }); y -= 14; cur = w; } else cur = tt; }); page.drawText(safe(cur), { x: M, y: y, size: 9.5, font: F, color: soft }); y -= 20; });
    page.drawText(safe('Residential Realtors - Trading name of Estallion Investments Limited - Registered in England No. ' + (INVOICE.companyNo || '') + ' - ' + (INVOICE.address || '')), { x: M, y: 40, size: 7.5, font: F, color: soft });
    const bytes = await pdf.save();
    res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', 'inline; filename="Holding deposit receipt - ' + ref + '.pdf"');
    res.end(Buffer.from(bytes));
  }));
  app.get('/api/admin/offers/:id/pdf', withDb(async function (p, req, res) {
    const out = await offerPdf(p, jobId(req));
    if (!out) return res.status(404).send('Not found');
    res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', (req.query.dl ? 'attachment' : 'inline') + '; filename="' + out.name.replace(/"/g, '') + '"');
    res.end(Buffer.from(out.bytes));
  }));

  // ---------- Costs added to one month's statement ----------
  // data.month_costs: [{id, from (that statement's first day), label, amount, novat, money_in, invoice_id}].
  // A cost on a day goes on the statement whose period holds that day.
  function stmtMonthFor(start, day) {
    let from = start;
    for (let i = 0; i < 240; i++) { const nx = addMonthsIso(start, i + 1); if (nx > day) return from; from = nx; }
    return from;
  }
  async function addMonthCost(p, tid, day, c) {
    const t = (await p.query('SELECT start_date, data FROM tenancies WHERE id = $1', [tid])).rows[0]; if (!t) return null;
    const start = String((t.data || {}).start_date || t.start_date || '').slice(0, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return null;
    const list = Array.isArray((t.data || {}).month_costs) ? t.data.month_costs : [];
    if (c.invoice_id && list.some(function (x) { return x.invoice_id === c.invoice_id; })) return null;
    const row = Object.assign({ id: crypto.randomBytes(5).toString('hex'), from: stmtMonthFor(start, day < start ? start : day), at: new Date().toISOString() }, c);
    await p.query(`UPDATE tenancies SET data = jsonb_set(data, '{month_costs}', coalesce(data->'month_costs', '[]'::jsonb) || $2::jsonb), log = log || $3::jsonb, updated_at = now() WHERE id = $1`,
      [tid, JSON.stringify([row]), JSON.stringify([{ at: new Date().toISOString(), text: (c.money_in ? 'Credit to the landlord added to the ' : 'Cost added to the ') + certDay(row.from) + ' statement: ' + c.label + ' ' + gbp(c.amount) + (c.novat && !c.money_in && !c.invoice_id ? ' (no VAT)' : '') }])]);
    return row;
  }
  app.post('/api/admin/tenancies/:id/month-cost', withDb(async function (p, req, res) {
    const b = req.body || {}, amount = money(b.amount), label = str(b.label, 200), day = isoDay(b.from);
    if (!label || !amount || !day) return res.status(400).json({ ok: false, error: 'details' });
    const row = await addMonthCost(p, jobId(req), day, { label: label, amount: amount, novat: b.novat === true, money_in: b.money_in === true });
    if (!row) return res.status(404).json({ ok: false, error: 'not-found' });
    res.json({ ok: true, cost: row });
  }));
  app.delete('/api/admin/tenancies/:id/month-cost/:cid', withDb(async function (p, req, res) {
    const t = (await p.query('SELECT data FROM tenancies WHERE id = $1', [jobId(req)])).rows[0]; if (!t) return res.status(404).json({ ok: false, error: 'not-found' });
    const list = Array.isArray((t.data || {}).month_costs) ? t.data.month_costs : [], gone = list.filter(function (x) { return x.id === req.params.cid; })[0];
    if (!gone) return res.status(404).json({ ok: false, error: 'not-found' });
    await p.query(`UPDATE tenancies SET data = jsonb_set(data, '{month_costs}', $2::jsonb), log = log || $3::jsonb, updated_at = now() WHERE id = $1`,
      [jobId(req), JSON.stringify(list.filter(function (x) { return x !== gone; })), JSON.stringify([{ at: new Date().toISOString(), text: 'Removed from the ' + certDay(gone.from) + ' statement: ' + gone.label + ' ' + gbp(gone.amount) }])]);
    res.json({ ok: true });
  }));

  // ---------- Monthly landlord statements ----------
  // A statement for every rent date: the move-in statement first (rent, less
  // every fee), then each month's rent less the monthly fees. When the fees
  // were more than the rent (the landlord owes us), the shortfall is brought
  // forward and taken from the next rent, month by month until it is cleared.
  // Rent Collection / Fully Managed: every month. Tenant Find: only while the
  // landlord still owes us. Rent4Rent: move-in only. Same figures as tcyCalc in admin.html.
  function stmtFees(d, rent, first, from) {
    const r2 = function (v) { return Math.round(v * 100) / 100; };
    const num = function (v) { const x = parseFloat(String(v == null ? '' : v).replace(/[£,\s]/g, '')); return isNaN(x) ? null : x; };
    const monthly = function (v, unit) { const x = num(v); return !x ? 0 : unit === 'gbp' ? r2(x) : r2(rent * x / 100); };
    const ft = function (v, unit) { const x = num(v) || 0; return unit === 'gbp' ? gbp(x) + ' pm' : x + '%'; };
    const fees = [], fp = num(d.find_pct), fm = monthly(fp, d.find_unit), cm = monthly(d.collect_pct, d.collect_unit), mm = monthly(d.manage_pct, d.manage_unit), mUp = d.manage_basis === 'upfront';
    if (fm && d.find_basis === 'upfront') { if (first) fees.push({ label: 'Tenant Find (' + (d.find_unit === 'gbp' ? gbp(fp) + ' pm × 12' : fp + '% of annual rent ' + gbp(rent * 12)) + ')', amount: r2(fm * 12) }); }
    else if (fm) fees.push({ label: 'Tenant Find' + (d.find_unit === 'gbp' ? ' (' + gbp(fp) + ' pm)' : ''), amount: fm });
    if (cm) fees.push({ label: 'Rent Collection (' + ft(d.collect_pct, d.collect_unit) + ')', amount: cm });
    if (mm && mUp) { if (first) fees.push({ label: 'Management Fee (' + (d.manage_unit === 'gbp' ? gbp(num(d.manage_pct)) + ' pm × 12' : num(d.manage_pct) + '% of annual rent ' + gbp(rent * 12)) + ', up front)', amount: r2(mm * 12) }); }
    else if (mm) fees.push({ label: 'Management Fee (' + ft(d.manage_pct, d.manage_unit) + ')', amount: mm });
    if (first) (d.fees || []).forEach(function (f) { if (f && f.label && num(f.amount) !== null) fees.push({ label: f.label, amount: r2(num(f.amount)), novat: !!f.novat }); });
    // Costs added to this month's statement (and invoices recovered from this rent).
    (d.month_costs || []).forEach(function (c) { if (c && c.from === from && !c.money_in && num(c.amount)) fees.push({ label: c.label, amount: r2(num(c.amount)), novat: !!c.novat, cost_id: c.id, invoice_id: c.invoice_id || null }); });
    const vatOn = !(d.vat === false || /rent\s*4\s*rent/i.test(String(d.service || '')));
    fees.forEach(function (f) { f.vat = vatOn && !f.novat ? r2(f.amount * 0.2) : 0; });
    const sub = r2(fees.reduce(function (a, f) { return a + f.amount; }, 0)), vat = r2(fees.reduce(function (a, f) { return a + f.vat; }, 0));
    return { fees: fees, sub: sub, vat: vat, vatOn: vatOn };
  }
  function statementChain(t, nextStart, settled, today) {
    const d = t.data || {}, start = String(d.start_date || t.start_date || '').slice(0, 10), sent = d.stmt_sent || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || start > today) return [];
    const r2 = function (v) { return Math.round(v * 100) / 100; };
    const sv = String(d.service || ''), r4r = /rent\s*4\s*rent/i.test(sv), tf = /tenant find/i.test(sv);
    const rentAt = function (day) {
      let rent = Number(d.rent_pcm) || 0;
      Object.keys(t.intention || {}).sort().forEach(function (k) { const it = t.intention[k] || {}; const nr = Number(it.new_rent); if (nr && !it.no_increase && (it.rent_from || k) <= day) rent = nr; });
      return rent;
    };
    const out = [];
    let carry = 0;
    for (let i = 0; i < 60; i++) {
      const from = addMonthsIso(start, i);
      if (from > today || (nextStart && from >= nextStart)) break;
      // Paid off by the landlord (marked paid, or the move-in invoice paid) before this rent: nothing brought forward.
      if (i > 0 && settled && settled < from) carry = 0;
      const ownCosts = (d.month_costs || []).some(function (c) { return c && c.from === from; });
      if (i > 0 && (r4r || (tf && carry <= 0.004)) && !ownCosts) break;
      const rent = i === 0 ? Number(d.rent_pcm) || 0 : rentAt(from);
      let deposit = 0;
      if (i === 0 && d.deposit_by === 'landlord') deposit = d.deposit != null && d.deposit !== '' ? Number(d.deposit) || 0 : Math.floor(rent * 12 / 52 * 5 + 1e-9);
      const credits = (i === 0 ? (d.credits || []).filter(function (c) { return c && c.label && Number(c.amount); }).map(function (c) { return { label: c.label, amount: r2(Number(c.amount)) }; }) : [])
        .concat((d.month_costs || []).filter(function (c) { return c && c.from === from && c.money_in && Number(c.amount); }).map(function (c) { return { label: c.label, amount: r2(Number(c.amount)), cost_id: c.id }; }));
      const f = stmtFees(d, rent, i === 0, from), income = r2(rent + deposit + credits.reduce(function (a, c) { return a + c.amount; }, 0)), bf = r2(carry), total = r2(f.sub + f.vat + bf), balance = r2(income - total);
      out.push({ n: i, from: from, to: addDaysIso(addMonthsIso(start, i + 1), -1), rent: rent, deposit: deposit, credits: credits, income: income, fees: f.fees, sub: f.sub, vat: f.vat, vatOn: f.vatOn,
        bf: bf, bf_from: i > 0 && bf ? addMonthsIso(start, i - 1) : null, total: total, balance: balance, sent: sent[from] || null,
        // Changed since it was sent (a cost added, a fee edited, an earlier month amended): send it again.
        // (A record with no figures — marked from a page open before this was added — can't be compared.)
        changed: sent[from] && typeof sent[from] === 'object' && (Number(sent[from].total) || Number(sent[from].balance)) && Math.abs((Number(sent[from].balance) || 0) - balance) > 0.004 ? { was: Number(sent[from].balance) || 0 } : null });
      carry = balance < -0.004 ? -balance : 0;
    }
    return out;
  }
  async function statementsAll(p) {
    const today = londonDay();
    const tcys = (await p.query('SELECT id, property_key, address, start_date, data, intention FROM tenancies WHERE start_date IS NOT NULL ORDER BY start_date, id')).rows;
    const paidInv = {};
    (await p.query('SELECT id, paid_at FROM invoices WHERE paid_at IS NOT NULL AND tenancy_id IS NOT NULL')).rows.forEach(function (r) { paidInv[r.id] = new Date(r.paid_at).toISOString().slice(0, 10); });
    const lls = {};
    (await p.query('SELECT pl.property_key, l.name, l.email FROM property_landlords pl JOIN landlords l ON l.id = pl.landlord_id')).rows.forEach(function (r) { lls[r.property_key] = r; });
    const out = [];
    tcys.forEach(function (t, i) {
      const d = t.data || {}, next = tcys.slice(i + 1).filter(function (x) { return x.property_key && x.property_key === t.property_key; })[0];
      // The day the landlord paid what they owed from the move-in statement, if they have.
      const settled = (d.fees_paid && String(d.fees_paid.at || today).slice(0, 10)) || (d.fees_invoice_id && paidInv[d.fees_invoice_id]) || null;
      const months = statementChain(t, next ? String(next.start_date).slice(0, 10) : null, settled, today);
      if (!months.length) return;
      const ll = lls[t.property_key] || {};
      out.push({ tenancy_id: t.id, address: d.address || t.address, current: !next, landlord: (d.landlord && d.landlord.name) || ll.name || '', email: (d.landlord && d.landlord.email) || ll.email || '', settled: settled, months: months });
    });
    return { today: today, items: out };
  }
  app.get('/api/admin/statements', withDb(async function (p, req, res) {
    res.json(Object.assign({ ok: true }, await statementsAll(p)));
  }));
  // A month's statement sent to the landlord (or not).
  app.post('/api/admin/tenancies/:id/statement', withDb(async function (p, req, res) {
    const b = req.body || {}, from = isoDay(b.from), sent = b.sent !== false;
    // What was sent (to spot a statement changed afterwards).
    const snap = { at: new Date().toISOString(), total: money(Math.abs(Number(b.total) || 0)) || 0, balance: Number(b.balance) || 0 };
    if (!from) return res.status(400).json({ ok: false, error: 'from' });
    const r = await p.query(`UPDATE tenancies SET data = jsonb_set(data, '{stmt_sent}', coalesce(data->'stmt_sent', '{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb)), log = log || $4::jsonb, updated_at = now() WHERE id = $1 RETURNING id`,
      [jobId(req), from, sent ? JSON.stringify(snap) : 'null', JSON.stringify([{ at: new Date().toISOString(), text: sent ? 'Landlord statement for the month from ' + certDay(from) + ' sent' + (b.how ? ' (' + str(b.how, 40) + ')' : '') : 'Statement for the month from ' + certDay(from) + ' marked not sent' }])]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'not-found' });
    res.json({ ok: true });
  }));
  // Several statements marked sent at once: [{tenancy_id, from, total, balance}].
  app.post('/api/admin/statements/sent', withDb(async function (p, req, res) {
    const list = (Array.isArray((req.body || {}).items) ? req.body.items : []).slice(0, 500), by = {};
    list.forEach(function (x) { const id = parseInt(x && x.tenancy_id, 10), from = isoDay(x && x.from); if (!id || !from) return; (by[id] = by[id] || {})[from] = { at: new Date().toISOString(), total: money(Math.abs(Number(x.total) || 0)) || 0, balance: Number(x.balance) || 0 }; });
    let n = 0;
    for (const id of Object.keys(by)) {
      const months = Object.keys(by[id]).sort();
      const r = await p.query(`UPDATE tenancies SET data = jsonb_set(data, '{stmt_sent}', coalesce(data->'stmt_sent', '{}'::jsonb) || $2::jsonb), log = log || $3::jsonb, updated_at = now() WHERE id = $1 RETURNING id`,
        [id, JSON.stringify(by[id]), JSON.stringify([{ at: new Date().toISOString(), text: 'Landlord statement' + (months.length === 1 ? '' : 's') + ' marked sent: ' + months.map(certDay).join(', ') }])]);
      n += r.rowCount ? months.length : 0;
    }
    res.json({ ok: true, marked: n });
  }));
  // Phone alert on each rent date (from 8am): the statements to send, and any
  // landlord who still owes us after this month's rent.
  async function alertStatements() {
    const p = await db(); if (!p) return;
    const hour = +new Date().toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hour12: false });
    if (hour < 8) return;
    const r = await statementsAll(p);
    const st = ((await p.query("SELECT value FROM app_settings WHERE key = 'stmt_alert'")).rows[0] || {}).value || {};
    const due = [];
    r.items.forEach(function (x) { const m = x.months[x.months.length - 1]; if (x.current && m.n > 0 && m.from === r.today && !m.sent && !st[x.tenancy_id + '|' + m.from]) due.push({ x: x, m: m }); });
    if (!due.length) return;
    const owe = due.filter(function (o) { return o.m.balance < -0.004 || o.m.bf; });
    for (const o of owe) {
      await ntfy({ title: 'Rent day: collect from ' + (o.x.landlord || 'the landlord') + ' — ' + shortAddrText(o.x.address), message: 'Brought forward ' + gbp(o.m.bf) + ' taken from this month’s rent of ' + gbp(o.m.rent) + '. ' + (o.m.balance < -0.004 ? 'They still owe ' + gbp(-o.m.balance) + '.' : 'Cleared — ' + gbp(o.m.balance) + ' to pay them.') + ' Send the statement from Fixflow.', tags: ['moneybag'] }).catch(function () {});
    }
    const rest = due.length - owe.length;
    if (rest) await ntfy({ title: 'Rent day: ' + rest + ' landlord statement' + (rest === 1 ? '' : 's') + ' to send', message: due.filter(function (o) { return owe.indexOf(o) === -1; }).map(function (o) { return shortAddrText(o.x.address); }).join(', ') + '. Open Fixflow.', tags: ['page_facing_up'] }).catch(function () {});
    const patch = {}; due.forEach(function (o) { patch[o.x.tenancy_id + '|' + o.m.from] = new Date().toISOString(); });
    await p.query(`INSERT INTO app_settings (key, value) VALUES ('stmt_alert', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = app_settings.value || excluded.value, updated_at = now()`, [JSON.stringify(patch)]);
  }
  setTimeout(function () { alertStatements().catch(function (err) { console.error('Statement alert failed:', err.message); }); }, 110 * 1000);
  setInterval(function () { alertStatements().catch(function (err) { console.error('Statement alert failed:', err.message); }); }, 3600 * 1000).unref();

  return { saveReport: saveReport, hasDb: async function () { return !!(await db()); } };
};
