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
// Delegated permissions: offline_access, User.Read, Mail.ReadWrite.
//
// Each person connects their own mailbox once; the sign-in is kept (encrypted)
// in the database so drafts can be made without signing in again.
const crypto = require('crypto');

const CLIENT_ID = process.env.MS_CLIENT_ID || '';
const TENANT = process.env.MS_TENANT_ID || 'organizations';
const SECRET = process.env.MS_CLIENT_SECRET || '';
const SCOPES = 'offline_access User.Read Mail.ReadWrite';
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

  app.get('/api/admin/outlook', withDb(async function (p, req, res) {
    const list = await accounts(p);
    res.json({ ok: true, configured: configured(), redirect: redirectUri(req),
      accounts: Object.keys(list).map(function (k) { return { email: k, name: list[k].name || '' }; }) });
  }));
  // Start signing in with Microsoft (a normal page visit from the admin page).
  app.get('/api/admin/outlook/connect', function (req, res) {
    if (!configured()) return res.redirect('/admin#outlook=not-set-up');
    const state = crypto.randomBytes(24).toString('hex');
    pending.set(state, Date.now() + 10 * 60 * 1000);
    const q = new URLSearchParams({ client_id: CLIENT_ID, response_type: 'code', redirect_uri: redirectUri(req), response_mode: 'query', scope: SCOPES, state: state, prompt: 'select_account' });
    res.redirect(AUTH + '/authorize?' + q.toString());
  });
  // Microsoft sends the person back here. The session cookie isn't sent on this
  // cross-site return, so the one-time state from /connect is what proves it.
  app.get('/ms/callback', async function (req, res) {
    const state = String(req.query.state || ''), exp = pending.get(state);
    pending.delete(state);
    if (!exp || exp < Date.now()) return res.redirect('/admin#outlook=expired');
    if (req.query.error || !req.query.code) return res.redirect('/admin#outlook=cancelled');
    try {
      const p = await db();
      if (!p) return res.redirect('/admin#outlook=failed');
      const t = await tokenRequest({ grant_type: 'authorization_code', code: String(req.query.code), redirect_uri: redirectUri(req) });
      const me = await (await fetch(GRAPH + '/me?$select=mail,userPrincipalName,displayName', { headers: { Authorization: 'Bearer ' + t.access_token } })).json();
      const email = String(me.mail || me.userPrincipalName || '').toLowerCase();
      if (!email || !t.refresh_token) return res.redirect('/admin#outlook=failed');
      const list = await accounts(p);
      list[email] = { name: me.displayName || '', rt: seal(t.refresh_token), at: new Date().toISOString() };
      await saveAccounts(p, list);
      res.redirect('/admin#outlook=connected');
    } catch (err) {
      console.error('Outlook sign-in failed:', err.message);
      res.redirect('/admin#outlook=failed');
    }
  });
  app.delete('/api/admin/outlook/:email', withDb(async function (p, req, res) {
    const list = await accounts(p), k = String(req.params.email || '').toLowerCase();
    delete list[k];
    await saveAccounts(p, list);
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
      attachments: atts
    };
    const r = await fetch(GRAPH + '/me/messages', { method: 'POST', headers: { Authorization: 'Bearer ' + t.access_token, 'Content-Type': 'application/json' }, body: JSON.stringify(msg), signal: AbortSignal.timeout(30000) });
    const d = await r.json().catch(function () { return {}; });
    if (!r.ok) { console.error('Outlook draft failed:', r.status, d.error && d.error.message); return res.status(502).json({ ok: false, error: 'draft-failed' }); }
    res.json({ ok: true, from: from, webLink: d.webLink || null });
  }));
};
module.exports.configured = configured;
