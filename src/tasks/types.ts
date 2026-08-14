import type { ForgeConfig } from "../config/types.js";
import type { IssueArtifact } from "../issues/types.js";
import type { TaskBlueprintStep, TaskContract, TaskDag } from "../runtime/types.js";

export interface SliceDraft {
  id: string;
  title: string;
  goal: string;
  acceptanceIds: string[];
  taskIds: string[];
  gate: Array<{ command: string; timeoutMs: number; proves: string }>;
}

export interface MicroTaskDraft {
  id: string;
  title: string;
  sliceId: string;
  goal: string;
  editPoint: { path: string; symbol: string };
  reads: Array<{ path: string; symbol: string; reason: string }>;
  writes: string[];
  dependencies: string[];
  conflicts: string[];
  produces: string[];
  consumes: string[];
  acceptanceIds: string[];
  implementationBlueprint: Array<TaskBlueprintStep | string>;
  expectedPatchShape: string[];
  forbiddenChanges: string[];
  stopConditions: string[];
  outOfScope: string[];
  verification: Array<{ command: string; timeoutMs: number }>;
  modelProfile?: string;
}

export interface PreparedTaskPlan {
  issue: IssueArtifact;
  controlRoot: string;
  repositoryRoot: string;
  repositoryRevision: string;
  config: ForgeConfig;
  source: TaskPlanGeneration["source"];
  semanticSource: {
    workItemId: string;
    prdHash: string;
    issuesHash: string;
    issueId: string;
    issueHash: string;
  };
  proposalHash: string;
  slices: SliceDraft[];
  drafts: MicroTaskDraft[];
  contracts: TaskContract[];
  dag: TaskDag;
}

export interface TaskPreflightReference {
  proposalGeneration: number;
  proposalHash: string;
  surfaceHash: string;
  bindingId: string;
  resultHash: string;
  receiptPath: string;
}

export interface TaskPlanGeneration {
  schemaVersion: 1;
  generation: number;
  source: {
    workItemId: string;
    prdHash: string;
    issuesHash: string;
    issueId: string;
    issueHash: string;
    configGeneration: number;
    configHash: string;
  };
  contentHash: string;
  proposalHash?: string;
  preflight?: TaskPreflightReference;
  slices: SliceDraft[];
  tasks: TaskContract[];
  createdAt: string;
}

export interface TaskPlanManifest {
  schemaVersion: 1;
  generation: number;
  issueId: string;
  contentHash: string;
  proposalHash?: string;
  preflight?: TaskPreflightReference;
  runtimeRoot: string;
  slices: SliceDraft[];
  taskIds: string[];
  createdAt: string;
}
