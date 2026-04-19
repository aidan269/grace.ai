import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const BRAVE_KEY = process.env.BRAVE_API_KEY;
const TWITTER_RE = /^https?:\/\/(x\.com|twitter\.com)\//i;

const STEPS = {
  virality: `You are Grace, Cantina's AI security marketing intern.

Given a URL and its content, do ONLY the virality check — nothing else.

Score the source on 4 signals, 1–2 sentences each:
- **Shock stat**: is there a concrete number or dollar impact?
- **Named actors**: specific handles, repos, wallet addresses, malware families?
- **Self-check hook**: can a user run a command to see if they're affected?
- **Novelty**: first public report, new technique, or a rehash?

End with a single verdict line: "X/4 strong signals — [proceed / weak, explain why]"

Be concise. No headers. Just the 4 bullets and the verdict.`,

  slug: `You are Grace, Cantina's AI security marketing intern.

Given a URL and its content, propose a plugin slug — nothing else.

Rules:
- kebab-case, 3–6 words
- Must start with "cl" or "cla" (e.g. clawzero, clawrmes, clowasp, clabridge)
- Should reference the attack vector or technology, not just the victim

Output format (exactly):
One sentence explaining your reasoning.
\`suggested-slug-here\`

Nothing else.`,

  plugin: `You are Grace, Cantina's AI security marketing intern.

Given a URL, its content, and a confirmed slug, write the full SKILL.md — nothing else.

All 8 sections required:

# {Threat Name} Detection

## Overview
2–3 sentences: what it is, impact, who's affected.

## Key Details
- **CVE(s):** CVE-YYYY-NNNNN or N/A
- **Affected Versions:** list all known
- **Discovered:** date
- **Severity:** CVSS or qualitative
- **C2 / Malicious Infrastructure:** domains/IPs/wallets if known
- **Source:** original URL

## Attack Mechanism
Technical: delivery vector, payload, persistence, exfiltration. Be specific.

## Detection Methodology
≥5 numbered steps, each with a concrete bash/cast command.

## Risk Classification
| Finding | Risk Level |
|---------|-----------|
| ... | **CRITICAL** |
| ... | **HIGH** |
| ... | **MEDIUM** |
| ... | **NONE** |

**CRITICAL** → ...
**HIGH** → ...
**MEDIUM** → ...
**NONE** → ...

## Remediation
Numbered steps. Primary fix first.

## Community Intelligence
What the infosec community has validated, disputed, or added beyond the source.

## References
- source URL
- CVE link
- vendor advisories
- notable threads

Practitioner-to-practitioner. No fluff. End with [PUSH_READY] on its own line.`,
};

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

async function resolveContent(url) {
  if (TWITTER_RE.test(url)) {
    const searched = await braveSearch(`${url} security vulnerability site:x.com OR site:twitter.com`);
    return searched || (await braveSearch(url));
  }
  const page = await fetchPage(url);
  if (page && page.length > 200) return page;
  return await braveSearch(url);
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { url, step = "virality", slug } = req.body || {};
  if (!url) return res.status(400).json({ error: "url is required" });
  if (!STEPS[step]) return res.status(400).json({ error: "invalid step" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");

  const content = await resolveContent(url);
  let userMessage = `URL: ${url}\n\n`;
  userMessage += content
    ? `Retrieved content:\n${content}`
    : `(Could not retrieve content — use your training knowledge.)`;
  if (slug) userMessage += `\n\nConfirmed plugin slug: ${slug}`;

  try {
    const stream = await client.messages.stream({
      model: "claude-opus-4-7",
      max_tokens: step === "plugin" ? 6000 : 800,
      system: STEPS[step],
      messages: [{ role: "user", content: userMessage }],
    });

    for await (const chunk of stream) {
      if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
        res.write(`data: ${JSON.stringify({ text: chunk.delta.text })}\n\n`);
      }
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    console.error("Grace error:", err);
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
}
