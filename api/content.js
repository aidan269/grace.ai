const BRAVE_KEY = process.env.BRAVE_API_KEY;
const TWITTER_RE = /^https?:\/\/(x\.com|twitter\.com)\//i;

async function braveSearch(query) {
  if (!BRAVE_KEY) return null;
  try {
    const res = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`,
      {
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip",
          "X-Subscription-Token": BRAVE_KEY,
        },
        signal: AbortSignal.timeout(8000),
      }
    );
    const json = await res.json();
    return (json?.web?.results || [])
      .map((r) => `${r.title}\n${r.url}\n${r.description || ""}`)
      .join("\n\n")
      .slice(0, 6000);
  } catch {
    return null;
  }
}

async function fetchPage(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" },
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });
    const text = await res.text();
    return text
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 6000);
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  res.setHeader("Access-Control-Allow-Origin", "*");

  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: "url is required" });

  let content = null;

  if (TWITTER_RE.test(url)) {
    content = await braveSearch(`${url} security vulnerability`) || await braveSearch(url);
  } else {
    const page = await fetchPage(url);
    content = (page && page.length > 200) ? page : await braveSearch(url);
  }

  return res.status(200).json({ content: content || null });
}
