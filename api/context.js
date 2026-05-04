import { parseIncidentContext } from "../lib/incidentContext.js";

function get(html, pattern) {
  const m = String(html || "").match(pattern);
  return m ? m[1].trim() : "";
}

async function fetchMeta(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; GraceContext/1.0)" },
    signal: AbortSignal.timeout(7000),
  });
  const html = await r.text();
  const title =
    get(html, /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
    get(html, /<title[^>]*>([^<]+)<\/title>/i);
  const description =
    get(html, /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) ||
    get(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
  return { title, description };
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  res.setHeader("Access-Control-Allow-Origin", "*");

  const { url, title = "", description = "" } = req.body || {};
  if (!url) return res.status(400).json({ error: "url is required" });

  try {
    let t = title;
    let d = description;
    if (!t && !d) {
      try {
        const meta = await fetchMeta(url);
        t = meta.title || "";
        d = meta.description || "";
      } catch {
        // Fallback to parser with provided inputs only.
      }
    }
    const context = parseIncidentContext({ url, title: t, description: d });
    return res.status(200).json({ ok: true, context });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || "context_parse_failed" });
  }
}
