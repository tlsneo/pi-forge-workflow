import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskExecutionService } from "../src/execution/service.js";
import { RuntimeService } from "../src/runtime/service.js";
import type { IssueAuditAxis, RuntimeManifest, TaskContract } from "../src/runtime/types.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

async function fixture(
  command = "node -e \"const v=require('fs').readFileSync('src/value.ts','utf8');if(!v.includes('value = 2'))process.exit(1)\"",
  gateCommand = command,
  assuranceProfile: RuntimeManifest["assuranceProfile"] = "standard",
  taskConformanceRequired = false,
) {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-forge-execution-"));
  roots.push(repositoryRoot);
  await mkdir(join(repositoryRoot, "src"), { recursive: true });
  await writeFile(join(repositoryRoot, "src", "value.ts"), "export const value = 1;\n");
  await writeFile(join(repositoryRoot, ".gitignore"), "/.forge/\n");
  git(repositoryRoot, "init", "-q");
  git(repositoryRoot, "config", "user.email", "forge@example.com");
  git(repositoryRoot, "config", "user.name", "Forge Test");
  git(repositoryRoot, "add", ".");
  git(repositoryRoot, "commit", "-qm", "baseline");
  const baseline = git(repositoryRoot, "rev-parse", "HEAD");
  const runtimeRoot = join(repositoryRoot, ".forge", "issues", "I001", "runtime");
  const runtime = new RuntimeService(runtimeRoot);
  const base: Omit<TaskContract, "contractHash"> = {
    id: "T001", version: 1, title: "Update value", sliceId: "S001", goal: "Expose value 2", editPoint: { path: "src/value.ts", symbol: "value" },
    reads: [{ path: "src/value.ts", symbol: "value", reason: "Primary edit" }], implementationBlueprint: [
      { id: "BP-01", instruction: "Change value to 2", expectedEvidence: ["src/value.ts#value diff"] },
      { id: "BP-02", instruction: "Preserve the export", expectedEvidence: ["Named value export remains"] },
    ], expectedPatchShape: ["One value literal change"], forbiddenChanges: ["No fallback or new export"], stopConditions: ["Stop if value export is absent"], outOfScope: [],
    dependencies: [], conflicts: [], writes: ["src/value.ts"], produces: ["value 2"], consumes: [], acceptance: ["AC-01"], verification: [{ command, timeoutMs: 30_000 }],
  };
  const contract = { ...base, contractHash: RuntimeService.contractHash(base) };
  await runtime.initialize({
    workItemId: "work-item-test", issueId: "I001", issueHash: "issue-hash", workspaceRoot: repositoryRoot, workspaceMode: "shared-serial", assuranceProfile, taskConformanceRequired,
    modelPolicy: { defaultProfile: "simple", profiles: { simple: { model: "test/simple", thinking: "low", maxTurns: 10 }, audit: { model: "test/audit", thinking: "high", maxTurns: 20 } }, roles: { "task-worker": "simple", "task-conformance-auditor": "audit" } },
  }, { generation: 1, tasks: [contract] }, [{ id: "S001", gate: [{ command: gateCommand, timeoutMs: 30_000, proves: "AC-01" }] }]);
  const state = await runtime.status();
  const binding = RuntimeService.createBinding({ workItemId: "work-item-test", issueId: "I001", taskId: "T001", taskVersion: 1, taskContractPath: "tasks/T001/TASK-V001.md", attempt: 1, workspace: repositoryRoot, baselineCommit: baseline, contractHash: contract.contractHash, model: "test/simple", thinking: "low", maxTurns: 10, startedGeneration: state.generation });
  await runtime.claimTask("T001", binding);
  await runtime.bindAgent("T001", binding.id, "agent-1");
  await runtime.markAgentStarted("agent-1");
  return { repositoryRoot, runtimeRoot, runtime, binding, baseline };
}

const blueprintEvidence = [
  { stepId: "BP-01", evidence: ["src/value.ts#value changed to 2"] },
  { stepId: "BP-02", evidence: ["Named value export remains"] },
];

async function submitConformance(runtime: RuntimeService, taskId: string, verdict: "passed" | "blocked") {
  const state = await runtime.status();
  const job = state.tasks[taskId]!.conformanceJob!;
  const binding = RuntimeService.createTaskConformanceBinding({
    workItemId: "work-item-test",
    issueId: "I001",
    taskId,
    taskVersion: job.surface.taskVersion,
    contractHash: job.surface.contractHash,
    surfaceHash: job.surface.surfaceHash,
    attempt: 1,
    model: job.model,
    thinking: job.thinking,
    maxTurns: job.maxTurns,
    startedGeneration: state.generation,
  });
  await runtime.claimTaskConformance(taskId, binding);
  const findings = verdict === "blocked" ? [{
    id: "TC-01", severity: "blocker" as const, message: "The staged patch does not follow BP-01.", evidence: ["src/value.ts#value"], blueprintStepIds: ["BP-01"], violatedRule: "Frozen Blueprint", verification: "Inspect the staged diff", suggestedResolution: "Implement BP-01 exactly without changing the Task contract.",
  }] : [];
  return runtime.submitTaskConformance(binding.id, job.surface.surfaceHash, verdict, findings);
}

describe("TaskExecutionService", () => {
  it("turns a failed Slice Gate into the existing Remediation planning path", async () => {
    const { repositoryRoot, runtimeRoot, runtime, binding } = await fixture(undefined, "node -e \"process.exit(1)\"");
    await runtime.store.transact("test_multi_command_gate", (state) => {
      state.sliceGates!.S001!.commands.push({ command: "node -e \"process.exit(0)\"", timeoutMs: 30_000, proves: "secondary evidence" });
    });
    await writeFile(join(repositoryRoot, "src", "value.ts"), "export const value = 2;\n");
    await runtime.submitHandoff(binding.id, { changedFiles: ["src/value.ts"], verification: [], produced: ["value 2"] });
    await runtime.markAgentTerminal("agent-1", "completed");
    const execution = new TaskExecutionService(runtimeRoot);
    await execution.finalizeTask("T001");
    const blocked = await execution.runReadySliceGates();
    expect(blocked.issueStatus).toBe("blocked");
    expect(blocked.remediationPlan).toMatchObject({ source: "slice_gate", sourceSliceId: "S001", status: "awaiting_proposal" });
    expect(blocked.sliceGates?.S001?.verification).toHaveLength(2);
  });

  it("authoritatively verifies, commits, receipts, and passes the Slice Gate", async () => {
    const { repositoryRoot, runtimeRoot, runtime, binding, baseline } = await fixture();
    await writeFile(join(repositoryRoot, "src", "value.ts"), "export const value = 2;\n");
    await runtime.submitHandoff(binding.id, { changedFiles: ["src/value.ts"], verification: [], produced: ["value 2"] });
    await runtime.markAgentTerminal("agent-1", "completed");

    const execution = new TaskExecutionService(runtimeRoot);
    const result = await execution.finalizeTask("T001");
    expect(result.commit).not.toBe(baseline);
    expect(result.state.tasks.T001?.status).toBe("completed");
    expect(git(repositoryRoot, "status", "--porcelain")).toBe("");
    expect(git(repositoryRoot, "log", "-1", "--pretty=%s")).toBe("Update value");
    const receipt = JSON.parse(await readFile(join(runtimeRoot, "receipts", "T001-V001.json"), "utf8"));
    expect(receipt.workItemId).toBe("work-item-test");
    expect(receipt.issueId).toBe("I001");
    expect(receipt.taskVersion).toBe(1);
    expect(receipt.taskContractPath).toBe("tasks/T001/TASK-V001.md");
    expect(receipt.baselineCommit).toBe(baseline);
    expect(receipt.verification[0].exitCode).toBe(0);

    const integrated = await execution.runReadySliceGates();
    expect(integrated.sliceGates?.S001?.status).toBe("passed");
    expect(integrated.issueStatus).toBe("auditing");

    await runtime.createAuditJobs({
      standards: { model: "test/audit", thinking: "high", maxTurns: 20, configHash: "config" },
      acceptance_integration: { model: "test/audit", thinking: "high", maxTurns: 20, configHash: "config" },
      architecture_minimality: { model: "test/audit", thinking: "high", maxTurns: 20, configHash: "config" },
    });
    let finalState = await runtime.status();
    for (const axis of ["standards", "acceptance_integration", "architecture_minimality"] as IssueAuditAxis[]) {
      const job = finalState.auditJobs![axis];
      const auditBinding = RuntimeService.createAuditBinding({ axis, ...(job.surface ? { surfaceHash: job.surface.surfaceHash } : {}), attempt: 1, model: job.model, thinking: job.thinking, maxTurns: job.maxTurns, startedGeneration: finalState.generation });
      await runtime.claimAuditJob(axis, auditBinding);
      finalState = await runtime.submitAudit(auditBinding.id, axis, "passed", [], job.surface?.surfaceHash);
    }
    expect(finalState.issueStatus).toBe("completed");
    expect(await readFile(join(runtimeRoot, "audits", "issue-final.json"), "utf8")).toContain("architecture_minimality");
  });

  it("requires one passed Task Conformance Audit before commit and Receipt", async () => {
    const { repositoryRoot, runtimeRoot, runtime, binding, baseline } = await fixture(undefined, undefined, "standard", true);
    await writeFile(join(repositoryRoot, "src", "value.ts"), "export const value = 2;\n");
    await runtime.submitHandoff(binding.id, { changedFiles: ["src/value.ts"], verification: [], produced: ["value 2"], blueprintEvidence });
    await runtime.markAgentTerminal("agent-1", "completed");

    const execution = new TaskExecutionService(runtimeRoot);
    const verified = await execution.finalizeTask("T001");

    expect(verified.reviewPending).toBe(true);
    expect(verified.commit).toBeUndefined();
    expect(verified.state.tasks.T001?.status).toBe("awaiting_review");
    expect(verified.state.tasks.T001?.conformanceJob?.status).toBe("pending");
    expect(git(repositoryRoot, "rev-parse", "HEAD")).toBe(baseline);
    expect(git(repositoryRoot, "diff", "--cached", "--name-only")).toBe("src/value.ts");

    const reviewed = await submitConformance(runtime, "T001", "passed");
    const reviewedTask = reviewed.tasks.T001!;
    expect(await runtime.submitTaskConformance(reviewedTask.conformanceJob!.binding!.id, reviewedTask.conformanceJob!.surface.surfaceHash, "passed", [])).toEqual(reviewed);
    const committed = await execution.commitAuditedTask("T001");
    const receipt = JSON.parse(await readFile(join(runtimeRoot, "receipts", "T001-V001.json"), "utf8"));

    expect(committed.commit).not.toBe(baseline);
    expect(committed.state.tasks.T001?.status).toBe("completed");
    expect(await runtime.submitTaskConformance(reviewedTask.conformanceJob!.binding!.id, reviewedTask.conformanceJob!.surface.surfaceHash, "passed", [])).toEqual(committed.state);
    expect(receipt.conformance).toMatchObject({ resultHash: expect.any(String), surfaceHash: expect.any(String) });
    expect(receipt.blueprintEvidence).toEqual(blueprintEvidence);
    expect(git(repositoryRoot, "status", "--porcelain")).toBe("");
  });

  it("blocks when the working tree changes after the staged Task Conformance Surface passed", async () => {
    const { repositoryRoot, runtimeRoot, runtime, binding } = await fixture(undefined, undefined, "standard", true);
    await writeFile(join(repositoryRoot, "src", "value.ts"), "export const value = 2;\n");
    await runtime.submitHandoff(binding.id, { changedFiles: ["src/value.ts"], verification: [], produced: ["value 2"], blueprintEvidence });
    await runtime.markAgentTerminal("agent-1", "completed");
    const execution = new TaskExecutionService(runtimeRoot);
    await execution.finalizeTask("T001");
    await submitConformance(runtime, "T001", "passed");
    await writeFile(join(repositoryRoot, "src", "value.ts"), "export const value = 3;\n");

    await expect(execution.commitAuditedTask("T001")).rejects.toThrow("working tree changed after its staged Task Conformance Surface");

    expect((await runtime.status()).tasks.T001).toMatchObject({ status: "blocked", blocker: expect.stringContaining("working tree changed") });
    expect(git(repositoryRoot, "log", "--oneline").split("\n")).toHaveLength(1);
  });

  it("recovers when the audited Task commit exists but its immutable Receipt was not written", async () => {
    const { repositoryRoot, runtimeRoot, runtime, binding } = await fixture(undefined, undefined, "standard", true);
    await writeFile(join(repositoryRoot, "src", "value.ts"), "export const value = 2;\n");
    await runtime.submitHandoff(binding.id, { changedFiles: ["src/value.ts"], verification: [], produced: ["value 2"], blueprintEvidence });
    await runtime.markAgentTerminal("agent-1", "completed");
    const execution = new TaskExecutionService(runtimeRoot);
    await execution.finalizeTask("T001");
    await submitConformance(runtime, "T001", "passed");
    git(repositoryRoot, "commit", "-m", "Update value");

    const recovered = await execution.commitAuditedTask("T001");

    expect(recovered.state.tasks.T001?.status).toBe("completed");
    expect(JSON.parse(await readFile(join(runtimeRoot, "receipts", "T001-V001.json"), "utf8"))).toMatchObject({ commit: recovered.commit, conformance: { resultHash: expect.any(String) } });
    expect(git(repositoryRoot, "status", "--porcelain")).toBe("");
  });

  it("rolls back a blocked Task Conformance result and retries the same frozen Task with Correction Context", async () => {
    const { repositoryRoot, runtimeRoot, runtime, binding } = await fixture(undefined, undefined, "standard", true);
    await writeFile(join(repositoryRoot, "src", "value.ts"), "export const value = 2;\n");
    await runtime.submitHandoff(binding.id, { changedFiles: ["src/value.ts"], verification: [], produced: ["value 2"], blueprintEvidence });
    await runtime.markAgentTerminal("agent-1", "completed");
    const execution = new TaskExecutionService(runtimeRoot);
    await execution.finalizeTask("T001");
    const blocked = await submitConformance(runtime, "T001", "blocked");
    const blockedJob = blocked.tasks.T001!.conformanceJob!;

    const rejected = await execution.rejectTaskConformance("T001");

    expect(rejected.retried).toBe(true);
    expect(rejected.state.tasks.T001?.status).toBe("ready");
    expect(rejected.state.tasks.T001?.correctionContext).toMatchObject({ findingIds: ["TC-01"], resultPath: expect.stringContaining("conformance-1-result.json") });
    expect(await runtime.submitTaskConformance(blockedJob.binding!.id, blockedJob.surface.surfaceHash, "blocked", blockedJob.result!.findings)).toEqual(rejected.state);
    expect(await readFile(join(repositoryRoot, "src", "value.ts"), "utf8")).toBe("export const value = 1;\n");
    expect(git(repositoryRoot, "status", "--porcelain")).toBe("");
    expect(git(repositoryRoot, "log", "--oneline").split("\n")).toHaveLength(1);
  });

  it("rejects a required Handoff that omits Blueprint Evidence", async () => {
    const { runtime, binding } = await fixture(undefined, undefined, "standard", true);
    await expect(runtime.submitHandoff(binding.id, { changedFiles: ["src/value.ts"], verification: [], produced: ["value 2"] })).rejects.toThrow("requires Blueprint Evidence");
  });

  it("completes Fast issues mechanically after Slice Gates without creating final Audit Jobs", async () => {
    const { repositoryRoot, runtimeRoot, runtime, binding } = await fixture(undefined, undefined, "fast");
    await writeFile(join(repositoryRoot, "src", "value.ts"), "export const value = 2;\n");
    await runtime.submitHandoff(binding.id, { changedFiles: ["src/value.ts"], verification: [], produced: ["value 2"] });
    await runtime.markAgentTerminal("agent-1", "completed");

    const execution = new TaskExecutionService(runtimeRoot);
    await execution.finalizeTask("T001");
    const completed = await execution.runReadySliceGates();

    expect(completed.issueStatus).toBe("completed");
    expect(completed.auditJobs).toBeUndefined();
    expect(completed.audits).toBeUndefined();
    await expect(runtime.createAuditJobs({
      standards: { model: "test/audit", thinking: "high", maxTurns: 20, configHash: "config" },
      acceptance_integration: { model: "test/audit", thinking: "high", maxTurns: 20, configHash: "config" },
      architecture_minimality: { model: "test/audit", thinking: "high", maxTurns: 20, configHash: "config" },
    })).rejects.toThrow("Fast Assurance does not run final Issue Audits");
    expect(JSON.parse(await readFile(join(runtimeRoot, "audits", "issue-final.json"), "utf8"))).toMatchObject({
      assuranceProfile: "fast",
      completionMode: "mechanical",
    });
  });

  it("blocks undeclared writes without committing them", async () => {
    const { repositoryRoot, runtimeRoot, runtime, binding } = await fixture();
    await writeFile(join(repositoryRoot, "src", "value.ts"), "export const value = 2;\n");
    await writeFile(join(repositoryRoot, "outside.ts"), "unexpected\n");
    await runtime.submitHandoff(binding.id, { changedFiles: ["src/value.ts"], verification: [], produced: ["value 2"] });
    await runtime.markAgentTerminal("agent-1", "completed");
    const result = await new TaskExecutionService(runtimeRoot).finalizeTask("T001");
    expect(result.state.tasks.T001?.status).toBe("blocked");
    expect(result.state.issueStatus).toBe("blocked");
    expect(git(repositoryRoot, "log", "--oneline").split("\n")).toHaveLength(1);
  });

  it("reconciles stale Task state only after validating the immutable Receipt commit in Git", async () => {
    const { repositoryRoot, runtimeRoot, runtime, binding } = await fixture();
    await writeFile(join(repositoryRoot, "src", "value.ts"), "export const value = 2;\n");
    await runtime.submitHandoff(binding.id, { changedFiles: ["src/value.ts"], verification: [], produced: ["value 2"] });
    await runtime.markAgentTerminal("agent-1", "completed");
    await new TaskExecutionService(runtimeRoot).finalizeTask("T001");
    await runtime.store.transact("simulate_stale_completed_task_handoff", (state) => {
      delete state.tasks.T001!.receipt;
      state.tasks.T001!.status = "blocked";
      state.tasks.T001!.verificationStatus = "failed";
      state.tasks.T001!.verificationError = "later Task diff was attributed to T001";
      state.tasks.T001!.blocker = state.tasks.T001!.verificationError;
      state.issueStatus = "blocked";
    });

    const result = await new TaskExecutionService(runtimeRoot).reconcileTaskReceipt("T001");

    expect(result.reconciled).toBe(true);
    expect(result.state.tasks.T001).toMatchObject({ status: "completed", gitStatus: "receipted", verificationStatus: "passed" });
    expect(result.state.tasks.T001?.verificationError).toBeUndefined();
    expect(git(repositoryRoot, "status", "--porcelain")).toBe("");
  });

  it("rejects authoritative verification when HEAD has advanced beyond the Binding baseline", async () => {
    const { repositoryRoot, runtimeRoot, runtime, binding } = await fixture();
    await writeFile(join(repositoryRoot, "src", "later.ts"), "export const later = true;\n");
    git(repositoryRoot, "add", "src/later.ts");
    git(repositoryRoot, "commit", "-qm", "later task");
    await writeFile(join(repositoryRoot, "src", "value.ts"), "export const value = 2;\n");
    await runtime.submitHandoff(binding.id, { changedFiles: ["src/value.ts"], verification: [], produced: ["value 2"] });
    await runtime.markAgentTerminal("agent-1", "completed");

    await expect(new TaskExecutionService(runtimeRoot).finalizeTask("T001")).rejects.toThrow("Binding baseline");

    const state = await runtime.status();
    expect(state.tasks.T001?.status).toBe("awaiting_verification");
    expect(state.tasks.T001?.verificationStatus).toBe("not_run");
    expect(git(repositoryRoot, "log", "-1", "--pretty=%s")).toBe("later task");
  });

  it("grants a fresh retry budget after Model Policy rebind and rolls back interrupted Writes", async () => {
    const { repositoryRoot, runtimeRoot, runtime } = await fixture();
    await writeFile(join(repositoryRoot, "src", "value.ts"), "export const value = 2;\n");
    await runtime.markAgentTerminal("agent-1", "failed", "interrupted");
    await runtime.store.transact("simulate_legacy_attempts", (state) => {
      state.tasks.T001!.attempt = 2;
      delete state.tasks.T001!.attemptsByModelPolicy;
    });
    await runtime.blockTask("T001", "Recover interrupted Task before a fresh Binding");
    await runtime.rebindModelPolicy({
      configGeneration: 3,
      configHash: "config-3",
      policy: { defaultProfile: "simple", profiles: { simple: { model: "test/simple", thinking: "low", maxTurns: 30 } }, roles: { "task-worker": "simple" } },
      reason: "Increase max turns",
    });

    const result = await new TaskExecutionService(runtimeRoot).prepareRetry("T001");
    expect(result.retried).toBe(true);
    expect(result.state.tasks.T001?.status).toBe("ready");
    expect(result.state.issueStatus).toBe("executing");
    expect(await readFile(join(repositoryRoot, "src", "value.ts"), "utf8")).toBe("export const value = 1;\n");
    expect(git(repositoryRoot, "status", "--porcelain")).toBe("");
  });

  it("rolls back a failed authoritative verification and schedules a bounded retry", async () => {
    const { repositoryRoot, runtimeRoot, runtime, binding } = await fixture("node -e \"process.exit(1)\"");
    await writeFile(join(repositoryRoot, "src", "value.ts"), "export const value = 2;\n");
    await runtime.submitHandoff(binding.id, { changedFiles: ["src/value.ts"], verification: [], produced: ["value 2"] });
    await runtime.markAgentTerminal("agent-1", "completed");
    const result = await new TaskExecutionService(runtimeRoot).finalizeTask("T001");
    expect(result.retried).toBe(true);
    expect(result.state.tasks.T001?.status).toBe("ready");
    expect(await readFile(join(repositoryRoot, "src", "value.ts"), "utf8")).toBe("export const value = 1;\n");
    expect(git(repositoryRoot, "status", "--porcelain")).toBe("");
  });
});
