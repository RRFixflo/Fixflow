const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Read email settings from the environment, never hardcoded — set these in
// Railway under Settings -> Variables:
//   RESEND_API_KEY   (required)  the API key from your Resend account
//   REPORT_TO_EMAIL   (optional) defaults to jayk@residentialrealtors.co.uk
//   REPORT_FROM_EMAIL (optional) must be on a domain verified in Resend;
//                                 defaults to Resend's shared test sender,
//                                 which only works for quick testing.
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const REPORT_TO_EMAIL = process.env.REPORT_TO_EMAIL || 'jayk@residentialrealtors.co.uk';
const REPORT_FROM_EMAIL = process.env.REPORT_FROM_EMAIL || 'Repair Reports <onboarding@resend.dev>';

// AI tips / translation / urgency-opinion settings — set in Railway under
// Settings -> Variables. Set ONE of these keys; if both are set, Gemini is used.
//   GEMINI_API_KEY    free key from aistudio.google.com (free tier, no card)
//   GEMINI_MODEL      (optional) defaults to Google's current Flash model
//   ANTHROPIC_API_KEY paid key from console.anthropic.com
//   ANTHROPIC_MODEL   (optional) defaults to a fast, inexpensive model
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
// Free-tier Gemini models are often briefly "experiencing high demand" (503) or
// rate limited (429), so each request walks this list until one answers. Names
// Google doesn't recognise (404) are simply skipped (Google retires numbered
// models; the 2.5 ones went in September 2026). The Lite models come first:
// the full Flash model took up to 52s for a few short tips in live use, while
// Lite answers in a few seconds and is plenty for this. GEMINI_MODEL, if set, is
// tried first.
const GEMINI_MODELS = (process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL] : []).concat([
  'gemini-flash-lite-latest',
  'gemini-3.5-flash-lite',
  'gemini-flash-latest',
  'gemini-3.8-flash'
]).filter(function (m, i, all) { return all.indexOf(m) === i; });
// How long one model gets before we give up on it and try the next. Translations
// (JSON) return far more text than tips, so they get longer.
// Staff requests (Ask Fixflow, invoices) send long prompts and get JSON back.
const GEMINI_TIMEOUT_MS = { text: 12000, json: 45000 };

// The same issue always produces the same prompt (and the same page produces the
// same translation prompt), so answers are remembered: repeat views are instant
// and don't use up the free allowance. Oldest entries are dropped past the cap.
const AI_CACHE_MAX = 300;
const aiCache = new Map();
function aiCacheGet(key) { return aiCache.get(key); }
function aiCacheSet(key, value) {
  aiCache.set(key, value);
  if (aiCache.size > AI_CACHE_MAX) aiCache.delete(aiCache.keys().next().value);
}
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
// Keys made outside a workspace must name one (Anthropic console -> Settings -> Workspaces).
const ANTHROPIC_WORKSPACE_ID = process.env.ANTHROPIC_WORKSPACE_ID || '';

// Address lookup settings — set in Railway under Settings -> Variables:
//   GETADDRESS_API_KEY (required for address lookup) your key from getaddress.io.
// It is only ever used here on the server, never sent to the browser.
const GETADDRESS_API_KEY = process.env.GETADDRESS_API_KEY || '';

// This endpoint has no login of its own (same as the rest of the tool), so it is
// reachable by anyone with the link — and unlike email, every call here costs
// real money against your Anthropic key. A simple per-IP hourly cap keeps a bad
// actor (or a stuck retry loop) from running up a bill; it does not affect normal
// tenant use, which is at most a handful of AI calls per report.
app.set('trust proxy', true);
// Always use the secure address: Railway passes on how the visitor connected, so
// plain http visits are sent to https and browsers are told to stick to https.
// Browsers keep the security state of a saved copy, so copies saved while the
// offers address was getting its certificate stayed "Not secure". On that address
// always send fresh copies (the pages are small), so old saved copies are replaced.
const OFFERS_HOSTNAME = (function () { try { return new URL(process.env.OFFER_ORIGIN || '').hostname; } catch (e) { return ''; } })();
app.use(function (req, res, next) {
  if (OFFERS_HOSTNAME && req.hostname === OFFERS_HOSTNAME) { delete req.headers['if-none-match']; delete req.headers['if-modified-since']; }
  if (req.get('x-forwarded-proto') === 'http' && req.method === 'GET') return res.redirect(301, 'https://' + req.get('host') + req.originalUrl);
  if (req.secure) { res.setHeader('Strict-Transport-Security', 'max-age=31536000'); res.setHeader('Content-Security-Policy', 'upgrade-insecure-requests'); }
  next();
});
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX_PER_IP = 40;
const rateLimitMap = new Map();
// Address lookups get their own, looser buckets: autocomplete fires as the tenant
// types (free on getAddress, but rate limited by them), while resolving a picked
// address costs one look-up, so that one is kept tighter.
const addressSearchLimitMap = new Map();
const addressGetLimitMap = new Map();
function allowedByRateLimit(ip, map, max) {
  map = map || rateLimitMap;
  max = max || RATE_LIMIT_MAX_PER_IP;
  const now = Date.now();
  const entry = map.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    map.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= max) return false;
  entry.count += 1;
  return true;
}

// The PDF (plus a photo or two folded into it) can be a few MB once base64-encoded,
// so the default 100kb JSON body limit needs raising.
// Photos are also sent individually (shrunk on the phone first) so staff can
// view them, which roughly doubles the size of a report with many photos.
app.use(express.json({ limit: '60mb' }));

// Smaller downloads: pages and data are sent compressed (brotli or gzip) when the
// browser accepts it — the dashboard page is ~900 KB, a few hundred KB compressed.
const zlib = require('zlib');
const fs = require('fs');
const crypto = require('crypto');
function pickEncoding(req) {
  const ae = String(req.headers['accept-encoding'] || '');
  return /\bbr\b/.test(ae) ? 'br' : /\bgzip\b/.test(ae) ? 'gzip' : null;
}
// Text responses (JSON from the API, pages built on the server) over ~1.5 KB.
app.use(function (req, res, next) {
  const send = res.send;
  res.send = function (body) {
    try {
      const enc = pickEncoding(req), type = String(res.get('Content-Type') || (typeof body === 'string' ? 'text/html' : ''));
      const isText = typeof body === 'string' || (Buffer.isBuffer(body) && /json|text|javascript|xml|svg/.test(type));
      if (enc && isText && req.method !== 'HEAD' && !res.get('Content-Encoding') && res.statusCode !== 204 && res.statusCode !== 304 && /json|text|javascript|xml|svg/.test(type || 'text/html')) {
        const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
        if (buf.length > 1500) {
          const out = enc === 'br' ? zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }) : zlib.gzipSync(buf, { level: 6 });
          if (!res.get('Content-Type')) res.type(typeof body === 'string' ? 'html' : 'bin');
          res.setHeader('Content-Encoding', enc); res.setHeader('Vary', 'Accept-Encoding'); res.setHeader('Content-Length', out.length);
          return res.end(out);
        }
      }
    } catch (err) { console.error('Compression failed:', err.message); }
    return send.call(this, body);
  };
  next();
});
// The HTML pages: compressed once per version of the file, with an ETag so an
// unchanged page is a quick "not modified".
const pageCache = {};
function sendPage(req, res, file) {
  let st; try { st = fs.statSync(file); } catch (e) { return false; }
  let c = pageCache[file];
  if (!c || c.mtime !== st.mtimeMs) {
    const raw = fs.readFileSync(file);
    c = pageCache[file] = { mtime: st.mtimeMs, raw: raw, gzip: zlib.gzipSync(raw, { level: 9 }), br: null, etag: '"' + crypto.createHash('sha1').update(raw).digest('base64').slice(0, 27) + '"' };
    zlib.brotliCompress(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 10 } }, function (err, out) { if (!err && pageCache[file] === c) c.br = out; });
  }
  res.setHeader('Cache-Control', 'no-cache'); res.setHeader('ETag', c.etag); res.setHeader('Vary', 'Accept-Encoding');
  res.type('html');
  if (req.headers['if-none-match'] === c.etag) { res.status(304).end(); return true; }
  let enc = pickEncoding(req); if (enc === 'br' && !c.br) enc = 'gzip';
  const body = enc ? c[enc] : c.raw;
  if (enc) res.setHeader('Content-Encoding', enc);
  res.setHeader('Content-Length', body.length);
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}
app.get(/^\/[\w-]+\.html$/, function (req, res, next) { if (!sendPage(req, res, path.join(__dirname, path.basename(req.path)))) next(); });

// Serve the report tool as a static file — Railway sets PORT itself, so we read it
// from the environment rather than hardcoding it.
// Pages are always re-checked, so phones pick up a new version straight away
// (images and icons can still be cached).
const noCache = function (res, p) { if (/\.html$/.test(p)) res.setHeader('Cache-Control', 'no-cache'); };
// Website photos and logos rarely change: let browsers keep them (faster pages, better search ranking).
app.use('/img', express.static(path.join(__dirname, 'img'), { maxAge: '30d', index: false }));
app.use(express.static(__dirname, { setHeaders: noCache, index: false }));

// On the offers address (e.g. offers.residentialrealtors.co.uk) the home page is the offer form.
const OFFER_HOST = (function () { try { return new URL(process.env.OFFER_ORIGIN || '').hostname; } catch (e) { return ''; } })();
// On the website's own address (residentialrealtors.co.uk, or SITE_HOSTS), the home page is the website.
const SITE_HOSTS = (process.env.SITE_HOSTS || 'residentialrealtors.co.uk,www.residentialrealtors.co.uk').split(',').map(function (h) { return h.trim().toLowerCase(); }).filter(Boolean);
app.get('/', (req, res, next) => { if (SITE_HOSTS.indexOf(String(req.hostname || '').toLowerCase()) !== -1) return sendSite(req, res, 'home'); next(); });
app.get('/', (req, res) => { if (OFFER_HOST && req.hostname === OFFER_HOST) return res.redirect(302, '/offer' + (req.originalUrl.indexOf('?') !== -1 ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '')); sendPage(req, res, path.join(__dirname, 'index.html')); });

// Staff dashboard for managing jobs (see jobs.js); its API needs ADMIN_PASSWORD.
app.get('/admin', (req, res) => { sendPage(req, res, path.join(__dirname, 'admin.html')); });
// Staff who only handle offers sign in here (with the offers staff password).
app.get('/staff', (req, res) => { sendPage(req, res, path.join(__dirname, 'admin.html')); });
// Applicants' offer / holding deposit form (the link given to applicants).
app.get('/offer', (req, res) => { sendPage(req, res, path.join(__dirname, 'offer.html')); });
// Public page for landlords: our services, free calculators and a valuation request form.
// ---------- The Residential Realtors website ----------
// Each page's content is in site/<name>.html; every page shares the same menu and footer.
const SITE_URL = String(process.env.SITE_URL || 'https://www.residentialrealtors.co.uk').replace(/\/+$/, '');
const SITE_PAGES = {
  home: { paths: ['/home'], canon: '/', title: 'Estate Agents & Letting Agents in London SE1 | Residential Realtors', desc: 'London estate and letting agents in SE1. Free sales and rental valuations, property sales, tenant find, rent collection and full management — ARLA Propertymark protected with Client Money Protection.', img: 'home-living' },
  sales: { paths: ['/sales', '/selling', '/sell'], canon: '/sales', crumb: 'Sales', title: 'Sell Your Home in London: Free Sales Valuation | Residential Realtors Estate Agents', desc: 'Selling your home in London? Free, no-obligation sales valuation, professional marketing, accompanied viewings and sale progression from Residential Realtors, SE1.', img: 'home-living' },
  tenants: { paths: ['/tenants'], canon: '/tenants', crumb: 'Tenants', title: 'Renting in London: Report a Repair, Tenant Fees & Offers | Residential Realtors', desc: 'Report a repair online 24/7, make an offer and see our tenant fees. Renting with Residential Realtors, London SE1 — no hidden fees.', img: 'family' },
  about: { paths: ['/about', '/about-us'], canon: '/about', crumb: 'About us', title: 'About Residential Realtors | ARLA Propertymark Letting Agent, London SE1', desc: 'A modern London letting and property management agency at 28-30 Harper Road, SE1. ARLA Propertymark member with Client Money Protection and The Property Ombudsman redress.', img: 'taxis', imgW: 1860 },
  contact: { paths: ['/contact'], canon: '/contact', crumb: 'Contact', title: 'Contact Residential Realtors | Letting Agent, Harper Road, London SE1 6AD', desc: 'Call 0207 096 8131, email or message Residential Realtors — 28-30 Harper Road, London SE1 6AD.', img: 'home-living' },
  privacy: { paths: ['/privacy'], canon: '/privacy', crumb: 'Privacy', title: 'Privacy notice | Residential Realtors', desc: 'How Residential Realtors uses the details you give us.' },
  landlords: { canon: '/landlords', crumb: 'Landlords', title: 'Landlords: Free Rental Valuation & Property Management in London | Residential Realtors', desc: 'Let your London property with Residential Realtors: tenant find, rent collection or full management, free rental valuations and free buy-to-let calculators.' }
};
const siteEsc = function (v) { return String(v).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
// The agency, for search engines (shown in Google's business details).
const SITE_ORG = { '@type': 'RealEstateAgent', '@id': SITE_URL + '/#agency', name: 'Residential Realtors', legalName: 'Estallion Investments Ltd', url: SITE_URL + '/',
  logo: SITE_URL + '/logo.png', image: SITE_URL + '/img/og-image.jpg', telephone: '+44 20 7096 8131', email: 'info@residentialrealtors.co.uk',
  address: { '@type': 'PostalAddress', streetAddress: '28-30 Harper Road', addressLocality: 'London', postalCode: 'SE1 6AD', addressCountry: 'GB' },
  areaServed: { '@type': 'City', name: 'London' },
  openingHoursSpecification: [{ '@type': 'OpeningHoursSpecification', dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'], opens: '09:00', closes: '19:00' }], knowsAbout: ['Property sales', 'Lettings', 'Property management', 'Rent collection', 'Tenant find', 'Sales valuations', 'Rental valuations'],
  identifier: { '@type': 'PropertyValue', propertyID: 'Companies House', value: '08760284' },
  memberOf: [{ '@type': 'Organization', name: 'ARLA Propertymark', url: 'https://www.propertymark.co.uk' }, { '@type': 'Organization', name: 'The Property Ombudsman', url: 'https://www.tpos.co.uk' }] };
// <head>: title, description, canonical address, social sharing cards and structured data.
function siteHead(name, body) { return siteHeadFor(SITE_PAGES[name], body); }
// pg: { canon, title, desc, crumb (+ crumbUrl, crumb2), img (hero to preload), ogImg, ld (more structured data), robots, preload }
function siteHeadFor(pg, body) {
  const url = SITE_URL + pg.canon, img = pg.ogImg || SITE_URL + '/img/og-image.jpg';
  const graph = [SITE_ORG, { '@type': 'WebPage', '@id': url + '#page', url: url, name: pg.title, description: pg.desc, inLanguage: 'en-GB', isPartOf: { '@type': 'WebSite', '@id': SITE_URL + '/#site', url: SITE_URL + '/', name: 'Residential Realtors' }, about: { '@id': SITE_URL + '/#agency' } }];
  if (pg.crumb) graph.push({ '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Home', item: SITE_URL + '/' }, { '@type': 'ListItem', position: 2, name: pg.crumb, item: SITE_URL + (pg.crumbUrl || pg.canon) }].concat(pg.crumb2 ? [{ '@type': 'ListItem', position: 3, name: pg.crumb2, item: url }] : []) });
  if (pg.ld) graph.push.apply(graph, pg.ld);
  // Questions and answers on the page (<details>) as an FAQ.
  const faq = []; String(body || '').replace(/<details><summary>([\s\S]*?)<\/summary><p>([\s\S]*?)<\/p><\/details>/g, function (m, q, a) { faq.push({ '@type': 'Question', name: q.replace(/<[^>]+>/g, ''), acceptedAnswer: { '@type': 'Answer', text: a.replace(/<[^>]+>/g, '') } }); });
  if (faq.length) graph.push({ '@type': 'FAQPage', mainEntity: faq });
  return '<title>' + siteEsc(pg.title) + '</title><meta name="description" content="' + siteEsc(pg.desc) + '"><link rel="canonical" href="' + url + '">' +
    '<meta name="robots" content="' + (pg.robots || 'index, follow, max-image-preview:large') + '"><meta name="theme-color" content="#0b1f3a">' +
    '<meta property="og:type" content="website"><meta property="og:site_name" content="Residential Realtors"><meta property="og:locale" content="en_GB">' +
    '<meta property="og:title" content="' + siteEsc(pg.title) + '"><meta property="og:description" content="' + siteEsc(pg.desc) + '"><meta property="og:url" content="' + url + '">' +
    '<meta property="og:image" content="' + img + '"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="' + (pg.ogImg ? siteEsc(pg.title) : 'Residential Realtors branded London taxis') + '">' +
    '<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="' + siteEsc(pg.title) + '"><meta name="twitter:description" content="' + siteEsc(pg.desc) + '"><meta name="twitter:image" content="' + img + '">' +
    '<link rel="icon" href="/apple-touch-icon.png"><link rel="apple-touch-icon" href="/apple-touch-icon.png">' +
    (pg.preload ? '<link rel="preload" as="image" href="' + siteEsc(pg.preload) + '" fetchpriority="high">' : '') +
    (pg.img ? '<link rel="preload" as="image" href="/img/' + pg.img + '.webp" imagesrcset="/img/' + pg.img + '-sm.webp 800w, /img/' + pg.img + '.webp ' + (pg.imgW || 1600) + 'w" imagesizes="100vw" fetchpriority="high">' : '') +
    '<script type="application/ld+json">' + JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(/</g, '\\u003c') + '</script>';
}
const SITE_FONTS = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet">';
const WRENCH = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>';
// The menu (with "Report a repair" always one tap away) and footer shared by every website page.
function siteHeader(name, home, req) {
  const props = listings && listings.show(req) ? [['/properties-for-sale', 'Buy', 'list-sale'], ['/properties-to-rent', 'Rent', 'list-let']] : [[home, 'Home', 'home']];
  const nav = props.concat([['/sales', 'Sell', 'sales'], ['/landlords', 'Landlords', 'landlords'], ['/tenants', 'Tenants', 'tenants'], ['/about', 'About', 'about'], ['/contact', 'Contact', 'contact']])
    .map(function (n) { return '<a href="' + n[0] + '"' + (n[2] === name ? ' class="on" aria-current="page"' : '') + '>' + n[1] + '</a>'; }).join('');
  return '<header class="top"><div class="wrap"><a class="brand" href="' + home + '" aria-label="Residential Realtors — home"><img src="/logo-tight.png" alt="Residential Realtors" width="122" height="38"></a>' +
    '<nav class="nav" aria-label="Main menu">' + nav + '<a class="cta" href="' + (name === 'sales' ? '/sales#sales-valuation' : '/landlords#valuation') + '">Get a valuation</a></nav>' +
    '<a class="rep" href="/report-a-repair">' + WRENCH + '<span>Report a repair</span></a>' +
    '<button class="menu-btn" type="button" aria-label="Menu" aria-expanded="false">☰</button></div></header>';
}
function siteFooter(home) {
  return '<footer><div class="wrap"><div class="cols">' +
    '<div><img src="/logo-white.png" alt="Residential Realtors" width="109" height="34" loading="lazy"><div>Estate agents, lettings and property management in London.</div><div style="margin-top:10px">28-30 Harper Road, London SE1 6AD</div><div style="margin-top:6px">Open 7 days, 9am–7pm</div></div>' +
    '<div><h4>Sell &amp; let</h4><a href="/sales">Selling your home</a><a href="/sales#sales-valuation">Sales valuation</a><a href="/landlords">Landlord services</a><a href="/landlords#valuation">Rental valuation</a><a href="/landlords#tools">Landlord tools</a></div>' +
    '<div><h4>Tenants</h4><a href="/report-a-repair">Report a repair</a><a href="/offer">Make an offer</a><a href="/tenants">Renting with us</a><a href="/tenants#fees">Tenant fees</a></div>' +
    '<div><h4>Get in touch</h4><a href="tel:02070968131">0207 096 8131</a><a href="mailto:info@residentialrealtors.co.uk">info@residentialrealtors.co.uk</a><a href="/about">About us</a><a href="/privacy">Privacy</a></div>' +
    '</div><div class="accred">' +
    '<a href="/cmp-certificate.pdf" target="_blank" rel="noopener" title="View our Client Money Protection certificate"><img src="/img/logo-cmp.webp" alt="Propertymark Client Money Protection" width="100" height="60" loading="lazy"></a>' +
    '<a href="https://www.propertymark.co.uk" target="_blank" rel="noopener" class="w"><img src="/img/logo-arla.png" alt="ARLA Propertymark Protected" width="96" height="60" loading="lazy"></a>' +
    '<a href="https://www.tpos.co.uk" target="_blank" rel="noopener"><img src="/img/logo-tpo.png" alt="The Property Ombudsman" width="159" height="60" loading="lazy"></a>' +
    '<p><b>Client Money Protection:</b> Propertymark, membership number C0130229 — <a href="/cmp-certificate.pdf" target="_blank" rel="noopener">view our certificate</a>.<br><b>Independent redress:</b> The Property Ombudsman (<a href="https://www.tpos.co.uk" target="_blank" rel="noopener">tpos.co.uk</a>). <a href="/tenants#fees">Tenant fees</a></p></div>' +
    '<div class="legal">© <span id="yr"></span> Estallion Investments Ltd trading as Residential Realtors · Registered in England, company number 08760284 · 28-30 Harper Road, London SE1 6AD.</div></div></footer>';
}
const isSiteHost = function (req) { return SITE_HOSTS.indexOf(String(req.hostname || '').toLowerCase()) !== -1; };
function siteShell(name, home, req) {
  let body = fs.readFileSync(path.join(__dirname, 'site', name + '.html'), 'utf8');
  if (name === 'home') body = body.replace('<!--FEATURED-->', listings ? listings.featured(req) : '').replace('<!--HEROSEARCH-->', heroSearch(req)).replace('<!--STATS-->', heroStats(req)).replace('<!--AREAS-->', heroAreas(req)).replace('<!--EXPERTS-->', heroExperts(req));
  return '<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
    siteHead(name, body) + SITE_FONTS + '<link rel="stylesheet" href="/site.css"></head><body>' + siteHeader(name, home, req) + '<main>' + body + '</main>' + siteFooter(home) +
    '<script src="/site.js" defer></script></body></html>';
}
// Home page: a property search (when our listings are showing), the live numbers and the areas.
const ICONS = {
  key: '<svg viewBox="0 0 48 48"><circle cx="17" cy="17" r="9"/><circle cx="17" cy="17" r="3"/><path d="m24 24 16 16M33 33l4-4M37 37l4-4"/></svg>',
  worth: '<svg viewBox="0 0 48 48"><path d="M6 22 24 7l18 15"/><path d="M10 19v21h12"/><circle cx="34" cy="34" r="9"/><path d="M36.5 30.5a3 3 0 0 0-5 2.2v4.6h5.5M30 35h4.5"/></svg>',
  rent: '<svg viewBox="0 0 48 48"><circle cx="21" cy="21" r="13"/><path d="m31 31 10 10"/><path d="M14 22 21 16l7 6M16 21v7h10v-7"/></svg>',
  buy: '<svg viewBox="0 0 48 48"><path d="M6 22 24 7l18 15"/><path d="M10 19v21h14"/><path d="m35 26 2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8Z"/></svg>'
};
function heroSearch(req) {
  const c = listings && listings.counts(req);
  const val = '<div class="hs-val"><span>Find out your home’s sales or rental value</span><a class="btn yellow" href="/sales#sales-valuation">Get a free valuation</a></div>';
  if (!c) return '<div class="hsearch">' + val.replace('class="hs-val"', 'class="hs-val solo"') + '</div>';
  return '<form class="hsearch" id="hSearch" action="/properties-to-rent" method="get" role="search">' +
    '<div class="hs-tabs" role="tablist">' + (c.sale ? '<button type="button" data-hs="buy" role="tab">Buy</button>' : '') + '<button type="button" class="on" data-hs="rent" role="tab">Rent</button></div>' +
    '<div class="hs-box"><div class="hs-row"><input name="q" aria-label="Area, street or postcode" placeholder="Find a property by area or postcode" autocomplete="off"><button class="hs-go" type="submit">Search <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg></button></div>' +
    '<div class="hs-modes"><button type="button" class="on" data-mode="list">📍 Location</button><button type="button" data-mode="map">🗺️ Map</button><button type="button" data-mode="near">➤ Near me</button></div></div>' +
    val + '</form>';
}
// The four "When you need experts" cards, with live numbers where we have them.
function heroExperts(req) {
  const c = listings && listings.counts(req);
  const card = function (ic, h, line, btn, href) { return '<a class="xcard rv" href="' + href + '"><span class="x-ic">' + ICONS[ic] + '</span><h3>' + h + '</h3><p>' + line + '</p><span class="btn yellow">' + btn + '</span></a>'; };
  return '<div class="xgrid">' +
    card('key', 'Let your property hassle-free', 'Tenant find, rent collection or full management', 'Let your property', '/landlords') +
    card('worth', 'What’s your home worth?', 'Free, no-obligation sales and rental valuations', 'Get a valuation', '/sales#sales-valuation') +
    card('rent', 'Find the right property to rent', c && c.let ? '<b>' + c.let + '</b> homes to rent right now' : 'Tell us what you’re looking for', 'Rent a property', c && c.let ? '/properties-to-rent' : '/contact?topic=Looking%20to%20rent') +
    card('buy', 'Find the right property to buy', c && c.sale ? '<b>' + c.sale + '</b> homes for sale right now' : 'Register to hear about new homes first', 'Buy a property', c && c.sale ? '/properties-for-sale' : '/contact?topic=Buying') +
    '</div>';
}
function heroStats(req) {
  const c = listings && listings.counts(req);
  if (!c || !(c.let + c.sale)) return '<p class="tb-p">Protected &amp; regulated</p>';
  return '<div class="tb-stats">' + (c.let ? '<a href="/properties-to-rent"><b>' + c.let + '</b> homes to rent now</a>' : '') + (c.sale ? '<a href="/properties-for-sale"><b>' + c.sale + '</b> for sale</a>' : '') + '<span>Protected &amp; regulated</span></div>';
}
function heroAreas(req) {
  const c = listings && listings.counts(req);
  if (!c || !c.areas.length) return '';
  return '<div class="areas"><span class="areas-h">Where our homes are right now</span><div class="areas-l">' + c.areas.map(function (a) { return '<a href="/properties-to-rent?q=' + encodeURIComponent(a.toLowerCase()) + '">' + siteEsc(a) + '</a>'; }).join('') + '</div></div>';
}
// The landlords page is its own file (calculators and valuation form); it gets the same head, menu and footer.
function landlordsShell(home, req) {
  let h = fs.readFileSync(path.join(__dirname, 'landlords.html'), 'utf8');
  h = h.replace(/<title>[\s\S]*?<link rel="icon"[^>]*>/, siteHead('landlords', h)).replace('<style>', '<link rel="stylesheet" href="/site.css">\n<style>')
    .replace(/<header class="top">[\s\S]*?<\/header>/, siteHeader('landlords', home, req)).replace(/<footer>[\s\S]*?<\/footer>/, siteFooter(home));
  return h;
}
const siteCache = {};
function sendSite(req, res, name) {
  const f = name === 'landlords' ? path.join(__dirname, 'landlords.html') : path.join(__dirname, 'site', name + '.html'); let st; try { st = fs.statSync(f); } catch (e) { return res.status(404).end(); }
  const home = isSiteHost(req) ? '/' : '/home', ck = name + home + (listings ? listings.stamp() + listings.show(req) : '');
  let c = siteCache[ck];
  if (!c || c.mtime !== st.mtimeMs) { const raw = Buffer.from(name === 'landlords' ? landlordsShell(home, req) : siteShell(name, home, req)); c = siteCache[ck] = { mtime: st.mtimeMs, raw: raw, gzip: zlib.gzipSync(raw, { level: 9 }), etag: '"s' + crypto.createHash('sha1').update(raw).digest('base64').slice(0, 26) + '"' }; }
  res.setHeader('Cache-Control', listings && listings.preview(req) ? 'private, no-store' : 'no-cache'); res.setHeader('ETag', c.etag); res.setHeader('Vary', 'Accept-Encoding, Cookie'); res.type('html');
  if (req.headers['if-none-match'] === c.etag) return res.status(304).end();
  const gz = /\bgzip\b/.test(String(req.headers['accept-encoding'] || '')); if (gz) res.setHeader('Content-Encoding', 'gzip');
  res.end(req.method === 'HEAD' ? undefined : (gz ? c.gzip : c.raw));
}
// A page built elsewhere (property listings), in the website's frame.
const builtCache = new Map();
function sendBuilt(req, res, meta, body) {
  const home = isSiteHost(req) ? '/' : '/home', ck = meta.name + home + (meta.stamp || '') + listings.show(req);
  let c = builtCache.get(ck);
  if (!c) {
    const raw = Buffer.from('<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
      siteHeadFor(meta, body) + SITE_FONTS + '<link rel="stylesheet" href="/site.css"></head><body>' + siteHeader(meta.name, home, req) + '<main>' + body + '</main>' + siteFooter(home) + '<script src="/site.js" defer></script></body></html>');
    c = { raw: raw, gzip: zlib.gzipSync(raw, { level: 6 }), etag: '"b' + crypto.createHash('sha1').update(raw).digest('base64').slice(0, 26) + '"' };
    if (res.statusCode === 200) { builtCache.set(ck, c); while (builtCache.size > 400) builtCache.delete(builtCache.keys().next().value); }
  }
  res.setHeader('Cache-Control', meta.private ? 'private, no-store' : 'no-cache'); res.setHeader('ETag', c.etag); res.setHeader('Vary', 'Accept-Encoding, Cookie'); res.type('html');
  if (res.statusCode === 200 && req.headers['if-none-match'] === c.etag) return res.status(304).end();
  const gz = /\bgzip\b/.test(String(req.headers['accept-encoding'] || '')); if (gz) res.setHeader('Content-Encoding', 'gzip');
  res.end(req.method === 'HEAD' ? undefined : (gz ? c.gzip : c.raw));
}
const listings = require('./listings')(app, { siteUrl: SITE_URL, send: sendBuilt, isStaff: function (req) { return !!(jobs && jobs.isStaff && jobs.isStaff(req)); } });
// On the website's own address, /home is the same page as / — send search engines to one address.
app.get('/home', (req, res, next) => { if (isSiteHost(req)) return res.redirect(301, '/'); next(); });
Object.keys(SITE_PAGES).forEach(function (name) { if (SITE_PAGES[name].paths) app.get(SITE_PAGES[name].paths, function (req, res) { sendSite(req, res, name); }); });
app.get(['/landlords', '/landlord-tools', '/valuation'], function (req, res) { sendSite(req, res, 'landlords'); });
app.get('/tenant-fees', (req, res) => res.redirect(301, '/tenants#fees'));
// For search engines: what to index (the public website) and what not to (staff and private links).
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send('User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /staff\nDisallow: /api/\nDisallow: /offer/\nDisallow: /landlord/\nDisallow: /reserve/\nDisallow: /portal\n\nSitemap: ' + SITE_URL + '/sitemap.xml\n');
});
app.get('/sitemap.xml', (req, res) => {
  const pages = [['/', '1.0'], ['/sales', '0.9'], ['/landlords', '0.9'], ['/tenants', '0.8'], ['/report-a-repair', '0.8'], ['/about', '0.6'], ['/contact', '0.6'], ['/offer', '0.5'], ['/privacy', '0.2']];
  res.type('application/xml').send('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    pages.concat(listings.urls().length ? [['/properties-to-rent', '0.9'], ['/properties-for-sale', '0.9']] : []).concat(listings.urls().map(function (u) { return [u, '0.7']; }))
      .map(function (x) { return '  <url><loc>' + SITE_URL + siteEsc(x[0]) + '</loc><priority>' + x[1] + '</priority></url>'; }).join('\n') + '\n</urlset>\n');
});
// The repair report (the tool tenants use) at a clear address on the website.
app.get(['/report-a-repair', '/repairs'], (req, res) => { sendPage(req, res, path.join(__dirname, 'index.html')); });
app.get('/offer/track/:token', (req, res) => { sendPage(req, res, path.join(__dirname, 'offer.html')); });
// A landlord's private link to review the agreed fees and terms, fill in the property details and sign.
app.get('/landlord/:token', (req, res) => { sendPage(req, res, path.join(__dirname, 'landlord.html')); });
app.get('/reserve/:token', (req, res) => { sendPage(req, res, path.join(__dirname, 'reserve.html')); });
// The offer for the landlord to review (no applicant contact details).
app.get('/offer/review/:token', (req, res) => { sendPage(req, res, path.join(__dirname, 'offer-review.html')); });

const jobs = require('./jobs')(app, {
  sendEmail: function (opts) { return sendViaResend(opts); },
  canEmail: function () { return !!RESEND_API_KEY; },
  // The same AI provider the tenant page uses, for drafting emails from a job.
  canAi: function () { return !!(GEMINI_API_KEY || ANTHROPIC_API_KEY); },
  // files: optional [{ mime, data (base64) }] — PDFs and photos the AI reads directly.
  askAi: function (prompt, wantJson, files) { return askAiSafe(prompt, wantJson, files); }
});

// Simple existence check the frontend can use to confirm a real backend is present
// (there is no such endpoint when this same file runs as a claude.ai artifact).
app.get('/api/health', (req, res) => {
  res.json({ ok: true, canEmail: !!RESEND_API_KEY, canAi: !!(GEMINI_API_KEY || ANTHROPIC_API_KEY), canAddress: !!GETADDRESS_API_KEY && !addressKeyRejected });
});

// Step 1 of getAddress.io Autocomplete: suggestions for what the tenant has typed
// so far (part of an address, or a postcode — all=true lists every address at a
// postcode). Proxied so the API key never reaches the browser.
// Set when getAddress turns the key down, so the page stops offering this search.
let addressKeyRejected = false;
app.get('/api/address/autocomplete', async (req, res) => {
  if (!GETADDRESS_API_KEY || addressKeyRejected) {
    return res.status(503).json({ ok: false, error: 'address-not-configured' });
  }
  if (!allowedByRateLimit(req.ip, addressSearchLimitMap, 300)) {
    return res.status(429).json({ ok: false, error: 'rate-limited' });
  }
  const term = String(req.query.term || '').trim().slice(0, 100);
  if (term.length < 3) {
    return res.json({ ok: true, suggestions: [] });
  }
  try {
    const url = 'https://api.getAddress.io/autocomplete/' + encodeURIComponent(term) +
      '?api-key=' + encodeURIComponent(GETADDRESS_API_KEY) + '&all=true&top=6';
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (resp.status === 401 || resp.status === 403) addressKeyRejected = true;
    if (!resp.ok) {
      console.error('getAddress autocomplete error:', resp.status);
      return res.status(502).json({ ok: false, error: resp.status === 429 ? 'rate-limited' : 'lookup-failed' });
    }
    const data = await resp.json();
    const suggestions = (data.suggestions || []).map(function (s) {
      return { address: String(s.address || ''), id: String(s.id || '') };
    }).filter(function (s) { return s.address && s.id; });
    return res.json({ ok: true, suggestions: suggestions });
  } catch (err) {
    console.error('address autocomplete error:', err && err.message);
    return res.status(502).json({ ok: false, error: 'lookup-failed' });
  }
});

// Step 2: resolve the suggestion the tenant picked into the full address,
// including its postcode (counts as one look-up on the getAddress account).
app.get('/api/address/get/:id', async (req, res) => {
  if (!GETADDRESS_API_KEY) {
    return res.status(503).json({ ok: false, error: 'address-not-configured' });
  }
  if (!allowedByRateLimit(req.ip, addressGetLimitMap, 60)) {
    return res.status(429).json({ ok: false, error: 'rate-limited' });
  }
  const id = String(req.params.id || '');
  if (!/^[A-Za-z0-9_=-]{1,200}$/.test(id)) {
    return res.status(400).json({ ok: false, error: 'bad-id' });
  }
  try {
    const url = 'https://api.getAddress.io/get/' + encodeURIComponent(id) +
      '?api-key=' + encodeURIComponent(GETADDRESS_API_KEY);
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) {
      console.error('getAddress get error:', resp.status);
      return res.status(502).json({ ok: false, error: resp.status === 429 ? 'rate-limited' : 'lookup-failed' });
    }
    const a = await resp.json();
    const lines = [a.line_1, a.line_2, a.line_3, a.line_4, a.locality, a.town_or_city]
      .map(function (l) { return String(l || '').trim(); })
      .filter(Boolean);
    const postcode = String(a.postcode || '').trim();
    return res.json({
      ok: true,
      address: {
        lines: lines,
        town: String(a.town_or_city || ''),
        county: String(a.county || ''),
        postcode: postcode,
        full: lines.concat(postcode ? [postcode] : []).join(', ')
      }
    });
  } catch (err) {
    console.error('address get error:', err && err.message);
    return res.status(502).json({ ok: false, error: 'lookup-failed' });
  }
});

// JSON replies are whole-page translations, which run far longer than a few tips;
// a 600-token cap cut them off mid-array and they failed to parse.
function maxOutputTokens(wantJson) { return wantJson ? 8000 : 1000; }

// Ask the AI so that a busy or slow provider never reaches the person waiting:
// Gemini first (free); if it fails, or hasn't answered after a few seconds, Claude is asked too and
// whichever answers first is used; if both fail, Gemini gets a longer go and then Claude once more.
function askAiSafe(prompt, wantJson, files) {
  if (!GEMINI_API_KEY) return askAnthropic(prompt, wantJson, files).then(function (r) { return r.ok ? r : askAnthropic(prompt, wantJson, files); });
  if (!ANTHROPIC_API_KEY) return askGemini(prompt, wantJson, false, files);
  return new Promise(function (resolve) {
    let done = false, left = 2, claudeOn = false;
    const last = async function () {
      const g = await askGemini(prompt, wantJson, false, files); if (g.ok) return resolve(g);
      resolve(await askAnthropic(prompt, wantJson, files));
    };
    const finish = function (r) { if (done) return; if (r && r.ok) { done = true; return resolve(r); } if (--left === 0) { done = true; last().catch(function () { resolve({ ok: false }); }); } };
    const claude = function (why) { if (claudeOn || done) return; claudeOn = true; console.log('Gemini ' + why + ', asking Claude too'); askAnthropic(prompt, wantJson, files).then(finish, function () { finish({ ok: false }); }); };
    askGemini(prompt, wantJson, true, files).then(function (r) { if (!r.ok) claude('unavailable'); finish(r); }, function () { claude('failed'); finish({ ok: false }); });
    setTimeout(function () { claude('slow'); }, (files && files.length) || wantJson ? 12000 : 6000).unref();
  });
}

// Claude, with one retry if it's busy (429 / 5xx / 529) or the connection drops.
async function askAnthropic(prompt, wantJson, files) {
  let r = await askAnthropicOnce(prompt, wantJson, files);
  if (!r.ok && r.retryable) { await new Promise(function (ok) { setTimeout(ok, 1500); }); r = await askAnthropicOnce(prompt, wantJson, files); }
  return r;
}
async function askAnthropicOnce(prompt, wantJson, files) {
  const content = (files && files.length) ? files.map(function (f) {
    return f.mime === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.data } }
      : { type: 'image', source: { type: 'base64', media_type: f.mime, data: f.data } };
  }).concat([{ type: 'text', text: prompt }]) : prompt;
  let resp;
  try { resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: AbortSignal.timeout(90000),
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
      ...(ANTHROPIC_WORKSPACE_ID ? { 'anthropic-workspace-id': ANTHROPIC_WORKSPACE_ID } : {})
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: maxOutputTokens(wantJson),
      messages: [{ role: 'user', content: content }]
    })
  }); } catch (err) { console.error('Anthropic request failed:', (err && err.name) || err); return { ok: false, retryable: true }; }
  if (!resp.ok) {
    const errText = await resp.text().catch(function () { return ''; });
    console.error('Anthropic API error:', resp.status, errText.slice(0, 300));
    return { ok: false, retryable: resp.status === 429 || resp.status >= 500 };
  }
  const data = await resp.json();
  return { ok: true, text: String((data.content && data.content[0] && data.content[0].text) || '').trim() };
}

// quick: one pass over the models (used when Claude is there as a backup).
async function askGemini(prompt, wantJson, quick, files) {
  // Overall budget across all models, so the tenant is never left waiting long;
  // the page gives up a little after this too.
  const deadline = Date.now() + (quick ? (wantJson ? 40000 : 15000) : (wantJson ? 100000 : 25000));
  // Google's free tier often answers "high demand" (503) from every model at
  // once for a few seconds, so go round the models again after a short pause.
  let pause = 2000;
  for (let round = 0; round < (quick ? 1 : wantJson ? 4 : 2); round++) {
    for (const model of GEMINI_MODELS) {
      if (Date.now() > deadline) return { ok: false };
      const result = await askGeminiModel(model, prompt, wantJson, files);
      if (result.ok || !result.retryable) return result;
    }
    if (Date.now() + pause > deadline) break;
    await new Promise(function (r) { setTimeout(r, pause); });
    pause *= 2;
  }
  return { ok: false };
}

async function askGeminiModel(model, prompt, wantJson, files) {
  const started = Date.now();
  let resp;
  try {
    resp = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent(model) + ':generateContent', {
      method: 'POST',
      signal: AbortSignal.timeout(wantJson ? GEMINI_TIMEOUT_MS.json : GEMINI_TIMEOUT_MS.text),
      headers: {
        'x-goog-api-key': GEMINI_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }].concat((files || []).map(function (f) { return { inline_data: { mime_type: f.mime, data: f.data } }; })) }],
        generationConfig: Object.assign(
          // Flash models may spend part of this on thinking, so leave headroom.
          { maxOutputTokens: maxOutputTokens(wantJson) * 2 },
          wantJson ? { responseMimeType: 'application/json' } : {}
        )
      })
    });
  } catch (err) {
    // Timed out (or the connection dropped): the next model may be quicker.
    console.error('Gemini request failed:', model, (err && err.name) || err, 'after', Date.now() - started, 'ms');
    return { ok: false, retryable: true };
  }
  if (!resp.ok) {
    const errText = await resp.text().catch(function () { return ''; });
    console.error('Gemini API error:', model, resp.status, errText.replace(/\s+/g, ' ').slice(0, 200));
    // Busy, rate limited, briefly down or unknown model: try the next model.
    // Anything else (e.g. a rejected key) would fail the same way on every model.
    const retryable = [404, 429, 500, 503].indexOf(resp.status) !== -1;
    return { ok: false, retryable: retryable };
  }
  const data = await resp.json();
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content &&
    data.candidates[0].content.parts) || [];
  const text = parts
    .filter(function (p) { return p && typeof p.text === 'string' && !p.thought; })
    .map(function (p) { return p.text; })
    .join('')
    .trim();
  if (!text) {
    console.error('Gemini returned no text:', model, JSON.stringify(data).slice(0, 300));
    return { ok: false, retryable: true };
  }
  console.log('Gemini ok:', model, Date.now() - started, 'ms');
  return { ok: true, text: text };
}

app.post('/api/ai', async (req, res) => {
  if (!GEMINI_API_KEY && !ANTHROPIC_API_KEY) {
    return res.status(503).json({ ok: false, error: 'ai-not-configured' });
  }
  if (!allowedByRateLimit(req.ip)) {
    return res.status(429).json({ ok: false, error: 'rate-limited' });
  }

  try {
    const body = req.body || {};
    // Translating the page sends every visible string in one prompt, so this cap
    // has to comfortably fit that; anything bigger is refused rather than cut
    // off part-way (a truncated prompt gives a broken answer, not a shorter one).
    const prompt = String(body.prompt || '');
    const wantJson = !!body.json;
    if (!prompt) {
      return res.status(400).json({ ok: false, error: 'missing-prompt' });
    }
    if (prompt.length > 40000) {
      return res.status(413).json({ ok: false, error: 'prompt-too-long' });
    }

    const cacheKey = (wantJson ? 'json:' : 'text:') + prompt;
    let text = aiCacheGet(cacheKey);
    if (text === undefined) {
      const result = await askAiSafe(prompt, wantJson);
      if (!result.ok) {
        return res.status(502).json({ ok: false, error: 'ai-provider-error' });
      }
      text = result.text;
    }

    if (wantJson) {
      const cleaned = text.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
      try {
        const parsed = JSON.parse(cleaned);
        aiCacheSet(cacheKey, text);
        return res.json({ ok: true, json: parsed });
      } catch (e) {
        return res.status(502).json({ ok: false, error: 'bad-json-from-model' });
      }
    }

    aiCacheSet(cacheKey, text);
    return res.json({ ok: true, text: text });
  } catch (err) {
    console.error('ai endpoint error:', err);
    return res.status(500).json({ ok: false, error: 'server-error' });
  }
});

app.post('/api/send-report', async (req, res) => {
  try {
    const body = req.body || {};
    const pdfBase64 = String(body.pdfBase64 || '');
    const filename = String(body.filename || 'Repair-Report.pdf').replace(/[^a-zA-Z0-9.\-_]+/g, '-');
    const reportText = String(body.reportText || '');
    const tenantEmail = String(body.tenantEmail || '').trim();
    const sendCopyToTenant = !!body.sendCopyToTenant && !!tenantEmail;

    if (!pdfBase64) {
      return res.status(400).json({ ok: false, error: 'missing-pdf' });
    }

    // 1) Save it as a job in the database (when one is connected). This is the
    // record the admin dashboard works from, so it comes first.
    let saved = null;
    try {
      saved = await jobs.saveReport(body.report, pdfBase64, filename, reportText, body.photos);
    } catch (err) {
      console.error('Saving report to database failed:', err.message);
    }

    const subject = String(body.subject || 'Repair report') + (saved ? ' [' + saved.ref + ']' : '');
    // The tenant's link to follow the repair's progress.
    const siteUrl = process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : req.protocol + '://' + req.get('host'));
    const trackUrl = saved && saved.trackPath ? siteUrl + saved.trackPath + '?w=t' : null;   // w=t: the tenant's own link

    // 2) Email it to Residential Realtors, PDF attached, when email is set up.
    let emailed = false;
    if (RESEND_API_KEY) {
      const mainResult = await sendViaResend({
        to: [REPORT_TO_EMAIL],
        subject: subject,
        text: (saved ? 'Job reference: ' + saved.ref + '\n\n' : '') + reportText,
        attachmentFilename: filename,
        attachmentBase64: pdfBase64
      });
      emailed = !!mainResult.ok;
      if (!mainResult.ok) console.error('Report email failed:', mainResult.error);
    }

    // Neither saved nor emailed: tell the page, which falls back to the tenant
    // emailing the PDF themselves.
    if (!saved && !emailed) {
      return res.status(503).json({ ok: false, error: RESEND_API_KEY ? 'resend-failed' : 'email-not-configured' });
    }

    // 3) Optionally send the tenant their own copy too, best-effort — a failure
    // here should not make the tool report failure, since the report itself
    // (the important part) already went through.
    let tenantCopySent = false;
    if (sendCopyToTenant && RESEND_API_KEY) {
      const tenantResult = await sendViaResend({
        to: [tenantEmail],
        subject: 'Your repair report — Residential Realtors' + (saved ? ' [' + saved.ref + ']' : ''),
        text: 'This is a copy of the repair report you submitted, for your own records.' +
          (saved ? ' Your reference is ' + saved.ref + '.' : '') +
          (trackUrl ? '\n\nYou can check the progress of your repair at any time here: ' + trackUrl : '') + '\n\n' + reportText,
        attachmentFilename: filename,
        attachmentBase64: pdfBase64
      });
      tenantCopySent = !!tenantResult.ok;
    }

    return res.json({ ok: true, emailed: emailed, saved: !!saved, ref: saved ? saved.ref : null, trackUrl: trackUrl, tenantCopySent: tenantCopySent });
  } catch (err) {
    console.error('send-report error:', err);
    return res.status(500).json({ ok: false, error: 'server-error' });
  }
});

async function sendViaResend(opts) {
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        // A person's name in front of our sending address, e.g. "Jo Smith - Residential Realtors <offers@...>".
        from: opts.fromName ? String(opts.fromName).replace(/[<>"\r\n]/g, '').slice(0, 80) + ' <' + ((/<([^>]+)>/.exec(REPORT_FROM_EMAIL) || [])[1] || REPORT_FROM_EMAIL) + '>' : REPORT_FROM_EMAIL,
        to: opts.to,
        cc: opts.cc && opts.cc.length ? opts.cc : undefined,
        bcc: opts.bcc && opts.bcc.length ? opts.bcc : undefined,
        reply_to: opts.replyTo || undefined,
        subject: opts.subject,
        text: opts.text,
        html: opts.html || undefined,
        attachments: opts.attachments && opts.attachments.length ? opts.attachments
          : opts.attachmentBase64 ? [{ filename: opts.attachmentFilename, content: opts.attachmentBase64 }]
          : undefined
      })
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(function () { return ''; });
      return { ok: false, error: 'HTTP ' + resp.status + ' ' + errText.slice(0, 300) };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

const httpServer = app.listen(PORT, () => {
  console.log(`Report tool running on port ${PORT}`);
});
// On a redeploy, finish the requests already running (e.g. an AI answer being written) before stopping.
process.on('SIGTERM', function () {
  console.log('Stopping: finishing requests in progress');
  httpServer.close(function () { process.exit(0); });
  setTimeout(function () { process.exit(0); }, 60000).unref();
});
