import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskExecutionService } from "../src/execution/service.js";
import { RuntimeService } from "../src/runtime/service.js";
import type { IssueAuditAxis, TaskContract } from "../src/runtime/types.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

async function fixture(command = "node -e \"const v=require('fs').readFileSync('src/value.ts','utf8');if(!v.includes('value = 2'))process.exit(1)\"", gateCommand = command) {
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
    reads: [{ path: "src/value.ts", symbol: "value", reason: "Primary edit" }], implementationBlueprint: ["Change value to 2", "Preserve the export"], outOfScope: [],
    dependencies: [], conflicts: [], writes: ["src/value.ts"], produces: ["value 2"], consumes: [], acceptance: ["AC-01"], verification: [{ command, timeoutMs: 30_000 }],
  };
  const contract = { ...base, contractHash: RuntimeService.contractHash(base) };
  await runtime.initialize({
    workItemId: "work-item-test", issueId: "I001", issueHash: "issue-hash", workspaceRoot: repositoryRoot, workspaceMode: "shared-serial",
    modelPolicy: { defaultProfile: "simple", profiles: { simple: { model: "test/simple", thinking: "low", maxTurns: 10 } }, roles: { "task-worker": "simple" } },
  }, { generation: 1, tasks: [contract] }, [{ id: "S001", gate: [{ command: gateCommand, timeoutMs: 30_000, proves: "AC-01" }] }]);
  const state = await runtime.status();
  const binding = RuntimeService.createBinding({ workItemId: "work-item-test", issueId: "I001", taskId: "T001", taskVersion: 1, taskContractPath: "tasks/T001/TASK-V001.md", attempt: 1, workspace: repositoryRoot, baselineCommit: baseline, contractHash: contract.contractHash, model: "test/simple", thinking: "low", maxTurns: 10, startedGeneration: state.generation });
  await runtime.claimTask("T001", binding);
  await runtime.bindAgent("T001", binding.id, "agent-1");
  await runtime.markAgentStarted("agent-1");
  return { repositoryRoot, runtimeRoot, runtime, binding, baseline };
}

describe("TaskExecutionService", () => {
  it("turns a failed Slice Gate into the existing Remediation planning path", async () => {
    const { repositoryRoot, runtimeRoot, runtime, binding } = await fixture(undefined, "node -e \"process.exit(1)\"");
    await writeFile(join(repositoryRoot, "src", "value.ts"), "export const value = 2;\n");
    await runtime.submitHandoff(binding.id, { changedFiles: ["src/value.ts"], verification: [], produced: ["value 2"] });
    await runtime.markAgentTerminal("agent-1", "completed");
    const execution = new TaskExecutionService(runtimeRoot);
    await execution.finalizeTask("T001");
    const blocked = await execution.runReadySliceGates();
    expect(blocked.issueStatus).toBe("blocked");
    expect(blocked.remediationPlan).toMatchObject({ source: "slice_gate", sourceSliceId: "S001", status: "awaiting_proposal" });
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
      const auditBinding = RuntimeService.createAuditBinding({ axis, attempt: 1, model: job.model, thinking: job.thinking, maxTurns: job.maxTurns, startedGeneration: finalState.generation });
      await runtime.claimAuditJob(axis, auditBinding);
      finalState = await runtime.submitAudit(auditBinding.id, axis, "passed", []);
    }
    expect(finalState.issueStatus).toBe("completed");
    expect(await readFile(join(runtimeRoot, "audits", "issue-final.json"), "utf8")).toContain("architecture_minimality");
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
