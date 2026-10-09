// Applicant leads from outside the website, shown on the staff app's Leads page with the website's own
// viewing requests and "looking to rent / buy" messages. Two ways in:
//  - /hooks/leads/<key>: any service can post a lead as JSON or a form (e.g. a mail-parsing service fed
//    with the Rightmove enquiry emails). The key is made on first use (app_settings 'lead_hook') and shown
//    to managers on the Leads page — whoever has the link can add leads, nothing more.
//  - Rightmove's Real Time Datafeed (enquiries sent to our branches), switched on by Railway variables:
//    RM_LEADS_CERT (the certificate Rightmove issues, .p12 as base64), RM_LEADS_CERT_PASS, RM_NETWORK_ID,
//    RM_BRANCH_IDS (comma-separated), optional RM_LEADS_URL (default Rightmove's live API) and
//    RM_LEADS_EVERY (minutes, default 10). Each lead is kept once (Rightmove's email id).
// Leads land in valuation_requests (data.kind 'rightmove' / 'lead'), like every other website lead.
const crypto = require('crypto');
const https = require('https');
const express = require('express');

module.exports = function (app, opts) {
  const str = function (v, n) { v = String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); return v ? v.slice(0, n) : ''; };
  async function hookKey(p) {
    const r = (await p.query("SELECT value FROM app_settings WHERE key = 'lead_hook'")).rows[0];
    if (r && r.value && r.value.key) return r.value;
    const key = crypto.randomBytes(18).toString('base64url');
    await p.query("INSERT INTO app_settings (key, value) VALUES ('lead_hook', $1) ON CONFLICT (key) DO NOTHING", [JSON.stringify({ key: key })]);
    return ((await p.query("SELECT value FROM app_settings WHERE key = 'lead_hook'")).rows[0].value || {});
  }
  // One lead in: kept once per outside id (or the same person about the same property within an hour).
  async function addLead(p, l) {
    const name = str(l.name, 120) || 'Applicant', email = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(str(l.email, 200)) ? str(l.email, 200).toLowerCase() : null;
    const phone = str(l.phone, 40).replace(/[^\d+ ()-]/g, '') || null, addr = str(l.address, 300) || '(no property given)', ext = str(l.ext_id, 120);
    if (!email && !phone) return { skipped: 'no-contact' };
    if (ext && (await p.query("SELECT 1 FROM valuation_requests WHERE data->>'ext_id' = $1 LIMIT 1", [ext])).rows.length) return { skipped: 'duplicate' };
    if (!ext && (await p.query("SELECT 1 FROM valuation_requests WHERE created_at > now() - interval '1 hour' AND address = $1 AND (lower(email) = $2 OR phone = $3) LIMIT 1", [addr, email || '-', phone || '-'])).rows.length) return { skipped: 'duplicate' };
    const data = { kind: l.kind || (l.source === 'Rightmove' ? 'rightmove' : 'lead'), rm: Array.isArray(l.rm) ? l.rm : undefined, lead_type: l.lead_type || undefined, source: str(l.source, 40) || 'Other', listing: l.listing === 'sale' ? 'sale' : 'let', message: str(l.message, 3000),
      ref: str(l.ref, 60), url: /^https?:\/\//.test(String(l.url || '')) ? str(l.url, 400) : '', ext_id: ext, people: str(l.people, 60), move: str(l.move, 60) };
    const at = l.at && !isNaN(new Date(l.at).getTime()) && new Date(l.at).getTime() < Date.now() + 3600000 ? new Date(l.at).toISOString() : new Date().toISOString();
    const r = await p.query('INSERT INTO valuation_requests (created_at, name, email, phone, address, data) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id', [at, name, email, phone, addr, JSON.stringify(data)]);
    await p.query('INSERT INTO crm_notes (ref, note, by_name, auto) VALUES ($1, $2, $3, true)', ['vr:' + r.rows[0].id, 'Came in from ' + data.source + (data.ref ? ' · ref ' + data.ref : ''), data.source]).catch(function () {});
    return { id: r.rows[0].id };
  }
  // Whatever a service posts: find the name, email, phone, property and message under the usual names.
  function readLead(b) {
    const flat = {}; (function walk(o, pre) { Object.keys(o || {}).forEach(function (k) { const v = o[k]; if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, pre + k + '.'); else flat[(pre + k).toLowerCase()] = v; }); })(b, '');
    const pick = function (re) { const k = Object.keys(flat).find(function (x) { return re.test(x) && flat[x] != null && String(flat[x]).trim(); }); return k ? String(flat[k]) : ''; };
    const first = pick(/first_?name$/), last = pick(/(last|sur)_?name$/);
    return { name: pick(/(^|\.)(full_?)?name$/) || [first, last].filter(Boolean).join(' '), email: pick(/e-?mail(_?address)?$/), phone: pick(/(phone|mobile|tel(ephone)?)(_?(number|day|evening))?$/),
      address: pick(/(property_?)?address$|^property$|display_?address/), message: pick(/message|comments?|enquiry|body|text$/), ref: pick(/(agent_?)?ref(erence)?$|property_?id$/), url: pick(/url$|link$/),
      source: pick(/^source$|portal/) || 'Other', listing: /sale|buy/i.test(pick(/channel|listing|type$/)) ? 'sale' : 'let', ext_id: pick(/(^|\.)(email_?|lead_?|enquiry_?)?id$/), at: pick(/date|time|created/) };
  }
  app.post('/hooks/leads/:key', express.urlencoded({ extended: true, limit: '256kb' }), async function (req, res) {
    try {
      const p = await opts.db(); if (!p) return res.status(503).end();
      const h = await hookKey(p);
      if (!req.params.key || req.params.key.length !== String(h.key).length || !crypto.timingSafeEqual(Buffer.from(req.params.key), Buffer.from(String(h.key)))) return res.status(404).end();
      const list = Array.isArray(req.body) ? req.body.slice(0, 50) : Array.isArray(req.body && req.body.leads) ? req.body.leads.slice(0, 50) : [req.body || {}];
      const out = [];
      for (const b of list) out.push(await addLead(p, readLead(b)));
      await p.query("UPDATE app_settings SET value = value || $1 WHERE key = 'lead_hook'", [JSON.stringify({ last_at: new Date().toISOString(), last: out })]).catch(function () {});
      res.json({ ok: true, results: out });
    } catch (e) { console.error('Lead hook:', e.message); res.status(500).json({ ok: false }); }
  });
  // Managers see the link (and when it was last used) on the Leads page.
  app.get('/api/admin/lead-hook', async function (req, res) {
    if (!opts.canManage(req)) return res.status(403).json({ ok: false });
    const p = await opts.db(); if (!p) return res.json({ ok: false });
    const h = await hookKey(p);
    res.json({ ok: true, url: opts.siteUrl + '/hooks/leads/' + h.key, last_at: h.last_at || null, rightmove: rmOn(), rm_last: rmLast, rm_hook: { url: opts.siteUrl + '/hooks/rightmove', secret: !!String(process.env.RIGHTMOVE_WEBHOOK_SECRET || '').trim(), stats: rmHook } });
  });

  // ---------- Rightmove Real Time Lead Integration (webhooks) ----------
  // Rightmove posts each new enquiry to /hooks/rightmove as { eventId, eventType: 'lead.created', data }.
  // Every request is signed (Svix: svix-id, svix-timestamp, svix-signature) with the secret Rightmove gives
  // us when they verify the address — kept in the Railway variable RIGHTMOVE_WEBHOOK_SECRET. Until it is set,
  // requests are answered (so Rightmove can check the address) but no leads are saved.
  const RM_TYPES = { LETTING_RESIDENTIAL: 'To rent', LETTING_RESIDENTIAL_ENHANCED: 'To rent (enhanced lead)', RESALE_RESIDENTIAL: 'To buy', RESALE_NEW_HOMES: 'New home to buy', RESALE_NEW_HOMES_ENHANCED: 'New home to buy (enhanced lead)',
    OVERSEAS_SALES: 'Overseas to buy', LETTING_COMMERCIAL: 'Commercial to rent', RESALE_COMMERCIAL: 'Commercial to buy', BFR_ENHANCED_LEAD: 'Build to rent (enhanced lead)', VALUATION_REQUEST_DISCOVER: 'Valuation request',
    VALUATION_REQUEST_LVA: 'Valuation request', ONLINE_AGENT_VALUATION: 'Online valuation request', EMAIL_AGENT: 'Message to the branch', MEDIA_CONTENT_REQUEST: 'Media request' };
  let rmHook = { at: null, ok: 0, bad: 0, unsigned: 0 };
  function svixOk(req) {
    const secret = String(process.env.RIGHTMOVE_WEBHOOK_SECRET || '').trim(); if (!secret) return null;
    const id = String(req.headers['svix-id'] || ''), ts = String(req.headers['svix-timestamp'] || ''), sig = String(req.headers['svix-signature'] || '');
    if (!id || !/^\d+$/.test(ts) || !sig || !req.rawBody) return false;
    if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;   // older than 5 minutes: a replay
    const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
    const want = crypto.createHmac('sha256', key).update(id + '.' + ts + '.').update(req.rawBody).digest();
    return sig.split(' ').some(function (part) {
      const v = part.split(','); if (v[0] !== 'v1' || !v[1]) return false;
      const got = Buffer.from(v[1], 'base64'); return got.length === want.length && crypto.timingSafeEqual(got, want);
    });
  }
  const yn = function (v) { return v === true ? 'Yes' : v === false ? 'No' : ''; };
  const words = function (v) { v = String(v || ''); return !v || /^NOT_(STATED|APPLICABLE)$/.test(v) ? '' : v.charAt(0) + v.slice(1).toLowerCase().replace(/_/g, ' '); };
  app.post('/hooks/rightmove', async function (req, res) {
    try {
      const ok = svixOk(req);
      rmHook.at = new Date().toISOString();
      if (ok === false) { rmHook.bad++; return res.status(401).json({ ok: false }); }
      if (ok === null) { rmHook.unsigned++; return res.json({ ok: true, note: 'received; not saved until the signing secret is set' }); }
      const b = req.body || {}; let d = b.data;
      if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { d = null; } }
      if (b.eventType !== 'lead.created' || !d || typeof d !== 'object') { rmHook.ok++; return res.json({ ok: true, ignored: true }); }
      const p = await opts.db(); if (!p) return res.status(503).end();
      const a = d.applicant || {}, type = String(d.leadType || ''), val = /VALUATION/.test(type), sale = /RESALE|OVERSEAS/.test(type);
      const home = d.reference && opts.findListing ? opts.findListing(d.reference) : null;
      const adults = String(d.numberOfAdultsMoving || ''), kids = String(d.numberOfChildrenMoving || '');
      const rm = [['Lead type', RM_TYPES[type] || words(type)], ['Wants a viewing', yn(d.requestViewing)], ['Wants more details', yn(d.requestPropertyDetails)],
        ['Income satisfactory', words(d.incomeSatisfactory)], ['Adverse credit', d.adverseCredit === 'HAS_ADVERSE_CREDIT' ? 'Yes' : d.adverseCredit === 'NO_ADVERSE_CREDIT' ? 'No' : ''],
        ['Work', words(d.employmentStatus)], ['Guarantor', yn(d.hasGuarantor)], ['Savings', yn(d.hasSavings)], ['Moving with', words(d.movingWith)],
        ['First-time renter', yn(d.firstTimeRenter)], ['Pets', yn(d.pets) + (d.petsInformation ? ' — ' + str(d.petsInformation, 200) : '')], ['Smoker', yn(d.smoker)],
        ['Credit check consent', words(d.creditCheckConsentStatus)], ['Selling', words(d.sellingSituationType)], ['Renting', words(d.rentingSituationType)], ['Valuation wanted', yn(d.valuationRequested)],
        ['Buyer', words(d.buyerStatus)], ['Timescale', words(d.urgency)], ['Their address', str(a.address, 200)]].filter(function (x) { return x[1]; });
      const got = await addLead(p, { source: 'Rightmove', ext_id: 'rm:' + (d.enquiryId || b.eventId), at: d.submitTime || d.createTime, name: [a.firstName, a.lastName].filter(Boolean).join(' '),
        email: a.emailAddress, phone: a.telephone, address: home ? home.where : (val ? str(a.address, 300) : (d.reference ? 'Rightmove ref ' + d.reference : '')), ref: d.reference, url: home ? home.url : str(d.deepLink, 400),
        listing: sale ? 'sale' : 'let', message: d.comments, people: adults ? adults + ' adult' + (adults === '1' ? '' : 's') + (kids && kids !== '0' ? ', ' + kids + ' child' + (kids === '1' ? '' : 'ren') : '') : '',
        move: words(d.moveByUrgency), kind: val ? (sale ? 'sale' : 'val') : '', rm: rm, lead_type: type });
      rmHook.ok++;
      res.json({ ok: true, saved: !!got.id });
    } catch (e) { console.error('Rightmove lead:', e.message); res.status(500).json({ ok: false }); }
  });

  // ---------- Rightmove Real Time Datafeed: enquiries to our branches ----------
  const rmOn = function () { return !!(process.env.RM_LEADS_CERT && process.env.RM_NETWORK_ID && process.env.RM_BRANCH_IDS); };
  let rmLast = null;
  const ukDate = function (d) { const z = function (n) { return String(n).padStart(2, '0'); }; return z(d.getUTCDate()) + '-' + z(d.getUTCMonth() + 1) + '-' + d.getUTCFullYear() + ' ' + z(d.getUTCHours()) + ':' + z(d.getUTCMinutes()) + ':' + z(d.getUTCSeconds()); };
  function rmPost(path, body) {
    return new Promise(function (resolve, reject) {
      const u = new URL(path, process.env.RM_LEADS_URL || 'https://adfapi.rightmove.co.uk/'), data = JSON.stringify(body);
      const req = https.request({ hostname: u.hostname, path: u.pathname, method: 'POST', pfx: Buffer.from(process.env.RM_LEADS_CERT, 'base64'), passphrase: process.env.RM_LEADS_CERT_PASS || undefined,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, timeout: 30000 }, function (res) {
        let s = ''; res.on('data', function (c) { s += c; }); res.on('end', function () { try { resolve({ status: res.statusCode, json: JSON.parse(s) }); } catch (e) { resolve({ status: res.statusCode, text: s.slice(0, 500) }); } });
      });
      req.on('timeout', function () { req.destroy(new Error('timeout')); }); req.on('error', reject); req.end(data);
    });
  }
  async function rmCheck() {
    if (!rmOn()) return;
    const p = await opts.db(); if (!p) return;
    const row = (await p.query("SELECT value FROM app_settings WHERE key = 'rm_leads'")).rows[0], st = (row && row.value) || {};
    const end = new Date(), start = new Date(Math.max(new Date(st.until || 0).getTime() - 15 * 60000, end.getTime() - 3 * 86400000));
    let added = 0, seen = 0;
    for (const branch of String(process.env.RM_BRANCH_IDS).split(',').map(function (x) { return +x.trim(); }).filter(Boolean)) {
      const r = await rmPost('/v1/property/getbranchemails', { network: { network_id: +process.env.RM_NETWORK_ID }, branch: { branch_id: branch }, export_period: { start_date_time: ukDate(start), end_date_time: ukDate(end) } });
      const emails = (r.json && (r.json.emails || (r.json.export && r.json.export.emails))) || [];
      if (r.status !== 200 || (r.json && r.json.success === false)) { rmLast = { at: end.toISOString(), error: 'Rightmove said ' + r.status + ' ' + JSON.stringify((r.json && (r.json.errors || r.json.message)) || r.text || '').slice(0, 300) }; console.error('Rightmove leads:', rmLast.error); return; }
      for (const e of emails) {
        seen++;
        const u = e.user || {}, c = u.user_contact_details || u.contact_details || u, pr = e.property || {}, info = u.user_information || {};
        const got = await addLead(p, { source: 'Rightmove', ext_id: 'rm:' + (e.email_id || e.id || ''), at: e.email_date || e.date, name: [c.title, c.first_name, c.last_name].filter(Boolean).join(' ') || c.name,
          email: c.email || e.from_address, phone: c.phone_day || c.phone_evening || c.phone || c.mobile, address: pr.display_address || pr.address || '', ref: pr.agent_ref || pr.rightmove_id || '',
          url: pr.rightmove_url || '', listing: Number(pr.channel) === 1 ? 'sale' : 'let', message: e.comments || e.message || e.body || '',
          move: info.move_date || '', people: info.number_of_people || '' });
        if (got.id) added++;
      }
    }
    rmLast = { at: end.toISOString(), seen: seen, added: added };
    await p.query("INSERT INTO app_settings (key, value) VALUES ('rm_leads', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [JSON.stringify({ until: end.toISOString(), last: rmLast })]);
    if (added) console.log('Rightmove leads: ' + added + ' new of ' + seen);
  }
  if (rmOn()) {
    const every = Math.max(5, +process.env.RM_LEADS_EVERY || 10) * 60000;
    setTimeout(function () { rmCheck().catch(function (e) { console.error('Rightmove leads:', e.message); }); }, 90 * 1000);
    setInterval(function () { rmCheck().catch(function (e) { rmLast = { at: new Date().toISOString(), error: e.message }; console.error('Rightmove leads:', e.message); }); }, every).unref();
  }
  return { addLead: addLead };
};
