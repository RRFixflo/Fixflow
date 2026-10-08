// Our properties with other agents: each night, the Rightmove adverts of other agents in the same postcode
// area with the same bedrooms are checked against our properties (available, and let in the last 3 years).
// A match on our own photos (fingerprints kept by listings.js in own_photos) or on the building name / street
// means the landlord may be marketing with someone else — worth a call. A small, gentle number of Rightmove
// pages a night (one search per postcode area and bedroom count), each property checked about every 2 weeks.
module.exports = function (app, opts) {
  const T = opts.tools, NIGHT_ROWS = Math.max(10, parseInt(process.env.RIVALS_PER_NIGHT, 10) || 120);
  let ready = null, running = false;
  async function pool() {
    const p = await opts.db(); if (!p) return null;
    if (!ready) ready = p.query(`CREATE TABLE IF NOT EXISTS rival_hits (id SERIAL PRIMARY KEY, prop_id INTEGER NOT NULL, rm_id TEXT NOT NULL, kind TEXT NOT NULL, photos INTEGER NOT NULL DEFAULT 0,
      agent TEXT, address TEXT, price TEXT, beds INTEGER, status TEXT, url TEXT, img TEXT, listed TEXT, first_seen TIMESTAMPTZ NOT NULL DEFAULT now(), last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
      dismissed_at TIMESTAMPTZ, dismissed_by TEXT, told BOOLEAN NOT NULL DEFAULT false, UNIQUE (prop_id, rm_id))`).catch(function (e) { ready = null; throw e; });
    await ready; return p;
  }
  async function state(p, v) {
    if (v) { await p.query("INSERT INTO app_settings (key, value) VALUES ('rivals', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [JSON.stringify(v)]); return v; }
    const r = (await p.query("SELECT value FROM app_settings WHERE key = 'rivals'")).rows[0], s = (r && r.value) || {};
    s.checked = s.checked || {}; s.oc = s.oc || {}; return s;
  }
  const wait = function (ms) { return new Promise(function (ok) { setTimeout(ok, ms); }); };
  const get = async function (url, json) {
    const r = await fetch(url, { headers: Object.assign({ Accept: json ? 'application/json, text/plain, */*' : 'text/html,application/json;q=0.9,*/*;q=0.8' }, T.UA), signal: AbortSignal.timeout(20000) });
    if (r.status === 403 || r.status === 429) { const e = new Error('Rightmove answered ' + r.status); e.blocked = true; throw e; }
    return r.ok ? r.text() : '';
  };
  // Rightmove's number for a postcode area (SE1 → OUTCODE^2307), remembered.
  async function outcodeId(s, oc) {
    if (s.oc[oc]) return s.oc[oc];
    let id = '';
    try { const j = JSON.parse(await get('https://los.rightmove.co.uk/typeahead?query=' + encodeURIComponent(oc) + '&limit=10&exclude=STREET', true) || '{}');
      const m = (j.matches || []).filter(function (x) { return String(x.type).toUpperCase() === 'OUTCODE' && String(x.displayName || '').toUpperCase().replace(/\s/g, '') === oc; })[0]; if (m) id = String(m.id); } catch (e) { if (e.blocked) throw e; }
    if (!id) { const h = await get(T.RM + '/property-to-rent/find.html?searchLocation=' + encodeURIComponent(oc) + '&useLocationIdentifier=false'); const m = /OUTCODE(?:%5E|\^)(\d+)/.exec(h); if (m) id = m[1]; }
    if (id) s.oc[oc] = id;
    return id;
  }
  // Rightmove adverts to rent in that area with that many bedrooms (other agents only).
  // (o: { loc: a full location id such as POSTCODE%5E123, radius in miles, buy: for sale, fresh: leave out let agreed / sold STC })
  async function search(id, beds, o) {
    o = o || {};
    const items = [], seen = {}, bq = beds == null ? '' : '&minBedrooms=' + beds + '&maxBedrooms=' + beds, loc = o.loc || 'OUTCODE%5E' + id, rad = '&radius=' + (o.radius || '0.0');
    const ch = o.buy ? 'BUY' : 'RENT', inc = o.fresh ? '' : (o.buy ? '&includeSSTC=true' : '&includeLetAgreed=true&_includeLetAgreed=on');
    for (let index = 0; index < 72; index += 24) {
      const urls = [T.RM + '/api/property-search/listing/search?searchLocation=&useLocationIdentifier=true&locationIdentifier=' + loc + '&channel=' + ch + '&index=' + index + '&sortType=6' + inc + rad + bq,
        T.RM + (o.buy ? '/property-for-sale' : '/property-to-rent') + '/find.html?locationIdentifier=' + loc + inc + rad + '&sortType=6&index=' + index + bq];
      let got = 0;
      for (const u of urls) {
        const body = await get(u, true), found = [];
        if (/^\s*[{[]/.test(body)) { try { T.dig(JSON.parse(body), found, 0); } catch (e) {} } else T.pageJson(body).forEach(function (j) { T.dig(j, found, 0); });
        found.forEach(function (x) { if (!seen[x.id]) { seen[x.id] = 1; items.push(x); got++; } });
        if (found.length) break;
        await wait(800);
      }
      if (got < 20) break;
      await wait(1200);
    }
    const ours = T.branches.map(String);
    return items.filter(function (x) { const c = x.customer || {}; return ours.indexOf(String(c.branchId || '')) === -1 && !/residential realtors/i.test(String(c.brandTradingName || '') + ' ' + String(c.branchDisplayName || '')); });
  }
  // Addresses: the building name (Longridge House) and the street (Falmouth Road).
  const plain = function (s) { return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); };
  const BUILDING = /\b([a-z][a-z ]{1,30}? (?:house|court|lodge|mansions|point|tower|building|apartments|wharf|heights|quay|works|studios|hall|residence|plaza|buildings|estate))\b/;
  const STREET = /\b([a-z][a-z ]{1,30}? (?:road|street|lane|avenue|way|grove|place|gardens|terrace|square|close|crescent|drive|walk|row|hill|park|rise|mews|parade|green|vale|embankment|bridge road|common))\b/;
  function addrParts(a) {
    const t = plain(String(a || '').replace(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i, '')).replace(/\b(flat|apartment|apt|unit|no|room)\s*[0-9a-z]*\b/g, ' ').replace(/\b\d+[a-z]?\b/g, ' ').replace(/\s+/g, ' ').trim();
    const b = BUILDING.exec(t), m = STREET.exec(t);
    let st = ''; if (m) { const w = m[1].split(' '); st = w.slice(-2).join(' '); if (w.length > 2 && /^(bridge|park|hill|high|church|new|old|green|grove|kings|queens)$/.test(w[w.length - 2])) st = w.slice(-3).join(' '); }
    return { building: b ? b[1].split(' ').slice(-2).join(' ') : '', street: st };
  }
  async function prints(p, gids) {
    if (!gids.length) return {};
    const out = {}; (await p.query('SELECT gid, h FROM own_photos WHERE gid = ANY($1::text[])', [gids])).rows.forEach(function (r) { (out[r.gid] = out[r.gid] || []).push(r.h); });
    return out;
  }
  async function run(limit) {
    if (running) return { busy: true }; running = true;
    const started = Date.now(), sum = { at: new Date().toISOString(), rows: 0, searches: 0, adverts: 0, newHits: 0, error: null };
    let p, s;
    try {
      p = await pool(); if (!p) throw new Error('no database'); s = await state(p);
      // Available now, and let in the last 3 years (when tenancies end, landlords re-market): least recently checked first.
      const all = (await p.query("SELECT id, address, beds, status, let_on, rm_id, gnomen_id FROM available_props WHERE status = 'available' OR (status = 'let' AND coalesce(let_on, updated_at::date) > current_date - interval '3 years')")).rows
        .map(function (r) { const m = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})?\s*$/i.exec(String(r.address || '').trim()) || /\b([A-Z]{1,2}\d[A-Z\d]?)\s+\d[A-Z]{2}\b/i.exec(String(r.address || '')); r.oc = m ? m[1].toUpperCase() : ''; return r; })
        .filter(function (r) { return r.oc; })
        .sort(function (a, b) { return (Date.parse(s.checked[a.id] || 0) || 0) - (Date.parse(s.checked[b.id] || 0) || 0) || (a.status === 'available' ? -1 : 1); });
      const rows = all.slice(0, limit || NIGHT_ROWS); sum.rows = rows.length; sum.eligible = all.length;
      // Our photos for each: by Gnomen number (typed, or matched from Gnomen's feed), else our old Rightmove advert's.
      let g = {}; try { g = opts.gnomenFor ? opts.gnomenFor(rows) : {}; } catch (e) {}
      rows.forEach(function (r) { r.gid = r.gnomen_id || g[r.id] || ''; });
      const ours = await prints(p, rows.map(function (r) { return r.gid; }).filter(Boolean).concat(rows.map(function (r) { return r.rm_id && r.rm_id !== 'none' ? 'rm:' + r.rm_id : ''; }).filter(Boolean)));
      let rmFetched = 0;
      for (const r of rows) {
        r.hs = (ours[r.gid] || []).concat(ours['rm:' + r.rm_id] || []);
        if (r.hs.length || !r.rm_id || r.rm_id === 'none' || rmFetched >= 15) continue;
        rmFetched++;
        try { const d = await T.detail(String(r.rm_id)), imgs = ((d && d.images) || []).map(function (i) { return T.abs(i.srcUrl || i.url || ''); }).filter(T.isImg).slice(0, 10), hs = [];
          for (const u of imgs) { const h = await T.fingerprint(u); if (h) hs.push(h); }
          if (hs.length) { await p.query('INSERT INTO own_photos (gid, h) SELECT $1, unnest($2::text[]) ON CONFLICT (gid, h) DO NOTHING', ['rm:' + r.rm_id, hs]); r.hs = hs; }
          await wait(1000); } catch (e) {}
      }
      // One search per postcode area and bedroom count.
      const groups = {}; rows.forEach(function (r) { const k = r.oc + '|' + (r.beds == null ? '' : r.beds); (groups[k] = groups[k] || []).push(r); });
      let empty = 0;
      for (const k of Object.keys(groups)) {
        const oc = k.split('|')[0], beds = k.split('|')[1] === '' ? null : Number(k.split('|')[1]);
        const id = await outcodeId(s, oc); await wait(800); if (!id) continue;
        const ads = await search(id, beds); sum.searches++; sum.adverts += ads.length;
        empty = ads.length ? 0 : empty + 1; if (empty >= 15) throw new Error('Rightmove searches came back empty 15 times running — stopped for tonight');
        // Their first few photos, fingerprinted (only where we have photos of our own to compare).
        const need = groups[k].some(function (r) { return r.hs.length; }), adPrints = {};
        if (need) for (const x of ads) {
          const imgs = (((x.propertyImages || {}).images) || []).map(function (i) { return T.abs(i.srcUrl || i.url || ''); }).filter(T.isImg).slice(0, 6), hs = [];
          for (const u of imgs) { const h = await T.fingerprint(u); if (h) hs.push(h); }
          adPrints[x.id] = hs;
        }
        for (const r of groups[k]) {
          const mine = addrParts(r.address);
          for (const x of ads) {
            const their = plain(x.displayAddress), hs = adPrints[x.id] || [];
            const same = hs.filter(function (h) { return r.hs.some(function (o) { return T.hamming(o, h) <= 4; }); }).length;
            const kind = same >= 2 || (same >= 1 && r.hs.length <= 2) ? 'photos' : mine.building && (' ' + their + ' ').indexOf(' ' + mine.building + ' ') !== -1 ? 'address' : mine.street && (' ' + their + ' ').indexOf(' ' + mine.street + ' ') !== -1 ? 'street' : '';
            if (!kind) continue;
            const c = x.customer || {}, pr = ((x.price || {}).displayPrices || [])[0] || {}, img = T.abs(((x.propertyImages || {}).mainImageSrc) || ((((x.propertyImages || {}).images) || [])[0] || {}).srcUrl || '');
            const q = await p.query(`INSERT INTO rival_hits (prop_id, rm_id, kind, photos, agent, address, price, beds, status, url, img, listed) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
              ON CONFLICT (prop_id, rm_id) DO UPDATE SET kind = CASE WHEN rival_hits.kind = 'photos' OR $3 = 'photos' THEN 'photos' WHEN rival_hits.kind = 'address' OR $3 = 'address' THEN 'address' ELSE 'street' END,
              photos = GREATEST(rival_hits.photos, $4), agent = $5, address = $6, price = $7, status = $9, img = coalesce($11, rival_hits.img), last_seen = now() RETURNING (xmax = 0) AS fresh`,
              [r.id, String(x.id), kind, same, String(c.brandTradingName || c.branchDisplayName || 'Another agent').slice(0, 120), String(x.displayAddress || '').slice(0, 200), String(pr.displayPrice || '').slice(0, 40), x.bedrooms == null ? null : Number(x.bedrooms),
                String(x.displayStatus || '').slice(0, 40), T.RM + '/properties/' + x.id, T.isImg(img) ? img : null, String(x.firstVisibleDate || '').slice(0, 10)]);
            if (q.rows[0] && q.rows[0].fresh) sum.newHits++;
          }
          s.checked[r.id] = new Date().toISOString();
        }
        await wait(1500);
      }
    } catch (e) { sum.error = String(e.message || e).slice(0, 200); console.error('Other agents check:', sum.error); }
    sum.secs = Math.round((Date.now() - started) / 1000);
    try { if (p && s) { s.run = sum; await state(p, s); await tell(p); } } catch (e) { console.error('Other agents check not saved:', e.message); }
    console.log('Other agents check: ' + sum.rows + ' of our properties, ' + sum.searches + ' Rightmove searches, ' + sum.adverts + ' adverts, ' + sum.newHits + ' new matches' + (sum.error ? ' — ' + sum.error : '') + ' (' + sum.secs + 's)');
    running = false; return sum;
  }
  // New strong matches (our photos, or the same building): the owner hears about them once.
  async function tell(p) {
    const rows = (await p.query(`SELECT h.*, a.address AS ours, a.landlord, a.landlord_phone, a.status AS our_status FROM rival_hits h JOIN available_props a ON a.id = h.prop_id
      WHERE NOT h.told AND h.dismissed_at IS NULL AND h.kind IN ('photos', 'address') ORDER BY h.id`)).rows;
    if (!rows.length) return;
    await p.query('UPDATE rival_hits SET told = true WHERE id = ANY($1::int[])', [rows.map(function (r) { return r.id; })]);
    const line = function (r) { return '• ' + r.ours + (r.our_status === 'let' ? ' (we let it)' : ' (on our books)') + ' — ' + (r.kind === 'photos' ? 'our photos (' + r.photos + ')' : 'same building') + ' on ' + r.agent + '’s advert ' + r.url + (r.landlord ? '\n  Landlord: ' + r.landlord + (r.landlord_phone ? ' · ' + r.landlord_phone : '') : ''); };
    if (opts.alert) opts.alert({ title: '🔎 ' + (rows.length === 1 ? 'One of our properties is' : rows.length + ' of our properties are') + ' with another agent', message: rows[0].ours.split(',')[0] + ' — ' + rows[0].agent + (rows.length > 1 ? ' (+' + (rows.length - 1) + ' more)' : '') + '. Call the landlord.', tags: ['mag'] });
    if (opts.email) opts.email('Our properties advertised by other agents on Rightmove', function (link) { return 'The latest check found these on Rightmove with other agents:\n\n' + rows.map(line).join('\n\n') + '\n\nThe full list is in Fixflow → Available properties → Other agents:\n' + link; }, '#avail');
  }
  // Every night at about 2am (London).
  setInterval(function () {
    const h = Number(new Date().toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hour12: false }));
    if (h !== 2 || running || process.env.RIVALS_CHECK === '0') return;
    pool().then(async function (p) { if (!p) return; const s = await state(p); if (s.run && Date.now() - Date.parse(s.run.at) < 20 * 3600000) return; await run(); }).catch(function (e) { console.error('Other agents check:', e.message); });
  }, 10 * 60000).unref();

  // ---------- New on Rightmove near the office ----------
  // Every couple of hours in the day: adverts (to rent and for sale, other agents) newly on Rightmove within a
  // quarter of a mile of the office — landlords worth a call. The first look only records what's there already.
  const OFFICE_PC = String(process.env.OFFICE_POSTCODE || 'SE1 6AD').toUpperCase().replace(/\s+/g, ' ').trim();
  const NEAR_MILES = Math.min(2, Math.max(0.1, parseFloat(process.env.NEARBY_MILES) || 0.25));
  let nearReady = null, nearRunning = false;
  async function nearPool() {
    const p = await opts.db(); if (!p) return null;
    if (!nearReady) nearReady = p.query(`CREATE TABLE IF NOT EXISTS nearby_ads (rm_id TEXT PRIMARY KEY, channel TEXT NOT NULL, address TEXT, price TEXT, beds INTEGER, type TEXT, agent TEXT, url TEXT, img TEXT,
      listed TEXT, miles REAL, first_seen TIMESTAMPTZ NOT NULL DEFAULT now(), last_seen TIMESTAMPTZ NOT NULL DEFAULT now(), seeded BOOLEAN NOT NULL DEFAULT false, dismissed_at TIMESTAMPTZ)`).catch(function (e) { nearReady = null; throw e; });
    await nearReady; return p;
  }
  async function nearState(p, v) {
    if (v) { await p.query("INSERT INTO app_settings (key, value) VALUES ('nearby', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [JSON.stringify(v)]); return v; }
    const r = (await p.query("SELECT value FROM app_settings WHERE key = 'nearby'")).rows[0]; return (r && r.value) || {};
  }
  const miles = function (a, b, c, d) { const R = 3958.8, r = Math.PI / 180, x = Math.sin((c - a) * r / 2), y = Math.sin((d - b) * r / 2); return 2 * R * Math.asin(Math.sqrt(x * x + Math.cos(a * r) * Math.cos(c * r) * y * y)); };
  async function nearRun() {
    if (nearRunning) return { busy: true }; nearRunning = true;
    const sum = { at: new Date().toISOString(), adverts: 0, inside: 0, fresh: 0, error: null };
    let p, s;
    try {
      p = await nearPool(); if (!p) throw new Error('no database'); s = await nearState(p);
      // Where the office is (postcodes.io, free), remembered.
      if (!s.office || s.office.pc !== OFFICE_PC) { const j = JSON.parse(await (await fetch('https://api.postcodes.io/postcodes/' + encodeURIComponent(OFFICE_PC.replace(/\s/g, '')), { signal: AbortSignal.timeout(15000) })).text() || '{}');
        if (!j.result || !j.result.latitude) throw new Error('office postcode ' + OFFICE_PC + ' not found'); s.office = { pc: OFFICE_PC, lat: j.result.latitude, lng: j.result.longitude }; }
      // Rightmove's number for the office postcode (a search within a radius of it), else the postcode area.
      if (!s.pcId) { try { const j = JSON.parse(await get('https://los.rightmove.co.uk/typeahead?query=' + encodeURIComponent(OFFICE_PC) + '&limit=10', true) || '{}');
        const m = (j.matches || []).filter(function (x) { return String(x.type).toUpperCase() === 'POSTCODE'; })[0]; if (m) s.pcId = String(m.id); } catch (e) { if (e.blocked) throw e; } }
      s.oc = s.oc || {}; s.checked = s.checked || {};
      const isNew = !s.seeded, found = [];
      for (const buy of [false, true]) {
        let ads = [];
        if (s.pcId) ads = await search(null, null, { loc: 'POSTCODE%5E' + s.pcId, radius: NEAR_MILES <= 0.25 ? '0.25' : NEAR_MILES <= 0.5 ? '0.5' : '1.0', buy: buy, fresh: true });
        else { const id = await outcodeId(s, OFFICE_PC.split(' ')[0]); if (id) ads = await search(id, null, { buy: buy, fresh: true }); }
        sum.adverts += ads.length;
        ads.forEach(function (x) {
          const loc = x.location || {}, lat = Number(loc.latitude), lng = Number(loc.longitude), d = isFinite(lat) && isFinite(lng) && lat ? miles(s.office.lat, s.office.lng, lat, lng) : null;
          if (d == null ? !s.pcId : d > NEAR_MILES + 0.01) return;   // outside the circle (or no map position to tell)
          found.push({ x: x, buy: buy, d: d });
        });
        await wait(1500);
      }
      sum.inside = found.length;
      const fresh = [];
      for (const f of found) {
        const x = f.x, c = x.customer || {}, pr = ((x.price || {}).displayPrices || [])[0] || {}, img = T.abs(((x.propertyImages || {}).mainImageSrc) || ((((x.propertyImages || {}).images) || [])[0] || {}).srcUrl || '');
        const q = await p.query(`INSERT INTO nearby_ads (rm_id, channel, address, price, beds, type, agent, url, img, listed, miles, seeded) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          ON CONFLICT (rm_id) DO UPDATE SET price = $4, last_seen = now() RETURNING (xmax = 0) AS fresh`,
          [String(x.id), f.buy ? 'sale' : 'let', String(x.displayAddress || '').slice(0, 200), String(pr.displayPrice || '').slice(0, 40), x.bedrooms == null ? null : Number(x.bedrooms), String(x.propertySubType || x.propertyTypeFullDescription || '').slice(0, 60),
            String(c.brandTradingName || c.branchDisplayName || 'An agent').slice(0, 120), T.RM + '/properties/' + x.id, T.isImg(img) ? img : null, String(x.firstVisibleDate || '').slice(0, 10), f.d == null ? null : Math.round(f.d * 100) / 100, isNew]);
        if (q.rows[0] && q.rows[0].fresh && !isNew) fresh.push(f);
      }
      sum.fresh = fresh.length; s.seeded = true;
      await p.query("DELETE FROM nearby_ads WHERE last_seen < now() - interval '120 days'");
      if (fresh.length && opts.alert) {
        const first = fresh[0].x;
        opts.alert({ title: '📍 ' + (fresh.length === 1 ? 'New on Rightmove near the office' : fresh.length + ' new on Rightmove near the office'), message: String(first.displayAddress || '').split(',')[0] + ' — ' + (fresh[0].buy ? 'for sale' : 'to rent') + ' with ' + String((first.customer || {}).brandTradingName || 'another agent') + (fresh.length > 1 ? ' (+' + (fresh.length - 1) + ' more)' : '') + '. A landlord to call.', tags: ['round_pushpin'] });
      }
    } catch (e) { sum.error = String(e.message || e).slice(0, 200); console.error('Near the office check:', sum.error); }
    try { if (p && s) { s.run = sum; await nearState(p, s); } } catch (e) {}
    console.log('Near the office check: ' + sum.adverts + ' adverts, ' + sum.inside + ' within ' + NEAR_MILES + ' mile, ' + sum.fresh + ' new' + (sum.error ? ' — ' + sum.error : ''));
    nearRunning = false; return sum;
  }
  // Every 2 hours from 8am to 8pm (London).
  setInterval(function () {
    const h = Number(new Date().toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hour12: false }));
    if (h < 8 || h > 20 || nearRunning || process.env.NEARBY_CHECK === '0') return;
    nearPool().then(async function (p) { if (!p) return; const s = await nearState(p); if (s.run && Date.now() - Date.parse(s.run.at) < 115 * 60000) return; await nearRun(); }).catch(function (e) { console.error('Near the office check:', e.message); });
  }, 10 * 60000).unref();

  const mgr = function (req) { return opts.isStaff(req) && opts.canManage(req); };
  app.get('/api/admin/nearby', async function (req, res) {
    if (!mgr(req)) return res.status(403).json({ ok: false });
    try { const p = await nearPool(), s = await nearState(p);
      res.json({ ok: true, run: s.run || null, running: nearRunning, miles: NEAR_MILES, office: OFFICE_PC, items: (await p.query("SELECT * FROM nearby_ads WHERE NOT seeded AND first_seen > now() - interval '60 days' ORDER BY (dismissed_at IS NULL) DESC, first_seen DESC LIMIT 200")).rows }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  app.post('/api/admin/nearby/run', function (req, res) {
    if (!mgr(req)) return res.status(403).json({ ok: false });
    if (nearRunning) return res.json({ ok: true, running: true });
    nearRun().catch(function () {}); res.json({ ok: true, started: true });
  });
  app.post('/api/admin/nearby/:id/dismiss', async function (req, res) {
    if (!mgr(req)) return res.status(403).json({ ok: false });
    try { const p = await nearPool(); await p.query('UPDATE nearby_ads SET dismissed_at = ' + ((req.body || {}).undo === true ? 'NULL' : 'now()') + ' WHERE rm_id = $1', [String(req.params.id).slice(0, 20)]); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  app.get('/api/admin/rivals', async function (req, res) {
    if (!mgr(req)) return res.status(403).json({ ok: false });
    try {
      const p = await pool(), s = await state(p);
      const hits = (await p.query(`SELECT h.*, a.address AS ours, a.beds AS our_beds, a.landlord, a.landlord_phone, a.status AS our_status, a.let_on FROM rival_hits h JOIN available_props a ON a.id = h.prop_id
        WHERE h.last_seen > now() - interval '45 days' ORDER BY (h.dismissed_at IS NULL) DESC, CASE h.kind WHEN 'photos' THEN 0 WHEN 'address' THEN 1 ELSE 2 END, h.last_seen DESC LIMIT 400`)).rows;
      res.json({ ok: true, run: s.run || null, running: running, checked: Object.keys(s.checked).length, hits: hits });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  app.post('/api/admin/rivals/run', function (req, res) {
    if (!mgr(req)) return res.status(403).json({ ok: false });
    if (running) return res.json({ ok: true, running: true });
    run(Math.min(NIGHT_ROWS, 40)).catch(function () {}); res.json({ ok: true, started: true });
  });
  app.post('/api/admin/rivals/:id/dismiss', async function (req, res) {
    if (!mgr(req)) return res.status(403).json({ ok: false });
    try { const p = await pool(), undo = (req.body || {}).undo === true;
      await p.query('UPDATE rival_hits SET dismissed_at = ' + (undo ? 'NULL' : 'now()') + ', dismissed_by = $2 WHERE id = $1', [parseInt(req.params.id, 10) || 0, undo ? null : (req.user && req.user.name) || '']);
      res.json({ ok: true }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  return { run: run, nearRun: nearRun, addrParts: addrParts };
};
