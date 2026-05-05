function clampPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

export function computeNorthStarMetric({
  favorableAnswers = 0,
  trackedPriorityQueries = 0,
}) {
  const denom = Number(trackedPriorityQueries) || 0;
  if (denom <= 0) return 0;
  return clampPct((Number(favorableAnswers) / denom) * 100);
}

export function computeLeadingIndicators({
  entityCoverageScore = 0,
  citationFrequency = 0,
  answerInclusionRate = 0,
  localProfileCompleteness = 0,
  contentFreshnessRatio = 0,
}) {
  return {
    entityCoverageScore: clampPct(entityCoverageScore),
    citationFrequency: clampPct(citationFrequency),
    answerInclusionRate: clampPct(answerInclusionRate),
    localProfileCompleteness: clampPct(localProfileCompleteness),
    contentFreshnessRatio: clampPct(contentFreshnessRatio),
  };
}

export function defaultGuardrails() {
  return {
    requireHumanApprovalForPublish: true,
    requireEvidencePerRecommendation: true,
    requireRollbackInstructions: true,
    prohibitUntraceableActions: true,
  };
}
