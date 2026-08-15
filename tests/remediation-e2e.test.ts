import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ForgeConfig } from "../src/config/types.js";
import { TaskExecutionService } from "../src/execution/service.js";
import { IssuesService } from "../src/issues/service.js";
import { RemediationService } from "../src/tasks/remediation-service.js";
import { TaskPreflightService } from "../src/tasks/preflight-service.js";
import { TasksService } from "../src/tasks/service.js";
import type { MicroTaskDraft, SliceDraft } from "../src/tasks/types.js";
import { RuntimeService } from "../src/runtime/service.js";
import type { IssueAuditAxis } from "../src/runtime/types.js";
import { WorkItemService } from "../src/work-item/service.js";
import type { ForgePrd, ReviewAxis } from "../src/work-item/types.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function config(): ForgeConfig {
  const audit = { model: "test/audit", thinking: "high" as const, maxTurns: 20 };
  return {
    schemaVersion: 1,
    generation: 1,
    artifacts: { root: ".forge", gitPolicy: "ignore" },
    tracker: { mode: "local", publishRequiresConfirmation: true },
    workspace: { mode: "shared-serial", isolationBackend: "none", poolSize: 1 },
    models: {
      profiles: { simple: { model: "test/simple", thinking: "low", maxTurns: 20 }, complex: audit, audit, verifier: { model: "test/verifier", thinking: "high", maxTurns: 20 } },
      routing: {
        "task.simple": "simple",
        "task.medium": "complex",
        "task.complex": "complex",
        prdCoverageReview: "audit",
        prdEvidenceReview: "audit",
        prdArchitectureReview: "audit",
        blockerVerifier: "verifier",
        taskPreflight: "audit",
        remediationPlanner: "complex",
        issueAudit: "audit",
      },
    },
    review: { preset: "standard", prd: { coverageReviewers: 1, evidenceReviewers: 1, architectureReviewers: 1 }, blockerVerification: { profile: "verifier", requireDifferentModel: true } },
    commands: {},
    agents: { directory: ".pi/agents", templateVersion: 2 },
  };
}

async function submitAudit(runtime: RuntimeService, axis: IssueAuditAxis, verdict: "passed" | "blocked", findings: Parameters<RuntimeService["submitAudit"]>[3]) {
  const state = await runtime.status();
  const job = state.auditJobs![axis];
  const binding = RuntimeService.createAuditBinding({ axis, attempt: job.attempt + 1, model: job.model, thinking: job.thinking, maxTurns: job.maxTurns, startedGeneration: state.generation });
  await runtime.claimAuditJob(axis, binding);
  return runtime.submitAudit(binding.id, axis, verdict, findings);
}

describe("full Forge remediation lifecycle", () => {
  it("repairs a confirmed Audit Blocker through Preflight, a new Task receipt, Slice Gate, and re-audit", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-forge-remediation-e2e-"));
    roots.push(repositoryRoot);
    await mkdir(join(repositoryRoot, "src"), { recursive: true });
    await mkdir(join(repositoryRoot, ".pi"), { recursive: true });
    await writeFile(join(repositoryRoot, "src", "value.ts"), "export const value = 1;\n");
    await writeFile(join(repositoryRoot, ".gitignore"), "/.forge/\n");
    await writeFile(join(repositoryRoot, ".pi", "forge.json"), JSON.stringify(config(), null, 2));
    git(repositoryRoot, "init", "-q");
    git(repositoryRoot, "config", "user.email", "forge@example.com");
    git(repositoryRoot, "config", "user.name", "Forge Test");
    git(repositoryRoot, "add", ".");
    git(repositoryRoot, "commit", "-qm", "baseline");
    const revision = git(repositoryRoot, "rev-parse", "HEAD");

    const workItemRoot = join(repositoryRoot, ".forge", "work-items", "value-change");
    const workItem = new WorkItemService(workItemRoot);
    await workItem.initialize({ workItemId: "value-change", title: "Value change", repositoryRoot, repositoryRevision: revision });
    const evidence = [{ id: "E-01", path: "src/value.ts", symbol: "value", claim: "The exported value is the observable seam.", repositoryRevision: revision }];
    const prd: ForgePrd = {
      title: "Value change",
      problem: "The exported value is stale.",
      solution: "Update the existing export without adding fallback behavior.",
      goals: ["Expose value 2"],
      nonGoals: ["Add fallback behavior"],
      actors: ["module consumer"],
      userStories: [{ id: "US-01", actor: "a module consumer", capability: "read value 2", benefit: "the current value is observable" }],
      acceptance: [{ id: "AC-01", statement: "The module exports value 2 without fallback behavior", verification: ["focused value command"] }],
      behavior: { happyPath: ["Read value 2"], errorPaths: ["No new error behavior"], edgeCases: ["No fallback export is introduced"] },
      decisions: [{ id: "D-01", decision: "Modify the existing value export", rationale: "It is the current owning seam", evidenceIds: ["E-01"] }],
      impactEvidence: evidence,
      testSeams: [{ name: "value command", level: "integration", evidenceIds: ["E-01"], verification: "Read src/value.ts and require value 2" }],
      risks: [{ risk: "Speculative fallback", mitigation: "Architecture/Minimality Audit rejects it" }],
      deliveryBoundaries: [{ id: "DB-01", title: "Deliver value 2", outcome: "Consumers observe value 2 without fallback behavior.", goal: "Expose value 2 without fallback behavior.", scope: ["Modify src/value.ts#value"], acceptanceIds: ["AC-01"], behavior: { happyPath: ["Read value 2"], errorPaths: ["No new error behavior"], edgeCases: ["No fallback export is introduced"] }, decisionIds: ["D-01"], impactEvidenceIds: ["E-01"], testSeamNames: ["value command"], nonGoals: ["Add fallback behavior"], verification: ["focused value command", "Read src/value.ts and require value 2"], dependencies: [], independentlyDeliverable: true, rationale: "One observable delivery outcome." }],
      rollback: "Revert the value commits.",
      diagrams: [],
      openQuestions: [],
    };
    await workItem.checkpoint({ decisions: [{ id: "Q-01", question: "Which value?", dependsOn: [], status: "answered", answer: "2", answerSource: "user" }], evidence, summary: "The value and owning seam are settled." });
    const submitted = await workItem.submitPrd(prd);
    for (const axis of ["coverage", "evidence", "architecture"] as ReviewAxis[]) await workItem.submitReview({ axis, verdict: "passed", surfaceHash: submitted.currentPrd!.reviewSurfaceHashes[axis], reviewerId: axis, findings: [] });
    await workItem.approve({ approvedBy: "user", evidence: "Approved" });
    await workItem.freeze();

    await new IssuesService(workItemRoot).submit();

    const valueCommand = "node -e \"const v=require('fs').readFileSync('src/value.ts','utf8');if(!v.includes('value = 2'))process.exit(1)\"";
    const slices: SliceDraft[] = [{ id: "S001", title: "Value behavior", goal: "Expose value 2", acceptanceIds: ["AC-01"], taskIds: ["T001"], gate: [{ command: valueCommand, timeoutMs: 30_000, proves: "AC-01 value is observable" }] }];
    const tasks: MicroTaskDraft[] = [{
      id: "T001", title: "Update exported value", sliceId: "S001", goal: "Expose value 2", editPoint: { path: "src/value.ts", symbol: "value" }, reads: [{ path: "src/value.ts", symbol: "value", reason: "Existing export" }], writes: ["src/value.ts"], dependencies: [], conflicts: [], produces: ["value 2 export"], consumes: [], acceptanceIds: ["AC-01"], implementationBlueprint: [{ id: "BP-01", instruction: "Change value from 1 to 2.", expectedEvidence: ["src/value.ts#value diff"] }, { id: "BP-02", instruction: "Preserve the existing export shape.", expectedEvidence: ["Named value export remains"] }], expectedPatchShape: ["Update the value export in src/value.ts"], forbiddenChanges: ["No fallback behavior"], stopConditions: ["Stop if the value export is absent"], outOfScope: ["Fallback behavior"], verification: [{ command: valueCommand, timeoutMs: 30_000 }], modelProfile: "simple",
    }];
    const frozenTasks = await new TasksService(workItemRoot).submit("I001", slices, tasks);
    const runtimeRoot = frozenTasks.manifest.runtimeRoot;
    const legacyManifest = JSON.parse(await readFile(join(runtimeRoot, "manifest.json"), "utf8"));
    legacyManifest.taskConformanceRequired = false;
    await writeFile(join(runtimeRoot, "manifest.json"), JSON.stringify(legacyManifest, null, 2));
    const runtime = new RuntimeService(runtimeRoot);
    const baseline = git(repositoryRoot, "rev-parse", "HEAD");
    let state = await runtime.status();
    const initialContract = (await runtime.store.readDag()).tasks[0]!;
    const initialBinding = RuntimeService.createBinding({ workItemId: "value-change", issueId: "I001", taskId: "T001", taskVersion: 1, taskContractPath: "tasks/T001/TASK-V001.md", attempt: 1, workspace: repositoryRoot, baselineCommit: baseline, contractHash: initialContract.contractHash, model: "test/simple", thinking: "low", maxTurns: 20, startedGeneration: state.generation });
    await runtime.claimTask("T001", initialBinding);
    await runtime.bindAgent("T001", initialBinding.id, "worker-1");
    await runtime.markAgentStarted("worker-1");
    await writeFile(join(repositoryRoot, "src", "value.ts"), "export const value = 2;\nexport const fallback = true;\n");
    await runtime.submitHandoff(initialBinding.id, { changedFiles: ["src/value.ts"], verification: [], produced: ["value 2 export"] });
    await runtime.markAgentTerminal("worker-1", "completed");
    const execution = new TaskExecutionService(runtimeRoot);
    await execution.finalizeTask("T001");
    state = await execution.runReadySliceGates();
    expect(state.issueStatus).toBe("auditing");

    const auditRoute = { model: "test/audit", thinking: "high" as const, maxTurns: 20, configHash: "config" };
    await runtime.createAuditJobs({ standards: auditRoute, acceptance_integration: auditRoute, architecture_minimality: auditRoute });
    await submitAudit(runtime, "standards", "passed", []);
    await submitAudit(runtime, "acceptance_integration", "passed", []);
    state = await submitAudit(runtime, "architecture_minimality", "blocked", [{ id: "ARCH-01", severity: "blocker", message: "The implementation adds unauthorized fallback behavior.", evidence: ["src/value.ts#fallback"], violatedRule: "Fallback is default-deny", verification: "Read src/value.ts", suggestedResolution: "Remove the fallback export." }]);
    expect(state.issueStatus).toBe("blocked");

    state = await runtime.createAuditBlockerVerifierJob({ model: "test/verifier", thinking: "high", maxTurns: 20, configHash: "config" });
    const verifierJob = state.auditBlockerVerifierJob!;
    const verifierBinding = RuntimeService.createAuditBlockerVerifierBinding({ attempt: 1, findingHash: verifierJob.findingHash, model: verifierJob.model, thinking: verifierJob.thinking, maxTurns: verifierJob.maxTurns, startedGeneration: state.generation });
    await runtime.claimAuditBlockerVerifier(verifierBinding);
    state = await runtime.submitAuditBlockerVerification(verifierBinding.id, [{ findingId: "ARCH-01", status: "confirmed", evidence: ["src/value.ts#fallback"], rationale: "The fallback export exists and is outside frozen scope.", missingEvidence: [] }]);
    expect(state.remediationPlan?.status).toBe("awaiting_proposal");

    state = await runtime.createRemediationPlannerJob({ model: "test/audit", thinking: "high", maxTurns: 20, configHash: "config" });
    const plannerJob = state.remediationPlan!.plannerJob!;
    const plannerBinding = RuntimeService.createRemediationPlannerBinding({ attempt: 1, findingHash: state.remediationPlan!.findingHash, model: plannerJob.model, thinking: plannerJob.thinking, maxTurns: plannerJob.maxTurns, startedGeneration: state.generation });
    await runtime.claimRemediationPlanner(plannerBinding);

    const repair: MicroTaskDraft = {
      id: "T002", title: "Remove unauthorized fallback", sliceId: "S001", goal: "Preserve only the approved value export", editPoint: { path: "src/value.ts", symbol: "fallback" }, reads: [{ path: "src/value.ts", symbol: "fallback", reason: "Confirmed Audit evidence seam" }], writes: ["src/value.ts"], dependencies: ["T001"], conflicts: [], produces: ["fallback removed"], consumes: ["T001::value 2 export"], acceptanceIds: ["AC-01"], implementationBlueprint: [{ id: "BP-01", instruction: "Remove the fallback export.", expectedEvidence: ["src/value.ts#fallback removal"] }, { id: "BP-02", instruction: "Keep the value 2 export unchanged.", expectedEvidence: ["src/value.ts#value remains 2"] }, { id: "BP-03", instruction: "Verify value 2 remains and fallback is absent.", expectedEvidence: ["Focused verification output"] }], expectedPatchShape: ["Remove only the fallback export"], forbiddenChanges: ["No value change or replacement behavior"], stopConditions: ["Stop if fallback is absent or value is not 2"], outOfScope: ["Changing value or adding replacement behavior"], verification: [{ command: `${valueCommand} && ! grep -q fallback src/value.ts`, timeoutMs: 30_000 }], modelProfile: "simple",
    };
    const remediation = new RemediationService(runtimeRoot);
    const proposed = await remediation.propose([repair], ["S001"]);
    await runtime.markRemediationPlannerProposalSubmitted(plannerBinding.id);
    const preflight = new TaskPreflightService(workItemRoot, "I001", "remediation");
    const preflightState = proposed.state!;
    const preflightBinding = TaskPreflightService.createBinding({ proposalGeneration: preflightState.activeProposalGeneration, proposalHash: preflightState.proposalHash, surfaceHash: preflightState.surfaceHash, attempt: 1, profile: preflightState.job.profile, model: preflightState.job.model, thinking: preflightState.job.thinking, maxTurns: preflightState.job.maxTurns, startedStateGeneration: preflightState.generation });
    await preflight.claim(preflightBinding);
    await preflight.submitResult({ bindingId: preflightBinding.id, proposalHash: preflightState.proposalHash, verdict: "passed", findings: [] });
    state = await remediation.applyPassed();
    expect(state.dagGeneration).toBe(2);
    expect(state.tasks.T002?.status).toBe("ready");

    const repairBaseline = git(repositoryRoot, "rev-parse", "HEAD");
    const repairContract = (await runtime.store.readDag()).tasks.find((task) => task.id === "T002")!;
    const repairBinding = RuntimeService.createBinding({ workItemId: "value-change", issueId: "I001", taskId: "T002", taskVersion: 1, taskContractPath: "tasks/T002/TASK-V001.md", attempt: 1, workspace: repositoryRoot, baselineCommit: repairBaseline, contractHash: repairContract.contractHash, model: "test/simple", thinking: "low", maxTurns: 20, startedGeneration: state.generation });
    await runtime.claimTask("T002", repairBinding);
    await runtime.bindAgent("T002", repairBinding.id, "worker-2");
    await runtime.markAgentStarted("worker-2");
    await writeFile(join(repositoryRoot, "src", "value.ts"), "export const value = 2;\n");
    await runtime.submitHandoff(repairBinding.id, { changedFiles: ["src/value.ts"], verification: [], produced: ["fallback removed"] });
    await runtime.markAgentTerminal("worker-2", "completed");
    await execution.finalizeTask("T002");
    state = await execution.runReadySliceGates();
    expect(state.issueStatus).toBe("auditing");
    expect(state.sliceGates?.S001?.status).toBe("passed");

    await runtime.createAuditJobs({ standards: auditRoute, acceptance_integration: auditRoute, architecture_minimality: auditRoute });
    await submitAudit(runtime, "standards", "passed", []);
    await submitAudit(runtime, "acceptance_integration", "passed", []);
    state = await submitAudit(runtime, "architecture_minimality", "passed", []);

    expect(state.issueStatus).toBe("completed");
    expect(state.auditGeneration).toBe(2);
    expect(await readFile(join(repositoryRoot, "src", "value.ts"), "utf8")).toBe("export const value = 2;\n");
    expect(await readFile(join(runtimeRoot, "receipts", "T001-V001.json"), "utf8")).toContain("value 2 export");
    expect(await readFile(join(runtimeRoot, "receipts", "T002-V001.json"), "utf8")).toContain("fallback removed");
    expect(await readFile(join(runtimeRoot, "generations", "dag-2.json"), "utf8")).toContain('"id": "T002"');
    expect(await readFile(join(runtimeRoot, "audits", "issue-final.json"), "utf8")).toContain("acceptance_integration");
    expect(git(repositoryRoot, "log", "--pretty=%s").split("\n")).toEqual(["Remove unauthorized fallback", "Update exported value", "baseline"]);
    expect(git(repositoryRoot, "status", "--porcelain")).toBe("");
  });
});
