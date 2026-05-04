import { normalizeEnvValue } from "../lib/envNormalize.js";

const DEFAULT_OWNER = process.env.NEWS_QUEUE_REPO_OWNER || "aidan269";
const DEFAULT_REPO = process.env.NEWS_QUEUE_REPO || "grace.ai";
const CACHE_TTL_MS = 45_000;
const issueListCache = new Map();

function extractUrls(text) {
  const s = text || "";
  return [...s.matchAll(/https?:\/\/[^\s)\]>'"]+/gi)].map((m) => m[0]);
}

function pickExternalUrlFromText(text) {
  const urls = extractUrls(text);
  if (!urls.length) return null;

  const ah = urls.filter((u) =>
    /(ahackaday\.news|ahackaday-site\.vercel\.app)\/incident\//i.test(u)
  );
  if (ah.length) return ah[0];

  const nonGh = urls.filter((u) => !/^https?:\/\/(www\.)?github\.com\//i.test(u));
  if (nonGh.length) return nonGh[0];

  return null;
}

function normalizeQueueTitle(raw, maxLen = 118) {
  const text = String(raw || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&rsquo;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "Untitled";
  const noLabel = text.replace(/^\[[^\]]+\]\s*/i, "").trim();
  const deduped = noLabel
    .replace(/\b(.{16,}?)\s+\1\b/gi, "$1")
    .replace(/\b([A-Z][^.]{22,}?)\s+\1\b/g, "$1")
    .trim();
  const head = deduped.split(/(?<=[.!?])\s+|(?<=\bago)\s+/i).filter(Boolean)[0] || deduped;
  if (head.length <= maxLen) return head;
  return `${head.slice(0, maxLen - 1).trimEnd()}…`;
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  res.setHeader("Access-Control-Allow-Origin", "*");

  const params = req.method === "GET" ? req.query || {} : req.body || {};
  const owner = params.owner || DEFAULT_OWNER;
  const repo = params.repo || DEFAULT_REPO;
  const limit = Math.min(Math.max(parseInt(params.limit || "30", 10), 1), 50);
  const q = (params.q || "").trim().toLowerCase();
  const skipCache = params.skip_cache === "1" || params.skip_cache === "true";

  let labels = params.labels;
  if (labels === undefined || labels === null) labels = "news-intake";
  if (labels === "all" || labels === "*") labels = "";

  const ghToken = normalizeEnvValue(process.env.GITHUB_TOKEN);
  if (!ghToken) {
    return res.status(200).json({
      ok: true,
      owner,
      repo,
      count: 0,
      items: [],
      auth: "none",
      notice: "Set GITHUB_TOKEN to list queue issues.",
    });
  }

  const cacheKey = `${owner}/${repo}|${labels || "__all__"}|${limit}`;
  const now = Date.now();
  let rawIssues = null;
  let cached = false;

  if (!skipCache) {
    const hit = issueListCache.get(cacheKey);
    if (hit && now - hit.ts < CACHE_TTL_MS) {
      rawIssues = hit.issues;
      cached = true;
    }
  } else {
    issueListCache.delete(cacheKey);
  }

  try {
    if (!rawIssues) {
      const qs = new URLSearchParams({
        state: "open",
        per_page: String(limit),
        sort: "updated",
        direction: "desc",
      });
      if (labels) qs.set("labels", labels);

      const apiUrl = `https://api.github.com/repos/${owner}/${repo}/issues?${qs.toString()}`;
      const headers = {
        Accept: "application/vnd.github+json",
        "User-Agent": "grace-queue-feed",
        Authorization: `Bearer ${ghToken}`,
      };

      const ghRes = await fetch(apiUrl, { headers, signal: AbortSignal.timeout(12000) });
      if (!ghRes.ok) {
        return res.status(502).json({
          ok: false,
          error: `GitHub API ${ghRes.status}`,
        });
      }
      rawIssues = await ghRes.json();
      issueListCache.set(cacheKey, { ts: now, issues: rawIssues });
    }

    const items = [];
    for (const issue of rawIssues || []) {
      if (issue.pull_request) continue;
      const hay = [issue.title || "", issue.body || ""].join("\n");
      const incident = pickExternalUrlFromText(hay);
      const row = {
        source: "github-queue",
        title: normalizeQueueTitle(issue.title || "Untitled"),
        url: incident || issue.html_url,
        issue_url: issue.html_url,
      };
      if (q) {
        const hayL = `${row.title}\n${row.url}\n${row.issue_url}`.toLowerCase();
        if (!hayL.includes(q)) continue;
      }
      items.push(row);
    }

    return res.status(200).json({
      ok: true,
      owner,
      repo,
      labels: labels || null,
      count: items.length,
      items,
      cached,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || "queue_feed_failed" });
  }
}
