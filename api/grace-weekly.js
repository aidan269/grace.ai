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
  const bridgeMeta = body.bridge_meta && typeof body.bridge_meta === "object" ? body.bridge_meta : null;
  const runOrigin = bridgeMeta?.origin || body.origin || "direct";
  const normalizedBridge = bridgeMeta || body.incident_key || body.incident_url || body.source_url || body.url
    ? {
        incident_key: bridgeMeta?.incident_key || body.incident_key || null,
        incident_url: bridgeMeta?.incident_url || body.incident_url || body.source_url || body.url || null,
        source: bridgeMeta?.source || body.source || "ahackaday",
        extracted_indicators: Array.isArray(bridgeMeta?.extracted_indicators)
          ? bridgeMeta.extracted_indicators.slice(0, 80)
          : [],
        selected_count: Number(bridgeMeta?.selected_count || 0),
        mapping_summary: bridgeMeta?.mapping_summary || null,
      }
    : null;

function normalizeUrl(raw) {
  try {
    return new URL(String(raw || "").trim()).toString();
  } catch {
    return null;
  }
}

function extractIndicatorsFromText(text = "") {
  const raw = String(text || "");
  const urls = [...raw.matchAll(/https?:\/\/[^\s)]+/gi)].map((m) => m[0]);
  const cves = [...raw.matchAll(/\bCVE-\d{4}-\d{4,}\b/gi)].map((m) => m[0].toUpperCase());
  const domains = [...raw.matchAll(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi)].map((m) => m[0].toLowerCase());
  return [...new Set([...urls, ...cves, ...domains])];
}

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
      detail: {
        phase: "ingest",
        origin: runOrigin,
        bridge: normalizedBridge,
      },
    });

    const websiteUrls = Array.isArray(body.website_urls) ? body.website_urls : [];
    const landingPageUrls = Array.isArray(body.landing_page_urls) ? body.landing_page_urls : [];
    const blogUrls = Array.isArray(body.blog_urls) ? body.blog_urls : [];
    const competitorUrls = Array.isArray(body.competitor_urls) ? body.competitor_urls : [];
    const fallbackIncidentUrl = normalizeUrl(
      normalizedBridge?.incident_url ||
        body.incident_url ||
        body.source_url ||
        body.url
    );
    const hasAnyUrls =
      websiteUrls.length || landingPageUrls.length || blogUrls.length || competitorUrls.length;
    if (normalizedBridge && normalizedBridge.extracted_indicators.length === 0) {
      normalizedBridge.extracted_indicators = extractIndicatorsFromText(
        [
          normalizedBridge.incident_url || "",
          body.incident_title || body.title || "",
          body.incident_summary || body.description || "",
        ].join("\n")
      ).slice(0, 80);
    }

    const graph = await buildCanonicalGraph({
      websiteUrls,
      landingPageUrls,
      blogUrls: hasAnyUrls ? blogUrls : fallbackIncidentUrl ? [fallbackIncidentUrl] : blogUrls,
      competitorUrls,
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

    const nodesForScoring =
      nodes.length > 0
        ? nodes
        : [
            {
              id: null,
              node_type: "blog_page",
              url: fallbackIncidentUrl || normalizedBridge?.incident_url || null,
              title: body.incident_title || body.title || normalizedBridge?.incident_key || "incident",
              topic_cluster: body.topic_cluster || "incident-ops",
              entity_tags: [],
              location_tag: body.location_tag || null,
              source_system: normalizedBridge?.source || "ahackaday",
              content_text: [
                body.incident_summary || "",
                body.description || "",
                normalizedBridge?.incident_key || "",
                fallbackIncidentUrl || "",
              ]
                .filter(Boolean)
                .join("\n")
                .slice(0, 8000),
            },
          ];

    const nodeScores = [];
    for (const node of nodesForScoring) {
      const score = await scoreContentNode(node);
      let recs = recommendationsFromScore(node, score);
      if (!recs.length) {
        recs = [
          {
            recommendation_type: "create_topic",
            title: "Create incident response topic update",
            details: "Publish an incident-focused explainer and mitigation page from this AHackaday signal.",
            expected_impact: 68,
            confidence_score: 62,
            effort_score: 35,
            priority_score: 72,
            evidence: score.evidence,
          },
        ];
      }
      nodeScores.push({ node, score, recs });
    }

    const recommendations = await storeScoresAndRecommendations({
      workspaceId: workspace.id,
      runId,
      nodeScores,
      context: {
        incident_key: normalizedBridge?.incident_key || null,
        origin: runOrigin,
        source: normalizedBridge?.source || null,
      },
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
        origin: runOrigin,
        inserted_nodes: nodes.length,
        recommendation_count: recommendations.length,
        top_actions: prioritized.map((x) => ({
          id: x.id,
          title: x.title,
          priority_score: x.priority_score,
          confidence_score: x.confidence_score,
        })),
        bridge: normalizedBridge,
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
      origin: runOrigin,
    });
  } catch (e) {
    try {
      const workspace = body.domain ? await ensureWorkspace({ domain: body.domain, name: body.workspace_name || body.domain }) : null;
      if (workspace) {
        await saveWeeklyRun({
          workspaceId: workspace.id,
          runId,
          status: "failed",
          detail: {
            error: e.message || "unknown_error",
            origin: runOrigin,
            bridge: normalizedBridge,
          },
        });
      }
    } catch {}
    return res.status(500).json({ ok: false, error: e.message || "grace_weekly_failed" });
  }
}
