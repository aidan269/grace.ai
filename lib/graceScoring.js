import Anthropic from "@anthropic-ai/sdk";

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

function scoreFromText(text = "", terms = []) {
  const lower = String(text || "").toLowerCase();
  if (!lower) return 30;
  let hits = 0;
  for (const term of terms) {
    if (lower.includes(term)) hits += 1;
  }
  return Math.min(100, Math.round((hits / Math.max(terms.length, 1)) * 100));
}

function overallScore(parts) {
  return Number(
    (
      parts.answerabilityScore * 0.3 +
      parts.entityAuthorityScore * 0.25 +
      parts.geoReadinessScore * 0.2 +
      parts.competitiveGapScore * 0.25
    ).toFixed(2)
  );
}

async function claudeConsensus(text) {
  if (!anthropic) return { provider: "claude", score: null, note: "not_configured" };
  try {
    const res = await anthropic.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 180,
      system:
        "Return JSON with fields score (0-100) and rationale. Assess content for answerability, authority, local GEO readiness, and competitor differentiation.",
      messages: [{ role: "user", content: text.slice(0, 8000) }],
    });
    const raw = res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || "{}");
    return { provider: "claude", score: Number(parsed.score) || null, rationale: parsed.rationale || null };
  } catch {
    return { provider: "claude", score: null, note: "parse_or_call_failed" };
  }
}

async function openAiConsensus(text) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { provider: "chatgpt", score: null, note: "not_configured" };
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        messages: [
          { role: "system", content: "Return strict JSON with score (0-100) and rationale." },
          { role: "user", content: text.slice(0, 8000) },
        ],
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { provider: "chatgpt", score: null, note: `http_${res.status}` };
    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content || "";
    const parsed = JSON.parse(String(content).match(/\{[\s\S]*\}/)?.[0] || "{}");
    return { provider: "chatgpt", score: Number(parsed.score) || null, rationale: parsed.rationale || null };
  } catch {
    return { provider: "chatgpt", score: null, note: "parse_or_call_failed" };
  }
}

async function geminiConsensus(text) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { provider: "gemini", score: null, note: "not_configured" };
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `Return strict JSON with score (0-100) and rationale.\n\n${text.slice(0, 8000)}` }] }],
        }),
        signal: AbortSignal.timeout(15000),
      }
    );
    if (!res.ok) return { provider: "gemini", score: null, note: `http_${res.status}` };
    const json = await res.json();
    const content = json?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("\n") || "";
    const parsed = JSON.parse(String(content).match(/\{[\s\S]*\}/)?.[0] || "{}");
    return { provider: "gemini", score: Number(parsed.score) || null, rationale: parsed.rationale || null };
  } catch {
    return { provider: "gemini", score: null, note: "parse_or_call_failed" };
  }
}

export async function scoreContentNode(node) {
  const content = String(node.content_text || "");
  const answerabilityScore = scoreFromText(content, ["faq", "how to", "what is", "steps", "summary", "answer"]);
  const entityAuthorityScore = scoreFromText(content, ["research", "source", "reference", "evidence", "guide", "expert"]);
  const geoReadinessScore = scoreFromText(
    `${content} ${node.location_tag || ""} ${(node.entity_tags || []).join(" ")}`,
    ["near me", "location", "city", "hours", "address", "google business"]
  );
  const competitiveGapScore = node.node_type === "competitor_page" ? 75 : scoreFromText(content, ["comparison", "alternative", "vs", "best"]);

  const base = {
    answerabilityScore,
    entityAuthorityScore,
    geoReadinessScore,
    competitiveGapScore,
  };

  const ensemblePrompt = [
    `node_type: ${node.node_type}`,
    `title: ${node.title || "untitled"}`,
    `topic_cluster: ${node.topic_cluster || "none"}`,
    `location: ${node.location_tag || "none"}`,
    `content: ${content.slice(0, 5000)}`,
  ].join("\n");

  const [claude, chatgpt, gemini] = await Promise.all([
    claudeConsensus(ensemblePrompt),
    openAiConsensus(ensemblePrompt),
    geminiConsensus(ensemblePrompt),
  ]);

  const modelScores = [claude, chatgpt, gemini].map((m) => m.score).filter((x) => Number.isFinite(x));
  const modelMean = modelScores.length
    ? modelScores.reduce((a, b) => a + b, 0) / modelScores.length
    : null;
  const deterministicOverall = overallScore(base);
  const blendedOverall = Number(
    (modelMean == null ? deterministicOverall : deterministicOverall * 0.6 + modelMean * 0.4).toFixed(2)
  );

  return {
    ...base,
    overallScore: blendedOverall,
    modelConsensus: { claude, chatgpt, gemini, modelMean },
    evidence: [
      { type: "keyword_match", detail: "deterministic scoring derived from content features" },
      ...(modelMean == null ? [] : [{ type: "model_ensemble", detail: "claude+chatgpt+gemini mean blended with deterministic score" }]),
    ],
  };
}

export function recommendationsFromScore(node, score) {
  const recs = [];
  if (score.answerabilityScore < 55) {
    recs.push({
      type: "add_schema_faq",
      title: "Add direct-answer sections and FAQ schema",
      details: "Improve answer blocks for AI overviews and citation extraction.",
      effort: 35,
      impact: 75,
    });
  }
  if (score.entityAuthorityScore < 55) {
    recs.push({
      type: "refresh_page",
      title: "Strengthen evidence and entity coverage",
      details: "Expand expert citations, entity references, and trust signals on this topic cluster.",
      effort: 50,
      impact: 80,
    });
  }
  if (score.geoReadinessScore < 55) {
    recs.push({
      type: node.node_type === "gbp_profile" ? "update_gbp" : "create_topic",
      title: "Improve GEO local signals",
      details: "Add location attributes, GBP updates, and local intent variants.",
      effort: 40,
      impact: 70,
    });
  }
  if (score.competitiveGapScore < 55) {
    recs.push({
      type: "create_topic",
      title: "Close competitor content gaps",
      details: "Publish net-new topic pages where competitors lead AI answer presence.",
      effort: 60,
      impact: 85,
    });
  }

  return recs.map((r) => {
    const confidence = Math.min(95, Math.max(45, Math.round(score.overallScore * 0.85)));
    const priority = Number((r.impact * 0.5 + confidence * 0.35 + (100 - r.effort) * 0.15).toFixed(2));
    return {
      recommendation_type: r.type,
      title: r.title,
      details: r.details,
      expected_impact: r.impact,
      confidence_score: confidence,
      effort_score: r.effort,
      priority_score: priority,
      evidence: score.evidence,
    };
  });
}
