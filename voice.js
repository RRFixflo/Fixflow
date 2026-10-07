// Out-of-hours phone answering. The office line forwards to a Twilio number after hours; Twilio calls these
// webhooks. Claude talks to the caller like a receptionist (Twilio turns speech into text and reads Claude's
// replies aloud), takes their name, email, best number and what it's about, and the call becomes a Website
// lead ("Out-of-hours call") with the team alerted. Repairs alert the owner only, like online repair reports.
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
  'You answer the phone for Residential Realtors, a London letting and estate agent at 28-30 Harper Road, London SE1 6AD, outside office hours. The office is closed; you are the out-of-hours assistant.',
  'Your job: take a message so the team can call back. Collect, one at a time and conversationally: the caller\'s full name; what the call is about (and the property address if it is about a property); the best phone number (the number they are calling from is given below, so just check whether that is the best one); and their email address (ask them to spell it, then read it back to confirm).',
  'What we do: lettings and property management, sales, rental and sales valuations, landlord certificates (Gas Safety, EICR, EPC), inventories, property licence applications, and repairs for the homes we manage.',
  'Rules:',
  '- This is a phone call: keep every reply short (one or two sentences), warm and natural British English. No lists, no symbols, no emojis, no web addresses spelt with punctuation. Say "residential realtors dot co dot uk" if you need to give the website.',
  '- Never make up information: prices, availability, opening times, whether a property is available, or anything you are not told here. Say the team will confirm when they call back.',
  '- Do not promise a call-back time. Say the team will be in touch as soon as the office opens.',
  '- If the caller smells gas or suspects a gas leak: tell them to call the National Gas Emergency Service on 0800 111 999 straight away, open windows, and not use switches or flames. If anyone is in danger, tell them to call 999. Then take their details; mark it urgent.',
  '- Urgent repairs (major leak or flooding, no heating or hot water, no power, unable to secure the home, fire or carbon monoxide alarm sounding): mark urgent and reassure them the message goes to the person on call.',
  '- If they only want the office phone number or email: 0207 096 8131, info at residential realtors dot co dot uk.',
  '- If the caller refuses to give some details, accept that and carry on.',
  '- When you have their name, what it is about, and at least one way to contact them (and you have read back the email if they gave one), thank them, say the team will be in touch, say goodbye, and set done to true.',
  '- If the caller says goodbye or wants to end the call, end politely and set done to true.',
  'Always fill the JSON fields with everything you know so far (empty string if unknown). "summary" is one or two plain sentences for the team describing the call.'
].join('\n');

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['reply', 'name', 'email', 'phone', 'about', 'address', 'category', 'urgent', 'done', 'summary'],
  properties: {
    reply: { type: 'string', description: 'What to say to the caller next (spoken aloud).' },
    name: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' },
    about: { type: 'string', description: 'What the call is about, briefly.' },
    address: { type: 'string', description: 'Property address if mentioned.' },
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
  const GREETING = 'Hello, you’ve reached Residential Realtors. The office is closed at the moment, but I can take a message so the team can get back to you. Can I take your name, please?';

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
      const r = await c.beta.messages.create({ model: MODEL, max_tokens: 2000, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
        output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } }, system: SYSTEM, messages: msgs });
      if (r.stop_reason === 'refusal') return null;
      const t = (r.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('');
      const o = JSON.parse(t); return o && typeof o.reply === 'string' ? o : null;
    } catch (e) { console.error('Phone answering: Claude', e.status || '', e.message); return null; }
  }
  // If Claude can't be reached: ask for what's still missing, in order.
  function scripted(info, n) {
    if (!info.name && n < 3) return { reply: 'Sorry, could you tell me your name again?', done: false };
    if (!info.about && n < 6) return { reply: 'Thank you. And what is your call about?', done: false };
    return { reply: 'Thank you. I’ve passed your message to the team, and they’ll be in touch as soon as the office opens. Goodbye.', done: true };
  }

  app.post('/voice/turn', form, guard, async function (req, res) {
    const sid = String(req.body.CallSid || '').slice(0, 64), heard = String(req.body.SpeechResult || '').trim().slice(0, 1500);
    const p = await pool().catch(function () { return null; });
    let call = p && sid ? (await p.query('SELECT * FROM voice_calls WHERE sid = $1', [sid]).catch(function () { return { rows: [] }; })).rows[0] : null;
    if (!call) call = { sid: sid, from_no: String(req.body.From || ''), turns: [], info: {}, silences: 0 };
    if (heard) call.turns.push({ role: 'caller', text: heard }); else call.silences = (call.silences || 0) + 1;
    let out;
    if (!heard && call.silences >= 3) out = { reply: 'I can’t hear anything, so I’ll end the call now. Please call back or email info at residential realtors dot co dot uk. Goodbye.', done: true };
    else if (call.turns.filter(function (t) { return t.role === 'caller'; }).length >= MAX_TURNS) out = { reply: 'Thank you, I’ve got all that and I’ll pass it to the team. They’ll be in touch as soon as the office opens. Goodbye.', done: true };
    else if (!heard && call.silences === 1) out = { reply: 'Sorry, I didn’t catch that. Could you say it again?', done: false };
    else out = (await think(call)) || scripted(call.info || {}, call.turns.length);
    call.turns.push({ role: 'assistant', text: out.reply });
    const info = Object.assign({}, call.info || {}); ['name', 'email', 'phone', 'about', 'address', 'category', 'summary'].forEach(function (k) { if (out[k]) info[k] = String(out[k]).slice(0, 500); }); if (out.urgent) info.urgent = true;
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
    const info = call.info || {}, said = (call.turns || []).filter(function (t) { return t.role === 'caller'; });
    if (!said.length && !call.from_no) return;   // nothing said and no number: nothing to call back
    const phone = String(info.phone || '').replace(/[^\d+ ]/g, '').trim() || String(call.from_no || '').replace(/^\+44/, '0'), email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(info.email || '').replace(/\s+/g, '')) ? String(info.email).replace(/\s+/g, '').toLowerCase() : null;
    const name = String(info.name || '').trim() || 'Caller ' + (String(call.from_no || '').replace(/^\+44/, '0') || '(number withheld)');
    const data = { kind: 'call', message: info.summary || info.about || (said.length ? 'Caller said: ' + said.map(function (t) { return t.text; }).join(' / ').slice(0, 600) : 'Rang and didn’t leave a message.'),
      about: info.about || '', category: info.category || '', urgent: !!info.urgent, caller_id: call.from_no || '', transcript: (call.turns || []).map(function (t) { return (t.role === 'assistant' ? 'Assistant: ' : 'Caller: ') + t.text; }).join('\n').slice(0, 8000) };
    const r = await p.query('INSERT INTO valuation_requests (name, email, phone, address, data) VALUES ($1, $2, $3, $4, $5) RETURNING id', [name.slice(0, 120), email, phone || null, (info.address || '(out-of-hours call)').slice(0, 300), JSON.stringify(data)]);
    await p.query('UPDATE voice_calls SET lead_id = $2 WHERE sid = $1', [sid, r.rows[0].id]);
    const title = (data.urgent ? '🚨 Urgent out-of-hours call: ' : '📞 Out-of-hours call: ') + name, line = (phone || email || 'no number') + ' — ' + data.message;
    const text = function (link) { return 'Someone rang the office out of hours and left a message with the phone assistant.\n\nName: ' + name + '\nPhone: ' + (phone || '—') + '\nEmail: ' + (email || '—') + (info.address ? '\nProperty: ' + info.address : '') + (data.urgent ? '\nMarked URGENT' : '') + '\n\nWhat it’s about:\n' + data.message + '\n\nThe full conversation is in Website leads:\n' + link; };
    // Repairs go to the owner only (as with online repair reports); everything else to all staff.
    if (data.category === 'repair') { opts.ntfy({ title: title, message: line, tags: [data.urgent ? 'rotating_light' : 'telephone_receiver'], priority: data.urgent ? 5 : 4 }); opts.ownerEmail(title, text, '#leads'); }
    else { opts.teamAlert({ title: title, message: line, tags: ['telephone_receiver'] }, '#leads'); opts.staffEmailAll(title, text, '#leads'); }
  }

  return { on: function () { return !!(process.env.TWILIO_AUTH_TOKEN && process.env.ANTHROPIC_API_KEY); } };
};
