export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  res.setHeader("Access-Control-Allow-Origin", "*");

  const slug = req.query.slug || (req.url || "").split("slug=")[1]?.split("&")[0];
  if (!slug || !/^[a-z][a-z0-9-]{2,50}$/.test(slug)) {
    return res.status(400).send("Invalid slug");
  }

  // Draft mode: content passed directly as base64 in the URL
  const draftParam = req.query.draft;
  let md, isDraft = false;

  if (draftParam) {
    try {
      md = Buffer.from(draftParam, "base64").toString("utf-8");
      isDraft = true;
    } catch {
      return res.status(400).send("Invalid draft content");
    }
  } else {
    const rawUrl = `https://raw.githubusercontent.com/aidan269/${slug}/main/skills/${slug}/SKILL.md`;
    try {
      const r = await fetch(rawUrl, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) return res.status(404).send("Plugin not found");
      md = await r.text();
    } catch {
      return res.status(500).send("Error fetching plugin");
    }
  }

  try {

    const overview = md.match(/## Overview\n([\s\S]*?)(?=\n##)/)?.[1]?.trim() || "";
    const title = md.match(/^# (.+)/m)?.[1] || slug;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — Grace by Cantina</title>
<meta property="og:title" content="${title}" />
<meta property="og:description" content="${overview.slice(0, 160)}" />
<meta property="og:site_name" content="Grace by Cantina" />
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',system-ui,sans-serif;background:#F9FAFB;color:#111827;min-height:100vh;-webkit-font-smoothing:antialiased}
nav{background:#fff;border-bottom:1px solid #E5E7EB;padding:0 40px;height:56px;display:flex;align-items:center;justify-content:space-between}
.nav-logo{font-weight:700;font-size:0.95rem;color:#111827;text-decoration:none}
.nav-badge{font-size:0.72rem;color:#9CA3AF;margin-left:6px}
.nav-back{font-size:0.82rem;color:#6B7280;text-decoration:none}
.nav-back:hover{color:#111827}
.container{max-width:760px;margin:0 auto;padding:40px 24px 80px}
.install-bar{display:flex;align-items:center;gap:12px;background:#fff;border:1px solid #E5E7EB;border-radius:10px;padding:14px 18px;margin-bottom:32px;box-shadow:0 1px 4px rgba(0,0,0,0.06)}
.install-cmd{font-family:'SF Mono','Fira Code',monospace;font-size:0.85rem;color:#111827;flex:1}
.copy-btn{font-family:inherit;font-size:0.78rem;font-weight:600;color:#fff;background:#0A0A0A;border:none;border-radius:6px;padding:7px 14px;cursor:pointer;transition:opacity 0.15s;white-space:nowrap}
.copy-btn:hover{opacity:0.8}
.skill-body{background:#fff;border:1px solid #E5E7EB;border-radius:12px;padding:36px 40px;box-shadow:0 1px 4px rgba(0,0,0,0.06)}
.skill-body h1{font-size:1.4rem;font-weight:700;letter-spacing:-0.02em;margin-bottom:24px;line-height:1.3}
.skill-body h2{font-size:1rem;font-weight:600;color:#374151;margin:28px 0 10px;padding-top:16px;border-top:1px solid #F3F4F6}
.skill-body h2:first-of-type{border-top:none;margin-top:0}
.skill-body p{font-size:0.9rem;line-height:1.75;color:#374151;margin:8px 0}
.skill-body ul,.skill-body ol{padding-left:20px;margin:8px 0}
.skill-body li{font-size:0.9rem;line-height:1.7;color:#374151;margin:4px 0}
.skill-body code{font-family:'SF Mono','Fira Code',monospace;font-size:0.78rem;background:#F3F4F6;border-radius:4px;padding:2px 6px}
.skill-body pre{background:#111827;color:#e5e7eb;border-radius:10px;padding:16px 18px;overflow-x:auto;margin:12px 0}
.skill-body pre code{background:none;padding:0;font-size:0.78rem;color:inherit}
.skill-body table{border-collapse:collapse;width:100%;margin:10px 0;font-size:0.85rem}
.skill-body th,.skill-body td{border:1px solid #E5E7EB;padding:8px 12px;text-align:left}
.skill-body th{background:#F9FAFB;font-weight:600}
.skill-body strong{font-weight:600}
.footer{text-align:center;margin-top:32px;font-size:0.78rem;color:#9CA3AF}
.footer a{color:#9CA3AF;text-decoration:none}
.footer a:hover{color:#374151}
</style>
</head>
<body>
<nav>
  <a class="nav-logo" href="/">Grace <span class="nav-badge">by Cantina</span></a>
  <a class="nav-back" href="/">← All plugins</a>
</nav>
<div class="container">
  ${isDraft ? `<div style="background:#FFF7ED;border:1px solid #FED7AA;border-radius:8px;padding:10px 16px;margin-bottom:16px;font-size:0.8rem;color:#92400E;display:flex;align-items:center;gap:8px;"><span style="font-weight:700">DRAFT</span> — not yet on GitHub. Share this link to preview.</div>` : ''}
  <div class="install-bar">
    <span class="install-cmd">/cantinasec:${slug}</span>
    <button class="copy-btn" onclick="navigator.clipboard.writeText('/cantinasec:${slug}').then(()=>{this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500)})">Copy</button>
    ${isDraft ? '' : `<a class="copy-btn" href="https://github.com/aidan269/${slug}" target="_blank" style="text-decoration:none;background:#F3F4F6;color:#374151">GitHub →</a>`}
  </div>
  <div class="skill-body" id="content"></div>
  <div class="footer">Built with <a href="/">Grace</a> · <a href="https://cantina.xyz" target="_blank">Cantina</a></div>
</div>
<script>
const md = ${JSON.stringify(md)};
document.getElementById('content').innerHTML = marked.parse(md);
</script>
</body>
</html>`);
  } catch {
    return res.status(500).send("Error rendering plugin");
  }
}
