import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const ASSESS_SYSTEM = `You are Grace, Cantina's security marketing specialist.
Give a concise virality and campaign assessment for security incidents.

Return plain text in this exact shape:
score: <0-4 integer>
slug: <kebab-case slug starting with cl or cla>
status: <archive|review|promote>
why: <1 sentence>
q1: <first scoping question with [options]>
q2: <second scoping question with [options]>

Rules:
- score 0-1 => archive
- score 2 => review
- score 3-4 => promote
- slug must be 3-6 words, include the attack vector or affected tech`;

const DEFAULT_OWNER = process.env.NEWS_QUEUE_REPO_OWNER || "aidan269";
const DEFAULT_REPO = process.env.NEWS_QUEUE_REPO || "grace.ai";

function normalizeItems(body) {
  if (!body) return [];
  if (Array.isArray(body.items)) return body.items;
  return [body];
}

function parseAssess(raw) {
  const text = raw || "";
  const scoreMatch = text.match(/score:\s*([0-4])/i);
  const slugMatch = text.match(/slug:\s*([a-z][a-z0-9-]{2,60})/i);
  const statusMatch = text.match(/status:\s*(archive|review|promote)/i);
  const whyMatch = text.match(/why:\s*(.+)/i);
  const q1Match = text.match(/q1:\s*(.+)/i);
  const q2Match = text.match(/q2:\s*(.+)/i);

  const score = scoreMatch ? parseInt(scoreMatch[1], 10) : 2;
  const status = statusMatch ? statusMatch[1].toLowerCase() : (score >= 3 ? "promote" : score === 2 ? "review" : "archive");
  return {
    score,
    slug: slugMatch ? slugMatch[1].toLowerCase() : null,
    status,
    why: whyMatch ? whyMatch[1].trim() : "No rationale produced.",
    q1: q1Match ? q1Match[1].trim() : "",
    q2: q2Match ? q2Match[1].trim() : "",
    raw: text,
  };
}

function buildAssessPrompt(item) {
  return [
    `source: ${item.source || "unknown"}`,
    `url: ${item.url || "n/a"}`,
    `title: ${item.title || "untitled"}`,
    `summary: ${item.summary || item.description || "n/a"}`,
    `severity: ${item.severity || "unknown"}`,
    `type: ${item.type || "unknown"}`,
    `published_at: ${item.published_at || item.publishedAt || "unknown"}`,
    `engagement: ${JSON.stringify(item.engagement || {})}`,
    `tags: ${(item.tags || []).join(", ") || "none"}`
  ].join("\n");
}

async function assessItem(item) {
  const response = await anthropic.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 300,
    system: ASSESS_SYSTEM,
    messages: [{ role: "user", content: buildAssessPrompt(item) }],
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

  const titlePrefix = triage.status === "promote" ? "PROMOTE" : triage.status === "review" ? "REVIEW" : "ARCHIVE";
  const issueTitle = `[${titlePrefix}] ${item.title || item.url || "Untitled incident"}`.slice(0, 250);

  const issueBody = [
    "## Incident",
    `- Source: ${item.source || "unknown"}`,
    `- URL: ${item.url || "n/a"}`,
    `- Severity: ${item.severity || "unknown"}`,
    `- Type: ${item.type || "unknown"}`,
    `- Published: ${item.published_at || item.publishedAt || "unknown"}`,
    "",
    "## Summary",
    item.summary || item.description || "No summary provided.",
    "",
    "## Grace Triage",
    `- Score: ${triage.score}/4`,
    `- Status: ${triage.status}`,
    `- Slug: ${triage.slug || "n/a"}`,
    `- Why: ${triage.why}`,
    "",
    "## Scoping Questions",
    `1. ${triage.q1 || "n/a"}`,
    `2. ${triage.q2 || "n/a"}`,
    "",
    "## Raw Assess Output",
    "```",
    triage.raw || "",
    "```",
  ].join("\n");

  const labels = ["news-intake", `triage:${triage.status}`];
  if (item.severity) labels.push(`severity:${String(item.severity).toLowerCase()}`);
  if (item.type) labels.push(`type:${String(item.type).toLowerCase().replace(/\s+/g, "-")}`);

  const { data } = await octokit.issues.create({
    owner: DEFAULT_OWNER,
    repo: DEFAULT_REPO,
    title: issueTitle,
    body: issueBody,
    labels,
  });

  return data.html_url;
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
  }

  const items = normalizeItems(req.body).filter((x) => x && (x.url || x.title));
  if (!items.length) {
    return res.status(400).json({ error: "Provide an item or items[] with at least url or title" });
  }

  const createIssues = req.body?.create_issue !== false;
  const results = [];

  for (const item of items) {
    try {
      const triage = await assessItem(item);
      const issue_url = createIssues ? await createQueueIssue(item, triage) : null;
      results.push({
        id: item.id || null,
        title: item.title || null,
        url: item.url || null,
        score: triage.score,
        status: triage.status,
        slug: triage.slug,
        why: triage.why,
        q1: triage.q1,
        q2: triage.q2,
        issue_url,
      });
    } catch (err) {
      results.push({
        id: item.id || null,
        title: item.title || null,
        url: item.url || null,
        error: err.message || "Failed to triage item",
      });
    }
  }

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

  return res.status(200).json({
    ok: true,
    count: results.length,
    summary,
    results,
  });
}
