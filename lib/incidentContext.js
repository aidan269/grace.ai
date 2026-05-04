function safeUrl(raw) {
  try {
    return new URL(String(raw || "").trim());
  } catch {
    return null;
  }
}

function pickSeverity(text) {
  const t = String(text || "").toLowerCase();
  if (/(critical|actively exploited|in the wild|worm|ransomware|zero[-\s]?day)/.test(t)) return "critical";
  if (/(high|exploit|token leak|credential leak|supply chain|rce)/.test(t)) return "high";
  if (/(medium|advisory|vulnerability|issue|patch)/.test(t)) return "medium";
  return "unknown";
}

function pickType(text) {
  const t = String(text || "").toLowerCase();
  if (/(token|credential|key leak|secret)/.test(t)) return "credential_exposure";
  if (/(supply chain|dependency|package|npm|pypi)/.test(t)) return "supply_chain";
  if (/(rce|remote code execution|command injection)/.test(t)) return "rce";
  if (/(phishing|social engineering)/.test(t)) return "phishing";
  if (/(malware|worm|trojan)/.test(t)) return "malware";
  return "incident";
}

function extractTokens(text, re) {
  const out = new Set();
  for (const m of String(text || "").matchAll(re)) out.add(m[0]);
  return [...out];
}

export function parseIncidentContext({ url, title = "", description = "" }) {
  const parsed = safeUrl(url);
  const sourceUrl = parsed ? parsed.toString() : String(url || "").trim();
  const host = parsed ? parsed.hostname.replace(/^www\./, "") : "";
  const joined = `${title}\n${description}\n${sourceUrl}`;
  const cves = extractTokens(joined, /\bCVE-\d{4}-\d{4,7}\b/gi);
  const ghsas = extractTokens(joined, /\bGHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}\b/gi);
  const ids = extractTokens(joined, /\b(?:INC|IR|AH)-\d{3,8}\b/gi);

  const severity = pickSeverity(joined);
  const incidentType = pickType(joined);
  const confidence =
    title && severity !== "unknown" ? "high" : title || description ? "partial" : "low";

  const summary = (description || title || "No summary available").slice(0, 240);

  return {
    sourceUrl,
    sourceHost: host || "unknown",
    title: title || "Incident context",
    summary,
    severity,
    incidentType,
    cves,
    ghsas,
    trackingIds: ids,
    confidence,
  };
}
