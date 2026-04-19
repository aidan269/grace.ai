import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are Grace, Cantina's AI security marketing intern. You receive a URL and optional fetched content, then produce a cantinasec plugin — step by step, conversationally.

Structure your response in exactly these steps, each preceded by a [STEP] marker on its own line:

[STEP:Virality Check]
Score the source on 4 signals (1–2 sentences each):
- Shock stat: is there a concrete number/impact?
- Named actors: specific handles, repos, malware families?
- Self-check hook: can a user run a command to see if they're affected?
- Novelty: first public report or rehash?
End with a one-line verdict: "3/4 strong — proceeding" or explain if weak.

[STEP:Slug]
Propose the plugin slug (kebab-case, 3–6 words, must start with cl or cla to follow Cantina naming — e.g. clawzero, clawrmes, clowasp).
Emit [SLUG:{slug}] on its own line immediately after.

[STEP:Plugin]
Write the full SKILL.md. All 8 sections required:
# {Threat Name} Detection
## Overview
## Key Details (CVEs, affected versions, date, severity, C2/infra, source URL)
## Attack Mechanism
## Detection Methodology (≥5 numbered steps with concrete bash/cast commands)
## Risk Classification (table: CRITICAL / HIGH / MEDIUM / NONE)
## Remediation
## Community Intelligence
## References

Be technically precise — practitioner-to-practitioner. No fluff.

At the very end emit [PUSH_READY] on its own line.`;

async function fetchUrlContent(url) {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1)",
        "Accept": "text/html,application/xhtml+xml,*/*",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });
    const text = await res.text();
    // Strip tags, collapse whitespace, truncate
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
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { url } = req.body || {};
  if (!url) {
    return res.status(400).json({ error: "url is required" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");

  const pageContent = await fetchUrlContent(url);
  const userMessage = pageContent
    ? `URL: ${url}\n\nFetched content:\n${pageContent}`
    : `URL: ${url}\n\n(Could not fetch page content — use your training knowledge of this source.)`;

  try {
    const stream = await client.messages.stream({
      model: "claude-opus-4-7",
      max_tokens: 6000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });

    for await (const chunk of stream) {
      if (
        chunk.type === "content_block_delta" &&
        chunk.delta.type === "text_delta"
      ) {
        res.write(`data: ${JSON.stringify({ text: chunk.delta.text })}\n\n`);
      }
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    console.error("Grace stream error:", err);
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
}
