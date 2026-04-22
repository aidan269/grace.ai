import { runNewsSync } from "../lib/newsSyncCore.js";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  res.setHeader("Access-Control-Allow-Origin", "*");

  try {
    const out = await runNewsSync(req.body || {});
    return res.status(200).json(out);
  } catch (e) {
    const msg = e.message || "news_sync_failed";
    const code = msg.includes("ANTHROPIC") ? 500 : msg.includes("fetch source") ? 500 : 500;
    return res.status(code).json({ ok: false, error: msg });
  }
}
