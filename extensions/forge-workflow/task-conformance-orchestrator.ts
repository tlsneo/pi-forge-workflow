import { dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { proportionalityPolicyLines } from "../../src/policy/proportionality.js";
import { RuntimeService } from "../../src/runtime/service.js";
import type { TaskConformanceJob } from "../../src/runtime/types.js";
import { PiSubagentsAdapter, type SubagentLifecycleEvent } from "../../src/subagents/adapter.js";

interface Location { runtimeRoot: string; taskId: string; bindingId: string }

function description(bindingId: string, taskId: string): string {
  return `forge-task-conformance:${bindingId}:${taskId}`;
}

function parseDescription(value: string): { bindingId: string; taskId: string } | undefined {
  const match = /^forge-task-conformance:([^:]+):(T\d+)$/.exec(value);
  return match?.[1] && match[2] ? { bindingId: match[1], taskId: match[2] } : undefined;
}

async function resolveExactModel(ctx: ExtensionContext, input: string): Promise<unknown> {
  const slash = input.indexOf("/");
  if (slash < 1) throw new Error(`Model must be exact provider/model: ${input}`);
  const model = ctx.modelRegistry.find(input.slice(0, slash), input.slice(slash + 1));
  if (!model) throw new Error(`Configured model is unavailable: ${input}; rerun /skill:forge-init`);
  return model;
}

function prompt(runtimeRoot: string, taskId: string, job: TaskConformanceJob, bindingId: string): string {
  const taskPath = join(dirname(runtimeRoot), "tasks", taskId, `TASK-V${String(job.surface.taskVersion).padStart(3, "0")}.md`);
  return [
    "Role: independent Forge Task Conformance Auditor",
    `Binding ID: ${bindingId}`,
    `Runtime root: ${runtimeRoot}`,
    `Task: ${taskId}@V${String(job.surface.taskVersion).padStart(3, "0")}`,
    `Frozen Task contract: ${taskPath}`,
    `Task Conformance Surface: ${join(runtimeRoot, job.surface.artifactPath)}`,
    `Surface Hash: ${job.surface.surfaceHash}`,
    `Worker baseline: ${job.surface.baselineCommit}`,
    "",
    "Question: Does the staged implementation follow the frozen Task contract correctly, minimally, and safely, with every BP-xx Step implemented exactly as documented?",
    "",
    "Required procedure:",
    "1. Read the frozen Task contract and Task Conformance Surface.",
    "2. Inspect the staged diff from the frozen baseline. Read only the Task's exact Reads and changed Writes; do not perform open-ended repository exploration.",
    "3. Verify every BP-xx Step against its Handoff Evidence and actual diff.",
    "4. Verify every diff hunk maps to the Expected Patch Shape and no Forbidden Change appears.",
    "5. Check local correctness, unchanged branches, Minimal Implementation Policy, repository conventions at the edited Seam, and concrete safety or concurrency risks introduced by this Task.",
    "6. Treat a Stop Condition mismatch, missing Blueprint Evidence, unauthorized fallback, unrequested abstraction, unrelated cleanup, or verification gap as a Blocker.",
    "",
    "Proportionality Policy:",
    ...proportionalityPolicyLines("review"),
    "",
    "Finding policy:",
    "- A Blocker means the Task cannot be committed as the frozen Task result.",
    "- Warnings and Notes record concrete non-blocking observations and do not request redesign.",
    "- Every Finding must cite concrete file#symbol, diff, Verification, or BP-xx Evidence and identify the affected Blueprint Step IDs.",
    "- suggestedResolution must remain inside the frozen Task contract; never redesign the Issue or create a new Task plan.",
    "",
    "Do not modify files, Git, Runtime JSON, Task contracts, or Issue artifacts. Do not call ordinary Agent, Explore, or Plan.",
    "Call forge_run_task_conformance_submit exactly once with Runtime root, Binding ID, Surface Hash, verdict, and structured Findings, then stop.",
  ].join("\n");
}

export class TaskConformanceOrchestrator {
  private readonly adapter: PiSubagentsAdapter;
  private readonly bindings = new Map<string, Location>();
  private readonly agents = new Map<string, Location>();
  private readonly models = new Map<string, unknown>();

  constructor(adapter: PiSubagentsAdapter) {
    this.adapter = adapter;
    adapter.onStarted((event) => this.started(event));
    adapter.onCompleted((event) => this.terminal(event, "completed"));
    adapter.onFailed((event) => this.terminal(event, event.status === "stopped" || event.status === "aborted" ? event.status : "failed"));
  }

  async start(runtimeRoot: string, taskId: string, ctx: ExtensionContext): Promise<{ taskId: string; agentId?: string; status: string; error?: string }> {
    const service = new RuntimeService(runtimeRoot);
    let task = (await service.status()).tasks[taskId];
    let job = task?.conformanceJob;
    if (!job) throw new Error(`${taskId} has no Task Conformance Job`);
    if (job.status === "starting" && !job.binding?.agentId) {
      await service.markTaskConformanceSpawnFailed(taskId, "Agent lifecycle missing during recovery before Task Conformance binding");
      task = (await service.status()).tasks[taskId];
      job = task?.conformanceJob;
    }
    if (!job) throw new Error(`${taskId} lost its Task Conformance Job during recovery`);
    if (!["pending", "retry_ready", "interrupted"].includes(job.status)) return { taskId, status: job.status };
    const model = await resolveExactModel(ctx, job.model);
    this.models.set(`${runtimeRoot}:${taskId}`, model);
    return this.spawn(runtimeRoot, taskId, job, model);
  }

  async index(runtimeRoot: string): Promise<void> {
    const state = await new RuntimeService(runtimeRoot).status();
    for (const task of Object.values(state.tasks)) {
      const binding = task.conformanceJob?.binding;
      if (!binding) continue;
      const location = { runtimeRoot, taskId: task.id, bindingId: binding.id };
      this.bindings.set(binding.id, location);
      if (binding.agentId) this.agents.set(binding.agentId, location);
    }
  }

  private async spawn(runtimeRoot: string, taskId: string, job: TaskConformanceJob, model: unknown) {
    const service = new RuntimeService(runtimeRoot);
    const state = await service.status();
    const manifest = await service.store.readManifest();
    const binding = RuntimeService.createTaskConformanceBinding({
      workItemId: manifest.workItemId,
      issueId: manifest.issueId,
      taskId,
      taskVersion: job.surface.taskVersion,
      contractHash: job.surface.contractHash,
      surfaceHash: job.surface.surfaceHash,
      attempt: job.attempt + 1,
      model: job.model,
      thinking: job.thinking,
      maxTurns: job.maxTurns,
      startedGeneration: state.generation,
    });
    await service.claimTaskConformance(taskId, binding);
    const location = { runtimeRoot, taskId, bindingId: binding.id };
    this.bindings.set(binding.id, location);
    try {
      const protocol = await this.adapter.ping();
      if (protocol < 1) throw new Error(`Unsupported pi-subagents RPC protocol: ${protocol}`);
      const agentId = await this.adapter.spawn({
        type: "forge-reviewer",
        prompt: prompt(runtimeRoot, taskId, job, binding.id),
        description: description(binding.id, taskId),
        model,
        thinkingLevel: job.thinking,
        maxTurns: job.maxTurns,
        cwd: manifest.workspaceRoot,
      });
      await service.bindTaskConformanceAgent(taskId, binding.id, agentId);
      this.agents.set(agentId, location);
      return { taskId, agentId, status: "started" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = await service.markTaskConformanceSpawnFailed(taskId, message);
      return { taskId, status: failed.tasks[taskId]?.conformanceJob?.status ?? "failed", error: message };
    }
  }

  private async locate(event: SubagentLifecycleEvent): Promise<Location | undefined> {
    const existing = this.agents.get(event.id);
    if (existing) return existing;
    const parsed = parseDescription(event.description);
    if (!parsed) return undefined;
    const location = this.bindings.get(parsed.bindingId);
    if (!location || location.taskId !== parsed.taskId) return undefined;
    await new RuntimeService(location.runtimeRoot).bindTaskConformanceAgent(location.taskId, location.bindingId, event.id);
    this.agents.set(event.id, location);
    return location;
  }

  private started(event: SubagentLifecycleEvent): void {
    void (async () => {
      const location = await this.locate(event);
      if (!location) return;
      const service = new RuntimeService(location.runtimeRoot);
      if ((await service.locateTaskConformance(location.bindingId))?.result) return;
      await service.markTaskConformanceAgentStarted(event.id);
    })().catch((error) => console.error("[pi-forge-workflow] Task Conformance Auditor started event failed", error));
  }

  private terminal(event: SubagentLifecycleEvent, terminal: "completed" | "failed" | "stopped" | "aborted"): void {
    void (async () => {
      const location = await this.locate(event);
      if (!location) return;
      const service = new RuntimeService(location.runtimeRoot);
      if ((await service.locateTaskConformance(location.bindingId))?.result) return;
      const state = await service.markTaskConformanceAgentTerminal(event.id, terminal, event.error);
      const job = state.tasks[location.taskId]?.conformanceJob;
      if (!job || job.result || !["retry_ready", "interrupted"].includes(job.status)) return;
      const model = this.models.get(`${location.runtimeRoot}:${location.taskId}`);
      if (model) await this.spawn(location.runtimeRoot, location.taskId, job, model);
    })().catch((error) => console.error("[pi-forge-workflow] Task Conformance Auditor terminal event failed", error));
  }
}
