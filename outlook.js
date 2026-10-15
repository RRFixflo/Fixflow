'use strict';
// Outlook (Microsoft 365): put emails straight into a staff member's Outlook
// Drafts folder, formatted and with attachments, ready to send from Outlook.
//
// Needs an app registration in Microsoft Entra ID (Azure) and these Railway
// variables:
//   MS_CLIENT_ID      Application (client) ID
//   MS_TENANT_ID      Directory (tenant) ID
//   MS_CLIENT_SECRET  a client secret's Value
// Redirect URI to register (type Web): <site>/ms/callback
// Delegated permissions: offline_access, User.Read, Mail.ReadWrite, Mail.Send.
// Once the office mailbox (OFFICE_MAILBOX, default info@) is connected, every email Fixflow sends goes
// through it (Microsoft Graph sendMail, kept in its Sent Items); Resend is only used if that fails.
//
// Each person connects their own mailbox once; the sign-in is kept (encrypted)
// in the database so drafts can be made without signing in again.
const crypto = require('crypto');

const CLIENT_ID = process.env.MS_CLIENT_ID || '';
const TENANT = process.env.MS_TENANT_ID || 'organizations';
const SECRET = process.env.MS_CLIENT_SECRET || '';
const SCOPES = 'offline_access User.Read Mail.ReadWrite Mail.Send';
// The office mailbox Fixflow sends all its emails from once it's connected (Resend stays as the backup).
const OFFICE = String(process.env.OFFICE_MAILBOX || 'info@residentialrealtors.co.uk').toLowerCase();
const AUTH = 'https://login.microsoftonline.com/' + encodeURIComponent(TENANT) + '/oauth2/v2.0';
const GRAPH = 'https://graph.microsoft.com/v1.0';

function configured() { return !!(CLIENT_ID && SECRET); }
const KEY = crypto.createHash('sha256').update('fixflow-outlook:' + SECRET).digest();
function seal(text) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const out = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), out]).toString('base64');
}
function unseal(b64) {
  try {
    const buf = Buffer.from(String(b64), 'base64'), d = crypto.createDecipheriv('aes-256-gcm', KEY, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
  } catch (e) { return null; }
}

module.exports = function (app, o) {
  const db = o.db, withDb = o.withDb, str = o.str;
  const redirectUri = function (req) { return (o.publicUrl || (req.protocol + '://' + req.get('host'))).replace(/\/+$/, '') + '/ms/callback'; };
  const pending = new Map();   // sign-in state -> expiry (one use, 10 minutes)

  async function accounts(p) {
    const row = (await p.query("SELECT value FROM app_settings WHERE key = 'outlook_accounts'")).rows[0];
    return row && row.value && typeof row.value === 'object' ? row.value : {};
  }
  async function saveAccounts(p, list) {
    await p.query(`INSERT INTO app_settings (key, value) VALUES ('outlook_accounts', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`, [JSON.stringify(list)]);
  }
  async function tokenRequest(params) {
    const body = new URLSearchParams(Object.assign({ client_id: CLIENT_ID, client_secret: SECRET, scope: SCOPES }, params));
    const r = await fetch(AUTH + '/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(), signal: AbortSignal.timeout(15000) });
    const d = await r.json().catch(function () { return {}; });
    if (!r.ok || !d.access_token) throw new Error((d.error || 'token') + (d.error_description ? ': ' + String(d.error_description).split('\n')[0] : ''));
    return d;
  }

  // Who is signed in to Fixflow: a staff login ('u<id>') or the owner's password ('owner').
  const whoOf = function (req) { return req.user && req.user.id ? 'u' + req.user.id : 'owner'; };
  const manager = function (req) { return !!(req.user && /^(owner|admin|offers_admin)$/.test(req.user.role)); };
  function mineOf(list, who) {
    return Object.keys(list).filter(function (k) { return k !== OFFICE && list[k].uid === who; }).sort(function (a, b) { return String(list[b].at || '').localeCompare(String(list[a].at || '')); })[0] || '';
  }
  app.get('/api/admin/outlook', withDb(async function (p, req, res) {
    const list = await accounts(p), all = manager(req);
    res.json({ ok: true, configured: configured(), redirect: redirectUri(req), office: OFFICE, sending: !!(configured() && list[OFFICE]), send_state: all ? sendState : undefined,
      mine: mineOf(list, whoOf(req)),
      // Staff see only their own mailbox; managers see every connected one.
      accounts: Object.keys(list).filter(function (k) { return all || list[k].uid === whoOf(req); }).map(function (k) { return { email: k, name: list[k].name || '' }; }) });
  }));
  // Start signing in with Microsoft (a normal page visit from the admin page).
  app.get('/api/admin/outlook/connect', function (req, res) {
    if (!configured()) return res.redirect('/admin#outlook=not-set-up');
    const state = crypto.randomBytes(24).toString('hex');
    pending.set(state, { exp: Date.now() + 10 * 60 * 1000, who: whoOf(req), back: req.role === 'offers' ? '/staff' : '/admin' });
    const q = new URLSearchParams({ client_id: CLIENT_ID, response_type: 'code', redirect_uri: redirectUri(req), response_mode: 'query', scope: SCOPES, state: state, prompt: 'select_account' });
    res.redirect(AUTH + '/authorize?' + q.toString());
  });
  // Microsoft sends the person back here. The session cookie isn't sent on this
  // cross-site return, so the one-time state from /connect is what proves it.
  app.get('/ms/callback', async function (req, res) {
    const state = String(req.query.state || ''), st = pending.get(state), back = (st && st.back) || '/admin';
    pending.delete(state);
    if (!st || st.exp < Date.now()) return res.redirect(back + '#outlook=expired');
    if (req.query.error || !req.query.code) return res.redirect(back + '#outlook=cancelled');
    try {
      const p = await db();
      if (!p) return res.redirect(back + '#outlook=failed');
      const t = await tokenRequest({ grant_type: 'authorization_code', code: String(req.query.code), redirect_uri: redirectUri(req) });
      const me = await (await fetch(GRAPH + '/me?$select=mail,userPrincipalName,displayName', { headers: { Authorization: 'Bearer ' + t.access_token } })).json();
      const email = String(me.mail || me.userPrincipalName || '').toLowerCase();
      if (!email || !t.refresh_token) return res.redirect(back + '#outlook=failed');
      const list = await accounts(p);
      // Remember whose mailbox it is, so what that person sends from Fixflow goes from it (the office one is shared).
      list[email] = { name: me.displayName || '', rt: seal(t.refresh_token), at: new Date().toISOString(), uid: email === OFFICE ? (list[email] && list[email].uid) || '' : st.who };
      await saveAccounts(p, list);
      delete toks[email];
      if (email === OFFICE) { sendState.error = ''; sendState.alerted = ''; }
      res.redirect(back + '#outlook=' + (email === OFFICE ? 'connected' : 'mine'));
    } catch (err) {
      console.error('Outlook sign-in failed:', err.message);
      res.redirect(back + '#outlook=failed');
    }
  });
  app.delete('/api/admin/outlook/:email', withDb(async function (p, req, res) {
    const list = await accounts(p), k = String(req.params.email || '').toLowerCase();
    if (list[k] && !manager(req) && list[k].uid !== whoOf(req)) return res.status(403).json({ ok: false, error: 'not-yours' });
    delete list[k];
    await saveAccounts(p, list);
    delete toks[k];
    res.json({ ok: true });
  }));
  // Make a draft in that person's Outlook: HTML body, recipients, attachments.
  app.post('/api/admin/outlook/draft', withDb(async function (p, req, res) {
    if (!configured()) return res.status(503).json({ ok: false, error: 'not-set-up' });
    const b = req.body || {}, list = await accounts(p);
    const from = String(b.from || '').toLowerCase() || Object.keys(list)[0];
    const acc = from && list[from];
    if (!acc) return res.status(400).json({ ok: false, error: 'not-connected' });
    const to = (Array.isArray(b.to) ? b.to : []).map(function (x) { return str(x, 200); }).filter(function (x) { return x && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x); }).slice(0, 20);
    const atts = (Array.isArray(b.attachments) ? b.attachments : []).slice(0, 8).map(function (a) {
      const name = str(a && a.name, 150) || 'Document.pdf';
      const att = { '@odata.type': '#microsoft.graph.fileAttachment', name: name, contentType: /\.pdf$/i.test(name) ? 'application/pdf' : /\.png$/i.test(name) ? 'image/png' : 'application/octet-stream', contentBytes: String(a && a.data || '').replace(/^data:[^,]*,/, '') };
      // The logo in the signature goes in as a picture inside the email (cid:…).
      if (a && a.inline && /^[\w.-]{1,40}$/.test(String(a.cid || ''))) { att.isInline = true; att.contentId = String(a.cid); }
      return att;
    }).filter(function (a) { return a.contentBytes; });
    if (atts.reduce(function (n, a) { return n + a.contentBytes.length; }, 0) > 3.4 * 1024 * 1024) return res.status(413).json({ ok: false, error: 'too-large' });
    const rt = unseal(acc.rt);
    if (!rt) return res.status(401).json({ ok: false, error: 'reconnect' });
    let t;
    try { t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: rt }); }
    catch (err) { console.error('Outlook token refresh failed for ' + from + ':', err.message); return res.status(401).json({ ok: false, error: 'reconnect' }); }
    if (t.refresh_token && t.refresh_token !== rt) { list[from].rt = seal(t.refresh_token); await saveAccounts(p, list); }
    const msg = {
      subject: str(b.subject, 300) || '',
      body: { contentType: 'HTML', content: typeof b.html === 'string' ? b.html.replace(/<script[\s\S]*?<\/script>/gi, '').slice(0, 500000) : '' },
      toRecipients: to.map(function (x) { return { emailAddress: { address: x } }; }),
      ccRecipients: (Array.isArray(b.cc) ? b.cc : []).map(function (x) { return str(x, 200); }).filter(function (x) { return x && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x); }).slice(0, 10).map(function (x) { return { emailAddress: { address: x } }; }),
      attachments: atts
    };
    const r = await fetch(GRAPH + '/me/messages', { method: 'POST', headers: { Authorization: 'Bearer ' + t.access_token, 'Content-Type': 'application/json' }, body: JSON.stringify(msg), signal: AbortSignal.timeout(30000) });
    const d = await r.json().catch(function () { return {}; });
    if (!r.ok) { console.error('Outlook draft failed:', r.status, d.error && d.error.message); return res.status(502).json({ ok: false, error: 'draft-failed' }); }
    res.json({ ok: true, from: from, webLink: d.webLink || null });
  }));

  // ---- Sending every Fixflow email from the office mailbox ----
  const toks = {};   // mailbox -> { token, exp }
  const sendState = { ok_at: null, error: '', error_at: null, alerted: '' };
  async function tokenFor(email) {
    const c = toks[email]; if (c && c.exp > Date.now() + 120000) return c.token;
    const p = await db(); if (!p) throw new Error('no-db');
    const list = await accounts(p), acc = list[email]; if (!acc) throw new Error('not-connected');
    const rt = unseal(acc.rt); if (!rt) throw new Error('reconnect');
    const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: rt });
    if (t.refresh_token && t.refresh_token !== rt) { list[email].rt = seal(t.refresh_token); await saveAccounts(p, list); }
    toks[email] = { token: t.access_token, exp: Date.now() + (Number(t.expires_in) || 3600) * 1000 };
    return toks[email].token;
  }
  // The mailbox to send from: the signed-in person's own (who = 'u<id>' / 'owner') when they've connected one, else info@.
  async function mailboxFor(who) {
    if (!who) return OFFICE;
    const p = await db(); if (!p) return OFFICE;
    return mineOf(await accounts(p), who) || OFFICE;
  }
  const addrs = function (v) { return [].concat(v || []).map(function (x) { return String(x || '').trim(); }).filter(function (x) { return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(x); }).map(function (x) { return { emailAddress: { address: x } }; }); };
  function mimeOf(name) { const e = (String(name).split('.').pop() || '').toLowerCase(); return { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv', txt: 'text/plain', ics: 'text/calendar' }[e] || 'application/octet-stream'; }
  // Same message shape as Resend's ({ to, cc, bcc, replyTo, subject, text, html, attachments: [{ filename, content }] }).
  // Returns { ok } — anything not ok (not connected, over ~3 MB of attachments, Microsoft refused) is sent by Resend instead.
  async function send(m, who) {
    if (!configured()) return { ok: false, error: 'not-set-up', skip: true };
    const box = await mailboxFor(who).catch(function () { return OFFICE; }), own = box !== OFFICE;
    const atts = (m.attachments && m.attachments.length ? m.attachments : m.attachmentBase64 ? [{ filename: m.attachmentFilename, content: m.attachmentBase64 }] : [])
      .map(function (a) { const c = Buffer.isBuffer(a.content) ? a.content.toString('base64') : String(a.content || '').replace(/^data:[^,]*,/, ''); return { '@odata.type': '#microsoft.graph.fileAttachment', name: String(a.filename || 'file').slice(0, 150), contentType: a.contentType || mimeOf(a.filename), contentBytes: c }; })
      .filter(function (a) { return a.contentBytes; });
    if (atts.reduce(function (n, a) { return n + a.contentBytes.length; }, 0) > 3 * 1024 * 1024) return { ok: false, error: 'too-large', skip: true };
    let token;
    try { token = await tokenFor(box); }
    catch (err) {
      // A person's own mailbox not working: send from info@ instead (and tell them in Sent emails, not the owner's phone).
      if (own) { console.error('Outlook: ' + box + ' couldn’t send (' + err.message + ') — sending from ' + OFFICE); return send(m, null); }
      if (err.message === 'not-connected') return { ok: false, error: 'not-connected', skip: true }; return fail('sign-in: ' + err.message);
    }
    // From a person's own mailbox, replies come back to them, not to info@.
    const replyTo = own ? [].concat(m.replyTo || []).filter(function (x) { return String(x).toLowerCase() !== OFFICE; }) : m.replyTo;
    const msg = { subject: String(m.subject || ''), body: m.html ? { contentType: 'HTML', content: String(m.html) } : { contentType: 'Text', content: String(m.text || '') },
      toRecipients: addrs(m.to), ccRecipients: addrs(m.cc), bccRecipients: addrs(m.bcc), replyTo: addrs(replyTo), attachments: atts };
    try {
      const r = await fetch(GRAPH + '/me/sendMail', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: msg, saveToSentItems: true }), signal: AbortSignal.timeout(30000) });
      if (r.status === 202 || r.ok) { if (!own) { sendState.ok_at = new Date().toISOString(); sendState.error = ''; } return { ok: true, via: 'outlook', from: box }; }
      const d = await r.json().catch(function () { return {}; });
      if (r.status === 401) delete toks[box];
      if (own) { console.error('Outlook: ' + box + ' refused (HTTP ' + r.status + ') — sending from ' + OFFICE); return send(m, null); }
      return fail('HTTP ' + r.status + ' ' + ((d.error && d.error.message) || '').slice(0, 200));
    } catch (err) { if (own) return send(m, null); return fail(err.message); }
  }
  // A problem with the office mailbox: noted for the Email usage box, and the owner's phone told once a day.
  function fail(why) {
    sendState.error = String(why).slice(0, 300); sendState.error_at = new Date().toISOString();
    console.error('Outlook sending failed (Resend used instead): ' + sendState.error);
    const day = new Date().toISOString().slice(0, 10);
    if (sendState.alerted !== day && o.alert) { sendState.alerted = day; o.alert({ title: '⚠️ Outlook sending stopped', message: 'Fixflow couldn’t send through ' + OFFICE + ' (' + sendState.error.slice(0, 80) + ') so it’s using Resend. If it keeps happening, reconnect Outlook in Fixflow (Tenancies → Settings) — the app secret may have expired.', priority: 4, tags: ['warning'] }); }
    return { ok: false, error: sendState.error };
  }
  async function connected() { const p = await db(); if (!p || !configured()) return false; return !!(await accounts(p))[OFFICE]; }
  return { send: send, office: OFFICE, state: sendState, connected: connected };
};
module.exports.configured = configured;
