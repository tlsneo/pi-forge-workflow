import { isAbsolute, normalize, sep } from "node:path";
import { validateDag } from "./dag.js";
import { RuntimeService } from "./service.js";
import type { IssueAuditFinding, TaskContract, TaskDag } from "./types.js";
import type { MicroTaskDraft } from "../tasks/types.js";

function text(value: string, label: string): void {
  if (!value?.trim()) throw new Error(`${label} must not be empty`);
}

function safePath(path: string, label: string): void {
  text(path, label);
  if (isAbsolute(path)) throw new Error(`${label} must be repository-relative`);
  const normalized = normalize(path);
  if (normalized === ".." || normalized.startsWith(`..${sep}`)) throw new Error(`${label} must remain inside the repository`);
}

export function validateRemediationDrafts(input: {
  currentDag: TaskDag;
  drafts: MicroTaskDraft[];
  confirmedFindings: IssueAuditFinding[];
  knownSliceIds: Set<string>;
  modelProfiles: Set<string>;
}): TaskContract[] {
  if (input.drafts.length === 0) throw new Error("At least one Remediation Micro Task is required");
  if (input.confirmedFindings.length === 0) throw new Error("Remediation requires confirmed Audit Findings");
  const firstExpected = input.currentDag.tasks.reduce((max, task) => Math.max(max, Number(task.id.slice(1))), 0) + 1;
  const ids = new Set(input.currentDag.tasks.map((task) => task.id));
  const confirmedEvidence = new Set(input.confirmedFindings.flatMap((finding) => finding.evidence));
  const contracts: TaskContract[] = [];

  for (const [index, draft] of input.drafts.entries()) {
    const expected = `T${String(firstExpected + index).padStart(3, "0")}`;
    if (draft.id !== expected) throw new Error(`Remediation Task IDs must continue the DAG; expected ${expected}, received ${draft.id}`);
    if (ids.has(draft.id)) throw new Error(`Duplicate Remediation Task ID: ${draft.id}`);
    ids.add(draft.id);
    text(draft.title, `${draft.id} title`);
    text(draft.goal, `${draft.id} goal`);
    if (!input.knownSliceIds.has(draft.sliceId)) throw new Error(`${draft.id} references unknown Slice ${draft.sliceId}`);
    safePath(draft.editPoint.path, `${draft.id} editPoint.path`);
    text(draft.editPoint.symbol, `${draft.id} editPoint.symbol`);
    if (draft.reads.length < 1 || draft.reads.length > 3) throw new Error(`${draft.id} must read between 1 and 3 exact files`);
    for (const read of draft.reads) {
      safePath(read.path, `${draft.id} read path`);
      text(read.symbol, `${draft.id} read symbol`);
      text(read.reason, `${draft.id} read reason`);
    }
    if (draft.writes.length < 1 || draft.writes.length > 3) throw new Error(`${draft.id} must write between 1 and 3 paths`);
    for (const path of draft.writes) safePath(path, `${draft.id} write`);
    if (!draft.writes.includes(draft.editPoint.path)) throw new Error(`${draft.id} primary Edit Point must appear in Writes`);
    if (!draft.reads.some((read) => confirmedEvidence.has(`${read.path}#${read.symbol}`) || confirmedEvidence.has(read.path))) {
      throw new Error(`${draft.id} Reads do not include any confirmed Finding evidence seam`);
    }
    if (draft.implementationBlueprint.length < 3) throw new Error(`${draft.id} Remediation Blueprint must contain at least 3 exact ordered steps`);
    if (draft.produces.length === 0) throw new Error(`${draft.id} must produce a repair artifact`);
    if (draft.verification.length === 0) throw new Error(`${draft.id} requires authoritative verification`);
    if (draft.modelProfile && !input.modelProfiles.has(draft.modelProfile)) throw new Error(`${draft.id} references unknown model profile ${draft.modelProfile}`);
    const base = {
      id: draft.id,
      version: 1,
      title: draft.title,
      sliceId: draft.sliceId,
      goal: draft.goal,
      editPoint: draft.editPoint,
      reads: draft.reads,
      implementationBlueprint: draft.implementationBlueprint,
      outOfScope: draft.outOfScope,
      dependencies: draft.dependencies,
      conflicts: draft.conflicts,
      writes: draft.writes,
      produces: draft.produces,
      consumes: draft.consumes,
      acceptance: draft.acceptanceIds,
      verification: draft.verification,
      ...(draft.modelProfile ? { modelProfile: draft.modelProfile } : {}),
    };
    contracts.push({ ...base, contractHash: RuntimeService.contractHash(base) });
  }
  validateDag({ generation: input.currentDag.generation + 1, tasks: [...input.currentDag.tasks, ...contracts] });
  return contracts;
}
