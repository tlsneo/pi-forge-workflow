import { constants } from "node:fs";
import { access, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { stableHash } from "../runtime/hash.js";
import { appendJsonLine, atomicWriteJson } from "../runtime/store.js";
import { classifySubagentFailure, recordSubagentFailure, subagentFailureEvent } from "../subagents/failures.js";
import type {
  TaskPreflightBinding,
  TaskPreflightEvent,
  TaskPreflightFinding,
  TaskPreflightProposal,
  TaskPreflightReceipt,
  TaskPreflightResult,
  TaskPreflightRoute,
  TaskPreflightState,
  TaskPreflightVerdict,
} from "./preflight-types.js";
import type { PreparedTaskPlan } from "./types.js";

const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 30_000;
const POLICY_VERSION = 1;

function proposalSurfaceHash(proposal: TaskPreflightProposal): string {
  if (proposal.kind === "remediation") {
    return stableHash({
      policyVersion: POLICY_VERSION,
      kind: "remediation",
      sourceFindingHash: proposal.sourceFindingHash,
      sourcePrdHash: proposal.sourcePrdHash,
      sourceIssueHash: proposal.sourceIssueHash,
      acceptanceIds: proposal.acceptanceIds,
      decisionIds: proposal.decisionIds,
      tasks: proposal.tasks,
      rerunSliceIds: proposal.rerunSliceIds,
    });
  }
  return stableHash({ policyVersion: POLICY_VERSION, issueHash: proposal.source.issueHash, slices: proposal.slices, tasks: proposal.tasks });
}

async function exists(path: string): Promise<boolean> {
  try { await access(path, constants.F_OK); return true; } catch { return false; }
}

function validateFindings(verdict: TaskPreflightVerdict, findings: TaskPreflightFinding[], taskIds: Set<string>): void {
  const ids = new Set<string>();
  for (const finding of findings) {
    if (!finding.id.trim()) throw new Error("Task Preflight Finding ID must not be empty");
    if (ids.has(finding.id)) throw new Error(`Duplicate Task Preflight Finding ID: ${finding.id}`);
    ids.add(finding.id);
    if (!taskIds.has(finding.taskId)) throw new Error(`Task Preflight Finding references unknown Task: ${finding.taskId}`);
    for (const [label, value] of Object.entries({ message: finding.message, violatedRule: finding.violatedRule, verification: finding.verification, suggestedResolution: finding.suggestedResolution })) {
      if (!value.trim()) throw new Error(`Task Preflight Finding ${finding.id} ${label} must not be empty`);
    }
    if (finding.evidence.length === 0 || finding.evidence.some((item) => !item.trim())) throw new Error(`Task Preflight Finding ${finding.id} requires concrete evidence`);
  }
  const blockers = findings.filter((finding) => finding.severity === "blocker");
  if (verdict === "passed" && blockers.length > 0) throw new Error("A passed Task Preflight cannot contain Blockers");
  if (verdict === "blocked" && blockers.length === 0) throw new Error("A blocked Task Preflight requires at least one Blocker");
}

export class TaskPreflightService {
  readonly workItemRoot: string;
  readonly issueId: string;
  readonly root: string;
  readonly statePath: string;
  readonly eventsPath: string;
  readonly lockPath: string;

  constructor(workItemRoot: string, issueId: string, scope: "initial" | "remediation" = "initial") {
    this.workItemRoot = workItemRoot;
    this.issueId = issueId;
    this.root = scope === "initial"
      ? join(workItemRoot, "issues", issueId, "task-preflight")
      : join(workItemRoot, "issues", issueId, "remediation-preflight");
    this.statePath = join(this.root, "state.json");
    this.eventsPath = join(this.root, "events.jsonl");
    this.lockPath = join(this.root, ".lock");
  }

  async status(): Promise<TaskPreflightState | undefined> {
    if (!(await exists(this.statePath))) return undefined;
    return JSON.parse(await readFile(this.statePath, "utf8")) as TaskPreflightState;
  }

  async readProposal(generation?: number): Promise<TaskPreflightProposal> {
    const state = await this.requireState();
    const selected = generation ?? state.activeProposalGeneration;
    const proposal = JSON.parse(await readFile(join(this.root, "proposals", `proposal-${selected}.json`), "utf8")) as TaskPreflightProposal;
    if (proposal.issueId !== this.issueId || proposal.generation !== selected || proposal.proposalHash !== state.proposalHash || proposal.surfaceHash !== state.surfaceHash || proposalSurfaceHash(proposal) !== proposal.surfaceHash) {
      throw new Error("Task Preflight Proposal artifact does not match its Runtime identity or Surface Hash");
    }
    return proposal;
  }

  async proposeRaw(proposal: TaskPreflightProposal, route: TaskPreflightRoute): Promise<{ state: TaskPreflightState; proposal: TaskPreflightProposal; idempotent: boolean }> {
    return this.withLock(async () => {
      const current = await this.status();
      if (current?.proposalHash === proposal.proposalHash) return { state: current, proposal: await this.readProposal(current.activeProposalGeneration), idempotent: true };
      const appliedPass = current?.status === "passed" && current.appliedDagGeneration !== undefined;
      if (current && !appliedPass && ["pending", "starting", "running", "retry_ready", "interrupted", "passed"].includes(current.status)) throw new Error(`Task Preflight Proposal ${current.activeProposalGeneration} is ${current.status}; it cannot be replaced`);
      if (appliedPass && proposal.generation !== current.activeProposalGeneration + 1) throw new Error(`Next Remediation Preflight Proposal must be Generation ${current.activeProposalGeneration + 1}`);
      const now = proposal.createdAt;
      const next: TaskPreflightState = {
        schemaVersion: 1,
        issueId: this.issueId,
        generation: (current?.generation ?? 0) + 1,
        eventSequence: (current?.eventSequence ?? 0) + 1,
        activeProposalGeneration: proposal.generation,
        proposalHash: proposal.proposalHash,
        surfaceHash: proposal.surfaceHash,
        status: "pending",
        job: {
          id: `task-preflight-${proposal.generation}`,
          status: "pending",
          attempt: 0,
          maxAttempts: 2,
          profile: route.profile,
          model: route.model,
          thinking: route.thinking,
          maxTurns: route.maxTurns,
          configGeneration: route.configGeneration,
          configHash: route.configHash,
        },
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      };
      await mkdir(join(this.root, "proposals"), { recursive: true });
      await atomicWriteJson(join(this.root, "proposals", `proposal-${proposal.generation}.json`), proposal);
      await this.persist("task_preflight_proposed", next, { proposalHash: proposal.proposalHash, surfaceHash: proposal.surfaceHash, kind: proposal.kind ?? "initial" });
      return { state: next, proposal, idempotent: false };
    });
  }

  async propose(prepared: PreparedTaskPlan, route: TaskPreflightRoute): Promise<{ state: TaskPreflightState; proposal: TaskPreflightProposal; idempotent: boolean }> {
    if (prepared.issue.id !== this.issueId) throw new Error(`Prepared Task Plan belongs to ${prepared.issue.id}, not ${this.issueId}`);
    return this.withLock(async () => {
      const current = await this.status();
      if (current?.proposalHash === prepared.proposalHash) {
        return { state: current, proposal: await this.readProposal(current.activeProposalGeneration), idempotent: true };
      }
      if (current && ["pending", "starting", "running", "retry_ready", "interrupted", "passed"].includes(current.status)) {
        throw new Error(`Task Preflight Proposal ${current.activeProposalGeneration} is ${current.status}; it cannot be replaced`);
      }
      const now = new Date().toISOString();
      const generation = (current?.activeProposalGeneration ?? 0) + 1;
      const surfaceHash = stableHash({
        policyVersion: POLICY_VERSION,
        issueHash: prepared.issue.artifactHash,
        slices: prepared.slices,
        tasks: prepared.drafts,
      });
      const proposal: TaskPreflightProposal = {
        schemaVersion: 1,
        kind: "initial",
        generation,
        issueId: this.issueId,
        proposalHash: prepared.proposalHash,
        surfaceHash,
        source: {
          workItemId: prepared.semanticSource.workItemId,
          controlRoot: prepared.controlRoot,
          prdHash: prepared.semanticSource.prdHash,
          issuesHash: prepared.semanticSource.issuesHash,
          issueHash: prepared.semanticSource.issueHash,
          repositoryRoot: prepared.repositoryRoot,
          repositoryRevision: prepared.repositoryRevision,
        },
        slices: structuredClone(prepared.slices),
        tasks: structuredClone(prepared.drafts),
        createdAt: now,
      };
      const next: TaskPreflightState = {
        schemaVersion: 1,
        issueId: this.issueId,
        generation: (current?.generation ?? 0) + 1,
        eventSequence: (current?.eventSequence ?? 0) + 1,
        activeProposalGeneration: generation,
        proposalHash: proposal.proposalHash,
        surfaceHash,
        status: "pending",
        job: {
          id: `task-preflight-${generation}`,
          status: "pending",
          attempt: 0,
          maxAttempts: 2,
          profile: route.profile,
          model: route.model,
          thinking: route.thinking,
          maxTurns: route.maxTurns,
          configGeneration: route.configGeneration,
          configHash: route.configHash,
        },
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      };
      await mkdir(join(this.root, "proposals"), { recursive: true });
      await atomicWriteJson(join(this.root, "proposals", `proposal-${generation}.json`), proposal);
      await this.persist("task_preflight_proposed", next, { proposalHash: proposal.proposalHash, surfaceHash });
      return { state: next, proposal, idempotent: false };
    });
  }

  async claim(binding: TaskPreflightBinding): Promise<TaskPreflightState> {
    return this.transact("task_preflight_claimed", (state) => {
      if (!["pending", "retry_ready", "interrupted"].includes(state.status)) throw new Error(`Task Preflight is ${state.status}`);
      if (binding.proposalGeneration !== state.activeProposalGeneration || binding.proposalHash !== state.proposalHash || binding.surfaceHash !== state.surfaceHash) {
        throw new Error("Task Preflight Binding does not match the active Proposal surface");
      }
      if (binding.attempt !== state.job.attempt + 1) throw new Error(`Task Preflight attempt must be ${state.job.attempt + 1}`);
      state.status = "starting";
      state.job.status = "starting";
      state.job.attempt = binding.attempt;
      state.job.binding = binding;
      delete state.job.lastError;
    }, { bindingId: binding.id, attempt: binding.attempt });
  }

  async bindAgent(bindingId: string, agentId: string): Promise<TaskPreflightState> {
    return this.transact("task_preflight_agent_bound", (state) => {
      if (state.job.binding?.id !== bindingId) throw new Error("Task Preflight Binding is stale");
      if (state.job.status === "infrastructure_failed") return;
      if (state.job.binding.agentId && state.job.binding.agentId !== agentId) throw new Error("Task Preflight Binding already has another Agent");
      state.job.binding.agentId = agentId;
    }, { bindingId, agentId });
  }

  async markStarted(agentId: string): Promise<TaskPreflightState> {
    return this.transact("task_preflight_agent_started", (state) => {
      if (state.job.binding?.agentId !== agentId) throw new Error("Unknown Task Preflight Agent");
      if (state.job.status === "infrastructure_failed" || state.job.result) return;
      state.status = "running";
      state.job.status = "running";
    }, { agentId });
  }

  async submitResult(input: { bindingId: string; proposalHash: string; verdict: TaskPreflightVerdict; findings: TaskPreflightFinding[] }): Promise<{ state: TaskPreflightState; result: TaskPreflightResult; receipt?: TaskPreflightReceipt; idempotent: boolean }> {
    return this.withLock(async () => {
      const current = await this.requireState();
      const binding = current.job.binding;
      if (!binding || binding.id !== input.bindingId) throw new Error("Task Preflight Result Binding is stale or unknown");
      if (input.proposalHash !== current.proposalHash || binding.proposalHash !== current.proposalHash || binding.surfaceHash !== current.surfaceHash) {
        throw new Error("Task Preflight Result does not match the active Proposal surface");
      }
      const proposal = await this.readProposal(current.activeProposalGeneration);
      validateFindings(input.verdict, input.findings, new Set(proposal.tasks.map((task) => task.id)));
      if (current.job.result) {
        if (current.job.result.verdict !== input.verdict || stableHash(current.job.result.findings) !== stableHash(input.findings)) {
          throw new Error("Task Preflight Binding already submitted a different Result");
        }
        const receipt = input.verdict === "passed" ? await this.readReceipt(current.activeProposalGeneration) : undefined;
        return { state: current, result: current.job.result, ...(receipt ? { receipt } : {}), idempotent: true };
      }
      const submittedAt = new Date().toISOString();
      const resultBase = {
        schemaVersion: 1 as const,
        proposalGeneration: current.activeProposalGeneration,
        proposalHash: current.proposalHash,
        surfaceHash: current.surfaceHash,
        bindingId: binding.id,
        verdict: input.verdict,
        findings: structuredClone(input.findings),
        submittedAt,
      };
      const result: TaskPreflightResult = { ...resultBase, resultHash: stableHash(resultBase) };
      const next = structuredClone(current);
      next.status = input.verdict;
      next.job.status = input.verdict;
      next.job.result = result;
      next.generation += 1;
      next.eventSequence += 1;
      next.updatedAt = submittedAt;
      await atomicWriteJson(join(this.root, "results", `proposal-${next.activeProposalGeneration}.json`), result);
      let receipt: TaskPreflightReceipt | undefined;
      if (input.verdict === "passed") {
        receipt = {
          schemaVersion: 1,
          issueId: this.issueId,
          proposalGeneration: next.activeProposalGeneration,
          proposalHash: next.proposalHash,
          surfaceHash: next.surfaceHash,
          bindingId: binding.id,
          resultHash: result.resultHash,
          verdict: "passed",
          approvedAt: submittedAt,
        };
        await atomicWriteJson(join(this.root, "receipts", `proposal-${next.activeProposalGeneration}.json`), receipt);
      }
      await this.persist("task_preflight_result_submitted", next, { bindingId: binding.id, verdict: input.verdict, resultHash: result.resultHash });
      return { state: next, result, ...(receipt ? { receipt } : {}), idempotent: false };
    });
  }

  async markTerminal(agentId: string, terminal: "completed" | "failed" | "stopped" | "aborted", error?: string): Promise<TaskPreflightState> {
    const message = error ?? `Agent ${terminal} without a structured Task Preflight Result`;
    const failure = classifySubagentFailure(message, "lifecycle");
    return this.transact(subagentFailureEvent(failure, "task_preflight_agent_terminal"), (state) => {
      if (state.job.binding?.agentId !== agentId) throw new Error("Unknown Task Preflight Agent");
      if (state.job.status === "infrastructure_failed" || state.job.result) return;
      state.job.lastError = message;
      const decision = recordSubagentFailure(state.job, failure);
      state.status = decision.retry
        ? terminal === "completed" && failure.classification === "semantic" ? "interrupted" : "retry_ready"
        : failure.classification === "infrastructure" ? "infrastructure_failed" : "failed";
      state.job.status = state.status;
    }, { agentId, terminal, failure });
  }

  async markSpawnFailed(bindingId: string, error: string): Promise<TaskPreflightState> {
    const failure = classifySubagentFailure(error, "spawn");
    return this.transact(subagentFailureEvent(failure, "task_preflight_spawn_failed"), (state) => {
      if (state.job.binding?.id !== bindingId) throw new Error("Task Preflight Binding is stale");
      state.job.lastError = error;
      const decision = recordSubagentFailure(state.job, failure);
      state.status = decision.retry ? "retry_ready" : failure.classification === "infrastructure" ? "infrastructure_failed" : "failed";
      state.job.status = state.status;
    }, { bindingId, error, failure });
  }

  async markFrozen(taskPlanHash: string): Promise<TaskPreflightState> {
    return this.transact("task_plan_frozen_after_preflight", (next) => {
      if (next.status !== "passed" || next.job.result?.verdict !== "passed") throw new Error("Task Plan cannot freeze before Task Preflight passes");
      if (next.frozenTaskPlanHash && next.frozenTaskPlanHash !== taskPlanHash) throw new Error("Task Preflight is already bound to another Task Plan hash");
      next.frozenTaskPlanHash = taskPlanHash;
    }, { taskPlanHash });
  }

  async markApplied(dagGeneration: number): Promise<TaskPreflightState> {
    return this.transact("remediation_preflight_applied", (state) => {
      if (state.status !== "passed" || state.job.result?.verdict !== "passed") throw new Error("Only a passed Task Preflight can be applied");
      if (state.appliedDagGeneration && state.appliedDagGeneration !== dagGeneration) throw new Error("Task Preflight is already applied to another DAG Generation");
      state.appliedDagGeneration = dagGeneration;
    }, { dagGeneration });
  }

  async readResult(generation?: number): Promise<TaskPreflightResult | undefined> {
    const state = await this.requireState();
    const selected = generation ?? state.activeProposalGeneration;
    const path = join(this.root, "results", `proposal-${selected}.json`);
    return await exists(path) ? JSON.parse(await readFile(path, "utf8")) as TaskPreflightResult : undefined;
  }

  async readReceipt(generation?: number): Promise<TaskPreflightReceipt | undefined> {
    const state = await this.requireState();
    const selected = generation ?? state.activeProposalGeneration;
    const path = join(this.root, "receipts", `proposal-${selected}.json`);
    return await exists(path) ? JSON.parse(await readFile(path, "utf8")) as TaskPreflightReceipt : undefined;
  }

  async validatePassedEvidence(): Promise<{ result: TaskPreflightResult; receipt: TaskPreflightReceipt }> {
    const state = await this.requireState();
    const result = await this.readResult(state.activeProposalGeneration);
    const receipt = await this.readReceipt(state.activeProposalGeneration);
    if (!result || !receipt || result.verdict !== "passed" || receipt.verdict !== "passed") throw new Error("Passed Task Preflight evidence is incomplete");
    const { resultHash, ...resultBase } = result;
    if (stableHash(resultBase) !== resultHash || state.job.result?.resultHash !== resultHash || receipt.resultHash !== resultHash
      || receipt.proposalGeneration !== result.proposalGeneration || receipt.proposalHash !== result.proposalHash
      || receipt.surfaceHash !== result.surfaceHash || receipt.bindingId !== result.bindingId) {
      throw new Error("Task Preflight Result, Receipt, and Runtime reference do not match");
    }
    return { result, receipt };
  }

  static createBinding(input: Omit<TaskPreflightBinding, "id" | "spawnRequestId" | "createdAt">): TaskPreflightBinding {
    return { ...input, id: randomUUID(), spawnRequestId: randomUUID(), createdAt: new Date().toISOString() };
  }

  private async requireState(): Promise<TaskPreflightState> {
    const state = await this.status();
    if (!state) throw new Error(`Task Preflight does not exist for ${this.issueId}`);
    return state;
  }

  private async transact(type: string, mutation: (state: TaskPreflightState) => void, details?: Record<string, unknown>): Promise<TaskPreflightState> {
    return this.withLock(async () => {
      const current = await this.requireState();
      const next = structuredClone(current);
      mutation(next);
      next.generation = current.generation + 1;
      next.eventSequence = current.eventSequence + 1;
      next.updatedAt = new Date().toISOString();
      await this.persist(type, next, details);
      return next;
    });
  }

  private async persist(type: string, state: TaskPreflightState, details?: Record<string, unknown>): Promise<void> {
    const event: TaskPreflightEvent = {
      id: randomUUID(),
      sequence: state.eventSequence,
      type,
      timestamp: state.updatedAt,
      issueId: state.issueId,
      proposalGeneration: state.activeProposalGeneration,
      ...(state.job.binding ? { bindingId: state.job.binding.id } : {}),
      ...(details ? { details } : {}),
      snapshot: state,
    };
    await appendJsonLine(this.eventsPath, event);
    await atomicWriteJson(this.statePath, state);
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.root, { recursive: true });
    const startedAt = Date.now();
    while (true) {
      try {
        const handle = await open(this.lockPath, "wx", 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
        await handle.close();
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const lockStat = await stat(this.lockPath);
          if (Date.now() - lockStat.mtimeMs > STALE_LOCK_MS) {
            await rm(this.lockPath, { force: true });
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() - startedAt > LOCK_TIMEOUT_MS) throw new Error(`Task Preflight lock timeout: ${this.root}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    try { return await operation(); } finally { await rm(this.lockPath, { force: true }); }
  }
}
