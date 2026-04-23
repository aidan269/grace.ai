import { getRecentPluginNudges, savePluginNudge, supabaseAdmin } from "../../lib/intelStore.js";
const nudgeCooldownMap = new Map();
const NUDGE_COOLDOWN_MS = 45 * 60 * 1000;

function isAuthorized(req) {
  const secret = process.env.HEALTH_SECRET;
  if (!secret) return true;
  return req.headers.authorization === `Bearer ${secret}`;
}

function isSameOriginRequest(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = req.headers["x-forwarded-host"] || req.headers.host || "";
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
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
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method === "GET" && req.query?.plugin_monitor === "1") {
    const limit = Number(req.query?.limit || 8);
    const out = await getRecentPluginNudges(limit);
    if (out.error) return res.status(500).json({ ok: false, error: out.error, items: [] });
    if (out.skipped) return res.status(200).json({ ok: false, skipped: true, reason: out.reason, items: [] });
    return res.status(200).json({ ok: true, items: out.items || [] });
  }

  if (req.method === "POST" && req.body?.action === "plugin_nudge") {
    if (!isSameOriginRequest(req)) return res.status(403).json({ ok: false, error: "Forbidden" });
    const webhook = process.env.SLACK_WEBHOOK_URL;
    if (!webhook) return res.status(200).json({ ok: false, skipped: true, reason: "slack_not_configured" });
    const slug = String(req.body?.slug || "plugin").slice(0, 80);
    const sourceUrl = String(req.body?.source_url || "").slice(0, 600);
    const step = String(req.body?.step || "write").slice(0, 20);
    const key = `${slug}|${sourceUrl}|${step}`;
    const now = Date.now();
    const last = nudgeCooldownMap.get(key) || 0;
    if (now - last < NUDGE_COOLDOWN_MS) {
      return res.status(200).json({ ok: true, skipped: true, reason: "cooldown_active" });
    }
    nudgeCooldownMap.set(key, now);
    try {
      const text = [
        `Grace nudge: still working on /cantinasec:${slug}?`,
        sourceUrl ? `source: ${sourceUrl}` : null,
        `step: ${step}`,
        "If yes, keep cooking. If no, ship or defer it so it does not drift.",
      ]
        .filter(Boolean)
        .join("\n");
      const ping = await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(8000),
      });
      if (!ping.ok) {
        const body = await ping.text().catch(() => "");
        return res.status(500).json({
          ok: false,
          error: `slack_webhook_${ping.status}${body ? `:${body.slice(0, 160)}` : ""}`,
        });
      }
      await savePluginNudge({ slug, sourceUrl, step, reason: "inactivity" });
      return res.status(200).json({ ok: true, sent: true });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message || "plugin_nudge_failed" });
    }
  }

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
