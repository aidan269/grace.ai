import { normalizeEnvValue } from "../lib/envNormalize.js";

const BRAVE_KEY = normalizeEnvValue(process.env.BRAVE_API_KEY);
const TWITTER_RE = /^https?:\/\/(x\.com|twitter\.com)\//i;
const GITHUB_ISSUE_RE =
  /^https?:\/\/(www\.)?github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/i;

function extractUrls(text) {
  const s = text || "";
  const matches = [...s.matchAll(/https?:\/\/[^\s)\]>'"]+/gi)].map((m) => m[0]);
  return matches;
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

async function resolveGitHubIssueUrl(issueUrl) {
  const m = issueUrl.match(GITHUB_ISSUE_RE);
  if (!m) return { resolvedUrl: issueUrl, note: null };

  const owner = m[2];
  const repo = m[3];
  const issue_number = m[4];

  const ghToken = normalizeEnvValue(process.env.GITHUB_TOKEN);
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/issues/${issue_number}`;
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "grace-content-resolver",
  };
  if (ghToken) headers.Authorization = `Bearer ${ghToken}`;

  const res = await fetch(apiUrl, { headers, signal: AbortSignal.timeout(12000) });
  if (!res.ok) return { resolvedUrl: issueUrl, note: `github_api_${res.status}` };

  const issue = await res.json();
  const haystack = [
    issue?.title || "",
    issue?.body || "",
    ...(Array.isArray(issue?.labels)
      ? issue.labels.map((l) => (typeof l === "string" ? l : l?.name)).filter(Boolean)
      : []),
  ].join("\n");

  const picked = pickExternalUrlFromText(haystack);
  if (picked) return { resolvedUrl: picked, note: "resolved_from_github_issue" };

  return { resolvedUrl: issueUrl, note: "no_external_url_found_in_issue" };
}

async function braveSearch(query) {
  if (!BRAVE_KEY) return null;
  try {
    const res = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`,
      {
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip",
          "X-Subscription-Token": BRAVE_KEY,
        },
        signal: AbortSignal.timeout(8000),
      }
    );
    const json = await res.json();
    return (json?.web?.results || [])
      .map((r) => `${r.title}\n${r.url}\n${r.description || ""}`)
      .join("\n\n")
      .slice(0, 6000);
  } catch {
    return null;
  }
}

async function fetchPage(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" },
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });
    const text = await res.text();
    return text
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 6000);
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  res.setHeader("Access-Control-Allow-Origin", "*");

  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: "url is required" });

  let fetchUrl = url;
  let resolvedFrom = null;
  if (GITHUB_ISSUE_RE.test(url)) {
    try {
      const resolved = await resolveGitHubIssueUrl(url);
      fetchUrl = resolved.resolvedUrl;
      resolvedFrom = resolved.note;
    } catch {
      fetchUrl = url;
    }
  }

  let content = null;

  if (TWITTER_RE.test(fetchUrl)) {
    content = await braveSearch(`${fetchUrl} security vulnerability`) || await braveSearch(fetchUrl);
  } else {
    const page = await fetchPage(fetchUrl);
    content = (page && page.length > 200) ? page : await braveSearch(fetchUrl);
  }

  return res.status(200).json({
    content: content || null,
    resolvedUrl: fetchUrl !== url ? fetchUrl : null,
    resolvedFrom,
  });
}
