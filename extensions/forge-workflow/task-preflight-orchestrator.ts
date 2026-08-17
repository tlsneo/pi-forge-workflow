import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadForgeConfig, resolveForgeProfile } from "../../src/config/resolver.js";
import { PiSubagentsAdapter, type SubagentLifecycleEvent } from "../../src/subagents/adapter.js";
import { buildTaskPreflightPrompt } from "../../src/tasks/preflight-prompt.js";
import { TaskPreflightService } from "../../src/tasks/preflight-service.js";
import type { TaskPreflightFinding, TaskPreflightRoute, TaskPreflightVerdict } from "../../src/tasks/preflight-types.js";
import { TasksService } from "../../src/tasks/service.js";
import type { MicroTaskDraft, SliceDraft } from "../../src/tasks/types.js";

interface Location {
  workItemRoot: string;
  issueId: string;
  proposalGeneration: number;
  bindingId: string;
}

interface SpawnResult {
  status: "started" | "passed" | "blocked" | "frozen" | "retry_ready" | "failed" | "infrastructure_failed";
  proposalGeneration: number;
  proposalHash: string;
  bindingId?: string;
  agentId?: string;
  taskPlanHash?: string;
  error?: string;
}

function description(location: Location): string {
  return `forge-task-preflight:${location.bindingId}:${location.issueId}:${location.proposalGeneration}`;
}

function parseDescription(value: string): { bindingId: string; issueId: string; proposalGeneration: number } | undefined {
  const match = /^forge-task-preflight:([^:]+):(I\d+):(\d+)$/.exec(value);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  return { bindingId: match[1], issueId: match[2], proposalGeneration: Number(match[3]) };
}

async function resolveExactModel(ctx: ExtensionContext, input: string): Promise<unknown> {
  const slash = input.indexOf("/");
  if (slash < 1) throw new Error(`Model must be exact provider/model: ${input}`);
  const model = ctx.modelRegistry.find(input.slice(0, slash), input.slice(slash + 1));
  if (!model) throw new Error(`Configured model is unavailable: ${input}; rerun /skill:forge-init`);
  return model;
}

function resolveRoute(config: Awaited<ReturnType<typeof loadForgeConfig>>): TaskPreflightRoute {
  const route = resolveForgeProfile(config, "taskPreflight");
  return {
    profile: route.profile,
    model: route.model,
    thinking: route.thinking,
    maxTurns: route.maxTurns,
    configGeneration: route.configGeneration,
    configHash: route.configHash,
  };
}

export class TaskPreflightOrchestrator {
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

  async propose(input: {
    workItemRoot: string;
    issueId: string;
    slices: SliceDraft[];
    tasks: MicroTaskDraft[];
    ctx: ExtensionContext;
  }): Promise<SpawnResult> {
    const tasksService = new TasksService(input.workItemRoot);
    const existing = await tasksService.status(input.issueId);
    if (existing.manifest) {
      const frozen = await tasksService.submit(input.issueId, input.slices, input.tasks);
      return { status: "frozen", proposalGeneration: frozen.manifest.generation, proposalHash: frozen.manifest.proposalHash ?? frozen.manifest.contentHash, taskPlanHash: frozen.manifest.contentHash };
    }

    const prepared = await tasksService.prepare(input.issueId, input.slices, input.tasks);
    const route = resolveRoute(prepared.config);
    const model = await resolveExactModel(input.ctx, route.model);
    const service = new TaskPreflightService(input.workItemRoot, input.issueId);
    let proposal = await service.propose(prepared, route);
    if (proposal.state.status === "starting" && proposal.state.job.binding && !proposal.state.job.binding.agentId) {
      const recovered = await service.markSpawnFailed(proposal.state.job.binding.id, "Agent lifecycle missing during recovery before Task Preflight binding");
      proposal = { ...proposal, state: recovered };
    }
    await this.index(input.workItemRoot, input.issueId);

    if (proposal.state.status === "passed") {
      const frozen = await this.freezePassed(input.workItemRoot, input.issueId);
      return { status: "frozen", proposalGeneration: proposal.proposal.generation, proposalHash: proposal.proposal.proposalHash, taskPlanHash: frozen.manifest.contentHash };
    }
    if (proposal.state.status === "blocked" || proposal.state.status === "failed" || proposal.state.status === "infrastructure_failed") {
      return { status: proposal.state.status, proposalGeneration: proposal.proposal.generation, proposalHash: proposal.proposal.proposalHash, ...(proposal.state.job.lastError ? { error: proposal.state.job.lastError } : {}) };
    }
    if (!["pending", "retry_ready", "interrupted"].includes(proposal.state.status)) {
      return {
        status: "started",
        proposalGeneration: proposal.proposal.generation,
        proposalHash: proposal.proposal.proposalHash,
        ...(proposal.state.job.binding?.id ? { bindingId: proposal.state.job.binding.id } : {}),
        ...(proposal.state.job.binding?.agentId ? { agentId: proposal.state.job.binding.agentId } : {}),
      };
    }
    this.models.set(`${input.workItemRoot}:${input.issueId}`, model);
    return this.spawn(input.workItemRoot, input.issueId, model);
  }

  async submitResult(input: {
    workItemRoot: string;
    issueId: string;
    bindingId: string;
    proposalHash: string;
    verdict: TaskPreflightVerdict;
    findings: TaskPreflightFinding[];
  }): Promise<{ status: "passed" | "blocked" | "frozen"; resultHash: string; taskPlanHash?: string; idempotent: boolean }> {
    const service = new TaskPreflightService(input.workItemRoot, input.issueId);
    const submitted = await service.submitResult(input);
    if (submitted.result.verdict === "blocked") return { status: "blocked", resultHash: submitted.result.resultHash, idempotent: submitted.idempotent };
    const frozen = await this.freezePassed(input.workItemRoot, input.issueId);
    return { status: "frozen", resultHash: submitted.result.resultHash, taskPlanHash: frozen.manifest.contentHash, idempotent: submitted.idempotent && frozen.idempotent };
  }

  async index(workItemRoot: string, issueId: string): Promise<void> {
    const state = await new TaskPreflightService(workItemRoot, issueId).status();
    const binding = state?.job.binding;
    if (!state || !binding) return;
    const location = { workItemRoot, issueId, proposalGeneration: state.activeProposalGeneration, bindingId: binding.id };
    this.bindings.set(binding.id, location);
    if (binding.agentId) this.agents.set(binding.agentId, location);
  }

  private async freezePassed(workItemRoot: string, issueId: string) {
    const service = new TaskPreflightService(workItemRoot, issueId);
    const state = await service.status();
    if (!state || state.status !== "passed" || state.job.result?.verdict !== "passed") throw new Error("Task Preflight has not passed");
    const proposal = await service.readProposal();
    const { receipt } = await service.validatePassedEvidence();
    const frozen = await new TasksService(workItemRoot).submit(issueId, proposal.slices, proposal.tasks, {
      proposalGeneration: receipt.proposalGeneration,
      proposalHash: receipt.proposalHash,
      surfaceHash: receipt.surfaceHash,
      bindingId: receipt.bindingId,
      resultHash: receipt.resultHash,
      receiptPath: `task-preflight/receipts/proposal-${receipt.proposalGeneration}.json`,
    });
    await service.markFrozen(frozen.manifest.contentHash);
    return frozen;
  }

  private async spawn(workItemRoot: string, issueId: string, model: unknown): Promise<SpawnResult> {
    const service = new TaskPreflightService(workItemRoot, issueId);
    const state = await service.status();
    const proposal = await service.readProposal();
    if (!state || !["pending", "retry_ready", "interrupted"].includes(state.status)) throw new Error(`Task Preflight is ${state?.status ?? "missing"}`);
    const binding = TaskPreflightService.createBinding({
      proposalGeneration: state.activeProposalGeneration,
      proposalHash: state.proposalHash,
      surfaceHash: state.surfaceHash,
      attempt: state.job.attempt + 1,
      profile: state.job.profile,
      model: state.job.model,
      thinking: state.job.thinking,
      maxTurns: state.job.maxTurns,
      startedStateGeneration: state.generation,
    });
    await service.claim(binding);
    const location = { workItemRoot, issueId, proposalGeneration: state.activeProposalGeneration, bindingId: binding.id };
    this.bindings.set(binding.id, location);
    try {
      const protocol = await this.adapter.ping();
      if (protocol < 1) throw new Error(`Unsupported pi-subagents RPC protocol: ${protocol}`);
      const agentId = await this.adapter.spawn({
        type: "forge-reviewer",
        prompt: buildTaskPreflightPrompt({ workItemRoot, proposal, bindingId: binding.id }),
        description: description(location),
        model,
        thinkingLevel: binding.thinking,
        maxTurns: binding.maxTurns,
        cwd: proposal.source.repositoryRoot,
      });
      await service.bindAgent(binding.id, agentId);
      this.agents.set(agentId, location);
      return { status: "started", proposalGeneration: proposal.generation, proposalHash: proposal.proposalHash, bindingId: binding.id, agentId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = await service.markSpawnFailed(binding.id, message);
      return { status: failed.status === "retry_ready" || failed.status === "infrastructure_failed" ? failed.status : "failed", proposalGeneration: proposal.generation, proposalHash: proposal.proposalHash, bindingId: binding.id, error: message };
    }
  }

  private async locate(event: SubagentLifecycleEvent): Promise<Location | undefined> {
    const existing = this.agents.get(event.id);
    if (existing) return existing;
    const parsed = parseDescription(event.description);
    if (!parsed) return undefined;
    const location = this.bindings.get(parsed.bindingId);
    if (!location || location.issueId !== parsed.issueId || location.proposalGeneration !== parsed.proposalGeneration) return undefined;
    await new TaskPreflightService(location.workItemRoot, location.issueId).bindAgent(location.bindingId, event.id);
    this.agents.set(event.id, location);
    return location;
  }

  private started(event: SubagentLifecycleEvent): void {
    void (async () => {
      const location = await this.locate(event);
      if (location) await new TaskPreflightService(location.workItemRoot, location.issueId).markStarted(event.id);
    })().catch((error) => console.error("[pi-forge-workflow] Task Preflight started event failed", error));
  }

  private terminal(event: SubagentLifecycleEvent, terminal: "completed" | "failed" | "stopped" | "aborted"): void {
    void (async () => {
      const location = await this.locate(event);
      if (!location) return;
      const service = new TaskPreflightService(location.workItemRoot, location.issueId);
      const state = await service.markTerminal(event.id, terminal, event.error);
      if (state.job.result || !["retry_ready", "interrupted"].includes(state.status)) return;
      const model = this.models.get(`${location.workItemRoot}:${location.issueId}`);
      if (model) await this.spawn(location.workItemRoot, location.issueId, model);
    })().catch((error) => console.error("[pi-forge-workflow] Task Preflight terminal event failed", error));
  }
}
