export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();
  res.setHeader("Access-Control-Allow-Origin", "*");

  const { url } = req.body || {};
  if (!url) return res.status(400).json({});

  let domain = "";
  try { domain = new URL(url).hostname.replace("www.", ""); } catch {}

  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Twitterbot/1.0)" },
      signal: AbortSignal.timeout(6000),
    });
    const html = await r.text();

    const get = (pattern) => {
      const m = html.match(pattern);
      return m ? m[1].trim() : null;
    };

    const title =
      get(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
      get(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i) ||
      get(/<title[^>]*>([^<]+)<\/title>/i) || domain;

    const description =
      get(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) ||
      get(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i) ||
      get(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) || "";

    const image =
      get(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
      get(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) || null;

    const favicon = `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;

    return res.status(200).json({ title, description: description.slice(0, 140), image, favicon, domain });
  } catch {
    return res.status(200).json({ title: domain, description: "", image: null, favicon: `https://www.google.com/s2/favicons?domain=${domain}&sz=32`, domain });
  }
}
