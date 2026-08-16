import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { TaskConformanceOrchestrator } from "../extensions/forge-workflow/task-conformance-orchestrator.js";
import { TaskExecutionService } from "../src/execution/service.js";
import { RuntimeService } from "../src/runtime/service.js";
import type { TaskContract } from "../src/runtime/types.js";
import { PiSubagentsAdapter, type EventBus } from "../src/subagents/adapter.js";

class FakeBus implements EventBus {
  handlers = new Map<string, Set<(payload: any) => void>>();
  on(event: string, handler: (payload: any) => void) { const set = this.handlers.get(event) ?? new Set(); set.add(handler); this.handlers.set(event, set); return () => set.delete(handler); }
  emit(event: string, payload: any) { for (const handler of this.handlers.get(event) ?? []) handler(payload); }
}

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function context(root: string): ExtensionContext {
  return { cwd: root, modelRegistry: { find(provider: string, id: string) { return provider === "test" && id === "audit" ? { provider, id } : undefined; } } } as unknown as ExtensionContext;
}

describe("TaskConformanceOrchestrator", () => {
  it("spawns exactly one Binding-bound read-only Task Conformance Auditor", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-forge-task-conformance-"));
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
      reads: [{ path: "src/value.ts", symbol: "value", reason: "Frozen edit seam" }],
      implementationBlueprint: [{ id: "BP-01", instruction: "Change value to 2.", expectedEvidence: ["src/value.ts#value diff"] }, { id: "BP-02", instruction: "Preserve the export shape.", expectedEvidence: ["Named export remains"] }],
      expectedPatchShape: ["One literal change"], forbiddenChanges: ["No fallback"], stopConditions: ["Stop if value is absent"], outOfScope: [],
      dependencies: [], conflicts: [], writes: ["src/value.ts"], produces: ["value 2"], consumes: [], acceptance: ["AC-01"],
      verification: [{ command: "grep -q 'value = 2' src/value.ts", timeoutMs: 30_000 }],
    };
    const contract = { ...base, contractHash: RuntimeService.contractHash(base) };
    await runtime.initialize({
      workItemId: "work-item-test", issueId: "I001", issueHash: "hash", workspaceRoot: repositoryRoot, workspaceMode: "shared-serial", taskConformanceRequired: true,
      modelPolicy: { defaultProfile: "simple", profiles: { simple: { model: "test/simple", thinking: "low", maxTurns: 10 }, audit: { model: "test/audit", thinking: "high", maxTurns: 20 } }, roles: { "task-worker": "simple", "task-conformance-auditor": "audit" } },
    }, { generation: 1, tasks: [contract] });
    const state = await runtime.status();
    const workerBinding = RuntimeService.createBinding({ workItemId: "work-item-test", issueId: "I001", taskId: "T001", taskVersion: 1, taskContractPath: "tasks/T001/TASK-V001.md", attempt: 1, workspace: repositoryRoot, baselineCommit: baseline, contractHash: contract.contractHash, model: "test/simple", thinking: "low", maxTurns: 10, startedGeneration: state.generation });
    await runtime.claimTask("T001", workerBinding);
    await runtime.bindAgent("T001", workerBinding.id, "worker-1");
    await runtime.markAgentStarted("worker-1");
    await writeFile(join(repositoryRoot, "src", "value.ts"), "export const value = 2;\n");
    await runtime.submitHandoff(workerBinding.id, { changedFiles: ["src/value.ts"], verification: [], produced: ["value 2"], blueprintEvidence: [{ stepId: "BP-01", evidence: ["value changed"] }, { stepId: "BP-02", evidence: ["export preserved"] }] });
    await runtime.markAgentTerminal("worker-1", "completed");
    const prepared = await new TaskExecutionService(runtimeRoot).finalizeTask("T001");
    expect(prepared.reviewPending).toBe(true);
    expect(git(repositoryRoot, "rev-parse", "HEAD")).toBe(baseline);
    const bus = new FakeBus();
    const spawns: any[] = [];
    bus.on("subagents:rpc:ping", (request) => bus.emit(`subagents:rpc:ping:reply:${request.requestId}`, { success: true, data: { version: 2 } }));
    bus.on("subagents:rpc:spawn", (request) => { spawns.push(request); bus.emit(`subagents:rpc:spawn:reply:${request.requestId}`, { success: true, data: { id: "auditor-1" } }); });
    const started = await new TaskConformanceOrchestrator(new PiSubagentsAdapter(bus, 100)).start(runtimeRoot, "T001", context(repositoryRoot));

    expect(started).toMatchObject({ taskId: "T001", agentId: "auditor-1", status: "started" });
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toMatchObject({ type: "forge-reviewer", options: { cwd: repositoryRoot, description: expect.stringContaining("forge-task-conformance"), model: { provider: "test", id: "audit" } } });
    expect((await runtime.status()).tasks.T001?.conformanceJob?.surface).toMatchObject({ workItemId: "work-item-test", issueId: "I001", taskId: "T001" });
    expect(spawns[0].prompt).toContain("forge_run_task_conformance_submit");
    expect(spawns[0].prompt).toContain("every BP-xx Step");
    expect(spawns[0].prompt).toContain("Proportionality Policy");
    expect(spawns[0].prompt).toContain("Passing with no findings is valid");
    expect((await runtime.status()).tasks.T001).toMatchObject({ status: "reviewing", conformanceJob: { status: "starting", attempt: 1, binding: { agentId: "auditor-1" } } });
  });
});
