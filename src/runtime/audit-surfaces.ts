import { stableHash } from "./hash.js";
import type {
  IssueAuditAxis,
  IssueAuditSurface,
  IssueAuditSurfaceReference,
  IssueRuntimeState,
  RuntimeManifest,
  TaskContract,
  TaskDag,
  TaskReceipt,
} from "./types.js";

const ISSUE_AUDIT_SURFACE_POLICY_VERSION = 2;

function sorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function taskReceiptEvidence(taskId: string, receipt: TaskReceipt | undefined) {
  if (!receipt) throw new Error(`Final Issue Audit requires an immutable Receipt for ${taskId}`);
  return {
    taskId,
    taskVersion: receipt.taskVersion,
    contractHash: receipt.contractHash,
    baselineCommit: receipt.baselineCommit ?? null,
    commit: receipt.commit,
    changedFiles: sorted(receipt.changedFiles),
    produced: sorted(receipt.produced),
    verification: receipt.verification,
    conformance: receipt.conformance ?? null,
  };
}

function contractEvidence(contract: TaskContract) {
  return {
    taskId: contract.id,
    taskVersion: contract.version,
    title: contract.title,
    sliceId: contract.sliceId,
    goal: contract.goal ?? null,
    editPoint: contract.editPoint ?? null,
    reads: contract.reads ?? [],
    writes: sorted(contract.writes),
    dependencies: sorted(contract.dependencies),
    produces: sorted(contract.produces),
    consumes: sorted(contract.consumes),
    acceptance: sorted(contract.acceptance),
    expectedPatchShape: contract.expectedPatchShape ?? [],
    forbiddenChanges: contract.forbiddenChanges ?? [],
    outOfScope: contract.outOfScope ?? [],
  };
}

export function issueAuditSurfaceTaskIds(
  state: IssueRuntimeState,
  axis: IssueAuditAxis,
): string[] {
  const previous = state.auditJobs?.[axis]?.surface?.taskIds;
  const invalidated = new Set(state.auditInvalidatedAxes ?? [
    "standards",
    "acceptance_integration",
    "architecture_minimality",
  ] satisfies IssueAuditAxis[]);
  if (previous && !invalidated.has(axis)) return sorted(previous);
  return sorted(Object.keys(state.tasks));
}

export function buildIssueAuditSurface(input: {
  manifest: RuntimeManifest;
  dag: TaskDag;
  state: IssueRuntimeState;
  axis: IssueAuditAxis;
  auditGeneration: number;
  taskIds: string[];
  acceptanceEvidence?: Array<{ id: string; statement: string; verification: string[] }>;
  behaviorEvidence?: { happyPath: string[]; errorPaths: string[]; edgeCases: string[] };
}): IssueAuditSurface {
  const taskIds = sorted(input.taskIds);
  const contracts = new Map(input.dag.tasks.map((contract) => [contract.id, contract]));
  const receipts = taskIds.map((taskId) => taskReceiptEvidence(taskId, input.state.tasks[taskId]?.receipt));
  const changedFiles = sorted(receipts.flatMap((receipt) => receipt.changedFiles));
  const sliceGates = Object.values(input.state.sliceGates ?? {})
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((gate) => ({
      sliceId: gate.id,
      commands: gate.commands,
      verification: gate.verification ?? [],
      status: gate.status,
    }));

  let evidence: unknown;
  switch (input.axis) {
    case "standards":
      evidence = {
        changedFiles,
        taskReceipts: receipts.map(({ taskId, taskVersion, contractHash, baselineCommit, commit, changedFiles: files, verification, conformance }) => ({
          taskId,
          taskVersion,
          contractHash,
          baselineCommit,
          commit,
          changedFiles: files,
          verification,
          conformance,
        })),
      };
      break;
    case "acceptance_integration":
      evidence = {
        issueAcceptance: input.acceptanceEvidence ?? [],
        issueBehavior: input.behaviorEvidence ?? null,
        tasks: taskIds.map((taskId) => {
          const contract = contracts.get(taskId);
          if (!contract) throw new Error(`Final Issue Audit is missing Task contract ${taskId}`);
          const receipt = receipts.find((candidate) => candidate.taskId === taskId)!;
          return {
            taskId,
            sliceId: contract.sliceId,
            acceptance: sorted(contract.acceptance),
            produces: sorted(contract.produces),
            consumes: sorted(contract.consumes),
            commit: receipt.commit,
            verification: receipt.verification,
          };
        }),
        sliceGates,
      };
      break;
    case "architecture_minimality":
      evidence = {
        tasks: taskIds.map((taskId) => {
          const contract = contracts.get(taskId);
          if (!contract) throw new Error(`Final Issue Audit is missing Task contract ${taskId}`);
          return { contract: contractEvidence(contract), receipt: receipts.find((candidate) => candidate.taskId === taskId) };
        }),
        changedFiles,
      };
      break;
  }

  const hashInput = {
    schemaVersion: 1 as const,
    policyVersion: ISSUE_AUDIT_SURFACE_POLICY_VERSION,
    axis: input.axis,
    workItemId: input.manifest.workItemId,
    issueId: input.manifest.issueId,
    issueHash: input.manifest.issueHash,
    repositoryRoot: input.manifest.repositoryRoot,
    taskIds,
    evidence,
  };
  return {
    ...hashInput,
    auditGeneration: input.auditGeneration,
    changedFiles,
    surfaceHash: stableHash(hashInput),
    artifactPath: `audits/generation-${input.auditGeneration}-${input.axis}-surface.json`,
  };
}

export function verifyIssueAuditSurface(surface: IssueAuditSurface): boolean {
  return stableHash({
    schemaVersion: surface.schemaVersion,
    policyVersion: surface.policyVersion,
    axis: surface.axis,
    workItemId: surface.workItemId,
    issueId: surface.issueId,
    issueHash: surface.issueHash,
    repositoryRoot: surface.repositoryRoot,
    taskIds: surface.taskIds,
    evidence: surface.evidence,
  }) === surface.surfaceHash;
}

export function issueAuditSurfaceReference(surface: IssueAuditSurface): IssueAuditSurfaceReference {
  const { evidence: _evidence, ...reference } = surface;
  return reference;
}

export function remediationInvalidatedAuditAxes(
  state: IssueRuntimeState,
): IssueAuditAxis[] {
  const plan = state.remediationPlan;
  if (!plan || plan.source === "slice_gate") {
    return ["standards", "acceptance_integration", "architecture_minimality"];
  }
  const axes = new Set<IssueAuditAxis>(["acceptance_integration"]);
  for (const reference of state.auditBlockerVerifierJob?.findings ?? []) {
    if (plan.confirmedFindingIds.includes(reference.findingId)) axes.add(reference.axis);
  }
  return [...axes].sort() as IssueAuditAxis[];
}
