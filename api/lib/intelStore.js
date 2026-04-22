import { createClient } from "@supabase/supabase-js";

export function supabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function mergedRowToItemTriage(r) {
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
  return { item, triage, issue_url: r.issue_url || null, issue_error: r.issue_error || null };
}

export async function persistGracePipelineRow(sb, row, pipeline) {
  const parsed = mergedRowToItemTriage(row);
  if (!parsed) return { skipped: true, reason: "not_triageable" };
  const { item, triage, issue_url, issue_error } = parsed;

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
  });

  if (insErr) throw insErr;
  return { story_id: storyId };
}

export async function persistGraceResults(results, pipeline) {
  const sb = supabaseAdmin();
  if (!sb) return { skipped: true, reason: "supabase_not_configured" };
  let persisted = 0;
  const errors = [];
  for (const r of results || []) {
    try {
      const out = await persistGracePipelineRow(sb, r, pipeline);
      if (!out.skipped) persisted += 1;
    } catch (e) {
      errors.push(e.message || String(e));
    }
  }
  return { persisted, errors: errors.length ? errors : undefined };
}
