import { buildCanonicalGraph } from "../lib/graceIngestion.js";
import { ensureWorkspace, insertCanonicalNodes, saveMetricSnapshot } from "../lib/graceStore.js";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  res.setHeader("Access-Control-Allow-Origin", "*");

  const body = req.body || {};
  if (!body.domain) return res.status(400).json({ error: "domain is required" });

  try {
    const workspace = await ensureWorkspace({
      domain: body.domain,
      name: body.workspace_name || body.domain,
      timezone: body.timezone || "UTC",
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
    const inserted = await insertCanonicalNodes(workspace.id, graph);

    let metricSnapshot = null;
    if (body.metrics) {
      metricSnapshot = await saveMetricSnapshot({
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

    return res.status(200).json({
      ok: true,
      workspace,
      inserted_count: inserted.length,
      inserted_nodes: inserted,
      metric_snapshot: metricSnapshot,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || "grace_ingest_failed" });
  }
}
