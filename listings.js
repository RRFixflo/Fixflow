// Property listings on the website, from the Gnomen sales and lettings feeds
// (GNOMEN_SALES_FEED / GNOMEN_LETTINGS_FEED: the feed addresses, which hold the
// keys, so they live in the environment, never in the code).
// The feeds are read every 15 minutes and kept in memory. Pages are built on the
// server so search engines see every property. Photos are resized here
// (sharp) so they're sharp but light on phones.
// They only go on the website when LISTINGS_ON=1 (so a test feed never shows publicly).
const crypto = require('crypto');
let sharp = null; try { sharp = require('sharp'); } catch (e) { sharp = null; }

module.exports = function (app, opts) {
  const FEEDS = { sale: process.env.GNOMEN_SALES_FEED || '', let: process.env.GNOMEN_LETTINGS_FEED || '' };
  const LIVE = process.env.LISTINGS_ON === '1';
  const esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  const data = { sale: [], let: [], at: 0, stamp: '' };

  // ---------- Reading the feed (a flat XML list of <property> records) ----------
  const ent = function (s) { return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&amp;/g, '&'); };
  const val = function (s) { s = String(s || ''); const m = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(s); return (m ? m[1] : ent(s)).replace(/\\(['"])/g, '$1').trim(); };
  const tag = function (x, t) { const m = new RegExp('<' + t + '>([\\s\\S]*?)</' + t + '>').exec(x); return m ? val(m[1]) : ''; };
  const list = function (x, t, c) { const m = new RegExp('<' + t + '>([\\s\\S]*?)</' + t + '>').exec(x); if (!m) return []; const out = []; m[1].replace(new RegExp('<' + c + '[^>]*>([\\s\\S]*?)</' + c + '>', 'g'), function (a, v) { v = val(v); if (/^https:\/\//.test(v)) out.push(v); }); return out; };
  // Only simple formatting from the description.
  const cleanHtml = function (h) {
    return String(h || '').replace(/<(script|style|iframe|object)[\s\S]*?<\/\1>/gi, '').replace(/<(\/?)(p|br|ul|ol|li|b|strong|em|i|h3|h4)\b[^>]*>/gi, '\u0001$1$2\u0002').replace(/<[^>]*>/g, '')
      .replace(/[<>]/g, '').replace(/\u0001(\/?)(\w+)\u0002/g, function (m, s, t) { t = t.toLowerCase(); return '<' + s + (t === 'h3' || t === 'h4' ? 'h3' : t) + '>'; }).replace(/(&nbsp;|\s)+/g, ' ').replace(/<p>\s*<\/p>/g, '').trim();
  };
  const SHOW = { let: ['to let', 'new instruction', 'let agreed', 'under offer', 'short let'], sale: ['for sale', 'new instruction', 'under offer', 'coming soon', 'sold stc', 'price reduction', 'new homes'] };
  const TAKEN = /let agreed|under offer|sold stc/i;
  function parse(xml, kind) {
    const out = [];
    String(xml || '').replace(/<property>([\s\S]*?)<\/property>/g, function (m, x) {
      const status = tag(x, 'status'), id = tag(x, 'id');
      if (!/^\d+$/.test(id) || tag(x, 'published') !== '1' || SHOW[kind].indexOf(status.toLowerCase()) === -1) return;
      const res = !/commercial|land/i.test(tag(x, 'category')), bedsRaw = res ? tag(x, 'bedrooms') : '', beds = /studio/i.test(bedsRaw) ? 0 : parseInt(bedsRaw, 10) || 0, type = tag(x, 'property_type') || tag(x, 'category') || 'Property';
      const street = tag(x, 'address1'), area = tag(x, 'address2'), town = tag(x, 'town'), pc = tag(x, 'postcode').toUpperCase(), outcode = pc.split(/\s+/)[0] || '';
      const lat = parseFloat(tag(x, 'latitude')), lng = parseFloat(tag(x, 'longitude'));
      const p = { id: id, kind: kind, type: type, category: tag(x, 'category'), status: status, taken: TAKEN.test(status),
        street: street, area: area && area !== town ? area : '', town: town, outcode: outcode,
        beds: beds, studio: res && (/studio/i.test(bedsRaw) || /studio/i.test(type)), commercial: !res, baths: parseInt(tag(x, 'bathrooms'), 10) || 0, receptions: parseInt(tag(x, 'receptions'), 10) || 0,
        price: parseFloat(tag(x, 'price')) || 0, qualifier: tag(x, 'price_qualifier'), short: tag(x, 'short_description').replace(/<[^>]*>/g, ''), html: cleanHtml(tag(x, 'full_details')),
        available: tag(x, 'available_date'), furnished: tag(x, 'furnished'), tenure: tag(x, 'tenure'), pets: tag(x, 'pets') === 'Yes', parking: tag(x, 'parking') === '1', garden: tag(x, 'garden') === 'Yes',
        features: tag(x, 'features').split(',').map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 20),
        lat: isFinite(lat) && Math.abs(lat) > 1 ? lat : null, lng: isFinite(lng) && Math.abs(lat) > 1 ? lng : null,
        epc: /^https:\/\//.test(tag(x, 'epc')) ? tag(x, 'epc') : '', vtour: /^https:\/\/vt\.gnomen\.co\.uk\//.test(tag(x, 'external_vtour')) ? tag(x, 'external_vtour') : '',
        images: list(x, 'images', 'image').slice(0, 40), floorplans: list(x, 'floorplans', 'floorplan').slice(0, 6), added: tag(x, 'date_added') };
      p.where = [p.street, p.area || p.town].filter(Boolean).join(', ') + (outcode ? ' ' + outcode : '');
      p.headline = (p.studio ? 'Studio' : beds ? beds + ' bedroom ' + type.toLowerCase() : (p.commercial ? 'Commercial ' + type.toLowerCase() : type)) + (kind === 'let' ? ' to rent' : ' for sale');
      p.slug = (p.where + ' ' + (p.studio ? 'studio' : p.commercial ? type : beds + ' bed ' + type)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 90);
      p.url = '/property/' + id + '/' + p.slug;
      out.push(p);
    });
    // Available first, newest first.
    return out.sort(function (a, b) { return (a.taken - b.taken) || String(b.added).localeCompare(String(a.added)); });
  }
  async function refresh() {
    for (const kind of ['sale', 'let']) {
      if (!FEEDS[kind]) continue;
      try {
        const ctl = new AbortController(), t = setTimeout(function () { ctl.abort(); }, 30000);
        const r = await fetch(FEEDS[kind], { signal: ctl.signal }); clearTimeout(t);
        const xml = await r.text();
        if (!r.ok || xml.indexOf('<properties') === -1) throw new Error('bad feed ' + r.status);
        data[kind] = parse(xml, kind);
      } catch (e) { console.error('Listings feed (' + kind + ') not read:', e.message); }   // keep the last good copy
    }
    data.at = Date.now(); data.stamp = crypto.createHash('sha1').update(JSON.stringify([data.sale.map(function (p) { return p.id + p.status + p.price; }), data.let.map(function (p) { return p.id + p.status + p.price; })])).digest('hex').slice(0, 12);
  }
  if (FEEDS.sale || FEEDS.let) { setTimeout(refresh, 3000); setInterval(refresh, 15 * 60000).unref(); }
  const find = function (id) { return data.let.find(function (p) { return p.id === id; }) || data.sale.find(function (p) { return p.id === id; }); };

  // ---------- Photos: resized and cached ----------
  const imgCache = new Map(), inflight = new Map(), WIDTHS = [480, 800, 1200, 1600];
  app.get('/listing-img/:id/:n.webp', async function (req, res) {
    const p = find(req.params.id), n = req.params.n, w = WIDTHS.indexOf(parseInt(req.query.w, 10)) !== -1 ? parseInt(req.query.w, 10) : 800;
    const src = !p ? '' : /^fp\d+$/.test(n) ? p.floorplans[+n.slice(2)] : n === 'epc' ? p.epc : /^\d+$/.test(n) ? p.images[+n] : '';
    if (!src) return res.status(404).end();
    if (!sharp) return res.redirect(302, src);
    const key = src + '|' + w;
    const send = function (buf) { res.setHeader('Cache-Control', 'public, max-age=604800'); res.type('image/webp'); res.end(buf); };
    if (imgCache.has(key)) { const b = imgCache.get(key); imgCache.delete(key); imgCache.set(key, b); return send(b); }
    try {
      if (!inflight.has(key)) inflight.set(key, (async function () {
        const r = await fetch(src); if (!r.ok) throw new Error('photo ' + r.status);
        const buf = Buffer.from(await r.arrayBuffer());
        return sharp(buf).rotate().resize({ width: w, withoutEnlargement: true }).webp({ quality: n === 'epc' || /^fp/.test(n) ? 85 : 76 }).toBuffer();
      })().finally(function () { inflight.delete(key); }));
      const out = await inflight.get(key);
      imgCache.set(key, out); while (imgCache.size > 400) imgCache.delete(imgCache.keys().next().value);
      send(out);
    } catch (e) { res.redirect(302, src); }
  });
  const pic = function (p, n, sizes, alt, extra) {
    const u = '/listing-img/' + p.id + '/' + n + '.webp?w=';
    return '<img src="' + u + '800" srcset="' + u + '480 480w, ' + u + '800 800w, ' + u + '1200 1200w" sizes="' + sizes + '" alt="' + esc(alt) + '" width="800" height="533"' + (extra || ' loading="lazy" decoding="async"') + '>';
  };

  // ---------- Formatting ----------
  const gbp = function (n) { return '£' + Math.round(n).toLocaleString('en-GB'); };
  const QUAL = { 'oieo': 'Offers in excess of', 'oiro': 'Offers in the region of', 'ono': 'Or nearest offer' };
  function priceHtml(p) {
    if (p.kind === 'let') return '<b>' + gbp(p.price) + '</b> <span>pcm</span> <small>' + gbp(p.price * 12 / 52) + ' pw</small>';
    const q = p.qualifier ? (QUAL[p.qualifier.toLowerCase()] || p.qualifier) : '';
    return (q ? '<small class="q">' + esc(q) + '</small> ' : '') + '<b>' + gbp(p.price) + '</b>';
  }
  const day = function (d) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || ''); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null; };
  const longDay = function (d) { return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }); };
  function availText(p) { const d = day(p.available); return p.kind !== 'let' || !d ? '' : d <= new Date() ? 'Available now' : 'Available ' + longDay(d); }
  const ICON = {
    bed: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 18v-6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6M3 14h18M6 10V7a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3M3 18v2M21 18v2"/></svg>',
    bath: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16v3a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4v-3zM6 12V6a2 2 0 0 1 4 0M7 19l-1 2M17 19l1 2"/></svg>',
    sofa: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11V8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3M2 13a2 2 0 0 1 4 0v2h12v-2a2 2 0 0 1 4 0v5H2v-5zM5 18v2M19 18v2"/></svg>' };
  const facts = function (p) {
    return (p.commercial ? '' : '<span>' + ICON.bed + (p.studio ? 'Studio' : p.beds + ' bed' + (p.beds === 1 ? '' : 's')) + '</span>') + (p.baths ? '<span>' + ICON.bath + p.baths + ' bath' + (p.baths === 1 ? '' : 's') + '</span>' : '') + (p.receptions ? '<span>' + ICON.sofa + p.receptions + ' reception' + (p.receptions === 1 ? '' : 's') + '</span>' : '');
  };
  function card(p, sizes) {
    return '<a class="lcard" href="' + esc(p.url) + '" data-k="' + p.kind + '" data-beds="' + p.beds + '" data-price="' + Math.round(p.price) + '" data-taken="' + (p.taken ? 1 : 0) + '" data-added="' + esc(p.added) + '" data-q="' + esc((p.where + ' ' + p.type + ' ' + p.town).toLowerCase()) + '">' +
      '<div class="lph">' + (p.images.length ? pic(p, 0, sizes || '(max-width: 640px) 100vw, (max-width: 1060px) 50vw, 380px', p.headline + ', ' + p.where) : '<div class="noph">Photos coming soon</div>') +
      '<span class="lst' + (p.taken ? ' taken' : '') + '">' + esc(p.status) + '</span>' + (p.images.length > 1 ? '<span class="lcount">📷 ' + p.images.length + '</span>' : '') + '</div>' +
      '<div class="lbody"><div class="lprice">' + priceHtml(p) + '</div><h3>' + esc(p.headline) + '</h3><p class="lwhere">' + esc(p.where) + '</p><div class="lfacts">' + facts(p) + '</div>' +
      (availText(p) ? '<p class="lavail">' + esc(availText(p)) + '</p>' : '') + '</div></a>';
  }

  // ---------- Pages ----------
  const KIND = { let: { path: '/properties-to-rent', h1: 'Properties to rent', kicker: 'To rent', none: 'to rent' }, sale: { path: '/properties-for-sale', h1: 'Properties for sale', kicker: 'For sale', none: 'for sale' } };
  function listPage(req, res, kind) {
    const K = KIND[kind], items = LIVE ? data[kind] : [], avail = items.filter(function (p) { return !p.taken; }).length;
    const prices = kind === 'let' ? [1000, 1250, 1500, 1750, 2000, 2500, 3000, 4000, 5000] : [250000, 300000, 400000, 500000, 600000, 750000, 1000000, 1500000, 2000000];
    const body = '<div class="phead small"><div class="wrap"><span class="eyebrow"><i></i> ' + K.kicker + ' · London</span><h1>' + K.h1 + '</h1>' +
      '<p class="lead">' + (items.length ? avail + ' available now' + (items.length > avail ? ' · ' + (items.length - avail) + ' ' + (kind === 'let' ? 'let agreed or under offer' : 'under offer or sold STC') : '') + '. Updated throughout the day.' : 'New properties are coming soon.') + '</p></div></div>' +
      (items.length ? '<section class="lsec"><div class="wrap"><form class="lfilter" id="lFilter" onsubmit="return false" role="search" aria-label="Filter properties">' +
        '<label class="lf-q">Area or postcode<input type="search" name="q" placeholder="e.g. SE1, Camberwell" autocomplete="off"></label>' +
        '<label>Bedrooms<select name="beds"><option value="">Any</option><option value="0">Studio+</option><option value="1">1+</option><option value="2">2+</option><option value="3">3+</option><option value="4">4+</option></select></label>' +
        '<label>Max price<select name="max"><option value="">No max</option>' + prices.map(function (v) { return '<option value="' + v + '">' + gbp(v) + (kind === 'let' ? ' pcm' : '') + '</option>'; }).join('') + '</select></label>' +
        '<label>Sort<select name="sort"><option value="new">Newest</option><option value="low">Lowest price</option><option value="high">Highest price</option></select></label>' +
        '<label class="lf-chk"><input type="checkbox" name="all" checked> Include ' + (kind === 'let' ? 'let agreed' : 'under offer') + '</label></form>' +
        '<p class="lcountline" id="lCount" aria-live="polite"></p><div class="lgrid" id="lGrid">' + items.map(function (p) { return card(p); }).join('') + '</div>' +
        '<div class="lnone" id="lNone" hidden><h3>No properties match those filters</h3><p>Try widening your search — or tell us what you’re looking for and we’ll let you know when something comes up.</p><a class="btn red" href="/contact?topic=' + (kind === 'let' ? 'Looking%20to%20rent' : 'Buying') + '">Tell us what you need →</a></div></div></section>'
      : '<section class="white"><div class="wrap" style="text-align:center;max-width:640px"><h2>Our list of properties ' + K.none + ' is on its way</h2><p class="sub" style="margin:0 auto 24px">Tell us what you’re looking for and we’ll let you know about suitable homes — or call us on 0207 096 8131.</p><a class="btn red" href="/contact?topic=' + (kind === 'let' ? 'Looking%20to%20rent' : 'Buying') + '">Tell us what you need →</a></div></section>') +
      '<section><div class="wrap"><div class="band"><div><h2>' + (kind === 'let' ? 'Got a property to let?' : 'Thinking of selling?') + '</h2><p>Get a free, no-obligation valuation from our local team.</p></div><div class="btns"><a class="btn red" href="' + (kind === 'let' ? '/landlords#valuation' : '/sales#sales-valuation') + '">Free valuation →</a><a class="btn ghost" href="tel:02070968131">📞 0207 096 8131</a></div></div></div></section>';
    const ld = items.length ? [{ '@type': 'ItemList', name: K.h1 + ' in London', numberOfItems: items.length, itemListElement: items.slice(0, 50).map(function (p, i) { return { '@type': 'ListItem', position: i + 1, url: opts.siteUrl + p.url, name: p.headline + ', ' + p.where }; }) }] : [];
    opts.send(req, res, { canon: K.path, crumb: K.h1, title: K.h1 + ' in London | Residential Realtors', desc: (kind === 'let' ? 'Flats and houses to rent in London from Residential Realtors' : 'Homes for sale in London from Residential Realtors') + ' — photos, floorplans, prices and availability, updated throughout the day.', ld: ld, name: 'list-' + kind, stamp: data.stamp, robots: items.length ? '' : 'noindex, follow' }, body);
  }
  app.get(['/properties-to-rent', '/to-rent', '/rent', '/lettings', '/properties'], function (req, res) { listPage(req, res, 'let'); });
  app.get(['/properties-for-sale', '/for-sale', '/buy'], function (req, res) { listPage(req, res, 'sale'); });

  app.get(['/property/:id', '/property/:id/*'], function (req, res) {
    const p = LIVE ? find(String(req.params.id)) : null;
    if (!p) {
      res.status(404);
      return opts.send(req, res, { canon: '/properties-to-rent', title: 'Property no longer available | Residential Realtors', desc: 'This property is no longer on the market.', robots: 'noindex, follow', name: '404' },
        '<div class="phead small"><div class="wrap"><span class="eyebrow"><i></i> Properties</span><h1>This property is no longer available</h1><p class="lead">It may have been let or sold. Have a look at what’s on the market now.</p><div class="btns"><a class="btn red" href="/properties-to-rent">Properties to rent →</a><a class="btn ghost" href="/properties-for-sale">Properties for sale</a></div></div></div>');
    }
    if (req.path !== p.url) return res.redirect(301, p.url);   // old or changed address → the current one
    const K = KIND[p.kind], n = p.images.length, mapQ = p.lat != null ? p.lat + ',' + p.lng : encodeURIComponent(p.where);
    const view = '/contact?topic=' + (p.kind === 'let' ? 'Looking%20to%20rent' : 'Buying') + '&address=' + encodeURIComponent(p.where) + '&ref=' + p.id;
    const offer = '/offer?p=' + encodeURIComponent(p.where);
    const share = encodeURIComponent(p.headline + ', ' + p.where + ' — ' + opts.siteUrl + p.url);
    const extras = [p.furnished ? (p.furnished === 'Full' ? 'Furnished' : p.furnished) : '', p.tenure, p.parking ? 'Parking' : '', p.garden ? 'Garden' : '', p.kind === 'let' ? (p.pets ? 'Pets considered' : '') : ''].filter(Boolean);
    const body = '<div class="pdhead"><div class="wrap"><nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a> › <a href="' + K.path + '">' + K.h1 + '</a> › <span>' + esc(p.where) + '</span></nav></div></div>' +
      '<section class="pd"><div class="wrap">' +
      (n ? '<div class="gal" id="gal"><div class="gtrack" id="gTrack">' + p.images.map(function (u, i) { return '<figure>' + pic(p, i, '(max-width: 1100px) 100vw, 1100px', p.headline + ' — photo ' + (i + 1) + ' of ' + n, i === 0 ? ' fetchpriority="high" decoding="async"' : ' loading="lazy" decoding="async"') + '</figure>'; }).join('') + '</div>' +
        (n > 1 ? '<button class="gbtn prev" type="button" aria-label="Previous photo">‹</button><button class="gbtn next" type="button" aria-label="Next photo">›</button><span class="gnum" id="gNum">1 / ' + n + '</span>' : '') +
        '<span class="lst' + (p.taken ? ' taken' : '') + '">' + esc(p.status) + '</span></div>' : '') +
      '<div class="pdgrid"><div class="pdmain">' +
        '<div class="lprice big">' + priceHtml(p) + '</div><h1>' + esc(p.headline) + '</h1><p class="pdwhere">📍 ' + esc(p.where) + '</p>' +
        '<div class="lfacts big">' + facts(p) + '</div>' + (availText(p) ? '<p class="lavail">' + esc(availText(p)) + '</p>' : '') +
        (extras.length ? '<div class="tagrow">' + extras.map(function (t) { return '<span>' + esc(t) + '</span>'; }).join('') + '</div>' : '') +
        (p.html ? '<h2>About this property</h2><div class="pddesc">' + p.html + '</div>' : (p.short ? '<h2>About this property</h2><p class="pddesc">' + esc(p.short) + '</p>' : '')) +
        (p.features.length ? '<h2>Key features</h2><ul class="ticks cols2">' + p.features.map(function (f) { return '<li>' + esc(f) + '</li>'; }).join('') + '</ul>' : '') +
        (p.floorplans.length ? '<h2>Floorplan</h2>' + p.floorplans.map(function (u, i) { return '<a class="pdplan" href="/listing-img/' + p.id + '/fp' + i + '.webp?w=1600" target="_blank" rel="noopener">' + pic(p, 'fp' + i, '(max-width: 900px) 100vw, 700px', 'Floorplan ' + (i + 1)) + '</a>'; }).join('') : '') +
        (p.epc ? '<h2>Energy performance (EPC)</h2><a class="pdplan epc" href="/listing-img/' + p.id + '/epc.webp?w=1200" target="_blank" rel="noopener">' + pic(p, 'epc', '(max-width: 900px) 100vw, 520px', 'EPC energy rating chart') + '</a>' : '') +
        '<h2>Location</h2><iframe class="map" title="Map of ' + esc(p.where) + '" src="https://maps.google.com/maps?q=' + mapQ + '&amp;z=15&amp;output=embed" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe><p class="mapnote">The map shows the approximate location.</p>' +
      '</div><aside class="pdside"><div class="pdbox">' +
        '<div class="lprice">' + priceHtml(p) + '</div><p class="pdsideh">' + esc(p.headline) + '</p>' +
        '<a class="btn red" href="' + esc(view) + '">Book a viewing</a>' + (p.kind === 'let' ? '<a class="btn navy" href="' + esc(offer) + '">Make an offer</a>' : '<a class="btn navy" href="' + esc(view) + '">Make an enquiry</a>') +
        '<a class="btn line" href="tel:02070968131">📞 0207 096 8131</a>' + (p.vtour ? '<a class="btn line" href="' + esc(p.vtour) + '" target="_blank" rel="noopener">🎥 Virtual tour</a>' : '') +
        '<a class="pdshare" href="https://wa.me/?text=' + share + '" target="_blank" rel="noopener">Share on WhatsApp</a><p class="pdref">Ref. ' + esc(p.id) + '</p></div></aside></div></div></section>' +
      '<div class="pdbar"><a class="btn red" href="' + esc(view) + '">Book a viewing</a>' + (p.kind === 'let' ? '<a class="btn navy" href="' + esc(offer) + '">Make an offer</a>' : '<a class="btn navy" href="tel:02070968131">📞 Call us</a>') + '</div>' +
      (function () { const more = data[p.kind].filter(function (x) { return x.id !== p.id && !x.taken; }).slice(0, 3); return more.length ? '<section class="white"><div class="wrap"><div class="head"><h2>More ' + K.none + '</h2></div><div class="lgrid">' + more.map(function (x) { return card(x); }).join('') + '</div><p style="margin-top:22px"><a class="btn line" href="' + K.path + '">See all ' + K.h1.toLowerCase() + ' →</a></p></div></section>' : ''; })();
    const ld = [{ '@type': 'RealEstateListing', name: p.headline + ', ' + p.where, url: opts.siteUrl + p.url, datePosted: String(p.added).slice(0, 10) || undefined, description: p.short || undefined,
      image: p.images.slice(0, 6), offers: { '@type': 'Offer', price: Math.round(p.price), priceCurrency: 'GBP', availability: p.taken ? 'https://schema.org/LimitedAvailability' : 'https://schema.org/InStock', businessFunction: p.kind === 'let' ? 'http://purl.org/goodrelations/v1#LeaseOut' : 'http://purl.org/goodrelations/v1#Sell', seller: { '@id': opts.siteUrl + '/#agency' } },
      about: { '@type': p.type === 'House' ? 'House' : 'Apartment', numberOfRooms: p.beds || undefined, numberOfBedrooms: p.beds, numberOfBathroomsTotal: p.baths || undefined, address: { '@type': 'PostalAddress', streetAddress: p.street, addressLocality: p.area || p.town, postalCode: p.outcode, addressCountry: 'GB' },
        geo: p.lat != null ? { '@type': 'GeoCoordinates', latitude: +p.lat.toFixed(3), longitude: +p.lng.toFixed(3) } : undefined } }];
    opts.send(req, res, { canon: p.url, crumb: K.h1, crumbUrl: K.path, crumb2: p.where, title: p.headline + ' in ' + p.where + ' | Residential Realtors', desc: (p.short || p.headline + ' in ' + p.where).slice(0, 155),
      ogImg: n ? opts.siteUrl + '/listing-img/' + p.id + '/0.webp?w=1200' : '', ld: ld, name: 'p' + p.id, stamp: data.stamp, preload: n ? '/listing-img/' + p.id + '/0.webp?w=800' : '' }, body);
  });

  return {
    live: function () { return LIVE && (data.let.length + data.sale.length) > 0; },
    stamp: function () { return data.stamp; },
    // A few of the latest, for the home page.
    featured: function () {
      if (!LIVE) return '';
      const pick = data.let.filter(function (p) { return !p.taken; }).slice(0, 3).concat(data.sale.filter(function (p) { return !p.taken; }).slice(0, 3));
      if (!pick.length) return '';
      return '<section><div class="wrap"><div class="head center"><p class="kicker">On the market</p><h2>Latest properties</h2><p class="sub">Homes to rent and for sale, straight from our listings.</p></div><div class="lgrid">' + pick.map(function (p) { return card(p); }).join('') + '</div>' +
        '<div class="btns" style="justify-content:center;margin-top:26px">' + (data.let.length ? '<a class="btn navy" href="/properties-to-rent">All properties to rent →</a>' : '') + (data.sale.length ? '<a class="btn line" href="/properties-for-sale">All properties for sale →</a>' : '') + '</div></div></section>';
    },
    urls: function () { return LIVE ? data.let.concat(data.sale).map(function (p) { return p.url; }) : []; }
  };
};
