// London rent pages: /london-rents (every borough) and /london-rents/<borough> (average rent, rent by
// bedrooms, house prices, our homes nearby, neighbourhoods and nearby boroughs). Figures are the ONS's
// (data/ons-london.json, Open Government Licence) — refresh that file when the ONS publishes a new month.
const fs = require('fs');
const path = require('path');
const AREAS = require('./areas-data');

module.exports = function (app, opts) {
  const BY = {}; AREAS.forEach(function (a) { BY[a.slug] = a; });
  let ons = { london: {}, boroughs: {} };
  try { ons = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'ons-london.json'), 'utf8')); } catch (e) { console.error('London rents: no ONS figures', e.message); }
  const base = ons; let ver = '';
  const fig = function (a) { return (ons.boroughs || {})[a.gss] || {}; };
  const esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  const gbp = function (n) { return '£' + Math.round(n).toLocaleString('en-GB'); };
  const pct = function (n) { return (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(1) + '%'; };
  const REGIONS = [['Central', 'Central London'], ['North', 'North London'], ['East', 'East London'], ['South', 'South London'], ['West', 'West London']];
  const SOURCE = '<p class="ar-src">Source: Office for National Statistics — Price Index of Private Rents and UK House Price Index. Average rents are for all private rented homes in the area, not only homes we let. Contains public sector information licensed under the <a href="https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/" rel="noopener">Open Government Licence v3.0</a>.</p>';
  const cta = function (where) {
    return '<section class="ar-cta"><div class="wrap ar-cta-in"><div><h2>Letting a property in ' + esc(where) + '?</h2><p>Get a free rental valuation from a local agent, or compare rents for similar homes near you.</p></div>' +
      '<div class="btns"><a class="btn red" href="/landlords#valuation">Free rental valuation →</a><a class="btn line" href="/landlords#compare">Compare rents</a></div></div></section>';
  };

  // A table of average rent by bedrooms: one row per borough, sortable (site.js), the current one highlighted.
  const table = function (list, cur) {
    const cell = function (v) { return '<td data-v="' + (v || 0) + '">' + (v ? gbp(v) : '–') + '</td>'; };
    return '<div class="ar-tw"><table class="ar-tbl"><thead><tr><th data-k="0" scope="col">Borough</th><th data-k="1" scope="col">1 bed</th><th data-k="2" scope="col">2 bed</th><th data-k="3" scope="col">3 bed</th><th data-k="4" scope="col">4+ beds</th><th data-k="5" scope="col">All homes</th></tr></thead><tbody>' +
      list.map(function (a) { const g = fig(a), b = g.beds || {};
        return '<tr' + (a === cur ? ' class="on"' : '') + '><th scope="row" data-v="' + esc(a.name) + '"><a href="/london-rents/' + a.slug + '">' + esc(a.name) + '</a></th>' + cell(b['1']) + cell(b['2']) + cell(b['3']) + cell(b['4']) + cell(g.rent) + '</tr>'; }).join('') +
      '</tbody></table></div><p class="ar-tnote">Average monthly rent (pcm) for all private rented homes in each borough, ONS. Tap a column heading to sort.</p>';
  };

  // One borough.
  app.get('/london-rents/:slug', function (req, res, next) {
    const a = BY[String(req.params.slug).toLowerCase()]; if (!a) return next();
    const f = fig(a), L = ons.london || {}, beds = f.beds || {}, bk = ['1', '2', '3', '4'].filter(function (k) { return beds[k]; });
    const max = bk.reduce(function (m, k) { return Math.max(m, beds[k]); }, 0);
    let h = '<section class="ar-hero"><div class="wrap"><p class="ar-kick"><a href="/london-rents">London rents</a> · ' + esc(a.region) + ' London</p><h1>Rental values in ' + esc(a.name) + '</h1>' +
      '<p class="ar-lead">What it costs to rent in ' + esc(a.name) + ', from official ONS figures, with the homes we have available in the area.</p></div></section>';
    h += '<section class="ar-main"><div class="wrap ar-grid">';
    if (f.rent) {
      h += '<div class="ar-card ar-big rv"><b>' + gbp(f.rent) + ' <small>pcm</small></b><span>Average monthly rent' + (f.rentMonth ? ', ' + esc(f.rentMonth) : '') + '</span>' +
        (f.rentChange != null ? '<em class="' + (f.rentChange >= 0 ? 'up' : 'down') + '">' + pct(f.rentChange) + ' on a year ago</em>' : '') +
        (L.rent ? '<p>London average: ' + gbp(L.rent) + ' pcm</p>' : '') + '</div>';
    }
    if (f.price) h += '<div class="ar-card rv"><b>' + gbp(f.price) + '</b><span>Average house price' + (f.priceMonth ? ', ' + esc(f.priceMonth) : '') + '</span>' + (f.priceChange != null ? '<em class="' + (f.priceChange >= 0 ? 'up' : 'down') + '">' + pct(f.priceChange) + ' on a year ago</em>' : '') + '<p><a href="/sales#sales-valuation">Get a free sales valuation →</a></p></div>';
    if (bk.length) {
      h += '<div class="ar-card ar-beds rv"><h2>Average rent by bedrooms' + (f.bedsMonth ? ' <small>' + esc(f.bedsMonth) + '</small>' : '') + '</h2>' + bk.map(function (k) {
        return '<div class="ar-bar"><span>' + (k === '4' ? '4+ beds' : k + ' bed') + '</span><i style="--w:' + Math.round(beds[k] / max * 100) + '%"></i><b>' + gbp(beds[k]) + '</b></div>'; }).join('') + '</div>';
    }
    if (f.rent) h += '<div class="ar-card ar-beds rv"><h2>' + esc(a.name) + ' compared with nearby boroughs</h2>' + table([a].concat(a.near.map(function (x) { return BY[x]; }).filter(function (b) { return fig(b).rent; })), a) + '</div>';
    if (!f.rent && !f.price) h += '<div class="ar-card rv"><b>' + (a.gss === 'E09000001' ? 'No official average' : 'Figures coming soon') + '</b><span>' + (a.gss === 'E09000001' ? 'The ONS doesn’t publish average rents for the City of London because too few homes are in its survey. ' : '') + 'Call us on <a href="tel:02070968131">0207 096 8131</a> for a rental valuation in ' + esc(a.name) + '.</span></div>';
    h += '</div>' + (f.rent || f.price ? '<div class="wrap">' + SOURCE.replace('</p>', (f.source ? ' <a href="' + esc(f.source) + '" rel="noopener">See the ONS figures for ' + esc(a.name) + '</a>.' : '') + '</p>') + '</div>' : '') + '</section>';
    const homes = opts.listings && opts.listings() ? opts.listings().near(req, a.outcodes, 8) : '';
    if (homes) h += '<section class="ar-homes"><div class="wrap"><div class="head2 row"><div><h2>Homes in and around ' + esc(a.name) + '</h2></div><div class="car-nav"><button type="button" class="car-b" data-car="-1" aria-label="Previous homes">‹</button><button type="button" class="car-b" data-car="1" aria-label="More homes">›</button></div></div><div class="car" id="car">' + homes + '</div></div></section>';
    h += '<section class="ar-more"><div class="wrap ar-cols">' +
      '<div><h2>Areas in ' + esc(a.name) + '</h2><ul class="ar-list">' + a.areas.map(function (n) { return '<li><a href="/properties-to-rent?q=' + encodeURIComponent(n) + '">Homes to rent in ' + esc(n) + '</a></li>'; }).join('') + '</ul></div>' +
      '<div><h2>Rental values in nearby boroughs</h2><ul class="ar-list">' + a.near.map(function (s) { const b = BY[s], g = fig(b); return '<li><a href="/london-rents/' + s + '">' + esc(b.name) + (g.rent ? '<span>' + gbp(g.rent) + ' pcm</span>' : '') + '</a></li>'; }).join('') + '</ul>' +
      '<p class="ar-also">Landlords in ' + esc(a.name) + ': <a href="/property-checks#licence">check if you need a licence</a> · <a href="/services">certificates and services</a></p></div></div></section>';
    h += cta(a.name);
    const desc = f.rent ? 'The average rent in ' + a.name + ' is ' + gbp(f.rent) + ' a month' + (f.rentMonth ? ' (' + f.rentMonth + ', ONS)' : ' (ONS)') + '. Rent by bedrooms, house prices, areas and homes to rent in ' + a.name + '.' : 'Rental values, areas and homes to rent in ' + a.name + ', London.';
    opts.send(req, res, { name: 'rents', stamp: 'ar' + a.slug + ver, canon: '/london-rents/' + a.slug, crumb: 'London rents', crumbUrl: '/london-rents', crumb2: a.name,
      title: 'Average Rent in ' + a.name + (f.rentMonth ? ' (' + String(f.rentMonth).replace(/^\w+ /, '') + ')' : '') + ': Rental Values | Residential Realtors', desc: desc, robots: f.rent ? undefined : 'noindex, follow' }, h);
  });

  // Every borough, by region.
  app.get(['/london-rents', '/rental-values', '/average-rent-london'], function (req, res) {
    const L = ons.london || {};
    let h = '<section class="ar-hero"><div class="wrap"><p class="ar-kick">London rents</p><h1>Rental values across London</h1>' +
      '<p class="ar-lead">Average monthly rents for every London borough, from official ONS figures' + (L.rent ? '. The London average is <b>' + gbp(L.rent) + ' a month</b>' + (L.rentMonth ? ' (' + esc(L.rentMonth) + ')' : '') : '') + '.</p></div></section>';
    h += '<section class="ar-main"><div class="wrap"><div class="ar-card ar-all rv"><h2>Average rent by bedrooms in every borough</h2>' + table(AREAS.filter(function (a) { return fig(a).rent; }).sort(function (x, y) { return x.name.localeCompare(y.name); })) + '</div><h2 class="ar-h2">Boroughs by area</h2>' + REGIONS.map(function (r, i) {
      const list = AREAS.filter(function (a) { return a.region === r[0]; });
      return '<details class="ar-reg"' + (i === 0 ? ' open' : '') + '><summary>' + r[1] + '<span>' + list.length + ' boroughs</span></summary><ul class="ar-list">' + list.map(function (a) { const g = fig(a); return '<li><a href="/london-rents/' + a.slug + '">' + esc(a.name) + (g.rent ? '<span>' + gbp(g.rent) + ' pcm</span>' : '') + '</a></li>'; }).join('') + '</ul></details>';
    }).join('') + SOURCE + '</div></section>' + cta('London');
    opts.send(req, res, { name: 'rents', stamp: 'arall' + ver, canon: '/london-rents', crumb: 'London rents', title: 'Average Rent in London by Borough: Rental Values | Residential Realtors',
      desc: 'Average monthly rents for all 33 London boroughs from official ONS figures' + (L.rent ? ' — London average ' + gbp(L.rent) + ' a month' : '') + '. Rent by bedrooms, house prices and homes to rent.' }, h);
  });

  // Automatic refresh: once a week, read each borough's ONS data file (the one behind its ONS page) and keep
  // any newer figures in app_settings ('ons_london'), laid over data/ons-london.json. Only sane numbers are used.
  const ONS_URL = function (gss) { return 'https://www.ons.gov.uk/visualisations/housingpriceslocal/data/json/' + gss + '.json'; };
  const num = function (v) { return parseInt(String(v).replace(/[£,\s]/g, ''), 10) || 0; };
  const chg = function (a, b) { return a && b ? Math.round((a - b) / b * 1000) / 10 : null; };
  const inR = function (v, lo, hi) { return v >= lo && v <= hi; };
  // The ONS's own stated change ("a 5.4% rise", "a 0.6% change"), signed; else worked out from the two figures.
  const said = function (t, a, b) { const m = /a (\d+(?:\.\d+)?)% (rise|increase|fall|decrease|change)/.exec(t || ''); if (!m) return chg(a, b); const v = parseFloat(m[1]); return /fall|decrease/.test(m[2]) || (m[2] === 'change' && a < b) ? -v : v; };
  function parseOns(j) {
    const S = (j && j.sections) || [], text = function (sec) { return String((sec && sec.content) || '').replace(/<[^>]+>/g, ' ').replace(/&pound;/g, '£').replace(/\s+/g, ' '); };
    const by = function (id) { return S.find(function (x) { return x.id === id; }); }, all = S.map(text).join(' '), f = {}, L = {};
    const tr = text(by('rent_price')); let m = /private rent in .+? was £([\d,]+) in (\w+ \d{4})\. This was [^£]*£([\d,]+) in \w+ \d{4}/.exec(tr);
    if (m && inR(num(m[1]), 300, 20000)) { f.rent = num(m[1]); f.rentMonth = m[2]; f.rentChange = said(tr.slice(m.index), f.rent, num(m[3])); }
    const t3 = text(by('rent_price_third')), bm = /as of (\w+ \d{4})/.exec(t3), beds = {};
    [['1', 'One bedroom'], ['2', 'Two bedrooms'], ['3', 'Three bedrooms'], ['4', 'Four or more bedrooms']].forEach(function (k) { const x = new RegExp(k[1] + ': £([\\d,]+)').exec(t3); if (x && inR(num(x[1]), 300, 30000)) beds[k[0]] = num(x[1]); });
    if (Object.keys(beds).length === 4) { f.beds = beds; f.bedsMonth = bm ? bm[1] : f.rentMonth; }
    m = /average house price in [^.]*? in (\w+ \d{4}) was £([\d,]+)\. This was [^£]*£([\d,]+) in \w+ \d{4}/.exec(all);
    if (m && inR(num(m[2]), 50000, 10000000)) { f.price = num(m[2]); f.priceMonth = m[1]; f.priceChange = said(all.slice(m.index, m.index + m[0].length + 60), f.price, num(m[3])); }
    m = /Across London, the average monthly rent was £([\d,]+), (?:up|down) from £([\d,]+)/.exec(text(by('rent_price_two')));
    if (m && inR(num(m[1]), 500, 10000)) { L.rent = num(m[1]); L.rentMonth = f.rentMonth; L.rentChange = chg(L.rent, num(m[2])); }
    m = /Across London, the average house price in (\w+ \d{4}) was £([\d,]+)[^£]*\(£([\d,]+)\)/.exec(all);
    if (m && inR(num(m[2]), 100000, 5000000)) { L.price = num(m[2]); L.priceMonth = m[1]; L.priceChange = chg(L.price, num(m[3])); }
    return { f: f, L: L };
  }
  function apply(over) {
    const b = JSON.parse(JSON.stringify(base)); b.london = Object.assign({}, b.london, over.london || {}); b.boroughs = b.boroughs || {};
    Object.keys(over.boroughs || {}).forEach(function (g) { b.boroughs[g] = Object.assign({}, b.boroughs[g], over.boroughs[g], { source: 'https://www.ons.gov.uk/visualisations/housingpriceslocal/' + g + '/' }); });
    ons = b; ver = String(over.at || '');
  }
  let refreshing = false;
  async function refreshOns(p) {
    if (refreshing) return; refreshing = true;
    const over = { at: Date.now(), london: {}, boroughs: {} }; let ok = 0, bad = [];
    try {
      for (const a of AREAS) {
        if (a.gss === 'E09000001') continue;
        try {
          const r = await fetch(ONS_URL(a.gss), { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ResidentialRealtors/1.0; +https://www.residentialrealtors.co.uk)' }, signal: AbortSignal.timeout(20000) });
          const x = parseOns(r.ok ? await r.json() : null);
          if (x.f.rent) { over.boroughs[a.gss] = x.f; ok++; } else bad.push(a.name);
          if (x.L.rent && !over.london.rent) over.london = Object.assign({}, x.L);
          else if (x.L.price && !over.london.price) Object.assign(over.london, { price: x.L.price, priceMonth: x.L.priceMonth, priceChange: x.L.priceChange });
        } catch (e) { bad.push(a.name); }
        await new Promise(function (res) { setTimeout(res, 1500); });
      }
      if (ok >= 16) { apply(over); await p.query("INSERT INTO app_settings (key, value) VALUES ('ons_london', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()", [JSON.stringify(over)]); }
      console.log('London rents: ONS refresh', ok, 'boroughs updated' + (bad.length ? '; not read: ' + bad.join(', ') : '') + (ok < 16 ? ' — too few, kept the old figures' : ''));
    } finally { refreshing = false; }
  }
  if (opts.db) setTimeout(async function tick() {
    try {
      const p = await opts.db(); if (!p) return;
      const row = (await p.query("SELECT value FROM app_settings WHERE key = 'ons_london'")).rows[0], v = row && row.value;
      if (v && v.boroughs && !ver) apply(v);
      if (!v || Date.now() - (v.at || 0) > 7 * 86400000) await refreshOns(p);
    } catch (e) { console.error('London rents: ONS refresh failed', e.message); }
    setTimeout(tick, 86400000);
  }, 60000);

  // ONS average rent for a borough (by its ONS code) and bedroom count, for the rent comparison tool.
  const onsBeds = function (gss, beds) {
    const a = AREAS.find(function (x) { return x.gss === gss; }); if (!a) return null;
    const f = fig(a), k = String(Math.max(1, Math.min(4, beds || 1))), v = (f.beds || {})[k];
    return { slug: a.slug, name: a.name, rent: v || 0, month: f.bedsMonth || f.rentMonth || '', all: f.rent || 0, beds: f.beds || null };
  };

  return { parseOns: parseOns, onsBeds: onsBeds, urls: function () { return ['/london-rents'].concat(AREAS.filter(function (a) { return fig(a).rent; }).map(function (a) { return '/london-rents/' + a.slug; })); } };
};
