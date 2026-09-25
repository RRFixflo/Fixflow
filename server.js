const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Read email settings from the environment, never hardcoded — set these in
// Railway under Settings -> Variables:
//   RESEND_API_KEY   (required)  the API key from your Resend account
//   REPORT_TO_EMAIL   (optional) defaults to jayk@residentialrealtors.co.uk
//   REPORT_FROM_EMAIL (optional) must be on a domain verified in Resend;
//                                 defaults to Resend's shared test sender,
//                                 which only works for quick testing.
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const REPORT_TO_EMAIL = process.env.REPORT_TO_EMAIL || 'jayk@residentialrealtors.co.uk';
const REPORT_FROM_EMAIL = process.env.REPORT_FROM_EMAIL || 'Repair Reports <onboarding@resend.dev>';

// AI tips / translation / urgency-opinion settings — set RESEND_API_KEY-style in
// Railway under Settings -> Variables:
//   ANTHROPIC_API_KEY (required)  your own key from console.anthropic.com
//   ANTHROPIC_MODEL   (optional)  defaults to a fast, inexpensive model
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

// Address lookup settings — set in Railway under Settings -> Variables:
//   GETADDRESS_API_KEY (required for address lookup) your key from getaddress.io.
// It is only ever used here on the server, never sent to the browser.
const GETADDRESS_API_KEY = process.env.GETADDRESS_API_KEY || '';

// This endpoint has no login of its own (same as the rest of the tool), so it is
// reachable by anyone with the link — and unlike email, every call here costs
// real money against your Anthropic key. A simple per-IP hourly cap keeps a bad
// actor (or a stuck retry loop) from running up a bill; it does not affect normal
// tenant use, which is at most a handful of AI calls per report.
app.set('trust proxy', true);
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX_PER_IP = 40;
const rateLimitMap = new Map();
// Address lookups get their own, looser buckets: autocomplete fires as the tenant
// types (free on getAddress, but rate limited by them), while resolving a picked
// address costs one look-up, so that one is kept tighter.
const addressSearchLimitMap = new Map();
const addressGetLimitMap = new Map();
function allowedByRateLimit(ip, map, max) {
  map = map || rateLimitMap;
  max = max || RATE_LIMIT_MAX_PER_IP;
  const now = Date.now();
  const entry = map.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    map.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= max) return false;
  entry.count += 1;
  return true;
}

// The PDF (plus a photo or two folded into it) can be a few MB once base64-encoded,
// so the default 100kb JSON body limit needs raising.
app.use(express.json({ limit: '25mb' }));

// Serve the report tool as a static file — Railway sets PORT itself, so we read it
// from the environment rather than hardcoding it.
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Simple existence check the frontend can use to confirm a real backend is present
// (there is no such endpoint when this same file runs as a claude.ai artifact).
app.get('/api/health', (req, res) => {
  res.json({ ok: true, canEmail: !!RESEND_API_KEY, canAi: !!ANTHROPIC_API_KEY, canAddress: !!GETADDRESS_API_KEY });
});

// Step 1 of getAddress.io Autocomplete: suggestions for what the tenant has typed
// so far (part of an address, or a postcode — all=true lists every address at a
// postcode). Proxied so the API key never reaches the browser.
app.get('/api/address/autocomplete', async (req, res) => {
  if (!GETADDRESS_API_KEY) {
    return res.status(503).json({ ok: false, error: 'address-not-configured' });
  }
  if (!allowedByRateLimit(req.ip, addressSearchLimitMap, 300)) {
    return res.status(429).json({ ok: false, error: 'rate-limited' });
  }
  const term = String(req.query.term || '').trim().slice(0, 100);
  if (term.length < 3) {
    return res.json({ ok: true, suggestions: [] });
  }
  try {
    const url = 'https://api.getAddress.io/autocomplete/' + encodeURIComponent(term) +
      '?api-key=' + encodeURIComponent(GETADDRESS_API_KEY) + '&all=true&top=6';
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) {
      console.error('getAddress autocomplete error:', resp.status);
      return res.status(502).json({ ok: false, error: resp.status === 429 ? 'rate-limited' : 'lookup-failed' });
    }
    const data = await resp.json();
    const suggestions = (data.suggestions || []).map(function (s) {
      return { address: String(s.address || ''), id: String(s.id || '') };
    }).filter(function (s) { return s.address && s.id; });
    return res.json({ ok: true, suggestions: suggestions });
  } catch (err) {
    console.error('address autocomplete error:', err && err.message);
    return res.status(502).json({ ok: false, error: 'lookup-failed' });
  }
});

// Step 2: resolve the suggestion the tenant picked into the full address,
// including its postcode (counts as one look-up on the getAddress account).
app.get('/api/address/get/:id', async (req, res) => {
  if (!GETADDRESS_API_KEY) {
    return res.status(503).json({ ok: false, error: 'address-not-configured' });
  }
  if (!allowedByRateLimit(req.ip, addressGetLimitMap, 60)) {
    return res.status(429).json({ ok: false, error: 'rate-limited' });
  }
  const id = String(req.params.id || '');
  if (!/^[A-Za-z0-9_=-]{1,200}$/.test(id)) {
    return res.status(400).json({ ok: false, error: 'bad-id' });
  }
  try {
    const url = 'https://api.getAddress.io/get/' + encodeURIComponent(id) +
      '?api-key=' + encodeURIComponent(GETADDRESS_API_KEY);
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) {
      console.error('getAddress get error:', resp.status);
      return res.status(502).json({ ok: false, error: resp.status === 429 ? 'rate-limited' : 'lookup-failed' });
    }
    const a = await resp.json();
    const lines = [a.line_1, a.line_2, a.line_3, a.line_4, a.locality, a.town_or_city]
      .map(function (l) { return String(l || '').trim(); })
      .filter(Boolean);
    const postcode = String(a.postcode || '').trim();
    return res.json({
      ok: true,
      address: {
        lines: lines,
        town: String(a.town_or_city || ''),
        county: String(a.county || ''),
        postcode: postcode,
        full: lines.concat(postcode ? [postcode] : []).join(', ')
      }
    });
  } catch (err) {
    console.error('address get error:', err && err.message);
    return res.status(502).json({ ok: false, error: 'lookup-failed' });
  }
});

app.post('/api/ai', async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(503).json({ ok: false, error: 'ai-not-configured' });
  }
  if (!allowedByRateLimit(req.ip)) {
    return res.status(429).json({ ok: false, error: 'rate-limited' });
  }

  try {
    const body = req.body || {};
    // Translating the page sends every visible string in one prompt, so this cap
    // has to comfortably fit that; anything bigger is refused rather than cut
    // off part-way (a truncated prompt gives a broken answer, not a shorter one).
    const prompt = String(body.prompt || '');
    const wantJson = !!body.json;
    if (!prompt) {
      return res.status(400).json({ ok: false, error: 'missing-prompt' });
    }
    if (prompt.length > 40000) {
      return res.status(413).json({ ok: false, error: 'prompt-too-long' });
    }

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        // JSON replies are whole-page translations, which run far longer than a
        // few tips; 600 tokens cut them off mid-array and they failed to parse.
        max_tokens: wantJson ? 8000 : 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(function () { return ''; });
      console.error('Anthropic API error:', resp.status, errText.slice(0, 300));
      return res.status(502).json({ ok: false, error: 'anthropic-error' });
    }

    const data = await resp.json();
    const text = String((data.content && data.content[0] && data.content[0].text) || '').trim();

    if (wantJson) {
      const cleaned = text.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
      try {
        const parsed = JSON.parse(cleaned);
        return res.json({ ok: true, json: parsed });
      } catch (e) {
        return res.status(502).json({ ok: false, error: 'bad-json-from-model' });
      }
    }

    return res.json({ ok: true, text: text });
  } catch (err) {
    console.error('ai endpoint error:', err);
    return res.status(500).json({ ok: false, error: 'server-error' });
  }
});

app.post('/api/send-report', async (req, res) => {
  if (!RESEND_API_KEY) {
    // Server is up but nobody has added the Resend API key yet in Railway's
    // environment variables. Tell the frontend plainly so it can fall back.
    return res.status(503).json({ ok: false, error: 'email-not-configured' });
  }

  try {
    const body = req.body || {};
    const pdfBase64 = String(body.pdfBase64 || '');
    const filename = String(body.filename || 'Repair-Report.pdf').replace(/[^a-zA-Z0-9.\-_]+/g, '-');
    const subject = String(body.subject || 'Repair report');
    const reportText = String(body.reportText || '');
    const tenantEmail = String(body.tenantEmail || '').trim();
    const sendCopyToTenant = !!body.sendCopyToTenant && !!tenantEmail;

    if (!pdfBase64) {
      return res.status(400).json({ ok: false, error: 'missing-pdf' });
    }

    // 1) Email the report to Residential Realtors, PDF genuinely attached.
    const mainResult = await sendViaResend({
      to: [REPORT_TO_EMAIL],
      subject: subject,
      text: reportText,
      attachmentFilename: filename,
      attachmentBase64: pdfBase64
    });

    if (!mainResult.ok) {
      return res.status(502).json({ ok: false, error: 'resend-failed', detail: mainResult.error });
    }

    // 2) Optionally send the tenant their own copy too, best-effort — a failure
    // here should not make the tool report failure, since the landlord copy
    // (the important one) already went through.
    let tenantCopySent = false;
    if (sendCopyToTenant) {
      const tenantResult = await sendViaResend({
        to: [tenantEmail],
        subject: 'Your repair report — Residential Realtors',
        text: 'This is a copy of the repair report you submitted, for your own records.\n\n' + reportText,
        attachmentFilename: filename,
        attachmentBase64: pdfBase64
      });
      tenantCopySent = !!tenantResult.ok;
    }

    return res.json({ ok: true, tenantCopySent: tenantCopySent });
  } catch (err) {
    console.error('send-report error:', err);
    return res.status(500).json({ ok: false, error: 'server-error' });
  }
});

async function sendViaResend(opts) {
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: REPORT_FROM_EMAIL,
        to: opts.to,
        subject: opts.subject,
        text: opts.text,
        attachments: [
          { filename: opts.attachmentFilename, content: opts.attachmentBase64 }
        ]
      })
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(function () { return ''; });
      return { ok: false, error: 'HTTP ' + resp.status + ' ' + errText.slice(0, 300) };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

app.listen(PORT, () => {
  console.log(`Report tool running on port ${PORT}`);
});
