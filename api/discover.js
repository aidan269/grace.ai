const DEFAULT_SOURCE_URL = "https://ahackaday-site.vercel.app/";

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

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  res.setHeader("Access-Control-Allow-Origin", "*");

  const params = req.method === "GET" ? req.query || {} : req.body || {};
  const source_url = params.source_url || DEFAULT_SOURCE_URL;
  const limit = Math.min(Math.max(parseInt(params.limit || "45", 10), 1), 80);
  const q = (params.q || "").trim().toLowerCase();

  try {
    const htmlRes = await fetch(source_url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; GraceDiscover/1.0)" },
      signal: AbortSignal.timeout(12000),
    });
    if (!htmlRes.ok) {
      return res.status(502).json({ ok: false, error: `Source returned ${htmlRes.status}` });
    }
    const html = await htmlRes.text();
    let items = extractItemsFromHtml(html, limit);

    if (q) {
      items = items.filter(
        (it) =>
          (it.title || "").toLowerCase().includes(q) ||
          (it.url || "").toLowerCase().includes(q)
      );
    }

    return res.status(200).json({
      ok: true,
      source_url,
      count: items.length,
      items,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || "discover_failed" });
  }
}
