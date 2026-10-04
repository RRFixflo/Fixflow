// Visit activity for the public pages (repair report, repair tracker, the
// contractor job link and the landlord's page): which steps someone reached,
// what they picked, how long they stayed. No names or contact details are
// sent; the server notes the connection's IP address for the office. A visit
// is a random id for this tab; the browser keeps a second random id so the office can recognise a returning tenant, landlord or
// contractor once they've sent a report or opened a link sent to them.
(function () {
  try {
    var path = location.pathname;
    var page = /^\/(t\/|track)/.test(path) ? 'track' : /^\/c\//.test(path) ? 'portal' : /^\/l\//.test(path) ? 'landlord' : /^\/offer\/review\//.test(path) ? 'review'
      : /^\/offer\/track\//.test(path) ? 'offer-track' : /^\/offer/.test(path) ? 'offer' : /^\/landlord\//.test(path) ? 'terms' : /^\/reserve\//.test(path) ? 'pvr' : 'report';
    var rand = function () { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36); };
    var sid;
    try { sid = sessionStorage.getItem('rr_sid'); if (!sid) { sid = rand(); sessionStorage.setItem('rr_sid', sid); } } catch (e) { sid = rand(); }
    var vid = '';
    try { vid = localStorage.getItem('rr_vid') || ''; if (!vid) { vid = rand(); localStorage.setItem('rr_vid', vid); } } catch (e) {}
    var send = function (ev, v, extra) {
      var d = { sid: sid, vid: vid, page: page, path: path, ev: ev };
      if (v != null) d.v = String(v).slice(0, 120);
      if (extra) for (var k in extra) d[k] = extra[k];
      var body = JSON.stringify(d);
      try { if (navigator.sendBeacon && navigator.sendBeacon('/api/visit/e', body)) return; } catch (e) {}
      try { fetch('/api/visit/e', { method: 'POST', body: body, keepalive: true, headers: { 'Content-Type': 'text/plain' } }); } catch (e) {}
    };
    window.rrt = send;
    var q = new URLSearchParams(location.search), tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) {}
    send('view', null, {
      ref: document.referrer ? document.referrer.slice(0, 300) : '',
      utm: (q.get('utm_source') || q.get('src') || '').slice(0, 60), to: (q.get('w') || '').slice(0, 2), search: (q.get('i') ? '?i=' + q.get('i') : q.get('pvr') ? '?pvr=' + q.get('pvr') : '').slice(0, 60),
      w: screen.width, h: screen.height, lang: (navigator.language || '').slice(0, 20), tz: tz.slice(0, 60)
    });
    // Keep the visit's length accurate while the page is open (up to 30 minutes).
    var beats = 0;
    var timer = setInterval(function () {
      if (document.visibilityState === 'visible') send('ping');
      if (++beats >= 60) clearInterval(timer);
    }, 30000);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') send('hide'); });
    // How far a form has got: boxes filled out of those showing, the last box touched and the section it's in.
    // Only the box's label is sent — never what was typed.
    var shown = function (el) { return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length); };
    var labelOf = function (el) {
      var t = '';
      if (el.id) { var l = document.querySelector('label[for="' + el.id + '"]'); if (l) t = l.textContent; }
      if (!t && el.closest('label')) t = el.closest('label').textContent;
      if (!t) t = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || el.id || '';
      return String(t).replace(/\s+/g, ' ').replace(/[*:]+\s*$/, '').trim().slice(0, 60);
    };
    var sectionOf = function (el) {
      var c = el.closest('section, .card, fieldset, form'), h = c && c.querySelector('h1, h2, h3, legend');
      return h ? String(h.textContent).replace(/\s+/g, ' ').trim().slice(0, 60) : '';
    };
    var formT = null, lastEl = null;
    var progress = function () {
      var els = Array.prototype.slice.call(document.querySelectorAll('input, select, textarea')).filter(function (el) {
        var ty = (el.type || '').toLowerCase();
        return ['hidden', 'submit', 'button', 'reset', 'image', 'search'].indexOf(ty) === -1 && !el.disabled && shown(el) && !el.closest('[data-rrt-skip]');
      });
      var radios = {}, total = 0, filled = 0;
      els.forEach(function (el) {
        var ty = (el.type || '').toLowerCase();
        if (ty === 'radio') { if (!(el.name in radios)) { radios[el.name] = false; total++; } if (el.checked && !radios[el.name]) { radios[el.name] = true; filled++; } return; }
        total++;
        if (ty === 'checkbox' ? el.checked : ty === 'file' ? el.files && el.files.length : String(el.value || '').trim()) filled++;
      });
      if (!total) return;
      send('form', null, { filled: filled, total: total, field: lastEl ? labelOf(lastEl) : '', section: lastEl ? sectionOf(lastEl) : '' });
    };
    var touched = function (e) { var el = e.target; if (!el || !/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return; lastEl = el; clearTimeout(formT); formT = setTimeout(progress, 2500); };
    document.addEventListener('input', touched, true); document.addEventListener('change', touched, true);
  } catch (e) {}
})();
