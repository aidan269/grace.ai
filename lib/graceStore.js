import { supabaseAdmin, writeRunAudit } from "./intelStore.js";
import { computeLeadingIndicators, computeNorthStarMetric, defaultGuardrails } from "./graceMetrics.js";

function sbOrThrow() {
  const sb = supabaseAdmin();
  if (!sb) throw new Error("supabase_not_configured");
  return sb;
}

export async function ensureWorkspace({ domain, name, timezone = "UTC" }) {
  const sb = sbOrThrow();
  const { data, error } = await sb
    .from("grace_workspaces")
    .upsert({ domain, name: name || domain, timezone }, { onConflict: "domain" })
    .select("id,name,domain,timezone")
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function insertCanonicalNodes(workspaceId, nodes = []) {
  if (!nodes.length) return [];
  const sb = sbOrThrow();
  const payload = nodes.map((n) => ({ ...n, workspace_id: workspaceId }));
  const { data, error } = await sb
    .from("grace_content_nodes")
    .insert(payload)
    .select("id,node_type,title,url,topic_cluster,location_tag,source_system");
  if (error) throw error;
  return data || [];
}

export async function listWorkspaceNodes(workspaceId, limit = 120) {
  const sb = sbOrThrow();
  const { data, error } = await sb
    .from("grace_content_nodes")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("ingested_at", { ascending: false })
    .limit(Math.max(1, Math.min(Number(limit) || 120, 500)));
  if (error) throw error;
  return data || [];
}

export async function saveMetricSnapshot({
  workspaceId,
  snapshotDate,
  favorableAnswers,
  trackedPriorityQueries,
  indicators,
  notes,
  rawPayload,
}) {
  const sb = sbOrThrow();
  const northStar = computeNorthStarMetric({ favorableAnswers, trackedPriorityQueries });
  const leading = computeLeadingIndicators(indicators || {});
  const { data, error } = await sb
    .from("grace_metric_snapshots")
    .upsert(
      {
        workspace_id: workspaceId,
        snapshot_date: snapshotDate,
        north_star_score: northStar,
        answer_inclusion_rate: leading.answerInclusionRate,
        entity_coverage_score: leading.entityCoverageScore,
        citation_frequency: leading.citationFrequency,
        local_profile_completeness: leading.localProfileCompleteness,
        content_freshness_ratio: leading.contentFreshnessRatio,
        notes: notes || null,
        raw_payload: {
          favorableAnswers,
          trackedPriorityQueries,
          guardrails: defaultGuardrails(),
          ...(rawPayload || {}),
        },
      },
      { onConflict: "workspace_id,snapshot_date" }
    )
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function storeScoresAndRecommendations({ workspaceId, runId, nodeScores = [] }) {
  const sb = sbOrThrow();
  const recommendations = [];
  for (const row of nodeScores) {
    const { node, score, recs } = row;
    const { data: scoreRow, error: scoreErr } = await sb
      .from("grace_scores")
      .insert({
        workspace_id: workspaceId,
        content_node_id: node.id || null,
        score_scope: "page",
        answerability_score: score.answerabilityScore,
        entity_authority_score: score.entityAuthorityScore,
        geo_readiness_score: score.geoReadinessScore,
        competitive_gap_score: score.competitiveGapScore,
        overall_score: score.overallScore,
        model_consensus: score.modelConsensus,
        evidence: score.evidence,
        run_id: runId,
      })
      .select("id,overall_score")
      .maybeSingle();
    if (scoreErr) throw scoreErr;

    for (const rec of recs || []) {
      const payload = {
        workspace_id: workspaceId,
        score_id: scoreRow?.id || null,
        ...rec,
      };
      const { data: recRow, error: recErr } = await sb
        .from("grace_recommendations")
        .insert(payload)
        .select("*")
        .maybeSingle();
      if (recErr) throw recErr;
      recommendations.push(recRow);
    }
  }
  return recommendations;
}

export async function markRecommendationStatus({
  workspaceId,
  recommendationId,
  nextStatus,
  actor,
  note,
}) {
  const sb = sbOrThrow();
  const { data: existing, error: getErr } = await sb
    .from("grace_recommendations")
    .select("id,status")
    .eq("id", recommendationId)
    .eq("workspace_id", workspaceId)
    .limit(1)
    .maybeSingle();
  if (getErr) throw getErr;
  if (!existing) throw new Error("recommendation_not_found");

  const { error: updateErr } = await sb
    .from("grace_recommendations")
    .update({ status: nextStatus, updated_at: new Date().toISOString() })
    .eq("id", recommendationId)
    .eq("workspace_id", workspaceId);
  if (updateErr) throw updateErr;

  const { error: actionErr } = await sb.from("grace_approval_actions").insert({
    workspace_id: workspaceId,
    recommendation_id: recommendationId,
    previous_status: existing.status,
    next_status: nextStatus,
    actor: actor || null,
    note: note || null,
  });
  if (actionErr) throw actionErr;

  return { id: recommendationId, previous: existing.status, next: nextStatus };
}

export async function saveWeeklyRun({ workspaceId, runId, status, detail }) {
  const sb = sbOrThrow();
  const { data, error } = await sb
    .from("grace_weekly_runs")
    .upsert(
      {
        workspace_id: workspaceId,
        run_id: runId,
        status,
        run_detail: detail || {},
      },
      { onConflict: "run_id" }
    )
    .select("*")
    .maybeSingle();
  if (error) throw error;
  await writeRunAudit(runId, "grace-weekly", status, detail || {});
  return data;
}

export async function getWorkspaceReport(workspaceId) {
  const sb = sbOrThrow();
  const [metricsRes, recsRes, scoresRes] = await Promise.all([
    sb
      .from("grace_metric_snapshots")
      .select("*")
      .eq("workspace_id", workspaceId)
      .order("snapshot_date", { ascending: false })
      .limit(8),
    sb
      .from("grace_recommendations")
      .select("*")
      .eq("workspace_id", workspaceId)
      .order("priority_score", { ascending: false })
      .limit(30),
    sb
      .from("grace_scores")
      .select("id,overall_score,created_at,model_consensus")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false })
      .limit(30),
  ]);
  if (metricsRes.error) throw metricsRes.error;
  if (recsRes.error) throw recsRes.error;
  if (scoresRes.error) throw scoresRes.error;

  const metrics = metricsRes.data || [];
  const recommendations = recsRes.data || [];
  const scores = scoresRes.data || [];

  return {
    overview: {
      latestMetric: metrics[0] || null,
      scoreTrend: scores.slice(0, 10),
      recommendationsByStatus: recommendations.reduce((acc, r) => {
        acc[r.status] = (acc[r.status] || 0) + 1;
        return acc;
      }, {}),
    },
    weeklyActions: recommendations.slice(0, 12),
    workbench: {
      scores,
      recommendations,
    },
  };
}
