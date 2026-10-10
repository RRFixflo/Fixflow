// Landlord services by London borough: /gas-safety-certificate/<borough>, /eicr/<borough>, /epc/<borough> and
// /diy-inventory/<borough>. Each is the service's own page (site/<service>.html) for that borough — its
// neighbourhoods and postcodes, local questions, links to nearby boroughs and the borough's rent page —
// with the price (as set in the staff app) marked up for search engines.
const fs = require('fs');
const path = require('path');
const AREAS = require('./areas-data');

const SERVICES = {
  gas: { base: '/gas-safety-certificate', file: 'gas', short: 'Gas Safety check', thing: 'Gas Safety certificate', type: 'Landlord Gas Safety certificate (CP12)', price: function (m) { return m.gas; },
    title: function (b) { return 'Gas Safety Certificate ' + b + ' — Landlord CP12 | Residential Realtors'; },
    desc: function (b, p) { return 'Landlord Gas Safety certificate (CP12) in ' + b + ', by Gas Safe registered engineers' + (p ? ', from £' + p + ' + VAT' : '') + '. Book online, and we arrange access with you or your tenant.'; } },
  eicr: { base: '/eicr', file: 'eicr', short: 'EICR', thing: 'EICR', type: 'EICR electrical safety certificate', price: function (m) { return m.eicr; },
    title: function (b) { return 'EICR ' + b + ' — Landlord Electrical Certificate | Residential Realtors'; },
    desc: function (b, p) { return 'Landlord EICR (electrical safety report) in ' + b + ' by qualified electricians, priced by property size' + (p ? ' from £' + p + ' + VAT' : '') + '. Book online, and we arrange the visit.'; } },
  epc: { base: '/epc', file: 'epc', short: 'EPC', thing: 'EPC', type: 'Energy Performance Certificate (EPC)', price: function (m) { return m.epc; },
    title: function (b) { return 'EPC ' + b + ' — Energy Performance Certificate | Residential Realtors'; },
    desc: function (b, p) { return 'EPC in ' + b + ' by an accredited energy assessor, lodged on the government register and valid for 10 years' + (p ? '. From £' + p + ' + VAT' : '') + '. Book online.'; } },
  diy: { base: '/diy-inventory', file: 'diy', short: 'inventory', thing: 'inventory report', type: 'DIY inventory and check-in report', price: function (m) { return m.diy; },
    title: function (b) { return 'Landlord Inventory ' + b + ' — DIY Check-in Report | Residential Realtors'; },
    desc: function (b, p) { return 'A room-by-room inventory and check-in report for your rental in ' + b + ', done on a phone with photos, meter readings and keys' + (p ? ' — £' + p + ' + VAT' : '') + '.'; } }
};

module.exports = function (app, opts) {
  const BY = {}; AREAS.forEach(function (a) { BY[a.slug] = a; });
  const esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  const list = function (xs) { return xs.length > 1 ? xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1] : xs.join(''); };
  const tpl = {};
  const page = function (file) {
    const f = path.join(__dirname, 'site', file + '.html'); let st; try { st = fs.statSync(f); } catch (e) { return ''; }
    if (!tpl[file] || tpl[file].mtime !== st.mtimeMs) tpl[file] = { mtime: st.mtimeMs, html: fs.readFileSync(f, 'utf8') };
    return tpl[file].html;
  };
  // Prices as set in the staff app (Certificates → services), refreshed every 10 minutes.
  let prices = { diy: '30' }, pricesAt = 0;
  async function loadPrices() {
    if (Date.now() - pricesAt < 600000) return prices; pricesAt = Date.now();
    try {
      const p = opts.db && await opts.db(); if (!p) return prices;
      const v = ((await p.query("SELECT value FROM app_settings WHERE key = 'cert_services'")).rows[0] || {}).value || {};
      const items = Array.isArray(v.items) ? v.items : [], num = function (x) { const n = parseFloat(String(x && x.price || '').replace(/[£,\s]/g, '')); return n > 0 ? String(Math.round(n * 100) / 100) : null; };
      const find = function (re) { const x = items.filter(function (i) { return re.test(String(i.id || '')) && num(i); }).sort(function (a, b) { return num(a) - num(b); })[0]; return x ? num(x) : null; };
      prices = { gas: find(/^gas/), eicr: find(/^eicr/), epc: find(/^epc/), diy: find(/^diy$/) || (items.some(function (i) { return i.id === 'diy'; }) ? null : '30') };
    } catch (e) { console.error('Service area prices:', e.message); }
    return prices;
  }

  function build(key, a, price) {
    const S = SERVICES[key], B = a.name, near = a.near.map(function (s) { return BY[s]; }).filter(Boolean);
    let h = page(S.file); if (!h) return null;
    const hoods = a.areas.slice(0, 6), pcs = a.outcodes.join(', ');
    h = h.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, '');   // replaced by the page's own (below)
    h = h.replace(/<h1([^>]*)>([\s\S]*?)<\/h1>/, function (m, at, inner) { return '<h1' + at.replace(/aria-label="([^"]*)"/, function (x, l) { return 'aria-label="' + esc(l.replace(/ in London$/, '') + ' in ' + B) + '"'; }) + '>' + inner + ' <span class="sa-in">in ' + esc(B) + '</span></h1>'; });
    h = h.replace('London landlords · book online', esc(B) + ' landlords · book online');
    h = h.replace(/(<p class="lp-lead">[\s\S]*?)<\/p>/, function (m, x) { return x + ' Covering ' + esc(list(hoods)) + ' and all of ' + esc(B) + '.</p>'; });
    h = h.replace(/(<svg[^>]*>(?:(?!<\/svg>)[\s\S])*<\/svg>) Serving London/, '$1 Serving ' + esc(B));
    // The borough: neighbourhoods, postcodes, its rents and the same service nearby.
    const local = '<section class="sa-local"><div class="wrap"><div class="sa-grid">' +
      '<div class="rv"><p class="kicker">Across ' + esc(B) + '</p><h2>' + esc(S.thing.charAt(0).toUpperCase() + S.thing.slice(1)) + 's in ' + esc(B) + '</h2>' +
        '<p>We arrange ' + esc(S.short) + 's for landlords right across ' + esc(B) + ', including ' + esc(list(a.areas)) + '.</p>' +
        '<p class="sa-pc"><b>Postcodes we cover in ' + esc(B) + ':</b> ' + esc(pcs) + ' — and the rest of London.</p>' +
        '<div class="btns"><a class="btn red" href="/book-certificate?service=' + key + '">Book your ' + esc(S.short) + ' →</a><a class="btn line" href="/london-rents/' + a.slug + '">Rents in ' + esc(B) + '</a></div></div>' +
      '<div class="rv"><h3>Nearby boroughs</h3><ul class="ar-list">' + near.map(function (b) { return '<li><a href="' + S.base + '/' + b.slug + '">' + esc(S.short.charAt(0).toUpperCase() + S.short.slice(1)) + ' in ' + esc(b.name) + '</a></li>'; }).join('') + '</ul>' +
        '<h3>Other services in ' + esc(B) + '</h3><ul class="ar-list">' + Object.keys(SERVICES).filter(function (k) { return k !== key; }).map(function (k) { const o = SERVICES[k]; return '<li><a href="' + o.base + '/' + a.slug + '">' + esc(o.type) + '</a></li>'; }).join('') + '</ul></div>' +
      '</div></div></section>';
    h = h.replace(/<!--areas-->[\s\S]*?<!--\/areas-->/g, '');   // the main page's list of every borough
    const at = h.indexOf('<section><div class="wrap"><div class="cb-band') !== -1 ? '<section><div class="wrap"><div class="cb-band' : '<section class="rl">';
    h = h.replace(at, local + at);
    // Questions about the borough, added to the page's own.
    const lq = [
      ['Do you cover ' + list(hoods.slice(0, 3)) + '?', 'Yes. We cover all of ' + B + ' (' + pcs + ') and the rest of London. Book online and we’ll arrange the visit with you or your tenant.'],
      ['How do I book a' + (/^[aeiou]/i.test(S.short) ? 'n ' : ' ') + S.short + ' in ' + B + '?', 'Book and pay online in a couple of minutes, or call 0207 096 8131. ' + (key === 'diy' ? 'You get the link to start the inventory as soon as you’ve paid.' : 'We then contact you, or your tenant if you prefer, to arrange a time.')],
      ['Do landlords in ' + B + ' need a property licence too?', 'It depends on the council’s licensing schemes and the property. Check your address with our free licence checker, and we can apply for you free of charge (the council’s fee is separate).']
    ];
    const lqh = lq.map(function (q) { return '<details class="rv"><summary>' + esc(q[0]) + '</summary><p>' + esc(q[1]) + '</p></details>'; }).join('');
    if (h.indexOf('<div class="sv-faq">') !== -1) h = h.replace(/(<div class="sv-faq">[\s\S]*?)(<\/div>)/, function (m, x, end) { return x + lqh + end; });
    else h = h.replace('<section class="sa-local">', '<section class="white sa-faqs"><div class="wrap"><h2 class="h2x rv">Questions landlords in ' + esc(B) + ' ask</h2><div class="sv-faq">' + lqh + '</div></div></section><section class="sa-local">');
    const url = (opts.siteUrl || '') + S.base + '/' + a.slug, faq = [];
    h.replace(/<details[^>]*><summary>([\s\S]*?)<\/summary><p>([\s\S]*?)<\/p><\/details>/g, function (m, q, ans) { faq.push({ '@type': 'Question', name: q.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"'), acceptedAnswer: { '@type': 'Answer', text: ans.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"') } }); });
    const svc = { '@type': 'Service', '@id': url + '#service', name: S.type + ' in ' + B, serviceType: S.type, url: url, provider: { '@id': (opts.siteUrl || '') + '/#agency' },
      areaServed: { '@type': 'AdministrativeArea', name: B + ', London' } };
    if (price) svc.offers = { '@type': 'Offer', price: price, priceCurrency: 'GBP', url: (opts.siteUrl || '') + '/book-certificate?service=' + key, priceSpecification: { '@type': 'UnitPriceSpecification', price: price, priceCurrency: 'GBP', valueAddedTaxIncluded: false } };
    return { body: h, ld: [svc].concat(faq.length ? [{ '@type': 'FAQPage', mainEntity: faq }] : []) };
  }

  Object.keys(SERVICES).forEach(function (key) {
    const S = SERVICES[key];
    app.get(S.base + '/:slug', async function (req, res, next) {
      const a = BY[String(req.params.slug).toLowerCase()]; if (!a) return next();
      if (req.params.slug !== a.slug) return res.redirect(301, S.base + '/' + a.slug);
      const p = S.price(await loadPrices()), b = build(key, a, p); if (!b) return next();
      opts.send(req, res, { name: key, stamp: 'sa' + key + a.slug + (p || ''), canon: S.base + '/' + a.slug, crumb: S.type.replace(/ \(.*\)$/, ''), crumbUrl: S.base, crumb2: a.name,
        title: S.title(a.name), desc: S.desc(a.name, p), ld: b.ld }, b.body);
    });
  });

  return {
    urls: function () { const out = []; Object.keys(SERVICES).forEach(function (k) { AREAS.forEach(function (a) { out.push(SERVICES[k].base + '/' + a.slug); }); }); return out; },
    // "Areas we cover" links for each service's main page.
    links: function (key) { const S = SERVICES[key]; return S ? AREAS.map(function (a) { return { url: S.base + '/' + a.slug, name: a.name }; }) : []; }
  };
};
