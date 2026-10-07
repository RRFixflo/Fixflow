// Who's calling: the office phone system (Edison Networks / Telecom150 → Company Features → Webhooks) tells
// Fixflow about each call at /hooks/phone/<key>. Each call is kept with the caller's number and matched to
// the tenants, landlords, contractors, applicants and website leads we have on file; the staff app shows a
// pop-up as the phone rings and a Calls page with the recent ones. The key is made on first use (app_settings
// 'phone_hook') and shown to managers on the Calls page — whoever has the link can post calls, nothing more.
const crypto = require('crypto');
const express = require('express');

module.exports = function (app, opts) {
  let ready = null;
  async function pool() {
    const p = await opts.db(); if (!p) return null;
    if (!ready) ready = p.query(`CREATE TABLE IF NOT EXISTS phone_calls (id SERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now(), number TEXT, direction TEXT,
      line TEXT, event TEXT, raw JSONB NOT NULL DEFAULT '{}'::jsonb); CREATE INDEX IF NOT EXISTS phone_calls_at ON phone_calls (at DESC);`).catch(function (e) { ready = null; throw e; });
    await ready; return p;
  }
  async function hookKey(p) {
    const r = (await p.query("SELECT value FROM app_settings WHERE key = 'phone_hook'")).rows[0];
    if (r && r.value && r.value.key) return r.value.key;
    const key = crypto.randomBytes(18).toString('base64url');
    await p.query("INSERT INTO app_settings (key, value) VALUES ('phone_hook', $1) ON CONFLICT (key) DO NOTHING", [JSON.stringify({ key: key })]);
    return ((await p.query("SELECT value FROM app_settings WHERE key = 'phone_hook'")).rows[0].value || {}).key;
  }
  // UK numbers to one form: 07700900123 (from +447700900123, 447700900123, 0044…, spaces, dashes).
  const norm = function (v) { let d = String(v || '').replace(/\D/g, ''); if (/^0044/.test(d)) d = d.slice(4); if (/^44\d{9,10}$/.test(d)) d = d.slice(2); if (d.length === 10 && !/^0/.test(d)) d = '0' + d; return d.length >= 7 && d.length <= 13 ? d : ''; };
  // Phone systems name things differently: find the caller, the number dialled and the direction in whatever arrives.
  function readCall(b) {
    const flat = {}; (function walk(o, pre) { Object.keys(o || {}).forEach(function (k) { const v = o[k]; if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, pre + k + '.'); else flat[(pre + k).toLowerCase()] = v; }); })(b, '');
    const pick = function (re, num) { const k = Object.keys(flat).find(function (x) { return re.test(x) && (!num || norm(flat[x])); }); return k ? flat[k] : ''; };
    const dir = String(pick(/direction|calltype|call_type|type$/) || '').toLowerCase();
    let number = pick(/caller(_?id|_?number|num)?$|^cli$|\.cli$|callingnumber|calling_number|^from$|\.from$|^ani$|source(_?number)?$|^src$|remote(_?number)?$|external(_?number)?$/, true);
    const line = pick(/called(_?number)?$|dialled|dialed|^to$|\.to$|^did$|^ddi$|destination|^dst$|^dnis$|extension|^ext$/, false);
    if (/out/.test(dir) && line && norm(line)) number = line;   // an outgoing call: the other party is the number dialled
    if (!number) number = pick(/number|phone/, true);
    return { number: norm(number), direction: /out/.test(dir) ? 'out' : /in/.test(dir) ? 'in' : dir.slice(0, 20), line: String(line || '').slice(0, 40), event: String(pick(/event|status|state|action/) || '').slice(0, 40) };
  }
  const body = [express.urlencoded({ extended: true, limit: '64kb' }), express.text({ type: ['text/*', 'application/xml'], limit: '64kb' })];
  app.all('/hooks/phone/:key', body, async function (req, res) {
    try {
      const p = await pool(); if (!p) return res.status(503).end();
      const key = await hookKey(p), given = String(req.params.key || '');
      if (given.length !== key.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(key))) return res.status(404).end();
      let b = Object.assign({}, req.query || {}, typeof req.body === 'object' ? req.body : {});
      if (typeof req.body === 'string' && req.body.trim()) { try { Object.assign(b, JSON.parse(req.body)); } catch (e) { b.text = req.body.slice(0, 4000); } }
      const c = readCall(b);
      // One row per call: repeated events for the same number within two minutes update it.
      const last = c.number ? (await p.query("SELECT id FROM phone_calls WHERE number = $1 AND at > now() - interval '2 minutes' ORDER BY id DESC LIMIT 1", [c.number])).rows[0] : null;
      if (last) await p.query('UPDATE phone_calls SET event = coalesce(nullif($2, \'\'), event), raw = $3 WHERE id = $1', [last.id, c.event, JSON.stringify(b).slice(0, 8000)]);
      else await p.query('INSERT INTO phone_calls (number, direction, line, event, raw) VALUES ($1, $2, $3, $4, $5)', [c.number || null, c.direction || null, c.line || null, c.event || null, JSON.stringify(b).slice(0, 8000)]);
      await p.query("DELETE FROM phone_calls WHERE at < now() - interval '180 days'").catch(function () {});
      res.json({ ok: true });
    } catch (e) { console.error('Phone calls hook:', e.message); res.status(500).json({ ok: false }); }
  });

  // Who a number belongs to, from everything on file.
  async function whoIs(p, numbers) {
    const want = {}; numbers.filter(Boolean).forEach(function (n) { want[n.slice(-10)] = []; }); if (!Object.keys(want).length) return {};
    const add = function (rows, kind, label) { rows.forEach(function (r) { const k = norm(r.phone).slice(-10); if (want[k] && want[k].length < 4 && !want[k].some(function (x) { return x.kind === kind && x.name === r.name; })) want[k].push({ kind: kind, label: label, name: r.name || '', where: r.addr || '', id: r.id }); }); };
    const q = function (sql) { return p.query(sql).then(function (r) { return r.rows; }).catch(function () { return []; }); };
    add(await q("SELECT id, name, phone, NULL AS addr FROM tenants WHERE coalesce(phone, '') <> ''"), 'tenant', 'Tenant');
    add(await q("SELECT DISTINCT ON (tenant_phone) id, tenant_name AS name, tenant_phone AS phone, property_address AS addr FROM jobs WHERE coalesce(tenant_phone, '') <> '' ORDER BY tenant_phone, id DESC"), 'tenant', 'Tenant');
    add(await q("SELECT id, name, phone, address AS addr FROM landlords WHERE coalesce(phone, '') <> ''"), 'landlord', 'Landlord');
    add(await q("SELECT id, name, phone, NULL AS addr FROM contractors WHERE coalesce(phone, '') <> ''"), 'contractor', 'Contractor');
    add(await q("SELECT id, lead_name AS name, lead_phone AS phone, property_address AS addr FROM offers WHERE coalesce(lead_phone, '') <> '' ORDER BY id DESC LIMIT 3000"), 'applicant', 'Applicant');
    add(await q("SELECT id, name, phone, address AS addr FROM valuation_requests WHERE coalesce(phone, '') <> '' ORDER BY id DESC LIMIT 3000"), 'lead', 'Website lead');
    return want;
  }
  async function list(p, where, args, limit) {
    const rows = (await p.query('SELECT id, at, number, direction, line, event FROM phone_calls ' + where + ' ORDER BY id DESC LIMIT ' + limit, args)).rows;
    const who = await whoIs(p, rows.map(function (r) { return r.number; }));
    rows.forEach(function (r) { r.who = r.number ? who[r.number.slice(-10)] || [] : []; });
    return rows;
  }
  app.get('/api/admin/calls', async function (req, res) {
    const p = await pool().catch(function () { return null; }); if (!p) return res.status(503).json({ ok: false });
    const out = { ok: true, items: await list(p, "WHERE at > now() - interval '90 days'", [], 300) };
    if (opts.canManage && opts.canManage(req)) { out.hook = (opts.siteUrl || '') + '/hooks/phone/' + await hookKey(p); const l = (await p.query('SELECT at, raw FROM phone_calls ORDER BY id DESC LIMIT 1')).rows[0]; out.lastRaw = l || null; }
    res.json(out);
  });
  // For the pop-up: calls since the last one the screen has seen.
  app.get('/api/admin/calls/new', async function (req, res) {
    const p = await pool().catch(function () { return null; }); if (!p) return res.json({ ok: true, items: [] });
    const after = parseInt(req.query.after, 10);
    if (isNaN(after)) { const m = (await p.query('SELECT coalesce(max(id), 0) AS id FROM phone_calls')).rows[0]; return res.json({ ok: true, items: [], last: m.id }); }
    const items = await list(p, "WHERE id > $1 AND at > now() - interval '3 minutes'", [after], 5);
    const m = (await p.query('SELECT coalesce(max(id), 0) AS id FROM phone_calls')).rows[0];
    res.json({ ok: true, items: items, last: m.id });
  });
  return { norm: norm, readCall: readCall };
};
