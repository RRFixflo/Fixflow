/* Website forms: before anything is sent, a quick check that a real person is using the page —
   a one-off token, a small puzzle the browser solves, and (when switched on) Cloudflare Turnstile. */
(function () {
  var work = null, got = 0;
  function solve(t, bits) {
    if (!(window.crypto && crypto.subtle && window.TextEncoder)) return Promise.resolve('');
    var enc = new TextEncoder(), zeros = new Array(bits / 4 + 1).join('0'), n = 0;
    var hex = function (b) { return Array.prototype.map.call(new Uint8Array(b), function (x) { return (x < 16 ? '0' : '') + x.toString(16); }).join(''); };
    return new Promise(function (done) {
      (function batch() {
        var start = n, list = [];
        for (var i = 0; i < 128; i++, n++) list.push(crypto.subtle.digest('SHA-256', enc.encode(t + ':' + n)));
        Promise.all(list).then(function (hs) {
          for (var k = 0; k < hs.length; k++) if (hex(hs[k]).slice(0, zeros.length) === zeros) return done(String(start + k));
          if (n > 2000000) return done(''); batch();
        });
      })();
    });
  }
  function start() {
    got = Date.now();
    work = fetch('/api/form-token', { cache: 'no-store', credentials: 'same-origin' }).then(function (r) { return r.json(); })
      .then(function (d) { return solve(d.t, d.bits || 12).then(function (n) { d.n = n; return d; }); });
    work.catch(function () { work = null; });
    return work;
  }
  // Start as soon as someone begins filling in a form, so it's ready by the time they press send.
  document.addEventListener('focusin', function (e) { if (!work && e.target && e.target.closest && e.target.closest('form')) start(); });
  window.ffPost = function (url, data, form, again) {
    return (work || start()).then(function (t) {
      var wait = Math.max(0, (t.min || 0) - (Date.now() - got) + 300);
      return new Promise(function (r) { setTimeout(r, wait); }).then(function () {
        var tsIn = (form && form.querySelector('[name="cf-turnstile-response"]')) || document.querySelector('[name="cf-turnstile-response"]');
        var body = {}; for (var k in data) if (Object.prototype.hasOwnProperty.call(data, k)) body[k] = data[k];
        body.ff = t.t; body.ffn = t.n; body.ts = tsIn ? tsIn.value : '';
        work = null;   // each send uses a fresh check
        var p = fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) });
        p.then(function () { try { var w = form && form.querySelector('.cf-turnstile'); if (w && window.turnstile) window.turnstile.reset(w); } catch (e) {} });
        // A check that didn't pass in time (e.g. a slow connection): get a fresh one and send again, once.
        return p.then(function (res) {
          if (res.status !== 403 || again) return res;
          return res.clone().json().then(function (d) { if (!d || !d.retry) return res; work = null; return window.ffPost(url, data, form, true); }, function () { return res; });
        });
      });
    });
  };
  // Cloudflare Turnstile on every enquiry form (only when the site key is set).
  if (window.FF_TS) {
    var add = function () {
      document.querySelectorAll('#vForm, #sForm, #eForm, #bkForm, #qvForm, .la-form').forEach(function (f) {
        if (f.querySelector('.cf-turnstile')) return;
        var d = document.createElement('div'); d.className = 'cf-turnstile'; d.setAttribute('data-sitekey', window.FF_TS); d.setAttribute('data-appearance', 'interaction-only'); d.setAttribute('data-size', 'flexible');
        var b = f.querySelector('button[type=submit]'); if (b && b.parentNode) b.parentNode.insertBefore(d, b); else f.appendChild(d);
      });
      var s = document.createElement('script'); s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js'; s.async = true; s.defer = true; document.head.appendChild(s);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add); else add();
  }
})();
