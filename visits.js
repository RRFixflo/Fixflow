// Website visitors, counted on our own server: which pages people look at, where they came from
// (Google, Rightmove…), on what device and roughly where. No cookies and no tracking scripts —
// a visitor is a daily-changing code (from their connection and browser). The IP address is kept for
// 30 days only, so the office can tell its own visits from real ones (and stop counting its own).
// Staff signed in to Fixflow, the office's own addresses and bots aren't counted. Kept for 13 months.
const crypto = require('crypto');

module.exports = function (app, opts) {
  const BOT = /bot\b|bot\/|spider|crawl|slurp|curl|wget|python|httpx|aiohttp|go-http|java\/|okhttp|axios|node-fetch|undici|libwww|scrapy|headless|phantom|selenium|puppeteer|playwright|lighthouse|pagespeed|gtmetrix|pingdom|uptime|monitor|preview|facebookexternalhit|whatsapp|telegram|slack|discord|skype|linkedinbot|embedly|quora|pinterest|gpt|openai|anthropic|claude|perplexity|bytespider|ccbot|petalbot|semrush|ahrefs|mj12|dotbot|yandex|baidu|seznam/i;
  const SALT = crypto.createHash('sha256').update('visits|' + (process.env.ADMIN_PASSWORD || '') + '|' + (process.env.DATABASE_URL || crypto.randomBytes(16).toString('hex'))).digest('hex');
  let ready = null, queue = [], ignore = [], names = {};   // ignore: our own IP addresses (not counted); names: IP → a name staff gave it
  const ipOf = function (req) { return String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim().replace(/^::ffff:/, '').slice(0, 64); };
  // Home broadband on IPv6 keeps the first half of the address and changes the rest every day or so,
  // so names and "don't count" match on that first half (the /64). IPv4 addresses match exactly.
  const ipKey = function (ip) {
    ip = String(ip || '').trim().toLowerCase(); if (ip.indexOf(':') === -1) return ip;
    const parts = ip.split('::'), a = parts[0] ? parts[0].split(':') : [], b = parts.length > 1 && parts[1] ? parts[1].split(':') : [];
    const full = a.concat(new Array(Math.max(0, 8 - a.length - b.length)).fill('0'), b);
    return full.slice(0, 4).map(function (h) { return (parseInt(h, 16) || 0).toString(16); }).join(':') + '::/64';
  };
  async function loadIgnore() { const p = await pool().catch(function () { return null; }); if (!p) return; const r = (await p.query("SELECT value FROM app_settings WHERE key = 'web_ignore_ips'").catch(function () { return { rows: [] }; })).rows[0]; ignore = (r && r.value && r.value.ips) || [];
    const n = (await p.query("SELECT value FROM app_settings WHERE key = 'web_ip_names'").catch(function () { return { rows: [] }; })).rows[0]; names = (n && n.value && n.value.names) || {}; }
  setTimeout(function () { loadIgnore().catch(function () {}); }, 5000);
  async function pool() {
    const p = await opts.db(); if (!p) return null;
    if (!ready) ready = p.query(`CREATE TABLE IF NOT EXISTS web_visits (
        id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now(), path TEXT NOT NULL, title TEXT,
        ref TEXT, device TEXT, country TEXT, visitor TEXT);
      CREATE INDEX IF NOT EXISTS web_visits_at ON web_visits (at);
      ALTER TABLE web_visits ADD COLUMN IF NOT EXISTS ip TEXT;`).catch(function (e) { ready = null; throw e; });
    await ready; return p;
  }
  // Where a visit came from: another website's name, or a campaign tag (?utm_source=…).
  function source(req) {
    const utm = String(req.query.utm_source || '').trim().toLowerCase().slice(0, 40); if (utm) return utm;
    let h = ''; try { h = new URL(String(req.headers.referer || '')).hostname.toLowerCase(); } catch (e) { return ''; }
    const own = String(req.headers.host || '').toLowerCase().split(':')[0];
    if (!h || h === own || /(^|\.)residentialrealtors\.co\.uk$/.test(h)) return '';
    return h.replace(/^(www|m|l|lm|android-app)\./, '');
  }
  function track(req, title) {
    try {
      if (req.method !== 'GET') return;
      const ua = String(req.headers['user-agent'] || '');
      if (!ua || BOT.test(ua) || /prefetch|prerender/i.test(String(req.headers.purpose || req.headers['sec-purpose'] || ''))) return;
      if (opts.isStaff && opts.isStaff(req)) return;   // our own team browsing the site
      const ip = ipOf(req);
      if (ignore.some(function (x) { return ipKey(x.ip) === ipKey(ip); })) return;   // the office's own address
      const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
      queue.push({ path: String(req.path || '/').slice(0, 300), title: String(title || '').slice(0, 200), ref: source(req) || null,
        device: /ipad|tablet|kindle|silk/i.test(ua) ? 'Tablet' : /mobi|iphone|android/i.test(ua) ? 'Phone' : 'Computer',
        country: String(req.headers['cf-ipcountry'] || '').toUpperCase().slice(0, 2) || null,
        visitor: crypto.createHash('sha256').update(SALT + '|' + day + '|' + ip + '|' + ua).digest('hex').slice(0, 16), ip: ip || null });
      if (queue.length > 5000) queue = queue.slice(-5000);
    } catch (e) {}
  }
  async function flush() {
    if (!queue.length) return;
    const p = await pool().catch(function () { return null; }); if (!p) return;
    const rows = queue.splice(0, 500), vals = [], ph = [];
    rows.forEach(function (r, i) { const b = i * 7; ph.push('($' + (b + 1) + ',$' + (b + 2) + ',$' + (b + 3) + ',$' + (b + 4) + ',$' + (b + 5) + ',$' + (b + 6) + ',$' + (b + 7) + ')'); vals.push(r.path, r.title, r.ref, r.device, r.country, r.visitor, r.ip); });
    await p.query('INSERT INTO web_visits (path, title, ref, device, country, visitor, ip) VALUES ' + ph.join(','), vals).catch(function (e) { console.error('Visitor log not saved:', e.message); });
  }
  setInterval(function () { flush().catch(function () {}); }, 10000).unref();
  setInterval(function () { pool().then(function (p) { return p && p.query("DELETE FROM web_visits WHERE at < now() - interval '13 months'").then(function () { return p.query("UPDATE web_visits SET ip = NULL WHERE ip IS NOT NULL AND at < now() - interval '30 days'"); }); }).catch(function () {}); }, 24 * 3600000).unref();

  // Sources grouped into names people recognise.
  const SRC = [[/google/, 'Google'], [/bing/, 'Bing'], [/yahoo|duckduckgo|ecosia/, 'Other search'], [/rightmove/, 'Rightmove'], [/zoopla/, 'Zoopla'], [/onthemarket/, 'OnTheMarket'],
    [/facebook|fb\.|instagram|meta/, 'Facebook / Instagram'], [/tiktok/, 'TikTok'], [/whatsapp|wa\.me/, 'WhatsApp'], [/t\.co|twitter|x\.com/, 'X / Twitter'], [/linkedin/, 'LinkedIn'], [/youtube/, 'YouTube'],
    [/gnomen/, 'Gnomen'], [/mail|outlook|gmail/, 'Email']];
  const srcName = function (r) { if (!r) return 'Direct (typed or bookmarked)'; for (const s of SRC) if (s[0].test(r)) return s[1]; return r; };

  app.get('/api/admin/site-stats', async function (req, res) {
    if (!(opts.isStaff && opts.isStaff(req))) return res.status(401).json({ ok: false });
    if (req.role === 'offers' && !(req.user && req.user.role === 'offers_admin')) return res.status(403).json({ ok: false, error: 'managers-only' });
    const p = await pool().catch(function () { return null; }); if (!p) return res.status(503).json({ ok: false, error: 'db' });
    await flush().catch(function () {}); await loadIgnore().catch(function () {});
    const days = [1, 7, 30, 90, 365].indexOf(+req.query.days) !== -1 ? +req.query.days : 7;
    // "Today" starts at midnight London time; longer ranges include today.
    const since = "date_trunc('day', now() AT TIME ZONE 'Europe/London') AT TIME ZONE 'Europe/London' - interval '" + (days - 1) + " days'";
    const prevSince = since + " - interval '" + days + " days'";
    const q = function (sql) { return p.query(sql).then(function (r) { return r.rows; }); };
    let recent = [];
    const [tot, prev, byDay, pages, props, refs, devices, countries, live] = await Promise.all([
      q('SELECT count(*)::int AS views, count(DISTINCT visitor)::int AS visitors FROM web_visits WHERE at >= ' + since),
      q('SELECT count(*)::int AS views, count(DISTINCT visitor)::int AS visitors FROM web_visits WHERE at >= ' + prevSince + ' AND at < ' + since),
      q("SELECT to_char(at AT TIME ZONE 'Europe/London', " + (days === 1 ? "'HH24'" : "'YYYY-MM-DD'") + ") AS k, count(*)::int AS views, count(DISTINCT visitor)::int AS visitors FROM web_visits WHERE at >= " + since + ' GROUP BY 1 ORDER BY 1'),
      q("SELECT path, max(title) AS title, count(*)::int AS views, count(DISTINCT visitor)::int AS visitors FROM web_visits WHERE at >= " + since + " AND path NOT LIKE '/property/%' GROUP BY path ORDER BY views DESC LIMIT 25"),
      q("SELECT split_part(path, '/', 3) AS id, max(title) AS title, max(path) AS path, count(*)::int AS views, count(DISTINCT visitor)::int AS visitors FROM web_visits WHERE at >= " + since + " AND path LIKE '/property/%' GROUP BY 1 ORDER BY views DESC LIMIT 25"),
      q('SELECT ref, count(DISTINCT visitor)::int AS visitors FROM web_visits WHERE at >= ' + since + ' GROUP BY ref'),
      q('SELECT device AS k, count(DISTINCT visitor)::int AS visitors FROM web_visits WHERE at >= ' + since + ' GROUP BY 1 ORDER BY 2 DESC'),
      q('SELECT coalesce(country, \'\') AS k, count(DISTINCT visitor)::int AS visitors FROM web_visits WHERE at >= ' + since + ' GROUP BY 1 ORDER BY 2 DESC LIMIT 8'),
      q("SELECT DISTINCT ON (visitor) visitor, path, title, device, ip, at FROM web_visits WHERE at >= now() - interval '5 minutes' ORDER BY visitor, at DESC"),
      q("SELECT at, path, title, ref, device, country, ip FROM web_visits ORDER BY id DESC LIMIT 60")
    ]).then(function (r) { recent = r.pop(); return r; });
    const namedIps = Object.keys(names);
    const keyOf = {}; namedIps.forEach(function (ip) { keyOf[ipKey(ip)] = ip; });
    const seenBy = {};
    if (namedIps.length) (await p.query('SELECT ip, max(at) AS last, count(*) FILTER (WHERE at >= ' + since + ')::int AS views FROM web_visits WHERE ip IS NOT NULL GROUP BY ip').then(function (x) { return x.rows; }).catch(function () { return []; }))
      .forEach(function (r) { const k = ipKey(r.ip); if (!keyOf[k]) return; const o = seenBy[k] || (seenBy[k] = { last: null, views: 0 }); o.views += r.views; if (!o.last || new Date(r.last) > new Date(o.last)) o.last = r.last; });
    const named = namedIps.map(function (ip) { const s = seenBy[ipKey(ip)] || {}; return { ip: ip, key: ipKey(ip), name: names[ip].name, last: s.last || null, views: s.views || 0 }; })
      .sort(function (a, b) { return (b.last ? new Date(b.last) : 0) - (a.last ? new Date(a.last) : 0); });
    const src = {}; refs.forEach(function (r) { const n = srcName(r.ref); src[n] = (src[n] || 0) + r.visitors; });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, days: days, totals: tot[0], previous: prev[0], series: byDay, pages: pages, properties: props,
      sources: Object.keys(src).map(function (k) { return { k: k, visitors: src[k] }; }).sort(function (a, b) { return b.visitors - a.visitors; }),
      devices: devices, countries: countries, live: live.map(function (l) { return { path: l.path, title: l.title, device: l.device, ip: l.ip, key: l.ip ? ipKey(l.ip) : '', at: l.at }; }),
      me: ipOf(req), meKey: ipKey(ipOf(req)), ignore: ignore.map(function (x) { return Object.assign({ key: ipKey(x.ip) }, x); }), names: named, recent: recent.map(function (r) { return { at: r.at, path: r.path, title: r.title, source: srcName(r.ref), device: r.device, country: r.country, ip: r.ip, key: r.ip ? ipKey(r.ip) : '' }; }) });
  });
  // Don't count visits from an address (the office, home) — or count them again.
  app.post('/api/admin/site-ignore', async function (req, res) {
    if (!(opts.isStaff && opts.isStaff(req))) return res.status(401).json({ ok: false });
    if (req.role === 'offers' && !(req.user && req.user.role === 'offers_admin')) return res.status(403).json({ ok: false, error: 'managers-only' });
    const b = req.body || {}, ip = String(b.ip || '').trim().slice(0, 64);
    if (!/^[0-9a-f.:]{3,64}$/i.test(ip)) return res.status(400).json({ ok: false, error: 'ip' });
    const p = await pool().catch(function () { return null; }); if (!p) return res.status(503).json({ ok: false });
    await loadIgnore();
    let list = ignore.filter(function (x) { return ipKey(x.ip) !== ipKey(ip); });
    if (!b.remove) { list.push({ ip: ip, label: String(b.label || '').trim().slice(0, 60) || 'Our address', by: req.user ? req.user.name : 'Office', at: new Date().toISOString() }); if (b.purge) { const all = (await p.query('SELECT DISTINCT ip FROM web_visits WHERE ip IS NOT NULL')).rows.map(function (r) { return r.ip; }).filter(function (x) { return ipKey(x) === ipKey(ip); }); if (all.length) await p.query('DELETE FROM web_visits WHERE ip = ANY($1)', [all]); } }
    await p.query("INSERT INTO app_settings (key, value) VALUES ('web_ignore_ips', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [JSON.stringify({ ips: list.slice(-50) })]);
    ignore = list.slice(-50);
    res.json({ ok: true, ignore: ignore });
  });

  // Give a visitor's IP address a name (e.g. "Mr Smith – landlord", "Office phone") so it's always recognised.
  app.post('/api/admin/site-name', async function (req, res) {
    if (!(opts.isStaff && opts.isStaff(req))) return res.status(401).json({ ok: false });
    if (req.role === 'offers' && !(req.user && req.user.role === 'offers_admin')) return res.status(403).json({ ok: false, error: 'managers-only' });
    const b = req.body || {}, ip = String(b.ip || '').trim().slice(0, 64), name = String(b.name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!/^[0-9a-f.:]{3,64}$/i.test(ip)) return res.status(400).json({ ok: false, error: 'ip' });
    const p = await pool().catch(function () { return null; }); if (!p) return res.status(503).json({ ok: false });
    await loadIgnore();
    const next = Object.assign({}, names);
    Object.keys(next).forEach(function (k) { if (ipKey(k) === ipKey(ip)) delete next[k]; });
    if (name) next[ip] = { name: name, by: req.user ? req.user.name : 'Office', at: new Date().toISOString() }; else delete next[ip];
    const keys = Object.keys(next); if (keys.length > 300) keys.slice(0, keys.length - 300).forEach(function (k) { delete next[k]; });
    await p.query("INSERT INTO app_settings (key, value) VALUES ('web_ip_names', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [JSON.stringify({ names: next })]);
    names = next;
    res.json({ ok: true });
  });

  return { track: track };
};
