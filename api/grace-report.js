import { getIncidentReport, getWorkspaceReport } from "../lib/graceStore.js";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  res.setHeader("Access-Control-Allow-Origin", "*");

  const workspaceId = req.query?.workspace_id;
  const incidentKey = req.query?.incident_key ? String(req.query.incident_key) : "";
  if (!workspaceId) return res.status(400).json({ error: "workspace_id is required" });

  try {
    const report = incidentKey
      ? await getIncidentReport(workspaceId, incidentKey)
      : await getWorkspaceReport(workspaceId);
    return res.status(200).json({ ok: true, ...report });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || "grace_report_failed" });
  }
}
