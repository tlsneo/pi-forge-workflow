import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { proportionalityPolicyLines } from "../policy/proportionality.js";
import type { ForgeConfig, ForgeModelProfile } from "./types.js";

const STATIC_TEMPLATE_FILES = ["task-worker.md", "forge-designer.md", "forge-reviewer.md"] as const;

export interface DesiredAgentTemplate {
  file: string;
  content: string;
}

function profileFor(config: ForgeConfig, route: string, fallbackRoute: string): ForgeModelProfile {
  const profileName = config.models.routing[route] ?? config.models.routing[fallbackRoute];
  const profile = profileName ? config.models.profiles[profileName] : undefined;
  if (!profile) throw new Error(`Missing model route for ${route}`);
  return profile;
}

function exploreTemplate(profile: ForgeModelProfile): string {
  return `---
name: Explore
description: Fast read-only repository exploration using the Forge simple model profile
tools: read, grep, find, ls
model: ${profile.model}
thinking: ${profile.thinking}
systemPromptMode: replace
inheritProjectContext: false
inheritSkills: false
defaultContext: fresh
async: true
timeoutMs: 3600000
turnBudget: {"maxTurns":${profile.maxTurns},"graceTurns":0}
acceptance: {"level":"none","reason":"Forge Runtime owns structured verification and acceptance"}
acceptanceRole: read-only
completionGuard: false
maxSubagentDepth: 0
---

You are a fast read-only repository explorer. Answer one bounded lookup with targeted searches. Report relevant \`path#Symbol\` facts, direct consumers, test seams, and unresolved unknowns. Do not design the change or modify files.
`;
}

function planTemplate(profile: ForgeModelProfile): string {
  return `---
name: Plan
description: Read-only implementation planning using the Forge complex model profile
tools: read, bash, grep, find, ls
model: ${profile.model}
thinking: ${profile.thinking}
systemPromptMode: replace
inheritProjectContext: false
inheritSkills: false
defaultContext: fresh
async: true
timeoutMs: 3600000
turnBudget: {"maxTurns":${profile.maxTurns},"graceTurns":0}
acceptance: {"level":"none","reason":"Forge Runtime owns structured verification and acceptance"}
acceptanceRole: read-only
completionGuard: false
maxSubagentDepth: 0
---

You are a read-only software planner. Build an evidence-backed implementation plan from the request and repository state. Trace affected interfaces, dependencies, risks, migration, and verification seams. State missing evidence explicitly.

Proportionality Policy:
${proportionalityPolicyLines("planning").join("\n")}

Do not modify files.
`;
}

export async function desiredAgentTemplates(packageRoot: string, config: ForgeConfig): Promise<DesiredAgentTemplate[]> {
  const templates = await Promise.all(STATIC_TEMPLATE_FILES.map(async (file) => ({
    file,
    content: await readFile(join(packageRoot, "assets", "agent-templates", file), "utf8"),
  })));
  const explore = profileFor(config, "interactiveExplore", "task.simple");
  const plan = profileFor(config, "interactivePlan", "task.complex");
  return [
    ...templates,
    { file: "Explore.md", content: exploreTemplate(explore) },
    { file: "Plan.md", content: planTemplate(plan) },
  ];
}
