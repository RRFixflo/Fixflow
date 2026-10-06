// Landlord updates (/landlord-updates): the latest official news and guidance for landlords, read
// automatically from gov.uk every hour, and email alerts landlords can sign up to (as it happens,
// weekly or monthly). Sign-ups are confirmed by email first, and every alert has a one-click
// unsubscribe link.
const crypto = require('crypto');

module.exports = function (app, opts) {
  const SITE = opts.siteUrl;
  const esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  const ent = function (s) { return String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, function (m, n) { return String.fromCharCode(+n); }).replace(/&#x([0-9a-f]+);/gi, function (m, n) { return String.fromCharCode(parseInt(n, 16)); }).replace(/&rsquo;|&lsquo;/g, '’').replace(/&ldquo;|&rdquo;/g, '"').replace(/&pound;/g, '£').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim(); };
  // Official sources: GOV.UK news and guidance about private renting (Atom feeds).
  const q = function (type, kw) { return 'https://www.gov.uk/search/' + type + '.atom?keywords=' + encodeURIComponent(kw) + '&order=updated-newest'; };
  const FEEDS = (process.env.LANDLORD_FEEDS ? process.env.LANDLORD_FEEDS.split(/\s*,\s*/) : [
    q('news-and-communications', 'landlords'), q('news-and-communications', 'renters rights'), q('news-and-communications', 'private rented sector'),
    q('guidance-and-regulation', 'landlords private rented'), q('guidance-and-regulation', 'renters rights act'), q('guidance-and-regulation', 'tenancy deposit'),
    q('policy-papers-and-consultations', 'private rented sector')
  ]).filter(function (u) { return /^https:\/\//.test(u); });
  // Only things that matter to landlords.
  const RELEVANT = /landlord|tenan|renter|rent(ed|ing|al)?\b|letting|lettings|housing|hmo|licens|epc|energy performance|deposit|evict|possession|section 21|section 8|gas safety|electrical safety|smoke alarm|carbon monoxide|damp|mould|decent homes|ombudsman|right to rent|leasehold|council tax|property|home/i;
  const IRRELEVANT = /scotland|scottish|wales|welsh|northern ireland/i;   // our landlords are in England

  let tableOk = false;
  async function pool() {
    const p = await opts.db(); if (!p) return null;
    if (!tableOk) {
      await p.query(`CREATE TABLE IF NOT EXISTS landlord_updates (id SERIAL PRIMARY KEY, url TEXT UNIQUE NOT NULL, title TEXT NOT NULL, summary TEXT, source TEXT, kind TEXT, published TIMESTAMPTZ, seen_at TIMESTAMPTZ NOT NULL DEFAULT now());
        CREATE TABLE IF NOT EXISTS landlord_alert_subs (id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, freq TEXT NOT NULL DEFAULT 'weekly', token TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          confirmed_at TIMESTAMPTZ, unsubscribed_at TIMESTAMPTZ, last_sent_at TIMESTAMPTZ, sent_count INT NOT NULL DEFAULT 0, ip TEXT);`);
      tableOk = true;
    }
    return p;
  }

  // ---------- Reading the feeds ----------
  function parseAtom(xml, kind) {
    const out = [];
    String(xml).replace(/<entry\b[\s\S]*?<\/entry>/g, function (e) {
      const t = ent((/<title[^>]*>([\s\S]*?)<\/title>/.exec(e) || [])[1]);
      const l = (/<link[^>]*href="([^"]+)"/.exec(e) || [])[1] || '';
      const s = ent((/<summary[^>]*>([\s\S]*?)<\/summary>/.exec(e) || [])[1]).slice(0, 400);
      const d = ent((/<(updated|published)>([\s\S]*?)<\/\1>/.exec(e) || [])[2]);
      if (t && /^https:\/\/www\.gov\.uk\//.test(l) && RELEVANT.test(t + ' ' + s) && !IRRELEVANT.test(t)) out.push({ title: t, url: l, summary: s, date: isFinite(Date.parse(d)) ? new Date(d).toISOString() : null, kind: kind });
    });
    return out;
  }
  let lastRun = 0, lastCount = 0;
  async function refresh() {
    const p = await pool(); if (!p) return;
    let found = 0, added = 0;
    for (const u of FEEDS) {
      try {
        const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (Residential Realtors landlord updates)', Accept: 'application/atom+xml, application/xml' }, signal: AbortSignal.timeout(15000) });
        if (!r.ok) continue;
        const kind = /news-and-communications/.test(u) ? 'News' : /policy/.test(u) ? 'Consultation' : 'Guidance';
        for (const it of parseAtom(await r.text(), kind)) {
          found++;
          const x = await p.query('INSERT INTO landlord_updates (url, title, summary, source, kind, published) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (url) DO UPDATE SET title = EXCLUDED.title, summary = EXCLUDED.summary, published = GREATEST(landlord_updates.published, EXCLUDED.published) RETURNING (xmax = 0) AS fresh',
            [it.url.slice(0, 500), it.title.slice(0, 300), it.summary || null, 'GOV.UK', it.kind, it.date]);
          if (x.rows[0] && x.rows[0].fresh) added++;
        }
      } catch (e) { /* try the next feed */ }
    }
    lastRun = Date.now(); lastCount = found;
    console.log('Landlord updates: ' + found + ' relevant items from GOV.UK, ' + added + ' new');
    if (added) await sendAlerts('instant');
  }

  // ---------- Alerts ----------
  const fmt = function (d) { return d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' }) : ''; };
  function alertEmail(sub, items, freq) {
    const unsub = SITE + '/landlord-updates/unsubscribe/' + sub.token, manage = SITE + '/landlord-updates/manage/' + sub.token;
    const head = freq === 'instant' ? 'New for landlords' : freq === 'monthly' ? 'Your monthly landlord update' : 'Your weekly landlord update';
    const text = head + '\n\n' + items.map(function (i) { return '• ' + i.title + (i.kind ? ' (' + i.kind + ')' : '') + '\n  ' + i.url; }).join('\n\n') +
      '\n\nSee everything: ' + SITE + '/landlord-updates\nNeed help with any of this? Call 0207 096 8131.\n\nChange how often you hear from us: ' + manage + '\nUnsubscribe: ' + unsub;
    const html = '<div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;color:#0f172a"><div style="background:#0b1f3a;color:#fff;padding:18px 22px;border-radius:12px 12px 0 0"><b style="font-size:18px">' + esc(head) + '</b><div style="color:#c9d3e1;font-size:13px;margin-top:4px">From Residential Realtors · ' + fmt(new Date()) + '</div></div>' +
      '<div style="border:1px solid #e6e9ef;border-top:0;padding:8px 22px 18px;border-radius:0 0 12px 12px">' + items.map(function (i) {
        return '<div style="padding:14px 0;border-bottom:1px solid #e6e9ef"><a href="' + esc(i.url) + '" style="color:#0b1f3a;font-weight:bold;font-size:15px;text-decoration:none">' + esc(i.title) + '</a>' +
          '<div style="color:#667085;font-size:12px;margin:3px 0">' + esc(i.kind || '') + ' · GOV.UK' + (i.published ? ' · ' + fmt(i.published) : '') + '</div>' + (i.summary ? '<div style="color:#475467;font-size:14px">' + esc(i.summary) + '</div>' : '') + '</div>';
      }).join('') +
      '<p style="margin:18px 0 6px"><a href="' + SITE + '/landlord-updates" style="background:#d9262e;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:bold">See all landlord updates</a></p>' +
      '<p style="color:#475467;font-size:14px">Not sure how a change affects you? Call us on 0207 096 8131 or reply to this email.</p>' +
      '<p style="color:#98a2b3;font-size:12px;margin-top:18px">You’re getting this because you signed up for landlord alerts on residentialrealtors.co.uk. <a href="' + manage + '" style="color:#667085">Change how often</a> · <a href="' + unsub + '" style="color:#667085">Unsubscribe</a><br>Estallion Investments Ltd trading as Residential Realtors · 28-30 Harper Road, London SE1 6AD</p></div></div>';
    return { to: sub.email, replyTo: 'info@residentialrealtors.co.uk', fromName: 'Residential Realtors', subject: head + ': ' + items[0].title.slice(0, 70) + (items.length > 1 ? ' + ' + (items.length - 1) + ' more' : ''), text: text, html: html,
      headers: { 'List-Unsubscribe': '<' + unsub + '>' } };
  }
  let sending = false;
  async function sendAlerts(only) {
    if (sending) return; sending = true;
    try {
      const p = await pool(); if (!p) return;
      const now = new Date(), london = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/London' }));
      // Weekly on Monday mornings, monthly on the 1st (from 9am London time); "instant" as items arrive (at most hourly).
      const due = { instant: true, weekly: london.getDay() === 1 && london.getHours() >= 9, monthly: london.getDate() === 1 && london.getHours() >= 9 };
      const subs = (await p.query("SELECT id, email, name, freq, token, last_sent_at, confirmed_at FROM landlord_alert_subs WHERE confirmed_at IS NOT NULL AND unsubscribed_at IS NULL AND ($1::text IS NULL OR freq = $1)", [only || null])).rows;
      for (const s of subs) {
        if (!due[s.freq]) continue;
        const gap = { instant: 50 * 60000, weekly: 6 * 86400000, monthly: 25 * 86400000 }[s.freq];
        if (s.last_sent_at && now - new Date(s.last_sent_at) < gap) continue;
        const since = s.last_sent_at || s.confirmed_at;
        const items = (await p.query('SELECT title, url, summary, kind, published FROM landlord_updates WHERE seen_at > $1 ORDER BY coalesce(published, seen_at) DESC LIMIT 15', [since])).rows;
        if (!items.length) continue;   // nothing new: no email
        const r = await opts.sendMail(alertEmail(s, items, s.freq));
        if (r && r.ok !== false) await p.query('UPDATE landlord_alert_subs SET last_sent_at = now(), sent_count = sent_count + 1 WHERE id = $1', [s.id]);
      }
    } catch (e) { console.error('Landlord alerts:', e.message); } finally { sending = false; }
  }
  if (FEEDS.length) { setTimeout(refresh, 20000); setInterval(refresh, 60 * 60000).unref(); setInterval(function () { sendAlerts(); }, 30 * 60000).unref(); }

  // ---------- Sign up, confirm, change, unsubscribe ----------
  const hits = new Map();
  const tooMany = function (ip) { const now = Date.now(), h = (hits.get(ip) || []).filter(function (t) { return now - t < 3600000; }); if (h.length >= 5) return true; h.push(now); hits.set(ip, h); if (hits.size > 5000) hits.clear(); return false; };
  const FREQ = { instant: 'as soon as something changes', weekly: 'a weekly round-up', monthly: 'a monthly round-up' };
  app.post('/api/landlord-alerts', async function (req, res) {
    const b = req.body || {}, ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    if (String(b.website || '').trim()) return res.json({ ok: true });   // a bot filled the hidden box
    if (tooMany(ip)) return res.status(429).json({ ok: false, error: 'rate-limited' });
    const email = String(b.email || '').trim().toLowerCase().slice(0, 200), name = String(b.name || '').trim().slice(0, 100), freq = FREQ[b.freq] ? b.freq : 'weekly';
    if (!/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(email)) return res.status(400).json({ ok: false, error: 'email' });
    if (b.consent !== true) return res.status(400).json({ ok: false, error: 'consent' });
    const p = await pool(); if (!p) return res.status(503).json({ ok: false, error: 'db' });
    const token = crypto.randomBytes(18).toString('base64url');
    const r = (await p.query(`INSERT INTO landlord_alert_subs (email, name, freq, token, ip) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (email) DO UPDATE SET name = coalesce(nullif(EXCLUDED.name, ''), landlord_alert_subs.name), freq = EXCLUDED.freq, unsubscribed_at = NULL
      RETURNING token, confirmed_at`, [email, name || null, freq, token, ip.slice(0, 60)])).rows[0];
    const link = SITE + '/landlord-updates/confirm/' + r.token;
    if (r.confirmed_at) { await p.query('UPDATE landlord_alert_subs SET unsubscribed_at = NULL WHERE email = $1', [email]); return res.json({ ok: true, already: true }); }
    await opts.sendMail({ to: email, replyTo: 'info@residentialrealtors.co.uk', fromName: 'Residential Realtors', subject: 'Please confirm your landlord alerts',
      text: 'Hello' + (name ? ' ' + name : '') + ',\n\nPlease confirm you’d like landlord alerts from Residential Realtors (' + FREQ[freq] + '):\n' + link + '\n\nIf you didn’t ask for this, just ignore this email.\n\nResidential Realtors · 0207 096 8131',
      html: '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#0f172a"><h2 style="color:#0b1f3a">Confirm your landlord alerts</h2><p>Hello' + (name ? ' ' + esc(name) : '') + ', please confirm you’d like landlord alerts from Residential Realtors — <b>' + esc(FREQ[freq]) + '</b>.</p>' +
        '<p><a href="' + link + '" style="background:#d9262e;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:bold">Yes, send me landlord alerts</a></p><p style="color:#667085;font-size:13px">If you didn’t ask for this, just ignore this email.</p></div>' });
    opts.alert({ title: '🔔 Landlord alerts sign-up', message: email + ' · ' + freq, tags: ['bell'] });
    res.json({ ok: true });
  });
  const shell = function (title, body) { return '<div class="phead small"><div class="wrap"><span class="eyebrow"><i></i> Landlord alerts</span><h1>' + esc(title) + '</h1></div></div><section class="white"><div class="wrap" style="max-width:720px">' + body + '</div></section>'; };
  const sendPage = function (req, res, name, title, body) { opts.send(req, res, { name: name, stamp: crypto.createHash('sha1').update(body).digest('hex').slice(0, 12), canon: '/landlord-updates', title: title + ' | Residential Realtors', desc: 'Landlord alerts', robots: 'noindex, nofollow', private: true }, shell(title, body)); };
  app.get('/landlord-updates/confirm/:token', async function (req, res) {
    const p = await pool(); const r = p && (await p.query('UPDATE landlord_alert_subs SET confirmed_at = coalesce(confirmed_at, now()), unsubscribed_at = NULL WHERE token = $1 RETURNING freq', [String(req.params.token).slice(0, 60)])).rows[0];
    if (!r) return sendPage(req, res, 'lu-x', 'Link not recognised', '<p class="sub">This link has expired or isn’t valid. You can <a href="/landlord-updates#alerts">sign up again here</a>.</p>');
    sendPage(req, res, 'lu-ok', 'You’re signed up', '<p class="sub">Thank you — you’ll get ' + esc(FREQ[r.freq]) + ' when the rules for landlords change. Every email has a link to change how often or unsubscribe.</p><p style="margin-top:20px"><a class="btn red" href="/landlord-updates">See the latest landlord updates →</a></p>');
  });
  app.get('/landlord-updates/manage/:token', async function (req, res) {
    const p = await pool(); const t = String(req.params.token).slice(0, 60), r = p && (await p.query('SELECT email, freq, unsubscribed_at FROM landlord_alert_subs WHERE token = $1', [t])).rows[0];
    if (!r) return sendPage(req, res, 'lu-x', 'Link not recognised', '<p class="sub">This link isn’t valid. <a href="/landlord-updates#alerts">Sign up again</a>.</p>');
    sendPage(req, res, 'lu-m', 'Your landlord alerts', '<p class="sub">Alerts for <b>' + esc(r.email) + '</b>' + (r.unsubscribed_at ? ' (currently unsubscribed)' : '') + '. How often would you like to hear from us?</p><div class="btns" style="margin-top:18px">' +
      Object.keys(FREQ).map(function (f) { return '<a class="btn ' + (f === r.freq && !r.unsubscribed_at ? 'navy' : 'line') + '" href="/landlord-updates/manage/' + esc(t) + '/' + f + '">' + (f === 'instant' ? 'As it happens' : f === 'weekly' ? 'Weekly' : 'Monthly') + '</a>'; }).join('') +
      '<a class="btn line" href="/landlord-updates/unsubscribe/' + esc(t) + '">Unsubscribe</a></div>');
  });
  app.get('/landlord-updates/manage/:token/:freq', async function (req, res) {
    const f = FREQ[req.params.freq] ? req.params.freq : null, p = await pool();
    if (f && p) await p.query('UPDATE landlord_alert_subs SET freq = $2, unsubscribed_at = NULL, confirmed_at = coalesce(confirmed_at, now()) WHERE token = $1', [String(req.params.token).slice(0, 60), f]);
    res.redirect(303, '/landlord-updates/manage/' + encodeURIComponent(req.params.token));
  });
  const unsub = async function (req, res) {
    const p = await pool(); const r = p && (await p.query('UPDATE landlord_alert_subs SET unsubscribed_at = coalesce(unsubscribed_at, now()) WHERE token = $1 RETURNING token', [String(req.params.token).slice(0, 60)])).rows[0];
    if (req.method === 'POST') return res.status(200).end();   // one-click unsubscribe from the email app
    sendPage(req, res, 'lu-u', r ? 'You’ve been unsubscribed' : 'Link not recognised', r ? '<p class="sub">You won’t get any more landlord alerts. Changed your mind? <a href="/landlord-updates/manage/' + esc(r.token) + '">Turn them back on</a>.</p>' : '<p class="sub">This link isn’t valid.</p>');
  };
  app.get('/landlord-updates/unsubscribe/:token', unsub); app.post('/landlord-updates/unsubscribe/:token', unsub);

  // For the office: how many landlords are signed up.
  app.get('/api/admin/landlord-alerts', async function (req, res) {
    if (!opts.isStaff || !opts.isStaff(req)) return res.status(401).json({ ok: false, error: 'signed-out' });   // registered before the admin sign-in check, so checked here
    const p = await pool(); if (!p) return res.json({ ok: false });
    const r = (await p.query("SELECT count(*) FILTER (WHERE confirmed_at IS NOT NULL AND unsubscribed_at IS NULL)::int AS active, count(*) FILTER (WHERE confirmed_at IS NULL AND unsubscribed_at IS NULL)::int AS waiting, count(*) FILTER (WHERE unsubscribed_at IS NOT NULL)::int AS left FROM landlord_alert_subs")).rows[0];
    const items = (await p.query('SELECT count(*)::int AS n, max(seen_at) AS last FROM landlord_updates')).rows[0];
    res.json(Object.assign({ ok: true, updates: items.n, last_update: items.last, checked_at: lastRun ? new Date(lastRun).toISOString() : null }, r));
  });

  // ---------- The page ----------
  async function latest(n) { const p = await pool(); if (!p) return []; return (await p.query('SELECT title, url, summary, kind, published, seen_at FROM landlord_updates ORDER BY coalesce(published, seen_at) DESC LIMIT $1', [n])).rows; }
  function signupForm(id) {
    return '<form class="la-form" id="' + id + '" novalidate><h3>Get landlord alerts</h3><p>We’ll email you when the rules for landlords change — free, and you can unsubscribe any time.</p>' +
      '<div class="la-row"><input name="name" placeholder="Your name (optional)" autocomplete="name"><input name="email" type="email" placeholder="Your email" autocomplete="email" required></div>' +
      '<div class="la-freq"><label><input type="radio" name="freq" value="instant"> As it happens</label><label><input type="radio" name="freq" value="weekly" checked> Weekly</label><label><input type="radio" name="freq" value="monthly"> Monthly</label></div>' +
      '<input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">' +
      '<label class="la-ok"><input type="checkbox" name="consent"> <span>I’d like landlord alerts from Residential Realtors (<a href="/privacy">privacy</a>)</span></label>' +
      '<p class="la-err" role="alert"></p><button class="btn red" type="submit">Sign me up</button></form>';
  }
  app.get(['/landlord-updates', '/landlord-news', '/landlord-alerts'], async function (req, res) {
    let items = []; try { items = await latest(30); } catch (e) { items = []; }
    const day = function (d) { return d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/London' }) : ''; };
    const latestDay = items.length ? items[0].published || items[0].seen_at : null;
    const body = '<div class="phead photo small"><img class="bg" src="/img/u-westminster.webp" srcset="/img/u-westminster-sm.webp 800w, /img/u-westminster.webp 1600w" sizes="100vw" alt="" fetchpriority="high" width="1600" height="1068"><div class="wrap">' +
      '<span class="eyebrow"><i></i> Updated automatically</span><h1>Landlord updates</h1><p class="lead">Every change to the rules for landlords in England, straight from GOV.UK — and free email alerts so you never miss one.</p>' +
      '<div class="btns"><a class="btn red" href="#alerts">Get landlord alerts</a><a class="btn ghost" href="/landlords#renters-rights">Renters’ Rights Act explained</a></div></div></div>' +
      '<section class="white"><div class="wrap lu-grid"><div>' +
      '<div class="lu-key"><h2 class="h2x">The big changes right now</h2><div class="lu-cards">' +
      '<a class="lu-card" href="/landlords#renters-rights"><b>Renters’ Rights Act</b><span>In force since 1 May 2026: rolling tenancies, no section 21, one rent increase a year.</span></a>' +
      '<a class="lu-card" href="https://www.gov.uk/government/publications/the-renters-rights-act-information-sheet-2026" target="_blank" rel="noopener"><b>Information Sheet 2026</b><span>The official sheet every tenant must be given. ↗</span></a>' +
      '<a class="lu-card" href="/property-checks#licence"><b>Property licensing</b><span>Check whether your London rental needs a licence.</span></a>' +
      '<a class="lu-card" href="/property-checks#epc"><b>Energy ratings</b><span>Rented homes need an EPC of E or better. Check yours.</span></a></div></div>' +
      '<div class="lu-h"><h2 class="h2x">Latest from GOV.UK</h2>' + (latestDay ? '<span class="lu-up">Last change ' + esc(day(latestDay)) + ' · checked every hour</span>' : '') + '</div>' +
      (items.length ? '<ul class="lu-list">' + items.map(function (i) {
        return '<li><a href="' + esc(i.url) + '" target="_blank" rel="noopener"><span class="lu-tag lu-' + esc(String(i.kind || '').toLowerCase()) + '">' + esc(i.kind || 'Update') + '</span><b>' + esc(i.title) + '</b>' + (i.summary ? '<small>' + esc(i.summary) + '</small>' : '') + '<em>GOV.UK · ' + esc(day(i.published || i.seen_at)) + ' ↗</em></a></li>';
      }).join('') + '</ul>' : '<p class="sub">The latest updates are being collected — please check back shortly.</p>') +
      '</div><aside class="lu-side" id="alerts">' + signupForm('laForm') + '<div class="lu-help"><b>Not sure what a change means for you?</b><p>Our team can explain it and make sure your property stays compliant.</p><a class="btn line" href="tel:02070968131">📞 0207 096 8131</a></div></aside></div></section>';
    opts.send(req, res, { name: 'landlord-updates', stamp: String(items.length) + (latestDay || ''), canon: '/landlord-updates', crumb: 'Landlord updates', title: 'Landlord Updates & Alerts: Latest Rules for Landlords in England | Residential Realtors',
      desc: 'The latest changes for landlords in England — Renters’ Rights Act, licensing, EPCs, deposits — updated automatically from GOV.UK, with free email alerts.', img: 'u-westminster' }, body);
  });
  return { form: signupForm };
};
