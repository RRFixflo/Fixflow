/* Residential Realtors website: menu, reveal-on-scroll and the enquiry form. */
(function () {
  var btn = document.querySelector('.menu-btn'), nav = document.querySelector('.nav');
  if (btn && nav) {
    btn.addEventListener('click', function () { var o = nav.classList.toggle('open'); btn.setAttribute('aria-expanded', o ? 'true' : 'false'); btn.textContent = o ? '✕' : '☰'; });
    nav.addEventListener('click', function (e) { if (e.target.closest('a')) { nav.classList.remove('open'); btn.textContent = '☰'; } });
  }
  var yr = document.getElementById('yr'); if (yr) yr.textContent = new Date().getFullYear();
  var io = 'IntersectionObserver' in window ? new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }); }, { threshold: .1 }) : null;
  document.querySelectorAll('.rv').forEach(function (el) { if (io) io.observe(el); else el.classList.add('in'); });

  // Sales valuation form (Sales page): saved with the website requests and sent to the office.
  var sf = document.getElementById('sForm');
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
    fetch('/api/valuation-request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(function (r) { return r.json(); }).then(function (d) {
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

  // Contact page: ?topic=Buying (etc.) picks the topic.
  var tp = /[?&]topic=([^&]+)/.exec(location.search), tsel = document.querySelector('#eForm select[name=topic]');
  if (tp && tsel) { var want = decodeURIComponent(tp[1].replace(/\+/g, ' ')); Array.prototype.forEach.call(tsel.options, function (o) { if (o.text === want) tsel.value = o.value || o.text; }); }
  // From a property page: the address and a ready-written viewing request.
  try { var cq = new URLSearchParams(location.search), ef = document.getElementById('eForm');
    if (ef && cq.get('address')) { ef.elements.address.value = cq.get('address'); if (!ef.elements.message.value) ef.elements.message.value = 'I’d like to book a viewing of ' + cq.get('address') + (cq.get('ref') ? ' (ref. ' + cq.get('ref') + ')' : '') + '. '; } } catch (e) {}

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
    fetch('/api/enquiry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) { go.disabled = false; go.textContent = 'Send message'; err.textContent = d.error === 'rate-limited' ? 'Too many messages — please try again later or call 0207 096 8131.' : 'Sorry, something went wrong. Please try again or call 0207 096 8131.'; return; }
      document.getElementById('eBody').innerHTML = '<div class="done"><div class="big">✓</div><h3 style="margin:0">Thanks, ' + String(data.name.split(/\s+/)[0]).replace(/[<>&"]/g, '') + ' — message sent</h3><p style="color:var(--soft);margin:8px 0 0">We’ll get back to you as soon as we can. For anything urgent, call <a href="tel:02070968131" style="font-weight:700;color:var(--navy)">0207 096 8131</a>.</p></div>';
    }).catch(function () { go.disabled = false; go.textContent = 'Send message'; err.textContent = 'Couldn’t connect — please try again or call 0207 096 8131.'; });
  });
})();
