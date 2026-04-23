import { runNewsSync } from "../lib/newsSyncCore.js";

function authorizeCron(req) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    return req.headers.authorization === `Bearer ${secret}`;
  }
  return req.headers["x-vercel-cron"] === "1";
}

/**
 * Scheduled AHackaday ingest + triage + Supabase + Slack sink.
 * Vercel Cron: GET /api/cron-intel (add CRON_SECRET or rely on x-vercel-cron in production).
 */
export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (!authorizeCron(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
  }

  try {
    const body = typeof req.body === "object" && req.body ? req.body : {};
    const out = await runNewsSync({
      ...body,
      max_items: body.max_items ?? 10,
      create_issue: body.create_issue !== false,
      source_mode: body.source_mode || "mixed",
    });
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || "cron_intel_failed" });
  }
}
