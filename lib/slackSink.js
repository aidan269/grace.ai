function clean(s, n = 240) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  return `${t.slice(0, Math.max(0, n - 1))}…`;
}

function pickEmoji(status, score) {
  if (status === "promote" || score >= 3) return "🔥";
  if (status === "review" || score === 2) return "👀";
  return "🗂️";
}

function titleCase(s) {
  const t = String(s || "").toLowerCase();
  return t ? `${t.charAt(0).toUpperCase()}${t.slice(1)}` : "Unknown";
}

/**
 * Posts top scored rows into Slack via Incoming Webhook URL.
 * Env:
 * - SLACK_WEBHOOK_URL (required)
 * - SLACK_FEED_TOP_N (default 8)
 */
export async function postSlackFeedFromResults(results, opts = {}) {
  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (!webhook) return { skipped: true, reason: "slack_not_configured" };

  const rows = (results || [])
    .filter((r) => !r?.error && typeof r?.score === "number")
    .sort((a, b) => (b.score || 0) - (a.score || 0));
  if (!rows.length) return { skipped: true, reason: "no_rows_to_post" };

  const topN = Math.min(Math.max(parseInt(process.env.SLACK_FEED_TOP_N || "8", 10), 1), 20);
  const top = rows.slice(0, topN);
  const heading = clean(opts.heading || `Grace triage update — ${new Date().toISOString().slice(0, 16)} UTC`, 140);
  const summary = {
    promote: top.filter((r) => r.status === "promote").length,
    review: top.filter((r) => r.status === "review").length,
    archive: top.filter((r) => r.status === "archive").length,
  };

  const lines = top.map((r, i) => {
    const emoji = pickEmoji(r.status, r.score);
    const title = clean(r.title || r.url || "Untitled", 96);
    const why = clean(r.why || "No rationale", 140);
    const status = titleCase(r.status);
    const titleWithLink = r.url ? `<${r.url}|${title}>` : title;
    return `*${i + 1})* ${emoji} ${titleWithLink}\n• *${r.score}/4* · *${status}*  \n> ${why}`;
  });

  const payload = {
    text: heading,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: heading.slice(0, 150), emoji: true },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Top signals:* ${summary.promote} promote · ${summary.review} review · ${summary.archive} archive`,
        },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: lines.join("\n\n").slice(0, 2900) },
      },
    ],
  };

  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`slack_webhook_${res.status}${body ? `:${body.slice(0, 180)}` : ""}`);
  }
  return { sent: top.length };
}
