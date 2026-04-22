import { Client } from "@notionhq/client";

const NOTION_VERSION = "2022-06-28";

function notionClient() {
  const token = process.env.NOTION_INTEGRATION_TOKEN;
  if (!token) return null;
  return new Client({ auth: token, notionVersion: NOTION_VERSION });
}

/** Accept raw UUID or Notion page URL. */
export function normalizeNotionPageId(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const m = s.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (m) return m[1];
  const compact = s.replace(/-/g, "");
  if (/^[0-9a-f]{32}$/i.test(compact)) {
    return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
  }
  return null;
}

/**
 * Appends a dated section + bullets to a Notion page (feed log).
 * Share the page with your integration, then set NOTION_FEED_PAGE_ID.
 */
export async function appendNotionFeedFromResults(results, opts = {}) {
  const notion = notionClient();
  const pageId = normalizeNotionPageId(process.env.NOTION_FEED_PAGE_ID || "");
  if (!notion || !pageId) return { skipped: true, reason: "notion_not_configured" };

  const rows = (results || [])
    .filter((r) => !r.error && typeof r.score === "number")
    .sort((a, b) => (b.score || 0) - (a.score || 0));

  const topN = Math.min(Math.max(parseInt(process.env.NOTION_FEED_TOP_N || "12", 10), 1), 25);
  const top = rows.slice(0, topN);

  const heading =
    opts.heading || `Grace triage — ${new Date().toISOString().slice(0, 16)} UTC`;

  const children = [
    { type: "divider", divider: {} },
    {
      type: "heading_2",
      heading_2: {
        rich_text: [{ type: "text", text: { content: heading.slice(0, 1900) } }],
      },
    },
  ];

  for (const r of top) {
    const title = (r.title || r.url || "Untitled").slice(0, 180);
    const rich = [
      {
        type: "text",
        text: { content: `[${r.score}/4 · ${r.status || "n/a"}] ` },
      },
    ];
    if (r.url) {
      rich.push({
        type: "text",
        text: {
          content: title,
          link: { url: r.url },
        },
      });
    } else {
      rich.push({ type: "text", text: { content: title } });
    }
    if (r.why) {
      rich.push({
        type: "text",
        text: { content: ` — ${String(r.why).slice(0, 500)}` },
      });
    }
    children.push({
      type: "bulleted_list_item",
      bulleted_list_item: { rich_text: rich },
    });
  }

  if (children.length <= 2) {
    return { skipped: true, reason: "no_rows_to_post" };
  }

  await notion.blocks.children.append({
    block_id: pageId,
    children,
  });

  return { appended: top.length, page_id: pageId };
}
