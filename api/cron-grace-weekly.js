function authorizeCron(req) {
  const secret = process.env.CRON_SECRET;
  if (secret) return req.headers.authorization === `Bearer ${secret}`;
  return req.headers["x-vercel-cron"] === "1";
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (!authorizeCron(req)) return res.status(401).json({ error: "Unauthorized" });

  const payload = typeof req.body === "object" && req.body ? req.body : {};
  if (!payload.domain) {
    return res.status(400).json({
      error: "domain is required in cron payload",
      hint: "Provide domain + source URLs in cron body or invoke /api/grace-weekly directly.",
    });
  }

  try {
    const origin = `${req.headers["x-forwarded-proto"] || "https"}://${req.headers["x-forwarded-host"] || req.headers.host}`;
    const weekly = await fetch(`${origin}/api/grace-weekly`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await weekly.json();
    return res.status(weekly.status).json(json);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || "cron_grace_weekly_failed" });
  }
}
