import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadForgeConfig, resolveForgeProfile } from "../../src/config/resolver.js";
import { RuntimeService } from "../../src/runtime/service.js";
import type { AuditBlockerVerificationResult } from "../../src/runtime/types.js";
import { PiSubagentsAdapter, type SubagentLifecycleEvent } from "../../src/subagents/adapter.js";
import { RemediationService } from "../../src/tasks/remediation-service.js";
import { TaskPreflightService } from "../../src/tasks/preflight-service.js";
import type { TaskPreflightFinding, TaskPreflightVerdict } from "../../src/tasks/preflight-types.js";
import type { MicroTaskDraft } from "../../src/tasks/types.js";

interface VerifierLocation { kind: "verifier"; runtimeRoot: string; bindingId: string }
interface PlannerLocation { kind: "planner"; runtimeRoot: string; bindingId: string }
interface PreflightLocation { kind: "preflight"; runtimeRoot: string; workItemRoot: string; issueId: string; bindingId: string; proposalGeneration: number }
type Location = VerifierLocation | PlannerLocation | PreflightLocation;

async function resolveExactModel(ctx: ExtensionContext, input: string): Promise<unknown> {
  const slash = input.indexOf("/");
  if (slash < 1) throw new Error(`Model must be exact provider/model: ${input}`);
  const model = ctx.modelRegistry.find(input.slice(0, slash), input.slice(slash + 1));
  if (!model) throw new Error(`Configured model is unavailable: ${input}; rerun /skill:forge-init`);
  return model;
}

function verifierDescription(bindingId: string): string { return `forge-audit-blocker-verifier:${bindingId}`; }
function preflightDescription(bindingId: string, issueId: string, generation: number): string { return `forge-remediation-preflight:${bindingId}:${issueId}:${generation}`; }

export class AuditRemediationOrchestrator {
  private readonly adapter: PiSubagentsAdapter;
  private readonly bindings = new Map<string, Location>();
  private readonly agents = new Map<string, Location>();
  private readonly models = new Map<string, unknown>();
  private readonly continueHandlers = new Set<(runtimeRoot: string) => void | Promise<void>>();
  private readonly reauditHandlers = new Set<(runtimeRoot: string) => void | Promise<void>>();

  constructor(adapter: PiSubagentsAdapter) {
    this.adapter = adapter;
    adapter.onStarted((event) => this.started(event));
    adapter.onCompleted((event) => this.terminal(event, "completed"));
    adapter.onFailed((event) => this.terminal(event, event.status === "stopped" || event.status === "aborted" ? event.status : "failed"));
  }

  onContinue(handler: (runtimeRoot: string) => void | Promise<void>): () => void {
    this.continueHandlers.add(handler);
    return () => this.continueHandlers.delete(handler);
  }

  onReaudit(handler: (runtimeRoot: string) => void | Promise<void>): () => void {
    this.reauditHandlers.add(handler);
    return () => this.reauditHandlers.delete(handler);
  }

  async startVerifier(runtimeRoot: string, ctx: ExtensionContext) {
    const runtime = new RuntimeService(runtimeRoot);
    const manifest = await runtime.store.readManifest();
    const config = await loadForgeConfig(manifest.controlRoot);
    const route = resolveForgeProfile(config, "blockerVerifier");
    const model = await resolveExactModel(ctx, route.model);
    const protocol = await this.adapter.ping();
    if (protocol < 2) throw new Error(`Unsupported pi-subagents RPC protocol: ${protocol}`);
    let state = await runtime.status();
    if (!state.auditBlockerVerifierJob) state = await runtime.createAuditBlockerVerifierJob({ model: route.model, thinking: route.thinking, maxTurns: route.maxTurns, configHash: route.configHash });
    const job = state.auditBlockerVerifierJob!;
    if (!["pending", "retry_ready", "interrupted"].includes(job.status)) return { status: job.status, bindingId: job.binding?.id, agentId: job.binding?.agentId };
    const binding = RuntimeService.createAuditBlockerVerifierBinding({
      attempt: job.attempt + 1,
      findingHash: job.findingHash,
      model: job.model,
      thinking: job.thinking,
      maxTurns: job.maxTurns,
      startedGeneration: state.generation,
    });
    await runtime.claimAuditBlockerVerifier(binding);
    const location: VerifierLocation = { kind: "verifier", runtimeRoot, bindingId: binding.id };
    this.bindings.set(binding.id, location);
    this.models.set(`verifier:${runtimeRoot}`, model);
    const findings = job.findings.map((reference) => ({ id: reference.findingId, axis: reference.axis, finding: reference.finding }));
    const prompt = [
      "Role: independent Forge final Audit Blocker Verifier",
      `Binding ID: ${binding.id}`,
      `Runtime root: ${runtimeRoot}`,
      `Control root: ${manifest.controlRoot}`,
      `Target repository root: ${manifest.workspaceRoot}`,
      `Finding hash: ${job.findingHash}`,
      "",
      "Verify only the listed Blockers against the final committed code and frozen Issue evidence. Do not widen scope or modify files.",
      "For every Finding return exactly one status: confirmed, rejected, or needs_more_evidence.",
      "Confirmed requires direct evidence. Rejected requires a concrete contradiction. needs_more_evidence must name exactly what evidence is missing.",
      JSON.stringify(findings, null, 2),
      "",
      "Call forge_run_audit_blockers_verify exactly once with this Runtime root, Binding ID, and one result for every Finding, then stop.",
    ].join("\n");
    try {
      const agentId = await this.adapter.spawn({ type: "forge-reviewer", prompt, description: verifierDescription(binding.id), model, thinkingLevel: binding.thinking, maxTurns: binding.maxTurns, cwd: manifest.workspaceRoot });
      await runtime.bindAuditBlockerVerifier(binding.id, agentId);
      this.agents.set(agentId, location);
      return { status: "started", bindingId: binding.id, agentId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await runtime.markAuditBlockerVerifierSpawnFailed(message);
      return { status: "failed", bindingId: binding.id, error: message };
    }
  }

  async submitVerification(runtimeRoot: string, bindingId: string, results: AuditBlockerVerificationResult[], ctx?: ExtensionContext) {
    const state = await new RuntimeService(runtimeRoot).submitAuditBlockerVerification(bindingId, results);
    const planner = state.remediationPlan?.status === "awaiting_proposal" && ctx ? await this.startPlanner(runtimeRoot, ctx) : undefined;
    const rejectedAll = !state.remediationPlan && state.issueStatus === "auditing";
    if (rejectedAll) await Promise.all([...this.reauditHandlers].map((handler) => handler(runtimeRoot)));
    return { state: await new RuntimeService(runtimeRoot).status(), remediationRequired: state.remediationPlan?.status === "awaiting_proposal", needsUser: state.remediationPlan?.status === "needs_user", rejectedAll, ...(planner ? { planner } : {}) };
  }

  async startPlanner(runtimeRoot: string, ctx: ExtensionContext) {
    const runtime = new RuntimeService(runtimeRoot);
    const manifest = await runtime.store.readManifest();
    const config = await loadForgeConfig(manifest.controlRoot);
    const route = resolveForgeProfile(config, config.models.routing.remediationPlanner ? "remediationPlanner" : "task.complex");
    const model = await resolveExactModel(ctx, route.model);
    let state = await runtime.status();
    if (!state.remediationPlan?.plannerJob) state = await runtime.createRemediationPlannerJob({ model: route.model, thinking: route.thinking, maxTurns: route.maxTurns, configHash: route.configHash });
    const plan = state.remediationPlan!;
    const job = plan.plannerJob!;
    if (!["pending", "retry_ready", "interrupted"].includes(job.status)) return { status: job.status, bindingId: job.binding?.id, agentId: job.binding?.agentId };
    const binding = RuntimeService.createRemediationPlannerBinding({ attempt: job.attempt + 1, findingHash: plan.findingHash, model: job.model, thinking: job.thinking, maxTurns: job.maxTurns, startedGeneration: state.generation });
    await runtime.claimRemediationPlanner(binding);
    const location: PlannerLocation = { kind: "planner", runtimeRoot, bindingId: binding.id };
    this.bindings.set(binding.id, location);
    this.models.set(`planner:${runtimeRoot}`, model);
    const verifier = state.auditBlockerVerifierJob;
    const confirmed = plan.source === "slice_gate"
      ? [{ findingId: plan.confirmedFindingIds[0]!, axis: "slice_gate", auditBindingId: "slice-gate", finding: { id: plan.confirmedFindingIds[0]!, severity: "blocker", message: state.sliceGates?.[plan.sourceSliceId!]?.error ?? "Slice Gate failed", evidence: state.sliceGates?.[plan.sourceSliceId!]?.verification?.map((result) => `${result.command} exited ${result.exitCode}`) ?? [], violatedRule: `Slice ${plan.sourceSliceId} Gate must pass`, verification: state.sliceGates?.[plan.sourceSliceId!]?.commands.map((command) => command.command).join("; ") ?? "Rerun Slice Gate" } }]
      : verifier!.findings.filter((finding) => plan.confirmedFindingIds.includes(finding.findingId));
    const dag = await runtime.store.readDag();
    const prompt = [
      "Role: Forge Remediation Task Planner",
      `Binding ID: ${binding.id}`,
      `Runtime root: ${runtimeRoot}`,
      `Control root: ${manifest.controlRoot}`,
      `Target repository root: ${manifest.workspaceRoot}`,
      `Frozen PRD: ${new RemediationService(runtimeRoot).workItemRoot}/PRD.md`,
      `Frozen Issue: ${new RemediationService(runtimeRoot).issueRoot}/ISSUE.md`,
      `Issue artifact: ${new RemediationService(runtimeRoot).issueRoot}/issue.json`,
      `Current Task DAG: ${runtimeRoot}/dag.json`,
      `Completed Task Receipts: ${runtimeRoot}/receipts`,
      `Current DAG generation: ${dag.generation}`,
      `Next Task ID starts after: ${dag.tasks.at(-1)?.id ?? "none"}`,
      "",
      "Read the frozen PRD, Issue artifact/ISSUE.md, current DAG, completed Receipts, and confirmed Findings before planning. The PRD and Issue are authoritative constraints, not optional background.",
      "If the repair would violate repository instructions, frozen PRD/Issue requirements, accepted Decisions, audit findings, Task/DAG contracts, Git/workspace rules, Issue scope/non-goals, architecture seam, or requires a product choice not determined by repository evidence, do not guess and do not submit Tasks. Call forge_run_human_decision_request with concrete evidence, 2-4 user options, consequences, and the correct resume action.",
      "Generate the smallest detailed Micro Tasks that repair only the confirmed final Audit Findings. Preserve all completed Tasks, commits and Receipts. Do not change frozen Acceptance, approved Decisions, architecture seam, public Interface, non-goals, or unrelated code. Fallback is forbidden unless frozen requirements explicitly authorize the exact behavior and verification. Keep app entry and composition-root Modules thin by placing cohesive behavior in its proven owner, but do not create one-function pass-through files merely to reduce file length.",
      "Each Task should normally read 1-2 exact symbols, write one primary path, contain an executable ordered Blueprint, and produce one useful verified commit. Name affected existing Slice IDs whose gates must rerun.",
      JSON.stringify(confirmed, null, 2),
      "",
      "Call forge_run_remediation_propose exactly once with this Runtime root, Binding ID, complete Tasks, and rerunSliceIds. Do not modify files, then stop.",
    ].join("\n");
    try {
      const agentId = await this.adapter.spawn({ type: "forge-designer", prompt, description: `forge-remediation-planner:${binding.id}`, model, thinkingLevel: binding.thinking, maxTurns: binding.maxTurns, cwd: manifest.workspaceRoot });
      await runtime.bindRemediationPlanner(binding.id, agentId);
      this.agents.set(agentId, location);
      return { status: "started", bindingId: binding.id, agentId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await runtime.markRemediationPlannerSpawnFailed(binding.id, message);
      return { status: "failed", bindingId: binding.id, error: message };
    }
  }

  async proposeRemediation(runtimeRoot: string, plannerBindingId: string, tasks: MicroTaskDraft[], rerunSliceIds: string[], ctx: ExtensionContext) {
    const runtime = new RuntimeService(runtimeRoot);
    const stateBefore = await runtime.status();
    if (stateBefore.remediationPlan?.plannerJob?.binding?.id !== plannerBindingId || !["starting", "running"].includes(stateBefore.remediationPlan.plannerJob.status)) throw new Error("Inactive Remediation Planner Binding");
    const remediation = new RemediationService(runtimeRoot);
    const proposed = await remediation.propose(tasks, rerunSliceIds);
    await runtime.markRemediationPlannerProposalSubmitted(plannerBindingId);
    const model = await resolveExactModel(ctx, proposed.route.model);
    const state = proposed.state!;
    if (state.status === "passed") {
      const runtimeState = await remediation.applyPassed();
      await this.notifyContinue(runtimeRoot);
      return { status: "applied", dagGeneration: runtimeState.dagGeneration };
    }
    if (!["pending", "retry_ready", "interrupted"].includes(state.status)) return { status: state.status, proposalGeneration: state.activeProposalGeneration };
    const service = new TaskPreflightService(remediation.workItemRoot, (await remediation.runtime.status()).issueId, "remediation");
    const proposal = await service.readProposal();
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
    const location: PreflightLocation = { kind: "preflight", runtimeRoot, workItemRoot: remediation.workItemRoot, issueId: proposal.issueId, bindingId: binding.id, proposalGeneration: proposal.generation };
    this.bindings.set(binding.id, location);
    this.models.set(`preflight:${runtimeRoot}`, model);
    const prompt = [
      "Role: independent Forge Remediation Task Preflight Reviewer",
      `Binding ID: ${binding.id}`,
      `Runtime root: ${runtimeRoot}`,
      `Proposal: ${service.root}/proposals/proposal-${proposal.generation}.json`,
      `Proposal hash: ${proposal.proposalHash}`,
      `Confirmed Finding hash: ${proposal.sourceFindingHash}`,
      `Frozen PRD generation/hash: ${proposal.sourcePrdGeneration}/${proposal.sourcePrdHash}`,
      `Frozen Issue hash: ${proposal.sourceIssueHash}`,
      `Frozen Acceptance IDs: ${(proposal.acceptanceIds ?? []).join(", ")}`,
      `Frozen Decision IDs: ${(proposal.decisionIds ?? []).join(", ")}`,
      `Frozen PRD: ${remediation.workItemRoot}/PRD.md`,
      `Frozen Issue: ${remediation.issueRoot}/ISSUE.md`,
      "",
      "Read the frozen PRD and Issue as authoritative constraints. Check that every repair Task is a small directly executable commit, reads only exact evidence seams, has a detailed Blueprint, stays within the confirmed Finding and Issue scope, preserves Acceptance/Decisions/non-goals, forbids unauthorized Fallback, keeps app/composition-root Modules thin without pass-through file fragmentation, and names focused verification and affected Slice Gates.",
      "If the Proposal conflicts with repository instructions, frozen PRD/Issue requirements, accepted Decisions, audit requirements, Task/DAG contracts, Git/workspace safety rules, architecture/public Interface/scope, or exposes an unresolved product choice, request human input through forge_run_human_decision_request instead of merely suggesting an implementation. Otherwise block any Task that requires investigation, changes frozen Acceptance or architecture, combines independently committable repairs, or lacks direct Finding traceability.",
      "Do not modify files. Call forge_run_remediation_preflight_submit exactly once, then stop.",
    ].join("\n");
    try {
      const agentId = await this.adapter.spawn({ type: "forge-reviewer", prompt, description: preflightDescription(binding.id, proposal.issueId, proposal.generation), model, thinkingLevel: binding.thinking, maxTurns: binding.maxTurns, cwd: proposal.source.repositoryRoot });
      await service.bindAgent(binding.id, agentId);
      this.agents.set(agentId, location);
      return { status: "started", proposalGeneration: proposal.generation, bindingId: binding.id, agentId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await service.markSpawnFailed(binding.id, message);
      return { status: "failed", proposalGeneration: proposal.generation, bindingId: binding.id, error: message };
    }
  }

  async requestHumanDecision(runtimeRoot: string, input: Parameters<RuntimeService["requestHumanDecision"]>[0]) {
    return new RuntimeService(runtimeRoot).requestHumanDecision(input);
  }

  async answerHumanDecision(runtimeRoot: string, input: Parameters<RuntimeService["answerHumanDecision"]>[0]) {
    return new RuntimeService(runtimeRoot).answerHumanDecision(input);
  }

  async resumeHumanDecision(runtimeRoot: string, requestId: string, ctx: ExtensionContext) {
    const runtime = new RuntimeService(runtimeRoot);
    const resumed = await runtime.resumeHumanDecision(requestId);
    const selected = resumed.state.humanDecision?.answer?.selectedOptionId;
    if (selected === "abort") return { ...resumed, resumed: false };
    if (resumed.action === "supersede_work_item") {
      return {
        ...resumed,
        resumed: false,
        nextAction: {
          skill: "forge-prd",
          tool: "forge_prd_supersede",
          predecessorWorkItemRoot: new RemediationService(runtimeRoot).workItemRoot,
          reason: "Frozen planning must be superseded by a new Work Item; the current Issue Runtime remains immutable and blocked.",
        },
      };
    }
    if (resumed.action === "rerun_verifier") return { ...resumed, resumed: true, next: await this.startVerifier(runtimeRoot, ctx) };
    if (resumed.action === "resume_planner") return { ...resumed, resumed: true, next: await this.startPlanner(runtimeRoot, ctx) };
    throw new Error(`Unsupported Human Decision resume action: ${resumed.action}`);
  }

  async submitPreflight(runtimeRoot: string, bindingId: string, proposalHash: string, verdict: TaskPreflightVerdict, findings: TaskPreflightFinding[]) {
    const remediation = new RemediationService(runtimeRoot);
    const issueId = (await remediation.runtime.status()).issueId;
    const service = new TaskPreflightService(remediation.workItemRoot, issueId, "remediation");
    const submitted = await service.submitResult({ bindingId, proposalHash, verdict, findings });
    if (verdict === "blocked") {
      await remediation.runtime.store.transact("remediation_preflight_blocked", (state) => {
        if (!state.remediationPlan) throw new Error("Missing Remediation Plan");
        state.remediationPlan.status = "awaiting_proposal";
        state.remediationPlan.updatedAt = new Date().toISOString();
      }, { details: { proposalHash, resultHash: submitted.result.resultHash } });
      return { status: "blocked", state: await remediation.runtime.status() };
    }
    const state = await remediation.applyPassed();
    await this.notifyContinue(runtimeRoot);
    return { status: "applied", state };
  }

  private async notifyContinue(runtimeRoot: string): Promise<void> {
    await Promise.all([...this.continueHandlers].map((handler) => handler(runtimeRoot)));
  }

  private async locate(event: SubagentLifecycleEvent): Promise<Location | undefined> {
    const existing = this.agents.get(event.id);
    if (existing) return existing;
    const verifier = /^forge-audit-blocker-verifier:([^:]+)$/.exec(event.description);
    if (verifier?.[1]) {
      const location = this.bindings.get(verifier[1]);
      if (location?.kind === "verifier") {
        await new RuntimeService(location.runtimeRoot).bindAuditBlockerVerifier(location.bindingId, event.id);
        this.agents.set(event.id, location);
        return location;
      }
    }
    const planner = /^forge-remediation-planner:([^:]+)$/.exec(event.description);
    if (planner?.[1]) {
      const location = this.bindings.get(planner[1]);
      if (location?.kind === "planner") {
        await new RuntimeService(location.runtimeRoot).bindRemediationPlanner(location.bindingId, event.id);
        this.agents.set(event.id, location);
        return location;
      }
    }
    const preflight = /^forge-remediation-preflight:([^:]+):(I\d+):(\d+)$/.exec(event.description);
    if (preflight?.[1]) {
      const location = this.bindings.get(preflight[1]);
      if (location?.kind === "preflight") {
        await new TaskPreflightService(location.workItemRoot, location.issueId, "remediation").bindAgent(location.bindingId, event.id);
        this.agents.set(event.id, location);
        return location;
      }
    }
    return undefined;
  }

  private started(event: SubagentLifecycleEvent): void {
    void (async () => {
      const location = await this.locate(event);
      if (!location) return;
      if (location.kind === "verifier") await new RuntimeService(location.runtimeRoot).markAuditBlockerVerifierStarted(event.id);
      else if (location.kind === "planner") await new RuntimeService(location.runtimeRoot).markRemediationPlannerStarted(event.id);
      else await new TaskPreflightService(location.workItemRoot, location.issueId, "remediation").markStarted(event.id);
    })().catch((error) => console.error("[pi-forge-workflow] Audit Remediation started event failed", error));
  }

  private terminal(event: SubagentLifecycleEvent, terminal: "completed" | "failed" | "stopped" | "aborted"): void {
    void (async () => {
      const location = await this.locate(event);
      if (!location) return;
      if (location.kind === "verifier") {
        const runtime = new RuntimeService(location.runtimeRoot);
        const state = await runtime.markAuditBlockerVerifierTerminal(event.id, terminal, event.error);
        const job = state.auditBlockerVerifierJob;
        if (!job || job.result || !["retry_ready", "interrupted"].includes(job.status) || job.attempt >= job.maxAttempts) return;
        const model = this.models.get(`verifier:${location.runtimeRoot}`);
        if (model) {
          const manifest = await runtime.store.readManifest();
          const binding = RuntimeService.createAuditBlockerVerifierBinding({ attempt: job.attempt + 1, findingHash: job.findingHash, model: job.model, thinking: job.thinking, maxTurns: job.maxTurns, startedGeneration: state.generation });
          await runtime.claimAuditBlockerVerifier(binding);
          const nextLocation: VerifierLocation = { kind: "verifier", runtimeRoot: location.runtimeRoot, bindingId: binding.id };
          this.bindings.set(binding.id, nextLocation);
          const agentId = await this.adapter.spawn({ type: "forge-reviewer", prompt: `Retry final Audit Blocker verification. Runtime root: ${location.runtimeRoot}\nBinding ID: ${binding.id}\nCall forge_run_audit_blockers_verify exactly once.`, description: verifierDescription(binding.id), model, thinkingLevel: binding.thinking, maxTurns: binding.maxTurns, cwd: manifest.workspaceRoot });
          await runtime.bindAuditBlockerVerifier(binding.id, agentId);
          this.agents.set(agentId, nextLocation);
        }
      } else if (location.kind === "planner") {
        await new RuntimeService(location.runtimeRoot).markRemediationPlannerTerminal(event.id, terminal, event.error);
      } else {
        const service = new TaskPreflightService(location.workItemRoot, location.issueId, "remediation");
        await service.markTerminal(event.id, terminal, event.error);
      }
    })().catch((error) => console.error("[pi-forge-workflow] Audit Remediation terminal event failed", error));
  }
}
