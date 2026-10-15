// SEO on autopilot.
// 1. IndexNow: when a page is new, changed or gone (a property added, re-priced, let or sold; a page's wording
//    changed), Bing and the search engines that share IndexNow (Yandex, Seznam, Naver; Bing also feeds DuckDuckGo
//    and ChatGPT search) are told straight away instead of waiting to crawl. The key file is /<key>.txt.
// 2. Sitemap dates: each address's first-seen and last-changed day, for <lastmod>.
// 3. Weekly health check: every page in the sitemap is fetched from this server and checked (title, description,
//    one h1, canonical, noindex, images without alt text, broken internal links, duplicate titles/descriptions,
//    slow or heavy pages). The report is on the staff app (Website visitors → SEO health) and the office is emailed
//    when new problems appear.
// SEO_AUTO=0 turns the automatic parts off.
const crypto = require('crypto');

module.exports = function (app, opts) {
  const SITE = String(opts.siteUrl).replace(/\/+$/, ''), HOST = new URL(SITE).host, LIVE = !/localhost|127\.0\.0\.1/.test(SITE) && process.env.SEO_AUTO !== '0' && !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);   // only the real site pings / emails
  let state = null, saving = null, checking = false, health = null;
  const day = function () { return new Date().toISOString().slice(0, 10); };
  async function load() {
    if (state) return state;
    const p = await opts.db(); if (!p) return null;
    const r = (await p.query("SELECT key, value FROM app_settings WHERE key IN ('seo', 'seo_health')")).rows;
    const s = (r.filter(function (x) { return x.key === 'seo'; })[0] || {}).value || {};
    health = (r.filter(function (x) { return x.key === 'seo_health'; })[0] || {}).value || null;
    if (!s.key) s.key = crypto.randomBytes(16).toString('hex');
    s.seen = s.seen || {}; s.log = s.log || [];
    state = s; return s;
  }
  function save(key, val) {
    saving = Promise.resolve(saving).then(async function () { const p = await opts.db(); if (p) await p.query('INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()', [key, JSON.stringify(val)]); }).catch(function (e) { console.error('SEO save failed:', e.message); });
    return saving;
  }
  load().catch(function () {});

  // The key file IndexNow fetches to check the pings are really ours.
  app.get('/:k([a-f0-9]{32}).txt', async function (req, res, next) {
    const s = await load().catch(function () { return null; });
    if (!s || req.params.k !== s.key) return next();
    res.type('text/plain').send(s.key);
  });

  // <lastmod> for the sitemap (the day the address was last seen to change).
  function lastmod(path) { const x = state && state.seen[path]; return x ? x[2] || x[1] : null; }

  // Compare what's on the site now with what we saw last time; tell IndexNow about the differences.
  // sigs: { path: signature } — listings give price/status/photos; other pages get their text hash from the health check.
  async function sync(why) {
    const s = await load(); if (!s) return;
    const now = opts.urls(), sigs = opts.sigs ? opts.sigs() : {}, today = day(), changed = [], first = !s.synced;
    now.forEach(function (u) {
      const old = s.seen[u], sig = sigs[u] || (old ? old[0] : 'page');
      if (!old) { s.seen[u] = [sig, today, today]; changed.push(u); }
      else if (sigs[u] && old[0] !== sig) { old[0] = sig; old[2] = today; changed.push(u); }
    });
    const live = {}; now.forEach(function (u) { live[u] = 1; });
    Object.keys(s.seen).forEach(function (u) { if (!live[u]) { delete s.seen[u]; changed.push(u); } });   // gone: IndexNow re-checks it (404/301)
    s.synced = new Date().toISOString();
    if (changed.length) await submit(first ? now : changed, why || (first ? 'first look' : 'changes'));
    await save('seo', s);
  }
  async function submit(paths, why) {
    const s = state; if (!paths.length) return;
    const entry = { at: new Date().toISOString(), n: paths.length, why: why, sample: paths.slice(0, 5) };
    if (!LIVE) { entry.skipped = 'not the live site'; }
    else {
      try {
        for (let i = 0; i < paths.length; i += 9000) {
          const r = await fetch('https://api.indexnow.org/indexnow', { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, signal: AbortSignal.timeout(20000),
            body: JSON.stringify({ host: HOST, key: s.key, keyLocation: SITE + '/' + s.key + '.txt', urlList: paths.slice(i, i + 9000).map(function (p) { return SITE + p; }) }) });
          entry.status = r.status;
        }
        console.log('IndexNow: told search engines about ' + paths.length + ' address' + (paths.length === 1 ? '' : 'es') + ' (' + why + ') — answer ' + entry.status);
      } catch (e) { entry.error = e.message; console.log('IndexNow failed: ' + e.message); }
    }
    s.log.unshift(entry); s.log = s.log.slice(0, 30);
  }

  // ---------- Weekly health check ----------
  const pick = function (re, h) { const m = re.exec(h); return m ? m[1].replace(/\s+/g, ' ').trim() : ''; };
  const decode = function (t) { return String(t || '').replace(/&amp;/g, '&').replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>'); };
  // (Node's fetch drops the Host header, so a plain request — the site answers as it does for visitors.)
  function getLocal(path) {
    const t0 = Date.now();
    return new Promise(function (ok, fail) {
      const rq = require('http').get({ host: '127.0.0.1', port: opts.port, path: path, headers: { Host: HOST, 'X-Forwarded-Proto': 'https', 'User-Agent': 'Fixflow SEO check', Accept: 'text/html' }, timeout: 30000 }, function (r) {
        const html = String(r.headers['content-type'] || '').indexOf('html') !== -1, chunks = [];
        r.on('data', function (c) { if (html) chunks.push(c); });
        r.on('end', function () { ok({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8'), ms: Date.now() - t0, location: r.headers.location || '' }); });
      });
      rq.on('timeout', function () { rq.destroy(new Error('timed out')); }); rq.on('error', fail);
    });
  }
  async function check() {
    if (checking) return { busy: true }; checking = true;
    const t0 = Date.now(), pages = opts.urls(), out = [], titles = {}, descs = {}, links = {}, s = await load();
    try {
      const queue = pages.slice();
      const worker = async function () {
        while (queue.length) {
          const path = queue.shift(), row = { path: path, issues: [] };
          try {
            const r = await getLocal(path), h = r.body;
            row.status = r.status; row.ms = r.ms; row.kb = Math.round(h.length / 1024);
            if (r.status >= 300) { row.issues.push([r.status >= 400 ? 'error' : 'warn', r.status >= 400 ? 'Page answers ' + r.status : 'Redirects (' + r.status + ') to ' + r.location + ' — the sitemap should list the final address']); out.push(row); continue; }
            const head = h.slice(0, h.indexOf('</head>') + 1 || 20000);
            const title = decode(pick(/<title>([\s\S]*?)<\/title>/i, head)), desc = decode(pick(/<meta name="description" content="([^"]*)"/i, head));
            const canon = pick(/<link rel="canonical" href="([^"]*)"/i, head), robots = pick(/<meta name="robots" content="([^"]*)"/i, head);
            const h1s = (h.match(/<h1[\s>]/gi) || []).length, imgs = h.match(/<img\b[^>]*>/gi) || [];
            const noAlt = imgs.filter(function (t) { return !/\balt=/i.test(t); }).length;   // alt="" is right for decorative pictures
            row.title = title; row.desc = desc;
            if (!title) row.issues.push(['error', 'No page title']); else if (title.length > 65) row.issues.push(['warn', 'Title is long (' + title.length + ' characters) — Google cuts it off after about 60']); else if (title.length < 15) row.issues.push(['warn', 'Title is very short']);
            if (!desc) row.issues.push(['error', 'No description for Google']); else if (desc.length > 170) row.issues.push(['warn', 'Description is long (' + desc.length + ') — about 155 shows']); else if (desc.length < 50) row.issues.push(['warn', 'Description is short (' + desc.length + ')']);
            if (!canon) row.issues.push(['warn', 'No canonical address']); else if (canon.replace(/\/$/, '') !== (SITE + path).replace(/\/$/, '')) row.issues.push(['warn', 'Canonical points elsewhere: ' + canon.replace(SITE, '')]);
            if (/noindex/i.test(robots)) row.issues.push(['error', 'Hidden from Google (noindex) but listed in the sitemap']);
            if (!h1s) row.issues.push(['warn', 'No main heading (h1)']); else if (h1s > 1) row.issues.push(['info', h1s + ' main headings (h1) — one is best']);
            if (noAlt) row.issues.push(['info', noAlt + ' image' + (noAlt === 1 ? '' : 's') + ' without a description (alt text)']);
            if (r.ms > 2500) row.issues.push(['warn', 'Slow: ' + (r.ms / 1000).toFixed(1) + 's to build']);
            if (h.length > 600 * 1024) row.issues.push(['info', 'Heavy page: ' + row.kb + ' KB of HTML']);
            if (title) (titles[title] = titles[title] || []).push(path);
            if (desc) (descs[desc] = descs[desc] || []).push(path);
            // Internal links (checked once each below).
            (h.replace(/<script[\s\S]*?<\/script>/gi, '').match(/href="(\/[^"#?']*)"/g) || []).forEach(function (m) { const u = m.slice(6, -1); if (!/^\/(api|admin|staff|cdn-cgi)\b|\.(css|js|png|jpe?g|webp|svg|ico|pdf|xml|txt)$/i.test(u)) (links[u] = links[u] || []).push(path); });
            // The page's words, so a wording change counts as a change for IndexNow / lastmod.
            const text = h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
            row.sig = crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
          } catch (e) { row.status = 0; row.issues.push(['error', 'Could not load: ' + e.message]); }
          out.push(row);
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      // Duplicates across pages.
      const byPath = {}; out.forEach(function (r) { byPath[r.path] = r; });
      Object.keys(titles).forEach(function (t) { if (titles[t].length > 1) titles[t].forEach(function (p) { byPath[p].issues.push(['warn', 'Same title as ' + (titles[t].length - 1) + ' other page' + (titles[t].length > 2 ? 's' : '') + ' (e.g. ' + titles[t].filter(function (x) { return x !== p; })[0] + ')']); }); });
      Object.keys(descs).forEach(function (d) { if (descs[d].length > 1) descs[d].forEach(function (p) { byPath[p].issues.push(['info', 'Same description as ' + (descs[d].length - 1) + ' other page' + (descs[d].length > 2 ? 's' : '')]); }); });
      // Broken internal links (pages not in the sitemap get one request each).
      const known = {}; pages.forEach(function (p) { known[p] = 1; }); const broken = [];
      const toCheck = Object.keys(links).filter(function (u) { return !known[u]; }).slice(0, 400);
      const q2 = toCheck.slice(), lw = async function () { while (q2.length) { const u = q2.shift(); try { const r = await getLocal(u); if (r.status >= 400) broken.push([u, r.status]); } catch (e) { broken.push([u, 0]); } } };
      await Promise.all([lw(), lw(), lw()]);
      broken.forEach(function (b) { links[b[0]].slice(0, 20).forEach(function (p) { if (byPath[p]) byPath[p].issues.push(['error', 'Broken link to ' + b[0] + ' (' + (b[1] || 'no answer') + ')']); }); });
      // Content changes → lastmod / IndexNow.
      const changed = [], today = day();
      out.forEach(function (r) { const x = s.seen[r.path]; if (!r.sig || !x) return; if (x[0] === 'page') x[0] = r.sig; else if (!/^L:/.test(x[0]) && x[0] !== r.sig) { x[0] = r.sig; x[2] = today; changed.push(r.path); } });
      if (changed.length) await submit(changed, 'wording changed');
      await save('seo', s);
      const count = function (lvl) { return out.reduce(function (n, r) { return n + r.issues.filter(function (i) { return i[0] === lvl; }).length; }, 0); };
      const prevErr = {}; ((health && health.pages) || []).forEach(function (r) { r.issues.forEach(function (i) { if (i[0] === 'error') prevErr[r.path + '|' + i[1]] = 1; }); });
      const newErr = []; out.forEach(function (r) { r.issues.forEach(function (i) { if (i[0] === 'error' && !prevErr[r.path + '|' + i[1]]) newErr.push(r.path + ' — ' + i[1]); }); });
      const score = Math.max(0, Math.round(100 - (count('error') * 5 + count('warn')) * 100 / Math.max(1, out.length * 2)));
      health = { at: new Date().toISOString(), secs: Math.round((Date.now() - t0) / 1000), pages: out.filter(function (r) { return r.issues.length; }).map(function (r) { return { path: r.path, status: r.status, title: r.title, issues: r.issues }; }),
        total: out.length, ok: out.filter(function (r) { return !r.issues.length; }).length, errors: count('error'), warnings: count('warn'), info: count('info'), score: score, changed: changed.length };
      await save('seo_health', health);
      console.log('SEO check: ' + out.length + ' pages, score ' + score + ', ' + health.errors + ' errors, ' + health.warnings + ' warnings, ' + changed.length + ' changed (' + health.secs + 's)');
      if (newErr.length && LIVE && opts.sendMail) {
        const text = 'The weekly website check found ' + newErr.length + ' new problem' + (newErr.length === 1 ? '' : 's') + ':\n\n' + newErr.slice(0, 40).map(function (l) { return '• ' + l; }).join('\n') + (newErr.length > 40 ? '\n…and ' + (newErr.length - 40) + ' more.' : '') +
          '\n\nSee them all in Fixflow → Website visitors → SEO health. Website score: ' + score + '/100.';
        opts.sendMail({ to: ['info@residentialrealtors.co.uk'], subject: 'Website check: ' + newErr.length + ' new problem' + (newErr.length === 1 ? '' : 's'), text: text }).catch(function () {});
      }
      return health;
    } finally { checking = false; }
  }

  // Schedules: listings changes hourly (and a few minutes after start-up); the full check weekly (Sunday ~3am).
  setTimeout(function () { sync('start-up').catch(function (e) { console.error('SEO sync:', e.message); }); }, 3 * 60000).unref();
  setInterval(function () { sync().catch(function (e) { console.error('SEO sync:', e.message); }); }, 60 * 60000).unref();
  setInterval(function () {
    const d = new Date(), h = Number(d.toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hour12: false })), wd = d.toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'short' });
    if (process.env.SEO_AUTO === '0' || checking || h !== 3) return;
    if (health && Date.now() - Date.parse(health.at) < 6 * 86400000 && wd !== 'Sun') return;
    if (health && Date.now() - Date.parse(health.at) < 20 * 3600000) return;
    check().catch(function (e) { console.error('SEO check:', e.message); });
  }, 20 * 60000).unref();
  // First check ~10 minutes after the very first start (no report yet).
  setTimeout(function () { load().then(function () { if (!health && process.env.SEO_AUTO !== '0') return check(); }).catch(function (e) { console.error('SEO check:', e.message); }); }, 10 * 60000).unref();

  // Staff app (managers): the report, IndexNow log, and "check now".
  app.get('/api/admin/seo', async function (req, res) {
    if (!opts.isStaff(req) || !opts.canManage(req)) return res.status(403).json({ ok: false });
    const s = await load(); if (!s) return res.json({ ok: false });
    res.json({ ok: true, health: health, checking: checking, indexnow: { key: s.key, live: LIVE, log: s.log.slice(0, 12), tracked: Object.keys(s.seen).length, synced: s.synced } });
  });
  app.post('/api/admin/seo/check', function (req, res) {
    if (!opts.isStaff(req) || !opts.canManage(req)) return res.status(403).json({ ok: false });
    if (checking) return res.json({ ok: true, running: true });
    check().catch(function (e) { console.error('SEO check:', e.message); }); res.json({ ok: true, started: true });
  });
  return { lastmod: lastmod, sync: sync, check: check };
};
