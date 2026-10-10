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
  // The bare domain goes to www (one address for search engines), keeping the page asked for.
  if (req.hostname === 'residentialrealtors.co.uk' && (req.method === 'GET' || req.method === 'HEAD')) return res.redirect(301, 'https://www.residentialrealtors.co.uk' + req.originalUrl);
  // Old Gnomen website search pages (/?id=…&action=view&jengo_…) go to our property lists.
  if (req.path === '/' && req.method === 'GET' && (req.query.jengo_property_for || req.query.action === 'view')) return res.redirect(301, String(req.query.jengo_property_for) === '1' ? '/properties-for-sale' : '/properties-to-rent');
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
// Webhooks (e.g. Rightmove's leads) are checked against the exact bytes sent, so those keep the raw body.
app.use(express.json({ limit: '60mb', verify: function (req, res, buf) { if (req.url.indexOf('/hooks/') === 0) req.rawBody = buf; } }));

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
// The app's own server code, settings and notes aren't for download — only the files pages use.
const NOT_PUBLIC = /^\/(node_modules|cloudflare)(\/|$)|^\/(server|jobs|listings|visits|tenancy|outlook|news|updates|portaldemo|areas|areas-data|svcareas|voice|calls|leads)\.js$|^\/data(\/|$)|^\/(package(-lock)?|railpack|landlord-terms)\.json$|\.md$/i;
app.use(function (req, res, next) { if (NOT_PUBLIC.test(req.path)) return res.status(404).send('Not found'); next(); });
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
let visits = null;   // set up once the jobs database is ready (below)
const SITE_PAGES = {
  home: { paths: ['/home'], canon: '/', title: 'Central London Letting Agents & Property Management | Residential Realtors', desc: 'Central London letting agents and property managers based in SE1. Free rental valuations, tenant find, rent collection and full management, plus sales — ARLA Propertymark protected with Client Money Protection.', img: 'u-london-bus' },
  sales: { paths: ['/sales', '/selling', '/sell'], canon: '/sales', crumb: 'Sales', title: 'Sell Your Home in London: Free Sales Valuation | Residential Realtors', desc: 'Selling your home in London? Free, no-obligation sales valuation, professional marketing, accompanied viewings and sale progression from Residential Realtors, SE1.', img: 'u-flat-dining' },
  checks: { img: 'u-thames', paths: ['/property-checks', '/epc-checker', '/licence-checker'], canon: '/property-checks', crumb: 'Property checks', title: 'Free EPC Checker & Property Licence Checker for London Landlords | Residential Realtors', desc: 'Check any property’s EPC rating and expiry, find out if a London rental needs a licence, do a free DIY inventory and try our landlord portal.' },
  certs: { img: 'u-flat-bedroom', paths: ['/book-certificate', '/landlord-certificates', '/certificates'], canon: '/book-certificate', crumb: 'Book a certificate', title: 'Book a Gas Safety Certificate, EICR or EPC in London | Residential Realtors', desc: 'Book your landlord Gas Safety certificate (CP12), electrical report (EICR) or EPC online in London. Choose your service, tell us how to get in, and pay securely.' },
  diy: { img: 'u-flat-plants', paths: ['/diy-inventory', '/inventory'], canon: '/diy-inventory', crumb: 'DIY inventory', title: 'DIY Inventory & Check-in Report for Landlords — £30 + VAT | Residential Realtors', desc: 'Do your own room-by-room inventory on your phone with photos, condition notes, meter readings and keys, and get a dated report. £30 + VAT. See an example report.' },
  tools: { img: 'u-phonebox', paths: ['/landlord-tools', '/tools'], canon: '/landlord-tools', crumb: 'Landlord tools', title: 'Free Landlord Tools: Rent Comparison, Calculators & Checkers | Residential Realtors', desc: 'Free tools for London landlords: compare rents, average rent by borough, buy-to-let mortgage, yield and stamp duty calculators, EPC and licence checkers.' },
  compliance: { img: 'u-flat-dining', paths: ['/landlord-compliance', '/landlord-checklist', '/compliance'], canon: '/landlord-compliance', crumb: 'Landlord compliance', title: 'Landlord Compliance Checklist for London Landlords | Residential Realtors', desc: 'Is your rental property ready to let? Free 1-minute readiness check, plus gas safety, EICR, EPC, alarms, licensing, deposits and right to rent explained, with links to the official guidance.' },
  switch: { img: 'u-london-night', paths: ['/switch-letting-agent', '/change-letting-agent'], canon: '/switch-letting-agent', crumb: 'Switch letting agent', title: 'Should You Switch Letting Agent? Free Agent Score | Residential Realtors', desc: 'Unhappy with your London letting agent? Score them in a minute, see what good management looks like, and how switching agent works — your tenancy carries on as normal.' },
  overseas: { img: 'u-thames', paths: ['/overseas-landlords', '/landlords-abroad'], canon: '/overseas-landlords', crumb: 'Overseas landlords', title: 'Letting Your London Property From Abroad | Overseas Landlords | Residential Realtors', desc: 'Live outside the UK? We find tenants for and manage Central London homes for overseas landlords — online portal, rent collection, repairs and compliance, plus the Non-Resident Landlord Scheme explained.' },
  services: { img: 'home-living', paths: ['/services', '/landlord-services'], canon: '/services', crumb: 'Landlord services', title: 'Landlord Services London: Certificates, Inventories & Licences | Residential Realtors', desc: 'Gas Safety certificates, EICRs, EPCs, DIY inventories and licence applications for London landlords — fixed prices, booked and paid online.' },
  licence: { img: 'u-westminster', paths: ['/licence-application', '/property-licence', '/hmo-licence-application'], canon: '/licence-application', crumb: 'Licence application', title: 'Property Licence Application Help in London — Free | Residential Realtors', desc: 'We prepare and submit your selective or HMO licence application and deal with the council until it’s granted. Free — you only pay the council’s fee.' },
  gas: { img: 'u-flat-kitchen', paths: ['/gas-safety-certificate', '/gas-safety', '/cp12'], canon: '/gas-safety-certificate', crumb: 'Gas Safety certificate', title: 'Landlord Gas Safety Certificate (CP12) in London — Book Online | Residential Realtors', desc: 'Book your annual landlord Gas Safety certificate (CP12) in London with a Gas Safe registered engineer. Pay online, and we arrange access with you or your tenant.' },
  eicr: { img: 'u-flat-living', paths: ['/eicr', '/eicr-certificate', '/electrical-safety-certificate'], canon: '/eicr', crumb: 'EICR', title: 'EICR Electrical Safety Certificate for London Landlords | Residential Realtors', desc: 'Book a landlord EICR (Electrical Installation Condition Report) in London, priced by property size. Pay online, and we arrange access with you or your tenant.' },
  epc: { img: 'u-flat-bright', paths: ['/epc', '/epc-certificate', '/book-epc'], canon: '/epc', crumb: 'EPC', title: 'EPC (Energy Performance Certificate) in London — Book Online | Residential Realtors', desc: 'Book an EPC in London with an accredited energy assessor — lodged on the government register and valid for 10 years. Pay online, and we arrange the visit.' },
  clean: { img: 'u-flat-plants', paths: ['/book-a-clean', '/end-of-tenancy-clean'], canon: '/book-a-clean', crumb: 'Book a clean', title: 'Book an End-of-Tenancy Clean in London | Residential Realtors', desc: 'Moving out? Book a professional end-of-tenancy clean online in London — choose your home’s size and extras, pick a date and pay securely.' },
  tenants: { paths: ['/tenants'], canon: '/tenants', crumb: 'Tenants', title: 'Renting in London: Report a Repair, Tenant Fees & Offers | Residential Realtors', desc: 'Report a repair online 24/7, make an offer and see our tenant fees. Renting with Residential Realtors, London SE1 — no hidden fees.', img: 'u-couple-home' },
  about: { paths: ['/about', '/about-us'], canon: '/about', crumb: 'About us', title: 'About Us | ARLA Propertymark Letting Agent, London SE1', desc: 'A modern London letting and property management agency at 28-30 Harper Road, SE1. ARLA Propertymark member with Client Money Protection and The Property Ombudsman redress.', img: 'u-tower-bridge' },
  contact: { paths: ['/contact'], canon: '/contact', crumb: 'Contact', title: 'Contact Us | Letting Agent, Harper Road, London SE1 6AD', desc: 'Call 0207 096 8131, email or message Residential Realtors — 28-30 Harper Road, London SE1 6AD.', img: 'u-phonebox' },
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
  // What Google shows: a title it won't cut off (it already shows our name above each result, so a long title drops
  // " | Residential Realtors") and a description of at most ~160 characters, ended at a word.
  const brand = ' | Residential Realtors', sTitle = String(pg.title || '').length > 65 && String(pg.title).slice(-brand.length) === brand ? String(pg.title).slice(0, -brand.length) : pg.title;
  const d0 = String(pg.desc || ''), sDesc = d0.length <= 165 ? d0 : (function () { const cut = d0.slice(0, 158), dot = cut.lastIndexOf('. '); return dot > 100 ? cut.slice(0, dot + 1) : cut.replace(/[\s,;:—–-]+\S*$/, '') + '…'; })();
  return '<title>' + siteEsc(sTitle) + '</title><meta name="description" content="' + siteEsc(sDesc) + '"><link rel="canonical" href="' + url + '">' +
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
const londonDay = function () { return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' }); };
function siteHeader(name, home, req) {
  const props = listings && listings.show(req) ? [['/properties-for-sale', 'Buy', 'list-sale'], ['/properties-to-rent', 'Rent', 'list-let']] : [[home, 'Home', 'home']];
  const nav = props.concat([['/sales', 'Sell', 'sales'], ['/landlords', 'Landlords', 'landlords'], ['/services', 'Services', 'services'], ['/tenants', 'Tenants', 'tenants'], ['/landlord-tools', 'Landlord tools', 'tools'], ['/about', 'About', 'about'], ['/contact', 'Contact', 'contact']])
    .map(function (n) { const on = n[2] === name || (n[2] === 'landlords' && /^(switch|overseas)$/.test(name)) || (n[2] === 'services' && /^(gas|eicr|epc|certs|diy|licence|compliance)$/.test(name)) || (n[2] === 'tools' && /^(checks|rents)$/.test(name)); return '<a href="' + n[0] + '"' + (on ? ' class="on" aria-current="page"' : '') + '>' + n[1] + '</a>'; }).join('');
  return '<header class="top"><div class="wrap"><a class="brand" href="' + home + '" aria-label="Residential Realtors — home"><img src="/logo-tight.png" alt="Residential Realtors" width="122" height="38"></a>' +
    '<nav class="nav" aria-label="Main menu">' + nav + '<a class="cta" href="' + (name === 'sales' ? '/sales#sales-valuation' : '/landlords#valuation') + '">Get a valuation</a></nav>' +
    '<a class="rep" href="/report-a-repair">' + WRENCH + '<span>Report a repair</span></a>' +
    '<button class="menu-btn" type="button" aria-label="Menu" aria-expanded="false">☰</button></div></header>';
}
// Our own CSS and scripts carry a fingerprint of their contents (?v=…), so every update reaches
// visitors straight away — even though Cloudflare tells browsers to keep these files for hours.
const assetV = {};
function asset(name) {
  if (!assetV[name]) { try { assetV[name] = crypto.createHash('sha1').update(fs.readFileSync(path.join(__dirname, name))).digest('hex').slice(0, 10); } catch (e) { assetV[name] = String(Date.now()); } }
  return '/' + name + '?v=' + assetV[name];
}
function siteFooter(home) {
  return '<footer><div class="wrap"><div class="cols">' +
    '<div><img src="/logo-white.png" alt="Residential Realtors" width="109" height="34" loading="lazy"><div>Estate agents, lettings and property management in London.</div><div style="margin-top:10px">28-30 Harper Road, London SE1 6AD</div><div style="margin-top:6px">Open 7 days, 9am–7pm</div></div>' +
    '<div><h4>Sell &amp; let</h4><a href="/sales">Selling your home</a><a href="/sales#sales-valuation">Sales valuation</a><a href="/landlords">Landlord services</a><a href="/letting-agents">Areas we cover — all of London</a><a href="/london-rents">London rents by area</a><a href="/landlords#valuation">Rental valuation</a><a href="/landlord-tools">Landlord tools</a><a href="/landlord-compliance">Landlord compliance checklist</a><a href="/switch-letting-agent">Switching letting agent</a><a href="/overseas-landlords">Overseas landlords</a><a href="/services">All landlord services</a><a href="/gas-safety-certificate">Gas Safety certificate</a><a href="/eicr">EICR</a><a href="/epc">EPC</a><a href="/property-checks">EPC &amp; licence checker</a><a href="/landlord-updates">Landlord updates &amp; alerts</a><a href="/diy-inventory">DIY inventory</a><a href="/landlord-portal-demo">Example landlord portal</a></div>' +
    '<div><h4>Tenants</h4><a href="/report-a-repair">Report a repair</a><a href="/offer">Make an offer</a><a href="/tenants">Renting with us</a><a href="/book-a-clean">Book a moving-out clean</a><a href="/tenants#fees">Tenant fees</a><a href="/tenants#guides">Renting guides</a></div>' +
    '<div><h4>Get in touch</h4><a href="tel:02070968131">0207 096 8131</a><a href="mailto:info@residentialrealtors.co.uk">info@residentialrealtors.co.uk</a><a href="/about">About us</a><a href="/news">Property news</a><a href="/privacy">Privacy</a></div>' +
    '</div><div class="accred">' +
    '<a href="/cmp-certificate.pdf" target="_blank" rel="noopener" title="View our Client Money Protection certificate"><img src="/img/logo-cmp.webp" alt="Propertymark Client Money Protection" width="100" height="60" loading="lazy"></a>' +
    '<a href="https://www.propertymark.co.uk" target="_blank" rel="noopener" class="w"><img src="/img/logo-arla.png" alt="ARLA Propertymark Protected" width="96" height="60" loading="lazy"></a>' +
    '<a href="https://www.tpos.co.uk" target="_blank" rel="noopener"><img src="/img/logo-tpo.png" alt="The Property Ombudsman" width="159" height="60" loading="lazy"></a>' +
    '<p><b>Client Money Protection:</b> Propertymark, membership number C0130229 — <a href="/cmp-certificate.pdf" target="_blank" rel="noopener">view our certificate</a>.<br><b>Independent redress:</b> The Property Ombudsman (<a href="https://www.tpos.co.uk" target="_blank" rel="noopener">tpos.co.uk</a>). <a href="/tenants#fees">Tenant fees</a></p></div>' +
    // Call us: a button on every page that rings the office (bottom corner; above the property page's bar on phones).
    '<a class="callfab" href="tel:02070968131" aria-label="Call us on 0207 096 8131"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/></svg><span>0207 096 8131</span></a>' +
    // Quick valuation: a tab on the side of every page — name, email and phone, and we call back.
    '<button type="button" class="qv-tab" id="qvTab" aria-controls="qvBox" aria-expanded="false">Free valuation</button>' +
    '<div class="qv" id="qvBox" hidden role="dialog" aria-label="Quick valuation request"><button type="button" class="qv-x" id="qvX" aria-label="Close">×</button>' +
    '<form id="qvForm" novalidate><h3>Free valuation</h3><p>Leave your details and we’ll call you back.</p>' +
    '<div class="qv-seg"><label><input type="radio" name="what" value="Sales"> Sales</label><label><input type="radio" name="what" value="Rental" checked> Rental</label></div>' +
    '<input name="name" placeholder="Your name" autocomplete="name" required><input name="email" type="email" placeholder="Email" autocomplete="email" required><input name="phone" type="tel" placeholder="Phone number" autocomplete="tel" inputmode="tel" required>' +
    '<input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">' +
    '<label class="qv-ok"><input type="checkbox" name="consent"> <span>I’m happy for you to contact me (<a href="/privacy">privacy</a>)</span></label>' +
    '<p class="qv-err" id="qvErr" role="alert"></p><button class="btn red" type="submit" id="qvGo">Request a call back</button></form></div>' +
    (process.env.TURNSTILE_SITE_KEY ? '<script>window.FF_TS=' + JSON.stringify(String(process.env.TURNSTILE_SITE_KEY)) + '</script>' : '') + '<script src="' + asset('ff.js') + '"></script>' +
    '<script>document.querySelectorAll(".la-form").forEach(function(f){f.onsubmit=function(ev){ev.preventDefault();var v=function(k){return String(f.elements[k].value||"").trim()},e=f.querySelector(".la-err"),g=f.querySelector("button[type=submit]"),w=f.querySelector("input[name=freq]:checked");e.textContent="";' +
    'if(!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(v("email")))return e.textContent="Please enter a valid email address.";if(!f.elements.consent.checked)return e.textContent="Please tick the box so we can email you.";g.disabled=true;g.textContent="Signing you up…";' +
    'ffPost("/api/landlord-alerts",{name:v("name"),email:v("email"),freq:w?w.value:"weekly",website:v("website"),consent:true},f).then(function(r){return r.json()}).then(function(d){' +
    'if(!d.ok){g.disabled=false;g.textContent="Sign me up";e.textContent=d.error==="rate-limited"?"Too many sign-ups — please try again later.":d.error==="email"?"Please check your email address.":"Sorry, something went wrong — please try again.";return}' +
    'f.innerHTML=d.already?"<div class=\\"la-done\\"><b>✓ You’re already signed up</b><span>We’ve updated how often you hear from us.</span></div>":"<div class=\\"la-done\\"><b>✓ Nearly done — check your email</b><span>Click the link we’ve sent to confirm your landlord alerts.</span></div>"}).catch(function(){g.disabled=false;g.textContent="Sign me up";e.textContent="Couldn’t connect — please try again."})}});</script>' +
    '<script>(function(){var t=document.getElementById("qvTab"),b=document.getElementById("qvBox"),f=document.getElementById("qvForm"),e=document.getElementById("qvErr"),g=document.getElementById("qvGo");if(!t)return;' +
    'var o=function(v){b.hidden=!v;t.setAttribute("aria-expanded",v?"true":"false");t.classList.toggle("on",v);if(v){var n=f&&f.elements.name;if(n)setTimeout(function(){n.focus()},50)}};' +
    't.onclick=function(){o(b.hidden)};document.getElementById("qvX").onclick=function(){o(false)};document.addEventListener("keydown",function(k){if(k.key==="Escape")o(false)});' +
    'if(f)f.onsubmit=function(ev){ev.preventDefault();var v=function(k){return String(f.elements[k].value||"").trim()},w=f.querySelector("input[name=what]:checked");e.textContent="";' +
    'if(!v("name"))return e.textContent="Please enter your name.";if(!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(v("email")))return e.textContent="Please enter a valid email.";if(v("phone").replace(/\\D/g,"").length<10)return e.textContent="Please enter your phone number.";if(!f.elements.consent.checked)return e.textContent="Please tick the box so we can call you.";' +
    'g.disabled=true;g.textContent="Sending…";ffPost("/api/valuation-request",{kind:"quick",what:w?w.value:"Not sure",name:v("name"),email:v("email"),phone:v("phone"),website:v("website"),consent:true,page:location.pathname},f).then(function(r){return r.json()}).then(function(d){' +
    'if(!d.ok){g.disabled=false;g.textContent="Request a call back";e.textContent=d.error==="rate-limited"?"Too many requests — please call 0207 096 8131.":"Sorry, something went wrong — please call 0207 096 8131.";return}' +
    'f.innerHTML="<div class=\\"qv-done\\"><b>✓ Thanks — we’ll call you soon.</b><span>Or ring us now on <a href=\\"tel:02070968131\\">0207 096 8131</a>.</span></div>"}).catch(function(){g.disabled=false;g.textContent="Request a call back";e.textContent="Couldn’t connect — please try again."})}})();</script>' +
    '<div class="legal">© <span id="yr"></span> Estallion Investments Ltd trading as Residential Realtors · Registered in England, company number 08760284 · 28-30 Harper Road, London SE1 6AD.</div></div></footer>';
}
const isSiteHost = function (req) { return SITE_HOSTS.indexOf(String(req.hostname || '').toLowerCase()) !== -1; };
function siteShell(name, home, req) {
  let body = fs.readFileSync(path.join(__dirname, 'site', name + '.html'), 'utf8');
  if (name === 'home') body = body.replace('<section class="tools2">', trackHtml('') + '<section class="tools2">');
  if (name === 'home') body = body.replace('<!--FEATURED-->', listings ? listings.featured(req) : '').replace('<!--HEROSEARCH-->', heroSearch(req)).replace('<!--STATS-->', heroStats(req)).replace('<!--AREAS-->', heroAreas(req)).replace('<!--EXPERTS-->', heroExperts(req)).replace('<!--NEWS-->', news ? news.section() : '');
  return '<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
    siteHead(name, body) + SITE_FONTS + '<link rel="stylesheet" href="' + asset('site.css') + '"></head><body>' + siteHeader(name, home, req) + '<main>' + body + '</main>' + siteFooter(home) +
    '<script src="' + asset('site.js') + '" defer></script></body></html>';
}
// Home page: a property search (when our listings are showing), the live numbers and the areas.
const ICONS = {
  diy: '<svg viewBox="0 0 48 48"><rect x="8" y="12" width="32" height="24" rx="4"/><circle cx="24" cy="24" r="6"/><path d="M17 12l3-4h8l3 4"/></svg>',
  cert: '<svg viewBox="0 0 48 48"><path d="M14 6h16l8 8v28H14z"/><path d="M30 6v8h8"/><path d="m20 28 4 4 8-9"/></svg>',
  key: '<svg viewBox="0 0 48 48"><circle cx="17" cy="17" r="9"/><circle cx="17" cy="17" r="3"/><path d="m24 24 16 16M33 33l4-4M37 37l4-4"/></svg>',
  worth: '<svg viewBox="0 0 48 48"><path d="M6 22 24 7l18 15"/><path d="M10 19v21h12"/><circle cx="34" cy="34" r="9"/><path d="M36.5 30.5a3 3 0 0 0-5 2.2v4.6h5.5M30 35h4.5"/></svg>',
  rent: '<svg viewBox="0 0 48 48"><circle cx="21" cy="21" r="13"/><path d="m31 31 10 10"/><path d="M14 22 21 16l7 6M16 21v7h10v-7"/></svg>',
  buy: '<svg viewBox="0 0 48 48"><path d="M6 22 24 7l18 15"/><path d="M10 19v21h14"/><path d="m35 26 2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8Z"/></svg>'
};
function heroSearch(req) {
  const c = listings && listings.counts(req);
  const val = '<div class="hs-val"><span><b>What’s your home worth?</b> Free sales and rental valuations</span><a class="btn yellow" href="/sales#sales-valuation">Get a valuation →</a></div>';
  if (!c) return '<div class="hsearch">' + val.replace('class="hs-val"', 'class="hs-val solo"') + '</div>';
  return '<form class="hsearch" id="hSearch" action="/properties-to-rent" method="get" role="search">' +
    '<div class="hs-tabs" role="tablist"><button type="button" class="on" data-hs="rent" role="tab">Rent</button><button type="button" data-hs="buy" role="tab">Buy</button></div>' +
    '<div class="hs-box"><div class="hs-row"><input name="q" aria-label="Area, street or postcode" placeholder="Area, street or postcode" autocomplete="off"><button class="hs-go" type="submit" aria-label="Search"><span class="hs-gt">Search</span> <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg></button></div>' +
    '<div class="hs-modes"><button type="button" class="on" data-mode="list"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>Location</button><button type="button" data-mode="map"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/></svg>Map</button><button type="button" data-mode="near"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 11 18-8-8 18-2-8-8-2z"/></svg>Near me</button></div></div>' +
    val + '</form>';
}
// The four "When you need experts" cards: each one does something — search homes, compare
// rents from a postcode, or pick a landlord service.
function heroExperts(req) {
  const c = listings && listings.counts(req);
  const search = function (action, label, ph) { return '<form class="x-form" action="' + action + '" method="get" role="search"><input name="q" aria-label="' + label + '" placeholder="' + ph + '" autocomplete="off"><button type="submit" aria-label="Search">→</button></form>'; };
  const card = function (ic, h, line, body, btn, href) { return '<div class="xcard rv"><span class="x-ic">' + ICONS[ic] + '</span><h3>' + h + '</h3><p>' + line + '</p>' + body + (btn ? '<a class="btn yellow" href="' + href + '">' + btn + '</a>' : '') + '</div>'; };
  return '<div class="xgrid">' +
    card('key', 'Let your property hassle-free', 'Pick the service that suits you',
      '<div class="x-svc"><a href="/landlords?svc=Tenant%20Find#valuation">Tenant find</a><a href="/landlords?svc=Rent%20Collection#valuation">Rent collection</a><a href="/landlords?svc=Fully%20Managed#valuation">Full management</a></div>',
      'Let your property', '/landlords') +
    card('worth', 'What rent could you get?', 'Compare rents for similar homes near you',
      '<form class="x-form x-val" action="/landlords" method="get"><input name="postcode" aria-label="Your postcode" placeholder="Your postcode" autocomplete="postal-code" style="text-transform:uppercase"><span class="x-val-b"><select name="beds" aria-label="Bedrooms"><option value="0">Studio</option><option value="1">1 bed</option><option value="2" selected>2 beds</option><option value="3">3 beds</option><option value="4">4 beds</option><option value="5">5+ beds</option></select><button type="submit" formaction="/landlords#compare">Compare</button></span></form><a class="x-sale" href="/sales#sales-valuation">Selling instead? Get a sales valuation →</a>',
      '', '') +
    '<div class="xcard xdiy rv"><div class="xd-top"><span class="xd-chip"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg> Do it yourself</span>' +
      '<div class="xd-phone" aria-hidden="true"><i class="xd-notch"></i><div class="xd-row"><i class="xd-ph a"></i><span>Kitchen</span><b>✓</b></div><div class="xd-row"><i class="xd-ph b"></i><span>Living room</span><b>✓</b></div><div class="xd-row"><i class="xd-ph c"></i><span>Bedroom</span><em><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg></em></div></div>' +
      '<span class="xd-price" data-cert-price="diy"><b>£30</b> + VAT</span></div>' +
      '<div class="xd-body"><h3>DIY inventory</h3><p>Get your tenant to do the check-in on their phone, instead of sending you hundreds of photos. Room by room, signed by them, in one report.</p>' +
      '<div class="xd-vs"><span><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2H2v10l9.29 9.29a2.41 2.41 0 0 0 3.42 0l6.58-6.58a2.41 2.41 0 0 0 0-3.42L12 2Z"/><circle cx="7" cy="7" r="1.5"/></svg> A fraction of the cost of an inventory clerk</span><small>Clerks typically charge £150–£200 a visit</small></div>' +
      '<div class="xd-pills"><a href="/diy-inventory#example"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg> See an example</a><a href="/diy-inventory">How it works</a></div>' +
      '<a class="btn red xd-go" href="/book-certificate?service=diy">Buy &amp; start now →</a></div></div>' +
    '</div>';
}
// Our track record for landlords (jobs.trackRecord(): our own records, last 12 months; each figure only when it
// rests on enough cases). Nothing shows until there is real data — never a made-up figure.
function trackHtml(where) {
  const t = jobs && jobs.trackRecord && jobs.trackRecord(); if (!t) return '';
  const tiles = [];
  if (t.days) tiles.push(['<b>' + t.days + ' day' + (t.days === 1 ? '' : 's') + '</b>', 'typical time from going online to let', 'median of ' + t.daysN + ' homes']);
  if (t.rentPct) tiles.push(['<b>' + (t.rentPct >= 100 ? t.rentPct.toFixed(t.rentPct % 1 ? 1 : 0) : t.rentPct.toFixed(1)) + '%</b>', 'of the asking rent agreed', 'median of ' + t.rentN + ' lets']);
  if (t.tenancies) tiles.push(['<b>' + t.tenancies + '</b>', 'new tenancies started', 'in the last 12 months']);
  if (t.boroughs) tiles.push(['<b>' + t.boroughs + '</b>', 'London boroughs we’ve let homes in', 'we cover all 33']);
  if (!tiles.length) return '';
  return '<section class="trk"><div class="wrap"><div class="trk-h"><p class="kicker">Our track record</p><h2>' + (where ? 'Letting homes in ' + siteEsc(where) + ' — fast, at the right rent' : 'Fast lets at the right rent') + '</h2></div>' +
    '<div class="trk-g">' + tiles.map(function (x) { return '<div class="trk-t">' + x[0] + '<span>' + x[1] + '</span><small>' + x[2] + '</small></div>'; }).join('') + '</div>' +
    '<p class="trk-n">From our own records over the last 12 months, updated every day. <a href="/landlords#valuation">Get a free rental valuation →</a></p></div></section>';
}
function heroStats(req) {
  const c = listings && listings.counts(req);
  if (!c || !(c.let + c.sale)) return '<p class="tb-p">Protected &amp; regulated</p>';
  return '<div class="tb-stats"><a href="/properties-to-rent">Homes to rent</a><a href="/properties-for-sale">Homes for sale</a><span>Protected &amp; regulated</span></div>';
}
function heroAreas(req) {
  const c = listings && listings.counts(req);
  if (!c || !c.areas.length) return '';
  return '<div class="areas"><span class="areas-h">Where our homes are right now</span><div class="areas-l">' + c.areas.map(function (a) { return '<a href="/properties-to-rent?q=' + encodeURIComponent(a.toLowerCase()) + '">' + siteEsc(a) + '</a>'; }).join('') + '</div></div>';
}
// The landlords page is its own file (calculators and valuation form); it gets the same head, menu and footer.
function landlordsShell(home, req) {
  let h = fs.readFileSync(path.join(__dirname, 'landlords.html'), 'utf8').replace('<section id="services">', trackHtml('London') + '<section id="services">');
  h = h.replace(/<title>[\s\S]*?<link rel="icon"[^>]*>/, siteHead('landlords', h)).replace('<style>', '<link rel="stylesheet" href="' + asset('site.css') + '">\n<style>')
    .replace(/<header class="top">[\s\S]*?<\/header>/, siteHeader('landlords', home, req)).replace(/<footer>[\s\S]*?<\/footer>/, siteFooter(home));
  return h;
}
const siteCache = {};
function sendSite(req, res, name) {
  if (visits) visits.track(req, (SITE_PAGES[name] && SITE_PAGES[name].title) || name);
  const f = name === 'landlords' ? path.join(__dirname, 'landlords.html') : path.join(__dirname, 'site', name + '.html'); let st; try { st = fs.statSync(f); } catch (e) { return res.status(404).end(); }
  const home = isSiteHost(req) ? '/' : '/home', ck = name + home + ((jobs && jobs.trackRecord && jobs.trackRecord() || {}).at || '') + (listings ? listings.stamp() + listings.show(req) + londonDay() : '') + (name === 'home' && typeof news !== 'undefined' ? 'n' + news.count() + (news.status().at || 0) : '');
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
  if (visits && res.statusCode < 400) visits.track(req, meta.title || meta.name);
  const home = isSiteHost(req) ? '/' : '/home', ck = meta.name + home + (meta.stamp || '') + listings.show(req) + listings.stamp() + londonDay();
  let c = builtCache.get(ck);
  if (!c) {
    const raw = Buffer.from('<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
      siteHeadFor(meta, body) + SITE_FONTS + '<link rel="stylesheet" href="' + asset('site.css') + '"></head><body>' + siteHeader(meta.name, home, req) + '<main>' + body + '</main>' + siteFooter(home) + '<script src="' + asset('site.js') + '" defer></script></body></html>');
    c = { raw: raw, gzip: zlib.gzipSync(raw, { level: 6 }), etag: '"b' + crypto.createHash('sha1').update(raw).digest('base64').slice(0, 26) + '"' };
    if (res.statusCode === 200) { builtCache.set(ck, c); while (builtCache.size > 400) builtCache.delete(builtCache.keys().next().value); }
  }
  res.setHeader('Cache-Control', meta.private ? 'private, no-store' : 'no-cache'); res.setHeader('ETag', c.etag); res.setHeader('Vary', 'Accept-Encoding, Cookie'); res.type('html');
  if (res.statusCode === 200 && req.headers['if-none-match'] === c.etag) return res.status(304).end();
  const gz = /\bgzip\b/.test(String(req.headers['accept-encoding'] || '')); if (gz) res.setHeader('Content-Encoding', 'gzip');
  res.end(req.method === 'HEAD' ? undefined : (gz ? c.gzip : c.raw));
}
const news = require('./news')();
const updates = require('./updates')(app, { siteUrl: SITE_URL, refuseBot: function (req, res, b, t) { return jobs && jobs.refuseBot ? jobs.refuseBot(req, res, b, t) : Promise.resolve(false); }, db: function () { return jobs.db(); }, sendMail: function (o) { return jobs.sendMail(o); }, alert: function (o) { return jobs.alert(o); }, isStaff: function (req) { return !!(jobs && jobs.isStaff(req)); }, send: function (req, res, meta, body) { return sendBuilt(req, res, meta, body); } });
require('./portaldemo')(app, { send: function (req, res, meta, body) { return sendBuilt(req, res, meta, body); } });
const listings = require('./listings')(app, { siteUrl: SITE_URL, send: sendBuilt, onsBeds: function (g, b) { return areas.onsBeds(g, b); }, db: function () { return jobs ? jobs.db() : null; },  isStaff: function (req) { return !!(jobs && jobs.isStaff && jobs.isStaff(req)); } });
const areas = require('./areas')(app, { send: function (req, res, meta, body) { return sendBuilt(req, res, meta, body); }, track: function () { return jobs && jobs.trackRecord && jobs.trackRecord(); }, trackHtml: function (w) { return trackHtml(w); }, listings: function () { return listings; }, db: function () { return jobs ? jobs.db() : null; } });
const svcAreas = require('./svcareas')(app, { siteUrl: SITE_URL, send: function (req, res, meta, body) { return sendBuilt(req, res, meta, body); }, db: function () { return jobs ? jobs.db() : null; } });
// On the website's own address, /home is the same page as / — send search engines to one address.
app.get('/home', (req, res, next) => { if (isSiteHost(req)) return res.redirect(301, '/'); next(); });
Object.keys(SITE_PAGES).forEach(function (name) { if (SITE_PAGES[name].paths) app.get(SITE_PAGES[name].paths, function (req, res) { sendSite(req, res, name); }); });
app.get(['/landlords', '/valuation'], function (req, res) { sendSite(req, res, 'landlords'); });
app.get('/tenant-fees', (req, res) => res.redirect(301, '/tenants#fees'));
// London property news (headlines that link to the full stories).
app.get('/news', function (req, res) { sendBuilt(req, res, { name: 'news', stamp: 'n' + news.count() + (news.status().at || 0), canon: '/news', crumb: 'London property news', title: 'London Property News | Residential Realtors', desc: 'The latest London property news headlines, updated through the day.' }, news.page()); });
// Home page hero video: a free-licence Mixkit clip ("Tower Bridge in London during sunset", Mixkit Free License),
// downloaded once and served from here (with Range support for iPhones) instead of linking to Mixkit.
const HERO_CLIP = '4457', HERO_VIDEO = { '720': ['720', '1080'], '360': ['360'] }, heroVidLoads = {};
app.get('/media/hero-:q.mp4', async function (req, res) {
  const tries = HERO_VIDEO[req.params.q]; if (!tries) return res.status(404).end();
  const file = path.join(require('os').tmpdir(), 'rr-hero-' + HERO_CLIP + '-' + req.params.q + '.mp4');
  try {
    if (!fs.existsSync(file)) {
      heroVidLoads[file] = heroVidLoads[file] || (async function () {
        for (const t of tries) {
          const r = await fetch('https://assets.mixkit.co/videos/' + HERO_CLIP + '/' + HERO_CLIP + '-' + t + '.mp4', { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ResidentialRealtors/1.0)' }, signal: AbortSignal.timeout(90000) });
          if (!r.ok) continue;
          const buf = Buffer.from(await r.arrayBuffer()); if (buf.length < 100000) continue;
          fs.writeFileSync(file + '.part', buf); fs.renameSync(file + '.part', file); return;
        }
        throw new Error('video not available');
      })().finally(function () { delete heroVidLoads[file]; });
      await heroVidLoads[file];
    }
    res.setHeader('Cache-Control', 'public, max-age=2592000'); res.sendFile(file);
  } catch (e) { console.error('Hero video:', e.message); res.status(502).end(); }
});
// For search engines: what to index (the public website) and what not to (staff and private links).
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send('User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /staff\nDisallow: /api/\nDisallow: /offer/\nDisallow: /landlord/\nDisallow: /reserve/\nDisallow: /portal\n\nSitemap: ' + SITE_URL + '/sitemap.xml\n');
});
// Every public address for the sitemap (and the SEO autopilot in seo.js).
let seo = null;
function siteUrls() {
  const pages = [['/', '1.0'], ['/landlord-updates', '0.8'], ['/news', '0.5'], ['/property-checks', '0.8'], ['/landlord-tools', '0.8'], ['/landlord-compliance', '0.8'], ['/switch-letting-agent', '0.7'], ['/overseas-landlords', '0.7'], ['/book-certificate', '0.8'], ['/book-a-clean', '0.6'], ['/services', '0.9'], ['/licence-application', '0.8'], ['/diy-inventory', '0.7'], ['/gas-safety-certificate', '0.8'], ['/eicr', '0.8'], ['/epc', '0.8'], ['/landlord-portal-demo', '0.6'], ['/sales', '0.9'], ['/landlords', '0.9'], ['/tenants', '0.8'], ['/report-a-repair', '0.8'], ['/about', '0.6'], ['/contact', '0.6'], ['/privacy', '0.2']];
  return pages.concat(listings.urls().length ? [['/properties-to-rent', '0.9'], ['/properties-for-sale', '0.9']] : []).concat(listings.urls().map(function (u) { return [u, '0.7']; })).concat(areas.urls().map(function (u) { return [u, '0.6']; })).concat(svcAreas.urls().map(function (u) { return [u, '0.6']; }));
}
app.get('/sitemap.xml', (req, res) => {
  res.type('application/xml').send('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    siteUrls().map(function (x) { const lm = seo && seo.lastmod(x[0]); return '  <url><loc>' + SITE_URL + siteEsc(x[0]) + '</loc>' + (lm ? '<lastmod>' + lm + '</lastmod>' : '') + '<priority>' + x[1] + '</priority></url>'; }).join('\n') + '\n</urlset>\n');
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
  ourComps: function (pc, beds) { return listings.compsNear(pc, beds); },
  gnomenFor: function (rows) { return listings.gnomenFor(rows); },
  gnomenForAdverts: function (items, typed) { return listings.gnomenForAdverts(items, typed); },
  sendEmail: function (opts) { return sendViaResend(opts); },
  canEmail: function () { return !!RESEND_API_KEY; },
  // The same AI provider the tenant page uses, for drafting emails from a job.
  canAi: function () { return !!(GEMINI_API_KEY || ANTHROPIC_API_KEY); },
  // files: optional [{ mime, data (base64) }] — PDFs and photos the AI reads directly.
  askAi: function (prompt, wantJson, files) { return askAiSafe(prompt, wantJson, files); }
});
// Who's calling: the phone system's webhook, shown in the staff app.
// Our properties with other agents on Rightmove (checked each night against our own photos and addresses).
seo = require('./seo')(app, { siteUrl: SITE_URL, port: PORT, db: function () { return jobs.db(); }, urls: function () { return siteUrls().map(function (x) { return x[0]; }); }, sigs: function () { return listings.sigs(); },
  isStaff: function (req) { return !!(jobs && jobs.isStaff(req)); }, canManage: function (req) { return jobs.canManage(req); }, sendMail: function (o) { return jobs.sendMail(o); } });
require('./rivals')(app, { tools: listings.rmTools, gnomenFor: function (rows) { return listings.gnomenFor(rows); }, db: function () { return jobs.db(); },
  isStaff: function (req) { return !!(jobs && jobs.isStaff(req)); }, canManage: function (req) { return jobs.canManage(req); },
  alert: function (b) { const base = process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : ''); return jobs.ntfy(Object.assign({ click: base ? base + '/admin#avail' : undefined }, b)); },
  email: function (subject, textFor, hash) { return jobs.ownerEmail(subject, textFor, hash); } });
require('./calls')(app, { siteUrl: SITE_URL, db: function () { return jobs.db(); }, canManage: function (req) { return jobs.canManage(req); } });
// Applicant leads from outside the website (Rightmove's datafeed, or any service posting to /hooks/leads/<key>).
require('./leads')(app, { siteUrl: SITE_URL, db: function () { return jobs.db(); }, canManage: function (req) { return jobs.canManage(req); }, findListing: function (ref) { return listings.findRef(ref); } });
// Out-of-hours phone answering (Twilio + Claude): calls become Website leads.
require('./voice')(app, { siteUrl: SITE_URL, db: function () { return jobs.db(); }, teamAlert: function (b, h) { return jobs.teamAlert(b, h); }, staffEmailAll: function (s, t, h) { return jobs.staffEmailAll(s, t, h); }, ownerEmail: function (s, t, h) { return jobs.ownerEmail(s, t, h); }, ntfy: function (b) { return jobs.ntfy(b); } });
// The same photo on more than one property: tell the office once per new case, so it can be removed in Gnomen.
async function photoDupesAlert(groups) {
  const p = await jobs.db(); if (!p) return;
  const row = (await p.query("SELECT value FROM app_settings WHERE key = 'photo_dupes_told'")).rows[0], told = (row && row.value && row.value.keys) || [];
  const fresh = groups.filter(function (g) { return told.indexOf(g.key) === -1; });
  await p.query("INSERT INTO app_settings (key, value) VALUES ('photo_dupes_told', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [JSON.stringify({ keys: groups.map(function (g) { return g.key; }) })]);
  if (!fresh.length) return;
  const lines = fresh.map(function (g) { return '• ' + g.homes[0].where + ' (no. ' + g.homes[0].id + ') and ' + g.homes[1].where + ' (no. ' + g.homes[1].id + ') share ' + g.count + ' photo' + (g.count === 1 ? '' : 's') + (g.sameArea ? ' — same building, may be fine' : ''); }).join('\n');
  jobs.alert({ title: '📷 ' + (fresh.length === 1 ? 'Two properties share photos' : fresh.length + ' pairs of properties share photos'), message: fresh[0].homes[0].where + ' and ' + fresh[0].homes[1].where + ' share ' + fresh[0].count + ' photo' + (fresh[0].count === 1 ? '' : 's') + (fresh.length > 1 ? ' (+' + (fresh.length - 1) + ' more)' : '') + '. Remove them from the wrong property in Gnomen — see Website visitors in Fixflow.', tags: ['camera'] });
  jobs.sendMail({ to: ['info@residentialrealtors.co.uk'], fromName: 'Fixflow', subject: 'Properties sharing the same photos — please fix in Gnomen', text: 'The website found the same photos on more than one property. Please remove them from the property they don’t belong to in Gnomen (the website updates within 2 minutes):\n\n' + lines + '\n\nThe full list, with the photos, is in Fixflow → Website visitors.' }).catch(function () {});
}
app.get('/api/admin/photo-dupes', function (req, res) {
  if (!(jobs && jobs.isStaff(req))) return res.status(401).json({ ok: false });
  res.setHeader('Cache-Control', 'no-store'); res.json(Object.assign({ ok: true }, listings.photoDupes()));
});
// Take a property off our website (e.g. a duplicate listing) so Gnomen's feed doesn't bring it back; managers only.
app.post('/api/admin/web-hidden', express.json(), async function (req, res) {
  if (!(jobs && jobs.isStaff(req) && jobs.canManage(req))) return res.status(403).json({ ok: false, error: 'Only managers can change what is on the website.' });
  const b = req.body || {}, list = (Array.isArray(b.items) ? b.items : [{ id: b.id, where: b.where }]).slice(0, 200).map(function (x) { return { id: String((x && x.id) || '').trim(), where: x && x.where }; });
  if (!list.length || list.some(function (x) { return !/^\d{1,12}$/.test(x.id); })) return res.status(400).json({ ok: false, error: 'Property number missing' });
  try { res.json({ ok: true, hidden: b.keep ? await listings.keepOff(list[0].id) : await listings.hide(list, b.hide !== false, req.user && (req.user.name || req.user.username) || '') }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/admin/photo-dupes/ok', express.json(), async function (req, res) {
  if (!(jobs && jobs.isStaff(req) && jobs.canManage(req))) return res.status(403).json({ ok: false, error: 'Only managers can change this.' });
  const key = String((req.body || {}).key || ''); if (!/^\d+\+\d+$/.test(key)) return res.status(400).json({ ok: false });
  try { await listings.pairOk(key, (req.body || {}).ok !== false); res.json({ ok: true }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// Website visitors (counted on our server, no cookies) — the Website visitors page in Fixflow.
visits = require('./visits')(app, { db: function () { return jobs.db(); }, isStaff: function (req) { return !!(jobs && jobs.isStaff(req)); } });

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
