import { createClient } from "@supabase/supabase-js";

/** Strips whitespace and surrounding quotes (common when values were pasted or synced with CLI). */
function normalizeEnvValue(raw) {
  let s = String(raw ?? "").trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

export function supabaseAdmin() {
  const url = normalizeEnvValue(process.env.SUPABASE_URL);
  const key = normalizeEnvValue(process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

const STOP_WORDS = new Set(["the","and","for","with","that","this","are","was","were","has","have","been","from","they","not","but","its","will","can","new","how","your","our","all","more","about","also","into","via","over","per","use","used","using","out","may","get","set","let","one","two","three","any","some","such","each","than","then","when","than","which","what","who","does","did"]);

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
}

function weightedTokenBag(title, why = "") {
  const bag = new Map();
  const cvePattern = /cve-\d{4}-\d{4,}/gi;
  const cves = [...String(title + " " + why).matchAll(cvePattern)].map((m) => m[0].toLowerCase());
  for (const cve of cves) bag.set(cve, (bag.get(cve) || 0) + 3);
  for (const t of tokenize(title)) bag.set(t, (bag.get(t) || 0) + 1.5);
  for (const t of tokenize(why)) bag.set(t, (bag.get(t) || 0) + 0.8);
  return bag;
}

function extractCveIds(text) {
  return new Set([...String(text || "").matchAll(/cve-\d{4}-\d{4,}/gi)].map((m) => m[0].toLowerCase()));
}

function weightedCosine(a, b) {
  if (!a.size || !b.size) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (const [k, v] of a) { magA += v * v; if (b.has(k)) dot += v * b.get(k); }
  for (const [, v] of b) magB += v * v;
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom ? dot / denom : 0;
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
    const { data: baseRows } = await sb
      .from("stories")
      .select("id,title,source,body_snippet")
      .eq("id", storyId)
      .limit(1);
    const base = baseRows?.[0];
    if (!base) continue;

    const { data: triageRows } = await sb
      .from("triage_runs")
      .select("why,viral_score")
      .eq("story_id", storyId)
      .order("created_at", { ascending: false })
      .limit(1);
    const baseTriage = triageRows?.[0];
    const baseWhy = baseTriage?.why || "";
    const baseVec = weightedTokenBag(base.title, baseWhy);
    const baseCves = extractCveIds(base.title + " " + baseWhy);

    const { data: candidates } = await sb
      .from("stories")
      .select("id,title,source")
      .neq("id", storyId)
      .order("updated_at", { ascending: false })
      .limit(200);

    const candIds = (candidates || []).map((c) => c.id);
    let triageByStory = {};
    if (candIds.length) {
      const { data: candTriages } = await sb
        .from("triage_runs")
        .select("story_id,why")
        .in("story_id", candIds.slice(0, 200))
        .order("created_at", { ascending: false });
      for (const t of candTriages || []) {
        if (!triageByStory[t.story_id]) triageByStory[t.story_id] = t.why || "";
      }
    }

    const scored = [];
    for (const c of candidates || []) {
      const candWhy = triageByStory[c.id] || "";
      const candCves = extractCveIds(c.title + " " + candWhy);

      let score = weightedCosine(baseVec, weightedTokenBag(c.title, candWhy));
      let reason = `cosine_${Math.round(score * 100)}pct`;

      if (baseCves.size && candCves.size) {
        for (const cve of baseCves) {
          if (candCves.has(cve)) {
            score = Math.max(score, 0.92);
            reason = `cve_match:${cve}`;
            break;
          }
        }
      }

      if (score >= 0.18) {
        scored.push({ story_id: storyId, related_story_id: c.id, score: Number(score.toFixed(4)), reason });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, 8);
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

export async function savePluginNudge({ slug, sourceUrl, step, reason = "inactivity" }) {
  const sb = supabaseAdmin();
  if (!sb) return { skipped: true, reason: "supabase_not_configured" };
  const { error } = await sb.from("plugin_nudges").insert({
    slug: slug || null,
    source_url: sourceUrl || null,
    step: step || null,
    reason,
  });
  if (error) return { error: error.message };
  return { ok: true };
}

export async function getRecentPluginNudges(limit = 10) {
  const sb = supabaseAdmin();
  if (!sb) return { skipped: true, reason: "supabase_not_configured", items: [] };
  const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 50));
  const { data, error } = await sb
    .from("plugin_nudges")
    .select("slug,source_url,step,reason,created_at")
    .order("created_at", { ascending: false })
    .limit(safeLimit);
  if (error) return { error: error.message, items: [] };
  return { ok: true, items: data || [] };
}

export async function saveOperatorActionByUrl({ url, action, note, actor, assignee }) {
  const sb = supabaseAdmin();
  if (!sb) return { skipped: true, reason: "supabase_not_configured" };
  const { data: storyRows, error: storyErr } = await sb.from("stories").select("id").eq("url", url).limit(1);
  if (storyErr) return { error: storyErr.message };
  const storyId = storyRows?.[0]?.id;
  if (!storyId) return { skipped: true, reason: "story_not_found" };
  const { error } = await sb.from("operator_actions").insert({
    story_id: storyId,
    action,
    note: note || null,
    actor: actor || null,
    assignee: assignee || null,
  });
  if (error) return { error: error.message };
  return { ok: true, story_id: storyId };
}
