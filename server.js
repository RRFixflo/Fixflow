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

// AI tips / translation / urgency-opinion settings — set in Railway under
// Settings -> Variables. Set ONE of these keys; if both are set, Gemini is used.
//   GEMINI_API_KEY    free key from aistudio.google.com (free tier, no card)
//   GEMINI_MODEL      (optional) defaults to Google's current Flash model
//   ANTHROPIC_API_KEY paid key from console.anthropic.com
//   ANTHROPIC_MODEL   (optional) defaults to a fast, inexpensive model
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
// Free-tier Gemini models are often briefly "experiencing high demand" (503) or
// rate limited (429), so each request walks this list until one answers. Names
// Google doesn't recognise (404) are simply skipped. The Lite models come first:
// the full Flash model took up to 52s for a few short tips in live use, while
// Lite answers in a few seconds and is plenty for this. GEMINI_MODEL, if set, is
// tried first.
const GEMINI_MODELS = (process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL] : []).concat([
  'gemini-flash-lite-latest',
  'gemini-2.5-flash-lite',
  'gemini-flash-latest',
  'gemini-2.5-flash'
]).filter(function (m, i, all) { return all.indexOf(m) === i; });
// How long one model gets before we give up on it and try the next. Translations
// (JSON) return far more text than tips, so they get longer.
const GEMINI_TIMEOUT_MS = { text: 12000, json: 30000 };

// The same issue always produces the same prompt (and the same page produces the
// same translation prompt), so answers are remembered: repeat views are instant
// and don't use up the free allowance. Oldest entries are dropped past the cap.
const AI_CACHE_MAX = 300;
const aiCache = new Map();
function aiCacheGet(key) { return aiCache.get(key); }
function aiCacheSet(key, value) {
  aiCache.set(key, value);
  if (aiCache.size > AI_CACHE_MAX) aiCache.delete(aiCache.keys().next().value);
}
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

// Staff dashboard for managing jobs (see jobs.js); its API needs ADMIN_PASSWORD.
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

const jobs = require('./jobs')(app, {
  sendEmail: function (opts) { return sendViaResend(opts); },
  canEmail: function () { return !!RESEND_API_KEY; }
});

// Simple existence check the frontend can use to confirm a real backend is present
// (there is no such endpoint when this same file runs as a claude.ai artifact).
app.get('/api/health', (req, res) => {
  res.json({ ok: true, canEmail: !!RESEND_API_KEY, canAi: !!(GEMINI_API_KEY || ANTHROPIC_API_KEY), canAddress: !!GETADDRESS_API_KEY });
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

// JSON replies are whole-page translations, which run far longer than a few tips;
// a 600-token cap cut them off mid-array and they failed to parse.
function maxOutputTokens(wantJson) { return wantJson ? 8000 : 1000; }

async function askAnthropic(prompt, wantJson) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: maxOutputTokens(wantJson),
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(function () { return ''; });
    console.error('Anthropic API error:', resp.status, errText.slice(0, 300));
    return { ok: false };
  }
  const data = await resp.json();
  return { ok: true, text: String((data.content && data.content[0] && data.content[0].text) || '').trim() };
}

async function askGemini(prompt, wantJson) {
  // Overall budget across all models, so the tenant is never left waiting long;
  // the page gives up a little after this too.
  const deadline = Date.now() + (wantJson ? 60000 : 25000);
  for (const model of GEMINI_MODELS) {
    if (Date.now() > deadline) break;
    const result = await askGeminiModel(model, prompt, wantJson);
    if (result.ok || !result.retryable) return result;
  }
  return { ok: false };
}

async function askGeminiModel(model, prompt, wantJson) {
  const started = Date.now();
  let resp;
  try {
    resp = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent(model) + ':generateContent', {
      method: 'POST',
      signal: AbortSignal.timeout(wantJson ? GEMINI_TIMEOUT_MS.json : GEMINI_TIMEOUT_MS.text),
      headers: {
        'x-goog-api-key': GEMINI_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: Object.assign(
          // Flash models may spend part of this on thinking, so leave headroom.
          { maxOutputTokens: maxOutputTokens(wantJson) * 2 },
          wantJson ? { responseMimeType: 'application/json' } : {}
        )
      })
    });
  } catch (err) {
    // Timed out (or the connection dropped): the next model may be quicker.
    console.error('Gemini request failed:', model, (err && err.name) || err, 'after', Date.now() - started, 'ms');
    return { ok: false, retryable: true };
  }
  if (!resp.ok) {
    const errText = await resp.text().catch(function () { return ''; });
    console.error('Gemini API error:', model, resp.status, errText.replace(/\s+/g, ' ').slice(0, 200));
    // Busy, rate limited, briefly down or unknown model: try the next model.
    // Anything else (e.g. a rejected key) would fail the same way on every model.
    const retryable = [404, 429, 500, 503].indexOf(resp.status) !== -1;
    return { ok: false, retryable: retryable };
  }
  const data = await resp.json();
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content &&
    data.candidates[0].content.parts) || [];
  const text = parts
    .filter(function (p) { return p && typeof p.text === 'string' && !p.thought; })
    .map(function (p) { return p.text; })
    .join('')
    .trim();
  if (!text) {
    console.error('Gemini returned no text:', model, JSON.stringify(data).slice(0, 300));
    return { ok: false, retryable: true };
  }
  console.log('Gemini ok:', model, Date.now() - started, 'ms');
  return { ok: true, text: text };
}

app.post('/api/ai', async (req, res) => {
  if (!GEMINI_API_KEY && !ANTHROPIC_API_KEY) {
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

    const cacheKey = (wantJson ? 'json:' : 'text:') + prompt;
    let text = aiCacheGet(cacheKey);
    if (text === undefined) {
      const result = GEMINI_API_KEY
        ? await askGemini(prompt, wantJson)
        : await askAnthropic(prompt, wantJson);
      if (!result.ok) {
        return res.status(502).json({ ok: false, error: 'ai-provider-error' });
      }
      text = result.text;
    }

    if (wantJson) {
      const cleaned = text.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
      try {
        const parsed = JSON.parse(cleaned);
        aiCacheSet(cacheKey, text);
        return res.json({ ok: true, json: parsed });
      } catch (e) {
        return res.status(502).json({ ok: false, error: 'bad-json-from-model' });
      }
    }

    aiCacheSet(cacheKey, text);
    return res.json({ ok: true, text: text });
  } catch (err) {
    console.error('ai endpoint error:', err);
    return res.status(500).json({ ok: false, error: 'server-error' });
  }
});

app.post('/api/send-report', async (req, res) => {
  try {
    const body = req.body || {};
    const pdfBase64 = String(body.pdfBase64 || '');
    const filename = String(body.filename || 'Repair-Report.pdf').replace(/[^a-zA-Z0-9.\-_]+/g, '-');
    const reportText = String(body.reportText || '');
    const tenantEmail = String(body.tenantEmail || '').trim();
    const sendCopyToTenant = !!body.sendCopyToTenant && !!tenantEmail;

    if (!pdfBase64) {
      return res.status(400).json({ ok: false, error: 'missing-pdf' });
    }

    // 1) Save it as a job in the database (when one is connected). This is the
    // record the admin dashboard works from, so it comes first.
    let saved = null;
    try {
      saved = await jobs.saveReport(body.report, pdfBase64, filename, reportText);
    } catch (err) {
      console.error('Saving report to database failed:', err.message);
    }

    const subject = String(body.subject || 'Repair report') + (saved ? ' [' + saved.ref + ']' : '');

    // 2) Email it to Residential Realtors, PDF attached, when email is set up.
    let emailed = false;
    if (RESEND_API_KEY) {
      const mainResult = await sendViaResend({
        to: [REPORT_TO_EMAIL],
        subject: subject,
        text: (saved ? 'Job reference: ' + saved.ref + '\n\n' : '') + reportText,
        attachmentFilename: filename,
        attachmentBase64: pdfBase64
      });
      emailed = !!mainResult.ok;
      if (!mainResult.ok) console.error('Report email failed:', mainResult.error);
    }

    // Neither saved nor emailed: tell the page, which falls back to the tenant
    // emailing the PDF themselves.
    if (!saved && !emailed) {
      return res.status(503).json({ ok: false, error: RESEND_API_KEY ? 'resend-failed' : 'email-not-configured' });
    }

    // 3) Optionally send the tenant their own copy too, best-effort — a failure
    // here should not make the tool report failure, since the report itself
    // (the important part) already went through.
    let tenantCopySent = false;
    if (sendCopyToTenant && RESEND_API_KEY) {
      const tenantResult = await sendViaResend({
        to: [tenantEmail],
        subject: 'Your repair report — Residential Realtors' + (saved ? ' [' + saved.ref + ']' : ''),
        text: 'This is a copy of the repair report you submitted, for your own records.' +
          (saved ? ' Your reference is ' + saved.ref + '.' : '') + '\n\n' + reportText,
        attachmentFilename: filename,
        attachmentBase64: pdfBase64
      });
      tenantCopySent = !!tenantResult.ok;
    }

    return res.json({ ok: true, emailed: emailed, saved: !!saved, ref: saved ? saved.ref : null, tenantCopySent: tenantCopySent });
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
        attachments: opts.attachmentBase64
          ? [{ filename: opts.attachmentFilename, content: opts.attachmentBase64 }]
          : undefined
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
