import { normalizeEnvValue } from "../lib/envNormalize.js";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();
  res.setHeader("Access-Control-Allow-Origin", "*");

  const { slug, content } = req.body || {};
  if (!slug || !content) return res.status(400).json({ error: "slug and content required" });

  const ghToken = normalizeEnvValue(process.env.GITHUB_TOKEN);
  if (!ghToken) return res.status(500).json({ error: "GITHUB_TOKEN not configured" });

  try {
    const { Octokit } = await import("@octokit/rest");
    const octokit = new Octokit({ auth: ghToken });

    const { data } = await octokit.gists.create({
      description: `/cantinasec:${slug} — cantina security skill`,
      public: true,
      files: { "SKILL.md": { content } },
    });

    return res.status(200).json({ gistId: data.id });
  } catch (err) {
    console.error("Share error:", err);
    return res.status(500).json({ error: err.message });
  }
}
