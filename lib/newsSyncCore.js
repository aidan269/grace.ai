import Anthropic from "@anthropic-ai/sdk";
import {
  computeAndStoreStoryRelated,
  persistGraceResults,
  supabaseAdmin,
  upsertPromptVersion,
  writeRunAudit,
} from "./intelStore.js";
import { postSlackFeedFromResults } from "./slackSink.js";
import { normalizeEnvValue } from "./envNormalize.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const DEFAULT_SOURCE_URL = "https://www.ahackaday.news/";
const DEFAULT_RSS_SOURCES = [
  "https://www.cisa.gov/news-events/cybersecurity-advisories/all.xml",
  "https://krebsonsecurity.com/feed/",
  "https://blog.talosintelligence.com/rss/",
  "https://unit42.paloaltonetworks.com/feed/",
  "https://feeds.feedburner.com/TheHackersNews",
  "https://www.bleepingcomputer.com/feed/",
  "https://isc.sans.edu/rssfeed_full.xml",
];
const CISA_KEV_URL = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";
const DEFAULT_OWNER = process.env.NEWS_QUEUE_REPO_OWNER || "aidan269";
const DEFAULT_REPO = process.env.NEWS_QUEUE_REPO || "grace.ai";
const PROMPT_VERSION = "v2.0.0";

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withOneRetry(label, fn, onRetry) {
  try {
    return await fn();
  } catch (firstErr) {
    if (onRetry) onRetry({ label, attempt: 1, error: firstErr.message || String(firstErr) });
    await sleep(250);
    return await fn();
  }
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
  const score = parseInt((txt.match(/score:\s*([0-4])/i) || [, "2"])[1], 10);
  const slug = (txt.match(/slug:\s*([a-z][a-z0-9-]{2,60})/i) || [, "cl-plugin"])[1].toLowerCase();
  const statusMatch = (txt.match(/status:\s*(archive|review|promote)/i) || [])[1];
  const status = statusMatch ? statusMatch.toLowerCase() : (score >= 3 ? "promote" : score === 2 ? "review" : "archive");
  const why = (txt.match(/why:\s*(.+)/i) || [, "No rationale produced."])[1].trim();
  const q1 = (txt.match(/q1:\s*(.+)/i) || [, ""])[1].trim();
  const q2 = (txt.match(/q2:\s*(.+)/i) || [, ""])[1].trim();
  return { score, slug, status, why, q1, q2, raw: txt };
}

function pickAll(regex, text) {
  const out = [];
  let m;
  while ((m = regex.exec(text)) !== null) out.push(m);
  return out;
}

function decodeXml(text = "") {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseRssItems(xmlText, sourceName, maxItems = 20) {
  const items = [];
  const entries = [...String(xmlText || "").matchAll(/<item[\s\S]*?<\/item>/gi)];
  for (const m of entries.slice(0, maxItems)) {
    const block = m[0];
    const title = decodeXml((block.match(/<title>([\s\S]*?)<\/title>/i) || [,""])[1]).replace(/<[^>]+>/g, " ").trim();
    const link = decodeXml((block.match(/<link>([\s\S]*?)<\/link>/i) || [,""])[1]).trim();
    const desc = decodeXml((block.match(/<description>([\s\S]*?)<\/description>/i) || [,""])[1]).replace(/<[^>]+>/g, " ").trim();
    if (!title || !link) continue;
    items.push({
      source: sourceName,
      url: link,
      title,
      summary: desc.slice(0, 900),
      type: "rss",
    });
  }
  return items;
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
    const url = href.startsWith("http") ? href : `https://www.ahackaday.news${href.startsWith("/") ? "" : "/"}${href}`;
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

async function fetchAhackadayItems(sourceUrl, maxItems) {
  const htmlRes = await fetch(sourceUrl, { signal: AbortSignal.timeout(10000) });
  if (!htmlRes.ok) throw new Error(`Failed to fetch source: ${htmlRes.status}`);
  const html = await htmlRes.text();
  return extractItemsFromHtml(html, maxItems);
}

async function fetchRssBundleItems(maxItems, feedUrls) {
  const urls = (feedUrls && feedUrls.length ? feedUrls : DEFAULT_RSS_SOURCES).slice(0, 6);
  const perFeed = Math.max(4, Math.ceil(maxItems / Math.max(1, urls.length)));
  const all = [];
  for (const u of urls) {
    try {
      const res = await fetch(u, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue;
      const xml = await res.text();
      const host = new URL(u).hostname.replace(/^www\./, "");
      all.push(...parseRssItems(xml, `rss:${host}`, perFeed));
    } catch {}
  }
  return all.slice(0, maxItems);
}

async function fetchNvdItems(maxItems) {
  const now = new Date();
  const since = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const fmt = (d) => d.toISOString().slice(0, 19) + ".000";
  const url = `https://services.nvd.nist.gov/rest/json/cves/2.0?pubStartDate=${fmt(since)}&pubEndDate=${fmt(now)}&resultsPerPage=${maxItems}&cvssV3Severity=HIGH`;
  const res = await fetch(url, { signal: AbortSignal.timeout(14000) });
  if (!res.ok) throw new Error(`nvd_fetch_${res.status}`);
  const json = await res.json();
  return (json?.vulnerabilities || []).slice(0, maxItems).map((entry) => {
    const cve = entry.cve || {};
    const cveId = cve.id || "CVE-????-?????";
    const desc = ((cve.descriptions || []).find((d) => d.lang === "en") || {}).value || "";
    const cvssScore = cve.metrics?.cvssMetricV31?.[0]?.cvssData?.baseScore
      ?? cve.metrics?.cvssMetricV30?.[0]?.cvssData?.baseScore
      ?? null;
    return {
      source: "nvd",
      url: `https://nvd.nist.gov/vuln/detail/${cveId}`,
      title: `${cveId} ${desc.slice(0, 120)}`.trim(),
      summary: desc.slice(0, 900),
      severity: cvssScore >= 9 ? "critical" : cvssScore >= 7 ? "high" : "medium",
      type: "cve",
      published_at: cve.published || null,
    };
  });
}

async function fetchRedditItems(maxItems) {
  const subs = ["netsec", "cybersecurity"];
  const perSub = Math.ceil(maxItems / subs.length);
  const items = [];
  for (const sub of subs) {
    try {
      const res = await fetch(`https://www.reddit.com/r/${sub}/new.json?limit=${perSub}`, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; GraceNewsSync/1.0)" },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;
      const json = await res.json();
      for (const child of (json?.data?.children || []).slice(0, perSub)) {
        const post = child.data || {};
        if (!post.title || (post.score || 0) < 10) continue;
        items.push({
          source: `reddit:${sub}`,
          url: post.url && !post.url.includes("reddit.com") ? post.url : `https://www.reddit.com${post.permalink}`,
          title: String(post.title || "").trim(),
          summary: post.selftext ? post.selftext.slice(0, 400) : "",
          type: "social",
          published_at: post.created_utc ? new Date(post.created_utc * 1000).toISOString() : null,
        });
      }
    } catch {}
  }
  return items.slice(0, maxItems);
}

async function fetchCisaKevItems(maxItems) {
  const res = await fetch(CISA_KEV_URL, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`kev_fetch_${res.status}`);
  const json = await res.json();
  const vulns = Array.isArray(json?.vulnerabilities) ? json.vulnerabilities : [];
  return vulns.slice(0, maxItems).map((v) => ({
    source: "cisa-kev",
    url: "https://www.cisa.gov/known-exploited-vulnerabilities-catalog",
    title: `${v.vendorProject || "Unknown"} ${v.product || ""} ${v.cveID || ""}`.trim(),
    summary: `${v.shortDescription || ""} Required action due: ${v.requiredAction || ""}`.trim(),
    severity: "high",
    type: "kev",
    published_at: v.dateAdded || null,
  }));
}

async function loadCandidates({ source_url, max_items, source_mode, rss_sources }, onRetry) {
  if (source_mode === "rss") {
    return withOneRetry("rss_fetch", () => fetchRssBundleItems(max_items, rss_sources), onRetry);
  }
  if (source_mode === "kev") {
    return withOneRetry("kev_fetch", () => fetchCisaKevItems(max_items), onRetry);
  }
  if (source_mode === "nvd") {
    return withOneRetry("nvd_fetch", () => fetchNvdItems(max_items), onRetry);
  }
  if (source_mode === "reddit" || source_mode === "social") {
    return withOneRetry("reddit_fetch", () => fetchRedditItems(max_items), onRetry);
  }
  if (source_mode === "mixed") {
    const [ah, rss, kev, nvd, reddit] = await Promise.all([
      withOneRetry("ahackaday_fetch", () => fetchAhackadayItems(source_url, Math.ceil(max_items * 0.30)), onRetry),
      withOneRetry("rss_fetch", () => fetchRssBundleItems(Math.ceil(max_items * 0.30), rss_sources), onRetry),
      withOneRetry("kev_fetch", () => fetchCisaKevItems(Math.ceil(max_items * 0.15)), onRetry),
      withOneRetry("nvd_fetch", () => fetchNvdItems(Math.ceil(max_items * 0.15)), onRetry).catch(() => []),
      withOneRetry("reddit_fetch", () => fetchRedditItems(Math.ceil(max_items * 0.10)), onRetry).catch(() => []),
    ]);
    const merged = [...ah, ...rss, ...kev, ...nvd, ...reddit];
    const seen = new Set();
    return merged.filter((x) => {
      const k = `${x.url}|${x.title}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, max_items);
  }
  return withOneRetry("ahackaday_fetch", () => fetchAhackadayItems(source_url, max_items), onRetry);
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
  const ghToken = normalizeEnvValue(process.env.GITHUB_TOKEN);
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
  const run_id = body?.run_id || `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const failures = {
    source_fetch: [],
    triage: [],
    issue_create: [],
    store: [],
    slack: [],
    retries: [],
  };

  const source_url = body?.source_url || DEFAULT_SOURCE_URL;
  const source_mode = body?.source_mode || "ahackaday";
  const rss_sources = Array.isArray(body?.rss_sources) ? body.rss_sources : undefined;
  const max_items = Math.min(Math.max(parseInt(body?.max_items || "8", 10), 1), 30);
  const create_issue = body?.create_issue !== false;
  const assess_concurrency = Math.min(Math.max(parseInt(body?.assess_concurrency || "3", 10), 1), 6);
  const issue_concurrency = Math.min(Math.max(parseInt(body?.issue_concurrency || "3", 10), 1), 6);

  await upsertPromptVersion("news_sync_assess_system", PROMPT_VERSION, ASSESS_SYSTEM);
  const candidates = await loadCandidates(
    { source_url, max_items, source_mode, rss_sources },
    (r) => failures.retries.push(r)
  ).catch((e) => {
    failures.source_fetch.push(e.message || String(e));
    throw e;
  });

  const triaged = await mapPool(candidates, assess_concurrency, async (item) => {
    try {
      const triage = await assessItem(item);
      return { ok: true, item, triage };
    } catch (err) {
      failures.triage.push({ title: item.title || null, url: item.url || null, error: err.message || "Triage failed" });
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
        failures.issue_create.push({ title: item.title || null, url: item.url || null, error: issue_error });
      }
    }
    return { ...item, ...triage, issue_url, issue_error, run_id };
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
    store = await persistGraceResults(results, "news-sync", run_id);
    const sb = supabaseAdmin();
    if (sb && store?.story_ids?.length) {
      await computeAndStoreStoryRelated(sb, store.story_ids);
    }
  } catch (e) {
    store = { error: e.message || String(e) };
    failures.store.push(store.error);
  }

  let slack = null;
  if (process.env.SLACK_ON_NEWS_SYNC !== "false") {
    try {
      slack = await withOneRetry(
        "slack_post",
        () =>
          postSlackFeedFromResults(results, {
            heading: `Grace — ${source_mode === "mixed" ? "Mixed (AH+RSS+KEV+NVD+Reddit)" : source_mode.toUpperCase()} (${new Date().toISOString().slice(0, 10)})`,
          }),
        (r) => failures.retries.push(r)
      );
    } catch (e) {
      slack = { error: e.message || String(e) };
      failures.slack.push(slack.error);
    }
  }

  await writeRunAudit(run_id, "news-sync", "completed", {
    source_mode,
    source_url,
    max_items,
    summary,
    failure_count: Object.values(failures).reduce((n, arr) => n + arr.length, 0),
  });

  return {
    ok: true,
    run_id,
    source_url,
    source_mode,
    count: results.length,
    summary,
    results,
    store,
    slack,
    failures,
  };
}
