// Visit activity for the public pages (repair report, repair tracker, the
// contractor job link and the landlord's page): which steps someone reached,
// what they picked, how long they stayed. No names or contact details are
// sent; the server notes the connection's IP address for the office. A visit
// is a random id for this tab; the browser keeps a second random id so the office can recognise a returning tenant, landlord or
// contractor once they've sent a report or opened a link sent to them.
(function () {
  try {
    var path = location.pathname;
    var page = /^\/(t\/|track)/.test(path) ? 'track' : /^\/c\//.test(path) ? 'portal' : /^\/l\//.test(path) ? 'landlord' : 'report';
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
      utm: (q.get('utm_source') || q.get('src') || '').slice(0, 60), to: (q.get('w') || '').slice(0, 2),
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
