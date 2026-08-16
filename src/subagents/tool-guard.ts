import { constants } from "node:fs";
import { access, readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ForgeConfig } from "../config/types.js";
import type { IssueRuntimeState } from "../runtime/types.js";
import type { WorkItemState } from "../work-item/types.js";

const TERMINAL_ISSUE_STATUSES = new Set(["completed", "failed", "infrastructure_failed"]);

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(path: string): Promise<T | undefined> {
  if (!(await exists(path))) return undefined;
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export async function findForgeControlRoot(cwd: string): Promise<string | undefined> {
  let current = resolve(cwd);
  const filesystemRoot = parse(current).root;
  while (true) {
    if (await exists(join(current, ".pi", "forge.json"))) return current;
    if (current === filesystemRoot) return undefined;
    current = dirname(current);
  }
}

async function frozenWorkItemStillActive(workItemRoot: string): Promise<boolean> {
  const issuesRoot = join(workItemRoot, "issues");
  if (!(await exists(issuesRoot))) return true;
  const issueEntries = (await readdir(issuesRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory() && /^I\d+$/.test(entry.name));
  if (issueEntries.length === 0) return true;
  for (const entry of issueEntries) {
    const issueState = await readJson<IssueRuntimeState>(join(issuesRoot, entry.name, "runtime", "state.json"));
    if (!issueState || !TERMINAL_ISSUE_STATUSES.has(issueState.issueStatus)) return true;
  }
  return false;
}

export interface ActiveForgeWorkItem {
  workItemRoot: string;
  workItemId: string;
  status: string;
}

export async function activeForgeWorkItems(cwd: string): Promise<ActiveForgeWorkItem[]> {
  const controlRoot = await findForgeControlRoot(cwd);
  if (!controlRoot) return [];
  const config = await readJson<ForgeConfig>(join(controlRoot, ".pi", "forge.json"));
  if (!config) return [];
  const artifactsRoot = isAbsolute(config.artifacts.root) ? config.artifacts.root : resolve(controlRoot, config.artifacts.root);
  const workItemsRoot = join(artifactsRoot, "work-items");
  if (!(await exists(workItemsRoot))) return [];
  const active: ActiveForgeWorkItem[] = [];
  for (const entry of await readdir(workItemsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const workItemRoot = join(workItemsRoot, entry.name);
    const state = await readJson<WorkItemState>(join(workItemRoot, "runtime", "state.json"));
    if (!state) continue;
    const isActive = state.status !== "frozen" || await frozenWorkItemStillActive(workItemRoot);
    if (isActive) active.push({ workItemRoot, workItemId: state.workItemId, status: state.status });
  }
  return active.sort((left, right) => left.workItemId.localeCompare(right.workItemId));
}

export function registerFormalAgentToolGuard(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "Agent") return;
    const active = await activeForgeWorkItems(ctx.cwd);
    if (active.length === 0) return;
    const input = event.input as { subagent_type?: unknown };
    const requestedType = typeof input.subagent_type === "string" ? input.subagent_type : "unknown";
    return {
      block: true,
      reason: `Ordinary Agent/${requestedType} is disabled while Forge Work Items are active (${active.map((item) => item.workItemId).join(", ")}). Use only formal Forge Binding tools and frozen surfaces; ordinary Agent, Explore, and Plan cannot substitute, and interactive repository Explore also cannot substitute for a formal Worker, Planner, or Reviewer Binding.`,
    };
  });
}
