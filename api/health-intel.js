import { supabaseAdmin } from "../lib/intelStore.js";

function isAuthorized(req) {
  const secret = process.env.HEALTH_SECRET;
  if (!secret) return true;
  return req.headers.authorization === `Bearer ${secret}`;
}

async function checkSupabase() {
  const sb = supabaseAdmin();
  if (!sb) return { ok: false, configured: false, error: "supabase_not_configured" };
  try {
    const { error } = await sb.from("stories").select("id", { count: "exact", head: true }).limit(1);
    if (error) return { ok: false, configured: true, error: error.message || "supabase_query_failed" };
    return { ok: true, configured: true };
  } catch (e) {
    return { ok: false, configured: true, error: e.message || "supabase_check_failed" };
  }
}

async function pingSlackIfRequested(req) {
  const webhook = process.env.SLACK_WEBHOOK_URL;
  const ping = req.query?.ping_slack === "1";
  if (!webhook) return { ok: false, configured: false, pinged: false, error: "slack_not_configured" };
  if (!ping) return { ok: true, configured: true, pinged: false };
  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `Grace health check OK (${new Date().toISOString()})`,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: false,
        configured: true,
        pinged: true,
        error: `slack_webhook_${res.status}${body ? `:${body.slice(0, 160)}` : ""}`,
      };
    }
    return { ok: true, configured: true, pinged: true };
  } catch (e) {
    return { ok: false, configured: true, pinged: true, error: e.message || "slack_ping_failed" };
  }
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (!isAuthorized(req)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const anthropic = {
    ok: !!process.env.ANTHROPIC_API_KEY,
    configured: !!process.env.ANTHROPIC_API_KEY,
    ...(process.env.ANTHROPIC_API_KEY ? {} : { error: "anthropic_not_configured" }),
  };
  const supabase = await checkSupabase();
  const slack = await pingSlackIfRequested(req);

  const ok = anthropic.ok && supabase.ok && (slack.configured ? slack.ok : true);
  return res.status(ok ? 200 : 500).json({
    ok,
    anthropic,
    supabase,
    slack,
    timestamp: new Date().toISOString(),
  });
}
