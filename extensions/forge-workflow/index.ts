import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { TaskExecutionService } from "../../src/execution/service.js";
import { resolveModelProfile } from "../../src/model/router.js";
import { RuntimeService } from "../../src/runtime/service.js";
import type { IssueAuditAxis, IssueAuditFinding, TaskContract, TaskHandoff } from "../../src/runtime/types.js";
import { PiSubagentsAdapter, type SubagentLifecycleEvent } from "../../src/subagents/adapter.js";
import { AuditRemediationOrchestrator } from "./audit-remediation-orchestrator.js";
import { registerInitTools } from "./init-tools.js";
import { IssueAuditOrchestrator } from "./issue-audit-orchestrator.js";
import { registerIssueTools } from "./issue-tools.js";
import { PrdReviewOrchestrator } from "./prd-review-orchestrator.js";
import { registerPrdTools } from "./prd-tools.js";
import { TaskPreflightOrchestrator } from "./task-preflight-orchestrator.js";
import { registerTaskTools } from "./task-tools.js";

interface BindingLocation {
  runtimeRoot: string;
  taskId: string;
  bindingId: string;
}

const RuntimeRoot = Type.String({ description: "Absolute or cwd-relative Issue Runtime directory" });

function text(content: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text: content }], details };
}

function normalizeRoot(cwd: string, input: string): string {
  return resolve(cwd, input.replace(/^@/, ""));
}

function bindingDescription(bindingId: string, taskId: string): string {
  return `workflow:${bindingId}:${taskId}`;
}

function parseBindingDescription(description: string): { bindingId: string; taskId: string } | undefined {
  const match = /^workflow:([^:]+):(T\d+)$/.exec(description);
  return match?.[1] && match[2] ? { bindingId: match[1], taskId: match[2] } : undefined;
}

async function resolveExactModel(ctx: ExtensionContext, input: string): Promise<unknown> {
  const slash = input.indexOf("/");
  if (slash < 1) throw new Error(`Model must be exact provider/model: ${input}`);
  const provider = input.slice(0, slash);
  const modelId = input.slice(slash + 1);
  const model = ctx.modelRegistry.find(provider, modelId);
  if (!model) throw new Error(`Configured model is unavailable: ${input}`);
  return model;
}

function findContract(contracts: TaskContract[], taskId: string): TaskContract {
  const contract = contracts.find((candidate) => candidate.id === taskId);
  if (!contract) throw new Error(`Missing Task contract: ${taskId}`);
  return contract;
}

export default function taskWorkflowExtension(pi: ExtensionAPI) {
  const adapter = new PiSubagentsAdapter(pi.events);
  const prdReviewOrchestrator = new PrdReviewOrchestrator(adapter);
  const issueAuditOrchestrator = new IssueAuditOrchestrator(adapter);
  const taskPreflightOrchestrator = new TaskPreflightOrchestrator(adapter);
  const auditRemediationOrchestrator = new AuditRemediationOrchestrator(adapter);
  registerInitTools(pi, adapter);
  registerPrdTools(pi, prdReviewOrchestrator);
  registerIssueTools(pi);
  registerTaskTools(pi, taskPreflightOrchestrator);
  const bindingLocations = new Map<string, BindingLocation>();
  const agentLocations = new Map<string, BindingLocation>();

  issueAuditOrchestrator.onResult(async (runtimeRoot, state) => {
    if (state.issueStatus !== "blocked") return;
    const blockers = Object.entries(state.audits ?? {}).flatMap(([axis, audit]) =>
      (audit?.findings ?? []).filter((finding) => finding.severity === "blocker").map((finding) => ({ axis, ...finding })),
    );
    if (blockers.length === 0) return;
    pi.events.emit("forge:issue-audit-blocked", { runtimeRoot, issueId: state.issueId, generation: state.generation, blockers });
    console.error(`[pi-forge-workflow] Issue ${state.issueId} final Audit blocked with ${blockers.length} finding(s). Starting independent Blocker Verification.`);
  });

  let extensionContext: ExtensionContext | undefined;
  let backgroundQueue: Promise<void> = Promise.resolve();
  const enqueueBackground = (label: string, operation: () => Promise<void>) => {
    backgroundQueue = backgroundQueue.then(operation, operation).catch((error) => console.error(`[pi-forge-workflow] ${label} failed`, error));
  };
  auditRemediationOrchestrator.onContinue(async (runtimeRoot) => {
    pi.events.emit("forge:run-continue-ready", { runtimeRoot });
    if (!extensionContext) return;
    enqueueBackground("automatic Remediation continuation", async () => {
      const service = await indexRuntime(runtimeRoot);
      const state = await new TaskExecutionService(runtimeRoot).runReadySliceGates();
      const frontier = await service.frontier();
      if (frontier.length > 0) {
        await startFrontier(runtimeRoot, undefined, extensionContext!);
      } else if (state.issueStatus === "auditing") {
        await issueAuditOrchestrator.start(runtimeRoot, extensionContext!);
      }
    });
  });
  auditRemediationOrchestrator.onReaudit(async (runtimeRoot) => {
    pi.events.emit("forge:run-reaudit-ready", { runtimeRoot });
    if (extensionContext) enqueueBackground("automatic final re-audit", async () => { await issueAuditOrchestrator.start(runtimeRoot, extensionContext!); });
  });
  pi.on("session_start", async (_event, ctx) => { extensionContext = ctx; });

  async function indexRuntime(runtimeRoot: string): Promise<RuntimeService> {
    const service = new RuntimeService(runtimeRoot);
    const state = await service.status();
    for (const task of Object.values(state.tasks)) {
      if (!task.binding) continue;
      const location = { runtimeRoot, taskId: task.id, bindingId: task.binding.id };
      bindingLocations.set(task.binding.id, location);
      if (task.binding.agentId) agentLocations.set(task.binding.agentId, location);
    }
    return service;
  }

  async function bindLifecycleAgent(event: SubagentLifecycleEvent): Promise<BindingLocation | undefined> {
    const existing = agentLocations.get(event.id);
    if (existing) return existing;
    const parsed = parseBindingDescription(event.description);
    if (!parsed) return undefined;
    const location = bindingLocations.get(parsed.bindingId);
    if (!location || location.taskId !== parsed.taskId) return undefined;
    const service = new RuntimeService(location.runtimeRoot);
    await service.bindAgent(location.taskId, location.bindingId, event.id);
    agentLocations.set(event.id, location);
    return location;
  }

  adapter.onStarted((event) => {
    void (async () => {
      const location = await bindLifecycleAgent(event);
      if (!location) return;
      await new RuntimeService(location.runtimeRoot).markAgentStarted(event.id);
    })().catch((error: unknown) => console.error("[pi-forge-workflow] started event failed", error));
  });

  async function finalizeTaskAgent(location: BindingLocation, event: SubagentLifecycleEvent, terminal: "completed" | "failed" | "stopped" | "aborted"): Promise<void> {
    const service = new RuntimeService(location.runtimeRoot);
    const state = await service.markAgentTerminal(event.id, terminal, event.error);
    const task = state.tasks[location.taskId];
    if (task?.handoffStatus !== "valid") return;
    const execution = new TaskExecutionService(location.runtimeRoot);
    const result = await execution.finalizeTask(location.taskId);
    if (!result.commit) return;
    const integrated = await execution.runReadySliceGates();
    if (!extensionContext) return;
    const frontier = await service.frontier();
    if (frontier.length > 0) await startFrontier(location.runtimeRoot, undefined, extensionContext);
    else if (integrated.remediationPlan?.source === "slice_gate" && integrated.remediationPlan.status === "awaiting_proposal") await auditRemediationOrchestrator.startPlanner(location.runtimeRoot, extensionContext);
    else if (integrated.issueStatus === "auditing") await issueAuditOrchestrator.start(location.runtimeRoot, extensionContext);
  }

  adapter.onCompleted((event) => {
    void (async () => {
      const location = await bindLifecycleAgent(event);
      if (!location) return;
      await finalizeTaskAgent(location, event, "completed");
    })().catch((error: unknown) => console.error("[pi-forge-workflow] completed event failed", error));
  });

  adapter.onFailed((event) => {
    void (async () => {
      const location = await bindLifecycleAgent(event);
      if (!location) return;
      const status = event.status === "stopped" || event.status === "aborted" ? event.status : "failed";
      await finalizeTaskAgent(location, event, status);
    })().catch((error: unknown) => console.error("[pi-forge-workflow] failed event failed", error));
  });

  async function startFrontier(runtimeRoot: string, signal: AbortSignal | undefined, ctx: ExtensionContext) {
    const service = await indexRuntime(runtimeRoot);
    await service.doctor();
    const [taskId] = await service.frontier();
    if (!taskId) return text("No Task is currently eligible to run.", { runtimeRoot, taskId: null });

    const manifest = await service.store.readManifest();
    const dag = await service.store.readDag();
    const contract = findContract(dag.tasks, taskId);
    const taskVersion = contract.version;
    const activeModelPolicy = await service.activeModelPolicy();
    const route = resolveModelProfile(activeModelPolicy.policy, {
      role: "task-worker",
      ...(contract.modelProfile ? { taskProfile: contract.modelProfile } : {}),
      ...(manifest.issueModelProfile ? { issueProfile: manifest.issueModelProfile } : {}),
    });
    const model = await resolveExactModel(ctx, route.model);
    const state = await service.status();
    const baselineCommit = await new TaskExecutionService(runtimeRoot).requireCleanWorkspace();
    const taskContractPath = `tasks/${taskId}/TASK-V${String(taskVersion).padStart(3, "0")}.md`;
    const binding = RuntimeService.createBinding({
      workItemId: manifest.workItemId,
      issueId: manifest.issueId,
      taskId,
      taskVersion,
      taskContractPath,
      attempt: (state.tasks[taskId]?.attempt ?? 0) + 1,
      workspace: manifest.workspaceRoot,
      baselineCommit,
      contractHash: contract.contractHash,
      model: route.model,
      thinking: route.thinking,
      maxTurns: route.maxTurns,
      modelPolicyGeneration: activeModelPolicy.generation,
      startedGeneration: state.generation,
    });
    await service.claimTask(taskId, binding);
    const location = { runtimeRoot, taskId, bindingId: binding.id };
    bindingLocations.set(binding.id, location);

    const taskPath = join(dirname(runtimeRoot), binding.taskContractPath);
    const prompt = [
      `Task: ${taskId}`,
      `Runtime root: ${runtimeRoot}`,
      `Binding ID: ${binding.id}`,
      `Contract hash: ${contract.contractHash}`,
      `Frozen Task contract: ${taskPath}`,
      `Task identity: ${binding.workItemId}/${binding.issueId}/${binding.taskId}@V${String(binding.taskVersion).padStart(3, "0")}`,
      "Call task_resume before any other workflow action. Follow the frozen Implementation Blueprint, checkpoint progress, submit task_handoff once, then stop.",
    ].join("\n");

    try {
      const protocol = await adapter.ping();
      if (protocol < 2) throw new Error(`Unsupported pi-subagents RPC protocol: ${protocol}`);
      const agentId = await adapter.spawn({
        type: "task-worker",
        prompt,
        description: bindingDescription(binding.id, taskId),
        model,
        thinkingLevel: route.thinking,
        maxTurns: route.maxTurns,
        cwd: manifest.workspaceRoot,
      });
      await service.bindAgent(taskId, binding.id, agentId);
      agentLocations.set(agentId, location);
      return text(`Started ${taskId} as ${agentId} using ${route.model}:${route.thinking}.`, {
        runtimeRoot,
        taskId,
        bindingId: binding.id,
        agentId,
        route,
        modelPolicyGeneration: activeModelPolicy.generation,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await service.markSpawnFailed(taskId, message);
      throw error;
    } finally {
      if (signal?.aborted) {
        const current = await service.status();
        const agentId = current.tasks[taskId]?.binding?.agentId;
        if (agentId) await adapter.stop(agentId).catch(() => undefined);
      }
    }
  }

  pi.registerTool({
    name: "workflow_status",
    label: "Workflow Status",
    description: "Read and reconcile one deterministic Issue Runtime",
    promptSnippet: "Inspect a Forge Runtime without editing its JSON files",
    parameters: Type.Object({ runtimeRoot: RuntimeRoot }),
    async execute(_id, params, _signal, _update, ctx) {
      const runtimeRoot = normalizeRoot(ctx.cwd, params.runtimeRoot);
      const service = await indexRuntime(runtimeRoot);
      const doctor = await service.doctor();
      const frontier = await service.frontier();
      return text(JSON.stringify({ repaired: doctor.repaired, frontier, state: doctor.state }, null, 2), {
        runtimeRoot,
        repaired: doctor.repaired,
        frontier,
        state: doctor.state,
      });
    },
  });

  pi.registerTool({
    name: "run_task_frontier",
    label: "Run Task Frontier",
    description: "Deterministically claim and spawn the next eligible Micro Task through pi-subagents",
    promptSnippet: "Claim and start the next ready Micro Task from a finalized Runtime",
    parameters: Type.Object({ runtimeRoot: RuntimeRoot }),
    async execute(_id, params, signal, _update, ctx) {
      return startFrontier(normalizeRoot(ctx.cwd, params.runtimeRoot), signal, ctx);
    },
  });

  pi.registerTool({
    name: "forge_run_status",
    label: "Forge Run Status",
    description: "Read one executable Forge Issue Runtime, Task receipts, Slice Gates, and current frontier",
    parameters: Type.Object({ runtimeRoot: RuntimeRoot }),
    async execute(_id, params, _signal, _update, ctx) {
      const runtimeRoot = normalizeRoot(ctx.cwd, params.runtimeRoot);
      const service = await indexRuntime(runtimeRoot);
      await issueAuditOrchestrator.index(runtimeRoot);
      const doctor = await service.doctor();
      const frontier = await service.frontier();
      return text(JSON.stringify({ runtimeRoot, repaired: doctor.repaired, frontier, state: doctor.state }, null, 2), { runtimeRoot, repaired: doctor.repaired, frontier, state: doctor.state });
    },
  });

  pi.registerTool({
    name: "forge_run_continue",
    label: "Forge Run Continue",
    description: "Finalize any submitted Handoff, run ready Slice Gates, or claim and spawn the next deterministic Micro Task",
    parameters: Type.Object({ runtimeRoot: RuntimeRoot }),
    async execute(_id, params, signal, _update, ctx) {
      const runtimeRoot = normalizeRoot(ctx.cwd, params.runtimeRoot);
      const service = await indexRuntime(runtimeRoot);
      let state = await service.status();
      const execution = new TaskExecutionService(runtimeRoot);
      const activeModelPolicy = await service.activeModelPolicy();
      for (const task of Object.values(state.tasks)) {
        const blockedByObsoleteRetryBudget = task.status === "blocked"
          && task.blocker === "Recover interrupted Task before a fresh Binding"
          && (task.binding?.modelPolicyGeneration ?? 1) < activeModelPolicy.generation;
        if ((["retry_ready", "interrupted"].includes(task.status) || blockedByObsoleteRetryBudget) && task.binding && task.handoffStatus !== "valid" && ["completed", "failed", "stopped", "aborted"].includes(task.agentStatus)) {
          await execution.prepareRetry(task.id);
          state = await service.status();
        }
      }
      for (const task of Object.values(state.tasks)) {
        if (task.status === "awaiting_verification" && task.handoffStatus === "valid" && ["completed", "failed", "stopped", "aborted"].includes(task.agentStatus)) {
          await execution.finalizeTask(task.id);
          state = await service.status();
        }
      }
      state = await execution.runReadySliceGates();
      const frontier = await service.frontier();
      if (frontier.length > 0) return startFrontier(runtimeRoot, signal, ctx);
      if (state.remediationPlan?.source === "slice_gate" && state.remediationPlan.status === "awaiting_proposal") {
        const planner = await auditRemediationOrchestrator.startPlanner(runtimeRoot, ctx);
        return text(`Slice Gate ${state.remediationPlan.sourceSliceId} failed and started the bounded Remediation Planner.`, { runtimeRoot, frontier, state: await service.status(), planner });
      }
      if (state.issueStatus === "auditing") {
        const auditSpawns = await issueAuditOrchestrator.start(runtimeRoot, ctx);
        state = await service.status();
        return text(`Started ${auditSpawns.filter((spawn) => spawn.status === "started").length} final Issue Auditors.`, { runtimeRoot, frontier, state, auditSpawns });
      }
      return text(`Issue ${state.issueId} is ${state.issueStatus}; no Task is currently spawnable.`, { runtimeRoot, frontier, state });
    },
  });

  pi.registerTool({
    name: "forge_run_audit_submit",
    label: "Forge Run Audit Submit",
    description: "Submit one Binding-bound final Issue Audit result for Standards, Spec/Integration, or Architecture/Minimality",
    parameters: Type.Object({
      runtimeRoot: RuntimeRoot,
      bindingId: Type.String(),
      axis: Type.Union([Type.Literal("standards"), Type.Literal("spec_integration"), Type.Literal("architecture_minimality")]),
      verdict: Type.Union([Type.Literal("passed"), Type.Literal("blocked")]),
      findings: Type.Array(Type.Object({
        id: Type.String(),
        severity: Type.Union([Type.Literal("blocker"), Type.Literal("warning"), Type.Literal("note")]),
        message: Type.String(),
        evidence: Type.Array(Type.String()),
        violatedRule: Type.String(),
        verification: Type.String(),
        suggestedResolution: Type.Optional(Type.String()),
      })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const runtimeRoot = normalizeRoot(ctx.cwd, params.runtimeRoot);
      const state = await new RuntimeService(runtimeRoot).submitAudit(
        params.bindingId,
        params.axis as IssueAuditAxis,
        params.verdict,
        params.findings as IssueAuditFinding[],
      );
      await issueAuditOrchestrator.notifyResult(runtimeRoot, state);
      const verifier = state.issueStatus === "blocked" ? await auditRemediationOrchestrator.startVerifier(runtimeRoot, ctx) : undefined;
      const blockers = Object.entries(state.audits ?? {}).flatMap(([axis, audit]) =>
        (audit?.findings ?? []).filter((finding) => finding.severity === "blocker").map((finding) => ({ axis, ...finding })),
      );
      const message = state.issueStatus === "blocked"
        ? `${params.axis} Issue Audit blocked the Issue with ${blockers.length} current Blocker(s). The coordinator has been notified; do not edit Runtime or product code outside a verified Remediation DAG Amendment.`
        : `${params.axis} Issue Audit recorded as ${params.verdict}.`;
      return { ...text(message, { runtimeRoot, state: await new RuntimeService(runtimeRoot).status(), blockers, verifier: verifier ?? null, coordinatorEvent: state.issueStatus === "blocked" ? "forge:issue-audit-blocked" : null }), terminate: true };
    },
  });

  pi.registerTool({
    name: "forge_run_audit_blockers_verify",
    label: "Forge Run Audit Blockers Verify",
    description: "Submit independent Binding-bound verification for every current final Audit Blocker",
    parameters: Type.Object({
      runtimeRoot: RuntimeRoot,
      bindingId: Type.String(),
      results: Type.Array(Type.Object({
        findingId: Type.String(),
        status: Type.Union([Type.Literal("confirmed"), Type.Literal("rejected"), Type.Literal("needs_more_evidence")]),
        evidence: Type.Array(Type.String()),
        rationale: Type.String(),
        missingEvidence: Type.Array(Type.String()),
      })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const runtimeRoot = normalizeRoot(ctx.cwd, params.runtimeRoot);
      const result = await auditRemediationOrchestrator.submitVerification(runtimeRoot, params.bindingId, params.results, ctx);
      const message = result.needsUser
        ? "Audit Blocker Verification needs more evidence; Issue remains blocked for user input."
        : result.remediationRequired
          ? "Confirmed Audit Blockers created a Remediation Plan and started the bound Remediation Planner."
          : "All final Audit Blockers were rejected; a fresh final Audit cycle can start.";
      return { ...text(message, { runtimeRoot, ...result }), terminate: true };
    },
  });

  pi.registerTool({
    name: "forge_run_remediation_propose",
    label: "Forge Run Remediation Propose",
    description: "Submit a Binding-bound Remediation Micro Task Proposal for confirmed final Audit Findings and start independent Preflight",
    parameters: Type.Object({
      runtimeRoot: RuntimeRoot,
      bindingId: Type.String(),
      tasks: Type.Array(Type.Object({
        id: Type.String(), title: Type.String(), sliceId: Type.String(), goal: Type.String(),
        editPoint: Type.Object({ path: Type.String(), symbol: Type.String() }),
        reads: Type.Array(Type.Object({ path: Type.String(), symbol: Type.String(), reason: Type.String() })),
        writes: Type.Array(Type.String()), dependencies: Type.Array(Type.String()), conflicts: Type.Array(Type.String()),
        produces: Type.Array(Type.String()), consumes: Type.Array(Type.String()), acceptanceIds: Type.Array(Type.String()),
        implementationBlueprint: Type.Array(Type.String()), outOfScope: Type.Array(Type.String()),
        verification: Type.Array(Type.Object({ command: Type.String(), timeoutMs: Type.Integer() })),
        modelProfile: Type.Optional(Type.String()),
      })),
      rerunSliceIds: Type.Array(Type.String()),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const runtimeRoot = normalizeRoot(ctx.cwd, params.runtimeRoot);
      const result = await auditRemediationOrchestrator.proposeRemediation(runtimeRoot, params.bindingId, params.tasks, params.rerunSliceIds, ctx);
      return { ...text(`Remediation Proposal is ${result.status}.`, { runtimeRoot, ...result }), terminate: true };
    },
  });

  pi.registerTool({
    name: "forge_run_remediation_preflight_submit",
    label: "Forge Run Remediation Preflight Submit",
    description: "Submit one Binding-bound Remediation Task Preflight result; a pass atomically appends a new DAG Generation",
    parameters: Type.Object({
      runtimeRoot: RuntimeRoot,
      bindingId: Type.String(),
      proposalHash: Type.String(),
      verdict: Type.Union([Type.Literal("passed"), Type.Literal("blocked")]),
      findings: Type.Array(Type.Object({
        id: Type.String(), severity: Type.Union([Type.Literal("blocker"), Type.Literal("warning"), Type.Literal("note")]),
        taskId: Type.String(), message: Type.String(), evidence: Type.Array(Type.String()), violatedRule: Type.String(), verification: Type.String(), suggestedResolution: Type.String(),
      })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const runtimeRoot = normalizeRoot(ctx.cwd, params.runtimeRoot);
      const result = await auditRemediationOrchestrator.submitPreflight(runtimeRoot, params.bindingId, params.proposalHash, params.verdict, params.findings);
      return { ...text(result.status === "applied" ? `Remediation passed Preflight and appended DAG Generation ${result.state.dagGeneration}.` : "Remediation Preflight blocked the Proposal; Planner must submit a smaller corrected Proposal.", { runtimeRoot, ...result }), terminate: true };
    },
  });

  pi.registerTool({
    name: "forge_run_human_decision_request",
    label: "Forge Run Human Decision Request",
    description: "Fail closed and persist one structured user decision gate when repository rules, frozen PRD/Issue contracts, audit requirements, architecture, scope, repository safety, or missing evidence prevents autonomous remediation",
    parameters: Type.Object({
      runtimeRoot: RuntimeRoot,
      kind: Type.Union([
        Type.Literal("missing_evidence"), Type.Literal("ambiguous_remediation"), Type.Literal("frozen_contract_violation"),
        Type.Literal("architecture_change"), Type.Literal("public_interface_change"), Type.Literal("scope_change"),
        Type.Literal("repository_rule_conflict"), Type.Literal("unsafe_repository_operation"),
      ]),
      source: Type.Union([Type.Literal("blocker_verifier"), Type.Literal("remediation_planner"), Type.Literal("remediation_preflight"), Type.Literal("coordinator")]),
      sourceBindingId: Type.Optional(Type.String()),
      question: Type.String(), reason: Type.String(), evidence: Type.Array(Type.String()),
      options: Type.Array(Type.Object({ id: Type.String(), label: Type.String(), description: Type.String(), consequences: Type.Array(Type.String()), resumeAction: Type.Union([Type.Literal("rerun_verifier"), Type.Literal("resume_planner"), Type.Literal("require_prd_amendment"), Type.Literal("abort_issue")]) })),
      recommendedOptionId: Type.Optional(Type.String()),
      resumeAction: Type.Union([Type.Literal("rerun_verifier"), Type.Literal("resume_planner"), Type.Literal("require_prd_amendment"), Type.Literal("abort_issue")]),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const runtimeRoot = normalizeRoot(ctx.cwd, params.runtimeRoot);
      const state = await auditRemediationOrchestrator.requestHumanDecision(runtimeRoot, params);
      pi.events.emit("forge:human-decision-required", { runtimeRoot, request: state.humanDecision });
      return { ...text(`Human decision required: ${state.humanDecision?.question}`, { runtimeRoot, state, request: state.humanDecision }), terminate: true };
    },
  });

  pi.registerTool({
    name: "forge_run_human_decision_answer",
    label: "Forge Run Human Decision Answer",
    description: "Record an explicit authorized user answer for the current immutable Human Decision Request without resuming execution yet",
    parameters: Type.Object({
      runtimeRoot: RuntimeRoot, requestId: Type.String(), requestHash: Type.String(), selectedOptionId: Type.Optional(Type.String()),
      decision: Type.String(), rationale: Type.String(), evidence: Type.Array(Type.String()), answeredBy: Type.String(), authorizationEvidence: Type.String(),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const runtimeRoot = normalizeRoot(ctx.cwd, params.runtimeRoot);
      const state = await auditRemediationOrchestrator.answerHumanDecision(runtimeRoot, params);
      return text(`Recorded user decision ${params.requestId}. Explicit resume is still required.`, { runtimeRoot, state, request: state.humanDecision });
    },
  });

  pi.registerTool({
    name: "forge_run_human_decision_resume",
    label: "Forge Run Human Decision Resume",
    description: "Resume the exact verifier or planner continuation authorized by an answered Human Decision Request",
    parameters: Type.Object({ runtimeRoot: RuntimeRoot, requestId: Type.String() }),
    async execute(_id, params, _signal, _update, ctx) {
      const runtimeRoot = normalizeRoot(ctx.cwd, params.runtimeRoot);
      const result = await auditRemediationOrchestrator.resumeHumanDecision(runtimeRoot, params.requestId, ctx);
      return text(result.resumed ? `Resumed ${result.action} from user decision ${params.requestId}.` : `Decision ${params.requestId} requires ${result.action}; automatic execution remains stopped.`, { runtimeRoot, ...result });
    },
  });

  pi.registerTool({
    name: "task_resume",
    label: "Task Resume",
    description: "Validate a worker binding and return the exact frozen Task context pointer",
    parameters: Type.Object({ runtimeRoot: RuntimeRoot, bindingId: Type.String() }),
    async execute(_id, params, _signal, _update, ctx) {
      const runtimeRoot = normalizeRoot(ctx.cwd, params.runtimeRoot);
      const service = await indexRuntime(runtimeRoot);
      const state = await service.status();
      const task = Object.values(state.tasks).find((candidate) => candidate.binding?.id === params.bindingId);
      if (!task?.binding) throw new Error(`Unknown binding: ${params.bindingId}`);
      const taskPath = join(dirname(runtimeRoot), task.binding.taskContractPath);
      return text(`Binding valid. Read ${taskPath}. Next action: ${task.checkpoint?.nextAction ?? "start the Implementation Blueprint"}.`, {
        runtimeRoot,
        workItemId: task.binding.workItemId,
        issueId: task.binding.issueId,
        taskId: task.id,
        taskVersion: task.binding.taskVersion,
        taskPath,
        contractHash: task.binding.contractHash,
        checkpoint: task.checkpoint ?? null,
      });
    },
  });

  pi.registerTool({
    name: "task_checkpoint",
    label: "Task Checkpoint",
    description: "Persist a short semantic checkpoint for the current worker binding",
    parameters: Type.Object({
      runtimeRoot: RuntimeRoot,
      bindingId: Type.String(),
      currentStep: Type.String(),
      nextAction: Type.String(),
      changedFiles: Type.Array(Type.String()),
      verificationNotes: Type.Array(Type.String()),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const runtimeRoot = normalizeRoot(ctx.cwd, params.runtimeRoot);
      const state = await new RuntimeService(runtimeRoot).checkpoint(params.bindingId, {
        currentStep: params.currentStep,
        nextAction: params.nextAction,
        changedFiles: params.changedFiles,
        verificationNotes: params.verificationNotes,
      });
      return text("Checkpoint saved.", { state });
    },
  });

  pi.registerTool({
    name: "task_handoff",
    label: "Task Handoff",
    description: "Submit a structured implementation handoff; this requests verification and does not complete the Task",
    parameters: Type.Object({
      runtimeRoot: RuntimeRoot,
      bindingId: Type.String(),
      changedFiles: Type.Array(Type.String()),
      verification: Type.Array(Type.Object({
        command: Type.String(),
        exitCode: Type.Integer(),
        keyOutput: Type.Optional(Type.String()),
      })),
      produced: Type.Array(Type.String()),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const runtimeRoot = normalizeRoot(ctx.cwd, params.runtimeRoot);
      const handoff: Omit<TaskHandoff, "submittedAt"> = {
        changedFiles: params.changedFiles,
        verification: params.verification,
        produced: params.produced,
      };
      const state = await new RuntimeService(runtimeRoot).submitHandoff(params.bindingId, handoff);
      return { ...text("Handoff accepted; waiting for the agent to stop and authoritative verification.", { state }), terminate: true };
    },
  });

  pi.registerCommand("workflow-status", {
    description: "Show a Forge Runtime status",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify("Usage: /workflow-status <runtime-root>", "warning");
        return;
      }
      const service = await indexRuntime(normalizeRoot(ctx.cwd, args.trim()));
      const doctor = await service.doctor();
      const frontier = await service.frontier();
      ctx.ui.notify(`Issue ${doctor.state.issueId}: ${doctor.state.issueStatus}; frontier: ${frontier.join(", ") || "none"}`, "info");
    },
  });
}
