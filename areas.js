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
  const fig = function (a) { return (ons.boroughs || {})[a.gss] || {}; };
  const esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  const gbp = function (n) { return '£' + Math.round(n).toLocaleString('en-GB'); };
  const pct = function (n) { return (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(1) + '%'; };
  const REGIONS = [['Central', 'Central London'], ['North', 'North London'], ['East', 'East London'], ['South', 'South London'], ['West', 'West London']];
  const SOURCE = '<p class="ar-src">Source: Office for National Statistics — Price Index of Private Rents and UK House Price Index. Average rents are for all private rented homes in the area, not only homes we let. Contains public sector information licensed under the <a href="https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/" rel="noopener">Open Government Licence v3.0</a>.</p>';
  const cta = function (where) {
    return '<section class="ar-cta"><div class="wrap ar-cta-in"><div><h2>Letting a property in ' + esc(where) + '?</h2><p>Get a free rental valuation from a local agent, or compare similar homes we’re letting.</p></div>' +
      '<div class="btns"><a class="btn red" href="/landlords#valuation">Free rental valuation →</a><a class="btn line" href="/landlords#compare">Compare rents</a></div></div></section>';
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
    opts.send(req, res, { name: 'rents', stamp: 'ar' + a.slug, canon: '/london-rents/' + a.slug, crumb: 'London rents', crumbUrl: '/london-rents', crumb2: a.name,
      title: 'Average Rent in ' + a.name + (f.rentMonth ? ' (' + String(f.rentMonth).replace(/^\w+ /, '') + ')' : '') + ': Rental Values | Residential Realtors', desc: desc, robots: f.rent ? undefined : 'noindex, follow' }, h);
  });

  // Every borough, by region.
  app.get(['/london-rents', '/rental-values', '/average-rent-london'], function (req, res) {
    const L = ons.london || {};
    let h = '<section class="ar-hero"><div class="wrap"><p class="ar-kick">London rents</p><h1>Rental values across London</h1>' +
      '<p class="ar-lead">Average monthly rents for every London borough, from official ONS figures' + (L.rent ? '. The London average is <b>' + gbp(L.rent) + ' a month</b>' + (L.rentMonth ? ' (' + esc(L.rentMonth) + ')' : '') : '') + '.</p></div></section>';
    h += '<section class="ar-main"><div class="wrap">' + REGIONS.map(function (r, i) {
      const list = AREAS.filter(function (a) { return a.region === r[0]; });
      return '<details class="ar-reg"' + (i === 0 ? ' open' : '') + '><summary>' + r[1] + '<span>' + list.length + ' boroughs</span></summary><ul class="ar-list">' + list.map(function (a) { const g = fig(a); return '<li><a href="/london-rents/' + a.slug + '">' + esc(a.name) + (g.rent ? '<span>' + gbp(g.rent) + ' pcm</span>' : '') + '</a></li>'; }).join('') + '</ul></details>';
    }).join('') + SOURCE + '</div></section>' + cta('London');
    opts.send(req, res, { name: 'rents', stamp: 'arall', canon: '/london-rents', crumb: 'London rents', title: 'Average Rent in London by Borough: Rental Values | Residential Realtors',
      desc: 'Average monthly rents for all 33 London boroughs from official ONS figures' + (L.rent ? ' — London average ' + gbp(L.rent) + ' a month' : '') + '. Rent by bedrooms, house prices and homes to rent.' }, h);
  });

  // One-off look at an ONS borough data file (written to the server log) to build the monthly refresh against.
  if (process.env.DATABASE_URL && !/localhost/.test(process.env.DATABASE_URL)) setTimeout(function () {
    fetch('https://www.ons.gov.uk/visualisations/housingpriceslocal/data/json/E09000028.json', { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ResidentialRealtors/1.0)' } }).then(function (r) { return r.json(); }).then(function (j) {
      (j.sections || []).forEach(function (sec, i) {
        const t = JSON.stringify(sec); console.log('ONS json ' + i + ' ' + sec.type + ' ' + (sec.title || '') + ' keys=' + Object.keys(sec).join(',') + ' len=' + t.length);
        if (/bed|rent/i.test(t)) for (let k = 0; k < Math.min(t.length, 3000); k += 1000) console.log('ONS json ' + i + ' @' + k + ': ' + t.slice(k, k + 1000));
      });
    }).catch(function (e) { console.log('ONS json probe failed', e.message); });
  }, 20000);

  // ONS average rent for a borough (by its ONS code) and bedroom count, for the rent comparison tool.
  const onsBeds = function (gss, beds) {
    const a = AREAS.find(function (x) { return x.gss === gss; }); if (!a) return null;
    const f = fig(a), k = String(Math.max(1, Math.min(4, beds || 1))), v = (f.beds || {})[k];
    return { slug: a.slug, name: a.name, rent: v || 0, month: f.bedsMonth || f.rentMonth || '', all: f.rent || 0 };
  };

  return { onsBeds: onsBeds, urls: function () { return ['/london-rents'].concat(AREAS.filter(function (a) { return fig(a).rent; }).map(function (a) { return '/london-rents/' + a.slug; })); } };
};
