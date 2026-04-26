import { supabaseAdmin } from "../lib/intelStore.js";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  res.setHeader("Access-Control-Allow-Origin", "*");

  const sb = supabaseAdmin();
  if (!sb) return res.status(503).json({ ok: false, error: "supabase_not_configured" });

  const params = req.query || {};
  const limit = Math.min(Math.max(parseInt(params.limit || "20", 10), 1), 100);

  try {
    const [runsRes, promptsRes, decisionsRes] = await Promise.all([
      sb
        .from("run_audit")
        .select("id,run_id,pipeline,status,detail,created_at")
        .order("created_at", { ascending: false })
        .limit(limit),
      sb
        .from("prompt_versions")
        .select("id,name,version,prompt_text,created_at")
        .order("created_at", { ascending: false })
        .limit(50),
      sb
        .from("publish_decisions")
        .select("id,decision,note,actor,created_at,story_id")
        .order("created_at", { ascending: false })
        .limit(limit),
    ]);

    const storyIds = [...new Set((decisionsRes.data || []).map((d) => d.story_id).filter(Boolean))];
    let storyById = {};
    if (storyIds.length) {
      const { data: stories } = await sb.from("stories").select("id,title,url,source").in("id", storyIds);
      storyById = Object.fromEntries((stories || []).map((s) => [s.id, s]));
    }

    const decisions = (decisionsRes.data || []).map((d) => ({
      ...d,
      story: storyById[d.story_id] || null,
    }));

    const promptsByName = {};
    for (const p of promptsRes.data || []) {
      if (!promptsByName[p.name]) promptsByName[p.name] = [];
      promptsByName[p.name].push(p);
    }

    return res.status(200).json({
      ok: true,
      runs: runsRes.data || [],
      prompt_registry: promptsByName,
      decisions,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || "audit_failed" });
  }
}
