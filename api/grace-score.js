import { recommendationTypeFromNode } from "../lib/graceIngestion.js";
import { recommendationsFromScore, scoreContentNode } from "../lib/graceScoring.js";
import { listWorkspaceNodes, storeScoresAndRecommendations } from "../lib/graceStore.js";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  res.setHeader("Access-Control-Allow-Origin", "*");

  const { workspace_id, run_id } = req.body || {};
  if (!workspace_id) return res.status(400).json({ error: "workspace_id is required" });

  try {
    const nodes = await listWorkspaceNodes(workspace_id, 120);
    const nodeScores = [];
    for (const node of nodes) {
      const score = await scoreContentNode(node);
      const baseRecs = recommendationsFromScore(node, score);
      const recs = baseRecs.map((r) => ({
        ...r,
        recommendation_type: r.recommendation_type || recommendationTypeFromNode(node.node_type),
      }));
      nodeScores.push({ node, score, recs });
    }
    const recommendations = await storeScoresAndRecommendations({
      workspaceId: workspace_id,
      runId: run_id || `score_${Date.now()}`,
      nodeScores,
    });
    return res.status(200).json({
      ok: true,
      node_count: nodes.length,
      recommendation_count: recommendations.length,
      recommendations,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || "grace_score_failed" });
  }
}
