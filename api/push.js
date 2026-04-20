export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { slug, content } = req.body || {};
  if (!slug || !content) return res.status(400).json({ error: "slug and content are required" });
  if (!/^[a-z0-9-]{3,60}$/.test(slug)) return res.status(400).json({ error: "Invalid slug format" });

  const ghToken = process.env.GITHUB_TOKEN;
  if (!ghToken) return res.status(500).json({ error: "GITHUB_TOKEN not configured" });

  const encode = (str) => Buffer.from(str).toString("base64");

  try {
    const { Octokit } = await import("@octokit/rest");
    const octokit = new Octokit({ auth: ghToken });

    // Create empty public repo
    await octokit.repos.createForAuthenticatedUser({
      name: slug,
      private: false,
      description: `cantinasec plugin: /cantinasec:${slug}`,
      auto_init: true,
    });

    // GitHub needs a moment to init the default branch
    await new Promise((r) => setTimeout(r, 2000));

    // Get the SHA of the initial commit so we can update files
    const { data: ref } = await octokit.git.getRef({ owner: "aidan269", repo: slug, ref: "heads/main" });
    const baseSha = ref.object.sha;

    // Write SKILL.md
    await octokit.repos.createOrUpdateFileContents({
      owner: "aidan269",
      repo: slug,
      path: `skills/${slug}/SKILL.md`,
      message: `feat: add ${slug} SKILL.md`,
      content: encode(content),
    });

    // Write command shim
    const shim = `---\ndescription: Run the ${slug} cantinasec security skill\nallowed-tools: Bash, Grep, Glob, Read, WebFetch, WebSearch\n---\n\nRun the \`${slug}\` skill.\n`;
    await octokit.repos.createOrUpdateFileContents({
      owner: "aidan269",
      repo: slug,
      path: `commands/${slug}.md`,
      message: `feat: add ${slug} command shim`,
      content: encode(shim),
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
