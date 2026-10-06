// Website visitors, counted on our own server: which pages people look at, where they came from
// (Google, Rightmove…), on what device and roughly where. No cookies and no tracking scripts —
// a visitor is a daily-changing anonymous code (from their connection and browser), never stored
// as an IP address. Staff and bots aren't counted. Kept for 13 months.
const crypto = require('crypto');

module.exports = function (app, opts) {
  const BOT = /bot\b|bot\/|spider|crawl|slurp|curl|wget|python|httpx|aiohttp|go-http|java\/|okhttp|axios|node-fetch|undici|libwww|scrapy|headless|phantom|selenium|puppeteer|playwright|lighthouse|pagespeed|gtmetrix|pingdom|uptime|monitor|preview|facebookexternalhit|whatsapp|telegram|slack|discord|skype|linkedinbot|embedly|quora|pinterest|gpt|openai|anthropic|claude|perplexity|bytespider|ccbot|petalbot|semrush|ahrefs|mj12|dotbot|yandex|baidu|seznam/i;
  const SALT = crypto.createHash('sha256').update('visits|' + (process.env.ADMIN_PASSWORD || '') + '|' + (process.env.DATABASE_URL || crypto.randomBytes(16).toString('hex'))).digest('hex');
  let ready = null, queue = [];
  async function pool() {
    const p = await opts.db(); if (!p) return null;
    if (!ready) ready = p.query(`CREATE TABLE IF NOT EXISTS web_visits (
        id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now(), path TEXT NOT NULL, title TEXT,
        ref TEXT, device TEXT, country TEXT, visitor TEXT);
      CREATE INDEX IF NOT EXISTS web_visits_at ON web_visits (at);`).catch(function (e) { ready = null; throw e; });
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
      const ip = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
      const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
      queue.push({ path: String(req.path || '/').slice(0, 300), title: String(title || '').slice(0, 200), ref: source(req) || null,
        device: /ipad|tablet|kindle|silk/i.test(ua) ? 'Tablet' : /mobi|iphone|android/i.test(ua) ? 'Phone' : 'Computer',
        country: String(req.headers['cf-ipcountry'] || '').toUpperCase().slice(0, 2) || null,
        visitor: crypto.createHash('sha256').update(SALT + '|' + day + '|' + ip + '|' + ua).digest('hex').slice(0, 16) });
      if (queue.length > 5000) queue = queue.slice(-5000);
    } catch (e) {}
  }
  async function flush() {
    if (!queue.length) return;
    const p = await pool().catch(function () { return null; }); if (!p) return;
    const rows = queue.splice(0, 500), vals = [], ph = [];
    rows.forEach(function (r, i) { const b = i * 6; ph.push('($' + (b + 1) + ',$' + (b + 2) + ',$' + (b + 3) + ',$' + (b + 4) + ',$' + (b + 5) + ',$' + (b + 6) + ')'); vals.push(r.path, r.title, r.ref, r.device, r.country, r.visitor); });
    await p.query('INSERT INTO web_visits (path, title, ref, device, country, visitor) VALUES ' + ph.join(','), vals).catch(function (e) { console.error('Visitor log not saved:', e.message); });
  }
  setInterval(function () { flush().catch(function () {}); }, 10000).unref();
  setInterval(function () { pool().then(function (p) { return p && p.query("DELETE FROM web_visits WHERE at < now() - interval '13 months'"); }).catch(function () {}); }, 24 * 3600000).unref();

  // Sources grouped into names people recognise.
  const SRC = [[/google/, 'Google'], [/bing/, 'Bing'], [/yahoo|duckduckgo|ecosia/, 'Other search'], [/rightmove/, 'Rightmove'], [/zoopla/, 'Zoopla'], [/onthemarket/, 'OnTheMarket'],
    [/facebook|fb\.|instagram|meta/, 'Facebook / Instagram'], [/tiktok/, 'TikTok'], [/whatsapp|wa\.me/, 'WhatsApp'], [/t\.co|twitter|x\.com/, 'X / Twitter'], [/linkedin/, 'LinkedIn'], [/youtube/, 'YouTube'],
    [/gnomen/, 'Gnomen'], [/mail|outlook|gmail/, 'Email']];
  const srcName = function (r) { if (!r) return 'Direct (typed or bookmarked)'; for (const s of SRC) if (s[0].test(r)) return s[1]; return r; };

  app.get('/api/admin/site-stats', async function (req, res) {
    if (!(opts.isStaff && opts.isStaff(req))) return res.status(401).json({ ok: false });
    if (req.role === 'offers' && !(req.user && req.user.role === 'offers_admin')) return res.status(403).json({ ok: false, error: 'managers-only' });
    const p = await pool().catch(function () { return null; }); if (!p) return res.status(503).json({ ok: false, error: 'db' });
    await flush().catch(function () {});
    const days = [1, 7, 30, 90, 365].indexOf(+req.query.days) !== -1 ? +req.query.days : 7;
    // "Today" starts at midnight London time; longer ranges include today.
    const since = "date_trunc('day', now() AT TIME ZONE 'Europe/London') AT TIME ZONE 'Europe/London' - interval '" + (days - 1) + " days'";
    const prevSince = since + " - interval '" + days + " days'";
    const q = function (sql) { return p.query(sql).then(function (r) { return r.rows; }); };
    const [tot, prev, byDay, pages, props, refs, devices, countries, live] = await Promise.all([
      q('SELECT count(*)::int AS views, count(DISTINCT visitor)::int AS visitors FROM web_visits WHERE at >= ' + since),
      q('SELECT count(*)::int AS views, count(DISTINCT visitor)::int AS visitors FROM web_visits WHERE at >= ' + prevSince + ' AND at < ' + since),
      q("SELECT to_char(at AT TIME ZONE 'Europe/London', " + (days === 1 ? "'HH24'" : "'YYYY-MM-DD'") + ") AS k, count(*)::int AS views, count(DISTINCT visitor)::int AS visitors FROM web_visits WHERE at >= " + since + ' GROUP BY 1 ORDER BY 1'),
      q("SELECT path, max(title) AS title, count(*)::int AS views, count(DISTINCT visitor)::int AS visitors FROM web_visits WHERE at >= " + since + " AND path NOT LIKE '/property/%' GROUP BY path ORDER BY views DESC LIMIT 25"),
      q("SELECT split_part(path, '/', 3) AS id, max(title) AS title, max(path) AS path, count(*)::int AS views, count(DISTINCT visitor)::int AS visitors FROM web_visits WHERE at >= " + since + " AND path LIKE '/property/%' GROUP BY 1 ORDER BY views DESC LIMIT 25"),
      q('SELECT ref, count(DISTINCT visitor)::int AS visitors FROM web_visits WHERE at >= ' + since + ' GROUP BY ref'),
      q('SELECT device AS k, count(DISTINCT visitor)::int AS visitors FROM web_visits WHERE at >= ' + since + ' GROUP BY 1 ORDER BY 2 DESC'),
      q('SELECT coalesce(country, \'\') AS k, count(DISTINCT visitor)::int AS visitors FROM web_visits WHERE at >= ' + since + ' GROUP BY 1 ORDER BY 2 DESC LIMIT 8'),
      q("SELECT DISTINCT ON (visitor) visitor, path, title, device, at FROM web_visits WHERE at >= now() - interval '5 minutes' ORDER BY visitor, at DESC")
    ]);
    const src = {}; refs.forEach(function (r) { const n = srcName(r.ref); src[n] = (src[n] || 0) + r.visitors; });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, days: days, totals: tot[0], previous: prev[0], series: byDay, pages: pages, properties: props,
      sources: Object.keys(src).map(function (k) { return { k: k, visitors: src[k] }; }).sort(function (a, b) { return b.visitors - a.visitors; }),
      devices: devices, countries: countries, live: live.map(function (l) { return { path: l.path, title: l.title, device: l.device, at: l.at }; }) });
  });

  return { track: track };
};
