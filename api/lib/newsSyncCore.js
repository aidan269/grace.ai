import Anthropic from "@anthropic-ai/sdk";
import { persistGraceResults } from "./intelStore.js";
import { appendNotionFeedFromResults } from "./notionSink.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const DEFAULT_SOURCE_URL = "https://ahackaday-site.vercel.app/";
const DEFAULT_OWNER = process.env.NEWS_QUEUE_REPO_OWNER || "aidan269";
const DEFAULT_REPO = process.env.NEWS_QUEUE_REPO || "grace.ai";

async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let idx = 0;

  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length || 1) }, () => worker());
  await Promise.all(workers);
  return results;
}

const ASSESS_SYSTEM = `You are Grace, Cantina's security marketing specialist.
Assess incident virality and campaign value.

Return exactly:
score: <0-4 integer>
slug: <kebab-case slug starting with cl or cla>
status: <archive|review|promote>
why: <1 sentence>
q1: <scoping question with [options]>
q2: <scoping question with [options]>

Mapping:
- score 0-1 => archive
- score 2 => review
- score 3-4 => promote`;

function parseAssess(raw) {
  const txt = raw || "";
  const score = parseInt((txt.match(/score:\s*([0-4])/i) || [,"2"])[1], 10);
  const slug = (txt.match(/slug:\s*([a-z][a-z0-9-]{2,60})/i) || [,"cl-plugin"])[1].toLowerCase();
  const statusMatch = (txt.match(/status:\s*(archive|review|promote)/i) || [])[1];
  const status = statusMatch ? statusMatch.toLowerCase() : (score >= 3 ? "promote" : score === 2 ? "review" : "archive");
  const why = (txt.match(/why:\s*(.+)/i) || [,"No rationale produced."])[1].trim();
  const q1 = (txt.match(/q1:\s*(.+)/i) || [,""])[1].trim();
  const q2 = (txt.match(/q2:\s*(.+)/i) || [,""])[1].trim();
  return { score, slug, status, why, q1, q2, raw: txt };
}

function pickAll(regex, text) {
  const out = [];
  let m;
  while ((m = regex.exec(text)) !== null) out.push(m);
  return out;
}

function extractItemsFromHtml(html, maxItems = 15) {
  const clean = (s) => (s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const items = [];

  const linkMatches = pickAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, html || "");
  for (const m of linkMatches) {
    const href = m[1];
    const title = clean(m[2]);
    if (!href || !title || title.length < 12) continue;
    if (/apply|feed|calendar|rss|search/i.test(title)) continue;
    if (/^\/$/.test(href)) continue;
    const url = href.startsWith("http") ? href : `https://ahackaday-site.vercel.app${href.startsWith("/") ? "" : "/"}${href}`;
    items.push({ source: "ahackaday", url, title });
    if (items.length >= maxItems) break;
  }

  if (!items.length) {
    const sentenceMatches = pickAll(/([A-Z][^.]{40,180}\.)/g, clean(html || ""));
    for (const m of sentenceMatches.slice(0, maxItems)) {
      const title = m[1].trim();
      if (!/vulnerab|breach|exploit|ransom|malware|cisa|supply chain|hack/i.test(title)) continue;
      items.push({ source: "ahackaday", url: DEFAULT_SOURCE_URL, title });
    }
  }

  const seen = new Set();
  return items.filter((x) => {
    const k = `${x.url}|${x.title}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function assessItem(item) {
  const prompt = [
    `source: ${item.source || "unknown"}`,
    `url: ${item.url || "n/a"}`,
    `title: ${item.title || "untitled"}`,
    `summary: ${item.summary || item.description || "n/a"}`,
    `severity: ${item.severity || "unknown"}`,
    `type: ${item.type || "unknown"}`,
    `published_at: ${item.published_at || item.publishedAt || "unknown"}`,
  ].join("\n");

  const response = await anthropic.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 300,
    system: ASSESS_SYSTEM,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  return parseAssess(text);
}

async function createQueueIssue(item, triage) {
  const ghToken = process.env.GITHUB_TOKEN;
  if (!ghToken) return null;
  const { Octokit } = await import("@octokit/rest");
  const octokit = new Octokit({ auth: ghToken });

  const issueTitle = `[${triage.status.toUpperCase()}] ${item.title || item.url || "Untitled incident"}`.slice(0, 250);
  const issueBody = [
    "## Incident",
    `- Source: ${item.source || "unknown"}`,
    `- URL: ${item.url || "n/a"}`,
    `- Severity: ${item.severity || "unknown"}`,
    `- Type: ${item.type || "unknown"}`,
    "",
    "## Grace Triage",
    `- Score: ${triage.score}/4`,
    `- Status: ${triage.status}`,
    `- Slug: ${triage.slug}`,
    `- Why: ${triage.why}`,
    "",
    "## Scoping Questions",
    `1. ${triage.q1 || "n/a"}`,
    `2. ${triage.q2 || "n/a"}`,
  ].join("\n");

  const { data } = await octokit.issues.create({
    owner: DEFAULT_OWNER,
    repo: DEFAULT_REPO,
    title: issueTitle,
    body: issueBody,
    labels: ["news-intake"],
  });
  return data.html_url;
}

/**
 * @param {Record<string, unknown>} body - same shape as POST /api/news-sync JSON body
 */
export async function runNewsSync(body = {}) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not configured");
  }

  const source_url = body?.source_url || DEFAULT_SOURCE_URL;
  const max_items = Math.min(Math.max(parseInt(body?.max_items || "8", 10), 1), 30);
  const create_issue = body?.create_issue !== false;
  const assess_concurrency = Math.min(Math.max(parseInt(body?.assess_concurrency || "3", 10), 1), 6);
  const issue_concurrency = Math.min(Math.max(parseInt(body?.issue_concurrency || "3", 10), 1), 6);

  const htmlRes = await fetch(source_url, { signal: AbortSignal.timeout(10000) });
  if (!htmlRes.ok) throw new Error(`Failed to fetch source: ${htmlRes.status}`);
  const html = await htmlRes.text();
  const candidates = extractItemsFromHtml(html, max_items);

  const triaged = await mapPool(candidates, assess_concurrency, async (item) => {
    try {
      const triage = await assessItem(item);
      return { ok: true, item, triage };
    } catch (err) {
      return { ok: false, item, error: err.message || "Triage failed" };
    }
  });

  const results = await mapPool(triaged, issue_concurrency, async (row) => {
    if (!row.ok) return { ...row.item, error: row.error };

    const triage = row.triage;
    const item = row.item;

    let issue_url = null;
    let issue_error = null;
    if (create_issue) {
      try {
        issue_url = await createQueueIssue(item, triage);
      } catch (err) {
        issue_error = err.message || "Failed to create issue";
      }
    }

    return { ...item, ...triage, issue_url, issue_error };
  });

  const summary = results.reduce(
    (acc, r) => {
      if (r.status === "promote") acc.promote += 1;
      else if (r.status === "review") acc.review += 1;
      else if (r.status === "archive") acc.archive += 1;
      else acc.failed += 1;
      return acc;
    },
    { promote: 0, review: 0, archive: 0, failed: 0 }
  );

  let store = null;
  try {
    store = await persistGraceResults(results, "news-sync");
  } catch (e) {
    store = { error: e.message || String(e) };
  }

  let notion = null;
  if (process.env.NOTION_ON_NEWS_SYNC !== "false") {
    try {
      notion = await appendNotionFeedFromResults(results, { heading: `Grace — AHackaday (${new Date().toISOString().slice(0, 10)})` });
    } catch (e) {
      notion = { error: e.message || String(e) };
    }
  }

  return {
    ok: true,
    source_url,
    count: results.length,
    summary,
    results,
    store,
    notion,
  };
}
