import { savePublishDecisionByUrl, supabaseAdmin } from "../lib/intelStore.js";

const DEFAULT_SOURCE_URL = "https://ahackaday-site.vercel.app/";
const LIST_CACHE_TTL_MS = 90_000;
/** In-process cache (best-effort on warm serverless invocations). */
const listCache = new Map();

function pickAll(regex, text) {
  const out = [];
  let m;
  while ((m = regex.exec(text)) !== null) out.push(m);
  return out;
}

function extractItemsFromHtml(html, maxItems = 40) {
  const clean = (s) => (s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const items = [];

  const linkMatches = pickAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, html || "");
  for (const m of linkMatches) {
    const href = m[1];
    const title = clean(m[2]);
    if (!href || !title || title.length < 12) continue;
    if (/apply|feed|calendar|rss|search/i.test(title)) continue;
    if (/^\/$/.test(href)) continue;
    const url = href.startsWith("http")
      ? href
      : `https://ahackaday-site.vercel.app${href.startsWith("/") ? "" : "/"}${href}`;
    items.push({ source: "ahackaday", url, title });
    if (items.length >= maxItems) break;
  }

  const seen = new Set();
  return items.filter((x) => {
    const k = `${x.url}|${x.title}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function decodeXml(text = "") {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseRssItems(xmlText, sourceName, maxItems = 18) {
  const out = [];
  const entries = [...String(xmlText || "").matchAll(/<item[\s\S]*?<\/item>/gi)];
  for (const m of entries.slice(0, maxItems)) {
    const block = m[0];
    const title = decodeXml((block.match(/<title>([\s\S]*?)<\/title>/i) || [,""])[1]).replace(/<[^>]+>/g, " ").trim();
    const link = decodeXml((block.match(/<link>([\s\S]*?)<\/link>/i) || [,""])[1]).trim();
    if (!title || !link) continue;
    out.push({ source: sourceName, url: link, title });
  }
  return out;
}

async function fetchRssItems(maxItems = 24) {
  const feeds = [
    "https://www.cisa.gov/news-events/cybersecurity-advisories/all.xml",
    "https://krebsonsecurity.com/feed/",
  ];
  const each = Math.max(4, Math.ceil(maxItems / feeds.length));
  const items = [];
  for (const feed of feeds) {
    try {
      const res = await fetch(feed, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; GraceDiscover/1.0)" },
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) continue;
      const xml = await res.text();
      const host = new URL(feed).hostname.replace(/^www\./, "");
      items.push(...parseRssItems(xml, `rss:${host}`, each));
    } catch {}
  }
  return items.slice(0, maxItems);
}

async function fetchKevItems(maxItems = 20) {
  const res = await fetch("https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json", {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; GraceDiscover/1.0)" },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) return [];
  const json = await res.json();
  const vulns = Array.isArray(json?.vulnerabilities) ? json.vulnerabilities : [];
  return vulns.slice(0, maxItems).map((v) => ({
    source: "cisa-kev",
    url: "https://www.cisa.gov/known-exploited-vulnerabilities-catalog",
    title: `${v.cveID || "CVE"} ${v.vendorProject || ""} ${v.product || ""}`.trim(),
  }));
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  res.setHeader("Access-Control-Allow-Origin", "*");

  const params = req.method === "GET" ? req.query || {} : req.body || {};
  if (req.method === "POST" && params.action === "decision") {
    const decision = String(params.decision || "").toLowerCase();
    if (!["reviewed", "approved", "deferred"].includes(decision)) {
      return res.status(400).json({ ok: false, error: "decision must be reviewed|approved|deferred" });
    }
    if (!params.url) return res.status(400).json({ ok: false, error: "url is required" });
    const out = await savePublishDecisionByUrl({
      url: params.url,
      decision,
      note: params.note || null,
      actor: params.actor || null,
    });
    if (out.error) return res.status(500).json({ ok: false, error: out.error });
    return res.status(200).json({ ok: true, ...out });
  }

  const source_url = params.source_url || DEFAULT_SOURCE_URL;
  const source_mode = (params.source_mode || "ahackaday").toLowerCase();
  const limit = Math.min(Math.max(parseInt(params.limit || "45", 10), 1), 80);
  const q = (params.q || "").trim().toLowerCase();
  const source_filter = (params.source_filter || "").trim().toLowerCase();
  const skipCache = params.skip_cache === "1" || params.skip_cache === "true";

  try {
    const cacheKey = `${source_mode}|${source_url}|${limit}`;
    const now = Date.now();
    let baseItems = null;
    let cached = false;

    if (!skipCache) {
      const hit = listCache.get(cacheKey);
      if (hit && now - hit.ts < LIST_CACHE_TTL_MS) {
        baseItems = hit.items;
        cached = true;
      }
    } else {
      listCache.delete(cacheKey);
    }

    if (!baseItems) {
      if (source_mode === "rss") {
        baseItems = await fetchRssItems(limit);
      } else if (source_mode === "kev") {
        baseItems = await fetchKevItems(limit);
      } else if (source_mode === "mixed") {
        const [ah, rss, kev] = await Promise.all([
          (async () => {
            const htmlRes = await fetch(source_url, {
              headers: { "User-Agent": "Mozilla/5.0 (compatible; GraceDiscover/1.0)" },
              signal: AbortSignal.timeout(12000),
            });
            if (!htmlRes.ok) return [];
            const html = await htmlRes.text();
            return extractItemsFromHtml(html, Math.ceil(limit * 0.45));
          })(),
          fetchRssItems(Math.ceil(limit * 0.35)),
          fetchKevItems(Math.ceil(limit * 0.2)),
        ]);
        baseItems = [...ah, ...rss, ...kev];
      } else {
        const htmlRes = await fetch(source_url, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; GraceDiscover/1.0)" },
          signal: AbortSignal.timeout(12000),
        });
        if (!htmlRes.ok) {
          return res.status(502).json({ ok: false, error: `Source returned ${htmlRes.status}` });
        }
        const html = await htmlRes.text();
        baseItems = extractItemsFromHtml(html, limit);
      }
      const seen = new Set();
      baseItems = baseItems.filter((x) => {
        const k = `${x.url}|${x.title}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      }).slice(0, limit);
      listCache.set(cacheKey, { ts: now, items: baseItems });
    }

    let items = baseItems;
    if (source_filter) {
      items = items.filter((it) => String(it.source || "").toLowerCase().includes(source_filter));
    }
    if (q) {
      items = items.filter(
        (it) =>
          (it.title || "").toLowerCase().includes(q) ||
          (it.url || "").toLowerCase().includes(q)
      );
    }

    const source_counts = items.reduce((acc, it) => {
      const k = it.source || "unknown";
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});

    const sb = supabaseAdmin();
    let relatedByUrl = {};
    let decisionsByUrl = {};
    if (sb) {
      const urls = items.map((i) => i.url).filter(Boolean).slice(0, 60);
      if (urls.length) {
        const { data: stories } = await sb.from("stories").select("id,url").in("url", urls);
        const idToUrl = {};
        for (const s of stories || []) idToUrl[s.id] = s.url;
        const storyIds = Object.keys(idToUrl);
        if (storyIds.length) {
          const { data: rel } = await sb
            .from("story_related")
            .select("story_id,related_story_id,score,reason")
            .in("story_id", storyIds)
            .order("score", { ascending: false });
          const relatedIds = [...new Set((rel || []).map((r) => r.related_story_id))];
          let relStoryById = {};
          if (relatedIds.length) {
            const { data: relStories } = await sb.from("stories").select("id,title,url,source").in("id", relatedIds);
            relStoryById = Object.fromEntries((relStories || []).map((r) => [r.id, r]));
          }
          for (const row of rel || []) {
            const u = idToUrl[row.story_id];
            if (!u) continue;
            if (!relatedByUrl[u]) relatedByUrl[u] = [];
            const rs = relStoryById[row.related_story_id];
            if (!rs) continue;
            relatedByUrl[u].push({
              title: rs.title,
              url: rs.url,
              source: rs.source,
              score: row.score,
              reason: row.reason,
            });
          }
        }
        const { data: decisions } = await sb
          .from("publish_decisions")
          .select("decision,created_at,story_id")
          .order("created_at", { ascending: false })
          .limit(400);
        const latestByStory = {};
        for (const d of decisions || []) {
          if (!latestByStory[d.story_id]) latestByStory[d.story_id] = d;
        }
        for (const [storyId, row] of Object.entries(latestByStory)) {
          const u = idToUrl[storyId];
          if (u) decisionsByUrl[u] = { decision: row.decision, created_at: row.created_at };
        }
      }
    }

    items = items.map((it) => ({
      ...it,
      related: (relatedByUrl[it.url] || []).slice(0, 3),
      latest_decision: decisionsByUrl[it.url] || null,
    }));

    return res.status(200).json({
      ok: true,
      source_url,
      source_mode,
      count: items.length,
      items,
      cached,
      source_counts,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || "discover_failed" });
  }
}
