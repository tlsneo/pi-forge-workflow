import { isAbsolute, normalize, sep } from "node:path";
import { validateBlueprintSteps } from "../runtime/blueprint.js";
import { validateDag } from "../runtime/dag.js";
import type { TaskContract, TaskDag } from "../runtime/types.js";
import type { IssueArtifact } from "../issues/types.js";
import type { ForgeConfig } from "../config/types.js";
import { validateTaskContextBudget } from "./context-budget.js";
import type { MicroTaskDraft, SliceDraft } from "./types.js";

function text(value: string, label: string): void {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
}

function unique(values: string[], label: string, allowEmpty = false): void {
  if (!Array.isArray(values) || (!allowEmpty && values.length === 0)) throw new Error(`${label} must${allowEmpty ? "" : " not"} be empty`);
  const seen = new Set<string>();
  for (const value of values) {
    text(value, label);
    if (seen.has(value)) throw new Error(`${label} contains duplicate value: ${value}`);
    seen.add(value);
  }
}

function safePath(path: string, label: string): void {
  text(path, label);
  if (isAbsolute(path)) throw new Error(`${label} must be repository-relative`);
  const normalized = normalize(path);
  if (normalized === ".." || normalized.startsWith(`..${sep}`)) throw new Error(`${label} must remain inside the repository`);
}

function validateCommand(command: { command: string; timeoutMs: number }, label: string): void {
  text(command.command, `${label} command`);
  if (!Number.isInteger(command.timeoutMs) || command.timeoutMs < 1_000 || command.timeoutMs > 1_800_000) {
    throw new Error(`${label} timeoutMs must be between 1000 and 1800000`);
  }
}

export function validateTaskPlan(issue: IssueArtifact, config: ForgeConfig, slices: SliceDraft[], drafts: MicroTaskDraft[]): TaskDag {
  if (config.workspace.mode !== "shared-serial" || config.workspace.isolationBackend !== "none") {
    throw new Error("The current forge-tasks MVP requires shared-serial with isolationBackend none");
  }
  if (slices.length === 0) throw new Error("At least one vertical Slice is required");
  if (drafts.length === 0) throw new Error("At least one behavior-complete Task is required");
  const issueAcceptance = new Set(issue.acceptanceIds);
  const sliceIds = new Set<string>();
  const taskIds = new Set<string>();

  for (const [index, slice] of slices.entries()) {
    const expected = `S${String(index + 1).padStart(3, "0")}`;
    if (slice.id !== expected) throw new Error(`Slice IDs must be contiguous; expected ${expected}, received ${slice.id}`);
    sliceIds.add(slice.id);
    text(slice.title, `${slice.id} title`);
    text(slice.goal, `${slice.id} goal`);
    unique(slice.acceptanceIds, `${slice.id} acceptanceIds`);
    unique(slice.taskIds, `${slice.id} taskIds`);
    if (slice.gate.length === 0) throw new Error(`${slice.id} requires at least one Slice Gate command`);
    for (const acceptanceId of slice.acceptanceIds) if (!issueAcceptance.has(acceptanceId)) throw new Error(`${slice.id} references unknown Issue Acceptance ${acceptanceId}`);
    for (const [gateIndex, gate] of slice.gate.entries()) {
      validateCommand(gate, `${slice.id} gate ${gateIndex + 1}`);
      text(gate.proves, `${slice.id} gate ${gateIndex + 1} proves`);
    }
  }
  const sliceAcceptanceCoverage = new Set(slices.flatMap((slice) => slice.acceptanceIds));
  const uncoveredIssueAcceptance = [...issueAcceptance].filter((id) => !sliceAcceptanceCoverage.has(id));
  if (uncoveredIssueAcceptance.length > 0) throw new Error(`Issue Acceptance is not covered by any Slice: ${uncoveredIssueAcceptance.join(", ")}`);

  for (const [index, task] of drafts.entries()) {
    const expected = `T${String(index + 1).padStart(3, "0")}`;
    if (task.id !== expected) throw new Error(`Task IDs must be contiguous; expected ${expected}, received ${task.id}`);
    if (taskIds.has(task.id)) throw new Error(`Duplicate Task ID: ${task.id}`);
    taskIds.add(task.id);
    if (!sliceIds.has(task.sliceId)) throw new Error(`${task.id} references unknown Slice ${task.sliceId}`);
    text(task.title, `${task.id} title`);
    text(task.goal, `${task.id} goal`);
    safePath(task.editPoint.path, `${task.id} editPoint.path`);
    text(task.editPoint.symbol, `${task.id} editPoint.symbol`);
    validateTaskContextBudget(task.id, task.reads, task.writes);
    for (const read of task.reads) {
      safePath(read.path, `${task.id} read path`);
      text(read.symbol, `${task.id} read symbol`);
      text(read.reason, `${task.id} read reason`);
    }
    unique(task.writes, `${task.id} writes`);
    for (const path of task.writes) safePath(path, `${task.id} write`);
    if (!task.writes.includes(task.editPoint.path)) throw new Error(`${task.id} primary Edit Point must appear in Writes`);
    unique(task.dependencies, `${task.id} dependencies`, true);
    unique(task.conflicts, `${task.id} conflicts`, true);
    unique(task.produces, `${task.id} produces`);
    unique(task.consumes, `${task.id} consumes`, true);
    unique(task.acceptanceIds, `${task.id} acceptanceIds`);
    validateBlueprintSteps(task.id, task.implementationBlueprint);
    unique(task.expectedPatchShape, `${task.id} expectedPatchShape`);
    unique(task.forbiddenChanges, `${task.id} forbiddenChanges`);
    unique(task.stopConditions, `${task.id} stopConditions`);
    unique(task.outOfScope, `${task.id} outOfScope`, true);
    if (task.verification.length === 0) throw new Error(`${task.id} requires authoritative verification`);
    task.verification.forEach((command, commandIndex) => validateCommand(command, `${task.id} verification ${commandIndex + 1}`));
    const slice = slices.find((candidate) => candidate.id === task.sliceId)!;
    for (const acceptanceId of task.acceptanceIds) if (!slice.acceptanceIds.includes(acceptanceId)) throw new Error(`${task.id} references Acceptance ${acceptanceId} outside ${slice.id}`);
    if (task.modelProfile && !config.models.profiles[task.modelProfile]) throw new Error(`${task.id} references unknown model profile ${task.modelProfile}`);
  }

  for (const slice of slices) {
    const actualTaskIds = drafts.filter((task) => task.sliceId === slice.id).map((task) => task.id);
    if (actualTaskIds.length !== slice.taskIds.length || actualTaskIds.some((id, index) => id !== slice.taskIds[index])) {
      throw new Error(`${slice.id} taskIds must exactly match its ordered Task drafts`);
    }
    const covered = new Set(drafts.filter((task) => task.sliceId === slice.id).flatMap((task) => task.acceptanceIds));
    const missing = slice.acceptanceIds.filter((id) => !covered.has(id));
    if (missing.length > 0) throw new Error(`${slice.id} Acceptance is not covered by its Tasks: ${missing.join(", ")}`);
  }

  const contracts: TaskContract[] = drafts.map((task) => ({
    id: task.id,
    version: 1,
    title: task.title,
    sliceId: task.sliceId,
    goal: task.goal,
    editPoint: task.editPoint,
    reads: task.reads,
    implementationBlueprint: validateBlueprintSteps(task.id, task.implementationBlueprint),
    expectedPatchShape: task.expectedPatchShape,
    forbiddenChanges: task.forbiddenChanges,
    stopConditions: task.stopConditions,
    outOfScope: task.outOfScope,
    dependencies: task.dependencies,
    conflicts: task.conflicts,
    writes: task.writes,
    produces: task.produces,
    consumes: task.consumes,
    acceptance: task.acceptanceIds,
    verification: task.verification,
    ...(task.modelProfile ? { modelProfile: task.modelProfile } : {}),
    contractHash: "pending",
  }));
  const dag: TaskDag = { generation: 1, tasks: contracts };
  validateDag(dag);
  return dag;
}
