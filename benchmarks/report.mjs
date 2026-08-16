import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const repositoryRoot = process.argv[2];
if (!repositoryRoot) {
  console.error("Usage: node benchmarks/report.mjs <benchmark-repository-root>");
  process.exit(1);
}

async function files(root, name) {
  const found = [];
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...await files(path, name));
    else if (entry.name === name) found.push(path);
  }
  return found;
}

function duration(events, startType, endType) {
  const start = events.find((event) => event.type === startType)?.timestamp;
  const end = [...events].reverse().find((event) => event.type === endType)?.timestamp;
  if (!start || !end) return undefined;
  return Math.round((Date.parse(end) - Date.parse(start)) / 10) / 100;
}

const eventFiles = (await files(join(repositoryRoot, ".forge", "work-items"), "events.jsonl"))
  .filter((path) => path.includes("/issues/") && path.includes("/runtime/"));
const runtimes = [];
for (const path of eventFiles) {
  const events = (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  if (!events.some((event) => event.type === "issue_completed")) continue;
  runtimes.push({ path, events });
}
if (runtimes.length === 0) {
  console.error("No completed Forge Issue Runtime found.");
  process.exit(2);
}

const selected = runtimes.sort((left, right) => Date.parse(right.events.at(-1).timestamp) - Date.parse(left.events.at(-1).timestamp))[0];
const events = selected.events;
const workItemRoot = selected.path.split("/issues/")[0];
async function readEvents(path) {
  try { return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; }
}
const workItemEvents = await readEvents(join(workItemRoot, "runtime", "events.jsonl"));
const issueId = events.find((event) => event.issueId)?.issueId ?? events.find((event) => event.snapshot?.issueId)?.snapshot.issueId ?? "I001";
const preflightEvents = await readEvents(join(workItemRoot, "issues", issueId, "task-preflight", "events.jsonl"));
const remediationPreflightEvents = await readEvents(join(workItemRoot, "issues", issueId, "remediation-preflight", "events.jsonl"));
const allEvents = [...workItemEvents, ...preflightEvents, ...remediationPreflightEvents, ...events];
const issueCompletedAt = [...events].reverse().find((event) => event.type === "issue_completed")?.timestamp;
const workItemStartedAt = workItemEvents.find((event) => event.type === "work_item_initialized")?.timestamp;
const workItemToCompleted = workItemStartedAt && issueCompletedAt
  ? Math.round((Date.parse(issueCompletedAt) - Date.parse(workItemStartedAt)) / 10) / 100
  : undefined;
console.log(JSON.stringify({
  workItemRoot,
  runtimeEvents: selected.path,
  seconds: {
    workItemToCompleted,
    prdToFrozen: duration(workItemEvents, "work_item_initialized", "prd_frozen"),
    taskPlanningAndPreflight: duration(preflightEvents, "task_preflight_proposed", "task_plan_frozen_after_preflight"),
    runtimeToCompleted: duration(events, "runtime_initialized", "issue_completed"),
    claimToCompleted: duration(events, "task_claimed", "issue_completed"),
    worker: duration(events, "agent_started", "agent_terminal"),
    mechanicalVerification: duration(events, "verification_started", "verification_passed"),
    taskConformanceAndCommit: duration(events, "task_conformance_created", "task_completed"),
    sliceGate: duration(events, "slice_gate_started", "slice_gate_passed"),
    finalIssueAudit: duration(events, "issue_audit_jobs_created", "issue_completed"),
  },
  counts: {
    prdGenerations: workItemEvents.filter((event) => ["prd_submitted", "prd_amended"].includes(event.type)).length,
    prdAmendments: workItemEvents.filter((event) => event.type === "prd_amended").length,
    taskPreflightProposals: preflightEvents.filter((event) => event.type === "task_preflight_proposed").length,
    tasksClaimed: events.filter((event) => event.type === "task_claimed").length,
    taskConformanceResults: events.filter((event) => event.type === "task_conformance_submitted").length,
    finalAuditGenerations: events.filter((event) => event.type === "issue_audit_jobs_created").length,
    finalAuditResults: events.filter((event) => event.type === "issue_audit_submitted").length,
    carriedFinalAuditAxes: events.filter((event) => event.type === "issue_audit_jobs_created").reduce((count, event) => count + (event.details?.carriedAxes?.length ?? 0), 0),
    infrastructureRetries: allEvents.filter((event) => event.type === "infrastructure_retry_scheduled").length,
    unknownSpawnOutcomes: allEvents.filter((event) => event.type === "infrastructure_spawn_outcome_unknown").length,
  },
}, null, 2));
