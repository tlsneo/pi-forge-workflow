import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ForgeConfig } from "../src/config/types.js";
import { TaskExecutionService } from "../src/execution/service.js";
import { IssuesService } from "../src/issues/service.js";
import type { IssueDraft } from "../src/issues/types.js";
import { RuntimeService } from "../src/runtime/service.js";
import { TasksService } from "../src/tasks/service.js";
import type { MicroTaskDraft, SliceDraft } from "../src/tasks/types.js";
import { WorkItemService } from "../src/work-item/service.js";
import type { ForgePrd, ReviewAxis } from "../src/work-item/types.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

async function initRepository(root: string): Promise<string> {
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "value.ts"), "export const value = 1;\n");
  git(root, "init", "-q");
  git(root, "config", "user.email", "forge@example.com");
  git(root, "config", "user.name", "Forge Test");
  git(root, "add", ".");
  git(root, "commit", "-qm", "baseline");
  return git(root, "rev-parse", "HEAD");
}

function config(): ForgeConfig {
  const audit = { model: "test/audit", thinking: "high" as const, maxTurns: 20 };
  return {
    schemaVersion: 1, generation: 1, artifacts: { root: ".forge", gitPolicy: "ignore" },
    tracker: { mode: "local", publishRequiresConfirmation: true }, workspace: { mode: "shared-serial", isolationBackend: "none", poolSize: 1 },
    models: { profiles: { simple: { model: "test/simple", thinking: "low", maxTurns: 20 }, complex: audit, audit, verifier: { model: "test/verifier", thinking: "high", maxTurns: 20 } }, routing: { "task.simple": "simple", "task.medium": "complex", "task.complex": "complex", prdCoverageReview: "audit", prdEvidenceReview: "audit", prdArchitectureReview: "audit", blockerVerifier: "verifier", taskPreflight: "audit", remediationPlanner: "complex", issueAudit: "audit" } },
    review: { preset: "standard", prd: { coverageReviewers: 1, evidenceReviewers: 1, architectureReviewers: 1 }, blockerVerification: { profile: "verifier", requireDifferentModel: true } },
    commands: {}, agents: { directory: ".pi/agents", templateVersion: 2 },
  };
}

describe("non-Git Forge Control Workspace", () => {
  it("stores artifacts outside product repos and commits only in the selected Repository", async () => {
    const controlRoot = await mkdtemp(join(tmpdir(), "pi-forge-multi-repo-"));
    roots.push(controlRoot);
    const repositoryRoot = join(controlRoot, "subproject1");
    const untouchedRoot = join(controlRoot, "subproject2");
    const revision = await initRepository(repositoryRoot);
    const untouchedRevision = await initRepository(untouchedRoot);
    await mkdir(join(controlRoot, ".pi"), { recursive: true });
    await writeFile(join(controlRoot, ".pi", "forge.json"), JSON.stringify(config(), null, 2));

    const workItemRoot = join(controlRoot, ".forge", "work-items", "selected-repository");
    const workItem = new WorkItemService(workItemRoot);
    await workItem.initialize({ workItemId: "selected-repository", title: "Selected repository", controlRoot, repositoryRoot, repositoryRevision: revision });
    const evidence = [{ id: "E-01", path: "src/value.ts", symbol: "value", claim: "The selected repository owns the exported value.", repositoryRevision: revision }];
    const prd: ForgePrd = {
      title: "Selected repository", problem: "The selected repository value is stale.", solution: "Update its existing export.", goals: ["Expose value 2"], nonGoals: ["Modify another repository"], actors: ["consumer"],
      userStories: [{ id: "US-01", actor: "a consumer", capability: "read value 2", benefit: "the selected project is correct" }],
      acceptance: [{ id: "AC-01", statement: "subproject1 exports value 2", verification: ["selected repository value command"] }],
      behavior: { happyPath: ["Read value 2"], errorPaths: [], edgeCases: ["subproject2 stays unchanged"] }, decisions: [{ id: "D-01", decision: "Edit the selected repository export", rationale: "It owns the value", evidenceIds: ["E-01"] }], impactEvidence: evidence,
      testSeams: [{ name: "selected value", level: "integration", evidenceIds: ["E-01"], verification: "Read the selected repository export" }], risks: [],
      deliveryBoundaries: [{ id: "DB-01", title: "Update selected value", outcome: "Only subproject1 changes.", goal: "Expose value 2", scope: ["src/value.ts#value"], acceptanceIds: ["AC-01"], behavior: { happyPath: ["Read value 2"], errorPaths: [], edgeCases: ["subproject2 stays unchanged"] }, decisionIds: ["D-01"], impactEvidenceIds: ["E-01"], testSeamNames: ["selected value"], nonGoals: ["Modify another repository"], verification: ["selected repository value command", "Read the selected repository export"], dependencies: [], independentlyDeliverable: true, rationale: "One repository-local outcome." }],
      rollback: "Revert the product commit.", diagrams: [], openQuestions: [],
    };
    await workItem.checkpoint({ decisions: [{ id: "Q-01", question: "Which repository?", dependsOn: [], status: "answered", answer: "subproject1", answerSource: "user" }], evidence, summary: "Target repository is frozen." });
    const submitted = await workItem.submitPrd(prd);
    for (const axis of ["coverage", "evidence", "architecture"] as ReviewAxis[]) await workItem.submitReview({ axis, verdict: "passed", surfaceHash: submitted.currentPrd!.reviewSurfaceHashes[axis], reviewerId: axis, findings: [] });
    await workItem.approve({ approvedBy: "user", evidence: "Approved" });
    await workItem.freeze();
    const issue: IssueDraft = { id: "I001", deliveryBoundaryId: "DB-01", title: "Update selected value", goal: "Expose value 2", deliveryOutcome: "Only subproject1 changes.", scope: ["src/value.ts#value"], nonGoals: ["Modify another repository"], acceptanceIds: ["AC-01"], behavior: prd.behavior, decisionIds: ["D-01"], impactEvidenceIds: ["E-01"], testSeamNames: ["selected value"], verification: ["selected repository value command", "Read the selected repository export"], dependencies: [] };
    await new IssuesService(workItemRoot).submit([issue]);

    const command = "grep -q 'value = 2' src/value.ts";
    const slices: SliceDraft[] = [{ id: "S001", title: "Selected value", goal: "Expose value 2", acceptanceIds: ["AC-01"], taskIds: ["T001"], gate: [{ command, timeoutMs: 30_000, proves: "AC-01" }] }];
    const tasks: MicroTaskDraft[] = [{ id: "T001", title: "Update selected repository value", sliceId: "S001", goal: "Expose value 2", editPoint: { path: "src/value.ts", symbol: "value" }, reads: [{ path: "src/value.ts", symbol: "value", reason: "Existing export" }], writes: ["src/value.ts"], dependencies: [], conflicts: [], produces: ["value 2 export"], consumes: [], acceptanceIds: ["AC-01"], implementationBlueprint: [{ id: "BP-01", instruction: "Change value from 1 to 2.", expectedEvidence: ["src/value.ts#value diff"] }, { id: "BP-02", instruction: "Preserve the export shape.", expectedEvidence: ["Export remains named value"] }], expectedPatchShape: ["One literal change in src/value.ts"], forbiddenChanges: ["No other repository changes"], stopConditions: ["Stop if value export is absent"], outOfScope: ["Other repositories"], verification: [{ command, timeoutMs: 30_000 }], modelProfile: "simple" }];
    const frozen = await new TasksService(workItemRoot).submit("I001", slices, tasks);
    const runtimeManifestPath = join(frozen.manifest.runtimeRoot, "manifest.json");
    const legacyManifest = JSON.parse(await readFile(runtimeManifestPath, "utf8"));
    legacyManifest.taskConformanceRequired = false;
    await writeFile(runtimeManifestPath, JSON.stringify(legacyManifest, null, 2));
    const runtime = new RuntimeService(frozen.manifest.runtimeRoot);
    const manifest = await runtime.store.readManifest();
    expect(manifest).toMatchObject({ controlRoot, repositoryRoot, workspaceRoot: repositoryRoot });

    const contract = (await runtime.store.readDag()).tasks[0]!;
    const state = await runtime.status();
    const binding = RuntimeService.createBinding({ workItemId: "selected-repository", issueId: "I001", taskId: "T001", taskVersion: 1, taskContractPath: "tasks/T001/TASK-V001.md", attempt: 1, workspace: repositoryRoot, baselineCommit: revision, contractHash: contract.contractHash, model: "test/simple", thinking: "low", maxTurns: 20, startedGeneration: state.generation });
    await runtime.claimTask("T001", binding);
    await runtime.bindAgent("T001", binding.id, "worker-1");
    await runtime.markAgentStarted("worker-1");
    await writeFile(join(repositoryRoot, "src", "value.ts"), "export const value = 2;\n");
    await runtime.submitHandoff(binding.id, { changedFiles: ["src/value.ts"], verification: [], produced: ["value 2 export"] });
    await runtime.markAgentTerminal("worker-1", "completed");
    await new TaskExecutionService(frozen.manifest.runtimeRoot).finalizeTask("T001");

    expect(git(repositoryRoot, "log", "-1", "--pretty=%s")).toBe("Update selected repository value");
    expect(git(untouchedRoot, "rev-parse", "HEAD")).toBe(untouchedRevision);
    expect(await readFile(join(untouchedRoot, "src", "value.ts"), "utf8")).toBe("export const value = 1;\n");
    expect(await readFile(join(workItemRoot, "PRD.md"), "utf8")).toContain("Selected repository");
  });
});
