import { supabaseAdmin, writeRunAudit } from "./intelStore.js";
import { computeLeadingIndicators, computeNorthStarMetric, defaultGuardrails } from "./graceMetrics.js";

function sbOrThrow() {
  const sb = supabaseAdmin();
  if (!sb) throw new Error("supabase_not_configured");
  return sb;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseWorkspaceMapEnv() {
  const raw = process.env.GRACE_WORKSPACE_MAP_JSON || process.env.WORKSPACE_MAP_JSON || "";
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export async function resolveWorkspaceId(workspaceRef, { source = "" } = {}) {
  const ref = String(workspaceRef || "").trim();
  if (!ref) return null;
  if (UUID_RE.test(ref)) return ref;

  const envMap = parseWorkspaceMapEnv();
  const mapped = envMap[ref] || envMap[source] || null;
  if (mapped && UUID_RE.test(mapped)) return mapped;

  const sb = sbOrThrow();
  const { data: rows, error } = await sb
    .from("grace_workspaces")
    .select("id,name,domain")
    .or(`domain.eq.${ref},name.eq.${ref}`)
    .limit(2);
  if (error) throw error;
  if (rows?.[0]?.id && UUID_RE.test(rows[0].id)) return rows[0].id;

  if (ref === "default") {
    const { data: fallbackRows, error: fallbackError } = await sb
      .from("grace_workspaces")
      .select("id,domain,created_at")
      .order("created_at", { ascending: true })
      .limit(50);
    if (fallbackError) throw fallbackError;
    const ah = (fallbackRows || []).find((r) => String(r.domain || "").includes("ahackaday"));
    if (ah?.id && UUID_RE.test(ah.id)) return ah.id;
    if ((fallbackRows || []).length === 1 && UUID_RE.test(fallbackRows[0].id)) return fallbackRows[0].id;
  }

  return null;
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

export async function storeScoresAndRecommendations({ workspaceId, runId, nodeScores = [], context = null }) {
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
      const baseEvidence = Array.isArray(rec.evidence) ? rec.evidence : [];
      const contextEvidence = context
        ? [
            {
              type: "bridge_context",
              detail: "correlates recommendation to upstream bridge payload",
              incident_key: context.incident_key || null,
              origin: context.origin || null,
              source: context.source || null,
            },
          ]
        : [];
      const payload = {
        workspace_id: workspaceId,
        score_id: scoreRow?.id || null,
        ...rec,
        evidence: [...baseEvidence, ...contextEvidence],
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

function incidentKeyFromRunDetail(detail = {}) {
  const d = detail && typeof detail === "object" ? detail : {};
  return d.incident_key || d.bridge?.incident_key || null;
}

function extractIndicatorsFromText(text = "") {
  const raw = String(text || "");
  const urls = [...raw.matchAll(/https?:\/\/[^\s)]+/gi)].map((m) => m[0]);
  const cves = [...raw.matchAll(/\bCVE-\d{4}-\d{4,}\b/gi)].map((m) => m[0].toUpperCase());
  const domains = [...raw.matchAll(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi)].map((m) => m[0].toLowerCase());
  return [...new Set([...urls, ...cves, ...domains])];
}

function recommendationMatchesIncident(rec, incidentKey) {
  if (!rec || !incidentKey) return false;
  const evidence = Array.isArray(rec.evidence) ? rec.evidence : [];
  return evidence.some((e) => e && typeof e === "object" && e.incident_key === incidentKey);
}

export async function getIncidentReport(workspaceId, incidentKey) {
  const sb = sbOrThrow();
  const [metricsRes, runsRes] = await Promise.all([
    sb
      .from("grace_metric_snapshots")
      .select("*")
      .eq("workspace_id", workspaceId)
      .order("snapshot_date", { ascending: false })
      .limit(8),
    sb
      .from("grace_weekly_runs")
      .select("run_id,status,created_at,run_detail")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false })
      .limit(120),
  ]);
  if (metricsRes.error) throw metricsRes.error;
  if (runsRes.error) throw runsRes.error;

  const incidentRuns = (runsRes.data || []).filter((r) => incidentKeyFromRunDetail(r.run_detail) === incidentKey);
  const runIds = [...new Set(incidentRuns.map((r) => r.run_id).filter(Boolean))];

  const [scoresRes, recsRes] = await Promise.all([
    runIds.length
      ? sb
          .from("grace_scores")
          .select("id,run_id,overall_score,created_at,model_consensus")
          .eq("workspace_id", workspaceId)
          .in("run_id", runIds)
          .order("created_at", { ascending: false })
          .limit(120)
      : Promise.resolve({ data: [], error: null }),
    sb
      .from("grace_recommendations")
      .select("*")
      .eq("workspace_id", workspaceId)
      .order("priority_score", { ascending: false })
      .limit(200),
  ]);
  if (scoresRes.error) throw scoresRes.error;
  if (recsRes.error) throw recsRes.error;

  const metrics = metricsRes.data || [];
  const scores = scoresRes.data || [];
  const recs = recsRes.data || [];
  const scoreIds = new Set(scores.map((s) => s.id));
  const recommendations = recs.filter(
    (r) => (r.score_id && scoreIds.has(r.score_id)) || recommendationMatchesIncident(r, incidentKey)
  );
  const latestMetric = metrics[0] || null;

  const extractedIndicators = [
    ...new Set(
      incidentRuns.flatMap((r) => {
        const bridgeIndicators = r?.run_detail?.bridge?.extracted_indicators;
        const bridgeText = JSON.stringify(r?.run_detail?.bridge || {});
        return [
          ...(Array.isArray(bridgeIndicators) ? bridgeIndicators : []),
          ...extractIndicatorsFromText(bridgeText),
        ];
      })
    ),
  ].slice(0, 40);
  if (!extractedIndicators.length && incidentKey) extractedIndicators.push(incidentKey);

  const latestRun = incidentRuns[0] || null;
  const runs = incidentRuns.slice(0, 20).map((r) => ({
    run_id: r.run_id,
    id: r.run_id,
    status: r.status,
    created_at: r.created_at,
    origin: r?.run_detail?.origin || null,
  }));

  const recommendationsByStatus = recommendations.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});

  const topRecommendation = recommendations
    .slice()
    .sort((a, b) => Number(b.priority_score || 0) - Number(a.priority_score || 0))[0] || null;

  const avgScore = scores.length
    ? scores.reduce((sum, s) => sum + Number(s.overall_score || 0), 0) / scores.length
    : 0;
  const metricNorth = Number(latestMetric?.north_star_score || 0);
  const metricAnswer = Number(latestMetric?.answer_inclusion_rate || 0);
  const metricFresh = Number(latestMetric?.content_freshness_ratio || 0);
  const recDensityBoost = Math.min(25, recommendations.length * 3);
  const indicatorBoost = Math.min(20, extractedIndicators.length * 2);
  const northStarDerived = Math.max(12, Math.min(95, Math.round(avgScore * 0.7 + recDensityBoost)));
  const answerDerived = Math.max(10, Math.min(95, Math.round(avgScore * 0.62 + indicatorBoost)));
  const freshnessDerived = Math.max(35, Math.min(95, 55 + Math.min(20, incidentRuns.length * 4)));
  const openActions = recommendations.filter((r) => !["executed", "measured"].includes(r.status)).length;
  const northStarFinal = metricNorth > 0 ? metricNorth : northStarDerived;
  const answerFinal = metricAnswer > 0 ? metricAnswer : answerDerived;
  const freshnessFinal = metricFresh > 0 ? metricFresh : freshnessDerived;

  return {
    incident_key: incidentKey,
    kpis: {
      north_star: northStarFinal,
      answer_inclusion: answerFinal,
      freshness: freshnessFinal,
      open_actions: openActions,
    },
    north_star: northStarFinal,
    answer_inclusion: answerFinal,
    freshness: freshnessFinal,
    open_actions: openActions,
    recommendations,
    top_recommendation: topRecommendation,
    runs,
    latest_run: runs[0] || null,
    extracted_indicators: extractedIndicators,
    overview: {
      latestMetric,
      scoreTrend: scores.slice(0, 10),
      recommendationsByStatus,
    },
    weeklyActions: recommendations.slice(0, 12),
    workbench: {
      scores,
      recommendations,
    },
    stale: !latestRun || latestRun.status !== "completed",
  };
}
