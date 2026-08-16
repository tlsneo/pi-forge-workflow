import { dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadForgeConfig, resolveForgeProfile } from "../../src/config/resolver.js";
import { TaskExecutionService } from "../../src/execution/service.js";
import { proportionalityPolicyLines } from "../../src/policy/proportionality.js";
import { RuntimeService } from "../../src/runtime/service.js";
import type { IssueAuditAxis, IssueAuditJob } from "../../src/runtime/types.js";
import { PiSubagentsAdapter, type SubagentLifecycleEvent } from "../../src/subagents/adapter.js";

const AXES: IssueAuditAxis[] = ["standards", "acceptance_integration", "architecture_minimality"];

interface Location { runtimeRoot: string; axis: IssueAuditAxis; bindingId: string }

const CONTRACTS: Record<IssueAuditAxis, { question: string; checks: string[]; outOfScope: string[] }> = {
  standards: {
    question: "Does the final implementation follow the repository's documented standards and verification obligations?",
    checks: ["Repository instructions", "Changed-file scope", "Tests, typecheck, lint, and generated artifacts", "Error handling and compatibility conventions"],
    outOfScope: ["Redesigning approved behavior", "Architecture preference unless a documented standard is violated"],
  },
  acceptance_integration: {
    question: "Do the committed Task Receipts and assembled Slice behavior satisfy every Issue Acceptance without integration gaps?",
    checks: ["Issue Acceptance coverage", "Happy, error, and edge behavior", "Cross-Task integration", "Task and Slice verification evidence", "No missing consumer or migration behavior"],
    outOfScope: ["Style preferences", "Features outside the frozen Issue"],
  },
  architecture_minimality: {
    question: "Is the final diff the minimum sufficient implementation at the approved seams?",
    checks: ["Approved Module and Seam", "Dependency direction", "Reuse of existing Symbols, Helpers, types, Modules, and test Seams", "No unnecessary Interface, abstraction, dependency, configuration, feature flag, or extension point", "Fallback is default-deny: no fallback branch, silent recovery, default substitution, compatibility path, catch-and-continue behavior, or swallowed error without explicit frozen authorization and verification", "No repeated runtime validation after a trusted input Seam or type established the invariant", "No unrelated refactor, rename, reformat, or cleanup", "App entry and composition-root Modules remain thin; cohesive behavior lives in its owning Module", "No file fragmentation into one-function pass-through Modules merely to reduce file size", "Nearby naming, control-flow, error, import, and test conventions are preserved", "Locality, rollback, and edits outside the closure"],
    outOfScope: ["Adding future features", "Rewriting product scope"],
  },
};

function description(bindingId: string, axis: IssueAuditAxis): string {
  return `forge-issue-audit:${bindingId}:${axis}`;
}

function parseDescription(value: string): { bindingId: string; axis: IssueAuditAxis } | undefined {
  const match = /^forge-issue-audit:([^:]+):(standards|acceptance_integration|spec_integration|architecture_minimality)$/.exec(value);
  const axis = match?.[2] === "spec_integration" ? "acceptance_integration" : match?.[2];
  return match?.[1] && axis ? { bindingId: match[1], axis: axis as IssueAuditAxis } : undefined;
}

async function resolveExactModel(ctx: ExtensionContext, input: string): Promise<unknown> {
  const slash = input.indexOf("/");
  if (slash < 1) throw new Error(`Model must be exact provider/model: ${input}`);
  const model = ctx.modelRegistry.find(input.slice(0, slash), input.slice(slash + 1));
  if (!model) throw new Error(`Configured model is unavailable: ${input}; rerun /skill:forge-init`);
  return model;
}

function prompt(runtimeRoot: string, job: IssueAuditJob, bindingId: string, controlRoot: string, workspaceRoot: string): string {
  const axis = job.axis;
  const contract = CONTRACTS[axis];
  const issueRoot = dirname(runtimeRoot);
  return [
    `Role: independent Forge Issue ${axis} Auditor`,
    `Binding ID: ${bindingId}`,
    `Runtime root: ${runtimeRoot}`,
    `Control root: ${controlRoot}`,
    `Target repository root: ${workspaceRoot}`,
    `Issue artifact: ${join(issueRoot, "issue.json")}`,
    ...(job.surface ? [
      `Compact Axis Surface: ${join(runtimeRoot, job.surface.artifactPath)}`,
      `Axis Surface Hash: ${job.surface.surfaceHash}`,
      `Surface Task IDs: ${job.surface.taskIds.join(", ") || "none"}`,
      `Surface Changed Files: ${job.surface.changedFiles.join(", ") || "none"}`,
    ] : [
      `Task manifest: ${join(issueRoot, "task-manifest.json")}`,
      `Task receipts: ${join(runtimeRoot, "receipts")}`,
      `Slice gate state: ${join(runtimeRoot, "state.json")}`,
    ]),
    "",
    `Audit question: ${contract.question}`,
    "Required checks:",
    ...contract.checks.map((item) => `- ${item}`),
    "Out of scope:",
    ...contract.outOfScope.map((item) => `- ${item}`),
    "",
    "Proportionality Policy:",
    ...proportionalityPolicyLines("review"),
    "",
    "Read the compact Axis Surface and inspect only its declared Task commits, changed files, and evidence necessary for this axis. Do not modify files, duplicate another axis, re-check settled evidence outside this surface, or expand scope.",
    `Finding IDs must use this Axis prefix: ${axis === "standards" ? "STD-" : axis === "acceptance_integration" ? "ACC-" : "ARCH-"}. A Blocker must make frozen Acceptance false, violate a documented hard rule, or prove the implementation structurally unsafe through a reachable path. Its evidence must include at least one exact repository path, path#line citation, or path#symbol Seam that a bounded repair Task can read. Preferences and optional confidence are Warnings or Notes.`,
    `Call forge_run_audit_submit exactly once with this Binding ID, axis${job.surface ? ", Axis Surface Hash" : ""}, verdict, and structured findings, then stop.`,
  ].join("\n");
}

export class IssueAuditOrchestrator {
  private readonly adapter: PiSubagentsAdapter;
  private readonly resultHandlers = new Set<(runtimeRoot: string, state: Awaited<ReturnType<RuntimeService["status"]>>) => void | Promise<void>>();
  private readonly bindings = new Map<string, Location>();
  private readonly agents = new Map<string, Location>();
  private readonly models = new Map<string, unknown>();

  constructor(adapter: PiSubagentsAdapter) {
    this.adapter = adapter;
    adapter.onStarted((event) => this.started(event));
    adapter.onCompleted((event) => this.terminal(event, "completed"));
    adapter.onFailed((event) => this.terminal(event, event.status === "stopped" || event.status === "aborted" ? event.status : "failed"));
  }

  onResult(handler: (runtimeRoot: string, state: Awaited<ReturnType<RuntimeService["status"]>>) => void | Promise<void>): () => void {
    this.resultHandlers.add(handler);
    return () => this.resultHandlers.delete(handler);
  }

  async notifyResult(runtimeRoot: string, state: Awaited<ReturnType<RuntimeService["status"]>>): Promise<void> {
    await Promise.all([...this.resultHandlers].map((handler) => handler(runtimeRoot, state)));
  }

  async start(runtimeRoot: string, ctx: ExtensionContext): Promise<Array<{ axis: IssueAuditAxis; agentId?: string; status: string }>> {
    const service = new RuntimeService(runtimeRoot);
    const manifest = await service.store.readManifest();
    if (manifest.assuranceProfile === "fast") {
      await new TaskExecutionService(runtimeRoot).completeFastIssue();
      return [];
    }
    const config = await loadForgeConfig(manifest.controlRoot);
    const route = resolveForgeProfile(config, "issueAudit");
    const model = await resolveExactModel(ctx, route.model);
    let state = await service.status();
    for (const [axis, job] of Object.entries(state.auditJobs ?? {}) as Array<[IssueAuditAxis, IssueAuditJob]>) {
      if (job.status === "starting" && job.binding && !job.binding.agentId) {
        await service.markAuditSpawnFailed(axis, "Agent lifecycle missing during recovery before Issue Audit binding");
        state = await service.status();
      }
    }
    if (state.issueStatus === "infrastructure_failed") {
      return AXES.map((axis) => ({ axis, status: state.auditJobs?.[axis]?.status ?? "infrastructure_failed" }));
    }
    if (!state.auditJobs || Object.values(state.auditJobs).every((job) => ["result_submitted", "completed", "failed"].includes(job.status))) {
      state = await service.createAuditJobs({
        standards: { model: route.model, thinking: route.thinking, maxTurns: route.maxTurns, configHash: route.configHash },
        acceptance_integration: { model: route.model, thinking: route.thinking, maxTurns: route.maxTurns, configHash: route.configHash },
        architecture_minimality: { model: route.model, thinking: route.thinking, maxTurns: route.maxTurns, configHash: route.configHash },
      });
    }
    await this.index(runtimeRoot);
    return Promise.all(AXES.map(async (axis) => {
      const job = state.auditJobs?.[axis];
      if (!job || !["pending", "retry_ready", "interrupted"].includes(job.status)) return { axis, status: job?.status ?? "missing" };
      this.models.set(`${runtimeRoot}:${axis}`, model);
      return this.spawn(runtimeRoot, job, model);
    }));
  }

  async index(runtimeRoot: string): Promise<void> {
    const state = await new RuntimeService(runtimeRoot).status();
    for (const [axis, job] of Object.entries(state.auditJobs ?? {}) as Array<[IssueAuditAxis, IssueAuditJob]>) {
      if (!job.binding) continue;
      const location = { runtimeRoot, axis, bindingId: job.binding.id };
      this.bindings.set(job.binding.id, location);
      if (job.binding.agentId) this.agents.set(job.binding.agentId, location);
    }
  }

  private async spawn(runtimeRoot: string, job: IssueAuditJob, model: unknown) {
    const service = new RuntimeService(runtimeRoot);
    const state = await service.status();
    const manifest = await service.store.readManifest();
    const binding = RuntimeService.createAuditBinding({ axis: job.axis, ...(job.surface ? { surfaceHash: job.surface.surfaceHash } : {}), attempt: job.attempt + 1, model: job.model, thinking: job.thinking, maxTurns: job.maxTurns, startedGeneration: state.generation });
    await service.claimAuditJob(job.axis, binding);
    const location = { runtimeRoot, axis: job.axis, bindingId: binding.id };
    this.bindings.set(binding.id, location);
    try {
      const protocol = await this.adapter.ping();
      if (protocol < 2) throw new Error(`Unsupported pi-subagents RPC protocol: ${protocol}`);
      const agentId = await this.adapter.spawn({ type: "forge-reviewer", prompt: prompt(runtimeRoot, job, binding.id, manifest.controlRoot, manifest.workspaceRoot), description: description(binding.id, job.axis), model, thinkingLevel: job.thinking, maxTurns: job.maxTurns, cwd: manifest.workspaceRoot });
      await service.bindAuditAgent(job.axis, binding.id, agentId);
      this.agents.set(agentId, location);
      return { axis: job.axis, agentId, status: "started" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = await service.markAuditSpawnFailed(job.axis, message);
      return { axis: job.axis, status: failed.auditJobs?.[job.axis]?.status ?? "failed", error: message };
    }
  }

  private async locate(event: SubagentLifecycleEvent): Promise<Location | undefined> {
    const existing = this.agents.get(event.id);
    if (existing) return existing;
    const parsed = parseDescription(event.description);
    if (!parsed) return undefined;
    const location = this.bindings.get(parsed.bindingId);
    if (!location || location.axis !== parsed.axis) return undefined;
    await new RuntimeService(location.runtimeRoot).bindAuditAgent(location.axis, location.bindingId, event.id);
    this.agents.set(event.id, location);
    return location;
  }

  private started(event: SubagentLifecycleEvent): void {
    void (async () => {
      const location = await this.locate(event);
      if (location) await new RuntimeService(location.runtimeRoot).markAuditAgentStarted(event.id);
    })().catch((error) => console.error("[pi-forge-workflow] Issue Auditor started event failed", error));
  }

  private terminal(event: SubagentLifecycleEvent, terminal: "completed" | "failed" | "stopped" | "aborted"): void {
    void (async () => {
      const location = await this.locate(event);
      if (!location) return;
      const service = new RuntimeService(location.runtimeRoot);
      const state = await service.markAuditAgentTerminal(event.id, terminal, event.error);
      const job = state.auditJobs?.[location.axis];
      if (!job || job.result || !["retry_ready", "interrupted"].includes(job.status)) return;
      const model = this.models.get(`${location.runtimeRoot}:${location.axis}`);
      if (model) await this.spawn(location.runtimeRoot, job, model);
    })().catch((error) => console.error("[pi-forge-workflow] Issue Auditor terminal event failed", error));
  }
}
