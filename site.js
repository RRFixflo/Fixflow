/* Residential Realtors website: menu, reveal-on-scroll and the enquiry form. */
(function () {
  var btn = document.querySelector('.menu-btn'), nav = document.querySelector('.nav');
  if (btn && nav) {
    btn.addEventListener('click', function () { var o = nav.classList.toggle('open'); btn.setAttribute('aria-expanded', o ? 'true' : 'false'); btn.textContent = o ? '✕' : '☰'; });
    nav.addEventListener('click', function (e) { if (e.target.closest('a')) { nav.classList.remove('open'); btn.textContent = '☰'; } });
  }
  var yr = document.getElementById('yr'); if (yr) yr.textContent = new Date().getFullYear();
  // Things that come into view together arrive one after another (a short stagger).
  var io = 'IntersectionObserver' in window ? new IntersectionObserver(function (es) { var n = 0; es.forEach(function (e) { if (e.isIntersecting) { if (n) e.target.style.setProperty('--d', Math.min(n, 6) * 0.08 + 's'); n++; e.target.classList.add('in'); io.unobserve(e.target); } }); }, { threshold: .1 }) : null;
  // Cards and headings slide in as you scroll, one after another within each group.
  if (io && !(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches)) {
    document.querySelectorAll('main section h2, .lcard, .pcard, .big-card, .xcard, .tl, .mo, .news-l > *, .lu-card, .dl, .pd-cert, .pd-doc, .gl4').forEach(function (el) {
      if (el.closest('.hero4, .phead, header, footer, form, [role=dialog]') && !el.classList.contains('gl4')) return;
      el.classList.add('rv');
    });
  }
  document.querySelectorAll('.rv').forEach(function (el) { if (io) io.observe(el); else el.classList.add('in'); });
  var top = document.querySelector('.top');
  if (top) { var onScroll = function () { top.classList.toggle('scrolled', window.scrollY > 8); }; window.addEventListener('scroll', onScroll, { passive: true }); onScroll(); }

  // Sales valuation form (Sales page): saved with the website requests and sent to the office.
  var sf = document.getElementById('sForm');
  try { var spc = new URLSearchParams(location.search).get('postcode'); if (sf && spc && sf.elements.postcode) sf.elements.postcode.value = spc.toUpperCase().slice(0, 10); } catch (e) {}
  if (sf) sf.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var err = document.getElementById('sErr'), go = document.getElementById('sGo'), v = function (k) { var el = sf.elements[k]; return el ? String(el.value || '').trim() : ''; };
    var data = { kind: 'sale', name: v('name'), email: v('email'), phone: v('phone'), address: v('address'), postcode: v('postcode'), beds: v('beds'), type: v('type'), when: v('when'), message: v('message'), website: v('website'), consent: sf.elements.consent.checked };
    err.textContent = '';
    if (!data.name) { err.textContent = 'Please enter your name.'; return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) { err.textContent = 'Please enter a valid email address.'; return; }
    if (!data.address) { err.textContent = 'Please enter the property address.'; return; }
    if (!/^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i.test(data.postcode)) { err.textContent = 'Please enter the postcode.'; return; }
    if (!data.consent) { err.textContent = 'Please tick the box so we can contact you.'; return; }
    go.disabled = true; go.textContent = 'Sending…';
    ffPost('/api/valuation-request', data, sf).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) { go.disabled = false; go.textContent = 'Request my free valuation →'; err.textContent = d.error === 'rate-limited' ? 'Too many requests — please try again later or call 0207 096 8131.' : d.error === 'postcode' ? 'Please check the postcode.' : 'Sorry, something went wrong. Please try again or call 0207 096 8131.'; return; }
      document.getElementById('sBody').innerHTML = '<div class="done"><div class="big">✓</div><h3 style="margin:0">Thanks, ' + String(data.name.split(/\s+/)[0]).replace(/[<>&"]/g, '') + ' — request sent</h3><p style="color:var(--soft);margin:8px 0 0">We’ll be in touch shortly to arrange your free valuation. For anything urgent, call <a href="tel:02070968131" style="font-weight:700;color:var(--navy)">0207 096 8131</a>.</p></div>';
    }).catch(function () { go.disabled = false; go.textContent = 'Request my free valuation →'; err.textContent = 'Couldn’t connect — please try again or call 0207 096 8131.'; });
  });

  // Property list: filter and sort the cards on the page; a map view; homes near me.
  var lf = document.getElementById('lFilter'), lg = document.getElementById('lGrid');
  if (lf && lg) {
    var cards = Array.prototype.slice.call(lg.children), cnt = document.getElementById('lCount'), none = document.getElementById('lNone');
    var mapBox = document.getElementById('lMap'), nearTx = document.getElementById('lNear'), userLoc = null, lmap = null, layer = null;
    var miles = function (a, b, c, d) { var r = Math.PI / 180, x = Math.sin((c - a) * r / 2), y = Math.sin((d - b) * r / 2), h = x * x + Math.cos(a * r) * Math.cos(c * r) * y * y; return 3958.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)); };
    var setNear = function (lat, lng) {
      userLoc = [lat, lng];
      cards.forEach(function (c) { var old = c.querySelector('.ldist'); if (old) old.remove(); if (!c.dataset.lat) { c.dataset.dist = 9999; return; } var m = miles(lat, lng, +c.dataset.lat, +c.dataset.lng); c.dataset.dist = m.toFixed(2);
        var t = document.createElement('p'); t.className = 'ldist'; t.textContent = (m < 0.1 ? 'Under 0.1' : m.toFixed(1)) + ' miles away'; c.querySelector('.lbody').appendChild(t); });
      var so = lf.elements.sort; if (!so.querySelector('option[value=near]')) { var o = document.createElement('option'); o.value = 'near'; o.textContent = 'Nearest to me'; so.insertBefore(o, so.firstChild); } so.value = 'near';
      if (nearTx) { nearTx.hidden = false; nearTx.textContent = 'Sorted by distance from you'; }
    };
    var drawMap = function () {
      if (!lmap || mapBox.hidden) return;
      layer.clearLayers(); var pts = [];
      cards.forEach(function (c) { if (c.hidden || !c.dataset.lat) return; var ll = [+c.dataset.lat, +c.dataset.lng]; pts.push(ll);
        var price = (c.querySelector('.lprice b') || {}).textContent || '', title = (c.querySelector('h3') || {}).textContent || '', where = (c.querySelector('.lwhere') || {}).textContent || '', img = c.querySelector('.lph img');
        var html = '<a class="mpop" href="' + c.getAttribute('href') + '">' + (img ? '<img src="' + img.getAttribute('src') + '" alt="">' : '') + '<b>' + price + '</b><span>' + title.replace(/</g, '') + '</span><small>' + where.replace(/</g, '') + '</small></a>';
        window.L.marker(ll, { icon: window.L.divIcon({ className: 'mpin', html: '<span>' + price.replace(/[^£\d,]/g, '') + '</span>', iconSize: null }) }).bindPopup(html, { maxWidth: 240 }).addTo(layer); });
      if (userLoc) pts.push(userLoc);
      if (pts.length) lmap.fitBounds(pts, { padding: [30, 30], maxZoom: 15 });
      setTimeout(function () { lmap.invalidateSize(); }, 50);
    };
    var showMap = function (on) {
      mapBox.hidden = !on; lg.classList.toggle('with-map', on);
      if (!on) return;
      var go = function () {
        if (!lmap) { lmap = window.L.map(mapBox, { scrollWheelZoom: false }); window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(lmap); layer = window.L.layerGroup().addTo(lmap); lmap.setView([51.5, -0.1], 11); }
        drawMap();
      };
      if (window.L) return go();
      var css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css'; document.head.appendChild(css);
      var js = document.createElement('script'); js.src = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js'; js.onload = go; document.head.appendChild(js);
    };
    var applyF = function () {
      var q = String(lf.elements.q.value || '').trim().toLowerCase().replace(/\s+/g, ' '), beds = lf.elements.beds.value, max = +lf.elements.max.value || 0, all = lf.elements.all.checked, sort = lf.elements.sort.value, shown = 0;
      cards.slice().sort(function (a, b) { return sort === 'near' && userLoc ? a.dataset.dist - b.dataset.dist : sort === 'low' ? a.dataset.price - b.dataset.price : sort === 'high' ? b.dataset.price - a.dataset.price : (a.dataset.taken - b.dataset.taken) || String(b.dataset.added).localeCompare(String(a.dataset.added)); })
        .forEach(function (c) { lg.appendChild(c);
          var ok = (!q || c.dataset.q.indexOf(q) !== -1 || c.dataset.q.replace(/\s/g, '').indexOf(q.replace(/\s/g, '')) !== -1) && (beds === '' || +c.dataset.beds >= +beds) && (!max || +c.dataset.price <= max) && (all || c.dataset.taken !== '1');
          c.hidden = !ok; if (ok) shown++; });
      cnt.textContent = shown + (shown === 1 ? ' property' : ' properties'); none.hidden = shown > 0;
      drawMap();
      try { var u = new URLSearchParams(); if (q) u.set('q', q); if (beds) u.set('beds', beds); if (max) u.set('max', max); if (!all) u.set('all', '0'); if (sort !== 'new' && sort !== 'near') u.set('sort', sort); if (userLoc) u.set('near', userLoc[0].toFixed(4) + ',' + userLoc[1].toFixed(4)); if (!mapBox.hidden) u.set('view', 'map');
        history.replaceState(null, '', location.pathname + (u.toString() ? '?' + u.toString() : '')); } catch (e) {}
    };
    var setView = function (v) { document.querySelectorAll('.lviews [data-view]').forEach(function (b) { b.classList.toggle('on', b.dataset.view === v || (v === 'near' && b.dataset.view === 'near')); }); };
    document.querySelectorAll('.lviews [data-view]').forEach(function (b) { b.addEventListener('click', function () {
      var v = b.dataset.view;
      if (v === 'near') {
        if (!navigator.geolocation) { nearTx.hidden = false; nearTx.textContent = 'Your browser can’t share your location.'; return; }
        nearTx.hidden = false; nearTx.textContent = 'Finding your location…';
        navigator.geolocation.getCurrentPosition(function (pos) { setNear(pos.coords.latitude, pos.coords.longitude); b.classList.add('on'); applyF(); }, function () { nearTx.textContent = 'We couldn’t get your location — check your browser’s location setting.'; }, { timeout: 10000, maximumAge: 300000 });
        return;
      }
      document.querySelectorAll('.lviews [data-view=list], .lviews [data-view=map]').forEach(function (x) { x.classList.toggle('on', x === b); });
      showMap(v === 'map'); applyF();
    }); });
    try { var sp = new URLSearchParams(location.search); ['q', 'beds', 'max', 'sort'].forEach(function (k) { if (sp.get(k)) lf.elements[k].value = sp.get(k); }); if (sp.get('all') === '0') lf.elements.all.checked = false;
      var nr = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(sp.get('near') || ''); if (nr) { setNear(+nr[1], +nr[2]); var nb = document.querySelector('.lviews [data-view=near]'); if (nb) nb.classList.add('on'); }
      if (sp.get('view') === 'map') { document.querySelectorAll('.lviews [data-view=list], .lviews [data-view=map]').forEach(function (x) { x.classList.toggle('on', x.dataset.view === 'map'); }); showMap(true); } } catch (e) {}
    lf.addEventListener('input', applyF); lf.addEventListener('change', applyF); applyF();
    // The Search button (or Enter): show the results and close the phone keyboard.
    lf.addEventListener('submit', function (e) { e.preventDefault(); applyF(); try { lf.elements.q.blur(); } catch (x) {} var c = document.getElementById('lCount'); if (c && c.getBoundingClientRect().top > window.innerHeight * .6) c.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  }

  // Home page: the search box (Buy / Rent, Location / Map / Near me) and the row of latest homes.
  var hs = document.getElementById('hSearch');
  if (hs) {
    var hsMode = 'list', hsMsg = function (t) { var m = hs.querySelector('.hs-msg'); if (!m) { m = document.createElement('p'); m.className = 'hs-msg'; hs.querySelector('.hs-box').appendChild(m); } m.textContent = t; };
    hs.querySelectorAll('[data-hs]').forEach(function (b) { b.addEventListener('click', function () { hs.querySelectorAll('[data-hs]').forEach(function (x) { x.classList.toggle('on', x === b); }); hs.action = b.dataset.hs === 'buy' ? '/properties-for-sale' : '/properties-to-rent'; }); });
    hs.querySelectorAll('[data-mode]').forEach(function (b) { b.addEventListener('click', function () {
      hs.querySelectorAll('[data-mode]').forEach(function (x) { x.classList.toggle('on', x === b); }); hsMode = b.dataset.mode;
      var q = hs.elements.q.value.trim(), base = hs.getAttribute('action');
      if (hsMode === 'map') location.href = base + '?view=map' + (q ? '&q=' + encodeURIComponent(q) : '');
      else if (hsMode === 'near') {
        if (!navigator.geolocation) return hsMsg('Your browser can’t share your location.');
        hsMsg('Finding your location…');
        navigator.geolocation.getCurrentPosition(function (pos) { location.href = base + '?near=' + pos.coords.latitude.toFixed(4) + ',' + pos.coords.longitude.toFixed(4); }, function () { hsMsg('We couldn’t get your location — check your browser’s location setting.'); }, { timeout: 10000, maximumAge: 300000 });
      } else hs.elements.q.focus();
    }); });
  }
  var car = document.getElementById('car');
  if (car) document.querySelectorAll('[data-car]').forEach(function (b) { b.addEventListener('click', function () { car.scrollBy({ left: +b.dataset.car * car.clientWidth * 0.9, behavior: 'smooth' }); }); });

  // Property page: photo gallery (swipe on phones, arrows on computers).
  var gt = document.getElementById('gTrack');
  if (gt) {
    var gn = document.getElementById('gNum'), total = gt.children.length, at = function () { return Math.round(gt.scrollLeft / gt.clientWidth); };
    gt.addEventListener('scroll', function () { if (gn) gn.textContent = (at() + 1) + ' / ' + total; }, { passive: true });
    var go = function (d) { var i = (at() + d + total) % total; gt.scrollTo({ left: i * gt.clientWidth, behavior: 'smooth' }); };
    var pb = document.querySelector('.gbtn.prev'), nb = document.querySelector('.gbtn.next');
    if (pb) pb.addEventListener('click', function () { go(-1); }); if (nb) nb.addEventListener('click', function () { go(1); });
    document.addEventListener('keydown', function (e) { if (e.key === 'ArrowLeft') go(-1); if (e.key === 'ArrowRight') go(1); });
  }

  // Property page: book a viewing — pick up to 3 times that suit, then your details.
  var bk = document.getElementById('book'), bkF = document.getElementById('bkForm');
  if (bk && bkF) {
    var pad = function (n) { return (n < 10 ? '0' : '') + n; }, picked = [], dayAt = 0;
    var ldn = function () { var g = {}; new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date()).forEach(function (x) { g[x.type] = x.value; }); return g; };
    var now = ldn(), base = Date.UTC(+now.year, +now.month - 1, +now.day, 12), nowH = (+now.hour % 24) + (+now.minute) / 60;
    var DAYS = [], HOURS = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
    for (var i = 0; i < 14; i++) { var d = new Date(base + i * 86400000); DAYS.push({ key: d.toISOString().slice(0, 10), wd: i === 0 ? 'Today' : i === 1 ? 'Tmrw' : d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' }), n: d.getUTCDate(), mon: d.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' }), long: d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }) }); }
    if (HOURS.every(function (h) { return h < nowH + 2; })) { DAYS.shift(); }   // too late to view today
    var hTxt = function (h) { return (h > 12 ? h - 12 : h) + (h >= 12 ? 'pm' : 'am'); };
    var label = function (v) { var d = DAYS.filter(function (x) { return x.key === v.slice(0, 10); })[0]; return (d ? (d.wd === 'Today' || d.wd === 'Tmrw' ? (d.wd === 'Tmrw' ? 'Tomorrow' : 'Today') + ' ' + d.n + ' ' + d.mon : d.long) : v.slice(0, 10)) + ', ' + hTxt(+v.slice(11, 13)); };
    var drawDays = function () {
      document.getElementById('bkDays').innerHTML = DAYS.map(function (d, i) { var has = picked.some(function (v) { return v.slice(0, 10) === d.key; }); return '<button type="button" class="bk-day' + (i === dayAt ? ' on' : '') + (has ? ' has' : '') + '" data-day="' + i + '" aria-pressed="' + (i === dayAt) + '"><small>' + d.wd + '</small><b>' + d.n + '</b><small>' + d.mon + '</small><span class="dot"></span></button>'; }).join('');
    };
    var drawTimes = function () {
      var d = DAYS[dayAt], isToday = d.wd === 'Today', full = picked.length >= 3;
      var btn = function (h) { var v = d.key + 'T' + pad(h) + ':00', on = picked.indexOf(v) !== -1, past = isToday && h < nowH + 2; return '<button type="button" class="bk-t' + (on ? ' on' : '') + '" data-t="' + v + '"' + (past || (full && !on) ? ' disabled' : '') + ' aria-pressed="' + on + '">' + hTxt(h) + '</button>'; };
      document.getElementById('bkTimes').innerHTML = '<span class="bk-tg">Morning</span>' + [9, 10, 11].map(btn).join('') + '<span class="bk-tg">Afternoon</span>' + [12, 13, 14, 15, 16].map(btn).join('') + '<span class="bk-tg">Evening</span>' + [17, 18].map(btn).join('');
      document.getElementById('bkPicked').innerHTML = picked.length ? picked.map(function (v) { return '<span class="bk-pk">' + label(v) + '<button type="button" data-rm="' + v + '" aria-label="Remove ' + label(v) + '">×</button></span>'; }).join('') + (full ? '<span class="bk-hint">That’s 3 — perfect.</span>' : '<span class="bk-hint">' + (3 - picked.length) + ' more if you like</span>') : '<span class="bk-hint">Tap a day, then a time.</span>';
    };
    var draw = function () { drawDays(); drawTimes(); };
    var open = function () { bk.classList.add('open'); document.body.classList.add('bk-lock'); draw(); setTimeout(function () { var b = bk.querySelector('.bk-day.on'); if (b) b.focus({ preventScroll: true }); }, 30); };
    var close = function () { bk.classList.remove('open'); document.body.classList.remove('bk-lock'); if (location.hash === '#book') history.replaceState(null, '', location.pathname + location.search); };
    document.querySelectorAll('a[href="#book"]').forEach(function (a) { a.addEventListener('click', function (e) { e.preventDefault(); open(); }); });
    bk.querySelectorAll('.bk-bg, .bk-x').forEach(function (a) { a.addEventListener('click', function (e) { e.preventDefault(); close(); }); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && bk.classList.contains('open')) close(); });
    if (location.hash === '#book') { history.replaceState(null, '', location.pathname + location.search); open(); }
    bk.addEventListener('click', function (e) {
      var dy = e.target.closest('[data-day]'), t = e.target.closest('[data-t]'), rm = e.target.closest('[data-rm]');
      if (dy) { dayAt = +dy.dataset.day; draw(); }
      else if (t && !t.disabled) { var v = t.dataset.t, k = picked.indexOf(v); if (k !== -1) picked.splice(k, 1); else if (picked.length < 3) picked.push(v); picked.sort(); if (picked.length) bkF.elements.flexible.checked = false; draw(); }
      else if (rm) { picked.splice(picked.indexOf(rm.dataset.rm), 1); draw(); }
    });
    bkF.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var f = bkF.elements, err = document.getElementById('bkErr'), go = document.getElementById('bkGo'), say = function (m, el) { err.textContent = m; if (el) el.focus(); };
      err.textContent = '';
      if (!picked.length && !f.flexible.checked) return say('Please pick at least one time — or tick “I’m flexible”.');
      if (!f.name.value.trim()) return say('Please enter your name.', f.name);
      if (f.phone.value.replace(/\D/g, '').length < 10) return say('Please enter your mobile number.', f.phone);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.value.trim())) return say('Please enter a valid email address.', f.email);
      if (!f.consent.checked) return say('Please tick the box so we can contact you about the viewing.', f.consent);
      go.disabled = true; go.textContent = 'Sending…';
      ffPost('/api/viewing-request', { name: f.name.value.trim(), phone: f.phone.value.trim(), email: f.email.value.trim(), people: f.people ? f.people.value : '', move: f.move ? f.move.value : '', message: f.message.value.trim(), website: f.website.value, consent: true, slots: picked, flexible: f.flexible.checked, ref: bkF.dataset.ref, address: bkF.dataset.addr, listing: bkF.dataset.kind, url: bkF.dataset.url }, bkF)
        .then(function (r) { return r.json(); }).then(function (d) {
          if (!d.ok) { go.disabled = false; go.textContent = 'Request viewing →'; return say(d.error === 'rate-limited' ? 'Too many requests — please call us on 0207 096 8131.' : d.error === 'slots' ? 'Please pick a time in the next few weeks.' : 'Please check your details and try again.'); }
          document.getElementById('bkBody').innerHTML = '<div class="bk-done"><div class="ok">✅</div><h3 style="margin:6px 0">Request sent — not booked yet</h3><p class="bk-where">' + escH(bkF.dataset.addr) + '</p>' + (picked.length ? '<p style="margin:0">You suggested:</p><ul>' + picked.map(function (v) { return '<li>' + label(v) + '</li>'; }).join('') + '</ul>' : '<p>You’re flexible — we’ll suggest a time.</p>') + '<p class="bk-where"><b>Your viewing isn’t booked yet.</b> One of our agents will contact you first, by phone or email, to confirm a time. We’ve emailed you a copy of your request.</p><a class="btn navy" href="#" data-bk-close>Done</a></div>';
          bk.querySelector('[data-bk-close]').addEventListener('click', function (e) { e.preventDefault(); close(); });
        }).catch(function () { go.disabled = false; go.textContent = 'Request viewing →'; say('Couldn’t send — please check your connection or call 0207 096 8131.'); });
    });
  }

  // Property page: Photos / Video / Floorplan tabs at the top (the video only loads when opened).
  var pdm = document.getElementById('pdmedia');
  if (pdm) {
    var pdShow = function (t) {
      document.querySelectorAll('.pdtabs [data-pdtab]').forEach(function (b) { b.classList.toggle('on', b.dataset.pdtab === t); b.setAttribute('aria-selected', b.dataset.pdtab === t ? 'true' : 'false'); });
      var g = document.getElementById('gal'); if (g) g.hidden = t !== 'photos';
      pdm.querySelectorAll('[data-panel]').forEach(function (x) {
        x.hidden = x.dataset.panel !== t;
        var f = x.querySelector('iframe[data-src]');
        if (f) { if (!x.hidden && !f.getAttribute('src')) f.setAttribute('src', f.dataset.src); if (x.hidden && f.getAttribute('src')) f.removeAttribute('src'); }   // stop the video when leaving it
      });
    };
    document.addEventListener('click', function (e) {
      var b = e.target.closest('[data-pdtab]'); if (!b) return; e.preventDefault(); pdShow(b.dataset.pdtab);
      var tabs = document.querySelector('.pdtabs') || pdm, r = tabs.getBoundingClientRect();
      if (r.top < 0 || r.top > window.innerHeight * 0.4) tabs.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  // Property checks page: EPC checker and licence checker.
  var escH = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var pcOk = function (v) { return /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i.test(String(v || '').trim()); };
  var epcF = document.getElementById('epcForm');
  if (epcF) epcF.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var pc = epcF.elements.postcode.value.trim(), flt = epcF.elements.filter.value.trim().toLowerCase(), err = document.getElementById('epcErr'), out = document.getElementById('epcOut'), go = document.getElementById('epcGo');
    err.textContent = ''; if (!pcOk(pc)) { err.textContent = 'Please enter a full postcode, e.g. SE1 6AD.'; return; }
    go.disabled = true; go.textContent = 'Checking…'; out.innerHTML = '';
    fetch('/api/public/epc?postcode=' + encodeURIComponent(pc)).then(function (r) { return r.json(); }).then(function (d) {
      go.disabled = false; go.textContent = 'Check EPCs';
      if (!d.ok) { out.innerHTML = '<div class="tool-card">' + (d.error === 'rate-limited' ? 'Too many checks — please try again shortly.' : 'The EPC register isn’t answering right now.') + (d.url ? ' <a href="' + escH(d.url) + '" target="_blank" rel="noopener">Search the register directly ↗</a>' : '') + '</div>'; return; }
      var list = d.results.filter(function (r) { return !flt || r.address.toLowerCase().indexOf(flt) !== -1; });
      if (!list.length) { out.innerHTML = '<div class="tool-card">No EPCs found' + (flt ? ' matching “' + escH(flt) + '”' : '') + ' at ' + escH(d.postcode) + '. <a href="' + escH(d.url) + '" target="_blank" rel="noopener">Check the register ↗</a></div>'; return; }
      var today = new Date().toISOString().slice(0, 10);
      out.innerHTML = '<p class="tool-count">' + list.length + ' certificate' + (list.length === 1 ? '' : 's') + ' at ' + escH(d.postcode) + '</p><div class="epc-l">' + list.slice(0, 120).map(function (r) {
        var exp = r.expired || (r.expires_on && r.expires_on < today), low = /[FG]/.test(r.rating);
        return '<a class="epc-r" href="' + escH(r.link) + '" target="_blank" rel="noopener"><span class="epc-b epc-' + escH(r.rating || 'x') + '">' + escH(r.rating || '?') + '</span><span class="epc-a"><b>' + escH(r.address) + '</b><small>' +
          (r.expires_on ? (exp ? '<i class="bad">Expired ' : 'Valid until ') + new Date(r.expires_on + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) + (exp ? '</i>' : '') : 'Expiry not shown') +
          (low ? ' · <i class="bad">Below E — can’t be let without an exemption</i>' : '') + '</small></span><span class="epc-go">View ↗</span></a>';
      }).join('') + '</div><p class="tool-src">From the government’s <a href="' + escH(d.url) + '" target="_blank" rel="noopener">EPC register</a>.</p>';
    }).catch(function () { go.disabled = false; go.textContent = 'Check EPCs'; err.textContent = 'Couldn’t connect — please try again.'; });
  });
  // Every licence's council fee in the borough, with the one this property needs picked out.
  function licFees(d) {
    var f = d.fees; if (!f) return '';
    var row = function (name, fee, state, key) {
      var on = d.licence && d.licence.indexOf(key) === 0, val = state === 'none' && key !== 'Mandatory' ? '<span class="lic-none">No ' + name.toLowerCase() + ' scheme in ' + escH(d.borough) + '</span>' : fee ? escH(fee) : '<span class="lic-none">Not confirmed — ask the council or ask us</span>';
      return '<div class="lic-row' + (on ? ' on' : '') + '"><span>' + name + (on ? ' <em>this property</em>' : '') + '</span><b>' + val + '</b></div>';
    };
    return '<div class="lic-fees"><p class="lic-fh">Licence fees in ' + escH(d.borough) + '</p>' +
      row('Selective licence', f.sel, f.sel_state, 'Selective') + row('Additional HMO licence', f.add, f.add_state, 'Additional') + row('Mandatory HMO licence', f.hmo, '', 'Mandatory') +
      '<small>Paid to ' + escH(d.borough) + ' Council, usually for a 5-year licence. Fees are set by the council and can change — check before you apply.</small></div>';
  }
  var lf2 = document.getElementById('licForm');
  if (lf2) {
    var shBox = document.getElementById('licShared');
    lf2.elements.household.addEventListener('change', function () { shBox.hidden = lf2.elements.household.value !== 'shared'; });
    lf2.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var e = lf2.elements, err = document.getElementById('licErr'), out = document.getElementById('licOut'), go = document.getElementById('licGo');
      err.textContent = ''; if (!pcOk(e.postcode.value)) { err.textContent = 'Please enter a full postcode.'; return; }
      go.disabled = true; go.textContent = 'Checking…'; out.innerHTML = '';
      fetch('/api/public/licence-check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ postcode: e.postcode.value, people: e.people.value, household: e.household.value, households: e.households.value, share: e.share.value, type: e.type.value }) })
        .then(function (r) { return r.json(); }).then(function (d) {
          go.disabled = false; go.textContent = 'Check licence';
          if (!d.ok) { out.innerHTML = '<div class="tool-card">' + (d.error === 'rate-limited' ? 'Too many checks — please try again shortly.' : d.error === 'postcode-unknown' ? 'We couldn’t find that postcode.' : 'Sorry, we couldn’t check that postcode.') + '</div>'; return; }
          out.innerHTML = '<div class="tool-card lic-' + escH(d.verdict) + '"><p class="lic-area">' + escH(d.borough) + (d.ward ? ' · ' + escH(d.ward) + ' ward' : '') + '</p><h3>' + escH(d.title) + '</h3>' +
            (d.licence ? '<p class="lic-type">' + escH(d.licence) + '</p>' : '') +
            licFees(d) +
            (d.why || []).map(function (w) { return '<p>' + escH(w) + '</p>'; }).join('') +
            (d.verified ? '' : '<p class="tool-note">We haven’t checked ' + escH(d.borough) + '’s schemes ward by ward yet, so please confirm with the council.</p>') +
            (d.verdict !== 'no' ? '<div class="lic-help" id="licBuy"><b>Struggling with the application? We’ll do it for you.</b><p>We handle the whole licence application for you — the council forms, floor plan, certificates and documents, and all the back-and-forth with the council until the licence is granted.</p></div>' : '') +
            '<div class="btns"><a class="btn red" href="/contact?topic=Landlord&message=' + encodeURIComponent(d.verdict === 'no' ? 'I checked my property (' + d.postcode + ') on your licence checker and would like some advice.' : 'Please help me apply for ' + (d.licence ? 'a ' + d.licence.toLowerCase() : 'a property licence') + ' for my property in ' + d.postcode + ' (' + d.borough + ').') + '">' + (d.verdict === 'no' ? 'Ask us a question' : 'Get us to apply for you →') + '</a>' +
            '<a class="btn line" href="tel:02070968131">Call 0207 096 8131</a>' + (d.link ? '<a class="btn line" href="' + escH(d.link) + '" target="_blank" rel="noopener">Council licensing page ↗</a>' : '') + '</div></div>';
          // Our licence application service, if the office has priced it: buy it straight away.
          if (d.verdict !== 'no') fetch('/api/public/cert-services', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (x) {
            var svc = ((x && x.items) || []).filter(function (i) { return /^licen/.test(i.id); })[0], box = document.getElementById('licBuy'); if (!svc || !box) return;
            box.insertAdjacentHTML('beforeend', '<div class="lic-buy"><span><b>Our licence application service</b><small>' + (svc.price ? '£' + Number(svc.price).toLocaleString('en-GB', { minimumFractionDigits: 2 }) + ' + VAT' : '<b class="lic-free">Free</b>') + ' · you only pay the council’s fee</small></span><a class="btn red" href="/book-certificate?service=licence">' + (svc.price ? 'Buy now →' : 'Get free help →') + '</a></div>');
            var ask = document.querySelector('#licOut .btns a.btn.red[href^="/contact"]'); if (ask) { ask.className = 'btn line'; ask.textContent = 'Ask a question'; }
          }).catch(function () {});
        }).catch(function () { go.disabled = false; go.textContent = 'Check licence'; err.textContent = 'Couldn’t connect — please try again.'; });
    });
  }

  // Home page "Find your next home" card: Rent / Buy picks where the search goes.
  document.querySelectorAll('.x-find').forEach(function (f) { f.addEventListener('change', function (e) { if (e.target.name === 'x-kind') f.action = e.target.value; }); });

  // Home page certificates section: each service's price from the price list.
  var hcp = document.querySelectorAll('[data-cert-price]');
  if (hcp.length) fetch('/api/public/cert-services', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
    var items = (d && d.items) || [];
    hcp.forEach(function (el) { var ids = el.getAttribute('data-cert-price').split(','), ps = items.filter(function (i) { return ids.indexOf(i.id) !== -1 && i.price; }).map(function (i) { return i.price; });
      if (ps.length) el.innerHTML = (ps.length > 1 ? 'From ' : '') + '<b>£' + Math.min.apply(null, ps).toLocaleString('en-GB') + '</b> + VAT'; });
  }).catch(function () {});
  // Home page certificates card: "from £X + VAT" from the price list.
  var xf = document.querySelector('[data-svc-from]');
  if (xf) fetch('/api/public/cert-services', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
    var ps = ((d && d.items) || []).filter(function (i) { return i.price && /^(gas|eicr|epc)/.test(i.id); }).map(function (i) { return i.price; }); if (!ps.length) return;
    xf.textContent = 'From £' + Math.min.apply(null, ps).toLocaleString('en-GB') + ' + VAT'; xf.hidden = false;
  }).catch(function () {});
  // Service pages (gas safety, EICR, EPC): the live price from the office's price list.
  var svp = document.querySelector('[data-svc-price]');
  if (svp) fetch('/api/public/cert-services', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
    var ids = svp.getAttribute('data-svc-price').split(','), list = ((d && d.items) || []).filter(function (i) { return ids.indexOf(i.id) !== -1 && i.price; });
    if (!list.length) return; var low = Math.min.apply(null, list.map(function (i) { return i.price; }));
    svp.innerHTML = '<span>' + (list.length > 1 ? 'From ' : '') + '<b>£' + low.toLocaleString('en-GB', { minimumFractionDigits: low % 1 ? 2 : 0 }) + '</b> + VAT</span>' + (list.length > 1 ? '<small>' + list.map(function (i) { return i.name.replace(/^.*?[—–-]\s*/, '') + ' £' + i.price; }).join(' · ') + ' (+ VAT)</small>' : '');
    svp.hidden = false;
  }).catch(function () {});

  // Book a gas safety certificate or EICR: pick services, see the total, book — then pay on SumUp.
  var cb = document.getElementById('cbForm');
  if (cb) {
    var cbItems = [], cbPay = false, money = function (n) { return '£' + Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
    var cbDone = document.getElementById('cbDone'), cbGo = document.getElementById('cbGo'), cbErr = document.getElementById('cbErr');
    var picked = function () { return Array.prototype.map.call(cb.querySelectorAll('[name=svc]:checked'), function (x) { return x.value; }); };
    var cbVat = 0.2, r2 = function (n) { return Math.round(n * 100) / 100; };
    var cbSum = function () { var sub = r2(cbItems.filter(function (i) { return picked().indexOf(i.id) !== -1; }).reduce(function (a, i) { return a + i.price; }, 0)), vat = r2(sub * cbVat), t = r2(sub + vat);
      document.getElementById('cbSub').textContent = money(sub); document.getElementById('cbVat').textContent = money(vat);
      var n = picked().length, onlyDiy = n && picked().every(function (id) { return /^diy/.test(id); });
      cb.querySelectorAll('.cb-visit').forEach(function (el) { el.hidden = !!onlyDiy; });
      document.getElementById('cbTotal').textContent = n && !t ? 'Free' : money(t); cbGo.disabled = !n; cbGo.textContent = !n ? 'Choose a service' : !t ? 'Send request — free →' : (cbPay ? 'Book & pay ' + money(t) + ' →' : 'Send booking — ' + money(t)); };
    var showDone = function (html) { cb.closest('.cb-grid').hidden = true; cbDone.innerHTML = '<div class="cb-done">' + html + '</div>'; cbDone.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    fetch('/api/public/cert-services', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
      cbItems = (d && d.items) || []; cbPay = !!(d && d.pay); if (d && typeof d.vat === 'number') cbVat = d.vat;
      var box = document.getElementById('cbItems');
      if (!cbItems.length) { box.innerHTML = '<div class="cb-none"><b>Online booking is coming soon.</b> Call us on <a href="tel:02070968131">0207 096 8131</a> or <a href="/contact?topic=Landlord&message=' + encodeURIComponent('I’d like to book a gas safety certificate / EICR.') + '">send us a message</a> and we’ll book it for you.</div>'; cbGo.hidden = true; return; }
      // Services named "EICR — studio to 2 bedrooms", "EICR — 3 to 4 bedrooms"… become one card with a size dropdown.
      var groups = [], byName = {};
      cbItems.forEach(function (i) { var m = /^(.+?)\s+[—–-]\s+(.+)$/.exec(i.name), key = m ? m[1] : i.id;
        if (m && byName[key]) { byName[key].opts.push({ id: i.id, label: m[2], price: i.price }); return; }
        var g = { name: m ? m[1] : i.name, desc: i.desc, opts: [{ id: i.id, label: m ? m[2] : '', price: i.price }] }; if (m) byName[key] = g; groups.push(g); });
      var icon = function (n) { return /gas/i.test(n) ? '🔥' : /eicr|electr/i.test(n) ? '⚡' : /epc|energy/i.test(n) ? '🏷️' : /inventory/i.test(n) ? '📸' : '📋'; };
      box.innerHTML = groups.map(function (g) { var o = g.opts[0], multi = g.opts.length > 1;
        return '<label class="cb-item"><input type="checkbox" name="svc" value="' + escH(o.id) + '"><span class="cb-ic">' + icon(g.name) + '</span><span class="cb-it"><b>' + escH(multi ? g.name : g.name + (o.label ? ' — ' + o.label : '')) + '</b>' + (g.desc ? '<small>' + escH(g.desc) + '</small>' : '') +
          (multi ? '<select class="cb-size" aria-label="Property size">' + g.opts.map(function (x) { return '<option value="' + escH(x.id) + '" data-price="' + x.price + '">' + escH(x.label.charAt(0).toUpperCase() + x.label.slice(1)) + '</option>'; }).join('') + '</select>' : '') +
          '</span><span class="cb-pr"><span class="cb-prv">' + (o.price ? money(o.price) : 'Free') + '</span>' + (o.price ? '<small>+ VAT</small>' : '') + '</span></label>'; }).join('');
      document.getElementById('cbPayNote').textContent = cbPay ? 'You’ll pay on SumUp’s secure page. Card details never touch our website.' : 'We’ll call you to take payment and confirm the date.';
      try { var want = new URLSearchParams(location.search).get('service'); if (want) cb.querySelectorAll('[name=svc]').forEach(function (x) { if (x.value === want || (want === 'gas' && /^gas/.test(x.value)) || (want === 'eicr' && /^eicr/.test(x.value)) || (want === 'epc' && /^epc/.test(x.value)) || (want === 'licence' && /^licen/.test(x.value)) || (want === 'diy' && /^diy/.test(x.value))) { x.checked = true; x.closest('.cb-item').classList.add('on'); } }); } catch (e) {}
      cbSum();
    }).catch(function () { document.getElementById('cbItems').innerHTML = '<p class="tool-err">Couldn’t load the services — please call 0207 096 8131.</p>'; });
    cb.addEventListener('change', function (e) { if (e.target.classList.contains('cb-size')) { var it = e.target.closest('.cb-item'), box2 = it.querySelector('[name=svc]'), op = e.target.selectedOptions[0]; box2.value = e.target.value; it.querySelector('.cb-prv').textContent = +op.dataset.price ? money(+op.dataset.price) : 'Free'; if (!box2.checked) { box2.checked = true; it.classList.add('on'); } cbSum(); return; } if (e.target.name === 'svc') { e.target.closest('.cb-item').classList.toggle('on', e.target.checked); cbSum(); } if (e.target.name === 'access') document.getElementById('cbTenantRow').hidden = e.target.value !== 'tenant'; });
    cb.addEventListener('submit', function (ev) {
      ev.preventDefault(); cbErr.textContent = '';
      var e = cb.elements, v = function (k) { return String(e[k].value || '').trim(); };
      var data = { items: picked(), address: v('address'), postcode: v('postcode'), access: v('access'), tenant_name: v('tenant_name'), tenant_phone: v('tenant_phone'), tenant_email: v('tenant_email'), dates_iso: [v('d1'), v('d2')].filter(Boolean), dates: [v('d1'), v('d2')].filter(Boolean).map(function (x) { return new Date(x + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }); }), name: v('name'), phone: v('phone'), email: v('email'), message: v('message'), website: v('website'), consent: e.consent.checked };
      if (!data.items.length) { cbErr.textContent = 'Please choose a service.'; return; }
      if (!data.address) { cbErr.textContent = 'Please enter the property address.'; return; }
      if (!pcOk(data.postcode)) { cbErr.textContent = 'Please enter the postcode.'; return; }
      if (data.access === 'tenant' && (!data.tenant_name || !data.tenant_phone)) { cbErr.textContent = 'Please enter your tenant’s name and phone number so we can arrange access.'; return; }
      if (!data.name || !data.phone) { cbErr.textContent = 'Please enter your name and phone number.'; return; }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) { cbErr.textContent = 'Please enter a valid email address.'; return; }
      if (!data.consent) { cbErr.textContent = 'Please tick the box so we can contact you.'; return; }
      var label = cbGo.textContent; cbGo.disabled = true; cbGo.textContent = cbPay ? 'Taking you to payment…' : 'Sending…';
      ffPost('/api/public/cert-booking', data, cb).then(function (r) { return r.json(); }).then(function (d) {
        if (!d.ok) { cbGo.disabled = false; cbGo.textContent = label; cbErr.textContent = d.error === 'rate-limited' ? 'Too many bookings — please call 0207 096 8131.' : d.error === 'not-london' ? 'Sorry — we only cover properties in London.' : d.error === 'postcode' ? 'Please check the postcode.' : 'Sorry, something went wrong. Please try again or call 0207 096 8131.'; return; }
        if (d.url) { location.href = d.url; return; }
        var free = !cbItems.filter(function (i) { return data.items.indexOf(i.id) !== -1; }).reduce(function (a, i) { return a + i.price; }, 0);
        showDone('<div class="big">✓</div><h3>Thanks, ' + escH(data.name.split(/\s+/)[0]) + ' — ' + (free ? 'request received' : 'booking received') + '</h3><p>' + (free ? 'We’ll call you shortly to get started. ' : d.payError ? 'We couldn’t open the payment page just now, so we’ll call you to take payment. ' : 'We’ll call you shortly to take payment and confirm the date. ') + 'Questions? Call <a href="tel:02070968131">0207 096 8131</a>.</p>');
      }).catch(function () { cbGo.disabled = false; cbGo.textContent = label; cbErr.textContent = 'Couldn’t connect — please try again or call 0207 096 8131.'; });
    });
    // Back from SumUp: ask our server (which asks SumUp) whether it's paid.
    try {
      var bq = new URLSearchParams(location.search), bid = bq.get('b'), bk = bq.get('k');
      if (bid && bk) {
        showDone('<p>Checking your payment…</p>');
        var check = function (n) { fetch('/api/public/cert-booking/' + encodeURIComponent(bid) + '?k=' + encodeURIComponent(bk), { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
          if (!d.ok) { showDone('<h3>We couldn’t find that booking</h3><p>Please call <a href="tel:02070968131">0207 096 8131</a>.</p>'); return; }
          var what = (d.items || []).map(function (i) { return escH(i.name); }).join(' + ');
          if (d.paid) { var visit = (d.items || []).some(function (i) { return !/DIY/i.test(i.name); });
            showDone('<div class="big">✓</div><h3>Paid — thank you!</h3><p><b>' + what + '</b><br>' + escH(d.address) + ' · ' + money(d.total) + (d.vat != null ? ' inc. VAT' : '') + '</p>' + (d.diy ? '<p><a class="btn red" href="' + escH(d.diy) + '">Start your DIY inventory →</a></p><p>We’ve also emailed you this link, so you can come back to it.</p>' : '') + (visit ? '<p>We’ll be in touch shortly to confirm the date and time, and we’ll remind you before your certificate expires.</p>' : '') + '<p>A confirmation has been emailed to you.</p>'); return; }
          if (n < 4) { setTimeout(function () { check(n + 1); }, 2500); return; }
          showDone('<h3>Your payment hasn’t gone through yet</h3><p><b>' + what + '</b> · ' + money(d.total) + '</p><p>If you closed the payment page, you can try again — nothing has been taken.</p><div class="btns" style="justify-content:center"><button type="button" class="btn red" id="cbRetry">Pay ' + money(d.total) + ' →</button><a class="btn line" href="tel:02070968131">Call 0207 096 8131</a></div>');
          var rb = document.getElementById('cbRetry'); if (rb) rb.addEventListener('click', function () { rb.disabled = true; rb.textContent = 'Opening payment…';
            fetch('/api/public/cert-booking/' + encodeURIComponent(bid) + '/pay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ k: bk }) }).then(function (r) { return r.json(); }).then(function (x) { if (x.paid) return check(0); if (x.url) location.href = x.url; else { rb.disabled = false; rb.textContent = 'Try again'; } }); });
        }).catch(function () { if (n < 4) setTimeout(function () { check(n + 1); }, 2500); }); };
        check(0);
      }
    } catch (e) {}
  }

  // Contact page: ?topic=Buying (etc.) picks the topic.
  var tp = /[?&]topic=([^&]+)/.exec(location.search), tsel = document.querySelector('#eForm select[name=topic]');
  if (tp && tsel) { var want = decodeURIComponent(tp[1].replace(/\+/g, ' ')); Array.prototype.forEach.call(tsel.options, function (o) { if (o.text === want) tsel.value = o.value || o.text; }); }
  // From a property page: the address and a ready-written viewing request.
  try { var cq = new URLSearchParams(location.search), ef = document.getElementById('eForm');
    if (ef && cq.get('address')) { ef.elements.address.value = cq.get('address'); if (!ef.elements.message.value) ef.elements.message.value = 'I’d like to book a viewing of ' + cq.get('address') + (cq.get('ref') ? ' (ref. ' + cq.get('ref') + ')' : '') + '. '; }
    if (ef && cq.get('message') && !ef.elements.message.value) ef.elements.message.value = String(cq.get('message')).slice(0, 500); } catch (e) {}

  // Enquiry form (Contact page): saved in Fixflow and sent to the office.
  var form = document.getElementById('eForm');
  if (form) form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var err = document.getElementById('eErr'), go = document.getElementById('eGo'), v = function (k) { var el = form.elements[k]; return el ? String(el.value || '').trim() : ''; };
    var data = { name: v('name'), email: v('email'), phone: v('phone'), topic: v('topic'), address: v('address'), message: v('message'), website: v('website'), consent: form.elements.consent.checked };
    err.textContent = '';
    if (!data.name) { err.textContent = 'Please enter your name.'; return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) { err.textContent = 'Please enter a valid email address.'; return; }
    if (data.message.length < 5) { err.textContent = 'Please tell us how we can help.'; return; }
    if (!data.consent) { err.textContent = 'Please tick the box so we can reply to you.'; return; }
    go.disabled = true; go.textContent = 'Sending…';
    ffPost('/api/enquiry', data, form).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) { go.disabled = false; go.textContent = 'Send message'; err.textContent = d.error === 'rate-limited' ? 'Too many messages — please try again later or call 0207 096 8131.' : 'Sorry, something went wrong. Please try again or call 0207 096 8131.'; return; }
      document.getElementById('eBody').innerHTML = '<div class="done"><div class="big">✓</div><h3 style="margin:0">Thanks, ' + String(data.name.split(/\s+/)[0]).replace(/[<>&"]/g, '') + ' — message sent</h3><p style="color:var(--soft);margin:8px 0 0">We’ll get back to you as soon as we can. For anything urgent, call <a href="tel:02070968131" style="font-weight:700;color:var(--navy)">0207 096 8131</a>.</p></div>';
    }).catch(function () { go.disabled = false; go.textContent = 'Send message'; err.textContent = 'Couldn’t connect — please try again or call 0207 096 8131.'; });
  });
})();
