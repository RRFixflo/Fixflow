// Cloudflare Worker for terms.residentialrealtors.co.uk
// Forwards the Landlord Terms pages to Fixflow (on the offers address), so landlords
// see terms.residentialrealtors.co.uk in their browser. Only the Landlord Terms page,
// its API and the logo/icons pass through; anything else goes to the main website.
// Set up: Cloudflare > Workers & Pages > Create > Worker, paste this, Deploy, then
// Settings > Domains & Routes > Add > Custom domain: terms.residentialrealtors.co.uk.
// Then set TERMS_ORIGIN=https://terms.residentialrealtors.co.uk on Railway.
const ORIGIN = 'https://offers.residentialrealtors.co.uk';
const HOME = 'https://www.residentialrealtors.co.uk/';
const ALLOW = [/^\/landlord\/[\w-]+\/?$/, /^\/api\/landlord-terms\/[\w-]+(\/(sign|pdf))?$/, /^\/logo[\w-]*\.png$/, /^\/icons\/[\w.-]+$/, /^\/favicon\.ico$/, /^\/apple-touch-icon\.png$/];

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.protocol === 'http:') { url.protocol = 'https:'; return Response.redirect(url.toString(), 301); }
    if (!ALLOW.some(function (r) { return r.test(url.pathname); })) return Response.redirect(HOME, 302);
    const headers = new Headers(request.headers);
    headers.delete('host'); headers.delete('cookie');
    // The landlord's own IP for the signing audit trail.
    const ip = request.headers.get('cf-connecting-ip'); if (ip) headers.set('x-forwarded-for', ip);
    const res = await fetch(new Request(ORIGIN + url.pathname + url.search, {
      method: request.method, headers: headers, redirect: 'manual',
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer()
    }));
    const out = new Response(res.body, res);
    const loc = out.headers.get('location');
    if (loc && loc.indexOf(ORIGIN) === 0) out.headers.set('location', url.origin + loc.slice(ORIGIN.length));
    out.headers.set('X-Robots-Tag', 'noindex');
    return out;
  }
};
