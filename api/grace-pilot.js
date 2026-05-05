import { ensureWorkspace, saveWeeklyRun } from "../lib/graceStore.js";

function isoDatePlus(days = 0) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  res.setHeader("Access-Control-Allow-Origin", "*");

  const body = req.body || {};
  if (!body.domain) return res.status(400).json({ error: "domain is required" });

  try {
    const workspace = await ensureWorkspace({
      domain: body.domain,
      name: body.workspace_name || body.domain,
      timezone: body.timezone || "UTC",
    });

    const runId = body.run_id || `pilot_${Date.now().toString(36)}`;
    const plan = {
      duration_days: 30,
      phases: [
        {
          name: "Week 1 baseline",
          start_date: isoDatePlus(0),
          end_date: isoDatePlus(6),
          tasks: [
            "Ingest website, landing pages, blog, competitor set, GBP snapshot, and GA/GSC baseline",
            "Lock north-star and leading indicator baseline values",
            "Review recommendation quality manually with marketing lead",
          ],
          exit_criteria: ">= 80% recommendations judged relevant by operator",
        },
        {
          name: "Week 2 execution",
          start_date: isoDatePlus(7),
          end_date: isoDatePlus(13),
          tasks: [
            "Approve and execute top 5 recommendations",
            "Track content production cycle time and review SLA",
            "Measure first movement in answer inclusion and freshness ratio",
          ],
          exit_criteria: ">= 3 recommendations moved to executed",
        },
        {
          name: "Week 3 calibration",
          start_date: isoDatePlus(14),
          end_date: isoDatePlus(20),
          tasks: [
            "Tune impact/confidence/effort weights by observed outcomes",
            "Refine competitor and local-entity clusters",
            "Promote high-performing recommendation templates",
          ],
          exit_criteria: "Priority ranking precision improves week-over-week",
        },
        {
          name: "Week 4 validation",
          start_date: isoDatePlus(21),
          end_date: isoDatePlus(29),
          tasks: [
            "Run final weekly cycle and compare against baseline",
            "Deliver evidence-backed wins, misses, and next-quarter backlog",
            "Package rollout recommendation for always-on cadence",
          ],
          exit_criteria: "Documented uplift and calibrated operating playbook",
        },
      ],
    };

    await saveWeeklyRun({
      workspaceId: workspace.id,
      runId,
      status: "completed",
      detail: {
        type: "pilot_plan",
        ...plan,
      },
    });

    return res.status(200).json({ ok: true, workspace, pilot_plan: plan, run_id: runId });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || "grace_pilot_failed" });
  }
}
