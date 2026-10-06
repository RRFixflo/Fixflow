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
