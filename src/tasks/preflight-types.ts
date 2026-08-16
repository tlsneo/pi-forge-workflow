import type { ModelProfile, ThinkingLevel } from "../runtime/types.js";
import type { SubagentFailureRecord } from "../subagents/failures.js";
import type { MicroTaskDraft, SliceDraft } from "./types.js";

export type TaskPreflightJobStatus = "pending" | "starting" | "running" | "retry_ready" | "interrupted" | "passed" | "blocked" | "failed" | "infrastructure_failed";
export type TaskPreflightVerdict = "passed" | "blocked";

export interface TaskPreflightFinding {
  id: string;
  severity: "blocker" | "warning" | "note";
  taskId: string;
  message: string;
  evidence: string[];
  violatedRule: string;
  verification: string;
  suggestedResolution: string;
}

export interface TaskPreflightResult {
  schemaVersion: 1;
  proposalGeneration: number;
  proposalHash: string;
  surfaceHash: string;
  bindingId: string;
  verdict: TaskPreflightVerdict;
  findings: TaskPreflightFinding[];
  resultHash: string;
  submittedAt: string;
}

export interface TaskPreflightBinding {
  id: string;
  proposalGeneration: number;
  proposalHash: string;
  surfaceHash: string;
  attempt: number;
  profile: string;
  model: string;
  thinking: ThinkingLevel;
  maxTurns: number;
  startedStateGeneration: number;
  spawnRequestId: string;
  agentId?: string;
  createdAt: string;
}

export interface TaskPreflightJob {
  id: string;
  status: TaskPreflightJobStatus;
  attempt: number;
  maxAttempts: number;
  infrastructureAttempts?: number;
  maxInfrastructureAttempts?: number;
  lastFailure?: SubagentFailureRecord;
  profile: string;
  model: string;
  thinking: ThinkingLevel;
  maxTurns: number;
  configGeneration: number;
  configHash: string;
  binding?: TaskPreflightBinding;
  result?: TaskPreflightResult;
  lastError?: string;
}

export interface TaskPreflightProposal {
  schemaVersion: 1;
  generation: number;
  issueId: string;
  kind?: "initial" | "remediation";
  runtimeRoot?: string;
  sourceFindingHash?: string;
  sourcePrdGeneration?: number;
  sourcePrdHash?: string;
  sourceIssueHash?: string;
  acceptanceIds?: string[];
  decisionIds?: string[];
  rerunSliceIds?: string[];
  proposalHash: string;
  surfaceHash: string;
  source: {
    workItemId: string;
    controlRoot?: string;
    prdHash: string;
    issuesHash: string;
    issueHash: string;
    repositoryRoot: string;
    repositoryRevision: string;
  };
  slices: SliceDraft[];
  tasks: MicroTaskDraft[];
  createdAt: string;
}

export interface TaskPreflightState {
  schemaVersion: 1;
  issueId: string;
  generation: number;
  eventSequence: number;
  activeProposalGeneration: number;
  proposalHash: string;
  surfaceHash: string;
  status: TaskPreflightJobStatus;
  job: TaskPreflightJob;
  frozenTaskPlanHash?: string;
  appliedDagGeneration?: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskPreflightEvent {
  id: string;
  sequence: number;
  type: string;
  timestamp: string;
  issueId: string;
  proposalGeneration: number;
  bindingId?: string;
  details?: Record<string, unknown>;
  snapshot: TaskPreflightState;
}

export interface TaskPreflightRoute extends ModelProfile {
  profile: string;
  configGeneration: number;
  configHash: string;
}

export interface TaskPreflightReceipt {
  schemaVersion: 1;
  issueId: string;
  proposalGeneration: number;
  proposalHash: string;
  surfaceHash: string;
  bindingId: string;
  resultHash: string;
  verdict: "passed";
  approvedAt: string;
}
