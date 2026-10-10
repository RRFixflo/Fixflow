// Monthly London rental market update (/market-updates): written automatically once a month from real figures only —
// the ONS rents for London and every borough (areas.js, refreshed weekly) and our own track record (jobs.trackRecord).
// The AI writes the wording from those figures; every £ amount and percentage in its text is checked against them and,
// if any doesn't match, the article is written from a plain template instead. The tables are drawn from the data,
// never by the AI. Published automatically (from the 20th, when the month's ONS figures are out); managers can hide or
// rewrite one from Activity → SEO health. MARKET_AUTO=0 stops the monthly article.
module.exports = function (app, opts) {
  const esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  const gbp = function (n) { return '£' + Math.round(n).toLocaleString('en-GB'); };
  const pct = function (n) { return (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(1) + '%'; };
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const LIVE = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID) && process.env.MARKET_AUTO !== '0';
  let ready = null, cache = [], making = false;
  async function pool() {
    const p = await opts.db(); if (!p) return null;
    if (!ready) ready = p.query(`CREATE TABLE IF NOT EXISTS market_reports (id SERIAL PRIMARY KEY, month TEXT NOT NULL UNIQUE, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, descr TEXT,
      body TEXT NOT NULL, facts JSONB NOT NULL DEFAULT '{}'::jsonb, ai BOOLEAN NOT NULL DEFAULT false, hidden BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`)
      .then(load).catch(function (e) { ready = null; throw e; });
    await ready; return p;
  }
  async function load() { const p = await opts.db(); if (p) cache = (await p.query('SELECT id, month, slug, title, descr, body, facts, ai, hidden, created_at, updated_at FROM market_reports ORDER BY month DESC')).rows; }
  pool().catch(function () {});

  // The figures for this month's article.
  function facts() {
    const ons = opts.figures() || {}, L = ons.london || {}, now = new Date(), month = MONTHS[now.getMonth()] + ' ' + now.getFullYear();
    const list = opts.areas.map(function (a) { const g = (ons.boroughs || {})[a.gss] || {}; return { name: a.name, slug: a.slug, region: a.region, rent: g.rent || null, change: g.rentChange != null ? g.rentChange : null, beds: g.beds || {}, month: g.rentMonth || null }; })
      .filter(function (b) { return b.rent; });
    const byChange = list.filter(function (b) { return b.change != null; }).sort(function (x, y) { return y.change - x.change; });
    const byRent = list.slice().sort(function (x, y) { return y.rent - x.rent; });
    const t = opts.track() || {};
    const regions = {}; list.forEach(function (b) { (regions[b.region] = regions[b.region] || []).push(b.rent); });
    const regionAvg = Object.keys(regions).map(function (r) { const a = regions[r]; return { region: r, avg: Math.round(a.reduce(function (s, x) { return s + x; }, 0) / a.length), n: a.length }; }).sort(function (x, y) { return y.avg - x.avg; });
    const rising = byChange.filter(function (b) { return b.change > 0; }).length, falling = byChange.filter(function (b) { return b.change < 0; }).length;
    return { month: month, key: now.toISOString().slice(0, 7), dataMonth: L.rentMonth || (list[0] && list[0].month) || '', london: { rent: L.rent || null, change: L.rentChange != null ? L.rentChange : null, priceChange: L.priceChange != null ? L.priceChange : null, priceMonth: L.priceMonth || '' },
      risers: byChange.slice(0, 5), fallers: byChange.slice(-5).reverse(), dearest: byRent.slice(0, 5), cheapest: byRent.slice(-5).reverse(), regions: regionAvg,
      counts: { boroughs: list.length, rising: rising, falling: falling },
      track: { days: t.days || null, rentPct: t.rentPct || null, ytd: t.ytd ? t.ytd.n : null, ytdYear: t.ytd ? t.ytd.year : null },
      source: L.source || 'https://www.ons.gov.uk/economy/inflationandpriceindices/bulletins/privaterentandhousepricesuk/latest' };
  }

  // Every number the article may use: the figures as written (2,332 / 2332 / 3.5) and small counts/ranks.
  function allowed(f) {
    const ok = {}, add = function (v) { if (v == null || v === '') return; const n = Number(v); if (!isFinite(n)) return; ok[String(n)] = 1; ok[n.toFixed(1)] = 1; ok[String(Math.abs(n))] = 1; ok[Math.abs(n).toFixed(1)] = 1; ok[String(Math.round(n))] = 1; ok[String(Math.round(Math.abs(n)))] = 1; };
    add(f.london.rent); add(f.london.change); add(f.london.priceChange);
    f.risers.concat(f.fallers, f.dearest, f.cheapest).forEach(function (b) { add(b.rent); add(b.change); ['1', '2', '3', '4'].forEach(function (k) { add(b.beds[k]); }); });
    f.regions.forEach(function (r) { add(r.avg); add(r.n); });
    add(f.counts.boroughs); add(f.counts.rising); add(f.counts.falling); add(f.track.days); add(f.track.rentPct); add(f.track.ytd); add(f.track.ytdYear);
    for (let i = 0; i <= 33; i++) ok[String(i)] = 1;   // counts and ranks ("five boroughs", "33 boroughs")
    return ok;
  }
  function numbersOk(text, ok) {
    const bad = [];
    String(text).replace(/£?\d[\d,]*(?:\.\d+)?%?/g, function (m) {
      const n = m.replace(/[£,%]/g, ''); if (/^(19|20)\d\d$/.test(n)) return m;   // years
      if (!ok[n] && !ok[String(Number(n))] && !ok[Number(n).toFixed(1)]) bad.push(m); return m;
    });
    return bad;
  }

  // Plain, data-only wording (used when the AI isn't available or its text didn't check out).
  function template(f) {
    const L = f.london, r = f.risers[0], fl = f.fallers[0], d = f.dearest[0], c = f.cheapest[0];
    return {
      intro: [(L.rent ? 'The average private rent in London was ' + gbp(L.rent) + ' a month in ' + f.dataMonth + (L.change != null ? ', ' + (L.change >= 0 ? 'up ' : 'down ') + Math.abs(L.change).toFixed(1) + '% on a year earlier' : '') + ', according to the latest ONS figures.' : 'Here are the latest ONS figures for rents across London.'),
        'Rents rose over the year in ' + f.counts.rising + ' of the ' + f.counts.boroughs + ' boroughs with published figures' + (f.counts.falling ? ' and fell in ' + f.counts.falling : '') + '.'],
      analysis: [(r ? r.name + ' saw the biggest annual rise (' + pct(r.change) + '), while ' + (fl && fl.change < 0 ? fl.name + ' saw the largest fall (' + pct(fl.change) + ').' : fl.name + ' saw the smallest change (' + pct(fl.change) + ').') : ''),
        (d && c ? d.name + ' remains the most expensive borough to rent in at ' + gbp(d.rent) + ' a month on average, and ' + c.name + ' the most affordable at ' + gbp(c.rent) + '.' : '')].filter(Boolean),
      landlords: ['Pricing in line with the local market is what lets a home quickly — a home set too high sits empty, and every empty week costs more than a small difference in rent.',
        'Check what similar homes near you are letting for before you advertise, keep your certificates up to date, and make sure the property is clean and well presented for viewings.']
    };
  }
  async function write(f) {
    if (!opts.askAi) return { text: template(f), ai: false };
    const brief = JSON.stringify({ month: f.month, ons_data_month: f.dataMonth, london: f.london, biggest_rises: f.risers.map(function (b) { return [b.name, b.rent, b.change]; }), smallest_rises_or_falls: f.fallers.map(function (b) { return [b.name, b.rent, b.change]; }),
      most_expensive: f.dearest.map(function (b) { return [b.name, b.rent]; }), most_affordable: f.cheapest.map(function (b) { return [b.name, b.rent]; }), region_averages: f.regions, counts: f.counts, our_lettings: f.track });
    const prompt = 'You write the monthly "London rental market update" for Residential Realtors, a London letting agent (SE1), for landlords. Plain, confident British English, no hype, no clichés.\n' +
      'Use ONLY the figures in the data below — never any other number, statistic, forecast or claim (no interest rates, no laws, no predictions with numbers). Money as £1,234, changes as 3.5%. Name the ONS as the source of rents. ' +
      'If our_lettings has figures you may mention them as "our own lettings" (days = typical days to let, rentPct = % of asking rent agreed, ytd = tenancies started this year); skip any that are null.\n' +
      'Reply with ONLY JSON: {"title": "London rental market update — ' + f.month + ': <a short hook from the data>" (max 60 characters in total), "description": "<= 155 characters for Google>", ' +
      '"intro": ["2 short paragraphs: the London picture"], "analysis": ["2-3 short paragraphs: which boroughs and areas are rising, falling, most and least expensive"], "landlords": ["2-3 short paragraphs: what this means for landlords letting now — practical, no numbers unless from the data"]}\n\nDATA:\n' + brief;
    try {
      const r = await opts.askAi(prompt, true); if (!r || !r.ok) throw new Error('no answer');
      const j = JSON.parse(String(r.text).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim());
      const clean = function (a, n) { return (Array.isArray(a) ? a : []).map(function (x) { return String(x || '').trim().slice(0, 900); }).filter(Boolean).slice(0, n); };
      const out = { title: String(j.title || '').slice(0, 90), description: String(j.description || '').slice(0, 170), intro: clean(j.intro, 3), analysis: clean(j.analysis, 4), landlords: clean(j.landlords, 4) };
      if (!out.intro.length || !out.analysis.length || !out.landlords.length) throw new Error('missing parts');
      const bad = numbersOk([out.title, out.description].concat(out.intro, out.analysis, out.landlords).join(' '), allowed(f));
      if (bad.length) { console.log('Market update: AI text used figures not in the data (' + bad.slice(0, 5).join(', ') + ') — using the plain version'); return { text: template(f), ai: false }; }
      return { text: out, ai: true };
    } catch (e) { console.log('Market update: AI not used (' + e.message + ')'); return { text: template(f), ai: false }; }
  }

  // The article's HTML (the AI's paragraphs, our tables).
  function render(f, t) {
    const P = function (a) { return a.map(function (x) { return '<p>' + esc(x) + '</p>'; }).join(''); };
    const tbl = function (rows, withChange) { return '<div class="ar-tw"><table class="ar-tbl"><thead><tr><th scope="col">Borough</th><th scope="col">Average rent</th>' + (withChange ? '<th scope="col">Change on a year</th>' : '<th scope="col">2 bed</th>') + '</tr></thead><tbody>' +
      rows.map(function (b) { return '<tr><th scope="row"><a href="/london-rents/' + b.slug + '">' + esc(b.name) + '</a></th><td>' + gbp(b.rent) + '</td><td>' + (withChange ? (b.change != null ? pct(b.change) : '–') : (b.beds['2'] ? gbp(b.beds['2']) : '–')) + '</td></tr>'; }).join('') + '</tbody></table></div>'; };
    const L = f.london, tr = f.track;
    let h = '<div class="ar-card mk-key rv"><div class="mk-g">' +
      (L.rent ? '<div><b>' + gbp(L.rent) + '</b><span>London average rent a month</span><small>' + esc(f.dataMonth) + ', ONS</small></div>' : '') +
      (L.change != null ? '<div><b>' + pct(L.change) + '</b><span>change on a year earlier</span><small>London, ONS</small></div>' : '') +
      '<div><b>' + f.counts.rising + ' of ' + f.counts.boroughs + '</b><span>boroughs where rents rose</span><small>over the year, ONS</small></div></div></div>';
    h += '<h2>The London picture</h2>' + P(t.intro);
    h += '<h2>Boroughs: where rents are moving</h2>' + P(t.analysis);
    h += '<div class="mk-tables"><div><h3>Biggest annual rises</h3>' + tbl(f.risers, true) + '</div><div><h3>Smallest rises / falls</h3>' + tbl(f.fallers, true) + '</div>' +
      '<div><h3>Most expensive</h3>' + tbl(f.dearest, false) + '</div><div><h3>Most affordable</h3>' + tbl(f.cheapest, false) + '</div></div>';
    if (f.regions.length) h += '<h3>Average rent by part of London</h3><div class="ar-tw"><table class="ar-tbl"><thead><tr><th scope="col">Area</th><th scope="col">Average of its boroughs</th><th scope="col">Boroughs</th></tr></thead><tbody>' +
      f.regions.map(function (r) { return '<tr><th scope="row">' + esc(r.region) + ' London</th><td>' + gbp(r.avg) + '</td><td>' + r.n + '</td></tr>'; }).join('') + '</tbody></table></div>';
    h += '<h2>What it means for landlords</h2>' + P(t.landlords);
    if (tr.days || tr.rentPct || tr.ytd) h += '<div class="ar-card mk-key rv"><h3 style="margin-top:0">Our own lettings</h3><div class="mk-g">' +
      (tr.days ? '<div><b>' + tr.days + ' days</b><span>typical time from online to let</span><small>median, last 12 months</small></div>' : '') +
      (tr.rentPct ? '<div><b>' + tr.rentPct + '%</b><span>of the asking rent agreed</span><small>median, last 12 months</small></div>' : '') +
      (tr.ytd ? '<div><b>' + tr.ytd + '</b><span>tenancies started so far in ' + tr.ytdYear + '</span><small>our office records</small></div>' : '') + '</div></div>';
    h += '<p class="ar-src">Rents: Office for National Statistics, Price Index of Private Rents (' + esc(f.dataMonth) + '), all private rented homes in each area — not only homes we let. <a href="' + esc(f.source) + '" rel="noopener">ONS release</a>. Contains public sector information licensed under the Open Government Licence v3.0. Our own figures: Residential Realtors’ records.</p>';
    return h;
  }

  async function make(force) {
    if (making) return null; making = true;
    try {
      const p = await pool(); if (!p) return null;
      const f = facts(); if (!f.london.rent && f.counts.boroughs < 10) { console.log('Market update: no ONS figures yet'); return null; }
      const w = await write(f), t = w.text;
      const title = t.title && w.ai && t.title.length <= 62 ? t.title : 'London rental market update — ' + f.month;   // short enough for Google
      const descr = t.description && w.ai ? t.description : ('London rents in ' + f.dataMonth + (f.london.rent ? ': average ' + gbp(f.london.rent) + ' a month' : '') + ' — which boroughs are rising and falling, and what it means for landlords.');
      const slug = 'london-rental-market-' + f.month.toLowerCase().replace(/\s+/g, '-');
      await p.query(`INSERT INTO market_reports (month, slug, title, descr, body, facts, ai) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (month) DO UPDATE SET title = excluded.title, descr = excluded.descr, body = excluded.body, facts = excluded.facts, ai = excluded.ai, updated_at = now()` + (force ? '' : ' WHERE false'),
        [f.key, slug, title, descr, render(f, t), JSON.stringify(f), w.ai]);
      await load();
      const row = cache.filter(function (r) { return r.month === f.key; })[0];
      console.log('Market update: ' + f.month + ' ' + (force ? 'written' : 'published') + (w.ai ? ' (AI wording, figures checked)' : ' (plain wording)'));
      if (row && LIVE && opts.sendMail && !force) opts.sendMail({ to: ['info@residentialrealtors.co.uk'], subject: 'Website: ' + title, text: 'This month’s London rental market update is live on the website:\n\n' + opts.siteUrl + '/market-updates/' + row.slug + '\n\nIt uses the latest ONS figures and our own track record. To hide it or rewrite it: Fixflow → Activity → SEO health.' }).catch(function () {});
      return row;
    } finally { making = false; }
  }
  // Once a month: from the 20th (ONS figures for the month are out), or straight away when there's none at all yet.
  function due() { const now = new Date(), key = now.toISOString().slice(0, 7); return !cache.some(function (r) { return r.month === key; }) && (now.getDate() >= 20 || !cache.length); }
  setTimeout(function () { pool().then(function () { if (process.env.MARKET_AUTO !== '0' && due()) return make(false); }).catch(function (e) { console.error('Market update:', e.message); }); }, 5 * 60000).unref();
  setInterval(function () { if (process.env.MARKET_AUTO !== '0' && due()) make(false).catch(function (e) { console.error('Market update:', e.message); }); }, 3 * 3600000).unref();

  // Pages.
  const shown = function () { return cache.filter(function (r) { return !r.hidden; }); };
  app.get(['/market-updates', '/london-rental-market'], function (req, res) {
    const list = shown();
    let h = '<section class="ar-hero"><div class="wrap"><p class="ar-kick">Market updates</p><h1>London rental market updates</h1><p class="ar-lead">Every month: what’s happening to rents across London and in each borough, from the latest official ONS figures — and what it means for landlords.</p></div></section>' +
      '<section class="ar-main"><div class="wrap">' + (list.length ? '<ul class="ar-list ar-cover">' + list.map(function (r) { return '<li><a href="/market-updates/' + esc(r.slug) + '"><b>' + esc(r.title) + '</b><span>' + esc(r.descr || '') + '</span></a></li>'; }).join('') + '</ul>' : '<p>The first update is on its way.</p>') + '</div></section>' +
      '<section class="ar-cta"><div class="wrap ar-cta-in"><div><h2>What could your property let for?</h2><p>Get a free rental valuation from a local agent who covers all of London.</p></div><div class="btns"><a class="btn red" href="/landlords#valuation">Free rental valuation →</a><a class="btn line" href="/london-rents">Rents by borough</a></div></div></section>';
    opts.send(req, res, { name: 'rents', stamp: 'mk' + list.length + (list[0] ? list[0].updated_at : ''), canon: '/market-updates', crumb: 'Market updates', title: 'London Rental Market Updates — Monthly | Residential Realtors',
      desc: 'Monthly London rental market updates for landlords: average rents, which boroughs are rising and falling, from official ONS figures. By Residential Realtors.' }, h);
  });
  app.get('/market-updates/:slug', function (req, res, next) {
    const r = cache.filter(function (x) { return x.slug === req.params.slug && !x.hidden; })[0]; if (!r) return next();
    const f = r.facts || {}, others = shown().filter(function (x) { return x.id !== r.id; }).slice(0, 4);
    const h = '<section class="ar-hero"><div class="wrap"><p class="ar-kick"><a href="/market-updates">Market updates</a> · ' + esc(f.month || '') + '</p><h1>' + esc(r.title) + '</h1><p class="ar-lead">' + esc(r.descr || '') + '</p></div></section>' +
      '<section class="ar-main"><div class="wrap mk-art">' + r.body + (others.length ? '<h2>Earlier updates</h2><ul class="ar-list ar-cover">' + others.map(function (x) { return '<li><a href="/market-updates/' + esc(x.slug) + '"><b>' + esc(x.title) + '</b></a></li>'; }).join('') + '</ul>' : '') + '</div></section>' +
      '<section class="ar-cta"><div class="wrap ar-cta-in"><div><h2>Letting a property in London?</h2><p>We let and manage homes in all 33 boroughs. Get a free rental valuation.</p></div><div class="btns"><a class="btn red" href="/landlords#valuation">Free rental valuation →</a><a class="btn line" href="/letting-agents">Areas we cover</a></div></div></section>';
    const pub = new Date(r.created_at).toISOString(), mod = new Date(r.updated_at).toISOString();
    opts.send(req, res, { name: 'rents', stamp: 'mk' + r.id + mod, canon: '/market-updates/' + r.slug, crumb: 'Market updates', crumbUrl: '/market-updates', crumb2: f.month || r.title, title: r.title + ' | Residential Realtors', desc: r.descr || r.title,
      ld: [{ '@type': 'Article', headline: r.title.slice(0, 110), description: r.descr || '', datePublished: pub, dateModified: mod, author: { '@type': 'Organization', name: 'Residential Realtors', url: opts.siteUrl + '/' }, publisher: { '@type': 'Organization', name: 'Residential Realtors', logo: { '@type': 'ImageObject', url: opts.siteUrl + '/icons/app-180.png' } }, mainEntityOfPage: opts.siteUrl + '/market-updates/' + r.slug }] }, h);
  });

  // Staff (managers): list, rewrite this month's, hide/show.
  app.get('/api/admin/market-reports', async function (req, res) {
    if (!opts.isStaff(req) || !opts.canManage(req)) return res.status(403).json({ ok: false });
    await pool().catch(function () {}); res.json({ ok: true, making: making, items: cache.map(function (r) { return { id: r.id, month: r.month, slug: r.slug, title: r.title, ai: r.ai, hidden: r.hidden, created_at: r.created_at, updated_at: r.updated_at }; }) });
  });
  app.post('/api/admin/market-reports/make', async function (req, res) {
    if (!opts.isStaff(req) || !opts.canManage(req)) return res.status(403).json({ ok: false });
    try { const r = await make(true); res.json({ ok: !!r, slug: r && r.slug }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  app.post('/api/admin/market-reports/:id', async function (req, res) {
    if (!opts.isStaff(req) || !opts.canManage(req)) return res.status(403).json({ ok: false });
    const p = await pool(); await p.query('UPDATE market_reports SET hidden = $2, updated_at = now() WHERE id = $1', [parseInt(req.params.id, 10) || 0, (req.body || {}).hidden === true]); await load(); res.json({ ok: true });
  });
  return { urls: function () { return (shown().length ? ['/market-updates'] : []).concat(shown().map(function (r) { return '/market-updates/' + r.slug; })); } };
};
