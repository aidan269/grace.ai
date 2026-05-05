import { markRecommendationStatus } from "../lib/graceStore.js";

const ALLOWED_STATES = new Set(["draft", "review", "approved", "executed", "measured", "deferred"]);

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  res.setHeader("Access-Control-Allow-Origin", "*");

  const { workspace_id, recommendation_id, next_status, actor, note } = req.body || {};
  if (!workspace_id || !recommendation_id || !next_status) {
    return res.status(400).json({ error: "workspace_id, recommendation_id, next_status are required" });
  }
  if (!ALLOWED_STATES.has(next_status)) {
    return res.status(400).json({ error: "invalid next_status" });
  }

  try {
    const out = await markRecommendationStatus({
      workspaceId: workspace_id,
      recommendationId: recommendation_id,
      nextStatus: next_status,
      actor: actor || null,
      note: note || null,
    });
    return res.status(200).json({ ok: true, transition: out });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || "grace_approval_failed" });
  }
}
