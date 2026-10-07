// Property listings on the website. Two sources (LISTINGS_SOURCE):
//  - rightmove (the default): our branch's adverts on Rightmove (RIGHTMOVE_BRANCH), read every
//    30 minutes, with each advert's photos, description and features;
//  - gnomen: the Gnomen sales and lettings feeds (GNOMEN_SALES_FEED / GNOMEN_LETTINGS_FEED: the
//    feed addresses hold the keys, so they live in the environment, never in the code).
// Kept in memory. Pages are built on the server so search engines see every property. Photos are
// resized here (sharp) so they're sharp but light on phones.
// They go on the public website only when LISTINGS_ON=1; signed-in staff always see them (a preview).
const crypto = require('crypto');
let sharp = null; try { sharp = require('sharp'); } catch (e) { sharp = null; }

module.exports = function (app, opts) {
  const FEEDS = { sale: process.env.GNOMEN_SALES_FEED || '', let: process.env.GNOMEN_LETTINGS_FEED || '' };
  const LIVE = process.env.LISTINGS_ON === '1', SOURCE = process.env.LISTINGS_SOURCE === 'gnomen' ? 'gnomen' : 'rightmove', BRANCH = String(process.env.RIGHTMOVE_BRANCH || '105856').replace(/\D/g, ''), SALES_BRANCH = String(process.env.RIGHTMOVE_SALES_BRANCH || BRANCH).replace(/\D/g, '');
  // Shown to this visitor? Everyone when live; otherwise signed-in staff only (a private preview).
  const staff = function (req) { try { return !!(req && opts.isStaff && opts.isStaff(req)); } catch (e) { return false; } };
  const show = function (req) { return LIVE || staff(req); };
  const preview = function (req) { return !LIVE && staff(req); };
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
  // A video or virtual tour we can show: YouTube, Vimeo, Matterport or Gnomen's own tours.
  const videoLink = function (u) { u = String(u || '').trim(); return /^https:\/\/((www\.|m\.)?youtube\.com\/(watch\?|embed\/|shorts\/)|youtu\.be\/|(player\.)?vimeo\.com\/|my\.matterport\.com\/|vt\.gnomen\.co\.uk\/|(www\.)?kuula\.co\/|(www\.)?panoramea\.co\.uk\/|(www\.)?spec\.co\/|[\w.-]*eyespy360\.com\/|[\w.-]*giraffe360\.com\/|[\w.-]*tourbuilder[\w.-]*\/)/i.test(u) && !/[<>"\s]/.test(u) ? u : ''; };
  const ytId = function (u) { const m = /(?:youtu\.be\/|[?&]v=|\/embed\/|\/shorts\/)([\w-]{11})/.exec(String(u || '')); return m ? m[1] : ''; };
  const vimeoId = function (u) { const m = /vimeo\.com\/(?:video\/)?(\d{6,12})/.exec(String(u || '')); return m ? m[1] : ''; };
  const gone = { let: [], sale: [] };   // homes the feed lists as let / sold
  function parse(xml, kind) {
    const out = []; gone[kind] = [];
    String(xml || '').replace(/<property>([\s\S]*?)<\/property>/g, function (m, x) {
      const status = tag(x, 'status'), id = tag(x, 'id');
      if (/^\d+$/.test(id) && /^(let|sold|withdrawn|completed|archived)$/i.test(status.trim())) { const st0 = tag(x, 'address1'), pc0 = tag(x, 'postcode').toUpperCase(); gone[kind].push({ street: st0, outcode: pc0.split(/\s+/)[0] || '', beds: /studio/i.test(tag(x, 'bedrooms')) ? 0 : parseInt(tag(x, 'bedrooms'), 10) || 0, status: status }); }
      if (!/^\d+$/.test(id) || tag(x, 'published') !== '1' || SHOW[kind].indexOf(status.toLowerCase()) === -1) return;
      const res = !/commercial|land/i.test(tag(x, 'category')), bedsRaw = res ? tag(x, 'bedrooms') : '', beds = /studio/i.test(bedsRaw) ? 0 : parseInt(bedsRaw, 10) || 0, type = tag(x, 'property_type') || tag(x, 'category') || 'Property';
      const street = tag(x, 'address1'), area = tag(x, 'address2'), town = tag(x, 'town'), pc = tag(x, 'postcode').toUpperCase(), outcode = pc.split(/\s+/)[0] || '';
      const lat = parseFloat(tag(x, 'latitude')), lng = parseFloat(tag(x, 'longitude'));
      const p = { id: id, kind: kind, type: type, category: tag(x, 'category'), status: status, taken: TAKEN.test(status),
        street: street, area: area && [town, street].every(function (v) { return area.trim().toLowerCase() !== String(v || '').trim().toLowerCase(); }) ? area : '', town: town, outcode: outcode,
        beds: beds, studio: res && (/studio/i.test(bedsRaw) || /studio/i.test(type)), commercial: !res, baths: parseInt(tag(x, 'bathrooms'), 10) || 0, receptions: parseInt(tag(x, 'receptions'), 10) || 0,
        price: kind === 'let' && process.env.GNOMEN_LET_PRICE !== 'pcm' ? Math.round((parseFloat(tag(x, 'price')) || 0) * 52 / 12) : (parseFloat(tag(x, 'price')) || 0), qualifier: tag(x, 'price_qualifier'),   // Gnomen sends rents per week: shown per month (with the weekly figure beside it) short: tag(x, 'short_description').replace(/<[^>]*>/g, ''), html: cleanHtml(tag(x, 'full_details')),
        available: tag(x, 'available_date'), furnished: tag(x, 'furnished'), tenure: tag(x, 'tenure'), pets: tag(x, 'pets') === 'Yes', parking: tag(x, 'parking') === '1', garden: tag(x, 'garden') === 'Yes',
        features: tag(x, 'features').split(',').map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 20),
        lat: isFinite(lat) && Math.abs(lat) > 1 ? lat : null, lng: isFinite(lng) && Math.abs(lat) > 1 ? lng : null,
        epc: /^https:\/\//.test(tag(x, 'epc')) ? tag(x, 'epc') : '', vtour: videoLink(tag(x, 'external_vtour')) || videoLink(tag(x, 'video_tour')),
        images: list(x, 'images', 'image').slice(0, 40), floorplans: list(x, 'floorplans', 'floorplan').slice(0, 6), added: tag(x, 'date_added'), updated: tag(x, 'date_updated') };
      p.where = [p.street, p.area || p.town].filter(Boolean).join(', ') + (outcode ? ' ' + outcode : '');
      p.unit = tag(x, 'property_no') ? (tag(x, 'property_no').toLowerCase().replace(/\b(flat|apartment|apt|unit|no)\b\.?/g, '') + '|' + street.toLowerCase()).replace(/[^a-z0-9|]/g, '') : ''; p.postcode = pc.replace(/\s+/g, '');
      p.headline = (p.studio ? 'Studio' : beds ? beds + ' bedroom ' + type.toLowerCase() : (p.commercial ? 'Commercial ' + type.toLowerCase() : type)) + (kind === 'let' ? ' to rent' : ' for sale');
      p.slug = (p.where + ' ' + (p.studio ? 'studio' : p.commercial ? type : beds + ' bed ' + type)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 90);
      p.url = '/property/' + id + '/' + p.slug;
      out.push(p);
    });
    // Available first, newest first.
    return out.sort(function (a, b) { return (a.taken - b.taken) || String(b.added).localeCompare(String(a.added)); });
  }
  // Gnomen sometimes holds two records for the same home (re-added for a new let): same flat
  // number, full postcode and bedrooms. Show it once — the newest record — and send the other's link to it.
  function dedupe(list, kind) {
    const keep = {}, out = [], gone = [];
    list.slice().sort(function (a, b) { return (+b.id) - (+a.id); }).forEach(function (p) {
      const k = p.unit && p.postcode ? p.unit + '|' + p.postcode + '|' + p.beds : '';
      if (k && keep[k]) { rmAlias[p.id] = keep[k].id; gone.push(p.id + '→' + keep[k].id); return; }
      if (k) keep[k] = p; out.push(p);
    });
    if (gone.length) logOnce('Duplicate Gnomen records shown once (' + (kind === 'let' ? 'lettings' : 'sales') + '): ' + gone.join(', '));
    return out.sort(function (a, b) { return (a.taken - b.taken) || String(b.added).localeCompare(String(a.added)); });
  }
  async function gnomenFeed(kind) {
    const r = await fetch(FEEDS[kind], { signal: AbortSignal.timeout(30000) });
    const xml = await r.text();
    if (!r.ok || xml.indexOf('<properties') === -1) throw new Error('bad feed ' + r.status);
    return dedupe(parse(xml, kind), kind);
  }
  // Gnomen's feed leaves some published properties out, so anything advertised on our Rightmove
  // branch that isn't in the feed is added too (matched on street, postcode district and bedrooms).
  const sameHome = function (a, b) {
    const st = function (p) { return String(p.street || p.where || '').toLowerCase().replace(/^(flat|apartment|unit)\s*\w+[,\s]*/, '').replace(/^\d+[a-z]?\s+/, '').replace(/[^a-z]/g, ''); };
    return a.outcode && a.outcode === b.outcode && (a.beds || 0) === (b.beds || 0) && st(a) && st(a) === st(b);
  };
  const rmListCache = {};   // our Rightmove adverts, re-read every 30 minutes (Gnomen is checked every couple of minutes)
  async function addFromRightmove(kind, list) {
    if (process.env.LISTINGS_RIGHTMOVE_TOO === '0') return list;
    const c = rmListCache[kind]; let items;
    if (c && Date.now() - c.at < 30 * 60000) items = c.items; else { items = await rmBranch(kind); rmListCache[kind] = { at: Date.now(), items: items }; }
    const extra = [], skippedLet = [];
    for (const x of items) {
      const quick = rmListing(x, null, kind);
      if (list.some(function (p) { return sameHome(p, quick); })) continue;
      if (gone[kind].some(function (g) { return sameHome(g, quick); })) { skippedLet.push(quick.where); continue; }   // Gnomen says it's let / sold: Gnomen wins
      const fresh = !rmDetails.has(String(x.id)), d = await rmDetail(String(x.id));
      if (fresh) await new Promise(function (ok) { setTimeout(ok, 800); });
      const p = rmListing(x, d, kind), manual = {}; String(process.env.RM_GNOMEN_IDS || '').split(/[\s,]+/).forEach(function (pair) { const m = /^(\d+)[=:](\d+)$/.exec(pair); if (m) manual[m[1]] = m[2]; });
      const pid = (d && d.gnomenPid) || manual[String(x.id)];
      if (pid && !list.some(function (q) { return q.id === pid; })) { rmAlias[p.id] = pid; p.rmId = p.id; p.id = pid; p.url = '/property/' + pid + '/' + p.slug; }
      extra.push(p);
    }
    if (skippedLet.length) logOnce('Not added from Rightmove — Gnomen says let/sold: ' + skippedLet.join('; ').slice(0, 300));
    if (extra.length) logOnce('Added from Rightmove (not in the Gnomen ' + (kind === 'let' ? 'lettings' : 'sales') + ' feed): ' + extra.length + ' — ' + extra.map(function (p) { return p.where + (p.rmId ? ' (our no. ' + p.id + ')' : ' (Rightmove no. ' + p.id + ' — Gnomen number not known)'); }).join('; ').slice(0, 600));
    return list.concat(extra).sort(function (a, b) { return (a.taken - b.taken) || String(b.added).localeCompare(String(a.added)); });
  }
  const lastMsg = {};
  const logOnce = function (m) { if (lastMsg['m:' + m] ) return; lastMsg['m:' + m] = 1; console.log(m); };
  async function refresh() {
    for (const kind of ['sale', 'let']) {
      if (!FEEDS[kind]) continue;
      try {
        let list = await gnomenFeed(kind);
        const msg = 'Listings from the Gnomen ' + (kind === 'let' ? 'lettings' : 'sales') + ' feed: ' + list.length + ' (' + list.filter(function (p) { return !p.taken; }).length + ' available)';
        if (msg !== lastMsg[kind]) { console.log(msg); lastMsg[kind] = msg; }
        try { list = await addFromRightmove(kind, list); } catch (e) { console.log('Rightmove check not done: ' + e.message); }
        data[kind] = list;
      } catch (e) { console.error('Listings feed (' + kind + ') not read:', e.message); }   // keep the last good copy
    }
    // (refreshAll works out when the list last changed)
  }
  // ---------- Rightmove: our branch's adverts ----------
  const RM = 'https://www.rightmove.co.uk', UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36', 'Accept-Language': 'en-GB,en;q=0.9' };
  const rmDetails = new Map();   // advert id -> { at, d }
  let rmPidDiag = 0;
  const rmAlias = {};   // Rightmove advert number -> our (Gnomen) property number, so old Rightmove-numbered links still work
  // Any list of advert-like objects inside a page's data.
  function dig(v, out, depth) {
    if (!v || depth > 10 || out.length > 500) return;
    if (Array.isArray(v)) { if (v.length && v.every(function (o) { return o && typeof o === 'object' && o.id != null && (o.displayAddress || o.propertyUrl); })) v.forEach(function (o) { out.push(o); }); else v.forEach(function (o) { dig(o, out, depth + 1); }); return; }
    if (typeof v === 'object') Object.keys(v).forEach(function (k) { dig(v[k], out, depth + 1); });
  }
  // Rightmove packs an advert's data as one list in which values point to other entries by position.
  function unpack(arr, byString) {
    const memo = new Map(), ref = function (x) { return byString ? (typeof x === 'string' && /^\d+$/.test(x) ? +x : null) : (typeof x === 'number' && x >= 0 && x % 1 === 0 ? x : null); };
    const r = function (i, depth) {
      if (i == null || i >= arr.length || depth > 60) return undefined;
      if (memo.has(i)) return memo.get(i);
      const v = arr[i];
      if (v === null || typeof v !== 'object') return v;
      const out = Array.isArray(v) ? [] : {}; memo.set(i, out);
      if (Array.isArray(v)) v.forEach(function (x) { const k = ref(x); out.push(k == null ? x : r(k, depth + 1)); });
      else Object.keys(v).forEach(function (key) { const k = ref(v[key]); out[key] = k == null ? v[key] : r(k, depth + 1); });
      return out;
    };
    return r(0, 0);
  }
  // The JSON object that starts at body[at] ("{"), read to its matching "}" (skipping strings).
  function jsonAt(body, at) {
    let depth = 0, inStr = false;
    for (let i = at; i < body.length; i++) {
      const c = body[i];
      if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true; else if (c === '{') depth++; else if (c === '}' && --depth === 0) return body.slice(at, i + 1);
    }
    return '';
  }
  function pageJson(body) {
    const out = [];
    const pmAt = body.search(/window\.__PAGE_MODEL\s*=\s*\{/), pm = pmAt === -1 ? null : [null, jsonAt(body, body.indexOf('{', pmAt))];
    if (pm && pm[1]) { try { const j = JSON.parse(pm[1]); if (typeof j.data === 'string') { const arr = JSON.parse(j.data); if (Array.isArray(arr)) { out.push(unpack(arr, false)); out.push(unpack(arr, true)); } else out.push(arr); } else out.push(j); } catch (e) {} }
    [/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/, /window\.jsonModel\s*=\s*(\{[\s\S]*?\})\s*<\/script>/, /window\.PAGE_MODEL\s*=\s*(\{[\s\S]*?\})\s*<\/script>/, /window\.__PRELOADED_STATE__\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/]
      .forEach(function (re) { const m = re.exec(body); if (m) { try { out.push(JSON.parse(m[1])); } catch (e) {} } });
    return out;
  }
  async function rmBranch(kind) {
    const ch = kind === 'let' ? 'RENT' : 'BUY', loc = 'BRANCH%5E' + (kind === 'let' ? BRANCH : SALES_BRANCH), seen = {}, items = [];
    const sources = [
      function (i) { return RM + '/api/property-search/listing/search?searchLocation=&useLocationIdentifier=true&locationIdentifier=' + loc + '&channel=' + ch + '&index=' + i + '&sortType=6&includeLetAgreed=true&includeSSTC=true&_includeLetAgreed=on'; },
      function (i) { return RM + '/api/_search?locationIdentifier=' + loc + '&numberOfPropertiesPerPage=24&radius=0.0&sortType=6&index=' + i + '&includeLetAgreed=true&includeSSTC=true&viewType=LIST&channel=' + ch + '&areaSizeUnit=sqft&currencyCode=GBP&isFetching=false'; },
      function (i) { return RM + (kind === 'let' ? '/property-to-rent' : '/property-for-sale') + '/find.html?locationIdentifier=' + loc + '&includeLetAgreed=true&includeSSTC=true&index=' + i; }
    ];
    let src = -1;
    for (let index = 0; index < 480; index += 24) {
      let raw = 0;
      for (let k = src === -1 ? 0 : src; k < sources.length; k++) {
        try {
          const r = await fetch(sources[k](index), { headers: Object.assign({ Accept: 'application/json, text/html;q=0.9, */*;q=0.8' }, UA), signal: AbortSignal.timeout(15000) });
          const body = await r.text(), found = [];
          if (/^\s*[{[]/.test(body)) { try { dig(JSON.parse(body), found, 0); } catch (e) {} } else pageJson(body).forEach(function (j) { dig(j, found, 0); });
          raw = found.length;
          found.forEach(function (x) { if (!seen[x.id]) { seen[x.id] = 1; items.push(x); } });
        } catch (e) { raw = 0; }
        if (raw) { src = k; break; }
      }
      if (raw < 20) break;
    }
    return items;
  }
  // An advert's own page: every photo, the description, key features, floorplans, location.
  let rmDiag = 0;
  async function rmDetail(id) {
    const c = rmDetails.get(id); if (c && Date.now() - c.at < 12 * 3600000) return c.d;
    let d = null;
    try {
      const r = await fetch(RM + '/properties/' + id, { headers: UA, signal: AbortSignal.timeout(15000) });
      const body = r.ok ? await r.text() : '';
      if (r.ok) {
        const found = [], look = function (v, depth) { if (!v || typeof v !== 'object' || depth > 10 || found.length) return; if (!Array.isArray(v) && Array.isArray(v.images) && (v.keyFeatures || v.text || v.floorplans)) { found.push(v); return; } Object.keys(v).forEach(function (k) { look(v[k], depth + 1); }); };
        pageJson(body).forEach(function (j) { look(j, 0); });
        d = found[0] || null;
        // Gnomen sends our property number with each advert (the brochure / details link, …pid=1650).
        const pidM = /residentialrealtors[^"'<>\s]{0,160}?pid[=:](\d{1,7})/i.exec(body) || /action=detail,pid=(\d{1,7})/i.exec(body) || /gnomen[^"'<>\s]{0,160}?[?&,]pid=(\d{1,7})/i.exec(body);
        if (d && pidM) d.gnomenPid = pidM[1];
        if (d && !pidM && rmPidDiag < 3) { rmPidDiag++; const links = (body.match(/https?:\\?\/\\?\/[^"'<>\s]{6,140}/g) || []).filter(function (u) { return !/rightmove|google|gstatic|facebook|twitter|doubleclick|cookielaw|onetrust/i.test(u); }).slice(0, 8);
          console.log('Rightmove advert ' + id + ': no Gnomen number found. Other links on it: ' + (links.join(' ') || 'none') + ' | data keys: ' + Object.keys(d).join(',').slice(0, 300)); }
      }
      // What an advert page looks like, the first couple of times one can't be read (to fix the reader).
      if (!d && rmDiag < 2) {
        rmDiag++;
        const scripts = []; body.replace(/<script\b([^>]*)>([\s\S]{0,80})/g, function (m, a, t) { if (scripts.length < 14) scripts.push((a.match(/id="([^"]+)"/) || [])[1] || (a.match(/type="([^"]+)"/) || [])[1] || t.replace(/\s+/g, ' ').slice(0, 40)); });
        const imgs = (body.match(/media\.rightmove\.co\.uk[^"'\s)\\]*/g) || []);
        console.log('Rightmove advert page ' + id + ': status ' + r.status + ', ' + body.length + ' bytes, title "' + ((/<title>([^<]{0,80})/.exec(body) || [])[1] || '') + '"' +
          ', markers ' + ['PAGE_MODEL', '__NEXT_DATA__', 'jsonModel', '__PRELOADED_STATE__', 'propertyData', 'keyFeatures', '"images"', 'floorplans', 'self.__next_f'].filter(function (k) { return body.indexOf(k) !== -1; }).join('/') +
          ', photo links ' + imgs.length + (imgs[0] ? ' e.g. ' + imgs[0].slice(0, 120) : ''));
        const pmAt = body.search(/window\.__PAGE_MODEL\s*=\s*\{/), pm = pmAt === -1 ? null : [null, jsonAt(body, body.indexOf('{', pmAt))];
        if (pm) { let info = 'regex matched ' + pm[1].length + ' chars';
          try { const j = JSON.parse(pm[1]); info += ', keys ' + Object.keys(j).join(','); if (typeof j.data === 'string') { const arr = JSON.parse(j.data); info += ', data is ' + (Array.isArray(arr) ? 'list of ' + arr.length : typeof arr) + ': ' + j.data.slice(0, 700); } } catch (e) { info += ', parse error ' + e.message + ' near ' + pm[1].slice(-120); }
          console.log('Rightmove advert data ' + id + ': ' + info); }
        else console.log('Rightmove advert data ' + id + ': no __PAGE_MODEL match; around it: ' + body.slice(Math.max(0, body.indexOf('__PAGE_MODEL') - 20), body.indexOf('__PAGE_MODEL') + 300));
      }
    } catch (e) { d = null; if (rmDiag < 2) { rmDiag++; console.log('Rightmove advert page ' + id + ' not read: ' + e.message); } }
    if (d || !c) rmDetails.set(id, { at: Date.now(), d: d || (c && c.d) || null });
    return d || (c && c.d) || null;
  }
  // Photo addresses: full size, absolute, without the :443 Rightmove sometimes adds.
  const abs = function (u) { u = String(u || '').trim(); return !u ? '' : (/^https?:\/\//i.test(u) ? u : 'https://media.rightmove.co.uk/' + u.replace(/^\/+/, '')).replace(/^http:/i, 'https:').replace('media.rightmove.co.uk:443/', 'media.rightmove.co.uk/'); };
  const big = function (u) { return abs(u).replace(/\/dir\/crop\/[^/]+\//, '/').replace(/_max_\d+x\d+(\.\w+)(\?.*)?$/, '$1'); };
  const isImg = function (u) { return /^https:\/\/media\.rightmove\.co\.uk\/.+\.(jpe?g|png|gif|webp)(\?.*)?$/i.test(String(u || '')); };
  const rmDay = function (v) { if (/^\d{4}-\d{2}-\d{2}/.test(String(v || ''))) return String(v).slice(0, 10); const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(v || '').trim()); return m ? m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2) : /^now$/i.test(String(v || '').trim()) ? '2000-01-01' : ''; };
  function rmListing(x, d, kind) {
    d = d || {};
    const pr = x.price || {}, freq = String(pr.frequency || '').toLowerCase(), amt = Number(pr.amount) || 0, dp = (pr.displayPrices || [])[0] || {};
    let price = kind === 'let' ? (freq === 'weekly' ? amt * 52 / 12 : freq === 'yearly' ? amt / 12 : amt) : amt;
    if (!price) { const m = /£([\d,]+)/.exec(dp.displayPrice || ((d.prices || {}).primaryPrice) || ''); if (m) price = Number(m[1].replace(/,/g, '')); }
    const addr = String(x.displayAddress || (d.address || {}).displayAddress || '').replace(/\s+/g, ' ').trim(), parts = addr.split(/\s*,\s*/).filter(Boolean);
    const oc = ((d.address || {}).outcode) || ((/\b([A-Z]{1,2}\d[A-Z\d]?)(?:\s*\d[A-Z]{2})?\s*$/i.exec(addr) || [])[1] || '').toUpperCase();
    const last = parts.length > 1 ? parts[parts.length - 1].replace(new RegExp('\\s*' + oc + '.*$', 'i'), '').trim() : '';
    const type = String(x.propertySubType || d.propertySubType || x.propertyTypeFullDescription || 'Property').replace(/\s+/g, ' ').trim();
    const st = String(x.displayStatus || '').trim(), taken = /let agreed|under offer|sold stc|sold subject|reserved/i.test(st);
    const beds = Number(x.bedrooms != null ? x.bedrooms : d.bedrooms) || 0;
    // Photos: the advert page's, else the search result's (its "url" is the full-size photo; "srcUrl" a smaller copy).
    const pick = function (list) { return (list || []).map(function (i) { return typeof i === 'string' ? { big: big(i), alt: abs(i) } : { big: i.url ? abs(i.url) : big(i.srcUrl || (i.resizedImageUrls || {}).size656x437), alt: abs(i.srcUrl || (i.resizedImageUrls || {}).size656x437 || i.url) }; }).filter(function (o) { return isImg(o.big) || isImg(o.alt); }); };
    let ph = pick(d.images); if (!ph.length) ph = pick((x.propertyImages || {}).images); if (!ph.length) ph = pick(x.images);
    ph = ph.slice(0, 40);
    const images = ph.map(function (o) { return isImg(o.big) ? o.big : o.alt; }), alts = ph.map(function (o) { return isImg(o.alt) ? o.alt : o.big; });
    const loc = d.location || x.location || {}, lat = Number(loc.latitude), lng = Number(loc.longitude), lt = Object.assign({ letAvailableDate: x.letAvailableDate }, d.lettings || {});
    const desc = (d.text || {}).description || '';
    const p = { id: String(x.id), kind: kind, src: 'rightmove', type: type, category: 'Residential', status: st || (kind === 'let' ? 'To let' : 'For sale'), taken: taken,
      street: parts[0] || addr, area: parts.length > 2 ? parts[1] : '', town: last, outcode: oc,
      beds: beds, studio: /studio/i.test(type) || (!beds && /flat|apartment/i.test(type)), commercial: false, baths: Number(x.bathrooms != null ? x.bathrooms : d.bathrooms) || 0, receptions: 0,
      price: Math.round(price) || 0, qualifier: String(dp.displayPriceQualifier || '').trim(), short: String(x.summary || (d.text || {}).propertyPhrase || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 400),
      html: cleanHtml(desc), available: rmDay(lt.letAvailableDate), furnished: String(lt.furnishType || '').replace(/^furnished$/i, 'Full'), tenure: String((d.tenure || x.tenure || {}).tenureType || '').replace(/^(\w)(\w*)$/, function (m, a, b) { return a + b.toLowerCase(); }),
      pets: false, parking: false, garden: false, features: (d.keyFeatures && d.keyFeatures.length ? d.keyFeatures : x.keyFeatures || []).map(function (f) { return String(f && typeof f === 'object' ? f.description || f.text || f.feature || '' : f || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(); }).filter(Boolean).slice(0, 20),
      lat: isFinite(lat) && lat ? lat : null, lng: isFinite(lng) && lng ? lng : null,
      epc: ((d.epcGraphs || []).map(function (e) { return abs(e.url); }).filter(isImg))[0] || '', vtour: ((d.virtualTours || []).map(function (v) { return videoLink(v && (v.url || v.link)); }).filter(Boolean))[0] || '',
      images: images, alts: alts, floorplans: (d.floorplans || []).map(function (f) { return abs(f.url); }).filter(isImg).slice(0, 6), added: String(x.firstVisibleDate || x.listingUpdate && x.listingUpdate.listingUpdateDate || '') };
    p.where = addr; p.street = p.street.replace(new RegExp('\\s*' + oc + '$', 'i'), '');
    p.headline = (p.studio ? 'Studio' : beds ? beds + ' bedroom ' + type.toLowerCase() : type) + (kind === 'let' ? ' to rent' : ' for sale');
    p.slug = (addr + ' ' + (p.studio ? 'studio' : beds + ' bed ' + type)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 90);
    p.url = '/property/' + p.id + '/' + p.slug;
    return p;
  }
  // ---------- Sales from our old Gnomen website (until the Gnomen feed is set up) ----------
  // Only while that site is still Gnomen's (it stops by itself once the domain points at this website).
  const OLD = String(process.env.OLD_SITE || 'https://www.residentialrealtors.co.uk').replace(/\/+$/, '');
  const oldDetails = new Map();
  const txt = function (h) { return String(h || '').replace(/<[^>]*>/g, ' ').replace(/&pound;/g, '£').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#0?39;|&rsquo;/g, '’').replace(/\s+/g, ' ').trim(); };
  const isOldImg = function (u) { return /^https:\/\/s3\.eu-central-003\.backblazeb2\.com\/Gnomen-Pms5-I\/[a-f0-9]+\/large\/[\w.-]+\.(jpe?g|png|gif|webp)$/i.test(String(u || '')); };
  async function oldSales() {
    const q = '/?id=37096&action=view&route=&view=&input=&jengo_radius=10&jengo_property_for=1&jengo_category=&jengo_property_type=-1&jengo_min_price=0&jengo_max_price=99999999999&jengo_min_beds=0&jengo_max_beds=9999&jengo_min_bathrooms=0&jengo_max_bathrooms=9999&min_land=0&max_land=999999999&min_space=0&max_space=999999999&jengo_branch=&country=&daterange=&jengo_order=6&trueSearch=&searchType=postcode&latitude=&longitude=&pfor_complete=on&pfor_offer=on&page=';
    const cards = [], seen = {};
    for (let pg = 1; pg <= 8; pg++) {
      const r = await fetch(OLD + q + pg, { headers: UA, signal: AbortSignal.timeout(20000) }); if (!r.ok) break;
      const html = await r.text();
      if (!/jengo|gnomen/i.test(html)) { console.log('Old website is no longer the Gnomen site — not reading sales from it'); return null; }
      let added = 0;
      html.split('resultWrapProperties').slice(1).forEach(function (c) {
        const id = (/href="\/property\/(\d+)\//.exec(c) || [])[1]; if (!id || seen[id]) return;
        seen[id] = 1; added++;
        const nums = []; c.replace(/class="property_items_amount[^"]*">\s*(\d+)/g, function (m, n) { nums.push(+n); });
        cards.push({ id: id, title: txt((/<h4>\s*<a[^>]*>([\s\S]*?)<\/a>/.exec(c) || [])[1]), type: txt((/tag_propertytype__group">([\s\S]*?)<\/div>/.exec(c) || [])[1]),
          status: txt((/status_group status__[^"]*"><\/span>([^<]*)</.exec(c) || [])[1]), price: Number(txt((/class="SSresults">([\s\S]*?)<\/div>/.exec(c) || [])[1]).replace(/[^\d.]/g, '')) || 0,
          beds: nums[0] || 0, baths: nums[1] || 0, receptions: nums[2] || 0, thumb: (/'(https:\/\/s3\.[^']+\/thumbnails\/[^']+)'/.exec(c) || [])[1] || '' });
      });
      if (!added) break;
    }
    return cards;
  }
  async function oldDetail(id) {
    const c = oldDetails.get(id); if (c && Date.now() - c.at < 12 * 3600000) return c.d;
    let d = null;
    try {
      const r = await fetch(OLD + '/property/' + id, { headers: UA, signal: AbortSignal.timeout(20000) });
      if (r.ok) {
        const h = await r.text(), di = h.indexOf('id="description"'), de = di === -1 ? -1 : h.indexOf('<!--end', di);
        const gal = h.indexOf('id="galleria"'), galEnd = gal === -1 ? -1 : h.indexOf('</div>', gal);
        const imgs = []; (gal === -1 ? '' : h.slice(gal, galEnd)).replace(/href="([^"]+)"/g, function (m, u) { if (isOldImg(u) && imgs.indexOf(u) === -1) imgs.push(u); });
        const ep = h.indexOf('class="epc__wrapper"'), epc = ep === -1 ? '' : ((/src="([^"]+)"/.exec(h.slice(ep, h.indexOf('</div>', ep))) || [])[1] || '');
        d = { html: di === -1 ? '' : cleanHtml(h.slice(h.indexOf('>', di) + 1, de === -1 ? di + 20000 : de).replace(/<div class="tab__header">[\s\S]*?<\/div>/, '')),
          images: imgs.slice(0, 40), lat: parseFloat((/prop_lat\s*=\s*(-?\d+\.\d+)/.exec(h) || [])[1]), lng: parseFloat((/prop_lng\s*=\s*(-?\d+\.\d+)/.exec(h) || [])[1]), epc: isOldImg(epc) ? epc : '' };
      }
    } catch (e) { d = null; }
    if (d || !c) oldDetails.set(id, { at: Date.now(), d: d || (c && c.d) || null });
    return d || (c && c.d) || null;
  }
  async function refreshOldSales() {
    const cards = await oldSales(); if (!cards) return null;
    const out = [];
    for (const x of cards) {
      if (/^sold$/i.test(x.status) || /awaiting/i.test(x.status)) continue;   // sold or not on the market yet
      const fresh = !oldDetails.has(x.id), d = await oldDetail(x.id) || {};
      if (fresh) await new Promise(function (ok) { setTimeout(ok, 600); });
      const parts = x.title.split(/\s*,\s*/).filter(Boolean), oc = (parts[parts.length - 1] || '').toUpperCase().replace(/[^A-Z0-9 ]/g, '').trim();
      const images = (d.images && d.images.length ? d.images : x.thumb ? [x.thumb.replace('/thumbnails/', '/large/')] : []).filter(isOldImg);
      const p = { id: x.id, kind: 'sale', src: 'oldsite', type: x.type || 'Property', category: 'Residential', status: x.status || 'For sale', taken: /under offer|sold stc/i.test(x.status),
        street: parts[0] || x.title, area: '', town: parts.length > 2 ? parts[1] : '', outcode: /^[A-Z]{1,2}\d[A-Z\d]?$/.test(oc) ? oc : '',
        beds: x.beds, studio: /studio/i.test(x.type), commercial: false, baths: x.baths, receptions: x.receptions, price: x.price, qualifier: '', short: '', html: d.html || '',
        available: '', furnished: '', tenure: '', pets: false, parking: false, garden: false, features: [], lat: isFinite(d.lat) && d.lat ? d.lat : null, lng: isFinite(d.lng) && d.lng ? d.lng : null,
        epc: d.epc || '', vtour: '', images: images, alts: images, floorplans: [], added: '' };
      p.where = x.title;
      p.headline = (p.studio ? 'Studio' : p.beds ? p.beds + ' bedroom ' + p.type.toLowerCase() : p.type) + ' for sale';
      p.slug = (x.title + ' ' + (p.studio ? 'studio' : p.beds + ' bed ' + p.type)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 90);
      p.url = '/property/' + p.id + '/' + p.slug;
      out.push(p);
    }
    return out;
  }
  async function refreshRightmove() {
    const counts = {};
    for (const kind of ['let', 'sale']) {
      try {
        const items = await rmBranch(kind), out = [];
        if (items[0] && !refreshRightmove.shown) { refreshRightmove.shown = 1; const x = items[0]; console.log('Rightmove list item fields: ' + Object.keys(x).join(',') + ' | images ' + JSON.stringify(x.propertyImages || {}).slice(0, 300)); }
        for (const x of items) {
          const fresh = !rmDetails.has(String(x.id));
          const d = await rmDetail(String(x.id));
          if (fresh) await new Promise(function (ok) { setTimeout(ok, 800); });   // gently, one advert at a time
          out.push(rmListing(x, d, kind));
        }
        // No sales adverts on Rightmove: our Gnomen sales feed, then (failing that) the old website.
        if (kind === 'sale' && !out.length && FEEDS.sale) { try { const g = await gnomenFeed('sale'); g.forEach(function (p) { out.push(p); }); counts.gnomen = g.length; } catch (e) { console.log('Gnomen sales feed not read: ' + e.message); } }
        if (kind === 'sale' && !out.length && OLD) { try { const o = await refreshOldSales(); if (o && o.length) { o.forEach(function (p) { out.push(p); }); counts.oldsite = o.length; } } catch (e) { console.log('Sales from the old website not read: ' + e.message); } }
        if (out.length || !data[kind].length) data[kind] = out.sort(function (a, b) { return (a.taken - b.taken) || String(b.added).localeCompare(String(a.added)); });
        counts[kind] = out.length + ' (' + out.filter(function (p) { return p.images.length > 1; }).length + ' with full photos)';
      } catch (e) { counts[kind] = 'not read: ' + e.message; }
    }
    console.log('Listings from Rightmove branch ' + BRANCH + (SALES_BRANCH !== BRANCH ? ' (sales ' + SALES_BRANCH + ')' : '') + ': to rent ' + counts.let + ', for sale ' + counts.sale + (counts.gnomen ? ' (from the Gnomen sales feed)' : counts.oldsite ? ' (from the old Gnomen website)' : '') + (LIVE ? '' : ' — staff preview only (LISTINGS_ON is off)'));
  }
  let refreshing = null;
  function refreshAll() { if (!refreshing) refreshing = doRefresh().finally(function () { refreshing = null; }); return refreshing; }
  async function doRefresh() {
    if (SOURCE === 'rightmove') await refreshRightmove(); else await refresh();
    const sig = function (p) { return [p.id, p.status, p.price, p.images.length, p.floorplans.length, p.vtour, p.available, p.headline, (p.html || p.short || '').length].join('|'); };
    const stamp = crypto.createHash('sha1').update(JSON.stringify([data.sale.map(sig), data.let.map(sig)])).digest('hex').slice(0, 12);
    // When the properties last changed: the moment we see the feed change; on first load, the latest
    // date Gnomen gives (added or updated).
    if (!data.stamp) { let latest = 0; data.let.concat(data.sale).forEach(function (p) { [p.updated, p.added].forEach(function (d) { const t = Date.parse(String(d || '').replace(' ', 'T')); if (t && t <= Date.now() && t > latest) latest = t; }); }); data.changedAt = latest || Date.now(); }
    else if (stamp !== data.stamp) { data.changedAt = Date.now(); console.log('Property listings changed — website updated'); }
    data.at = Date.now(); data.stamp = stamp;
  }
  // Gnomen is checked every couple of minutes (LISTINGS_POLL_MIN), so changes show almost straight away.
  const POLL = Math.max(1, parseFloat(process.env.LISTINGS_POLL_MIN) || 2);
  if (SOURCE === 'rightmove' || FEEDS.sale || FEEDS.let) { setTimeout(refreshAll, 3000); setInterval(function () { refreshAll().catch(function () {}); }, (SOURCE === 'rightmove' ? 30 : POLL) * 60000).unref(); }
  // Staff: "Update website now" in Fixflow — read Gnomen straight away.
  app.post('/api/admin/listings-refresh', async function (req, res) {
    if (!staff(req)) return res.status(401).json({ ok: false });
    for (const k of ['let', 'sale']) if (rmListCache[k]) rmListCache[k].at = 0;   // and look at Rightmove again
    try { await refreshAll(); } catch (e) {}
    res.json({ ok: true, let: data.let.length, sale: data.sale.length, changed: data.changedAt });
  });
  // ---------- Rent comparison for landlords (website) ----------
  // What similar homes let for near a postcode: asking rents across the whole market (all agents and portals)
  // from PropertyData's licensed API when PROPERTYDATA_API_KEY is set, otherwise the ONS average for the
  // borough and bedroom count. Never our own adverts, and never scraped from Rightmove or other portals.
  const pcGeo = new Map(), rcHits = new Map(), pdCache = new Map();
  async function geoPostcode(pc) {
    if (pcGeo.has(pc)) return pcGeo.get(pc);
    try { const r = await fetch('https://api.postcodes.io/postcodes/' + encodeURIComponent(pc), { signal: AbortSignal.timeout(6000) }); const j = r.ok ? await r.json() : null, x = j && j.result;
      const g = x ? { lat: x.latitude, lng: x.longitude, outcode: x.outcode, area: x.admin_district || '', gss: (x.codes && x.codes.admin_district) || '' } : null; if (g) pcGeo.set(pc, g); return g; } catch (e) { return null; }
  }
  async function marketRents(pc, beds) {
    const key = process.env.PROPERTYDATA_API_KEY; if (!key) return null;
    const ck = pc + '|' + beds, hit = pdCache.get(ck); if (hit && Date.now() - hit.at < 86400000) return hit.v;
    try {
      const r = await fetch('https://api.propertydata.co.uk/rents?key=' + encodeURIComponent(key) + '&postcode=' + encodeURIComponent(pc) + '&bedrooms=' + Math.min(beds, 5), { signal: AbortSignal.timeout(10000) });
      const j = await r.json(), L = j && j.data && j.data.long_let;
      if (!L || !L.average) { console.error('PropertyData rents:', r.status, JSON.stringify(j).slice(0, 300)); return null; }
      const k = /week/.test(String(L.unit || 'gbp_per_week')) ? 52 / 12 : 1, rg = L['80pc_range'] || L['70pc_range'] || L['90pc_range'] || [];
      const v = { mid: Math.round(L.average * k), low: rg[0] ? Math.round(rg[0] * k) : 0, high: rg[1] ? Math.round(rg[1] * k) : 0, count: parseInt(L.points_analysed, 10) || 0, radius: parseFloat(L.radius) || 0 };
      pdCache.set(ck, { at: Date.now(), v: v }); if (pdCache.size > 2000) pdCache.clear(); return v;
    } catch (e) { console.error('PropertyData rents failed:', e.message); return null; }
  }
  app.get('/api/public/rent-compare', async function (req, res) {
    const ip = String(req.headers['cf-connecting-ip'] || req.ip || ''), now = Date.now(), h = (rcHits.get(ip) || []).filter(function (t) { return now - t < 600000; });
    if (h.length >= 30) return res.status(429).json({ ok: false, error: 'rate-limited' }); h.push(now); rcHits.set(ip, h); if (rcHits.size > 5000) rcHits.clear();
    const m = /^([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})$/i.exec(String(req.query.postcode || '').trim());
    if (!m) return res.status(400).json({ ok: false, error: 'postcode' });
    const pc = (m[1] + ' ' + m[2]).toUpperCase(), beds = Math.max(0, Math.min(6, parseInt(req.query.beds, 10) || 0));
    res.setHeader('Cache-Control', 'no-store');
    const mk = await marketRents(pc.replace(' ', ''), beds);
    if (mk) return res.json({ ok: true, source: 'market', postcode: pc, beds: beds, radius: mk.radius, count: mk.count, low: mk.low, high: mk.high, mid: mk.mid });
    const g = await geoPostcode(pc.replace(' ', ''));
    if (!g) return res.json({ ok: false, error: 'postcode-unknown' });
    const o = opts.onsBeds ? opts.onsBeds(g.gss, beds) : null;
    res.json({ ok: true, source: 'ons', postcode: pc, beds: beds, area: g.area, gss: g.gss, slug: o ? o.slug : '', mid: o ? o.rent : 0, month: o ? o.month : '', all: o ? o.all : 0, table: o && o.beds ? o.beds : null });
  });
  const find = function (id) { id = rmAlias[id] || id; return data.let.find(function (p) { return p.id === id; }) || data.sale.find(function (p) { return p.id === id; }); };

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
        let r = await fetch(src, { headers: UA });
        const alt = /^\d+$/.test(n) && p.alts && p.alts[+n];
        if (!r.ok && alt && alt !== src) r = await fetch(alt, { headers: UA });
        if (!r.ok) throw new Error('photo ' + r.status);
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
    return '<a class="lcard" href="' + esc(p.url) + '" data-k="' + p.kind + '" data-beds="' + p.beds + '" data-price="' + Math.round(p.price) + '" data-taken="' + (p.taken ? 1 : 0) + '" data-added="' + esc(p.added) + '" data-q="' + esc((p.where + ' ' + p.type + ' ' + p.town).toLowerCase()) + '"' + (p.lat != null ? ' data-lat="' + p.lat.toFixed(5) + '" data-lng="' + p.lng.toFixed(5) + '"' : '') + '>' +
      '<div class="lph">' + (p.images.length ? pic(p, 0, sizes || '(max-width: 640px) 100vw, (max-width: 1060px) 50vw, 380px', p.headline + ', ' + p.where) : '<div class="noph">Photos coming soon</div>') +
      '<span class="lst' + (p.taken ? ' taken' : '') + '">' + esc(p.status) + '</span>' + '<span class="lmedia">' + (p.vtour ? '<span class="lm-v">' + (ytId(p.vtour) || vimeoId(p.vtour) ? '▶ Video' : '🎥 360° tour') + '</span>' : '') + (p.floorplans.length ? '<span class="lm-f">📐 Floorplan</span>' : '') + (p.images.length > 1 ? '<span>📷 ' + p.images.length + '</span>' : '') + '</span></div>' +
      '<div class="lbody"><div class="lprice">' + priceHtml(p) + '</div><h3>' + esc(p.headline) + '</h3><p class="lwhere">' + esc(p.where) + '</p><div class="lfacts">' + facts(p) + '</div>' +
      (availText(p) ? '<p class="lavail">' + esc(availText(p)) + '</p>' : '') + '</div></a>';
  }

  // ---------- Pages ----------
  const KIND = { let: { path: '/properties-to-rent', h1: 'Properties to rent', kicker: 'To rent', none: 'to rent' }, sale: { path: '/properties-for-sale', h1: 'Properties for sale', kicker: 'For sale', none: 'for sale' } };
  const whenText = function (t) {
    const d = new Date(t), o = { timeZone: 'Europe/London' }, day = function (x) { return x.toLocaleDateString('en-CA', o); };
    const time = d.toLocaleTimeString('en-GB', Object.assign({ hour: 'numeric', minute: '2-digit', hour12: true }, o)).replace(' ', '').toLowerCase();
    const today = day(new Date()), yest = day(new Date(Date.now() - 86400000));
    return (day(d) === today ? 'today' : day(d) === yest ? 'yesterday' : d.toLocaleDateString('en-GB', Object.assign({ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }, o))) + ' at ' + time;
  };
  function listPage(req, res, kind) {
    const K = KIND[kind], pv = preview(req), items = show(req) ? data[kind] : [], avail = items.filter(function (p) { return !p.taken; }).length;
    const prices = kind === 'let' ? [1000, 1250, 1500, 1750, 2000, 2500, 3000, 4000, 5000] : [250000, 300000, 400000, 500000, 600000, 750000, 1000000, 1500000, 2000000];
    const body = (pv ? '<div class="pvbar">👀 Staff preview — only people signed in to Fixflow can see these properties. They’re not public yet.</div>' : '') + '<div class="phead photo small lhead">' + (function () { const im = kind === 'let' ? 'u-flat-open' : 'u-london-night'; return '<img class="bg" src="/img/' + im + '.webp" srcset="/img/' + im + '-sm.webp 800w, /img/' + im + '.webp 1600w" sizes="100vw" alt="" fetchpriority="high" width="1600" height="1066">'; })() + '<div class="wrap"><div class="lupd-row"><span class="eyebrow"><i></i> ' + K.kicker + ' · London</span>' + (data.changedAt ? '<span class="lupd" title="When our property list last changed">🕒 Last updated ' + esc(whenText(data.changedAt)) + '</span>' : '') + '</div><h1>' + K.h1 + '</h1>' +
      '<p class="lead">' + (items.length ? avail + ' available now' + (items.length > avail ? ' · ' + (items.length - avail) + ' ' + (kind === 'let' ? 'let agreed or under offer' : 'under offer or sold STC') : '') + '.' : 'New properties are coming soon.') + '</p></div></div>' +
      (items.length ? '<section class="lsec"><div class="wrap"><form class="lfilter" id="lFilter" onsubmit="return false" role="search" aria-label="Filter properties">' +
        '<div class="lf-q"><label for="lfQ">Area or postcode</label><div class="lf-qrow"><input id="lfQ" type="search" name="q" placeholder="e.g. SE1, Camberwell" autocomplete="off" enterkeyhint="search"><button type="submit" class="lf-go" aria-label="Search">Search</button></div></div>' +
        '<label>Bedrooms<select name="beds"><option value="">Any</option><option value="0">Studio+</option><option value="1">1+</option><option value="2">2+</option><option value="3">3+</option><option value="4">4+</option></select></label>' +
        '<label>Max price<select name="max"><option value="">No max</option>' + prices.map(function (v) { return '<option value="' + v + '">' + gbp(v) + (kind === 'let' ? ' pcm' : '') + '</option>'; }).join('') + '</select></label>' +
        '<label>Sort<select name="sort"><option value="new">Newest</option><option value="low">Lowest price</option><option value="high">Highest price</option></select></label>' +
        '<label class="lf-chk"><input type="checkbox" name="all" checked> Include ' + (kind === 'let' ? 'let agreed' : 'under offer') + '</label></form>' +
        '<div class="lviews" role="group" aria-label="How to show the properties"><button type="button" class="on" data-view="list">☰ List</button><button type="button" data-view="map">🗺️ Map</button><button type="button" data-view="near">➤ Near me</button><span class="lnear" id="lNear" hidden></span></div>' +
        '<div class="lmap" id="lMap" hidden></div>' +
        '<p class="lcountline" id="lCount" aria-live="polite"></p><div class="lgrid" id="lGrid">' + items.map(function (p) { return card(p); }).join('') + '</div>' +
        '<div class="lnone" id="lNone" hidden><h3>No properties match those filters</h3><p>Try widening your search — or tell us what you’re looking for and we’ll let you know when something comes up.</p><a class="btn red" href="/contact?topic=' + (kind === 'let' ? 'Looking%20to%20rent' : 'Buying') + '">Tell us what you need →</a></div></div></section>'
      : '<section class="white"><div class="wrap" style="text-align:center;max-width:640px"><h2>Our list of properties ' + K.none + ' is on its way</h2><p class="sub" style="margin:0 auto 24px">Tell us what you’re looking for and we’ll let you know about suitable homes — or call us on 0207 096 8131.</p><a class="btn red" href="/contact?topic=' + (kind === 'let' ? 'Looking%20to%20rent' : 'Buying') + '">Tell us what you need →</a></div></section>') +
      '<section><div class="wrap"><div class="band"><div><h2>' + (kind === 'let' ? 'Got a property to let?' : 'Thinking of selling?') + '</h2><p>Get a free, no-obligation valuation from our local team.</p></div><div class="btns"><a class="btn red" href="' + (kind === 'let' ? '/landlords#valuation' : '/sales#sales-valuation') + '">Free valuation →</a><a class="btn ghost" href="tel:02070968131">📞 0207 096 8131</a></div></div></div></section>';
    const ld = items.length ? [{ '@type': 'ItemList', name: K.h1 + ' in London', numberOfItems: items.length, itemListElement: items.slice(0, 50).map(function (p, i) { return { '@type': 'ListItem', position: i + 1, url: opts.siteUrl + p.url, name: p.headline + ', ' + p.where }; }) }] : [];
    opts.send(req, res, { canon: K.path, crumb: K.h1, title: K.h1 + ' in London | Residential Realtors', desc: (kind === 'let' ? 'Flats and houses to rent in London from Residential Realtors' : 'Homes for sale in London from Residential Realtors') + ' — photos, floorplans, prices and availability, updated throughout the day.', ld: pv ? [] : ld, name: 'list-' + kind + (pv ? '-pv' : ''), stamp: data.stamp + new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' }), private: pv, robots: items.length && !pv ? '' : 'noindex, follow' }, body);
  }
  app.get(['/properties-to-rent', '/to-rent', '/rent', '/lettings', '/properties'], function (req, res) { listPage(req, res, 'let'); });
  app.get(['/properties-for-sale', '/for-sale', '/buy'], function (req, res) { listPage(req, res, 'sale'); });

  // Links from our old Gnomen website keep working: /search~action=detail,pid=3925 (and
  // /property-search~…) go to that property's page; old search pages go to the list.
  app.use(function (req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let path = req.path; try { path = decodeURIComponent(path); } catch (e) {}
    const old = /^\/(?:property-)?search~(.*)$/i.exec(path);
    if (old) {
      const pid = (/(?:^|[,&;~])pid=(\d+)/i.exec(old[1]) || [])[1];
      if (pid) { const p = find(pid); return res.redirect(301, p ? p.url : '/property/' + pid); }
      return res.redirect(301, /sale|buy|property_for=1|for=1/i.test(old[1]) ? '/properties-for-sale' : '/properties-to-rent');
    }
    next();
  });
  // Book a viewing: pick up to 3 times that suit, then name, phone and email. Opens over the property page.
  function book(p) {
    return '<div class="bk" id="book" role="dialog" aria-modal="true" aria-labelledby="bkH"><a class="bk-bg" href="#" aria-label="Close" tabindex="-1"></a>' +
      '<form class="bk-box form" id="bkForm" novalidate data-ref="' + esc(p.id) + '" data-addr="' + esc(p.where) + '" data-kind="' + p.kind + '" data-url="' + esc(p.url) + '"><a class="bk-x" href="#" aria-label="Close">×</a><div id="bkBody">' +
      '<p class="kicker">Book a viewing</p><h3 id="bkH">' + esc(p.headline) + '</h3><p class="bk-where">📍 ' + esc(p.where) + '</p>' +
      '<div class="bk-step"><b><i>1</i> Pick up to 3 times that suit you</b><small>This is a request, not a confirmed booking — one of our agents will contact you first to agree a time.</small></div>' +
      '<div class="bk-days" id="bkDays" role="group" aria-label="Day"></div><div class="bk-times" id="bkTimes" role="group" aria-label="Time"></div>' +
      '<div class="bk-picked" id="bkPicked" aria-live="polite"></div>' +
      '<label class="bk-flex"><input type="checkbox" name="flexible"> I’m flexible — any time is fine</label>' +
      '<div class="bk-step"><b><i>2</i> Your details</b></div><div class="fg">' +
      '<label>Your name<input name="name" autocomplete="name" required></label><label>Mobile<input name="phone" type="tel" autocomplete="tel" inputmode="tel" required></label>' +
      '<label class="full">Email<input name="email" type="email" autocomplete="email" required></label>' +
      (p.kind === 'let' ? '<label>How many people?<select name="people"><option value="">Choose…</option><option>1</option><option>2</option><option>3</option><option>4</option><option>5+</option></select></label><label>When do you want to move?<select name="move"><option value="">Choose…</option><option>As soon as possible</option><option>Within a month</option><option>1–2 months</option><option>Just looking</option></select></label>'
        : '<label class="full">Your position<select name="move"><option value="">Choose…</option><option>First-time buyer</option><option>Nothing to sell</option><option>Selling — on the market</option><option>Selling — not yet on the market</option><option>Investor</option></select></label>') +
      '<label class="full">Anything else? <span class="opt">(optional)</span><textarea name="message" rows="2" placeholder="e.g. questions about the property"></textarea></label>' +
      '<label class="hp" aria-hidden="true">Leave this empty<input name="website" tabindex="-1" autocomplete="off"></label>' +
      '<label class="full consent"><input type="checkbox" name="consent" required> <span>I’m happy for Residential Realtors to contact me about this viewing. See our <a href="/privacy">privacy notice</a>.</span></label></div>' +
      '<p class="bk-note">ℹ️ Sending this form <b>doesn’t book the viewing</b>. One of our agents will call or email you first to confirm a time that works.</p><p class="ferr" id="bkErr" role="alert"></p><button class="btn red" type="submit" id="bkGo">Request viewing →</button><p class="bk-call">Rather talk? Call <a href="tel:02070968131">0207 096 8131</a></p></div></form></div>';
  }
  app.get(['/property/:id', '/property/:id/*'], function (req, res) {
    const pv = preview(req), p = show(req) ? find(String(req.params.id)) : null;
    if (!p) {
      res.status(404);
      return opts.send(req, res, { canon: '/properties-to-rent', title: 'Property no longer available | Residential Realtors', desc: 'This property is no longer on the market.', robots: 'noindex, follow', name: '404' },
        '<div class="phead small"><div class="wrap"><span class="eyebrow"><i></i> Properties</span><h1>This property is no longer available</h1><p class="lead">It may have been let or sold. Have a look at what’s on the market now.</p><div class="btns"><a class="btn red" href="/properties-to-rent">Properties to rent →</a><a class="btn ghost" href="/properties-for-sale">Properties for sale</a></div></div></div>');
    }
    if (req.path !== p.url) return res.redirect(301, p.url);   // old or changed address → the current one
    const isVid = !!(ytId(p.vtour) || vimeoId(p.vtour)), hasMedia = !!(p.vtour || p.floorplans.length);
    const K = KIND[p.kind], n = p.images.length, mapQ = p.lat != null ? p.lat + ',' + p.lng : encodeURIComponent(p.where);
    const view = '#book', ask = '/contact?topic=' + (p.kind === 'let' ? 'Looking%20to%20rent' : 'Buying') + '&address=' + encodeURIComponent(p.where) + '&ref=' + p.id;
    const offer = '/offer?p=' + encodeURIComponent(p.where);
    const share = encodeURIComponent(p.headline + ', ' + p.where + ' — ' + opts.siteUrl + p.url);
    const extras = [p.furnished ? (p.furnished === 'Full' ? 'Furnished' : p.furnished) : '', p.tenure, p.parking ? 'Parking' : '', p.garden ? 'Garden' : '', p.kind === 'let' ? (p.pets ? 'Pets considered' : '') : ''].filter(Boolean);
    const body = (pv ? '<div class="pvbar">👀 Staff preview — only people signed in to Fixflow can see these properties. They’re not public yet.</div>' : '') + '<div class="pdhead"><div class="wrap"><nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a> › <a href="' + K.path + '">' + K.h1 + '</a> › <span>' + esc(p.where) + '</span></nav></div></div>' +
      '<section class="pd"><div class="wrap">' + (hasMedia ? '<div class="pdtabs" role="tablist" aria-label="Photos, video and floorplan"><button type="button" class="on" data-pdtab="photos">📷 Photos' + (n ? '<span class="pdt-n"> (' + n + ')</span>' : '') + '</button>' + (p.vtour ? '<button type="button" class="pdt-v" data-pdtab="video">' + (isVid ? '▶ Video' : '🎥 360° tour') + '</button>' : '') + (p.floorplans.length ? '<button type="button" class="pdt-f" data-pdtab="plan">📐 Floorplan</button>' : '') + '</div>' : '') + '<div class="pdmedia" id="pdmedia">' +
      (n ? '<div class="gal" id="gal"><div class="gtrack" id="gTrack">' + p.images.map(function (u, i) { return '<figure>' + pic(p, i, '(max-width: 1100px) 100vw, 1100px', p.headline + ' — photo ' + (i + 1) + ' of ' + n, i === 0 ? ' fetchpriority="high" decoding="async"' : ' loading="lazy" decoding="async"') + '</figure>'; }).join('') + '</div>' +
        (n > 1 ? '<button class="gbtn prev" type="button" aria-label="Previous photo">‹</button><button class="gbtn next" type="button" aria-label="Next photo">›</button><span class="gnum" id="gNum">1 / ' + n + '</span>' : '') +
        '<span class="lst' + (p.taken ? ' taken' : '') + '">' + esc(p.status) + '</span>' +
        (p.vtour || p.floorplans.length ? '<div class="gmedia">' + (p.vtour ? '<a class="gm-v" href="#pdmedia" data-pdtab="video">' + (isVid ? '▶ Watch the video' : '🎥 360° tour') + '</a>' : '') + (p.floorplans.length ? '<a class="gm-f" href="#pdmedia" data-pdtab="plan">📐 Floorplan</a>' : '') + '</div>' : '') + '</div>' : '') +
      (p.vtour ? '<div class="pdpanel" data-panel="video" hidden>' + (ytId(p.vtour) ? '<div class="pdvid"><iframe data-src="https://www.youtube-nocookie.com/embed/' + ytId(p.vtour) + '?rel=0&autoplay=1" title="Video tour of ' + esc(p.where) + '" allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>'
        : vimeoId(p.vtour) ? '<div class="pdvid"><iframe data-src="https://player.vimeo.com/video/' + vimeoId(p.vtour) + '?autoplay=1" title="Video tour of ' + esc(p.where) + '" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe></div>'
        : '<div class="pdtour"' + (n ? ' style="background-image:url(/listing-img/' + p.id + '/0.webp?w=1200)"' : '') + '><a class="btn red" href="' + esc(p.vtour) + '" target="_blank" rel="noopener">🎥 Open the 360° virtual tour ↗</a><span>Walk round the property from your phone or computer</span></div>') + '</div>' : '') +
      (p.floorplans.length ? '<div class="pdpanel pdplanp" data-panel="plan" hidden>' + p.floorplans.map(function (u, i) { return '<a href="/listing-img/' + p.id + '/fp' + i + '.webp?w=1600" target="_blank" rel="noopener"><img src="/listing-img/' + p.id + '/fp' + i + '.webp?w=1200" alt="Floorplan ' + (i + 1) + ' of ' + esc(p.where) + '" loading="lazy" width="1200" height="900"></a>'; }).join('') + '</div>' : '') +
      '</div>' +
      '<div class="pdgrid"><div class="pdmain">' +
        '<div class="lprice big">' + priceHtml(p) + '</div><h1>' + esc(p.headline) + '</h1><p class="pdwhere">📍 ' + esc(p.where) + '</p>' +
        '<div class="lfacts big">' + facts(p) + '</div>' + (availText(p) ? '<p class="lavail">' + esc(availText(p)) + '</p>' : '') +
        (extras.length ? '<div class="tagrow">' + extras.map(function (t) { return '<span>' + esc(t) + '</span>'; }).join('') + '</div>' : '') +
        (p.vtour || p.floorplans.length || p.epc ? '<div class="pdjump">' + (p.vtour ? '<a href="#pdmedia" data-pdtab="video" class="pj-v">' + (isVid ? '▶ Watch the video' : '🎥 360° tour') + '</a>' : '') + (p.floorplans.length ? '<a href="#pdmedia" data-pdtab="plan" class="pj-f">📐 Floorplan</a>' : '') + (p.epc ? '<a href="#pd-epc">⚡ EPC</a>' : '') + '<a href="#pd-map">📍 Map</a></div>' : '') +
        (p.html ? '<h2>About this property</h2><div class="pddesc">' + p.html + '</div>' : (p.short ? '<h2>About this property</h2><p class="pddesc">' + esc(p.short) + '</p>' : '')) +
        (p.features.length ? '<h2>Key features</h2><ul class="ticks cols2">' + p.features.map(function (f) { return '<li>' + esc(f) + '</li>'; }).join('') + '</ul>' : '') +
        (p.floorplans.length ? '<h2 id="pd-floorplan">Floorplan</h2>' + p.floorplans.map(function (u, i) { return '<a class="pdplan" href="/listing-img/' + p.id + '/fp' + i + '.webp?w=1600" target="_blank" rel="noopener">' + pic(p, 'fp' + i, '(max-width: 900px) 100vw, 700px', 'Floorplan ' + (i + 1)) + '</a>'; }).join('') : '') +
        (p.epc ? '<h2 id="pd-epc">Energy performance (EPC)</h2><a class="pdplan epc" href="/listing-img/' + p.id + '/epc.webp?w=1200" target="_blank" rel="noopener">' + pic(p, 'epc', '(max-width: 900px) 100vw, 520px', 'EPC energy rating chart') + '</a>' : '') +
        '<h2 id="pd-map">Location</h2><iframe class="map" title="Map of ' + esc(p.where) + '" src="https://maps.google.com/maps?q=' + mapQ + '&amp;z=15&amp;output=embed" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe><p class="mapnote">The map shows the approximate location.</p>' +
      '</div><aside class="pdside"><div class="pdbox">' +
        '<div class="lprice">' + priceHtml(p) + '</div><p class="pdsideh">' + esc(p.headline) + '</p>' +
        '<a class="btn red" href="' + esc(view) + '">Book a viewing</a>' + (p.kind === 'let' ? '<a class="btn navy" href="' + esc(offer) + '">Make an offer</a>' : '<a class="btn navy" href="' + esc(ask) + '">Make an enquiry</a>') +
        '<a class="btn line" href="tel:02070968131">📞 0207 096 8131</a>' + (p.vtour ? '<a class="btn line" href="#pdmedia" data-pdtab="video">' + (isVid ? '▶ Watch the video' : '🎥 360° tour') + '</a>' : '') + (p.floorplans.length ? '<a class="btn line" href="#pdmedia" data-pdtab="plan">📐 See the floorplan</a>' : '') +
        '<a class="pdshare" href="https://wa.me/?text=' + share + '" target="_blank" rel="noopener">Share on WhatsApp</a><p class="pdref">Ref. ' + esc(p.id) + '</p></div></aside></div></div></section>' +
      book(p) +
      '<div class="pdbar"><a class="btn red" href="' + esc(view) + '">Book a viewing</a>' + (p.kind === 'let' ? '<a class="btn navy" href="' + esc(offer) + '">Make an offer</a>' : '<a class="btn navy" href="tel:02070968131">📞 Call us</a>') + '</div>' +
      (function () { const more = data[p.kind].filter(function (x) { return x.id !== p.id && !x.taken; }).slice(0, 3); return more.length ? '<section class="white"><div class="wrap"><div class="head"><h2>More ' + K.none + '</h2></div><div class="lgrid">' + more.map(function (x) { return card(x); }).join('') + '</div><p style="margin-top:22px"><a class="btn line" href="' + K.path + '">See all ' + K.h1.toLowerCase() + ' →</a></p></div></section>' : ''; })();
    const ld = [{ '@type': 'RealEstateListing', name: p.headline + ', ' + p.where, url: opts.siteUrl + p.url, datePosted: String(p.added).slice(0, 10) || undefined, description: p.short || undefined,
      image: p.images.slice(0, 6), offers: { '@type': 'Offer', price: Math.round(p.price), priceCurrency: 'GBP', availability: p.taken ? 'https://schema.org/LimitedAvailability' : 'https://schema.org/InStock', businessFunction: p.kind === 'let' ? 'http://purl.org/goodrelations/v1#LeaseOut' : 'http://purl.org/goodrelations/v1#Sell', seller: { '@id': opts.siteUrl + '/#agency' } },
      about: { '@type': p.type === 'House' ? 'House' : 'Apartment', numberOfRooms: p.beds || undefined, numberOfBedrooms: p.beds, numberOfBathroomsTotal: p.baths || undefined, address: { '@type': 'PostalAddress', streetAddress: p.street, addressLocality: p.area || p.town, postalCode: p.outcode, addressCountry: 'GB' },
        geo: p.lat != null ? { '@type': 'GeoCoordinates', latitude: +p.lat.toFixed(3), longitude: +p.lng.toFixed(3) } : undefined } }];
    opts.send(req, res, { canon: p.url, crumb: K.h1, crumbUrl: K.path, crumb2: p.where, title: p.headline + ' in ' + p.where + ' | Residential Realtors', desc: (p.short || p.headline + ' in ' + p.where).slice(0, 155),
      ogImg: n ? opts.siteUrl + '/listing-img/' + p.id + '/0.webp?w=1200' : '', ld: pv ? [] : ld, name: 'p' + p.id + (pv ? '-pv' : ''), stamp: data.stamp, private: pv, robots: pv ? 'noindex, nofollow' : '', preload: n ? '/listing-img/' + p.id + '/0.webp?w=800' : '' }, body);
  });

  // ---------- The same photo on more than one property (to get it removed in Gnomen) ----------
  // Each photo gets a small fingerprint of what it looks like (so a re-upload under another name still
  // matches); photos on two different homes with the same fingerprint are reported. Checked slowly in
  // the background, one photo at a time; fingerprints are remembered so each photo is read once.
  const fp = new Map();   // photo address -> 64-bit fingerprint (hex) or '' if unreadable
  let dupes = [], dupesAt = 0, checking = false, progress = { done: 0, total: 0 }, fpLoaded = false;
  // Fingerprints are kept in the database, so a restart doesn't read every photo again.
  async function fpDb() { try { const p = opts.db && await opts.db(); if (!p) return null; if (!fpLoaded) { await p.query('CREATE TABLE IF NOT EXISTS photo_prints (url TEXT PRIMARY KEY, h TEXT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT now())'); (await p.query('SELECT url, h FROM photo_prints')).rows.forEach(function (r) { fp.set(r.url, r.h); }); fpLoaded = true; } return p; } catch (e) { return null; } }
  async function fingerprint(url) {
    if (fp.has(url)) return fp.get(url);
    let h = '';
    try {
      // Gnomen's small thumbnail (about 30KB) is plenty to compare by; the full photo if there isn't one.
      const small = /\/Gnomen-Pms5-I\/[^/]+\/large\//.test(url) ? url.replace('/large/', '/thumbnails/') : '';
      let r = small ? await fetch(small, { headers: UA, signal: AbortSignal.timeout(15000) }) : null;
      if (!r || !r.ok) r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
      if (r.ok && sharp) {
        const px = await sharp(Buffer.from(await r.arrayBuffer())).rotate().greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
        let bits = '';
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += px[y * 9 + x] > px[y * 9 + x + 1] ? '1' : '0';
        // A plain or nearly plain picture (all the same) can't be told apart from others — skip it.
        if (/^(0+|1+)$/.test(bits)) h = ''; else h = BigInt('0b' + bits).toString(16).padStart(16, '0');
      }
    } catch (e) { h = null; }
    if (h !== null) { fp.set(url, h); const p = await fpDb(); if (p) p.query('INSERT INTO photo_prints (url, h) VALUES ($1, $2) ON CONFLICT (url) DO UPDATE SET h = $2', [url, h]).catch(function () {}); }
    return h || '';
  }
  const hamming = function (a, b) { let x = BigInt('0x' + a) ^ BigInt('0x' + b), n = 0; while (x) { n += Number(x & 1n); x >>= 1n; } return n; };
  async function checkPhotos() {
    if (checking || !sharp || process.env.PHOTO_CHECK === '0') return; checking = true;
    try {
      await fpDb();
      const homes = data.let.concat(data.sale), items = [], jobs = [];
      homes.forEach(function (p) { p.images.forEach(function (u, i) { jobs.push({ p: p, i: i, u: u }); }); });
      progress = { done: 0, total: jobs.length };
      // Eight photos at a time.
      let next = 0;
      await Promise.all(Array.from({ length: 8 }, async function () {
        while (next < jobs.length) {
          const j = jobs[next++], h = await fingerprint(j.u); progress.done++;
          if (h) items.push({ h: h, id: j.p.id, where: j.p.where, url: j.p.url, kind: j.p.kind, n: j.i, img: j.u });
        }
      }));
      // Group photos that look the same (fingerprints within 4 of 64 bits), across different homes.
      const groups = [], used = new Set();
      for (let a = 0; a < items.length; a++) {
        if (used.has(a)) continue; const g = [items[a]];
        for (let b = a + 1; b < items.length; b++) if (!used.has(b) && items[b].id !== items[a].id && (items[b].h === items[a].h || hamming(items[a].h, items[b].h) <= 4)) { g.push(items[b]); used.add(b); }
        if (g.length > 1) { used.add(a); const ids = {}; g.forEach(function (x) { ids[x.id] = 1; }); if (Object.keys(ids).length > 1) groups.push(g); }
      }
      // Report by pairs of homes ("Corry Drive and St Leonards Road share 10 photos") — easier to fix in Gnomen.
      const pairs = {};
      groups.forEach(function (g) {
        for (let a = 0; a < g.length; a++) for (let b = a + 1; b < g.length; b++) {
          if (g[a].id === g[b].id) continue;
          const x = +g[a].id < +g[b].id ? g[a] : g[b], y = x === g[a] ? g[b] : g[a], k = x.id + '+' + y.id;
          const pr = pairs[k] || (pairs[k] = { key: k, homes: [x, y].map(function (h) { return { id: h.id, where: h.where, url: h.url, img: '/listing-img/' + h.id + '/' + h.n + '.webp?w=480' }; }), photos: [] });
          if (!pr.photos.some(function (q) { return q[0] === x.n + 1 && q[1] === y.n + 1; })) pr.photos.push([x.n + 1, y.n + 1]);
        }
      });
      const oc = function (w) { return (String(w).match(/\b([A-Z]{1,2}\d[A-Z\d]?)\s*$/) || [])[1] || ''; };
      dupes = Object.keys(pairs).map(function (k) { const pr = pairs[k]; pr.count = pr.photos.length; pr.sameArea = !!oc(pr.homes[0].where) && oc(pr.homes[0].where) === oc(pr.homes[1].where) && pr.homes[0].where.split(',')[0] === pr.homes[1].where.split(',')[0]; return pr; })
        .sort(function (a, b) { return (a.sameArea - b.sameArea) || (b.count - a.count); });
      dupesAt = Date.now();
      console.log('Photo check: ' + items.length + ' photos on ' + homes.length + ' homes — ' + (dupes.length ? dupes.length + ' pair(s) of homes sharing photos (' + groups.length + ' photos)' : 'no repeats'));
      if (opts.onPhotoDupes) opts.onPhotoDupes(dupes);
    } catch (e) { console.log('Photo check stopped: ' + e.message); }
    checking = false;
  }
  setTimeout(function () { checkPhotos(); }, 60000); setInterval(function () { checkPhotos(); }, 2 * 3600000).unref();

  return {
    photoDupes: function () { return { at: dupesAt, checking: checking, done: progress.done, total: progress.total, groups: dupes }; },
    // Shown to this visitor (everyone when live, signed-in staff otherwise), and there's something to show.
    show: function (req) { return show(req) && (data.let.length + data.sale.length) > 0; },
    preview: preview,
    stamp: function () { return data.stamp; },
    // When the property list last changed, in words ("today at 7:30pm"); '' before the first read.
    updated: function () { return data.changedAt ? whenText(data.changedAt) : ''; },
    updatedShort: function () { return data.changedAt ? whenText(data.changedAt).replace(/^today at /, '').replace(/ at .*$/, '').replace(/^\w{3} (\d+ \w{3}) \d{4}$/, '$1') : ''; },
    // A few of the latest, for the home page.
    featured: function (req) {
      if (!show(req)) return '';
      const pick = data.let.concat(data.sale).filter(function (p) { return !p.taken; }).sort(function (a, b) { return String(b.added).localeCompare(String(a.added)); }).slice(0, 10);
      if (!pick.length) return '';
      // A swipeable row of the latest homes.
      return '<section class="feat2"><div class="wrap"><div class="head2 row"><div><p class="kicker">On the market now</p><h2>Latest <em>homes.</em></h2></div>' +
        '<div class="car-nav"><button type="button" class="car-b" data-car="-1" aria-label="Previous homes">‹</button><button type="button" class="car-b" data-car="1" aria-label="More homes">›</button></div></div>' +
        '<div class="car" id="car">' + pick.map(function (p) { return card(p, '(max-width: 640px) 85vw, 360px'); }).join('') + '</div>' +
        '<div class="btns car-all">' + (data.let.length ? '<a class="btn navy" href="/properties-to-rent">All homes to rent →</a>' : '') + (data.sale.length ? '<a class="btn line" href="/properties-for-sale">All homes for sale →</a>' : '') + '</div></div></section>';
    },
    // Live numbers for the home page: homes available now, and the areas they're in.
    counts: function (req) {
      if (!show(req)) return null;
      const av = data.let.concat(data.sale).filter(function (p) { return !p.taken; }), n = {};
      av.forEach(function (p) { if (p.outcode) n[p.outcode] = (n[p.outcode] || 0) + 1; });
      return { let: data.let.filter(function (p) { return !p.taken; }).length, sale: data.sale.filter(function (p) { return !p.taken; }).length,
        areas: Object.keys(n).sort(function (a, b) { return n[b] - n[a] || a.localeCompare(b); }).slice(0, 14) };
    },
    // Available homes in some postcode districts ('W1' matches W1T but 'SW1' doesn't match SW10), for the area pages.
    near: function (req, outcodes, max) {
      if (!show(req)) return '';
      const hit = function (o) { return outcodes.some(function (b) { return o === b || (o.indexOf(b) === 0 && /[A-Z]/.test(o.charAt(b.length))); }); };
      const pick = data.let.concat(data.sale).filter(function (p) { return !p.taken && p.outcode && hit(p.outcode); }).sort(function (a, b) { return String(b.added).localeCompare(String(a.added)); }).slice(0, max || 6);
      return pick.map(function (p) { return card(p, '(max-width: 640px) 85vw, 360px'); }).join('');
    },
    // Our own lets near a postcode (any status, incl. let agreed) for staff to add to a comparables report.
    compsNear: async function (postcode, beds) {
      const g = await geoPostcode(String(postcode || '').replace(/\s+/g, '').toUpperCase()) || {}, has = isFinite(g.lat) && isFinite(g.lng);
      const mi = function (a, b, c, d) { const R = 3958.8, t = Math.PI / 180, x = Math.sin((c - a) * t / 2), y = Math.sin((d - b) * t / 2); return 2 * R * Math.asin(Math.sqrt(x * x + Math.cos(a * t) * Math.cos(c * t) * y * y)); };
      const n = /studio/i.test(beds || '') ? 0 : parseInt(beds, 10), five = /\+/.test(beds || '') || n >= 5, out = String(postcode || '').trim().split(/\s+/)[0].toUpperCase();
      return data.let.filter(function (p) { return !p.commercial && p.price > 0 && (isNaN(n) || (n === 0 ? p.studio || p.beds === 0 : five ? p.beds >= 5 : p.beds === n && !p.studio)); })
        .map(function (p) { const d = has && p.lat != null ? mi(g.lat, g.lng, p.lat, p.lng) : (p.outcode === out ? 0.5 : 99); return { url: opts.siteUrl + p.url, address: p.where, beds: p.studio ? 'Studio' : String(p.beds), rent: Math.round(p.price), dist: Math.round(d * 10) / 10, status: p.status || '' }; })
        .filter(function (x) { return x.dist <= 3; }).sort(function (a, b) { return a.dist - b.dist; }).slice(0, 15);
    },
    // Gnomen numbers for the office's available list: matched on postcode, bedrooms and door number (only when clear-cut).
    gnomenFor: function (rows) {
      const out = {}, recs = data.let.concat(data.sale).filter(function (p) { return /^\d+$/.test(String(p.id)) && p.postcode; });
      const PC = /([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i, door = function (s) { const m = /^\s*(?:flat|apartment|apt|unit)?\s*([0-9]+[a-z]?)\b/i.exec(String(s || '')); return m ? m[1].toLowerCase() : ''; };
      (rows || []).forEach(function (r) {
        const m = PC.exec(String(r.address || '')); if (!m) return;
        const pc = (m[1] + m[2]).toUpperCase(), beds = r.beds == null ? null : Number(r.beds), addr = String(r.address).toLowerCase();
        let c = recs.filter(function (p) { return p.postcode === pc && (beds == null || p.beds === beds); });
        if (c.length > 1) { const d = door(r.address); if (d) { const byNo = c.filter(function (p) { return p.unit && p.unit.split('|')[0] === d.replace(/[^a-z0-9]/g, ''); }); if (byNo.length) c = byNo; } }
        if (c.length > 1) { const bySt = c.filter(function (p) { return p.street && addr.indexOf(String(p.street).toLowerCase().replace(/^[\d\s\w]*?\d+[a-z]?\s+/, '').trim()) !== -1; }); if (bySt.length) c = bySt; }
        const ids = Array.from(new Set(c.map(function (p) { return String(p.id); })));
        if (ids.length === 1) out[r.id] = ids[0];
      });
      return out;
    },
    urls: function () { return LIVE ? data.let.concat(data.sale).map(function (p) { return p.url; }) : []; }
  };
};
