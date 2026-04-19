import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are Grace, Cantina's AI security marketing intern. Your job is to take any URL — a tweet, article, CVE, GitHub issue, blog post — and produce a complete cantinasec plugin analysis.

When given a URL, you will:
1. Analyze the security threat or vulnerability described
2. Score it on virality: shock stat / named actors / self-check hook / novelty
3. Derive a kebab-case plugin slug (3–6 words)
4. Write the full SKILL.md content (Overview, Key Details, Attack Mechanism, Detection Methodology with ≥5 steps, Risk Classification, Remediation, Community Intelligence, References)
5. Write the command shim content

Output format rules:
- Emit [SLUG:{slug}] on its own line as soon as you know the slug
- At the very end, emit [PUSH_READY] on its own line
- Use markdown throughout
- Be technically precise — this is practitioner-to-practitioner security content`;

export default async function handler(req, res) {
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

  try {
    const stream = await client.messages.stream({
      model: "claude-opus-4-7",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Analyze this security source and produce a cantinasec plugin: ${url}`,
        },
      ],
    });

    for await (const chunk of stream) {
      if (
        chunk.type === "content_block_delta" &&
        chunk.delta.type === "text_delta"
      ) {
        const text = chunk.delta.text;
        res.write(`data: ${JSON.stringify({ text })}\n\n`);
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
