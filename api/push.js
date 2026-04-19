import { execSync } from "child_process";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { slug, skillContent, commandContent } = req.body || {};
  if (!slug || !skillContent || !commandContent) {
    return res.status(400).json({ error: "slug, skillContent, and commandContent are required" });
  }

  // Sanitize slug — alphanumeric and hyphens only
  if (!/^[a-z0-9-]{3,60}$/.test(slug)) {
    return res.status(400).json({ error: "Invalid slug format" });
  }

  const ghToken = process.env.GITHUB_TOKEN;
  if (!ghToken) {
    return res.status(500).json({ error: "GITHUB_TOKEN not configured" });
  }

  try {
    const { Octokit } = await import("@octokit/rest");
    const octokit = new Octokit({ auth: ghToken });

    // Create repo from grace template
    await octokit.repos.createUsingTemplate({
      template_owner: "aidan269",
      template_repo: "grace",
      owner: "aidan269",
      name: slug,
      private: false,
      description: `cantinasec plugin: ${slug}`,
    });

    // Wait for GitHub to provision the repo
    await new Promise((r) => setTimeout(r, 3000));

    const encode = (str) => Buffer.from(str).toString("base64");

    // Write command shim
    await octokit.repos.createOrUpdateFileContents({
      owner: "aidan269",
      repo: slug,
      path: `commands/${slug}.md`,
      message: `feat: add ${slug} cantinasec plugin`,
      content: encode(commandContent),
    });

    // Write SKILL.md
    await octokit.repos.createOrUpdateFileContents({
      owner: "aidan269",
      repo: slug,
      path: `skills/${slug}/SKILL.md`,
      message: `feat: add ${slug} SKILL.md`,
      content: encode(skillContent),
    });

    return res.status(200).json({
      url: `https://github.com/aidan269/${slug}`,
      command: `/cantinasec:${slug}`,
    });
  } catch (err) {
    console.error("Push error:", err);
    return res.status(500).json({ error: err.message });
  }
}
