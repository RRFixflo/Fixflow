'use strict';
// Tenancies: the welcome email templates, and filling in the tenancy agreement
// (a Word .docx uploaded by staff) with a tenancy's details.
//
// Bank details and staff signatures are not written here (this code is public):
// they come from Railway variables, and can be edited in the admin page, where
// they are saved in the database.
//   TENANCY_BANK_DETAILS        the bank account block for move-in monies
//   TENANCY_SIGNATURE_TENANT    signature under the tenants' welcome email
//   TENANCY_SIGNATURE_LANDLORD  signature under the landlord's welcome email
const zlib = require('zlib');

const DISCLAIMER = 'This e-mail message may contain confidential or legally privileged information and is intended only for the use of the intended recipient(s). Any unauthorised disclosure, dissemination, distribution, copying or the taking of any action in reliance on the information herein is prohibited. E-mails are not secure and cannot be guaranteed to be error free as they can be intercepted, amended, or contain viruses. Anyone who communicates with us by e-mail is deemed to have accepted these risks. Residential Realtors is not responsible for errors or omissions in this message and denies any responsibility for any damage arising from the use of e-mail. Any opinion and other statement contained in this message and any attachment are solely those of the author and do not necessarily represent those of the company. ©{{year}} Estallion Investments';

const TENANT_BODY = `Dear Tenants,

RE: Preparing for your new home: {{address}}

I am pleased to provide you with a copy of your tenancy agreement via Adobe E-sign. Please read the document carefully, it sets out the length of your tenancy, who is holding your deposit, and the terms and conditions of your let, including the Special Terms and Conditions at Schedule 1. Your tenancy agreement also outlines the account details for your rent payments. Please ensure a standing order is set up with your bank to pay your rent at least 3 days before your rent due date. If you have any queries relating to this document, please contact us immediately. Please also check for any misspelt names or addresses and let us know straight away so we can correct these.

Move-in monies
As set out in Schedule 1 of your tenancy agreement, full move-in monies must be paid by bank transfer within 48 hours of this email (by {{move_in_due}}), as agreed at the time of your reservation. Vacant possession of the property will not be given and keys will not be released until these funds have cleared in our account in full. If payment is not received within this 48-hour window, we reserve the right to withdraw the offer of tenancy and re-market the property.

When paying by bank transfer, please check with your bank how long the transfer will take to clear, as international transfers can take longer than expected. Once paid, please email proof of transfer (e.g. a receipt confirmation PDF or screenshot) so we can confirm receipt efficiently.

Standing order
You will also need to set up a standing order starting {{standing_order_start}}, for a minimum of {{standing_order_payments}} payments. This must be set up from a single account, covering the full rent amount, rent cannot be paid individually by each tenant. As set out in Schedule 1, this standing order must be set up within 3 working days of signing your tenancy agreement, and you must send us written confirmation (a screenshot or reference confirmation) that this has been done. Keys will not be released until this is confirmed.

Break Down of Move in Monies
First Month’s Rent: {{first_rent}}
Five Week Deposit: {{deposit}}
Total Excluding Reservation Fee: {{move_in_total}}

I can confirm that we have received {{holding_deposit}} as your reservation fee as such the remaining balance of {{move_in_remaining}} must be paid within 48 hours of this email.

Bank Account Details
{{bank_details}}
Reference: {{address}}

If you are a Southwark Student Resident, please apply for your council tax exemption using the link: https://coa.myforms.southwark.gov.uk/CoaPlus/launch

Please register with the relevant local authority for council tax purposes within 14 days of your tenancy commencement date, and register for all applicable utilities (gas, electricity, and water) in your name immediately upon moving in. The local authority, not the landlord or agent, is responsible for assessing and billing your council tax liability. Once billed, it is your responsibility to apply directly to the local authority for any exemption, discount, or reduction you may be entitled to (for example, single person discount or student exemption). We take no responsibility for any issues, delays, disruption, charges, or backdated liability relating to utility accounts, supply, or council tax, any such matters should be raised directly with the relevant provider or local authority.

I can confirm an inventory/check-in has been booked for {{checkin_date}} at {{checkin_time}}. Upon your arrival the Inventory Clerk would have prepared a report on the condition of the property and an inventory check list at the time of handing over the keys, this report will be email out to you within 7 days of your move in, you will then given a further 7 days to check the inventory and suggest any ammendments if needs be. At the time of your move in keys will be handed over to you upon arrival by the clerk, please arrive a minimum of 15 minutes before your check-in time as the clerk would have strict time frames to adhere. Unfortunately due tight scheduling the inventory clerk is unable to wait for late comers. Should a check-in need to be rebooked a cost of £80.00 + VAT booking fee will be charged.

Your Inventory Clerk Details:
Company: MC INVENTORY
Email: info@mcinventories.com
Number: 02034394840

Where no formal inventory has been commissioned for your property, you may submit your own record of the property's condition using our DIY check-in platform:
https://diy-check-in-production-6024.up.railway.app/
Your submission, including photographs and written notes, must be completed within 7 days of your tenancy commencement date. We will review it and confirm in writing within 7 days if any part of it is disputed. If we do not raise a dispute within that period, your submission will stand as the agreed record of the property's condition for deposit purposes.

Cleaning
We offer two options regarding the cleaning of the property:

Option 1 – Property as-is: No professional clean is arranged before your move-in, and the property is taken in its current condition. In return, no professional clean is required from you at the end of your tenancy, saving you the cost.
Option 2 – Professional clean arranged: We arrange a professional clean before you move in. In this case, as set out in your tenancy agreement, you will be expected to arrange a professional clean of the property to an equivalent standard when you vacate, and you may be asked to provide evidence of this (e.g. an invoice).

Please note that on occasion, a property may not be cleaned to the standard we expect on the day you move in. We ask for your understanding here, as there are times we may need to arrange the clean on your actual move-in day rather than before it. If this would be a problem for you, please let us know now so we can address it in advance.
Similarly, properties can occasionally have issues we were not previously aware of. If you notice anything on moving in, please report it to us straight away so we can resolve it swiftly. Again, if this arrangement would be a problem for you, please raise it with us now.

Please let us know which cleaning option you'd prefer.

We wish you the best of luck in your new home and should you have any other queries please contact me to discuss.

Regards,

{{signature}}

` + DISCLAIMER;

const LANDLORD_BODY = `Dear {{landlord_name}}

RE: {{address}}

I am pleased to advise you that we have provided you with the following items by email as part of your welcome pack:

* Signed Tenancy Agreement
* Landlord Statement
* Tenants ID (Right to rent for non UK citizen)
* Deposit Protection Certificate
* Tenant Contact Sheet

As part of our service to you we have provided your tenants with a standing order and requested that they ensure that the mandate has been set up by their bank at least 14 days prior to the standing order becoming due.

Please note that if you are an overseas landlord you will be required to fill in and return a HMRC form to the HMRC in order to obtain an approval certificate for the tenants to pay the full rent to you. This will also apply if you are out of the UK for over six months of the year. If you do not request such from the HMRC the tenant will be required to deduct tax and to forward it to the Inland Revenue quarterly. http://www.hmrc.gov.uk/cnr/nr_landlords.htm#10 for full details please check the HMRC website.

PS: If you have been pleased with the service you have been provided from Residential Realtors please write me a short review on our Google review site, this will not only encourage me to continue to provide the service I am but help me progress further in my company to achieve my ambitions. Any feedback short or long would be appreciated deeply. https://www.google.co.uk/webhp?sourceid=chrome-instant&ion=1&espv=2&ie=UTF-8#q=residential%20realtors or simply type Residential Realtors into Google and hit the review button.

Thank you for choosing Residential Realtors as your agent.

Regards,

{{signature}}`;

function envText(name) { return String(process.env[name] || '').replace(/\\n/g, '\n').trim(); }

function defaultTemplates() {
  return {
    // Quick-add fees charged to landlords (editable in the admin page).
    fee_presets: [{ label: 'Inventory - Check In', amount: 195 }, { label: 'EICR Certificate', amount: 120 }, { label: 'Gas Safety Certificate', amount: 60 },
      { label: 'EPC', amount: 70 }, { label: 'Deposit Registration', amount: 145 }, { label: 'Referencing', amount: null }, { label: 'Professional Clean', amount: null }],
    tenant_subject: 'Preparing for your new home: {{address}}',
    tenant_body: TENANT_BODY,
    landlord_subject: 'Welcome pack: {{address}}',
    landlord_body: LANDLORD_BODY,
    bank_details: envText('TENANCY_BANK_DETAILS'),
    signature_tenant: envText('TENANCY_SIGNATURE_TENANT') || 'Residential Realtors\n28-30 Harper Road, London, SE1 6AD\nwww.residentialrealtors.co.uk',
    signature_landlord: envText('TENANCY_SIGNATURE_LANDLORD') || envText('TENANCY_SIGNATURE_TENANT') || 'Residential Realtors\n28-30 Harper Road, London, SE1 6AD\nwww.residentialrealtors.co.uk'
  };
}

// ---------- A small .docx (zip) reader and writer ----------
const CRC_TABLE = (function () {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; }

function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) { if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) throw new Error('not-a-zip');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const files = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('bad-zip');
    const method = buf.readUInt16LE(off + 10), size = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28), extraLen = buf.readUInt16LE(off + 30), commentLen = buf.readUInt16LE(off + 32);
    const local = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.slice(start, start + size);
    files.push({ name: name, data: method === 8 ? zlib.inflateRawSync(raw) : raw });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function zip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  files.forEach(function (f) {
    const name = Buffer.from(f.name, 'utf8'), data = zlib.deflateRawSync(f.data), crc = crc32(f.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(0, 10); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(0, 12); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, data); centrals.push(ch, name);
    offset += 30 + name.length + data.length;
  });
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat(locals.concat([cd, end]));
}

function xmlEscape(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// Swap {{placeholders}} in the Word document's text. Word often splits a
// placeholder over several runs ("{{ten" + "ant_names}}"), so the tags in
// between are dropped along with it; line breaks become Word line breaks.
// Placeholders it doesn't know are left in, so they're easy to spot.
function fillXml(xml, values) {
  return xml.replace(/\{(?:<[^>]*>)*\{((?:<[^>]*>|[^{}<])*?)\}(?:<[^>]*>)*\}/g, function (m, inner) {
    const key = inner.replace(/<[^>]*>/g, '').trim().toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(values, key)) return m;
    return xmlEscape(values[key] == null ? '' : values[key]).split('\n').join('</w:t><w:br/><w:t xml:space="preserve">');
  });
}

function fillDocx(buf, values) {
  const files = unzip(buf);
  files.forEach(function (f) {
    if (/^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(f.name)) f.data = Buffer.from(fillXml(f.data.toString('utf8'), values), 'utf8');
  });
  return zip(files);
}

// ---------- Filling in the tenancy agreement ----------
// Works with the agency's own template as it is: the bracketed blanks
// ([LEAD TENANT], [TENANT 2], [£RENT], PROPERTY ADDRESS …) are filled in, and
// the signature boxes follow the number of tenants and guarantors: spare ones
// are taken out, and extra ones added when there are more people than boxes.
// {{placeholders}} work too. v: { address, landlord, start, rent, deposit,
// deposit_scheme, first_rent, rent_day, second_rent, second_rent_month,
// agreement_date, tenants: [names], guarantors: [names], values: {…} }
function decodeXml(s) { return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'); }
function joinNames(list) { list = list.filter(Boolean); return list.length <= 1 ? (list[0] || '') : list.slice(0, -1).join(', ') + ' & ' + list[list.length - 1]; }

// Top-level pieces of the document body (paragraphs, tables …).
function bodyParts(xml) {
  const open = xml.indexOf('<w:body>') + 8, close = xml.lastIndexOf('</w:body>');
  const body = xml.slice(open, close), parts = [];
  const re = /<(\/?)(w:p|w:tbl|w:sdt|w:sectPr|w:bookmarkStart|w:bookmarkEnd)\b[^>]*?(\/?)>/g;
  let depth = 0, name = null, start = 0, m, last = 0;
  while ((m = re.exec(body))) {
    const closing = m[1] === '/', tag = m[2], selfClose = m[3] === '/';
    if (depth === 0) {
      if (closing) continue;
      if (m.index > last) parts.push(body.slice(last, m.index));
      if (selfClose) { parts.push(body.slice(m.index, re.lastIndex)); last = re.lastIndex; continue; }
      name = tag; start = m.index; depth = 1; continue;
    }
    if (tag !== name) continue;
    if (closing) { depth -= 1; if (depth === 0) { parts.push(body.slice(start, re.lastIndex)); last = re.lastIndex; } }
    else if (!selfClose) depth += 1;
  }
  if (last < body.length) parts.push(body.slice(last));
  return { head: xml.slice(0, open), tail: xml.slice(close), parts: parts };
}
function plain(x) { return decodeXml((x.match(/<w:t(?: [^>]*)?>[^<]*<\/w:t>/g) || []).map(function (t) { return t.replace(/<[^>]+>/g, ''); }).join('')); }
function isBlank(x) { return /^<w:p\b/.test(x) && !plain(x).trim() && !/<w:drawing|<w:pict|<w:sectPr|w:type="page"/.test(x); }

function signatureBoxes(parts, who, count) {
  const re = who === 'tenant' ? /^\s*Name:\s*\[(LEAD TENANT|TENANT (\d+))\]\s*Signature:\s*Date:\s*$/ : /^\s*Name:\s*\[GUARANTOR (\d+)\]\s*Signature:\s*Date:\s*$/;
  const boxes = [];
  parts.forEach(function (x, i) {
    if (!/^<w:tbl\b/.test(x)) return;
    const m = re.exec(plain(x));
    if (m) boxes.push({ i: i, n: who === 'tenant' ? (m[2] ? parseInt(m[2], 10) : 1) : parseInt(m[1], 10) });
  });
  if (!boxes.length) return parts;
  boxes.sort(function (a, b) { return a.n - b.n; });
  const drop = new Set(), after = {};
  boxes.forEach(function (b) {
    if (b.n <= count) return;
    drop.add(b.i);
    for (let j = b.i - 1; j >= 0 && isBlank(parts[j]); j--) drop.add(j);
  });
  if (count > boxes[boxes.length - 1].n) {
    const lastBox = boxes[boxes.length - 1], extra = [];
    for (let k = lastBox.n + 1; k <= count; k++) {
      extra.push('<w:p/>', replaceText(parts[lastBox.i], [[who === 'tenant' ? /\[(?:LEAD TENANT|TENANT \d+)\]/ : /\[GUARANTOR \d+\]/, who === 'tenant' ? '[TENANT ' + k + ']' : '[GUARANTOR ' + k + ']']]));
    }
    after[lastBox.i] = extra;
  }
  // With no guarantors, the guarantor signing heading goes too.
  if (who === 'guarantor' && count === 0) {
    parts.forEach(function (x, i) { if (/^<w:p\b/.test(x) && /^\s*SIGNED BY THE GUARANTOR/i.test(plain(x))) drop.add(i); });
  }
  const out = [];
  parts.forEach(function (x, i) { if (!drop.has(i)) out.push(x); if (after[i]) out.push.apply(out, after[i]); });
  return out;
}
// Keep a paragraph with the one after it (so a heading or table row never
// ends a page on its own). keepNext goes right after pStyle in <w:pPr>.
function keepWithNext(p) {
  if (/<w:keepNext\/>/.test(p)) return p;
  if (/<w:pPr>/.test(p) || /<w:pPr\s[^>]*>/.test(p)) {
    if (/<w:pStyle\b[^>]*\/>/.test(p)) return p.replace(/(<w:pStyle\b[^>]*\/>)/, '$1<w:keepNext/>');
    return p.replace(/(<w:pPr(?:\s[^>]*)?>)/, '$1<w:keepNext/>');
  }
  if (/<w:pPr\/>/.test(p)) return p.replace('<w:pPr/>', '<w:pPr><w:keepNext/></w:pPr>');
  return p.replace(/^(<w:p\b[^>]*>)/, '$1<w:pPr><w:keepNext/></w:pPr>');
}
// A signature box (Name / Signature / Date) stays on one page: rows can't
// split, and every row but the last keeps with the next.
function keepBoxTogether(tbl) {
  const rows = tbl.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) || [];
  let out = tbl;
  rows.forEach(function (row, i) {
    let r = row;
    if (!/<w:cantSplit\/>/.test(r)) r = /<w:trPr>/.test(r) ? r.replace('<w:trPr>', '<w:trPr><w:cantSplit/>') : /<w:trPr\/>/.test(r) ? r.replace('<w:trPr/>', '<w:trPr><w:cantSplit/></w:trPr>') : r.replace(/^(<w:tr\b[^>]*>)/, '$1<w:trPr><w:cantSplit/></w:trPr>');
    if (i < rows.length - 1) r = r.replace(/<w:p\b(?![rP])[^>]*?(?:\/>|>[\s\S]*?<\/w:p>)/g, function (p) { return /\/>$/.test(p) && !/<\/w:p>$/.test(p) ? p : keepWithNext(p); });
    out = out.replace(row, r);
  });
  return out;
}
function keepSignaturesTogether(parts) {
  return parts.map(function (x, i) {
    if (/^<w:tbl\b/.test(x) && /^\s*Name:[\s\S]*Signature:[\s\S]*Date:\s*$/.test(plain(x))) return keepBoxTogether(x);
    // "SIGNED BY THE …:" headings (and blank lines under them) stay with their box.
    if (/^<w:p\b/.test(x) && /^\s*SIGNED BY THE/i.test(plain(x))) return keepWithNext(x);
    if (isBlank(x) && i > 0 && /^\s*SIGNED BY THE/i.test(plain(parts[i - 1]))) return keepWithNext(x);
    return x;
  });
}
// The front page's "Guarantors (3) …" box, when there are none.
function dropFrontGuarantors(parts) {
  const out = parts.slice();
  for (let i = 0; i < out.length; i++) {
    if (/^<w:tbl\b/.test(out[i]) && /^\s*\(3\)\s*\[GUARANTOR 1\]/.test(plain(out[i]))) {
      let j = i - 1;
      while (j >= 0 && (isBlank(out[j]) || /^\s*Guarantors?\s*$/i.test(plain(out[j])))) { if (/^\s*Guarantors?\s*$/i.test(plain(out[j]))) { out.splice(j, 1); i--; break; } j--; }
      out.splice(i, 1);
      break;
    }
  }
  return out;
}

// Replace text across the runs of each paragraph (Word splits words over runs).
function replaceText(xml, rules) {
  const re = /(<w:t(?: [^>]*)?>)([^<]*)(<\/w:t>)|<\/w:p>/g;
  const nodes = []; let m, group = [];
  const groups = [group];
  while ((m = re.exec(xml))) {
    if (!m[1]) { group = []; groups.push(group); continue; }
    const node = { s: m.index, e: re.lastIndex, open: m[1], text: decodeXml(m[2]), changed: false };
    nodes.push(node); group.push(node);
  }
  groups.forEach(function (g) {
    if (!g.length) return;
    rules.forEach(function (rule) {
      let full = g.map(function (n) { return n.text; }).join('');
      if (!rule[0].test(full)) return;
      rule[0].lastIndex = 0;
      const hits = []; let h;
      const rx = new RegExp(rule[0].source, rule[0].flags.indexOf('g') === -1 ? rule[0].flags + 'g' : rule[0].flags);
      while ((h = rx.exec(full))) { hits.push({ s: h.index, e: h.index + h[0].length, v: typeof rule[1] === 'function' ? rule[1].apply(null, h) : rule[1] }); if (!h[0].length) rx.lastIndex++; }
      for (let k = hits.length - 1; k >= 0; k--) {
        const hit = hits[k]; let pos = 0, first = -1, lastN = -1, firstOff = 0, lastOff = 0;
        for (let i = 0; i < g.length; i++) {
          const len = g[i].text.length;
          if (first === -1 && hit.s < pos + len + (i === g.length - 1 ? 1 : 0) && hit.s >= pos) { first = i; firstOff = hit.s - pos; }
          if (hit.e <= pos + len && hit.e >= pos && first !== -1) { lastN = i; lastOff = hit.e - pos; break; }
          pos += len;
        }
        if (first === -1 || lastN === -1) continue;
        if (first === lastN) {
          g[first].text = g[first].text.slice(0, firstOff) + hit.v + g[first].text.slice(lastOff);
        } else {
          g[first].text = g[first].text.slice(0, firstOff) + hit.v;
          for (let i = first + 1; i < lastN; i++) g[i].text = '';
          g[lastN].text = g[lastN].text.slice(lastOff);
        }
        for (let i = first; i <= lastN; i++) g[i].changed = true;
      }
    });
  });
  let out = '', at = 0;
  nodes.forEach(function (n) {
    if (!n.changed) return;
    const open = /xml:space=/.test(n.open) ? n.open : n.open.replace('<w:t', '<w:t xml:space="preserve"');
    out += xml.slice(at, n.s) + open + xmlEscape(n.text).split('\n').join('</w:t><w:br/>' + open) + '</w:t>';
    at = n.e;
  });
  return out + xml.slice(at);
}

function agreementRules(v) {
  const t = (v.tenants || []).filter(Boolean), g = (v.guarantors || []).filter(Boolean), vals = v.values || {};
  return [
    [/\[LEAD TENANT\](?:\s*(?:,|&|and)\s*\[TENANT \d+\])+/g, joinNames(t)],
    [/\[GUARANTOR 1\](?:\s*(?:,|&|and)\s*\[GUARANTOR \d+\])+/g, joinNames(g) || 'None'],
    [/\[LEAD TENANT\]/g, t[0] || ''],
    [/\[TENANT (\d+)\]/g, function (m, n) { return t[parseInt(n, 10) - 1] || ''; }],
    [/\[GUARANTOR (\d+)\]/g, function (m, n) { return g[parseInt(n, 10) - 1] || ''; }],
    [/\[RENT DAY\](?:th|st|nd|rd)? \[SECOND RENT\] \d{4}/g, v.second_rent || ''],
    [/\[RENT DAY\](?:th|st|nd|rd)?/g, v.rent_day || ''],
    [/\[SECOND RENT\]/g, v.second_rent_month || ''],
    [/\[£ ?RENT\]/g, v.rent || ''],
    [/\[FIRST RENT DATE\]/g, v.first_rent || ''],
    [/\[DEPOSIT\]/g, v.deposit || ''],
    [/\[Deposit Scheme\]/gi, v.deposit_scheme || ''],
    [/\[PROPERTY ?ADDRESS\]/g, v.address || ''],
    [/PROPERTY ADDRESS/g, v.address || ''],
    [/TENANCY START DATE/g, v.start || ''],
    [/LANDLORD NAME/g, v.landlord || ''],
    [/(THIS AGREEMENT IS MADE on the )\d{1,2}(?:st|nd|rd|th)? [A-Z][a-z]+ \d{4}/g, function (m, a) { return a + (v.agreement_date || ''); }],
    [/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, function (m, k) { k = k.toLowerCase(); return Object.prototype.hasOwnProperty.call(vals, k) ? String(vals[k]) : m; }]
  ];
}

// Date fields (e.g. SAVEDATE) would be recalculated when opened; keep their
// text and drop the field so the date written in stays.
function unfieldDates(xml) {
  const R = function (type) { return '<w:r\\b[^>]*>(?:(?!</w:r>).)*?<w:fldChar w:fldCharType="' + type + '"/>(?:(?!</w:r>).)*?</w:r>'; };
  const re = new RegExp(R('begin') + '((?:(?!w:fldCharType=).)*?)' + R('separate') + '((?:(?!w:fldCharType=).)*?)' + R('end'), 'gs');
  return xml.replace(re, function (m, instr, result) {
    return /\b(SAVEDATE|CREATEDATE|PRINTDATE|DATE|TIME)\b/.test(instr.replace(/<[^>]+>/g, '')) ? result : m;
  });
}

function fillAgreement(buf, v) {
  const files = unzip(buf), rules = agreementRules(v);
  const nt = (v.tenants || []).filter(Boolean).length, ng = (v.guarantors || []).filter(Boolean).length;
  files.forEach(function (f) {
    if (f.name === 'word/document.xml') {
      const d = bodyParts(f.data.toString('utf8'));
      let parts = signatureBoxes(d.parts, 'tenant', Math.max(1, nt));
      parts = signatureBoxes(parts, 'guarantor', ng);
      if (!ng) parts = dropFrontGuarantors(parts);
      parts = keepSignaturesTogether(parts);
      f.data = Buffer.from(replaceText(unfieldDates(d.head + parts.join('') + d.tail), rules), 'utf8');
    } else if (/^word\/(header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(f.name)) {
      f.data = Buffer.from(replaceText(f.data.toString('utf8'), rules), 'utf8');
    }
  });
  return zip(files);
}

// Word → PDF with LibreOffice (installed on the server; see railpack.json).
// One conversion at a time, each in its own folder.
const { execFile } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
let pdfQueue = Promise.resolve();
function docxToPdf(buf) {
  const run = function () {
    return new Promise(function (resolve, reject) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcy-'));
      const src = path.join(dir, 'agreement.docx');
      fs.writeFileSync(src, buf);
      execFile('soffice', ['-env:UserInstallation=file://' + path.join(os.tmpdir(), 'lo-profile'), '--headless', '--convert-to', 'pdf', '--outdir', dir, src],
        { timeout: 120000, env: Object.assign({}, process.env, { HOME: os.tmpdir() }) }, function (err) {
          let out = null;
          try { out = fs.readFileSync(path.join(dir, 'agreement.pdf')); } catch (e) { out = null; }
          fs.rmSync(dir, { recursive: true, force: true });
          if (!out) return reject(err || new Error('no-pdf'));
          resolve(out);
        });
    });
  };
  const job = pdfQueue.then(run, run);
  pdfQueue = job.catch(function () {});
  return job;
}

// The placeholders used in an uploaded template (for the admin page to show).
function docxPlaceholders(buf) {
  const found = new Set();
  unzip(buf).forEach(function (f) {
    if (!/^word\/.*\.xml$/.test(f.name)) return;
    const text = f.data.toString('utf8');
    const re = /\{(?:<[^>]*>)*\{((?:<[^>]*>|[^{}<])*?)\}(?:<[^>]*>)*\}/g; let m;
    while ((m = re.exec(text))) found.add(m[1].replace(/<[^>]*>/g, '').trim().toLowerCase());
  });
  return Array.from(found);
}

module.exports = { defaultTemplates: defaultTemplates, fillDocx: fillDocx, fillAgreement: fillAgreement, docxToPdf: docxToPdf, docxPlaceholders: docxPlaceholders, unzip: unzip, zip: zip };
