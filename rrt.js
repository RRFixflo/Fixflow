// Visit activity for the public pages (repair report, repair tracker and the
// contractor job link): which steps someone reached, what they picked, how
// long they stayed. No names, contact details or IP addresses are sent; a
// visit is a random id kept for this browser tab only.
(function () {
  try {
    var path = location.pathname;
    var page = /^\/(t\/|track)/.test(path) ? 'track' : /^\/c\//.test(path) ? 'portal' : 'report';
    var rand = function () { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36); };
    var sid;
    try { sid = sessionStorage.getItem('rr_sid'); if (!sid) { sid = rand(); sessionStorage.setItem('rr_sid', sid); } } catch (e) { sid = rand(); }
    var send = function (ev, v, extra) {
      var d = { sid: sid, page: page, path: path, ev: ev };
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
      utm: (q.get('utm_source') || q.get('src') || '').slice(0, 60),
      w: screen.width, h: screen.height, lang: (navigator.language || '').slice(0, 20), tz: tz.slice(0, 60)
    });
    // Keep the visit's length accurate while the page is open (up to 30 minutes).
    var beats = 0;
    var timer = setInterval(function () {
      if (document.visibilityState === 'visible') send('ping');
      if (++beats >= 60) clearInterval(timer);
    }, 30000);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') send('hide'); });
  } catch (e) {}
})();
