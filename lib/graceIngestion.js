const PAGE_NODE_TYPES = new Set(["landing", "blog", "website"]);

function stripHtml(raw = "") {
  return String(raw)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function inferNodeType(kind = "") {
  const k = String(kind || "").toLowerCase();
  if (k === "gbp") return "gbp_profile";
  if (k === "competitor") return "competitor_page";
  if (k === "analytics") return "analytics_snapshot";
  if (k === "landing") return "landing_page";
  if (k === "blog") return "blog_page";
  if (k === "website") return "website_page";
  return "website_page";
}

function inferSourceSystem(kind = "") {
  const k = String(kind || "").toLowerCase();
  if (k === "gbp") return "google_business_profile";
  if (k === "analytics") return "ga_gsc";
  if (k === "competitor") return "competitor_crawl";
  return "website_crawl";
}

async function fetchPageContent(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; GraceIngestion/1.0)" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    return stripHtml(html).slice(0, 14000);
  } catch {
    return null;
  }
}

export async function buildCanonicalGraph({
  websiteUrls = [],
  landingPageUrls = [],
  blogUrls = [],
  competitorUrls = [],
  analyticsSnapshots = [],
  gbpSnapshot = null,
  topicCluster = null,
  locationTag = null,
}) {
  const urls = [
    ...websiteUrls.map((url) => ({ url, kind: "website" })),
    ...landingPageUrls.map((url) => ({ url, kind: "landing" })),
    ...blogUrls.map((url) => ({ url, kind: "blog" })),
    ...competitorUrls.map((url) => ({ url, kind: "competitor" })),
  ];

  const urlNodes = await Promise.all(
    urls.map(async ({ url, kind }) => {
      const content = await fetchPageContent(url);
      const entityTags = (content || "")
        .toLowerCase()
        .match(/\b[a-z][a-z0-9-]{3,}\b/g)
        ?.slice(0, 24) || [];
      return {
        node_type: inferNodeType(kind),
        url,
        title: url,
        topic_cluster: topicCluster,
        entity_tags: [...new Set(entityTags)],
        location_tag: locationTag,
        source_system: inferSourceSystem(kind),
        content_text: content,
        metadata: { ingested_from: "url" },
      };
    })
  );

  const analyticsNode = analyticsSnapshots.length
    ? {
        node_type: "analytics_snapshot",
        url: null,
        title: "GA/GSC Snapshot",
        topic_cluster: topicCluster,
        entity_tags: [],
        location_tag: locationTag,
        source_system: "ga_gsc",
        content_text: null,
        metadata: { snapshots: analyticsSnapshots },
      }
    : null;

  const gbpNode = gbpSnapshot
    ? {
        node_type: "gbp_profile",
        url: gbpSnapshot.profileUrl || null,
        title: gbpSnapshot.businessName || "Google Business Profile",
        topic_cluster: topicCluster,
        entity_tags: gbpSnapshot.categories || [],
        location_tag: locationTag || gbpSnapshot.location || null,
        source_system: "google_business_profile",
        content_text: gbpSnapshot.description || null,
        metadata: gbpSnapshot,
      }
    : null;

  return [...urlNodes, ...(analyticsNode ? [analyticsNode] : []), ...(gbpNode ? [gbpNode] : [])];
}

export function recommendationTypeFromNode(nodeType = "") {
  const t = String(nodeType || "");
  if (t === "gbp_profile") return "update_gbp";
  if (t === "blog_page" || t === "landing_page") return "refresh_page";
  if (PAGE_NODE_TYPES.has(t.replace("_page", ""))) return "add_schema_faq";
  if (t === "competitor_page") return "create_topic";
  return "improve_internal_links";
}
