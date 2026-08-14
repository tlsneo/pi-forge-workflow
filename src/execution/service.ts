import { spawn } from "node:child_process";
import { realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolveModelProfile } from "../model/router.js";
import { stableHash } from "../runtime/hash.js";
import { RuntimeService } from "../runtime/service.js";
import type { TaskConformanceSurface, TaskContract } from "../runtime/types.js";

export interface CommandResult {
  command: string;
  exitCode: number;
  keyOutput?: string;
}

async function runProcess(command: string, args: string[], cwd: string, timeoutMs: number): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const timeout = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolveResult({ exitCode: code ?? (signal ? 124 : 1), stdout, stderr });
    });
  });
}

async function git(cwd: string, args: string[], timeoutMs = 30_000): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return runProcess("git", args, cwd, timeoutMs);
}

function output(stdout: string, stderr: string): string | undefined {
  const text = `${stdout}${stdout && stderr ? "\n" : ""}${stderr}`.trim();
  return text ? text.slice(-2_000) : undefined;
}

function sorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

export class TaskExecutionService {
  readonly runtime: RuntimeService;

  constructor(runtimeRoot: string) {
    this.runtime = new RuntimeService(runtimeRoot);
  }

  private async requireFrozenGitRoot(): Promise<void> {
    const manifest = await this.runtime.store.readManifest();
    const topLevel = await git(manifest.workspaceRoot, ["rev-parse", "--show-toplevel"]);
    if (topLevel.exitCode !== 0 || !topLevel.stdout.trim()) throw new Error("Forge execution requires a Git Working Tree");
    const actualRoot = await realpath(resolve(topLevel.stdout.trim()));
    const repositoryRoot = await realpath(resolve(manifest.repositoryRoot));
    const workspaceRoot = await realpath(resolve(manifest.workspaceRoot));
    if (actualRoot !== repositoryRoot) {
      throw new Error(`Execution Git Root ${actualRoot} does not match frozen Repository Root ${repositoryRoot}`);
    }
    if (workspaceRoot !== actualRoot) {
      throw new Error(`The current shared-serial release requires workspaceRoot to equal repositoryRoot: ${workspaceRoot}`);
    }
  }

  async requireCleanWorkspace(): Promise<string> {
    const manifest = await this.runtime.store.readManifest();
    await this.requireFrozenGitRoot();
    const status = await git(manifest.workspaceRoot, ["status", "--porcelain"]);
    if (status.exitCode !== 0) throw new Error(output(status.stdout, status.stderr) ?? "git status failed");
    if (status.stdout.trim()) throw new Error("forge-run requires a clean Git workspace before claiming the next Task");
    const head = await git(manifest.workspaceRoot, ["rev-parse", "HEAD"]);
    if (head.exitCode !== 0 || !head.stdout.trim()) throw new Error("forge-run requires a committed Git baseline");
    return head.stdout.trim();
  }

  async reconcileTaskReceipt(taskId: string): Promise<{ state: Awaited<ReturnType<RuntimeService["status"]>>; reconciled: boolean }> {
    await this.requireFrozenGitRoot();
    const state = await this.runtime.status();
    const task = state.tasks[taskId];
    if (!task?.receipt) throw new Error(`${taskId} has no Task Receipt to reconcile`);
    const manifest = await this.runtime.store.readManifest();
    const commitExists = await git(manifest.workspaceRoot, ["cat-file", "-e", `${task.receipt.commit}^{commit}`]);
    if (commitExists.exitCode !== 0) throw new Error(`${taskId} Receipt commit does not exist: ${task.receipt.commit}`);
    const ancestor = await git(manifest.workspaceRoot, ["merge-base", "--is-ancestor", task.receipt.commit, "HEAD"]);
    if (ancestor.exitCode !== 0) throw new Error(`${taskId} Receipt commit is not an ancestor of current HEAD: ${task.receipt.commit}`);
    return this.runtime.reconcileTaskReceipt(taskId);
  }

  async prepareRetry(taskId: string, maxAttempts = 2): Promise<{ state: Awaited<ReturnType<RuntimeService["status"]>>; retried: boolean }> {
    await this.requireFrozenGitRoot();
    const state = await this.runtime.status();
    const task = state.tasks[taskId];
    const recoverableStatus = task && (["retry_ready", "interrupted"].includes(task.status)
      || (task.status === "blocked" && task.blocker === "Recover interrupted Task before a fresh Binding"));
    if (!task?.binding || !recoverableStatus) throw new Error(`${taskId} is not an interrupted retry candidate`);
    const baseline = task.binding.baselineCommit;
    if (!baseline) throw new Error(`${taskId} Binding has no Git baseline`);
    const manifest = await this.runtime.store.readManifest();
    const contract = (await this.runtime.store.readDag()).tasks.find((candidate) => candidate.id === taskId);
    if (!contract) throw new Error(`Missing Task contract ${taskId}`);
    const actual = await this.changedFiles(manifest.workspaceRoot, baseline);
    const outside = actual.filter((path) => !contract.writes.includes(path));
    if (outside.length > 0) {
      const reason = `${taskId} interrupted with undeclared paths: ${outside.join(", ")}`;
      return { state: await this.runtime.blockTask(taskId, reason), retried: false };
    }
    return this.rollbackAndRetry(taskId, contract, baseline, "Recover interrupted Task before a fresh Binding", maxAttempts);
  }

  async finalizeTask(taskId: string, maxAttempts = 2): Promise<{ state: Awaited<ReturnType<RuntimeService["status"]>>; commit?: string; retried: boolean; reviewPending?: boolean }> {
    await this.requireFrozenGitRoot();
    const state = await this.runtime.status();
    const task = state.tasks[taskId];
    if (task?.receipt || task?.status === "completed" || task?.gitStatus === "receipted") throw new Error(`${taskId} has an immutable Task Receipt`);
    if (!task?.binding || !task.handoff) throw new Error(`${taskId} has no bound Handoff`);
    const manifest = await this.runtime.store.readManifest();
    const contract = (await this.runtime.store.readDag()).tasks.find((candidate) => candidate.id === taskId);
    if (!contract) throw new Error(`Missing Task contract ${taskId}`);
    const baseline = task.binding.baselineCommit;
    if (!baseline) throw new Error(`${taskId} Binding has no Git baseline`);
    const headBeforeVerification = await git(manifest.workspaceRoot, ["rev-parse", "HEAD"]);
    if (headBeforeVerification.exitCode !== 0 || !headBeforeVerification.stdout.trim()) throw new Error(`Unable to read HEAD before verifying ${taskId}`);
    if (headBeforeVerification.stdout.trim() !== baseline) {
      throw new Error(`${taskId} Binding baseline ${baseline} is stale; current HEAD is ${headBeforeVerification.stdout.trim()}`);
    }
    await this.runtime.beginVerification(taskId);

    const actual = await this.changedFiles(manifest.workspaceRoot, baseline);
    const outside = actual.filter((path) => !contract.writes.includes(path));
    if (outside.length > 0) {
      const reason = `${taskId} changed undeclared paths: ${outside.join(", ")}`;
      await this.runtime.finishVerification(taskId, false, reason);
      return { state: await this.runtime.blockTask(taskId, reason), retried: false };
    }
    if (JSON.stringify(sorted(actual)) !== JSON.stringify(sorted(task.handoff.changedFiles))) {
      return this.failAndMaybeRetry(taskId, contract, baseline, `Authoritative Git diff does not match Handoff: ${actual.join(", ")}`, maxAttempts);
    }

    const verification: CommandResult[] = [];
    for (const check of contract.verification) {
      const result = await runProcess("bash", ["-lc", check.command], manifest.workspaceRoot, check.timeoutMs);
      const keyOutput = output(result.stdout, result.stderr);
      verification.push({ command: check.command, exitCode: result.exitCode, ...(keyOutput ? { keyOutput } : {}) });
      if (result.exitCode !== 0) {
        await this.runtime.finishVerification(taskId, false, `Verification failed: ${check.command}`, verification);
        return this.rollbackAndRetry(taskId, contract, baseline, `Verification failed: ${check.command}`, maxAttempts);
      }
    }
    const staged = await git(manifest.workspaceRoot, ["add", "--", ...actual]);
    if (staged.exitCode !== 0) return this.blockAfterVerification(taskId, `git add failed before final checks: ${output(staged.stdout, staged.stderr) ?? "unknown error"}`);
    const diffCheck = await git(manifest.workspaceRoot, ["diff", "--cached", "--check", baseline, "--"]);
    if (diffCheck.exitCode !== 0) {
      const reason = `git diff --check failed: ${output(diffCheck.stdout, diffCheck.stderr) ?? "unknown error"}`;
      await this.runtime.finishVerification(taskId, false, reason, verification);
      return this.rollbackAndRetry(taskId, contract, baseline, reason, maxAttempts);
    }
    verification.push({ command: "git diff --check", exitCode: 0 });
    await this.runtime.finishVerification(taskId, true, undefined, verification);

    if (manifest.taskConformanceRequired) {
      const next = await this.prepareTaskConformance(taskId, contract, baseline, actual, verification);
      return { state: next, retried: false, reviewPending: true };
    }

    const commitSubject = contract.title.trim().split(/\r?\n/, 1)[0];
    if (!commitSubject) return this.blockAfterVerification(taskId, "Task title cannot produce a Git commit subject");
    const commit = await git(manifest.workspaceRoot, ["commit", "-m", commitSubject], 120_000);
    if (commit.exitCode !== 0) return this.blockAfterVerification(taskId, `git commit failed: ${output(commit.stdout, commit.stderr) ?? "unknown error"}`);
    const head = await git(manifest.workspaceRoot, ["rev-parse", "HEAD"]);
    if (head.exitCode !== 0 || !head.stdout.trim()) return this.blockAfterVerification(taskId, "Unable to read Task commit");
    const next = await this.runtime.completeTask(taskId, head.stdout.trim());
    return { state: next, commit: head.stdout.trim(), retried: false };
  }

  async continueVerifiedTask(taskId: string): Promise<{ state: Awaited<ReturnType<RuntimeService["status"]>>; reviewPending: boolean }> {
    await this.requireFrozenGitRoot();
    const state = await this.runtime.status();
    const task = state.tasks[taskId];
    if (!task?.binding || !task.handoff || task.status !== "verifying" || task.verificationStatus !== "passed") {
      throw new Error(`${taskId} has no verified Task patch to continue`);
    }
    const manifest = await this.runtime.store.readManifest();
    if (!manifest.taskConformanceRequired) throw new Error(`${taskId} legacy completion cannot resume through Task Conformance`);
    const contract = (await this.runtime.store.readDag()).tasks.find((candidate) => candidate.id === taskId);
    if (!contract) throw new Error(`Missing Task contract ${taskId}`);
    const baseline = task.binding.baselineCommit;
    if (!baseline) throw new Error(`${taskId} Binding has no Git baseline`);
    const actual = await this.changedFiles(manifest.workspaceRoot, baseline);
    const staged = await git(manifest.workspaceRoot, ["add", "--", ...actual]);
    if (staged.exitCode !== 0) throw new Error(`git add failed while recovering ${taskId}: ${output(staged.stdout, staged.stderr) ?? "unknown error"}`);
    const next = await this.prepareTaskConformance(taskId, contract, baseline, actual, task.authoritativeVerification ?? []);
    return { state: next, reviewPending: true };
  }

  async commitAuditedTask(taskId: string): Promise<{ state: Awaited<ReturnType<RuntimeService["status"]>>; commit: string }> {
    await this.requireFrozenGitRoot();
    const state = await this.runtime.status();
    const task = state.tasks[taskId];
    const job = task?.conformanceJob;
    if (!task?.binding || !job?.result || job.result.verdict !== "passed" || task.status !== "awaiting_commit") {
      throw new Error(`${taskId} has no passed Task Conformance Result awaiting commit`);
    }
    const manifest = await this.runtime.store.readManifest();
    const contract = (await this.runtime.store.readDag()).tasks.find((candidate) => candidate.id === taskId);
    if (!contract) throw new Error(`Missing Task contract ${taskId}`);
    const baseline = task.binding.baselineCommit;
    if (!baseline) throw new Error(`${taskId} Binding has no Git baseline`);
    const actual = await this.changedFiles(manifest.workspaceRoot, baseline);
    const patchHash = await this.patchHash(manifest.workspaceRoot, baseline, actual);
    if (patchHash !== job.surface.patchHash || JSON.stringify(sorted(actual)) !== JSON.stringify(sorted(job.surface.changedFiles))) {
      return this.blockAuditedTask(taskId, `${taskId} working patch changed after Task Conformance Review`);
    }
    const head = await git(manifest.workspaceRoot, ["rev-parse", "HEAD"]);
    if (head.exitCode !== 0 || !head.stdout.trim()) throw new Error(`Unable to read HEAD before committing ${taskId}`);
    let commitHash = head.stdout.trim();
    if (commitHash === baseline) {
      const unstaged = await git(manifest.workspaceRoot, ["diff", "--quiet", "--"]);
      const untracked = await git(manifest.workspaceRoot, ["ls-files", "--others", "--exclude-standard"]);
      if (unstaged.exitCode !== 0 || untracked.exitCode !== 0 || untracked.stdout.trim()) {
        return this.blockAuditedTask(taskId, `${taskId} working tree changed after its staged Task Conformance Surface was frozen`);
      }
      const commitSubject = contract.title.trim().split(/\r?\n/, 1)[0];
      if (!commitSubject) return this.blockAuditedTask(taskId, "Task title cannot produce a Git commit subject");
      const commit = await git(manifest.workspaceRoot, ["commit", "-m", commitSubject], 120_000);
      if (commit.exitCode !== 0) return this.blockAuditedTask(taskId, `git commit failed: ${output(commit.stdout, commit.stderr) ?? "unknown error"}`);
      const committedHead = await git(manifest.workspaceRoot, ["rev-parse", "HEAD"]);
      if (committedHead.exitCode !== 0 || !committedHead.stdout.trim()) return this.blockAuditedTask(taskId, `Unable to read ${taskId} commit`);
      commitHash = committedHead.stdout.trim();
    } else {
      const parent = await git(manifest.workspaceRoot, ["rev-parse", `${commitHash}^`]);
      if (parent.exitCode !== 0 || parent.stdout.trim() !== baseline) {
        return this.blockAuditedTask(taskId, `${taskId} HEAD moved beyond its audited one-commit patch`);
      }
      const status = await git(manifest.workspaceRoot, ["status", "--porcelain"]);
      if (status.exitCode !== 0 || status.stdout.trim()) return this.blockAuditedTask(taskId, `${taskId} crash recovery requires a clean committed audited patch`);
    }
    const finalStatus = await git(manifest.workspaceRoot, ["status", "--porcelain"]);
    if (finalStatus.exitCode !== 0 || finalStatus.stdout.trim()) return this.blockAuditedTask(taskId, `${taskId} audited commit left an unexpected dirty workspace`);
    return { state: await this.runtime.completeTask(taskId, commitHash), commit: commitHash };
  }

  async rejectTaskConformance(taskId: string, maxAttempts = 2): Promise<{ state: Awaited<ReturnType<RuntimeService["status"]>>; retried: boolean }> {
    await this.requireFrozenGitRoot();
    const state = await this.runtime.status();
    const task = state.tasks[taskId];
    const job = task?.conformanceJob;
    if (!task?.binding || !job?.result || job.result.verdict !== "blocked" || task.status !== "blocked") {
      throw new Error(`${taskId} has no blocked Task Conformance Result to reject`);
    }
    const contract = (await this.runtime.store.readDag()).tasks.find((candidate) => candidate.id === taskId);
    if (!contract) throw new Error(`Missing Task contract ${taskId}`);
    const baseline = task.binding.baselineCommit;
    if (!baseline) throw new Error(`${taskId} Binding has no Git baseline`);
    const blockers = job.result.findings.filter((finding) => finding.severity === "blocker").map((finding) => finding.id);
    return this.rollbackAndRetry(taskId, contract, baseline, `Task Conformance blocked: ${blockers.join(", ")}`, maxAttempts);
  }

  async completeFastIssue(): Promise<Awaited<ReturnType<RuntimeService["status"]>>> {
    await this.requireCleanWorkspace();
    return this.runtime.completeFastIssue();
  }

  async runReadySliceGates(): Promise<Awaited<ReturnType<RuntimeService["status"]>>> {
    await this.requireFrozenGitRoot();
    let state = await this.runtime.status();
    const manifest = await this.runtime.store.readManifest();
    const dag = await this.runtime.store.readDag();
    for (const gate of Object.values(state.sliceGates ?? {}).sort((left, right) => left.id.localeCompare(right.id))) {
      if (gate.status === "passed") continue;
      const sliceTasks = dag.tasks.filter((task) => task.sliceId === gate.id);
      if (sliceTasks.some((task) => state.tasks[task.id]?.status !== "completed")) continue;
      state = await this.runtime.startSliceGate(gate.id);
      const verification: CommandResult[] = [];
      let error: string | undefined;
      for (const check of gate.commands) {
        const result = await runProcess("bash", ["-lc", check.command], manifest.workspaceRoot, check.timeoutMs);
        const keyOutput = output(result.stdout, result.stderr);
        verification.push({ command: check.command, exitCode: result.exitCode, ...(keyOutput ? { keyOutput } : {}) });
        if (result.exitCode !== 0) {
          error = `Slice Gate failed: ${check.command}`;
          break;
        }
      }
      state = await this.runtime.finishSliceGate(gate.id, !error, verification, error);
      if (error) break;
    }
    if (state.issueStatus === "auditing" && manifest.assuranceProfile === "fast") {
      state = await this.completeFastIssue();
    }
    return state;
  }

  private async prepareTaskConformance(
    taskId: string,
    contract: TaskContract,
    baseline: string,
    changedFiles: string[],
    verification: CommandResult[],
  ) {
    const state = await this.runtime.status();
    const task = state.tasks[taskId];
    if (!task?.binding || !task.handoff) throw new Error(`${taskId} is missing its Binding or Handoff`);
    const policy = await this.runtime.activeModelPolicy();
    const route = resolveModelProfile(policy.policy, { role: "task-conformance-auditor" });
    const generation = (task.conformanceGeneration ?? 0) + 1;
    const artifactPath = `audits/tasks/${taskId}/conformance-${generation}-surface.json`;
    const manifest = await this.runtime.store.readManifest();
    const patchHash = await this.patchHash(manifest.workspaceRoot, baseline, changedFiles);
    const createdAt = task.handoff.submittedAt;
    const surfaceBase = {
      schemaVersion: 1 as const,
      workItemId: manifest.workItemId,
      issueId: manifest.issueId,
      taskId,
      taskVersion: contract.version,
      contractHash: contract.contractHash,
      workerBindingId: task.binding.id,
      baselineCommit: baseline,
      changedFiles: sorted(changedFiles),
      patchHash,
      blueprintEvidence: structuredClone(task.handoff.blueprintEvidence ?? []),
      verification: structuredClone(verification),
      artifactPath,
      createdAt,
    };
    const surface: TaskConformanceSurface = { ...surfaceBase, surfaceHash: stableHash(surfaceBase) };
    return this.runtime.createTaskConformanceJob(taskId, surface, {
      model: route.model,
      thinking: route.thinking,
      maxTurns: route.maxTurns,
      modelPolicyGeneration: policy.generation,
    });
  }

  private async patchHash(cwd: string, baseline: string, changedFiles: string[]): Promise<string> {
    const head = await git(cwd, ["rev-parse", "HEAD"]);
    if (head.exitCode !== 0 || !head.stdout.trim()) throw new Error("Unable to read HEAD while hashing the Task patch");
    const args = head.stdout.trim() === baseline
      ? ["diff", "--cached", "--binary", "--no-ext-diff", baseline, "--"]
      : ["diff", "--binary", "--no-ext-diff", baseline, head.stdout.trim(), "--"];
    const diff = await git(cwd, args);
    if (diff.exitCode !== 0) throw new Error(output(diff.stdout, diff.stderr) ?? "git diff failed");
    return stableHash({ changedFiles: sorted(changedFiles), patch: diff.stdout });
  }

  private async changedFiles(cwd: string, baseline: string): Promise<string[]> {
    const changed = await git(cwd, ["diff", "--name-only", "-z", baseline, "--"]);
    if (changed.exitCode !== 0) throw new Error(output(changed.stdout, changed.stderr) ?? "git diff failed");
    const untracked = await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
    if (untracked.exitCode !== 0) throw new Error(output(untracked.stdout, untracked.stderr) ?? "git ls-files failed");
    return sorted([...changed.stdout.split("\0"), ...untracked.stdout.split("\0")].filter(Boolean));
  }

  private async failAndMaybeRetry(taskId: string, contract: TaskContract, baseline: string, reason: string, maxAttempts: number) {
    await this.runtime.finishVerification(taskId, false, reason);
    return this.rollbackAndRetry(taskId, contract, baseline, reason, maxAttempts);
  }

  private async rollbackAndRetry(taskId: string, contract: TaskContract, baseline: string, reason: string, maxAttempts: number) {
    const state = await this.runtime.status();
    const manifest = await this.runtime.store.readManifest();
    const tracked = await git(manifest.workspaceRoot, ["ls-tree", "-r", "--name-only", baseline, "--", ...contract.writes]);
    if (tracked.exitCode !== 0) return this.blockAfterVerification(taskId, `Rollback inspection failed: ${reason}`);
    const trackedPaths = tracked.stdout.split("\n").filter(Boolean);
    if (trackedPaths.length > 0) {
      const restored = await git(manifest.workspaceRoot, ["restore", "--source", baseline, "--staged", "--worktree", "--", ...trackedPaths]);
      if (restored.exitCode !== 0) return this.blockAfterVerification(taskId, `Rollback failed: ${reason}`);
    }
    const actual = await this.changedFiles(manifest.workspaceRoot, baseline);
    for (const path of actual.filter((candidate) => contract.writes.includes(candidate) && !trackedPaths.includes(candidate))) {
      const absolute = resolve(manifest.workspaceRoot, path);
      if (!absolute.startsWith(`${resolve(manifest.workspaceRoot)}/`)) return this.blockAfterVerification(taskId, `Unsafe rollback path: ${path}`);
      await rm(absolute, { recursive: true, force: true });
    }
    const task = state.tasks[taskId];
    const activePolicyGeneration = (await this.runtime.activeModelPolicy()).generation;
    const attemptsInActivePolicy = task?.attemptsByModelPolicy?.[String(activePolicyGeneration)]
      ?? ((task?.binding?.modelPolicyGeneration ?? 1) === activePolicyGeneration ? task?.attempt ?? 0 : 0);
    if (attemptsInActivePolicy >= maxAttempts) return { state: await this.runtime.blockTask(taskId, reason), retried: false as const };
    return { state: await this.runtime.retryTask(taskId, reason), retried: true as const };
  }

  private async blockAuditedTask(taskId: string, reason: string): Promise<never> {
    await this.runtime.blockTask(taskId, reason);
    throw new Error(reason);
  }

  private async blockAfterVerification(taskId: string, reason: string) {
    return { state: await this.runtime.blockTask(taskId, reason), retried: false as const };
  }
}
