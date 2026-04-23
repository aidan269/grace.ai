import { createClient } from "@supabase/supabase-js";

export function supabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function uniqTokens(text) {
  return new Set(
    String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2)
  );
}

function jaccardScore(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  if (!union) return 0;
  return inter / union;
}

function mergedRowToItemTriage(r, runId) {
  if (!r || r.error) return null;
  const url = r.url;
  if (!url) return null;
  const item = {
    source: r.source || null,
    url: r.url,
    title: r.title || "Untitled",
    summary: r.summary || r.description || null,
    description: r.description || null,
    severity: r.severity || null,
    type: r.type || null,
    published_at: r.published_at || r.publishedAt || null,
    run_id: runId || r.run_id || null,
  };
  const triage = {
    score: r.score,
    status: r.status,
    slug: r.slug,
    why: r.why,
    q1: r.q1,
    q2: r.q2,
    raw: r.raw || null,
  };
  if (triage.score === undefined && !triage.status) return null;
  return { item, triage, issue_url: r.issue_url || null, issue_error: r.issue_error || null, run_id: runId || r.run_id || null };
}

export async function persistGracePipelineRow(sb, row, pipeline, runId) {
  const parsed = mergedRowToItemTriage(row, runId);
  if (!parsed) return { skipped: true, reason: "not_triageable" };
  const { item, triage, issue_url, issue_error, run_id } = parsed;

  const snippet = [item.summary, item.description].filter(Boolean).join("\n").slice(0, 8000) || null;

  const { data: story, error: upErr } = await sb
    .from("stories")
    .upsert(
      {
        url: item.url,
        title: item.title,
        source: item.source,
        body_snippet: snippet,
        raw_item: item,
        run_id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "url" }
    )
    .select("id")
    .maybeSingle();

  if (upErr) throw upErr;
  const storyId = story?.id;
  if (!storyId) throw new Error("story_upsert_no_id");

  const { error: insErr } = await sb.from("triage_runs").insert({
    story_id: storyId,
    viral_score: Number(triage.score) || 0,
    status: triage.status || null,
    slug: triage.slug || null,
    why: triage.why || null,
    q1: triage.q1 || null,
    q2: triage.q2 || null,
    raw_assess: triage.raw || null,
    issue_url,
    issue_error,
    pipeline,
    run_id,
  });

  if (insErr) throw insErr;
  return { story_id: storyId };
}

export async function persistGraceResults(results, pipeline, runId) {
  const sb = supabaseAdmin();
  if (!sb) return { skipped: true, reason: "supabase_not_configured" };
  let persisted = 0;
  const errors = [];
  const storyIds = [];
  for (const r of results || []) {
    try {
      const out = await persistGracePipelineRow(sb, r, pipeline, runId);
      if (!out.skipped) {
        persisted += 1;
        if (out.story_id) storyIds.push(out.story_id);
      }
    } catch (e) {
      errors.push(e.message || String(e));
    }
  }
  return { persisted, story_ids: storyIds, errors: errors.length ? errors : undefined };
}

export async function computeAndStoreStoryRelated(sb, storyIds) {
  const ids = (storyIds || []).filter(Boolean);
  if (!ids.length) return { processed: 0 };
  let processed = 0;
  for (const storyId of ids) {
    const { data: baseRows } = await sb.from("stories").select("id,title,source").eq("id", storyId).limit(1);
    const base = baseRows?.[0];
    if (!base) continue;
    const baseTok = uniqTokens(base.title);
    const { data: candidates } = await sb
      .from("stories")
      .select("id,title,source")
      .neq("id", storyId)
      .order("updated_at", { ascending: false })
      .limit(80);
    const scored = [];
    for (const c of candidates || []) {
      const score = jaccardScore(baseTok, uniqTokens(c.title));
      if (score >= 0.16) {
        scored.push({
          story_id: storyId,
          related_story_id: c.id,
          score: Number(score.toFixed(4)),
          reason: `title_overlap_${Math.round(score * 100)}pct`,
        });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, 5);
    if (top.length) {
      await sb.from("story_related").upsert(top, { onConflict: "story_id,related_story_id" });
    }
    processed += 1;
  }
  return { processed };
}

export async function writeRunAudit(runId, pipeline, status, detail = {}) {
  const sb = supabaseAdmin();
  if (!sb) return { skipped: true };
  const { error } = await sb.from("run_audit").insert({
    run_id: runId,
    pipeline,
    status,
    detail,
  });
  if (error) return { error: error.message };
  return { ok: true };
}

export async function upsertPromptVersion(name, version, promptText) {
  const sb = supabaseAdmin();
  if (!sb) return { skipped: true };
  const { error } = await sb.from("prompt_versions").upsert(
    {
      name,
      version,
      prompt_text: promptText,
    },
    { onConflict: "name,version" }
  );
  if (error) return { error: error.message };
  return { ok: true };
}

export async function savePublishDecisionByUrl({ url, decision, note, actor }) {
  const sb = supabaseAdmin();
  if (!sb) return { skipped: true, reason: "supabase_not_configured" };
  const { data: storyRows, error: storyErr } = await sb.from("stories").select("id").eq("url", url).limit(1);
  if (storyErr) return { error: storyErr.message };
  const storyId = storyRows?.[0]?.id;
  if (!storyId) return { skipped: true, reason: "story_not_found" };
  const { error } = await sb.from("publish_decisions").insert({
    story_id: storyId,
    decision,
    note: note || null,
    actor: actor || null,
  });
  if (error) return { error: error.message };
  return { ok: true, story_id: storyId };
}
