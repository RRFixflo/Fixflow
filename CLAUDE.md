# Fixflow — Residential Realtors

Fixflow is the staff app **and** the public website for Residential Realtors, a London letting and estate
agent (28-30 Harper Road, London SE1 6AD). It is a Node/Express app with Postgres, hosted on Railway and
deployed automatically from `main`. The live site is https://www.residentialrealtors.co.uk (behind
Cloudflare; the bare domain redirects to www).

The owner is not a developer: explain results in plain, non-technical English, briefly.

## This repository is PUBLIC — privacy rules (never break these)

- Never commit personal data: tenant, landlord, applicant or contractor names, phone numbers, emails,
  addresses linked to people, bank details, IDs, screenshots, PDFs or uploaded documents. Use clearly
  made-up test data only. If the user pastes real people's details, use them only for the task in hand
  and never write them into the code, tests, commits or PRs.
- Secrets (passwords, API keys, feed keys, Turnstile secret) live only in Railway environment variables —
  never in code, never repeated back. Don't store passwords the user pastes.
- Don't hardcode staff names, mobiles or emails. The only contact details allowed in code are the
  office phone **0207 096 8131** and **info@residentialrealtors.co.uk**.
- Landlord-facing pages never show our costs, profit, or contractor names/prices. The landlord offer
  review never shows applicant contact details or IDs.
- The public licence checker must not expose register data; firm answers only for councils we have
  verified ward by ward (currently Southwark and Newham).
- No fabricated stats, reviews, testimonials or claims. Demo content is clearly marked as an example.
- Never bypass CAPTCHAs or the form bot checks.

## Where things live

| File | What it does |
|---|---|
| `server.js` | Express app, routing, public website shell (`siteShell`, header/footer), `asset()` fingerprinting of CSS/JS |
| `jobs.js` | Most API routes: repairs, tenancies, landlords, offers, certificates, website leads (CRM), alerts, form bot checks (`humanCheck`), licence checker |
| `admin.html` | The whole staff app (owner at `/admin`, staff at `/staff` — "staff mode") |
| `listings.js` | Property listings from Gnomen XML feeds (+ Rightmove fill-in), property pages, photo cache, duplicate-photo check |
| `areas.js`, `areas-data.js`, `data/ons-london.json` | Compare rents (`/api/public/rent-compare` in listings.js) uses PropertyData (`PROPERTYDATA_API_KEY`, whole-market asking rents) or else these ONS figures — never our own adverts, never scraped portals. Below the result, landlords can request a free comparables report (lead kind `comps`): staff add 3–6 similar Rightmove adverts by hand in Website leads and send it (`/api/admin/valuation-requests/:id/comps`, report page `/comparables/<token>`). London rent pages (`/london-rents`, `/london-rents/<borough>`): ONS average rents, rent by bedrooms and house prices per borough. ONS figures only (never scraped from Foxtons/Rightmove); the server refreshes them weekly from each borough’s ONS data file (`/visualisations/housingpriceslocal/data/json/<GSS>.json`, stored in app_settings `ons_london`); the JSON file is the fallback |
| `visits.js` | Website visitor stats (no cookies), IP names, "don't count" list |
| `site/*.html`, `site.css`, `site.js` | Public website pages, styles and scripts |
| `index.html` | Public repair report form |
| `offer.html`, `reserve.html`, `landlord.html`, `landlords.html` | Applicant offer form, reservations, landlord portal/terms, landlords page |
| `tenancy.js`, `outlook.js`, `news.js`, `updates.js`, `rrt.js`, `portaldemo.js`, `ff.js` | Tenancy docs, Outlook drafts, news, landlord updates, Renters' Rights, demo portal, form token client |

## Listings (Gnomen) quirks

- Source of truth is Gnomen's XML feeds (`GNOMEN_LETTINGS_FEED`, `GNOMEN_SALES_FEED`, `LISTINGS_SOURCE=gnomen`), polled every 2 minutes; staff can press "🌐 Update website now".
- **Gnomen lettings prices are per week** — convert to pcm (× 52 / 12).
- Property URLs use the Gnomen id: `/property/<gnomen id>/<slug>`. Old Gnomen-style links redirect.
- If a published property is missing from Gnomen's feed it is filled in from the Rightmove advert; `RM_GNOMEN_IDS` maps Rightmove ids to Gnomen ids. Re-saving the property in Gnomen usually makes it appear in the feed.
- Records are de-duplicated; let/sold Gnomen records win over Rightmove adverts.

## How to work

1. Make the change; keep the style of the surrounding code (plain ES5-style JS in the browser, no frameworks or build step).
2. Test locally and with Playwright at desktop (1280) and phone (390, sometimes 360) widths: check for JS errors and horizontal overflow, and look at screenshots.
3. `node --check` any edited `.js` file.
4. Commit with a clear message, push the working branch, open a PR, squash-merge it, then reset the working branch to the new `main`.
5. Tell the user what changed in plain English and anything they need to do.

Public website changes must respect `prefers-reduced-motion`, work without horizontal scroll at phone width, and keep the existing SEO (titles, descriptions, sitemap, structured data).

## User preferences learned so far

- No "Last updated" label in the website header (removed at the owner's request).
- No notifications about properties that share photos — the report stays on the Website visitors page only.
- Staff alerts for viewings and valuation requests go to all staff.
- New repair emails and phone alerts go to the owner only, never staff.
- Refreshing the staff app keeps you on the same page; the Refresh button reloads every page's data.
