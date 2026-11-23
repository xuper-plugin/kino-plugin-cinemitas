// Cinemitas (cinemitas.org) — a DooPlay site, like VerPelis but with English routes (/movies//tvshows/)
// and the admin-ajax player. Everything generic is channel-kit; this file is only the site scraper.
import { single, multi, dl, clean } from "./kit/scrape.js";

export const HOST = "https://cinemitas.org/";
export const NAME = "Cinemitas";

// Browser headers ported from Balandro's httptools.default_headers. Cinemitas's WAF/CloudFlare
// 403s a bare request (minimal headers) but accepts a browser-shaped one; Accept-Language es-ES
// and a full Accept are the ones it keys on. The per-plugin kino.fetch cookie jar already carries
// the session cookie from the page GET to the admin-ajax POST, like Balandro's cookies=True.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const BASE_HDRS = {
  "User-Agent": UA,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "es-ES,es;q=0.8,en-US;q=0.5,en;q=0.3",
};
const cdl = (url, post, extra) => dl(url, post, { ...BASE_HDRS, Referer: HOST, ...(extra || {}) });

// DooPlay <article class="item"> cards. Title from the img alt (or <h3 class="title">); type from the
// <span class="item_type">Película|Serie</span> badge (or the /tvshows/ path).
function parseCards(bloque) {
  const out = [];
  for (const m of multi(bloque, "<article(.*?)</article>")) {
    const url = single(m, '<a href="(.*?)"');
    let title = clean(single(m, 'alt="(.*?)"'));
    if (!title) title = clean(single(m, '<h3 class="title">(.*?)</h3>'));
    if (!url || !title) continue;
    const thumb = single(m, '<img src="(.*?)"') || single(m, "<img src='(.*?)'") || single(m, 'data-src="(.*?)"');
    const year = single(m, "<span>(\\d{4})</span>") || "";
    const type = /item_type">\s*Serie/i.test(m) || /\/tvshows\//.test(url) ? "tvshow" : "movie";
    out.push({ url, title, thumb, year, type });
    if (out.length >= 24) break;
  }
  return out;
}

// The listing block runs from "Añadido recientemente" / the </h1> to the next <div class="copy">.
function listingBlock(data) {
  return single(data, '>Añadido recientemente<(.*?)<div class="copy">') || single(data, '</h1>(.*?)<div class="copy">') || data;
}

/**
 * The live-search nonce the site's own pages carry (DooPlay's `dtGonza`, a base64 data: script on the home page). Kept a few hours:
 * WordPress nonces last 12-24 h.
 */
const NONCE_KEY = "searchNonce1", NONCE_MS = 6 * 3600 * 1000;
async function searchNonce(fresh = false) {
  if (!fresh) {
    try { const o = JSON.parse(kino.storage.get(NONCE_KEY) || "null"); if (o && o.n && Date.now() - o.at < NONCE_MS) return o.n; } catch { /* none kept */ }
  }
  const home = await cdl(HOST);
  const b64 = single(home, 'id="live_search-js-extra" src="data:text/javascript;base64,([A-Za-z0-9+/=]+)"');
  const cfg = b64 ? atob(b64) : home; // older pages inline it
  const n = single(cfg, '"nonce":"([a-z0-9]+)"');
  if (n) try { kino.storage.set(NONCE_KEY, JSON.stringify({ n, at: Date.now() })); } catch { /* no copy */ }
  return n || null;
}

/** DooPlay's live search: `{ "<id>": { title, url, img, extra: { date } } }`; {"error":...} when the nonce is no good. */
async function liveSearch(q, nonce) {
  const raw = await cdl(HOST + "wp-json/dooplay/search/?keyword=" + encodeURIComponent(String(q)) + "&nonce=" + nonce);
  let data = null;
  try { data = JSON.parse(raw); } catch { return null; }
  if (!data || typeof data !== "object" || data.error) return null;
  return Object.values(data).filter((x) => x && x.url && x.title).slice(0, 24).map((x) => ({
    url: String(x.url),
    title: clean(String(x.title)),
    thumb: String(x.img || "").replace(/\/w92\//, "/w342/"),
    year: (x.extra && x.extra.date) || "",
    type: /\/tvshows\//.test(String(x.url)) ? "tvshow" : "movie",
  }));
}

/**
 * Search. The site's `?s=` page sits behind a Cloudflare challenge (403 "Just a moment…" to any client that is not a browser,
 * 2026-11-22), so the site's own live-search API (the one its search box uses) is asked instead, with the nonce its pages
 * publish; a stale nonce is refreshed once. The `?s=` page stays as the last resort.
 */
export async function search(q) {
  try {
    let found = await liveSearch(q, await searchNonce());
    if (found === null) found = await liveSearch(q, await searchNonce(true));
    if (found) return found;
  } catch { /* fall back to the listing page */ }
  const data = await cdl(HOST + "?s=" + encodeURIComponent(String(q)).replace(/%20/g, "+"));
  return parseCards(listingBlock(data));
}

async function listPage(url) {
  return parseCards(listingBlock(await cdl(url)));
}

async function genreList(base) {
  const data = await cdl(base);
  const bloque = single(data, ">Géneros<(.*?)</ul>") || single(data, ">Generos<(.*?)</ul>");
  return multi(bloque, '<a href="(.*?)".*?>(.*?)</a>').map(([u, t]) => ({ url: u, title: clean(String(t)).replace(/&amp;/g, "&") })).filter((g) => g.url && g.title);
}

// Populares tab: cinemitas exposes "peliculas-mas-vistas" as a genre page.
async function popularCatalog() {
  let movies = [];
  try { movies = await listPage(HOST + "genre/peliculas-mas-vistas/"); } catch { /* ignore */ }
  return movies.length ? [{ title: "Películas populares", titleEn: "Popular movies", items: movies }] : [];
}

// Home rows for a tab. kind: "movie" (/movies/) | "tvshow" (/tvshows/) | "popular". Row 0 = recent (hero).
export async function catalog(kind) {
  if (kind === "popular") return popularCatalog();
  const base = kind === "tvshow" ? HOST + "tvshows/" : HOST + "movies/";
  const recientes = await listPage(base);
  const rows = [];
  if (recientes.length) rows.push({ title: kind === "tvshow" ? "Series recientes" : "Estrenos", titleEn: kind === "tvshow" ? "Recent series" : "New releases", items: recientes });
  let genres = [];
  try { genres = await genreList(base); } catch { /* ignore */ }
  const genreRows = await Promise.all(genres.slice(0, 6).map(async (g) => {
    try { const items = await listPage(g.url); return items.length ? { title: g.title, items } : null; } catch { return null; }
  }));
  for (const r of genreRows) if (r) rows.push(r);
  return rows;
}

// Series: same DooPlay markup as VerPelis (se-t seasons, mark-/numerando episodes).
export async function seasons(url) {
  const data = await cdl(url);
  return multi(data, "<span class='se-t.*?'>(.*?)</span>").map((t) => ({ season: String(t).trim() }));
}

export async function episodesOf(url, season) {
  const data = await cdl(url);
  const bloque = single(data, "<span class='se-t.*?'>" + season + "</span>(.*?)</ul>");
  const out = [];
  for (const [thumb, se, epUrl, title] of multi(bloque, "<li class='mark-.*?<img src='(.*?)'.*?</div><div class='numerando'>(.*?)</div>.*?<a href='(.*?)'>(.*?)</a>")) {
    out.push({ thumb, season: single(se, "(.*?)-").trim(), epis: single(se, "-(.*?)$").trim(), url: epUrl, title: clean(title) });
  }
  return out;
}

// Player options -> embed_url. Two ways to the same embed (DooPlay exposes both): the admin-ajax
// POST the site's own player uses, and a wp-json GET. On-device, CloudFlare lets GETs through by IP
// but can 403 the POST; so we try the POST first (with the movie page as Referer, like the player),
// then fall back to the wp-json GET. Trailers (a YouTube id, not a URL) are skipped.
export async function findvideos(url) {
  const data = (await cdl(url)).replace(/[\n\r\t]/g, "");
  const out = [];
  const origin = HOST.replace(/\/$/, "");
  const options = [];
  for (const option of multi(data, "<li id=.player-option-(.*?)</li>")) {
    const dpost = single(option, "data-post=.([^\"'> ]+)");
    const dtype = single(option, "data-type=.([^\"'> ]+)");
    const dnume = single(option, "data-nume=.([^\"'> ]+)");
    if (!dpost || !dtype || !dnume || dnume === "trailer") continue;
    options.push({ option, dpost, dtype, dnume });
  }
  // The options are asked together, not one after another: a film lists a dozen, ~0.8 s each, so ~11 s of waiting before the first
  // embed was opened (Redmi, 2026-11-22). Kino runs at most 6 requests of a plugin at once; the results keep the page order.
  const embeds = await Promise.all(options.map(async ({ dpost, dtype, dnume }) => {
    let embed = "";
    // Pass 1: admin-ajax POST, shaped like the site's own player call.
    try {
      const d0 = await cdl(HOST + "wp-admin/admin-ajax.php", { action: "doo_player_ajax", post: dpost, nume: dnume, type: dtype }, { Referer: url, Origin: origin, "X-Requested-With": "XMLHttpRequest" });
      embed = single(d0, '"embed_url":.*?"(.*?)"');
    } catch { /* fall through to wp-json */ }
    // Pass 2: DooPlay's wp-json GET (sidesteps a POST-only 403).
    if (!embed) {
      try {
        const d1 = await cdl(HOST + "wp-json/dooplayer/v2/" + dpost + "/" + dtype + "/" + dnume, null, { Referer: url });
        embed = single(d1, '"embed_url":.*?"(.*?)"');
      } catch { /* ignore */ }
    }
    return embed;
  }));
  options.forEach(({ option }, i) => {
    let embed = embeds[i];
    if (!embed) return;
    embed = embed.replaceAll("\\/", "/");
    if (!/^https?:\/\//i.test(embed)) return;
    const lang = /Latino/i.test(option) ? "Lat" : /Castellano|Españ|ESPA/i.test(option) ? "Esp" : /Sub|VOSE|Vose/i.test(option) ? "Vose" : "?";
    out.push({ url: embed, lang });
  });
  // Fallback: cinemitas's player endpoints (admin-ajax + wp-json) are WAF/JA3-blocked for kino.fetch (both
  // 403), but the real WebView passes the WAF — the page's own JS runs the admin-ajax with the browser's
  // fingerprint and injects the embed <iframe>. So read the JS-rendered movie page and pull the embed(s).
  if (!out.length && typeof kino !== "undefined" && kino.browser && typeof kino.browser.page === "function") {
    try {
      const page = await kino.browser.page(url, { waitFor: "source-player-\\d+[^>]*>\\s*<iframe", timeoutMs: 18000 });
      const html = String(page && page.html || "");
      const seen = new Set();
      const add = (raw) => {
        const u = String(raw).replace(/&amp;/g, "&").trim();
        if (/^https?:\/\//i.test(u) && !/cinemitas\.org|youtube\.com|youtu\.be|google\.|facebook\.|disqus\./i.test(u) && !seen.has(u)) { seen.add(u); out.push({ url: u, lang: "?" }); }
      };
      for (const src of multi(html, "id=.source-player-[^>]*?<iframe[^>]+src=[\"']([^\"']+)")) add(src);
      if (!out.length) for (const src of multi(html, "<iframe[^>]+src=[\"']([^\"']+)")) add(src);
    } catch { /* browser unavailable or nothing injected */ }
  }
  return out;
}
