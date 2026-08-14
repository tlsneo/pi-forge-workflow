import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { validateBlueprintEvidence } from "./blueprint.js";
import { calculateFrontier, refreshReadyStates, validateDag } from "./dag.js";
import { stableHash } from "./hash.js";
import { appendJsonLine, atomicWriteJson, RuntimeStore } from "./store.js";
import type {
  AuditBlockerVerifierBinding,
  AuditBlockerVerifierJob,
  AuditBlockerVerificationResult,
  DagAmendment,
  HumanDecisionAnswer,
  HumanDecisionRequest,
  IssueAuditAxis,
  IssueAuditBinding,
  IssueAuditFinding,
  IssueAuditJob,
  IssueAuditReview,
  IssueRuntimeState,
  ModelPolicy,
  RemediationPlannerBinding,
  RemediationPlannerJob,
  RuntimeManifest,
  TaskBinding,
  TaskCheckpoint,
  TaskConformanceBinding,
  TaskConformanceFinding,
  TaskConformanceJob,
  TaskConformanceResult,
  TaskConformanceSurface,
  TaskConformanceVerdict,
  TaskContract,
  TaskDag,
  TaskHandoff,
  TaskReceipt,
  TaskState,
} from "./types.js";

const TERMINAL_AGENT_STATUSES = new Set(["completed", "failed", "stopped", "aborted"]);

function requireTask(state: IssueRuntimeState, taskId: string) {
  const task = state.tasks[taskId];
  if (!task) throw new Error(`Unknown task: ${taskId}`);
  return task;
}

function requireActiveTaskBinding(state: IssueRuntimeState, bindingId: string) {
  const task = Object.values(state.tasks).find((candidate) => candidate.binding?.id === bindingId);
  if (!task) throw new Error(`Unknown binding: ${bindingId}`);
  if (task.receipt || task.status === "completed" || task.gitStatus === "receipted") {
    throw new Error(`${task.id} has an immutable Task Receipt; Binding ${bindingId} is terminal`);
  }
  if (!["starting", "running"].includes(task.status)) {
    throw new Error(`${task.id} Binding ${bindingId} is not writable from ${task.status}`);
  }
  return task;
}

function receiptMatchesTask(receipt: TaskReceipt, task: TaskState, contract: TaskContract, manifest: RuntimeManifest): boolean {
  return receipt.schemaVersion === 1
    && receipt.workItemId === manifest.workItemId
    && receipt.issueId === manifest.issueId
    && receipt.taskId === task.id
    && receipt.taskVersion === contract.version
    && receipt.taskContractPath === `tasks/${task.id}/TASK-V${String(contract.version).padStart(3, "0")}.md`
    && receipt.contractHash === contract.contractHash
    && (!manifest.taskConformanceRequired || Boolean(receipt.conformance));
}

function issueStatusAfterReceiptReconciliation(state: IssueRuntimeState): IssueRuntimeState["issueStatus"] {
  if (state.humanDecision?.status === "open" || state.remediationPlan?.status === "needs_user") return "needs_user";
  const tasks = Object.values(state.tasks);
  if (tasks.some((task) => task.status === "failed" || task.status === "cancelled")) return "failed";
  if (tasks.some((task) => task.status === "blocked" || task.status === "needs_user")) return "blocked";
  if (tasks.some((task) => task.status !== "completed")) return "executing";
  const gates = Object.values(state.sliceGates ?? {});
  if (gates.some((gate) => gate.status === "failed")) return "blocked";
  if (gates.some((gate) => gate.status !== "passed") || gates.length === 0) return "integrating";
  if (Object.values(state.audits ?? {}).some((audit) => audit?.verdict === "blocked")) return "blocked";
  return state.issueStatus === "completed" ? "completed" : "auditing";
}

export class RuntimeService {
  readonly store: RuntimeStore;

  constructor(root: string) {
    this.store = new RuntimeStore(root);
  }

  async initialize(
    manifestInput: Omit<RuntimeManifest, "schemaVersion" | "dagHash" | "createdAt" | "controlRoot" | "repositoryRoot" | "assuranceProfile" | "taskConformanceRequired"> & {
      controlRoot?: string;
      repositoryRoot?: string;
      assuranceProfile?: RuntimeManifest["assuranceProfile"];
      taskConformanceRequired?: boolean;
    },
    dag: TaskDag,
    slices: Array<{ id: string; gate: Array<{ command: string; timeoutMs: number; proves: string }> }> = [],
  ): Promise<void> {
    validateDag(dag);
    if (!manifestInput.workItemId?.trim()) throw new Error("Runtime requires a Work Item ID");
    if (!manifestInput.issueId.trim()) throw new Error("Runtime requires an Issue ID");
    const now = new Date().toISOString();
    const state: IssueRuntimeState = {
      schemaVersion: 1,
      issueId: manifestInput.issueId,
      issueStatus: "planned",
      generation: 1,
      eventSequence: 1,
      dagGeneration: dag.generation,
      modelPolicyGeneration: 1,
      auditGeneration: 0,
      tasks: Object.fromEntries(
        dag.tasks.map((task) => [
          task.id,
          {
            id: task.id,
            status: task.dependencies.length === 0 ? "ready" : "pending",
            attempt: 0,
            attemptsByModelPolicy: {},
            agentStatus: "none",
            handoffStatus: "none",
            verificationStatus: "not_run",
            gitStatus: "not_started",
          },
        ]),
      ),
      ...(slices.length > 0 ? {
        sliceGates: Object.fromEntries(slices.map((slice) => [slice.id, { id: slice.id, status: "pending" as const, commands: slice.gate }])),
      } : {}),
      updatedAt: now,
    };
    const manifest: RuntimeManifest = {
      ...manifestInput,
      controlRoot: manifestInput.controlRoot ?? manifestInput.repositoryRoot ?? manifestInput.workspaceRoot,
      repositoryRoot: manifestInput.repositoryRoot ?? manifestInput.workspaceRoot,
      assuranceProfile: manifestInput.assuranceProfile ?? "standard",
      taskConformanceRequired: manifestInput.taskConformanceRequired ?? false,
      schemaVersion: 1,
      dagHash: stableHash(dag),
      createdAt: now,
    };
    await this.store.initialize(manifest, dag, state);
  }

  async status(): Promise<IssueRuntimeState> {
    return this.store.readState();
  }

  async doctor() {
    return this.store.doctor();
  }

  async frontier(): Promise<string[]> {
    return calculateFrontier(await this.store.readDag(), await this.store.readState());
  }

  async activeModelPolicy() {
    return this.store.readActiveModelPolicy();
  }

  async locateTaskConformance(bindingId: string): Promise<{ taskId: string; result?: TaskConformanceResult } | undefined> {
    const state = await this.store.readState();
    for (const task of Object.values(state.tasks)) {
      if (task.conformanceJob?.binding?.id === bindingId) return { taskId: task.id, ...(task.conformanceJob.result ? { result: task.conformanceJob.result } : {}) };
      const resultPath = task.receipt?.conformance?.bindingId === bindingId
        ? task.receipt.conformance.resultPath
        : task.correctionContext?.resultPath;
      if (!resultPath) continue;
      const result = await this.store.readTaskConformanceArtifact<TaskConformanceResult>(resultPath);
      if (result?.bindingId === bindingId) return { taskId: task.id, result };
    }
    return undefined;
  }

  async rebindModelPolicy(input: { configGeneration: number; configHash: string; policy: ModelPolicy; reason: string }) {
    return this.store.rebindModelPolicy(input);
  }

  async claimTask(taskId: string, binding: TaskBinding): Promise<IssueRuntimeState> {
    const dag = await this.store.readDag();
    const manifest = await this.store.readManifest();
    const contract = dag.tasks.find((candidate) => candidate.id === taskId);
    if (!contract) throw new Error(`Missing contract for ${taskId}`);
    const contractVersion = contract.version;
    const expectedPath = `tasks/${taskId}/TASK-V${String(contractVersion).padStart(3, "0")}.md`;
    if (binding.workItemId !== manifest.workItemId || binding.issueId !== manifest.issueId || binding.taskId !== taskId || binding.taskVersion !== contractVersion || binding.taskContractPath !== expectedPath || binding.contractHash !== contract.contractHash) {
      throw new Error(`Binding identity or frozen Task contract does not match ${manifest.workItemId}/${manifest.issueId}/${taskId}@V${String(contractVersion).padStart(3, "0")}`);
    }
    const frontier = calculateFrontier(dag, await this.store.readState());
    if (!frontier.includes(taskId)) throw new Error(`${taskId} is not in the current frontier`);
    await this.store.writeBinding(binding.id, binding);
    return this.store.transact("task_claimed", (state) => {
      const task = requireTask(state, taskId);
      task.status = "starting";
      if (!task.attemptsByModelPolicy) {
        const previousGeneration = task.binding?.modelPolicyGeneration ?? 1;
        task.attemptsByModelPolicy = task.attempt > 0 ? { [String(previousGeneration)]: task.attempt } : {};
      }
      const bindingPolicyGeneration = binding.modelPolicyGeneration ?? state.modelPolicyGeneration ?? 1;
      task.attemptsByModelPolicy[String(bindingPolicyGeneration)] = (task.attemptsByModelPolicy[String(bindingPolicyGeneration)] ?? 0) + 1;
      task.attempt += 1;
      task.binding = binding;
      task.agentStatus = "queued";
      task.handoffStatus = "none";
      delete task.handoff;
      task.verificationStatus = "not_run";
      delete task.authoritativeVerification;
      delete task.verificationError;
      delete task.conformanceJob;
      delete task.blocker;
      task.gitStatus = "not_started";
      state.issueStatus = "executing";
    }, { taskId, details: { bindingId: binding.id } });
  }

  async bindAgent(taskId: string, bindingId: string, agentId: string): Promise<IssueRuntimeState> {
    const current = await this.store.readState();
    const currentTask = requireTask(current, taskId);
    if (currentTask.receipt || currentTask.status === "completed" || currentTask.gitStatus === "receipted") return current;
    return this.store.transact("agent_bound", (state) => {
      const task = requireTask(state, taskId);
      if (task.receipt || task.status === "completed" || task.gitStatus === "receipted") return;
      if (!task.binding || task.binding.id !== bindingId) throw new Error(`Binding mismatch for ${taskId}`);
      if (task.binding.agentId && task.binding.agentId !== agentId) throw new Error(`${taskId} is already bound to another agent`);
      task.binding.agentId = agentId;
    }, { taskId, details: { bindingId, agentId } });
  }

  async markAgentStarted(agentId: string): Promise<IssueRuntimeState> {
    const current = await this.store.readState();
    const currentTask = Object.values(current.tasks).find((candidate) => candidate.binding?.agentId === agentId);
    if (!currentTask) throw new Error(`Unknown agent binding: ${agentId}`);
    if (currentTask.receipt || currentTask.status === "completed" || currentTask.gitStatus === "receipted") return current;
    return this.store.transact("agent_started", (state) => {
      const task = Object.values(state.tasks).find((candidate) => candidate.binding?.agentId === agentId);
      if (!task) throw new Error(`Unknown agent binding: ${agentId}`);
      if (task.receipt || task.status === "completed" || task.gitStatus === "receipted") return;
      task.agentStatus = "running";
      task.status = task.handoffStatus === "valid" ? "awaiting_verification" : "running";
    }, { details: { agentId } });
  }

  async resumeTask(bindingId: string): Promise<{ state: IssueRuntimeState; task: IssueRuntimeState["tasks"][string] }> {
    const state = await this.store.readState();
    return { state, task: requireActiveTaskBinding(state, bindingId) };
  }

  async checkpoint(bindingId: string, checkpoint: Omit<TaskCheckpoint, "generation" | "updatedAt">): Promise<IssueRuntimeState> {
    const current = await this.store.readState();
    const task = requireActiveTaskBinding(current, bindingId);
    const nextCheckpoint: TaskCheckpoint = {
      ...checkpoint,
      generation: (task.checkpoint?.generation ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    const state = await this.store.transact("task_checkpointed", (next) => {
      requireActiveTaskBinding(next, bindingId).checkpoint = nextCheckpoint;
    }, { taskId: task.id, details: { bindingId, checkpointGeneration: nextCheckpoint.generation } });
    await this.store.writeCheckpoint(task.id, nextCheckpoint);
    return state;
  }

  async submitHandoff(bindingId: string, handoff: Omit<TaskHandoff, "submittedAt">): Promise<IssueRuntimeState> {
    const current = await this.store.readState();
    const locatedTask = Object.values(current.tasks).find((candidate) => candidate.binding?.id === bindingId);
    if (!locatedTask) throw new Error(`Unknown binding: ${bindingId}`);
    if (locatedTask.receipt || locatedTask.status === "completed" || locatedTask.gitStatus === "receipted") {
      throw new Error(`${locatedTask.id} has an immutable Task Receipt; Binding ${bindingId} is terminal`);
    }
    if (locatedTask.handoffStatus === "valid" && locatedTask.handoff) {
      const existing = {
        changedFiles: locatedTask.handoff.changedFiles,
        verification: locatedTask.handoff.verification,
        produced: locatedTask.handoff.produced,
        blueprintEvidence: locatedTask.handoff.blueprintEvidence ?? [],
      };
      if (stableHash(existing) === stableHash({ ...handoff, blueprintEvidence: handoff.blueprintEvidence ?? [] })) return current;
      throw new Error(`${locatedTask.id} Binding ${bindingId} already submitted a different Handoff`);
    }
    const currentTask = requireActiveTaskBinding(current, bindingId);
    const contract = (await this.store.readDag()).tasks.find((candidate) => candidate.id === currentTask.id);
    if (!contract) throw new Error(`Missing contract for ${currentTask.id}`);
    const unexpectedFiles = handoff.changedFiles.filter((path) => !contract.writes.includes(path));
    if (unexpectedFiles.length > 0) throw new Error(`Handoff contains undeclared Writes: ${unexpectedFiles.join(", ")}`);
    const manifest = await this.store.readManifest();
    if (manifest.taskConformanceRequired && handoff.changedFiles.length === 0) throw new Error(`${currentTask.id} Handoff requires at least one changed Write`);
    const unexpectedProducts = handoff.produced.filter((artifact) => !contract.produces.includes(artifact));
    const missingProducts = contract.produces.filter((artifact) => !handoff.produced.includes(artifact));
    if (unexpectedProducts.length > 0 || missingProducts.length > 0) {
      throw new Error(`Handoff Produces must exactly match the frozen contract; missing: ${missingProducts.join(", ") || "none"}; unexpected: ${unexpectedProducts.join(", ") || "none"}`);
    }
    const blueprintEvidence = manifest.taskConformanceRequired
      ? validateBlueprintEvidence(contract, handoff.blueprintEvidence)
      : handoff.blueprintEvidence ?? [];

    return this.store.transact("task_handoff_received", (state) => {
      const task = requireActiveTaskBinding(state, bindingId);
      task.handoffStatus = "valid";
      task.handoff = { ...handoff, blueprintEvidence, submittedAt: new Date().toISOString() };
      task.status = "awaiting_verification";
    }, { taskId: currentTask.id, details: { bindingId } });
  }

  async markSpawnFailed(taskId: string, error: string): Promise<IssueRuntimeState> {
    return this.store.transact("agent_spawn_failed", (state) => {
      const task = requireTask(state, taskId);
      if (task.status !== "starting") throw new Error(`${taskId} is not starting`);
      task.status = "retry_ready";
      task.agentStatus = "failed";
      task.verificationError = error;
    }, { taskId, details: { error } });
  }

  async markAgentTerminal(agentId: string, status: "completed" | "failed" | "stopped" | "aborted", error?: string): Promise<IssueRuntimeState> {
    const current = await this.store.readState();
    const currentTask = Object.values(current.tasks).find((candidate) => candidate.binding?.agentId === agentId);
    if (!currentTask) throw new Error(`Unknown agent binding: ${agentId}`);
    if (currentTask.receipt || currentTask.status === "completed" || currentTask.gitStatus === "receipted") return current;
    return this.store.transact("agent_terminal", (state) => {
      const task = Object.values(state.tasks).find((candidate) => candidate.binding?.agentId === agentId);
      if (!task) throw new Error(`Unknown agent binding: ${agentId}`);
      if (task.receipt || task.status === "completed" || task.gitStatus === "receipted") return;
      task.agentStatus = status;
      if (task.handoffStatus === "valid") {
        task.status = "awaiting_verification";
      } else {
        task.status = status === "completed" ? "interrupted" : "retry_ready";
        task.verificationError = error ?? "Agent stopped without a valid handoff";
      }
    }, { details: { agentId, status, ...(error ? { error } : {}) } });
  }

  async beginVerification(taskId: string): Promise<IssueRuntimeState> {
    return this.store.transact("verification_started", (state) => {
      const task = requireTask(state, taskId);
      if (task.receipt || task.status === "completed" || task.gitStatus === "receipted") throw new Error(`${taskId} has an immutable Task Receipt`);
      if (!TERMINAL_AGENT_STATUSES.has(task.agentStatus)) throw new Error(`${taskId} agent is not terminal`);
      if (task.handoffStatus !== "valid" || !task.handoff) throw new Error(`${taskId} has no valid handoff`);
      if (task.status !== "awaiting_verification") throw new Error(`${taskId} is not awaiting verification`);
      task.status = "verifying";
      task.verificationStatus = "running";
    }, { taskId });
  }

  async finishVerification(
    taskId: string,
    passed: boolean,
    error?: string,
    verification?: Array<{ command: string; exitCode: number; keyOutput?: string }>,
  ): Promise<IssueRuntimeState> {
    return this.store.transact(passed ? "verification_passed" : "verification_failed", (state) => {
      const task = requireTask(state, taskId);
      if (task.status !== "verifying") throw new Error(`${taskId} is not verifying`);
      task.verificationStatus = passed ? "passed" : "failed";
      if (verification) task.authoritativeVerification = verification;
      if (passed) {
        delete task.verificationError;
      } else {
        task.status = "retry_ready";
        task.verificationError = error ?? "Verification failed";
      }
    }, { taskId, details: { passed, ...(error ? { error } : {}) } });
  }

  async createTaskConformanceJob(
    taskId: string,
    surface: TaskConformanceSurface,
    route: { model: string; thinking: TaskConformanceJob["thinking"]; maxTurns: number; modelPolicyGeneration: number },
  ): Promise<IssueRuntimeState> {
    const manifest = await this.store.readManifest();
    if (!manifest.taskConformanceRequired) throw new Error("Task Conformance is not required for this Runtime");
    const current = await this.store.readState();
    const task = requireTask(current, taskId);
    const contract = (await this.store.readDag()).tasks.find((candidate) => candidate.id === taskId);
    if (!contract || !task.binding || !task.handoff) throw new Error(`${taskId} is missing its frozen contract, Binding, or Handoff`);
    if (task.status !== "verifying" || task.verificationStatus !== "passed") throw new Error(`${taskId} is not ready for Task Conformance`);
    if (surface.workItemId !== manifest.workItemId || surface.issueId !== manifest.issueId || surface.taskId !== taskId || surface.taskVersion !== contract.version || surface.contractHash !== contract.contractHash || surface.workerBindingId !== task.binding.id || surface.baselineCommit !== task.binding.baselineCommit) {
      throw new Error(`${taskId} Task Conformance Surface identity is stale`);
    }
    const generation = (task.conformanceGeneration ?? 0) + 1;
    if (surface.artifactPath !== `audits/tasks/${taskId}/conformance-${generation}-surface.json`) throw new Error(`${taskId} Task Conformance Surface path is stale`);
    await this.store.writeTaskConformanceArtifact(surface.artifactPath, surface);
    return this.store.transact("task_conformance_created", (state) => {
      const mutable = requireTask(state, taskId);
      mutable.conformanceGeneration = generation;
      mutable.conformanceJob = {
        id: `task-conformance-${taskId}-${generation}`,
        generation,
        status: "pending",
        attempt: 0,
        maxAttempts: 2,
        model: route.model,
        thinking: route.thinking,
        maxTurns: route.maxTurns,
        modelPolicyGeneration: route.modelPolicyGeneration,
        surface,
      };
      mutable.status = "awaiting_review";
    }, { taskId, details: { generation, surfaceHash: surface.surfaceHash } });
  }

  async claimTaskConformance(taskId: string, binding: TaskConformanceBinding): Promise<IssueRuntimeState> {
    const current = await this.store.readState();
    const task = requireTask(current, taskId);
    const job = task.conformanceJob;
    if (!job || !["pending", "retry_ready", "interrupted"].includes(job.status)) throw new Error(`${taskId} Task Conformance is not claimable`);
    const manifest = await this.store.readManifest();
    if (binding.workItemId !== manifest.workItemId || binding.issueId !== manifest.issueId || binding.taskId !== taskId || binding.taskVersion !== job.surface.taskVersion || binding.contractHash !== job.surface.contractHash || binding.surfaceHash !== job.surface.surfaceHash) {
      throw new Error(`${taskId} Task Conformance Binding identity is stale`);
    }
    await this.store.writeBinding(binding.id, binding);
    return this.store.transact("task_conformance_claimed", (state) => {
      const mutable = requireTask(state, taskId);
      const mutableJob = mutable.conformanceJob!;
      mutableJob.status = "starting";
      mutableJob.attempt += 1;
      mutableJob.binding = binding;
      delete mutableJob.error;
      mutable.status = "reviewing";
    }, { taskId, details: { bindingId: binding.id, surfaceHash: binding.surfaceHash } });
  }

  async bindTaskConformanceAgent(taskId: string, bindingId: string, agentId: string): Promise<IssueRuntimeState> {
    return this.store.transact("task_conformance_agent_bound", (state) => {
      const task = requireTask(state, taskId);
      const job = task.conformanceJob;
      if (!job?.binding || job.binding.id !== bindingId) throw new Error(`${taskId} Task Conformance Binding mismatch`);
      if (job.binding.agentId && job.binding.agentId !== agentId) throw new Error(`${taskId} Task Conformance is already bound to another Agent`);
      job.binding.agentId = agentId;
    }, { taskId, details: { bindingId, agentId } });
  }

  async markTaskConformanceAgentStarted(agentId: string): Promise<IssueRuntimeState> {
    return this.store.transact("task_conformance_agent_started", (state) => {
      const task = Object.values(state.tasks).find((candidate) => candidate.conformanceJob?.binding?.agentId === agentId);
      if (!task?.conformanceJob) throw new Error(`Unknown Task Conformance Agent: ${agentId}`);
      if (task.conformanceJob.result) return;
      task.conformanceJob.status = "running";
      task.status = "reviewing";
    }, { details: { agentId } });
  }

  async submitTaskConformance(
    bindingId: string,
    surfaceHash: string,
    verdict: TaskConformanceVerdict,
    findings: TaskConformanceFinding[],
  ): Promise<IssueRuntimeState> {
    const current = await this.store.readState();
    const located = await this.locateTaskConformance(bindingId);
    if (located?.result) {
      const existingPayload = { bindingId: located.result.bindingId, surfaceHash: located.result.surfaceHash, verdict: located.result.verdict, findings: located.result.findings };
      const incomingPayload = { bindingId, surfaceHash, verdict, findings };
      if (stableHash(existingPayload) === stableHash(incomingPayload)) return this.store.readState();
      throw new Error(`${located.taskId} Task Conformance Binding already submitted a different Result`);
    }
    const task = located ? current.tasks[located.taskId] : undefined;
    if (!task?.conformanceJob?.binding) throw new Error(`Unknown Task Conformance Binding: ${bindingId}`);
    const job = task.conformanceJob;
    const binding = job.binding!;
    if (job.surface.surfaceHash !== surfaceHash || binding.surfaceHash !== surfaceHash) throw new Error(`${task.id} Task Conformance Surface Hash is stale`);
    if (!["starting", "running"].includes(job.status)) throw new Error(`${task.id} Task Conformance cannot submit from ${job.status}`);
    const blocking = findings.filter((finding) => finding.severity === "blocker");
    if ((verdict === "passed" && blocking.length > 0) || (verdict === "blocked" && blocking.length === 0)) {
      throw new Error(`${task.id} Task Conformance verdict does not match Blocker Findings`);
    }
    const findingIds = new Set<string>();
    const blueprintIds = new Set((await this.store.readDag()).tasks.find((candidate) => candidate.id === task.id)?.implementationBlueprint?.map((step, index) => typeof step === "string" ? `BP-${String(index + 1).padStart(2, "0")}` : step.id) ?? []);
    for (const finding of findings) {
      if (!finding.id.trim() || findingIds.has(finding.id)) throw new Error(`${task.id} Task Conformance Finding IDs must be unique and non-empty`);
      findingIds.add(finding.id);
      if (!finding.message.trim() || !finding.violatedRule.trim() || !finding.verification.trim() || !finding.suggestedResolution.trim() || finding.evidence.length === 0 || finding.blueprintStepIds.length === 0) throw new Error(`${finding.id} Task Conformance Finding is incomplete`);
      const unknownSteps = finding.blueprintStepIds.filter((id) => !blueprintIds.has(id));
      if (unknownSteps.length > 0) throw new Error(`${finding.id} references unknown Blueprint Steps: ${unknownSteps.join(", ")}`);
    }
    const artifactPath = `audits/tasks/${task.id}/conformance-${job.generation}-result.json`;
    const submittedAt = binding.createdAt;
    const resultBase = {
      schemaVersion: 1 as const,
      workItemId: job.surface.workItemId,
      issueId: job.surface.issueId,
      taskId: task.id,
      taskVersion: job.surface.taskVersion,
      contractHash: job.surface.contractHash,
      surfaceHash,
      bindingId,
      verdict,
      findings: structuredClone(findings),
      artifactPath,
      submittedAt,
    };
    const result: TaskConformanceResult = { ...resultBase, resultHash: stableHash(resultBase) };
    await this.store.writeTaskConformanceArtifact(artifactPath, result);
    return this.store.transact("task_conformance_submitted", (state) => {
      const mutable = requireTask(state, task.id);
      const mutableJob = mutable.conformanceJob!;
      mutableJob.result = result;
      mutableJob.status = verdict === "passed" ? "passed" : "blocked";
      if (verdict === "passed") {
        mutable.status = "awaiting_commit";
        delete mutable.blocker;
      } else {
        mutable.status = "blocked";
        mutable.blocker = `${blocking.length} Task Conformance Blocker(s)`;
        mutable.correctionContext = { resultHash: result.resultHash, resultPath: artifactPath, findingIds: blocking.map((finding) => finding.id) };
        state.issueStatus = "blocked";
      }
    }, { taskId: task.id, details: { bindingId, surfaceHash, verdict, findingIds: [...findingIds] } });
  }

  async markTaskConformanceAgentTerminal(agentId: string, terminal: "completed" | "failed" | "stopped" | "aborted", error?: string): Promise<IssueRuntimeState> {
    return this.store.transact("task_conformance_agent_terminal", (state) => {
      const task = Object.values(state.tasks).find((candidate) => candidate.conformanceJob?.binding?.agentId === agentId);
      if (!task?.conformanceJob) throw new Error(`Unknown Task Conformance Agent: ${agentId}`);
      const job = task.conformanceJob;
      if (job.result) return;
      job.error = error ?? `Task Conformance Agent ${terminal} without a Result`;
      if (job.attempt >= job.maxAttempts) {
        job.status = "failed";
        task.status = "blocked";
        task.blocker = job.error;
        state.issueStatus = "blocked";
      } else {
        job.status = terminal === "completed" ? "interrupted" : "retry_ready";
        task.status = "awaiting_review";
      }
    }, { details: { agentId, terminal, ...(error ? { error } : {}) } });
  }

  async markTaskConformanceSpawnFailed(taskId: string, error: string): Promise<IssueRuntimeState> {
    return this.store.transact("task_conformance_spawn_failed", (state) => {
      const task = requireTask(state, taskId);
      const job = task.conformanceJob;
      if (!job || job.status !== "starting") throw new Error(`${taskId} Task Conformance is not starting`);
      job.error = error;
      job.status = job.attempt >= job.maxAttempts ? "failed" : "retry_ready";
      task.status = job.status === "failed" ? "blocked" : "awaiting_review";
      if (job.status === "failed") {
        task.blocker = error;
        state.issueStatus = "blocked";
      }
    }, { taskId, details: { error } });
  }

  async completeTask(taskId: string, commit: string): Promise<IssueRuntimeState> {
    const manifest = await this.store.readManifest();
    const current = await this.store.readState();
    const task = requireTask(current, taskId);
    if (task.receipt || task.status === "completed" || task.gitStatus === "receipted") throw new Error(`${taskId} is already completed`);
    const conformance = task.conformanceJob?.result;
    const eligibleStatus = manifest.taskConformanceRequired ? task.status === "awaiting_commit" : task.status === "verifying";
    if (!eligibleStatus || task.verificationStatus !== "passed" || !task.handoff || !task.binding || (manifest.taskConformanceRequired && conformance?.verdict !== "passed")) {
      throw new Error(`${taskId} is not eligible for completion`);
    }
    const receipt: TaskReceipt = {
      schemaVersion: 1,
      workItemId: task.binding.workItemId,
      issueId: task.binding.issueId,
      taskId,
      taskVersion: task.binding.taskVersion,
      taskContractPath: task.binding.taskContractPath,
      contractHash: task.binding.contractHash,
      dagGeneration: current.dagGeneration,
      commit,
      changedFiles: task.handoff.changedFiles,
      produced: task.handoff.produced,
      ...(task.handoff.blueprintEvidence ? { blueprintEvidence: task.handoff.blueprintEvidence } : {}),
      verification: task.authoritativeVerification ?? task.handoff.verification,
      ...(conformance ? { conformance: { surfaceHash: conformance.surfaceHash, bindingId: conformance.bindingId, resultHash: conformance.resultHash, resultPath: conformance.artifactPath } } : {}),
      ...(task.binding.baselineCommit ? { baselineCommit: task.binding.baselineCommit } : {}),
      completedAt: new Date().toISOString(),
    };
    await this.store.writeReceipt(taskId, receipt);
    const dag = await this.store.readDag();
    return this.store.transact("task_completed", (state) => {
      const mutableTask = requireTask(state, taskId);
      mutableTask.receipt = receipt;
      mutableTask.gitStatus = "receipted";
      mutableTask.status = "completed";
      refreshReadyStates(dag, state);
      if (Object.values(state.tasks).every((candidate) => candidate.status === "completed")) {
        state.issueStatus = "integrating";
      }
    }, { taskId, details: { commit } });
  }

  async reconcileTaskReceipt(taskId: string): Promise<{ state: IssueRuntimeState; reconciled: boolean }> {
    const current = await this.store.readState();
    const task = requireTask(current, taskId);
    const dag = await this.store.readDag();
    const contract = dag.tasks.find((candidate) => candidate.id === taskId);
    if (!contract) throw new Error(`Missing contract for ${taskId}`);
    const receipt = await this.store.readReceipt<TaskReceipt>(taskId, contract.version);
    if (!receipt) throw new Error(`${taskId} has no immutable Task Receipt to reconcile`);
    const manifest = await this.store.readManifest();
    if (!receiptMatchesTask(receipt, task, contract, manifest)) throw new Error(`${taskId} Task Receipt identity does not match the frozen Runtime`);
    if (manifest.taskConformanceRequired) {
      const conformance = receipt.conformance!;
      const result = await this.store.readTaskConformanceArtifact<TaskConformanceResult>(conformance.resultPath);
      if (!result || result.verdict !== "passed" || result.resultHash !== conformance.resultHash || result.surfaceHash !== conformance.surfaceHash || result.bindingId !== conformance.bindingId || result.workItemId !== manifest.workItemId || result.issueId !== manifest.issueId || result.taskId !== taskId || result.taskVersion !== contract.version || result.contractHash !== contract.contractHash) {
        throw new Error(`${taskId} Task Receipt Conformance evidence does not match the frozen Runtime`);
      }
    }
    if (task.status === "completed"
      && task.gitStatus === "receipted"
      && task.verificationStatus === "passed"
      && stableHash(task.receipt) === stableHash(receipt)
      && !task.verificationError
      && !task.blocker) {
      return { state: current, reconciled: false };
    }
    const state = await this.store.transact("task_reconciled_from_receipt", (next) => {
      const mutable = requireTask(next, taskId);
      mutable.receipt = receipt;
      mutable.status = "completed";
      mutable.gitStatus = "receipted";
      mutable.handoffStatus = "valid";
      mutable.handoff = {
        changedFiles: structuredClone(receipt.changedFiles),
        produced: structuredClone(receipt.produced),
        blueprintEvidence: structuredClone(receipt.blueprintEvidence ?? []),
        verification: structuredClone(receipt.verification),
        submittedAt: receipt.completedAt,
      };
      mutable.verificationStatus = "passed";
      mutable.authoritativeVerification = structuredClone(receipt.verification);
      delete mutable.verificationError;
      delete mutable.blocker;
      refreshReadyStates(dag, next);
      next.issueStatus = issueStatusAfterReceiptReconciliation(next);
    }, { taskId, details: { commit: receipt.commit, reason: "Immutable Task Receipt supersedes stale lifecycle state" } });
    return { state, reconciled: true };
  }

  async retryTask(taskId: string, reason: string): Promise<IssueRuntimeState> {
    return this.store.transact("task_retry_scheduled", (state) => {
      const task = requireTask(state, taskId);
      if (task.receipt || task.status === "completed" || task.gitStatus === "receipted") throw new Error(`${taskId} has an immutable Task Receipt`);
      if (!["retry_ready", "interrupted", "blocked"].includes(task.status)) {
        throw new Error(`${taskId} is not retryable from ${task.status}`);
      }
      task.status = "ready";
      task.agentStatus = "none";
      task.handoffStatus = "none";
      delete task.handoff;
      task.verificationStatus = "not_run";
      delete task.authoritativeVerification;
      task.gitStatus = "not_started";
      task.blocker = reason;
      state.issueStatus = "executing";
    }, { taskId, details: { reason } });
  }

  async blockTask(taskId: string, reason: string): Promise<IssueRuntimeState> {
    return this.store.transact("task_blocked", (state) => {
      const task = requireTask(state, taskId);
      if (task.receipt || task.status === "completed" || task.gitStatus === "receipted") throw new Error(`${taskId} has an immutable Task Receipt`);
      task.status = "blocked";
      task.blocker = reason;
      state.issueStatus = "blocked";
    }, { taskId, details: { reason } });
  }

  async startSliceGate(sliceId: string): Promise<IssueRuntimeState> {
    return this.store.transact("slice_gate_started", (state) => {
      const gate = state.sliceGates?.[sliceId];
      if (!gate) throw new Error(`Unknown Slice Gate: ${sliceId}`);
      if (gate.status !== "pending" && gate.status !== "failed") throw new Error(`${sliceId} gate cannot start from ${gate.status}`);
      gate.status = "running";
      delete gate.error;
      delete gate.verification;
      state.issueStatus = "integrating";
    }, { details: { sliceId } });
  }

  async finishSliceGate(
    sliceId: string,
    passed: boolean,
    verification: Array<{ command: string; exitCode: number; keyOutput?: string }>,
    error?: string,
  ): Promise<IssueRuntimeState> {
    return this.store.transact(passed ? "slice_gate_passed" : "slice_gate_failed", (state) => {
      const gate = state.sliceGates?.[sliceId];
      if (!gate || gate.status !== "running") throw new Error(`${sliceId} gate is not running`);
      gate.status = passed ? "passed" : "failed";
      gate.verification = verification;
      if (passed) {
        gate.completedAt = new Date().toISOString();
        delete gate.error;
        if (Object.values(state.sliceGates ?? {}).every((candidate) => candidate.status === "passed")) state.issueStatus = "auditing";
      } else {
        const gateError = error ?? "Slice Gate failed";
        gate.error = gateError;
        const findingHash = stableHash({ sliceId, commands: gate.commands, verification, error: gateError });
        state.remediationPlan = {
          id: `remediation-slice-${sliceId}-${String(state.dagGeneration).padStart(3, "0")}`,
          source: "slice_gate",
          sourceSliceId: sliceId,
          findingHash,
          confirmedFindingIds: [`SLICE-${sliceId}`],
          status: "awaiting_proposal",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        state.issueStatus = "blocked";
      }
    }, { details: { sliceId, passed, ...(error ? { error } : {}) } });
  }

  async createAuditJobs(input: Record<IssueAuditAxis, { model: string; thinking: IssueAuditJob["thinking"]; maxTurns: number; configHash: string }>): Promise<IssueRuntimeState> {
    const manifest = await this.store.readManifest();
    if (manifest.assuranceProfile === "fast") throw new Error("Fast Assurance does not run final Issue Audits");
    const current = await this.store.readState();
    if (current.auditJobs && Object.values(current.auditJobs).some((job) => ["pending", "starting", "running", "retry_ready", "interrupted"].includes(job.status))) return current;
    if (current.issueStatus !== "auditing") throw new Error(`Issue Audit cannot start from ${current.issueStatus}`);
    const axes: IssueAuditAxis[] = ["standards", "acceptance_integration", "architecture_minimality"];
    const jobs = Object.fromEntries(axes.map((axis) => [axis, {
      id: `issue-audit-${(current.auditGeneration ?? 0) + 1}-${axis}`,
      axis,
      status: "pending" as const,
      attempt: 0,
      maxAttempts: 2,
      ...input[axis],
    }])) as Record<IssueAuditAxis, IssueAuditJob>;
    const auditGeneration = (current.auditGeneration ?? 0) + 1;
    await this.store.writeAudit(`issue-audit-plan-${auditGeneration}`, { schemaVersion: 1, issueId: current.issueId, auditGeneration, jobs });
    return this.store.transact("issue_audit_jobs_created", (state) => {
      state.auditGeneration = auditGeneration;
      state.auditJobs = jobs;
      state.audits = {};
      delete state.auditBlockerVerifierJob;
    }, { details: { axes, auditGeneration } });
  }

  async claimAuditJob(axis: IssueAuditAxis, binding: IssueAuditBinding): Promise<IssueRuntimeState> {
    const current = await this.store.readState();
    const job = current.auditJobs?.[axis];
    if (!job || job.axis !== axis) throw new Error(`Unknown Issue Audit Job: ${axis}`);
    if (!["pending", "retry_ready", "interrupted"].includes(job.status)) throw new Error(`${job.id} cannot be claimed from ${job.status}`);
    if (job.attempt >= job.maxAttempts) throw new Error(`${job.id} exhausted its retry budget`);
    if (binding.axis !== axis || binding.attempt !== job.attempt + 1) throw new Error(`Binding does not match ${job.id}`);
    await this.store.writeBinding(binding.id, binding);
    return this.store.transact("issue_audit_claimed", (state) => {
      const mutable = state.auditJobs?.[axis];
      if (!mutable) throw new Error(`Missing Issue Audit Job: ${axis}`);
      mutable.status = "starting";
      mutable.attempt += 1;
      mutable.binding = binding;
      delete mutable.error;
    }, { details: { axis, bindingId: binding.id, attempt: binding.attempt } });
  }

  async bindAuditAgent(axis: IssueAuditAxis, bindingId: string, agentId: string): Promise<IssueRuntimeState> {
    return this.store.transact("issue_audit_agent_bound", (state) => {
      const job = state.auditJobs?.[axis];
      if (!job?.binding || job.binding.id !== bindingId) throw new Error(`Issue Audit Binding mismatch: ${bindingId}`);
      if (job.binding.agentId && job.binding.agentId !== agentId) throw new Error(`${job.id} is already bound to another Agent`);
      job.binding.agentId = agentId;
    }, { details: { axis, bindingId, agentId } });
  }

  async markAuditAgentStarted(agentId: string): Promise<IssueRuntimeState> {
    return this.store.transact("issue_audit_agent_started", (state) => {
      const job = Object.values(state.auditJobs ?? {}).find((candidate) => candidate.binding?.agentId === agentId);
      if (!job) throw new Error(`Unknown Issue Auditor Agent: ${agentId}`);
      if (!job.result) job.status = "running";
    }, { details: { agentId } });
  }

  async markAuditAgentTerminal(agentId: string, terminal: "completed" | "failed" | "stopped" | "aborted", error?: string): Promise<IssueRuntimeState> {
    return this.store.transact("issue_audit_agent_terminal", (state) => {
      const job = Object.values(state.auditJobs ?? {}).find((candidate) => candidate.binding?.agentId === agentId);
      if (!job) throw new Error(`Unknown Issue Auditor Agent: ${agentId}`);
      if (job.result) job.status = "completed";
      else if (terminal === "completed") {
        job.status = "interrupted";
        job.error = error ?? "Auditor stopped without a structured result";
      } else {
        job.status = job.attempt >= job.maxAttempts ? "failed" : "retry_ready";
        job.error = error ?? `Auditor terminated as ${terminal}`;
        if (job.status === "failed") state.issueStatus = "blocked";
      }
    }, { details: { agentId, terminal, ...(error ? { error } : {}) } });
  }

  async markAuditSpawnFailed(axis: IssueAuditAxis, error: string): Promise<IssueRuntimeState> {
    return this.store.transact("issue_audit_spawn_failed", (state) => {
      const job = state.auditJobs?.[axis];
      if (!job || job.status !== "starting") throw new Error(`${axis} Audit is not starting`);
      job.status = job.attempt >= job.maxAttempts ? "failed" : "retry_ready";
      job.error = error;
      if (job.status === "failed") state.issueStatus = "blocked";
    }, { details: { axis, error } });
  }

  async submitAudit(bindingId: string, axis: IssueAuditAxis, verdict: IssueAuditReview["verdict"], findings: IssueAuditFinding[]): Promise<IssueRuntimeState> {
    const current = await this.store.readState();
    const job = current.auditJobs?.[axis];
    if (!job?.binding || job.binding.id !== bindingId) throw new Error(`Unknown Issue Audit Binding: ${bindingId}`);
    if (job.result || ["result_submitted", "completed"].includes(job.status)) throw new Error(`${bindingId} already submitted an Audit`);
    if (!["starting", "running"].includes(job.status)) throw new Error(`${bindingId} cannot submit from ${job.status}`);
    const ids = new Set<string>();
    for (const finding of findings) {
      if (!finding.id.trim() || ids.has(finding.id)) throw new Error(`Invalid or duplicate Issue Audit Finding ID: ${finding.id}`);
      ids.add(finding.id);
      if (!finding.message.trim() || !finding.violatedRule.trim() || !finding.verification.trim()) throw new Error(`${finding.id} is incomplete`);
      if (finding.severity === "blocker" && finding.evidence.length === 0) throw new Error(`${finding.id} Blocker has no evidence`);
    }
    const hasBlocker = findings.some((finding) => finding.severity === "blocker");
    if (verdict === "passed" && hasBlocker) throw new Error(`${axis} Audit cannot pass with a Blocker`);
    if (verdict === "blocked" && !hasBlocker) throw new Error(`${axis} Audit cannot block without a Blocker`);
    const review: IssueAuditReview = { axis, verdict, bindingId, findings, submittedAt: new Date().toISOString() };
    await this.store.writeAudit(`generation-${current.auditGeneration ?? 1}-${axis}-${bindingId}`, review);
    const next = await this.store.transact("issue_audit_submitted", (state) => {
      const mutable = state.auditJobs?.[axis];
      if (!mutable?.binding || mutable.binding.id !== bindingId) throw new Error(`Issue Audit Binding changed: ${bindingId}`);
      mutable.result = review;
      mutable.status = "result_submitted";
      (state.audits ??= {})[axis] = review;
      if (verdict === "blocked") state.issueStatus = "blocked";
    }, { details: { axis, bindingId, verdict } });
    const axes: IssueAuditAxis[] = ["standards", "acceptance_integration", "architecture_minimality"];
    if (axes.every((candidate) => next.audits?.[candidate]?.verdict === "passed")) {
      return this.markIssueCompleted({ schemaVersion: 1, issueId: next.issueId, audits: next.audits, completedAt: new Date().toISOString() });
    }
    return next;
  }

  async createAuditBlockerVerifierJob(input: { model: string; thinking: AuditBlockerVerifierJob["thinking"]; maxTurns: number; configHash: string }): Promise<IssueRuntimeState> {
    const current = await this.store.readState();
    if (current.issueStatus !== "blocked") throw new Error(`Audit Blocker Verification cannot start from ${current.issueStatus}`);
    const findings = Object.entries(current.audits ?? {}).flatMap(([axis, audit]) =>
      (audit?.findings ?? []).filter((finding) => finding.severity === "blocker").map((finding) => ({
        findingId: finding.id,
        axis: axis as IssueAuditAxis,
        auditBindingId: audit!.bindingId,
        finding,
      })),
    );
    if (findings.length === 0) throw new Error("No final Audit Blockers require verification");
    const findingHash = stableHash(findings);
    if (current.auditBlockerVerifierJob?.findingHash === findingHash) return current;
    const job: AuditBlockerVerifierJob = {
      id: `issue-audit-blocker-verifier-${current.auditGeneration ?? 1}`,
      status: "pending",
      attempt: 0,
      maxAttempts: 2,
      findingHash,
      findings,
      ...input,
    };
    await this.store.writeAudit(`blocker-verifier-plan-${current.auditGeneration ?? 1}`, { schemaVersion: 1, auditGeneration: current.auditGeneration ?? 1, job });
    return this.store.transact("issue_audit_blocker_verifier_created", (state) => {
      state.auditBlockerVerifierJob = job;
    }, { details: { findingHash, findings: findings.map((finding) => finding.findingId) } });
  }

  async claimAuditBlockerVerifier(binding: AuditBlockerVerifierBinding): Promise<IssueRuntimeState> {
    const current = await this.store.readState();
    const job = current.auditBlockerVerifierJob;
    if (!job || !["pending", "retry_ready", "interrupted"].includes(job.status)) throw new Error("Audit Blocker Verifier is not claimable");
    if (job.attempt >= job.maxAttempts || binding.attempt !== job.attempt + 1 || binding.findingHash !== job.findingHash) throw new Error("Audit Blocker Verifier Binding is invalid");
    await this.store.writeBinding(binding.id, binding);
    return this.store.transact("issue_audit_blocker_verifier_claimed", (state) => {
      const mutable = state.auditBlockerVerifierJob!;
      mutable.status = "starting";
      mutable.attempt += 1;
      mutable.binding = binding;
      delete mutable.error;
    }, { details: { bindingId: binding.id, attempt: binding.attempt } });
  }

  async bindAuditBlockerVerifier(bindingId: string, agentId: string): Promise<IssueRuntimeState> {
    return this.store.transact("issue_audit_blocker_verifier_bound", (state) => {
      const job = state.auditBlockerVerifierJob;
      if (!job?.binding || job.binding.id !== bindingId) throw new Error("Audit Blocker Verifier Binding mismatch");
      if (job.binding.agentId && job.binding.agentId !== agentId) throw new Error("Audit Blocker Verifier already has another Agent");
      job.binding.agentId = agentId;
    }, { details: { bindingId, agentId } });
  }

  async markAuditBlockerVerifierStarted(agentId: string): Promise<IssueRuntimeState> {
    return this.store.transact("issue_audit_blocker_verifier_started", (state) => {
      const job = state.auditBlockerVerifierJob;
      if (job?.binding?.agentId !== agentId) throw new Error("Unknown Audit Blocker Verifier Agent");
      if (!job.result) job.status = "running";
    }, { details: { agentId } });
  }

  async markAuditBlockerVerifierTerminal(agentId: string, terminal: "completed" | "failed" | "stopped" | "aborted", error?: string): Promise<IssueRuntimeState> {
    return this.store.transact("issue_audit_blocker_verifier_terminal", (state) => {
      const job = state.auditBlockerVerifierJob;
      if (job?.binding?.agentId !== agentId) throw new Error("Unknown Audit Blocker Verifier Agent");
      if (job.result) job.status = "completed";
      else {
        job.status = job.attempt >= job.maxAttempts ? "failed" : terminal === "completed" ? "interrupted" : "retry_ready";
        job.error = error ?? `Verifier terminated as ${terminal} without a structured result`;
      }
    }, { details: { agentId, terminal, ...(error ? { error } : {}) } });
  }

  async markAuditBlockerVerifierSpawnFailed(error: string): Promise<IssueRuntimeState> {
    return this.store.transact("issue_audit_blocker_verifier_spawn_failed", (state) => {
      const job = state.auditBlockerVerifierJob;
      if (!job || job.status !== "starting") throw new Error("Audit Blocker Verifier is not starting");
      job.status = job.attempt >= job.maxAttempts ? "failed" : "retry_ready";
      job.error = error;
    }, { details: { error } });
  }

  async submitAuditBlockerVerification(bindingId: string, results: AuditBlockerVerificationResult[]): Promise<IssueRuntimeState> {
    const current = await this.store.readState();
    const job = current.auditBlockerVerifierJob;
    if (!job?.binding || job.binding.id !== bindingId || !["starting", "running"].includes(job.status)) throw new Error("Unknown or inactive Audit Blocker Verifier Binding");
    const expected = new Set(job.findings.map((finding) => finding.findingId));
    if (results.length !== expected.size || new Set(results.map((result) => result.findingId)).size !== results.length || results.some((result) => !expected.has(result.findingId))) {
      throw new Error("Audit Blocker Verification must cover every current Finding exactly once");
    }
    for (const result of results) {
      if (!result.rationale.trim()) throw new Error(`${result.findingId} verification rationale is empty`);
      if (result.status === "confirmed" && result.evidence.length === 0) throw new Error(`${result.findingId} confirmed without evidence`);
      if (result.status === "needs_more_evidence" && result.missingEvidence.length === 0) throw new Error(`${result.findingId} needs_more_evidence without naming missing evidence`);
    }
    const review = { bindingId, findingHash: job.findingHash, results: structuredClone(results), submittedAt: new Date().toISOString() };
    await this.store.writeAudit(`blocker-verification-${current.auditGeneration ?? 1}-${bindingId}`, review);
    return this.store.transact("issue_audit_blockers_verified", (state) => {
      const mutable = state.auditBlockerVerifierJob!;
      mutable.result = review;
      mutable.status = "result_submitted";
      const confirmed = results.filter((result) => result.status === "confirmed").map((result) => result.findingId);
      const unresolved = results.filter((result) => result.status === "needs_more_evidence");
      if (unresolved.length > 0) {
        state.remediationPlan = {
          id: `remediation-${state.auditGeneration ?? 1}`,
          source: "audit",
          sourceAuditGeneration: state.auditGeneration ?? 1,
          findingHash: mutable.findingHash,
          confirmedFindingIds: confirmed,
          status: "needs_user",
          createdAt: review.submittedAt,
          updatedAt: review.submittedAt,
        };
        const requestBase = {
          schemaVersion: 1 as const,
          id: `HD-${String(state.auditGeneration ?? 1).padStart(3, "0")}-evidence`,
          kind: "missing_evidence" as const,
          status: "open" as const,
          source: "blocker_verifier" as const,
          sourceBindingId: bindingId,
          findingHash: mutable.findingHash,
          runtimeGeneration: state.generation + 1,
          question: "What authoritative evidence should Forge use to decide the unresolved final Audit Blockers?",
          reason: unresolved.map((result) => `${result.findingId}: ${result.rationale}`).join("\n"),
          evidence: unresolved.flatMap((result) => result.missingEvidence),
          options: [
            { id: "provide_evidence", label: "Provide evidence and rerun verification", description: "Supply the requested repository, command, policy, or external evidence.", consequences: ["Blocker Verifier runs again", "No product code changes before verification"], resumeAction: "rerun_verifier" as const },
            { id: "amend_scope", label: "Supersede frozen planning", description: "Create a successor Work Item for changed product scope or approved decisions.", consequences: ["Current Runtime remains blocked and immutable", "A new Work Item restarts PRD discovery with an explicit predecessor link"], resumeAction: "supersede_work_item" as const },
            { id: "abort", label: "Abort this Issue", description: "Stop delivery without applying an unverified repair.", consequences: ["No further Workers are started", "Completed immutable history is preserved"], resumeAction: "abort_issue" as const },
          ],
          recommendedOptionId: "provide_evidence",
          resumeAction: "rerun_verifier" as const,
          createdAt: review.submittedAt,
          updatedAt: review.submittedAt,
        };
        state.humanDecision = { ...requestBase, requestHash: stableHash(requestBase) };
        state.issueStatus = "needs_user";
      } else if (confirmed.length > 0) {
        state.remediationPlan = {
          id: `remediation-${state.auditGeneration ?? 1}`,
          source: "audit",
          sourceAuditGeneration: state.auditGeneration ?? 1,
          findingHash: mutable.findingHash,
          confirmedFindingIds: confirmed,
          status: "awaiting_proposal",
          createdAt: review.submittedAt,
          updatedAt: review.submittedAt,
        };
      } else {
        state.issueStatus = "auditing";
        delete state.humanDecision;
        delete state.auditJobs;
        state.audits = {};
        delete state.auditBlockerVerifierJob;
        delete state.remediationPlan;
      }
    }, { details: { bindingId, statuses: Object.fromEntries(results.map((result) => [result.findingId, result.status])) } });
  }

  async requestHumanDecision(input: {
    kind: HumanDecisionRequest["kind"];
    source: HumanDecisionRequest["source"];
    sourceBindingId?: string;
    question: string;
    reason: string;
    evidence: string[];
    options: HumanDecisionRequest["options"];
    recommendedOptionId?: string;
    resumeAction: HumanDecisionRequest["resumeAction"];
  }): Promise<IssueRuntimeState> {
    const current = await this.store.readState();
    const findingHash = current.remediationPlan?.findingHash ?? current.auditBlockerVerifierJob?.findingHash;
    if (!findingHash) throw new Error("Human Decision requires an active Audit Finding surface");
    if (input.source !== "coordinator" && !input.sourceBindingId) throw new Error(`${input.source} Human Decision requires a source Binding`);
    if (input.source === "blocker_verifier" && current.auditBlockerVerifierJob?.binding?.id !== input.sourceBindingId) throw new Error("Human Decision source is not the active Blocker Verifier Binding");
    if (input.source === "remediation_planner" && current.remediationPlan?.plannerJob?.binding?.id !== input.sourceBindingId) throw new Error("Human Decision source is not the active Remediation Planner Binding");
    if (input.source === "remediation_preflight") {
      const bindingPath = input.sourceBindingId ? join(this.store.root, "bindings", `${input.sourceBindingId}.json`) : "";
      if (!bindingPath) throw new Error("Human Decision source is not a Remediation Preflight Binding");
    }
    if (current.humanDecision?.status === "open") throw new Error(`Human Decision ${current.humanDecision.id} is already open`);
    if (!input.question.trim() || !input.reason.trim() || input.evidence.length === 0 || input.options.length < 2) throw new Error("Human Decision Request is incomplete");
    const optionIds = new Set(input.options.map((option) => option.id));
    if (optionIds.size !== input.options.length || input.options.some((option) => !option.id.trim() || !option.label.trim() || !option.description.trim())) throw new Error("Human Decision options are invalid");
    if (input.recommendedOptionId && !optionIds.has(input.recommendedOptionId)) throw new Error("Recommended Human Decision option is unknown");
    if (input.options.every((option) => option.resumeAction !== input.resumeAction)) throw new Error("Default Human Decision resumeAction is not represented by any option");
    const now = new Date().toISOString();
    const requestBase = {
      schemaVersion: 1 as const,
      id: `HD-${String(current.eventSequence + 1).padStart(4, "0")}`,
      kind: input.kind,
      status: "open" as const,
      source: input.source,
      ...(input.sourceBindingId ? { sourceBindingId: input.sourceBindingId } : {}),
      findingHash,
      runtimeGeneration: current.generation + 1,
      question: input.question,
      reason: input.reason,
      evidence: structuredClone(input.evidence),
      options: structuredClone(input.options),
      ...(input.recommendedOptionId ? { recommendedOptionId: input.recommendedOptionId } : {}),
      resumeAction: input.resumeAction,
      createdAt: now,
      updatedAt: now,
    };
    const request: HumanDecisionRequest = { ...requestBase, requestHash: stableHash(requestBase) };
    await atomicWriteJson(join(this.store.root, "human-decisions", `${request.id}.json`), request);
    return this.store.transact("human_decision_requested", (state) => {
      state.humanDecision = request;
      state.issueStatus = "needs_user";
      if (state.remediationPlan) {
        state.remediationPlan.status = "needs_user";
        state.remediationPlan.updatedAt = now;
      }
    }, { details: { requestId: request.id, kind: request.kind, resumeAction: request.resumeAction } });
  }

  async answerHumanDecision(input: {
    requestId: string;
    requestHash: string;
    selectedOptionId?: string;
    decision: string;
    rationale: string;
    evidence: string[];
    answeredBy: string;
    authorizationEvidence: string;
  }): Promise<IssueRuntimeState> {
    const current = await this.store.readState();
    const request = current.humanDecision;
    if (!request || request.status !== "open" || request.id !== input.requestId || request.requestHash !== input.requestHash) throw new Error("Human Decision Request is stale or already answered");
    if (input.selectedOptionId && !request.options.some((option) => option.id === input.selectedOptionId)) throw new Error("Selected Human Decision option is unknown");
    if (!input.decision.trim() || !input.rationale.trim() || !input.answeredBy.trim() || !input.authorizationEvidence.trim()) throw new Error("Human Decision Answer is incomplete");
    if (request.kind === "missing_evidence" && input.selectedOptionId === "provide_evidence" && input.evidence.length === 0) throw new Error("Missing-evidence Decision must include the supplied evidence");
    const answer: HumanDecisionAnswer = {
      ...(input.selectedOptionId ? { selectedOptionId: input.selectedOptionId } : {}),
      decision: input.decision,
      rationale: input.rationale,
      evidence: structuredClone(input.evidence),
      answeredBy: input.answeredBy,
      authorizationEvidence: input.authorizationEvidence,
      answeredAt: new Date().toISOString(),
    };
    const answered: HumanDecisionRequest = { ...request, status: "answered", answer, updatedAt: answer.answeredAt };
    await atomicWriteJson(join(this.store.root, "human-decisions", `${request.id}-answered.json`), answered);
    return this.store.transact("human_decision_answered", (state) => {
      const mutable = state.humanDecision;
      if (!mutable || mutable.id !== request.id || mutable.requestHash !== request.requestHash) throw new Error("Human Decision changed while answering");
      mutable.status = "answered";
      mutable.answer = answer;
      mutable.updatedAt = answer.answeredAt;
    }, { details: { requestId: request.id, selectedOptionId: input.selectedOptionId ?? null, answeredBy: input.answeredBy } });
  }

  async resumeHumanDecision(requestId: string): Promise<{ state: IssueRuntimeState; action: HumanDecisionRequest["resumeAction"] }> {
    const current = await this.store.readState();
    const request = current.humanDecision;
    if (!request || request.id !== requestId || request.status !== "answered" || !request.answer) throw new Error("Human Decision is not answered");
    const selectedOption = request.answer.selectedOptionId ? request.options.find((option) => option.id === request.answer!.selectedOptionId) : undefined;
    const resumeAction = selectedOption?.resumeAction ?? request.resumeAction;
    return {
      action: resumeAction,
      state: await this.store.transact("human_decision_resumed", (state) => {
        const mutable = state.humanDecision!;
        const selected = mutable.answer?.selectedOptionId;
        if (selected === "abort" || resumeAction === "abort_issue") {
          state.issueStatus = "failed";
          if (state.remediationPlan) state.remediationPlan.status = "needs_user";
          return;
        }
        if (resumeAction === "supersede_work_item") {
          state.issueStatus = "needs_user";
          return;
        }
        state.issueStatus = "blocked";
        if (state.remediationPlan) {
          state.remediationPlan.status = resumeAction === "resume_planner" ? "awaiting_proposal" : "needs_user";
          state.remediationPlan.updatedAt = new Date().toISOString();
        }
        if (resumeAction === "rerun_verifier") delete state.auditBlockerVerifierJob;
      }, { details: { requestId, resumeAction, selectedOptionId: request.answer.selectedOptionId ?? null } }),
    };
  }

  async createRemediationPlannerJob(input: { model: string; thinking: RemediationPlannerJob["thinking"]; maxTurns: number; configHash: string }): Promise<IssueRuntimeState> {
    return this.store.transact("remediation_planner_created", (state) => {
      const plan = state.remediationPlan;
      if (!plan || plan.status !== "awaiting_proposal") throw new Error("Runtime is not awaiting a Remediation Proposal");
      if (plan.plannerJob) return;
      plan.plannerJob = { status: "pending", attempt: 0, maxAttempts: 2, ...input };
      plan.updatedAt = new Date().toISOString();
    }, { details: { role: "remediationPlanner" } });
  }

  async claimRemediationPlanner(binding: RemediationPlannerBinding): Promise<IssueRuntimeState> {
    const current = await this.store.readState();
    const plan = current.remediationPlan;
    const job = plan?.plannerJob;
    if (!plan || !job || !["pending", "retry_ready", "interrupted"].includes(job.status)) throw new Error("Remediation Planner is not claimable");
    if (binding.findingHash !== plan.findingHash || binding.attempt !== job.attempt + 1 || job.attempt >= job.maxAttempts) throw new Error("Remediation Planner Binding is invalid");
    await this.store.writeBinding(binding.id, binding);
    return this.store.transact("remediation_planner_claimed", (state) => {
      const mutable = state.remediationPlan!.plannerJob!;
      mutable.status = "starting";
      mutable.attempt += 1;
      mutable.binding = binding;
      delete mutable.error;
    }, { details: { bindingId: binding.id, attempt: binding.attempt } });
  }

  async bindRemediationPlanner(bindingId: string, agentId: string): Promise<IssueRuntimeState> {
    return this.store.transact("remediation_planner_bound", (state) => {
      const job = state.remediationPlan?.plannerJob;
      if (!job?.binding || job.binding.id !== bindingId) throw new Error("Remediation Planner Binding mismatch");
      if (job.binding.agentId && job.binding.agentId !== agentId) throw new Error("Remediation Planner already has another Agent");
      job.binding.agentId = agentId;
    }, { details: { bindingId, agentId } });
  }

  async markRemediationPlannerStarted(agentId: string): Promise<IssueRuntimeState> {
    return this.store.transact("remediation_planner_started", (state) => {
      const job = state.remediationPlan?.plannerJob;
      if (job?.binding?.agentId !== agentId) throw new Error("Unknown Remediation Planner Agent");
      job.status = "running";
    }, { details: { agentId } });
  }

  async markRemediationPlannerSpawnFailed(bindingId: string, error: string): Promise<IssueRuntimeState> {
    return this.store.transact("remediation_planner_spawn_failed", (state) => {
      const job = state.remediationPlan?.plannerJob;
      if (!job?.binding || job.binding.id !== bindingId || job.status !== "starting") throw new Error("Remediation Planner Binding is not starting");
      job.status = job.attempt >= job.maxAttempts ? "failed" : "retry_ready";
      job.error = error;
    }, { details: { bindingId, error } });
  }

  async markRemediationPlannerTerminal(agentId: string, terminal: "completed" | "failed" | "stopped" | "aborted", error?: string): Promise<IssueRuntimeState> {
    return this.store.transact("remediation_planner_terminal", (state) => {
      const job = state.remediationPlan?.plannerJob;
      if (job?.binding?.agentId !== agentId) throw new Error("Unknown Remediation Planner Agent");
      if (job.status === "proposal_submitted") job.status = "completed";
      else {
        job.status = job.attempt >= job.maxAttempts ? "failed" : terminal === "completed" ? "interrupted" : "retry_ready";
        job.error = error ?? `Planner terminated as ${terminal} without a Proposal`;
      }
    }, { details: { agentId, terminal, ...(error ? { error } : {}) } });
  }

  async markRemediationPlannerProposalSubmitted(bindingId: string): Promise<IssueRuntimeState> {
    return this.store.transact("remediation_planner_proposal_submitted", (state) => {
      const job = state.remediationPlan?.plannerJob;
      if (!job?.binding || job.binding.id !== bindingId || !["starting", "running"].includes(job.status)) throw new Error("Inactive Remediation Planner Binding");
      job.status = "proposal_submitted";
    }, { details: { bindingId } });
  }

  async completeFastIssue(): Promise<IssueRuntimeState> {
    const manifest = await this.store.readManifest();
    if (manifest.assuranceProfile !== "fast") throw new Error("Mechanical Issue completion requires Fast Assurance");
    const current = await this.store.readState();
    if (current.issueStatus === "completed") return current;
    if (!["integrating", "auditing"].includes(current.issueStatus)) {
      throw new Error(`Fast Assurance cannot complete from ${current.issueStatus}`);
    }
    const tasks = Object.values(current.tasks).sort((left, right) => left.id.localeCompare(right.id));
    if (tasks.some((task) => task.status !== "completed" || task.gitStatus !== "receipted" || task.verificationStatus !== "passed" || !task.receipt || task.verificationError || task.blocker)) {
      throw new Error("Fast Assurance completion requires verified immutable Task Receipts");
    }
    const sliceGates = Object.values(current.sliceGates ?? {}).sort((left, right) => left.id.localeCompare(right.id));
    if (sliceGates.length === 0 || sliceGates.some((gate) => gate.status !== "passed")) {
      throw new Error("Fast Assurance completion requires every Slice Gate to pass");
    }
    const activeRemediation = current.remediationPlan && current.remediationPlan.status !== "applied";
    if (current.auditJobs || Object.keys(current.audits ?? {}).length > 0 || current.auditBlockerVerifierJob || activeRemediation || current.humanDecision?.status === "open") {
      throw new Error("Fast Assurance completion cannot bypass active Audit or Remediation state");
    }
    return this.markIssueCompleted({
      schemaVersion: 1,
      issueId: current.issueId,
      assuranceProfile: "fast",
      completionMode: "mechanical",
      taskReceipts: tasks.map((task) => ({ taskId: task.id, commit: task.receipt!.commit, contractHash: task.receipt!.contractHash })),
      sliceGates: sliceGates.map((gate) => ({ sliceId: gate.id, verification: gate.verification ?? [] })),
      completedAt: new Date().toISOString(),
    });
  }

  async markIssueCompleted(auditReceipt: Record<string, unknown>): Promise<IssueRuntimeState> {
    await this.store.writeAudit("issue-final", auditReceipt);
    return this.store.transact("issue_completed", (state) => {
      if (Object.values(state.tasks).some((task) => task.status !== "completed")) throw new Error("Issue has incomplete Tasks");
      if (Object.values(state.sliceGates ?? {}).some((gate) => gate.status !== "passed")) throw new Error("Issue has incomplete Slice Gates");
      state.issueStatus = "completed";
    }, { details: { auditHash: stableHash(auditReceipt) } });
  }

  async applyRemediation(amendment: DagAmendment): Promise<IssueRuntimeState> {
    return this.store.withLock(async () => {
      const dag = await this.store.readDag();
      const state = await this.store.readState();
      if (!state.remediationPlan || state.remediationPlan.status !== "ready") throw new Error("Remediation Plan is not ready for DAG Amendment");
      const duplicate = amendment.tasks.find((task) => dag.tasks.some((existing) => existing.id === task.id));
      if (duplicate) throw new Error(`Remediation task already exists: ${duplicate.id}`);
      if (amendment.tasks.some((task) => task.version !== 1)) throw new Error("A new Remediation Task must begin at Version 1");
      const nextDag: TaskDag = { generation: dag.generation + 1, tasks: [...dag.tasks, ...amendment.tasks] };
      validateDag(nextDag);
      await this.store.writeDagGeneration(nextDag, amendment);

      const next = structuredClone(state);
      next.dagGeneration = nextDag.generation;
      for (const task of amendment.tasks) {
        next.tasks[task.id] = {
          id: task.id,
          status: task.dependencies.every((dependency) => next.tasks[dependency]?.status === "completed") ? "ready" : "pending",
          attempt: 0,
          attemptsByModelPolicy: {},
          agentStatus: "none",
          handoffStatus: "none",
          verificationStatus: "not_run",
          gitStatus: "not_started",
        };
      }
      for (const sliceId of amendment.rerunSliceIds) {
        const gate = next.sliceGates?.[sliceId];
        if (!gate) throw new Error(`Remediation references unknown Slice Gate: ${sliceId}`);
        gate.status = "pending";
        delete gate.verification;
        delete gate.error;
        delete gate.completedAt;
      }
      delete next.auditJobs;
      next.audits = {};
      delete next.auditBlockerVerifierJob;
      next.remediationPlan = {
        ...next.remediationPlan!,
        status: "applied",
        taskIds: amendment.tasks.map((task) => task.id),
        dagGeneration: nextDag.generation,
        updatedAt: new Date().toISOString(),
      };
      next.issueStatus = "executing";
      next.generation += 1;
      next.eventSequence += 1;
      next.updatedAt = new Date().toISOString();

      const event = {
        id: randomUUID(),
        sequence: next.eventSequence,
        type: "dag_amended",
        timestamp: next.updatedAt,
        issueId: next.issueId,
        details: { amendmentId: amendment.id, reason: amendment.reason, taskIds: amendment.tasks.map((task) => task.id), rerunSliceIds: amendment.rerunSliceIds },
        snapshot: next,
      };
      await appendJsonLine(this.store.eventsPath, event);
      await atomicWriteJson(this.store.statePath, next);
      return next;
    });
  }

  static createBinding(input: Omit<TaskBinding, "id" | "spawnRequestId">): TaskBinding {
    return { ...input, id: randomUUID(), spawnRequestId: randomUUID() };
  }

  static createTaskConformanceBinding(input: Omit<TaskConformanceBinding, "id" | "spawnRequestId" | "createdAt">): TaskConformanceBinding {
    return { ...input, id: randomUUID(), spawnRequestId: randomUUID(), createdAt: new Date().toISOString() };
  }

  static createAuditBinding(input: Omit<IssueAuditBinding, "id" | "spawnRequestId" | "createdAt">): IssueAuditBinding {
    return { ...input, id: randomUUID(), spawnRequestId: randomUUID(), createdAt: new Date().toISOString() };
  }

  static createAuditBlockerVerifierBinding(input: Omit<AuditBlockerVerifierBinding, "id" | "spawnRequestId" | "createdAt">): AuditBlockerVerifierBinding {
    return { ...input, id: randomUUID(), spawnRequestId: randomUUID(), createdAt: new Date().toISOString() };
  }

  static createRemediationPlannerBinding(input: Omit<RemediationPlannerBinding, "id" | "spawnRequestId" | "createdAt">): RemediationPlannerBinding {
    return { ...input, id: randomUUID(), spawnRequestId: randomUUID(), createdAt: new Date().toISOString() };
  }

  static contractHash(contract: Omit<TaskContract, "contractHash">): string {
    return stableHash(contract);
  }

  runtimePath(...parts: string[]): string {
    return join(this.store.root, ...parts);
  }
}
