// Phone answering when nobody is free: the office line diverts unanswered (or after-hours) calls to a Twilio number; Twilio calls these
// webhooks. Claude talks to the caller like a receptionist (Twilio turns speech into text and reads Claude's
// replies aloud), takes their name, email, best number and what it's about, and the call becomes a Website
// lead ("Phone message") with the team alerted. Repairs alert the owner only, like online repair reports.
//
// Railway variables: TWILIO_AUTH_TOKEN (checks each request really comes from Twilio), ANTHROPIC_API_KEY.
// Optional: VOICE_MODEL (default claude-opus-5-5), VOICE_NAME (Twilio voice, default Polly.Amy-Neural).
// Twilio number → Voice → "A call comes in": https://www.residentialrealtors.co.uk/voice/incoming (POST),
// and Call status changes: https://www.residentialrealtors.co.uk/voice/status (POST).
const crypto = require('crypto');
const express = require('express');

const MODEL = process.env.VOICE_MODEL || 'claude-opus-5-5';
const VOICE = process.env.VOICE_NAME || 'Polly.Amy-Neural';
const MAX_TURNS = 16;

const SYSTEM = [
  'You answer the phone for Residential Realtors, a London letting and estate agent at 28-30 Harper Road, London SE1 6AD, when nobody in the office is free to answer (it may be during office hours or after them). You are the phone assistant. Never say the office is closed; say nobody is available to take the call right now.',
  'Your job: take a message so the team can call back. Collect, one at a time and conversationally: the caller\'s full name; what the call is about (and the property address if it is about a property); the best phone number (the number they are calling from is given below, so just check whether that is the best one); and, last, offer email as an optional extra ("Would you like the team to email you the details too?") — only if they say yes, ask them to spell it, then read it back to confirm. If they say no, that is fine: carry on and finish.',
  '- Keep them on the line to the end: when asking for something, say briefly why it helps (for example "so the team can send you the property details", "so the right person can call you back ready to help"). Near the end, give a sense of progress ("Great, just two more quick questions", "Last one"). Keep these short and do not repeat the same phrase every time.',
  'What we do: lettings and property management, rental valuations, landlord certificates (Gas Safety, EICR, EPC), inventories, property licence applications, and repairs for the homes we manage.',
  '- Never bring up buying, selling or sales yourself (do not ask "are you looking to rent or buy?"). Only if the caller raises it, take their details as usual.',
  'Rules:',
  '- This is a phone call: keep every reply short (one or two sentences), warm and natural British English. No lists, no symbols, no emojis, no web addresses spelt with punctuation. Say "residential realtors dot co dot uk" if you need to give the website.',
  '- Never make up information: prices, availability, opening times, whether a property is available, or anything you are not told here. Say the team will confirm when they call back.',
  '- Do not promise a call-back time. Say the team will be in touch as soon as they can.',
  '- If the caller smells gas or suspects a gas leak: tell them to call the National Gas Emergency Service on 0800 111 999 straight away, open windows, and not use switches or flames. If anyone is in danger, tell them to call 999. Then take their details; mark it urgent.',
  '- Urgent repairs (major leak or flooding, no heating or hot water, no power, unable to secure the home, fire or carbon monoxide alarm sounding): mark urgent and reassure them the message goes to the person on call.',
  '- If they only want the office phone number or email: 0207 096 8131, info at residential realtors dot co dot uk.',
  '- If they want to view or rent a property: ask which property (the street or area is enough) and whether they receive Universal Credit or any other benefits towards the rent — ask it plainly, e.g. "And will you be receiving Universal Credit or any benefits towards the rent?" (the office asked). If not, ask briefly whether they are working, self-employed, a student or retired. Ask in a friendly, matter-of-fact way, never suggest it could count against them, and never turn anyone away or discourage them because they receive benefits (that is unlawful); it is only so the team can help with the right paperwork. Never ask how many people are moving in, adults or children, when they want to move in, or about a guarantor (the office asked — it wastes time on the call); fill adults, children, move_date and guarantor only if the caller says them. Fill income.',
  '- Names: the speech recognition often gets names wrong (for example Tariq comes through as Carrick), so never trust a name as heard and never say it aloud before it is spelt. As soon as they give their name, ask them to spell their first name and surname for you, letter by letter. Use exactly the letters they spell (a caller line may end with [spelt: ...] showing the letters joined up) and write the name in normal capitals (Tariq Ahmed). If what comes through is still unclear, ask once more for just that part. Do not ask to spell it again after that.',
  '- If the caller refuses to give some details, accept that and carry on.',
  '- When you have their name, what it is about, and at least one way to contact them (and you have read back the email if they gave one), thank them, say the team will be in touch, say goodbye, and set done to true.',
  '- If the caller says goodbye or wants to end the call, end politely and set done to true.',
  'Answer with JSON: "reply" (what to say next), "done" (true once the call should end) and "urgent". Nothing else — the details are taken from the conversation after the call.'
].join('\n');
// During the call Claude only writes the next line (a short answer = a short pause for the caller); the details
// (name, email, what it's about, …) are read from the whole conversation once, after the call (extract()).
const TURN = { type: 'object', additionalProperties: false, required: ['reply', 'done', 'urgent'],
  properties: { reply: { type: 'string', description: 'What to say to the caller next (spoken aloud).' }, done: { type: 'boolean' }, urgent: { type: 'boolean' } } };
const EXTRACT = 'Below is a phone call between Residential Realtors\' phone assistant and a caller (a London letting agent). Fill in the JSON with what the caller said — empty string for anything not said; never guess. Use the spelling the caller gave for names and emails (a caller line may end with [spelt: …]). "summary": one or two plain sentences for the team describing the call. "reply" and "done": leave "reply" empty and "done" true.';

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['reply', 'name', 'email', 'phone', 'about', 'address', 'category', 'adults', 'children', 'move_date', 'income', 'guarantor', 'urgent', 'done', 'summary'],
  properties: {
    reply: { type: 'string', description: 'What to say to the caller next (spoken aloud).' },
    name: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' },
    about: { type: 'string', description: 'What the call is about, briefly.' },
    address: { type: 'string', description: 'Property address if mentioned.' },
    adults: { type: 'string', description: 'Number of adults moving in, if a viewing or rental enquiry.' }, children: { type: 'string', description: 'Number of children moving in.' },
    move_date: { type: 'string', description: 'When they want to move in, as they said it (e.g. 1 November, ASAP).' },
    income: { type: 'string', description: 'How they will pay the rent, as they said it (e.g. employed, self-employed, Universal Credit, student).' }, guarantor: { type: 'string', description: 'Only if the caller mentions a UK guarantor themselves — never ask (empty otherwise).' },
    category: { type: 'string', enum: ['repair', 'letting', 'renting', 'buying', 'selling', 'valuation', 'certificate', 'other'] },
    urgent: { type: 'boolean' }, done: { type: 'boolean' }, summary: { type: 'string' }
  }
};

module.exports = function (app, opts) {
  let client = null;
  function claude() {
    if (client || !process.env.ANTHROPIC_API_KEY) return client;
    try { const A = require('@anthropic-ai/sdk'); client = new (A.default || A)({ timeout: 11000, maxRetries: 0 }); } catch (e) { console.error('Phone answering: Anthropic library missing', e.message); }
    return client;
  }
  const esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]; }); };
  const say = function (t) { return '<Say voice="' + VOICE + '" language="en-GB">' + esc(t) + '</Say>'; };
  const gather = function (t) { return '<Gather input="speech" language="en-GB" speechModel="phone_call" enhanced="true" speechTimeout="auto" timeout="7" actionOnEmptyResult="true" action="/voice/turn" method="POST">' + say(t) + '</Gather><Redirect method="POST">/voice/turn</Redirect>'; };
  const twiml = function (res, inner) { res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response>' + inner + '</Response>'); };
  // Letters spelt out ("T A R I Q", "T-A-R-I-Q", "t. a. r. i. q.") joined up, so the name is taken letter for letter.
  const spelt = function (t) {
    const m = String(t).match(/(?:^|[^A-Za-z])((?:[A-Za-z](?:[\s.,-]+|$)){3,})/g); if (!m) return '';
    const w = m.map(function (x) { return x.replace(/[^A-Za-z]/g, '').toUpperCase(); }).filter(function (x) { return x.length >= 3; });
    return w.length ? ' [spelt: ' + w.join(' ') + ']' : '';
  };
  const spoken = function (num) { const d = String(num || '').replace(/^\+44/, '0').replace(/\D/g, ''); return d ? d.split('').join(' ') : ''; };

  // Only Twilio may call these: its signature is an HMAC-SHA1 of the full URL plus the sorted form fields.
  function fromTwilio(req) {
    const token = process.env.TWILIO_AUTH_TOKEN, sig = String(req.headers['x-twilio-signature'] || ''); if (!token || !sig) return false;
    const params = req.body || {}, tail = Object.keys(params).sort().map(function (k) { return k + params[k]; }).join('');
    const urls = [(opts.siteUrl || '') + req.originalUrl, 'https://' + req.get('host') + req.originalUrl];
    return urls.some(function (u) { const exp = crypto.createHmac('sha1', token).update(u + tail).digest('base64'); return exp.length === sig.length && crypto.timingSafeEqual(Buffer.from(exp), Buffer.from(sig)); });
  }
  const form = express.urlencoded({ extended: false, limit: '64kb' });
  function guard(req, res, next) { if (!fromTwilio(req)) return res.status(403).send('Forbidden'); next(); }

  let ready = null;
  async function pool() {
    const p = await opts.db(); if (!p) return null;
    if (!ready) ready = p.query(`CREATE TABLE IF NOT EXISTS voice_calls (sid TEXT PRIMARY KEY, from_no TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      turns JSONB NOT NULL DEFAULT '[]'::jsonb, info JSONB NOT NULL DEFAULT '{}'::jsonb, silences INT NOT NULL DEFAULT 0, lead_id INT, ended_at TIMESTAMPTZ)`).catch(function (e) { ready = null; throw e; });
    await ready; return p;
  }
  const GREETING = 'Hello, you’ve reached Residential Realtors. I’m sorry, nobody is available to take your call right now. If it’s a property enquiry, I can take a few quick details now. It only takes a minute, and the right person will call you back ready to help. Can I take your name, please?';

  app.post('/voice/incoming', form, guard, async function (req, res) {
    const sid = String(req.body.CallSid || '').slice(0, 64), from = String(req.body.From || '').slice(0, 32);
    try { const p = await pool(); if (p && sid) await p.query("INSERT INTO voice_calls (sid, from_no, turns) VALUES ($1, $2, $3) ON CONFLICT (sid) DO NOTHING", [sid, from, JSON.stringify([{ role: 'assistant', text: GREETING }])]); } catch (e) { console.error('Phone answering:', e.message); }
    twiml(res, gather(GREETING));
  });

  // Claude's next line and what it knows so far. Null if it couldn't answer in time.
  async function think(call) {
    const c = claude(); if (!c) return null;
    const msgs = [], turns = call.turns || [];
    msgs.push({ role: 'user', content: '[Call started. Caller\'s number: ' + (call.from_no ? spoken(call.from_no) : 'withheld') + '.]' });
    turns.forEach(function (t) { const role = t.role === 'assistant' ? 'assistant' : 'user', last = msgs[msgs.length - 1];
      if (last.role === role) last.content += '\n' + t.text; else msgs.push({ role: role, content: t.text }); });
    if (msgs[msgs.length - 1].role !== 'user') msgs.push({ role: 'user', content: '[silence]' });
    try {
      const req = { model: MODEL, max_tokens: 600, output_config: { effort: 'low', format: { type: 'json_schema', schema: TURN } }, system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }], messages: msgs };
      // Haiku: thinking off, plain request (no server-side fallback). Other models keep the fallback and low effort —
      // Sonnet with thinking set to between_tools was tried and was slower on the line (8 s vs about 2 s), so it's back.
      const fast = /haiku/.test(MODEL) ? { type: 'disabled' } : null, t0 = Date.now();
      if (fast) req.thinking = fast;
      const r = fast ? await c.messages.create(req) : await c.beta.messages.create(Object.assign({ betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, req));
      console.log('Phone answering: reply in ' + (Date.now() - t0) + ' ms (' + (r.model || MODEL) + ', ' + ((r.usage && r.usage.output_tokens) || 0) + ' tokens out)');
      if (r.stop_reason === 'refusal') return null;
      const t = (r.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('');
      const o = JSON.parse(t); return o && typeof o.reply === 'string' ? o : null;
    } catch (e) { console.error('Phone answering: Claude', e.status || '', e.message); return null; }
  }
  // After the call: everything the caller told us, from the whole conversation (no hurry — the caller has gone).
  async function extract(call) {
    const c = claude(); if (!c) return null;
    const text = '[Caller\'s number: ' + (call.from_no ? spoken(call.from_no) : 'withheld') + ']\n' + (call.turns || []).map(function (t) { return (t.role === 'assistant' ? 'Assistant: ' : 'Caller: ') + t.text; }).join('\n');
    try {
      const req = { model: MODEL, max_tokens: 2000, output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } }, system: SYSTEM + '\n\n' + EXTRACT, messages: [{ role: 'user', content: text }] };
      const r = /haiku/.test(MODEL) ? await c.messages.create(req, { timeout: 30000 }) : await c.beta.messages.create(Object.assign({ betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, req), { timeout: 30000 });
      const t = (r.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('');
      return JSON.parse(t);
    } catch (e) { console.error('Phone answering: reading the call', e.status || '', e.message); return null; }
  }
  // If Claude can't be reached: ask for what's still missing, in order.
  function scripted(info, n) {
    if (!info.name && n < 3) return { reply: 'Sorry, could you tell me your name again?', done: false };
    if (!info.about && n < 6) return { reply: 'Thank you. And what is your call about?', done: false };
    return { reply: 'Thank you. I’ve passed your message to the team, and they’ll be in touch as soon as they can. Goodbye.', done: true };
  }

  app.post('/voice/turn', form, guard, async function (req, res) {
    const sid = String(req.body.CallSid || '').slice(0, 64), heard = String(req.body.SpeechResult || '').trim().slice(0, 1500);
    const p = await pool().catch(function () { return null; });
    let call = p && sid ? (await p.query('SELECT * FROM voice_calls WHERE sid = $1', [sid]).catch(function () { return { rows: [] }; })).rows[0] : null;
    if (!call) call = { sid: sid, from_no: String(req.body.From || ''), turns: [], info: {}, silences: 0 };
    if (heard) call.turns.push({ role: 'caller', text: heard + spelt(heard) }); else call.silences = (call.silences || 0) + 1;
    let out;
    if (!heard && call.silences >= 3) out = { reply: 'I can’t hear anything, so I’ll end the call now. Please call back or email info at residential realtors dot co dot uk. Goodbye.', done: true };
    else if (call.turns.filter(function (t) { return t.role === 'caller'; }).length >= MAX_TURNS) out = { reply: 'Thank you, I’ve got all that and I’ll pass it to the team. They’ll be in touch as soon as the office opens. Goodbye.', done: true };
    else if (!heard && call.silences === 1) out = { reply: 'Sorry, I didn’t catch that. Could you say it again?', done: false };
    else out = (await think(call)) || scripted(call.info || {}, call.turns.length);
    call.turns.push({ role: 'assistant', text: out.reply });
    const info = Object.assign({}, call.info || {}); ['name', 'email', 'phone', 'about', 'address', 'category', 'adults', 'children', 'move_date', 'income', 'guarantor', 'summary'].forEach(function (k) { if (out[k]) info[k] = String(out[k]).slice(0, 500); }); if (out.urgent) info.urgent = true;
    call.info = info;
    if (p && sid) await p.query('INSERT INTO voice_calls (sid, from_no, turns, info, silences) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (sid) DO UPDATE SET turns = $3, info = $4, silences = $5',
      [sid, call.from_no || '', JSON.stringify(call.turns), JSON.stringify(info), call.silences || 0]).catch(function (e) { console.error('Phone answering:', e.message); });
    if (out.done) { twiml(res, say(out.reply) + '<Hangup/>'); finish(sid).catch(function (e) { console.error('Phone answering: saving the call', e.message); }); }
    else twiml(res, gather(out.reply));
  });

  // The call ended (also when the caller just hangs up): save it as a lead, once.
  app.post('/voice/status', form, guard, function (req, res) {
    res.status(204).end();
    if (/completed|busy|failed|no-answer|canceled/.test(String(req.body.CallStatus || ''))) finish(String(req.body.CallSid || '').slice(0, 64)).catch(function (e) { console.error('Phone answering: saving the call', e.message); });
  });

  async function finish(sid) {
    const p = await pool(); if (!p || !sid) return;
    const call = (await p.query('UPDATE voice_calls SET ended_at = now() WHERE sid = $1 AND ended_at IS NULL RETURNING *', [sid])).rows[0]; if (!call) return;   // only once, even if the hang-up and the last turn arrive together
    const said = (call.turns || []).filter(function (t) { return t.role === 'caller'; });
    if (!said.length && !call.from_no) return;   // nothing said and no number: nothing to call back
    const info = Object.assign({}, call.info || {}), got = said.length ? await extract(call) : null;
    if (got) ['name', 'email', 'phone', 'about', 'address', 'category', 'adults', 'children', 'move_date', 'income', 'guarantor', 'summary'].forEach(function (k) { if (got[k]) info[k] = String(got[k]).slice(0, 500); });
    if (got && got.urgent) info.urgent = true;
    const phone = String(info.phone || '').replace(/[^\d+ ]/g, '').trim() || String(call.from_no || '').replace(/^\+44/, '0'), email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(info.email || '').replace(/\s+/g, '')) ? String(info.email).replace(/\s+/g, '').toLowerCase() : null;
    const name = String(info.name || '').trim() || 'Caller ' + (String(call.from_no || '').replace(/^\+44/, '0') || '(number withheld)');
    const data = { kind: 'call', message: info.summary || info.about || (said.length ? 'Caller said: ' + said.map(function (t) { return t.text; }).join(' / ').slice(0, 600) : 'Rang and didn’t leave a message.'),
      about: info.about || '', category: info.category || '', move: info.move_date || '', income: info.income || '', guarantor: info.guarantor || '', people: info.adults ? info.adults + ' adult' + (info.adults === '1' ? '' : 's') + (info.children && info.children !== '0' ? ', ' + info.children + ' child' + (info.children === '1' ? '' : 'ren') : ', no children') : '', urgent: !!info.urgent, caller_id: call.from_no || '', transcript: (call.turns || []).map(function (t) { return (t.role === 'assistant' ? 'Assistant: ' : 'Caller: ') + t.text; }).join('\n').slice(0, 8000) };
    const r = await p.query('INSERT INTO valuation_requests (name, email, phone, address, data) VALUES ($1, $2, $3, $4, $5) RETURNING id', [name.slice(0, 120), email, phone || null, (info.address || '(phone call)').slice(0, 300), JSON.stringify(data)]);
    await p.query('UPDATE voice_calls SET lead_id = $2 WHERE sid = $1', [sid, r.rows[0].id]);
    const title = (data.urgent ? '🚨 Urgent phone message: ' : '📞 Phone message: ') + name, line = (phone || email || 'no number') + ' — ' + data.message;
    const text = function (link) { return 'Someone rang the office when nobody was free to answer and left a message with the phone assistant.\n\nName: ' + name + '\nPhone: ' + (phone || '—') + '\nEmail: ' + (email || '—') + (info.address ? '\nProperty: ' + info.address : '') + (data.people ? '\nMoving in: ' + data.people : '') + (data.move ? '\nMove-in date: ' + data.move : '') + (data.income ? '\nRent paid by: ' + data.income : '') + (data.guarantor ? '\nUK guarantor: ' + data.guarantor : '') + (data.urgent ? '\nMarked URGENT' : '') + '\n\nWhat it’s about:\n' + data.message + '\n\nThe full conversation is in Website leads:\n' + link; };
    // Repairs go to the owner only (as with online repair reports); everything else to all staff. A call that
    // sounds like a repair counts as one even if the assistant filed it under another heading.
    const heard = [info.about, info.summary, data.message].concat(said.map(function (t) { return t.text; })).join(' ').toLowerCase();
    const repairish = /\b(repair|leak\w*|boiler|heating|hot water|no water|flood\w*|burst|damp|mou?ld|broken|blocked|toilet|drain|sink|shower|electric\w*|power cut|no power|fuse|socket|lights? (?:not|don)|lock(?:ed)? out|door won|window won|pest\w*|mice|rats?|cockroach\w*|bed ?bugs|gas smell|smell of gas|carbon monoxide|alarm going|fridge|oven|washing machine|dishwasher|ceiling|roof)\b/.test(heard);
    if (data.category === 'repair' || (repairish && ['letting', 'renting', 'buying', 'selling', 'valuation'].indexOf(data.category) === -1)) { opts.ntfy({ title: title, message: line, tags: [data.urgent ? 'rotating_light' : 'telephone_receiver'], priority: data.urgent ? 5 : 4 }); opts.ownerEmail(title, text, '#leads'); }
    else { opts.teamAlert({ title: title, message: line, tags: ['telephone_receiver'] }, '#leads'); opts.staffEmailAll(title, text, '#leads'); }
  }

  return { on: function () { return !!(process.env.TWILIO_AUTH_TOKEN && process.env.ANTHROPIC_API_KEY); } };
};
