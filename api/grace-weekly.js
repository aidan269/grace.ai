import { buildCanonicalGraph } from "../lib/graceIngestion.js";
import { recommendationsFromScore, scoreContentNode } from "../lib/graceScoring.js";
import {
  ensureWorkspace,
  insertCanonicalNodes,
  saveMetricSnapshot,
  saveWeeklyRun,
  storeScoresAndRecommendations,
} from "../lib/graceStore.js";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  res.setHeader("Access-Control-Allow-Origin", "*");

  const body = req.body || {};
  if (!body.domain) return res.status(400).json({ error: "domain is required" });
  const runId = body.run_id || `weekly_${Date.now().toString(36)}`;

  try {
    const workspace = await ensureWorkspace({
      domain: body.domain,
      name: body.workspace_name || body.domain,
      timezone: body.timezone || "UTC",
    });

    await saveWeeklyRun({
      workspaceId: workspace.id,
      runId,
      status: "started",
      detail: { phase: "ingest" },
    });

    const graph = await buildCanonicalGraph({
      websiteUrls: body.website_urls || [],
      landingPageUrls: body.landing_page_urls || [],
      blogUrls: body.blog_urls || [],
      competitorUrls: body.competitor_urls || [],
      analyticsSnapshots: body.analytics_snapshots || [],
      gbpSnapshot: body.gbp_snapshot || null,
      topicCluster: body.topic_cluster || null,
      locationTag: body.location_tag || null,
    });
    const nodes = await insertCanonicalNodes(workspace.id, graph);

    if (body.metrics) {
      await saveMetricSnapshot({
        workspaceId: workspace.id,
        snapshotDate: body.snapshot_date || new Date().toISOString().slice(0, 10),
        favorableAnswers: body.metrics.favorable_answers || 0,
        trackedPriorityQueries: body.metrics.tracked_priority_queries || 0,
        indicators: {
          entityCoverageScore: body.metrics.entity_coverage_score || 0,
          citationFrequency: body.metrics.citation_frequency || 0,
          answerInclusionRate: body.metrics.answer_inclusion_rate || 0,
          localProfileCompleteness: body.metrics.local_profile_completeness || 0,
          contentFreshnessRatio: body.metrics.content_freshness_ratio || 0,
        },
        notes: body.metrics.notes || null,
        rawPayload: body.metrics,
      });
    }

    const nodeScores = [];
    for (const node of nodes) {
      const score = await scoreContentNode(node);
      const recs = recommendationsFromScore(node, score);
      nodeScores.push({ node, score, recs });
    }

    const recommendations = await storeScoresAndRecommendations({
      workspaceId: workspace.id,
      runId,
      nodeScores,
    });

    const prioritized = recommendations
      .sort((a, b) => Number(b.priority_score || 0) - Number(a.priority_score || 0))
      .slice(0, 5);

    await saveWeeklyRun({
      workspaceId: workspace.id,
      runId,
      status: "completed",
      detail: {
        phase: "completed",
        inserted_nodes: nodes.length,
        recommendation_count: recommendations.length,
        top_actions: prioritized.map((x) => ({
          id: x.id,
          title: x.title,
          priority_score: x.priority_score,
          confidence_score: x.confidence_score,
        })),
      },
    });

    return res.status(200).json({
      ok: true,
      run_id: runId,
      workspace,
      inserted_nodes: nodes.length,
      recommendation_count: recommendations.length,
      top_actions: prioritized,
      workflow_states: ["draft", "review", "approved", "executed", "measured"],
    });
  } catch (e) {
    try {
      const workspace = body.domain ? await ensureWorkspace({ domain: body.domain, name: body.workspace_name || body.domain }) : null;
      if (workspace) {
        await saveWeeklyRun({
          workspaceId: workspace.id,
          runId,
          status: "failed",
          detail: { error: e.message || "unknown_error" },
        });
      }
    } catch {}
    return res.status(500).json({ ok: false, error: e.message || "grace_weekly_failed" });
  }
}
