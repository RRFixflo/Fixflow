// An example landlord portal for the website (/landlord-portal-demo): made-up landlord, properties,
// rent, repairs, certificates and sample documents, so landlords can see what they'd get.
// Nothing here is real or read from the database.
module.exports = function (app, opts) {
  const esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  const gbp = function (n) { return '£' + Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  // Dates relative to today, so the example always looks current.
  const now = new Date(), d = function (days) { const x = new Date(now); x.setDate(x.getDate() + days); return x; };
  const m = function (months, day) { const x = new Date(now.getFullYear(), now.getMonth() + months, day || 1); return x; };
  const long = function (x) { return x.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }); };
  const short = function (x) { return x.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); };
  const monthName = function (x) { return x.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }); };

  const LL = { name: 'Alex Sample', address: '1 Example Lane, London N1 0AA', email: 'alex@example.com' };
  const P = [
    { id: 'p1', address: 'Flat 4, Example Court, 20 Demo Street, London SE1 1AA', short: 'Flat 4, Example Court', beds: 2, service: 'Fully Managed', rent: 2150, fee: 12, tenants: ['Jamie Example', 'Sam Example'],
      start: m(-14, 3), deposit: 2480.77, scheme: 'Deposit Protection Service (DPS)', dref: 'DPS-0000-0000-SAMPLE', due: 3 },
    { id: 'p2', address: '12 Sample Road, London SE17 2BB', short: '12 Sample Road', beds: 3, service: 'Rent Collection', rent: 2600, fee: 8, tenants: ['Taylor Demo'],
      start: m(-5, 15), deposit: 3000, scheme: 'Deposit Protection Service (DPS)', dref: 'DPS-0000-0001-SAMPLE', due: 15 }
  ];
  const JOBS = [
    { ref: 'J-1042', p: 'p1', title: 'Annual boiler service', status: 'Completed', when: d(-21), cost: 96, note: 'Boiler serviced and gas safety check done — certificate added to your documents.', steps: ['Reported', 'Contractor booked', 'Done', 'Invoiced'] },
    { ref: 'J-1057', p: 'p1', title: 'Kitchen tap dripping', status: 'Contractor booked', when: d(-3), cost: null, note: 'Plumber visiting on ' + short(d(2)) + ', 9am–1pm. The tenant will let them in.', steps: ['Reported', 'Contractor booked'] },
    { ref: 'J-1061', p: 'p2', title: 'Smoke alarm battery warning', status: 'Reported', when: d(-1), cost: null, note: 'Reported by the tenant with a photo. We’re arranging a visit.', steps: ['Reported'] },
    { ref: 'J-0998', p: 'p2', title: 'Bathroom extractor fan replaced', status: 'Completed', when: d(-48), cost: 168, note: 'New extractor fan fitted and tested. Photos before and after added.', steps: ['Reported', 'Contractor booked', 'Done', 'Invoiced'] }
  ];
  const CERTS = [
    { p: 'p1', type: 'Gas safety record', done: d(-21), expires: d(344), doc: 'gas', ok: true },
    { p: 'p1', type: 'Electrical (EICR)', done: d(-420), expires: d(1405), doc: 'eicr', ok: true },
    { p: 'p1', type: 'EPC', done: d(-900), expires: d(2750), doc: 'epc', ok: true, note: 'Rating C (72)' },
    { p: 'p1', type: 'Selective licence', done: d(-500), expires: d(900), doc: 'licence', ok: true, note: 'Southwark Council' },
    { p: 'p2', type: 'Gas safety record', done: d(-330), expires: d(35), doc: 'gas2', ok: false, note: 'Renewal booked for ' + short(d(20)) },
    { p: 'p2', type: 'Electrical (EICR)', done: d(-200), expires: d(1625), doc: 'eicr2', ok: true },
    { p: 'p2', type: 'EPC', done: d(-1200), expires: d(2450), doc: 'epc2', ok: true, note: 'Rating D (61)' }
  ];
  const MONTHS = [0, -1, -2, -3, -4, -5].map(function (i) { return m(i, 1); });
  const prop = function (id) { return P.filter(function (x) { return x.id === id; })[0]; };
  // A month's statement figures for a property.
  function stmt(p, month) {
    const fee = Math.round(p.rent * p.fee) / 100, vat = Math.round(fee * 20) / 100;
    const costs = JOBS.filter(function (j) { return j.p === p.id && j.cost && j.when.getMonth() === month.getMonth() && j.when.getFullYear() === month.getFullYear(); });
    const cost = costs.reduce(function (a, j) { return a + j.cost; }, 0);
    return { rent: p.rent, fee: fee, vat: vat, costs: costs, cost: cost, net: p.rent - fee - vat - cost };
  }
  const DOCS = {
    tenancy: { t: 'Tenancy agreement', p: 'p1', kind: 'Tenancy' }, inventory: { t: 'Inventory & check-in report', p: 'p1', kind: 'Tenancy' }, deposit: { t: 'Deposit protection certificate', p: 'p1', kind: 'Tenancy' },
    infosheet: { t: 'Renters’ Rights Act Information Sheet — served', p: 'p1', kind: 'Tenancy' }, rentincrease: { t: 'Rent increase notice (Form 4A)', p: 'p1', kind: 'Tenancy' },
    gas: { t: 'Gas safety record (CP12)', p: 'p1', kind: 'Certificates' }, eicr: { t: 'Electrical installation condition report (EICR)', p: 'p1', kind: 'Certificates' }, epc: { t: 'Energy performance certificate (EPC)', p: 'p1', kind: 'Certificates' },
    licence: { t: 'Selective licence', p: 'p1', kind: 'Certificates' }, gas2: { t: 'Gas safety record (CP12)', p: 'p2', kind: 'Certificates' }, eicr2: { t: 'Electrical installation condition report (EICR)', p: 'p2', kind: 'Certificates' }, epc2: { t: 'Energy performance certificate (EPC)', p: 'p2', kind: 'Certificates' },
    terms: { t: 'Landlord terms of business (signed)', p: null, kind: 'Agreements' }, inv1042: { t: 'Invoice INV-1042 — boiler service', p: 'p1', kind: 'Invoices' }, inv0998: { t: 'Invoice INV-0998 — extractor fan', p: 'p2', kind: 'Invoices' },
    tenancy2: { t: 'Tenancy agreement', p: 'p2', kind: 'Tenancy' }, inventory2: { t: 'Inventory & check-in report', p: 'p2', kind: 'Tenancy' }
  };
  MONTHS.forEach(function (mo, i) { P.forEach(function (p) { DOCS['st-' + p.id + '-' + i] = { t: 'Statement — ' + monthName(mo), p: p.id, kind: 'Statements', month: mo }; }); });

  // ---------- The portal page ----------
  function page() {
    const rentIn = P.reduce(function (a, p) { return a + stmt(p, MONTHS[0]).net; }, 0);
    const open = JOBS.filter(function (j) { return j.status !== 'Completed'; }).length;
    const due = CERTS.filter(function (c) { return !c.ok; }).length;
    const tile = function (k, v, s, cls) { return '<div class="pd-tile ' + (cls || '') + '"><span>' + k + '</span><b>' + v + '</b><small>' + s + '</small></div>'; };
    const docLink = function (id) { return '<a class="pd-doc" href="/landlord-portal-demo/doc/' + id + '" target="_blank" rel="noopener"><span class="pd-doc-ic">📄</span><span><b>' + esc(DOCS[id].t) + '</b><small>' + esc(DOCS[id].p ? prop(DOCS[id].p).short : 'All properties') + '</small></span><span class="pd-doc-go">Open</span></a>'; };
    return '<div class="pdemo-bar"><div class="wrap"><b>👀 Example landlord portal</b><span>Everything here is made up, so you can see what our landlords get. Click around — nothing is real.</span><a class="btn red" href="/landlords#valuation">Get a free valuation</a></div></div>' +
      '<section class="pdemo"><div class="wrap">' +
      '<div class="pd-head"><div><p class="kicker">Your landlord page</p><h1>Hello, ' + esc(LL.name.split(' ')[0]) + '</h1><p class="sub">Your 2 properties, rent, repairs, certificates and documents — always up to date.</p></div>' +
      '<div class="pd-tabs" role="tablist"><a href="#pd-over" class="on">Overview</a><a href="#pd-rent">Rent</a><a href="#pd-rep">Repairs</a><a href="#pd-cert">Certificates</a><a href="#pd-docs">Documents</a></div></div>' +
      '<div class="pd-tiles" id="pd-over">' + tile('Paid to you this month', gbp(rentIn), 'on ' + short(m(0, 5)), 'good') + tile('Rent collected', gbp(P.reduce(function (a, p) { return a + p.rent; }, 0)), 'from 2 tenancies') + tile('Repairs in progress', open, open ? 'we’re on it' : 'none open', open ? 'warn' : '') + tile('Certificates', due ? due + ' due soon' : 'All valid', due ? 'renewal already booked' : 'nothing to do', due ? 'warn' : 'good') + '</div>' +
      '<div class="pd-props">' + P.map(function (p) {
        return '<div class="pd-prop"><div class="pd-prop-h"><span class="pd-ph">🏠</span><div><b>' + esc(p.address) + '</b><small>' + p.beds + ' bedrooms · ' + esc(p.service) + '</small></div></div>' +
          '<div class="pd-kv"><span>Tenants</span><b>' + esc(p.tenants.join(' & ')) + '</b></div><div class="pd-kv"><span>Rent</span><b>' + gbp(p.rent) + ' a month · due on the ' + p.due + (p.due === 3 ? 'rd' : 'th') + '</b></div>' +
          '<div class="pd-kv"><span>Tenancy</span><b>Periodic, since ' + long(p.start) + '</b></div><div class="pd-kv"><span>Deposit</span><b>' + gbp(p.deposit) + ' · ' + esc(p.scheme) + '</b></div>' +
          '<div class="pd-kv"><span>Next rent review</span><b>' + long(new Date(p.start.getFullYear() + 1 + (p.start < m(-12) ? 1 : 0), p.start.getMonth(), p.start.getDate())) + '</b></div></div>';
      }).join('') + '</div>' +
      '<h2 class="h2x pd-h2" id="pd-rent">Rent &amp; statements</h2><div class="pd-table"><table><thead><tr><th>Month</th><th>Property</th><th>Rent</th><th>Fees &amp; costs</th><th>Paid to you</th><th></th></tr></thead><tbody>' +
      MONTHS.map(function (mo, i) { return P.map(function (p) { const s = stmt(p, mo); return '<tr><td>' + monthName(mo) + '</td><td>' + esc(p.short) + '</td><td>' + gbp(s.rent) + '</td><td>' + gbp(s.fee + s.vat + s.cost) + '</td><td><b>' + gbp(s.net) + '</b></td><td><a href="/landlord-portal-demo/doc/st-' + p.id + '-' + i + '" target="_blank" rel="noopener">Statement</a></td></tr>'; }).join(''); }).join('') +
      '</tbody></table></div><p class="pd-note">Download everything as a spreadsheet for your accountant at the end of the tax year.</p>' +
      '<h2 class="h2x pd-h2" id="pd-rep">Repairs</h2><div class="pd-jobs">' + JOBS.map(function (j) {
        const all = ['Reported', 'Contractor booked', 'Done', 'Invoiced'];
        return '<div class="pd-job"><div class="pd-job-h"><b>' + esc(j.title) + '</b><span class="pd-st ' + (j.status === 'Completed' ? 'done' : 'open') + '">' + esc(j.status) + '</span></div><small>' + esc(prop(j.p).short) + ' · ' + j.ref + ' · reported ' + short(j.when) + (j.cost ? ' · ' + gbp(j.cost) : '') + '</small>' +
          '<div class="pd-steps">' + all.map(function (s) { return '<span class="' + (j.steps.indexOf(s) !== -1 ? 'on' : '') + '">' + s + '</span>'; }).join('') + '</div><p>' + esc(j.note) + '</p></div>';
      }).join('') + '</div>' +
      '<h2 class="h2x pd-h2" id="pd-cert">Certificates</h2><div class="pd-certs">' + CERTS.map(function (c) {
        return '<a class="pd-cert ' + (c.ok ? 'ok' : 'due') + '" href="/landlord-portal-demo/doc/' + c.doc + '" target="_blank" rel="noopener"><span class="pd-cert-ic">' + (c.ok ? '✓' : '⏰') + '</span><span><b>' + esc(c.type) + '</b><small>' + esc(prop(c.p).short) + ' · ' + (c.ok ? 'valid until ' : 'expires ') + short(c.expires) + (c.note ? ' · ' + esc(c.note) : '') + '</small></span></a>';
      }).join('') + '</div>' +
      '<h2 class="h2x pd-h2" id="pd-docs">Documents</h2>' + ['Tenancy', 'Certificates', 'Agreements', 'Invoices', 'Statements'].map(function (k) {
        const ids = Object.keys(DOCS).filter(function (id) { return DOCS[id].kind === k; }).slice(0, k === 'Statements' ? 4 : 99);
        return '<h3 class="pd-dh">' + (k === 'Tenancy' ? 'Tenancy documents' : k) + '</h3><div class="pd-docs">' + ids.map(docLink).join('') + '</div>';
      }).join('') +
      '<div class="band" style="margin-top:44px"><div><h2>Want this for your property?</h2><p>Every landlord we manage for gets their own portal, free.</p></div><div class="btns"><a class="btn red" href="/landlords#valuation">Free valuation →</a><a class="btn ghost" href="tel:02070968131">📞 0207 096 8131</a></div></div>' +
      '</div></section>';
  }

  // ---------- Sample documents (printable) ----------
  function shell(title, body) {
    return '<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>' + esc(title) + ' — sample</title>' +
      '<style>body{margin:0;background:#eef1f6;font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;color:#0f172a}.pg{max-width:820px;margin:24px auto;background:#fff;padding:44px 48px;border-radius:6px;box-shadow:0 10px 40px -20px rgba(0,0,0,.35);position:relative;overflow:hidden}' +
      '.wm{position:absolute;inset:0;display:grid;place-items:center;pointer-events:none;font-size:110px;font-weight:900;color:rgba(217,38,46,.07);transform:rotate(-24deg)}.hd{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;border-bottom:3px solid #0b1f3a;padding-bottom:16px;margin-bottom:22px}.hd img{height:46px}.hd small{color:#475467;text-align:right;display:block}' +
      'h1{font-size:24px;margin:0 0 4px;color:#0b1f3a}h2{font-size:16px;margin:24px 0 8px;color:#0b1f3a}table{width:100%;border-collapse:collapse;margin:8px 0}td,th{border-bottom:1px solid #e6e9ef;padding:8px 6px;text-align:left;vertical-align:top}th{background:#f6f7fb;font-size:13px}.r{text-align:right}.tot td{font-weight:800;border-top:2px solid #0b1f3a}' +
      '.sample{background:#fff4d6;border:1px solid #f3d28b;color:#7a5200;border-radius:8px;padding:10px 14px;font-weight:700;margin-bottom:20px}.kv{display:grid;grid-template-columns:200px 1fr;gap:6px 14px}.kv b{color:#475467;font-weight:600}.badge{display:inline-block;padding:3px 10px;border-radius:999px;font-weight:800;font-size:13px}.ok{background:#e7f8ef;color:#067647}.ft{margin-top:30px;font-size:12px;color:#667085;border-top:1px solid #e6e9ef;padding-top:12px}' +
      '.bar{position:sticky;top:0;background:#0b1f3a;color:#fff;padding:10px 16px;display:flex;gap:12px;align-items:center;justify-content:center;font-weight:700}.bar button{background:#fff;color:#0b1f3a;border:0;border-radius:8px;padding:8px 14px;font-weight:800;cursor:pointer}' +
      '@media print{.bar{display:none}body{background:#fff}.pg{box-shadow:none;margin:0}}@media(max-width:600px){.pg{padding:24px 18px;margin:0}.kv{grid-template-columns:1fr}.wm{font-size:60px}}</style></head><body>' +
      '<div class="bar">Example document from our landlord portal <button onclick="print()">Print / save as PDF</button></div><div class="pg"><div class="wm">SAMPLE</div>' +
      '<div class="hd"><img src="/logo-tight.png" alt="Residential Realtors"><small>Residential Realtors<br>28-30 Harper Road, London SE1 6AD<br>0207 096 8131 · info@residentialrealtors.co.uk</small></div>' +
      '<div class="sample">Example only — the names, addresses and figures in this document are made up.</div>' + body +
      '<p class="ft">Estallion Investments Ltd trading as Residential Realtors · Company number 08760284 · Propertymark Client Money Protection · The Property Ombudsman.</p></div></body></html>';
  }
  const kv = function (rows) { return '<div class="kv">' + rows.map(function (r) { return '<b>' + r[0] + '</b><span>' + r[1] + '</span>'; }).join('') + '</div>'; };
  function docBody(id) {
    const D = DOCS[id]; if (!D) return null;
    const p = D.p ? prop(D.p) : null;
    if (D.kind === 'Statements') {
      const s = stmt(p, D.month);
      return '<h1>Landlord statement — ' + monthName(D.month) + '</h1>' + kv([['Landlord', esc(LL.name)], ['Property', esc(p.address)], ['Tenants', esc(p.tenants.join(' & '))], ['Statement date', long(new Date(D.month.getFullYear(), D.month.getMonth(), 5))]]) +
        '<table><tr><th>Item</th><th class="r">Amount</th></tr><tr><td>Rent received — ' + monthName(D.month) + '</td><td class="r">' + gbp(s.rent) + '</td></tr><tr><td>' + esc(p.service) + ' fee (' + p.fee + '%)</td><td class="r">−' + gbp(s.fee) + '</td></tr><tr><td>VAT on fee (20%)</td><td class="r">−' + gbp(s.vat) + '</td></tr>' +
        s.costs.map(function (j) { return '<tr><td>' + esc(j.title) + ' (' + j.ref + ')</td><td class="r">−' + gbp(j.cost) + '</td></tr>'; }).join('') + '<tr class="tot"><td>Paid to you</td><td class="r">' + gbp(s.net) + '</td></tr></table><p>Paid by bank transfer to your nominated account ending 0000.</p>';
    }
    if (id === 'inv1042' || id === 'inv0998') {
      const j = JOBS.filter(function (x) { return 'inv' + x.ref.slice(2) === id; })[0], net = Math.round(j.cost / 1.2 * 100) / 100;
      return '<h1>Invoice INV-' + j.ref.slice(2) + '</h1>' + kv([['To', esc(LL.name) + ', ' + esc(LL.address)], ['Property', esc(prop(j.p).address)], ['Date', long(j.when)], ['Job', j.ref + ' — ' + esc(j.title)]]) +
        '<table><tr><th>Description</th><th class="r">Amount</th></tr><tr><td>' + esc(j.title) + ' — labour and parts</td><td class="r">' + gbp(net) + '</td></tr><tr><td>VAT (20%)</td><td class="r">' + gbp(j.cost - net) + '</td></tr><tr class="tot"><td>Total — taken from rent</td><td class="r">' + gbp(j.cost) + '</td></tr></table><p>' + esc(j.note) + '</p>';
    }
    if (/^gas/.test(id)) { const c = CERTS.filter(function (x) { return x.doc === id; })[0];
      return '<h1>Landlord gas safety record (CP12)</h1>' + kv([['Property', esc(p.address)], ['Date of check', long(c.done)], ['Next check due by', long(c.expires)], ['Engineer', 'A. Example — Gas Safe reg. 000000'], ['Result', '<span class="badge ok">PASS</span>']]) +
        '<table><tr><th>Appliance</th><th>Location</th><th>Safe to use</th></tr><tr><td>Combination boiler</td><td>Kitchen</td><td>Yes</td></tr><tr><td>Gas hob</td><td>Kitchen</td><td>Yes</td></tr></table><h2>Safety checks</h2><p>Flue, ventilation, gas tightness and carbon monoxide alarm checked — all satisfactory.</p>'; }
    if (/^eicr/.test(id)) { const c = CERTS.filter(function (x) { return x.doc === id; })[0];
      return '<h1>Electrical installation condition report (EICR)</h1>' + kv([['Property', esc(p.address)], ['Inspected', long(c.done)], ['Next inspection by', long(c.expires)], ['Electrician', 'B. Example Electrical — NICEIC 000000'], ['Overall condition', '<span class="badge ok">SATISFACTORY</span>']]) +
        '<h2>Observations</h2><table><tr><th>Item</th><th>Code</th></tr><tr><td>No RCD protection to one outdoor socket — recommendation only</td><td>C3</td></tr></table><p>No dangerous (C1) or potentially dangerous (C2) items found.</p>'; }
    if (/^epc/.test(id)) { const c = CERTS.filter(function (x) { return x.doc === id; })[0], r = /Rating (\w) \((\d+)\)/.exec(c.note);
      return '<h1>Energy performance certificate (EPC)</h1>' + kv([['Property', esc(p.address)], ['Rating', 'Band ' + r[1] + ' (' + r[2] + ')'], ['Potential', 'Band B (84)'], ['Valid until', long(c.expires)], ['Reference', '0000-0000-0000-0000-SAMPLE']]) +
        '<h2>Recommended improvements</h2><table><tr><th>Measure</th><th>Typical cost</th></tr><tr><td>Low energy lighting</td><td>£50</td></tr><tr><td>Hot water cylinder thermostat</td><td>£200 – £400</td></tr><tr><td>Solar panels</td><td>£3,500 – £5,500</td></tr></table>'; }
    if (id === 'licence') return '<h1>Selective licence</h1>' + kv([['Licence holder', esc(LL.name)], ['Property', esc(p.address)], ['Council', 'London Borough of Southwark (example)'], ['Licence number', 'SL-00000-SAMPLE'], ['Valid', short(d(-500)) + ' to ' + short(d(900))], ['Maximum occupants', '4 people, 2 households']]) + '<h2>Conditions</h2><p>Keep gas, electrical and smoke alarm safety certificates up to date; give tenants a written statement of terms; deal with anti-social behaviour; keep the property in good repair.</p>';
    if (id === 'tenancy' || id === 'tenancy2') return '<h1>Assured periodic tenancy agreement</h1>' + kv([['Landlord', esc(LL.name)], ['Tenants', esc(p.tenants.join(', '))], ['Property', esc(p.address)], ['Start date', long(p.start)], ['Rent', gbp(p.rent) + ' a month, payable on the ' + p.due + (p.due === 3 ? 'rd' : 'th')], ['Deposit', gbp(p.deposit) + ' — protected with the ' + esc(p.scheme)]]) +
      '<h2>1. The tenancy</h2><p>This is an assured periodic tenancy under the Housing Act 1988 as amended by the Renters’ Rights Act 2025. It runs from month to month with no fixed end date.</p><h2>2. Rent</h2><p>The rent may be increased once a year by notice in the prescribed form.</p><h2>3. Ending the tenancy</h2><p>The tenants may end the tenancy by giving at least two months’ written notice. The landlord may only seek possession on the grounds set out in law.</p><h2>4. Repairs</h2><p>Repairs can be reported to Residential Realtors online at any time.</p><p><i>… (sample — the full agreement continues) …</i></p><p>Signed electronically by all parties on ' + long(new Date(p.start.getTime() - 6 * 86400000)) + '.</p>';
    if (id === 'inventory' || id === 'inventory2') return '<h1>Inventory &amp; check-in report</h1>' + kv([['Property', esc(p.address)], ['Check-in date', long(p.start)], ['Prepared by', 'Example Inventories Ltd'], ['Photos', '146 photos, dated']]) +
      '<table><tr><th>Room</th><th>Item</th><th>Condition</th></tr><tr><td>Living room</td><td>Walls &amp; ceiling</td><td>Freshly painted, clean, no marks</td></tr><tr><td>Living room</td><td>Flooring</td><td>Oak-effect laminate — good, light wear by door</td></tr><tr><td>Kitchen</td><td>Oven &amp; hob</td><td>Professionally cleaned, working</td></tr><tr><td>Bedroom 1</td><td>Double bed &amp; mattress</td><td>Good, mattress protector fitted</td></tr><tr><td>Bathroom</td><td>Bath &amp; shower screen</td><td>Clean, sealant intact</td></tr></table><p>Meter readings — Gas 01234 · Electric 56789 · Water 00012. Keys given: 2 sets.</p>';
    if (id === 'deposit') return '<h1>Deposit protection certificate</h1>' + kv([['Scheme', esc(p.scheme)], ['Deposit ID', esc(p.dref)], ['Amount protected', gbp(p.deposit)], ['Tenants', esc(p.tenants.join(', '))], ['Property', esc(p.address)], ['Protected on', long(new Date(p.start.getTime() + 9 * 86400000))]]) + '<p>The prescribed information was given to the tenants within 30 days of receiving the deposit.</p>';
    if (id === 'infosheet') return '<h1>Renters’ Rights Act Information Sheet 2026 — record of service</h1>' + kv([['Property', esc(p.address)], ['Served to', esc(p.tenants.join(', '))], ['Method', 'Emailed as a PDF attachment'], ['Date served', long(m(-6, 12))]]) + '<p>The official government Information Sheet was given to every tenant named on the tenancy, as required.</p>';
    if (id === 'rentincrease') return '<h1>Notice proposing a new rent (Form 4A)</h1>' + kv([['Property', esc(p.address)], ['Current rent', gbp(p.rent) + ' a month'], ['Proposed rent', gbp(p.rent + 75) + ' a month'], ['Starting from', long(new Date(p.start.getFullYear() + 2, p.start.getMonth(), p.start.getDate()))], ['Status', 'Draft — waiting for your approval']]) + '<p>Rent can only be increased once a year, with at least two months’ notice. Tenants can challenge an increase at the First-tier Tribunal.</p>';
    if (id === 'terms') return '<h1>Landlord terms of business</h1>' + kv([['Landlord', esc(LL.name)], ['Properties', P.map(function (x) { return esc(x.short); }).join(', ')], ['Services', 'Fully Managed (12% + VAT) · Rent Collection (8% + VAT)'], ['Signed', long(m(-15, 20)) + ', electronically']]) + '<h2>Summary</h2><p>Rent collected and paid to you by the 5th of each month with a statement; repairs arranged with your approval above £250; certificates tracked and renewed; deposits protected; Client Money Protection with Propertymark.</p>';
    return null;
  }

  app.get('/landlord-portal-demo', function (req, res) {
    opts.send(req, res, { name: 'portaldemo', stamp: now.toISOString().slice(0, 10), canon: '/landlord-portal-demo', crumb: 'Example landlord portal', title: 'Example Landlord Portal | Residential Realtors', desc: 'Try our landlord portal with an example property: rent statements, repairs, certificates and documents in one place.' }, page());
  });
  app.get('/landlord-portal-demo/doc/:id', function (req, res) {
    const id = String(req.params.id || ''), body = docBody(id);
    if (!body) return res.status(404).send('Not found');
    res.setHeader('X-Robots-Tag', 'noindex'); res.type('html').send(shell(DOCS[id].t, body));
  });
};
