import { getRecentPluginNudges } from "../lib/intelStore.js";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  res.setHeader("Access-Control-Allow-Origin", "*");

  const limit = Number(req.query?.limit || 8);
  const out = await getRecentPluginNudges(limit);
  if (out.error) return res.status(500).json({ ok: false, error: out.error, items: [] });
  if (out.skipped) return res.status(200).json({ ok: false, skipped: true, reason: out.reason, items: [] });
  return res.status(200).json({ ok: true, items: out.items || [] });
}
