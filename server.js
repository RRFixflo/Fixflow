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
  res.json({ ok: true, canEmail: !!RESEND_API_KEY });
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
