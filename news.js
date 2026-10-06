// London property news on the website: the latest headlines from Property Week's London page
// (NEWS_SOURCE to change it). We show each headline with a link to the full story on their site,
// credited to them — never their article text. Read every 2 hours and kept in memory.
module.exports = function (opts) {
  const PAGE = String(process.env.NEWS_SOURCE || 'https://www.propertyweek.com/regions/london').replace(/\/+$/, '');
  const ORIGIN = (function () { try { return new URL(PAGE).origin; } catch (e) { return ''; } })();
  const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36', 'Accept-Language': 'en-GB,en;q=0.9' };
  const esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  const ent = function (s) { return String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, function (m, n) { return String.fromCharCode(+n); }).replace(/&rsquo;|&lsquo;/g, '’').replace(/&ldquo;|&rdquo;/g, '"').replace(/&ndash;/g, '–').replace(/&mdash;/g, '—').replace(/&pound;/g, '£').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim(); };
  let items = [], at = 0, how = '';

  // A feed (RSS or Atom), if the site has one.
  function fromFeed(xml) {
    const out = [];
    String(xml).replace(/<(item|entry)\b[\s\S]*?<\/\1>/g, function (it) {
      const t = ent((/<title[^>]*>([\s\S]*?)<\/title>/.exec(it) || [])[1]);
      let l = ent((/<link[^>]*>([\s\S]*?)<\/link>/.exec(it) || [])[1]) || ((/<link[^>]*href="([^"]+)"/.exec(it) || [])[1] || '');
      const d = ent((/<(pubDate|published|updated|dc:date)[^>]*>([\s\S]*?)<\/\1>/.exec(it) || [])[2]);
      if (t && /^https?:\/\//.test(l)) out.push({ title: t, url: l, date: isFinite(Date.parse(d)) ? new Date(d).toISOString() : '' });
    });
    return out;
  }
  // Otherwise the London page itself: links to stories (".../1234567.article"), with their dates where shown.
  function fromPage(html) {
    const out = [], seen = {};
    String(html).replace(/<a\b[^>]*href="([^"]*\/\d{6,8}\.article)"[^>]*>([\s\S]*?)<\/a>/g, function (m, href, inner) {
      const t = ent(inner); if (t.length < 25 || t.length > 220) return;
      const url = /^https?:/.test(href) ? href : ORIGIN + (href.charAt(0) === '/' ? '' : '/') + href;
      if (seen[url]) { if (t.length > seen[url].title.length) seen[url].title = t; return; }
      seen[url] = { title: t, url: url, date: '' }; out.push(seen[url]);
    });
    return out;
  }
  async function get(url) {
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) });
    return { ok: r.ok, status: r.status, type: r.headers.get('content-type') || '', body: await r.text() };
  }
  async function refresh() {
    if (!PAGE) return;
    let got = [], src = '';
    for (const u of [PAGE + '/rss', PAGE + '.rss', ORIGIN + '/rss' + PAGE.replace(ORIGIN, ''), PAGE + '?format=rss']) {
      try { const r = await get(u); if (r.ok && /<(rss|feed)\b/.test(r.body.slice(0, 2000))) { got = fromFeed(r.body); if (got.length) { src = 'feed ' + u; break; } } } catch (e) {}
    }
    if (!got.length) { try { const r = await get(PAGE); if (r.ok) { got = fromPage(r.body); src = 'page'; } else src = 'page status ' + r.status; } catch (e) { src = 'page not read: ' + e.message; } }
    if (got.length) { items = got.slice(0, 20); at = Date.now(); }
    how = src;
    console.log('London property news: ' + got.length + ' headlines (' + src + ')' + (got.length ? '' : ' — keeping ' + items.length + ' from before'));
  }
  setTimeout(refresh, 8000); setInterval(refresh, 2 * 3600000).unref();

  const day = function (iso) { return iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/London' }) : ''; };
  const list = function (n) {
    return '<ul class="news-l">' + items.slice(0, n).map(function (x) {
      return '<li><a href="' + esc(x.url) + '" target="_blank" rel="noopener nofollow"><span class="news-t">' + esc(x.title) + '</span><span class="news-m">Property Week' + (x.date ? ' · ' + esc(day(x.date)) : '') + ' ↗</span></a></li>';
    }).join('') + '</ul>';
  };
  return {
    count: function () { return items.length; },
    // The home page section (nothing when there's no news to show).
    section: function () {
      if (!items.length) return '';
      return '<section class="news"><div class="wrap"><div class="head2 row"><div><p class="kicker">London property news</p><h2 class="h2x" style="margin:4px 0 0">What’s happening in London</h2></div><a class="btn line" href="/news">More news →</a></div>' + list(6) +
        '<p class="news-src">Headlines from <a href="' + esc(PAGE) + '" target="_blank" rel="noopener nofollow">Property Week</a> — each opens the full story on their website.</p></div></section>';
    },
    page: function () {
      return '<div class="phead small"><div class="wrap"><span class="eyebrow"><i></i> News</span><h1>London property news</h1><p class="lead">The latest London property headlines, updated through the day.</p></div></div>' +
        '<section class="white"><div class="wrap">' + (items.length ? list(20) + '<p class="news-src">Headlines from <a href="' + esc(PAGE) + '" target="_blank" rel="noopener nofollow">Property Week</a> — each opens the full story on their website.</p>' : '<p class="sub">News is on its way — please check back soon.</p>') + '</div></section>';
    },
    status: function () { return { items: items.length, at: at, how: how }; }
  };
};
