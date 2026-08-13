import { spawn } from "node:child_process";
import { realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { RuntimeService } from "../runtime/service.js";
import type { TaskContract } from "../runtime/types.js";

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

  async finalizeTask(taskId: string, maxAttempts = 2): Promise<{ state: Awaited<ReturnType<RuntimeService["status"]>>; commit?: string; retried: boolean }> {
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
    await this.runtime.finishVerification(taskId, true, undefined, verification);

    const add = await git(manifest.workspaceRoot, ["add", "--", ...actual]);
    if (add.exitCode !== 0) return this.blockAfterVerification(taskId, `git add failed: ${output(add.stdout, add.stderr) ?? "unknown error"}`);
    const commitSubject = contract.title.trim().split(/\r?\n/, 1)[0];
    if (!commitSubject) return this.blockAfterVerification(taskId, "Task title cannot produce a Git commit subject");
    const commit = await git(manifest.workspaceRoot, ["commit", "-m", commitSubject], 120_000);
    if (commit.exitCode !== 0) return this.blockAfterVerification(taskId, `git commit failed: ${output(commit.stdout, commit.stderr) ?? "unknown error"}`);
    const head = await git(manifest.workspaceRoot, ["rev-parse", "HEAD"]);
    if (head.exitCode !== 0 || !head.stdout.trim()) return this.blockAfterVerification(taskId, "Unable to read Task commit");
    const next = await this.runtime.completeTask(taskId, head.stdout.trim());
    return { state: next, commit: head.stdout.trim(), retried: false };
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
    return state;
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

  private async blockAfterVerification(taskId: string, reason: string) {
    return { state: await this.runtime.blockTask(taskId, reason), retried: false as const };
  }
}
