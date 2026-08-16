import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { IssueAuditOrchestrator } from "../extensions/forge-workflow/issue-audit-orchestrator.js";
import type { ForgeConfig } from "../src/config/types.js";
import { buildIssueAuditSurface } from "../src/runtime/audit-surfaces.js";
import { RuntimeService } from "../src/runtime/service.js";
import type { IssueAuditAxis, IssueRuntimeState, RuntimeManifest, TaskDag } from "../src/runtime/types.js";
import { PiSubagentsAdapter, type EventBus } from "../src/subagents/adapter.js";

class FakeBus implements EventBus {
  handlers = new Map<string, Set<(payload: any) => void>>();
  on(event: string, handler: (payload: any) => void) { const set = this.handlers.get(event) ?? new Set(); set.add(handler); this.handlers.set(event, set); return () => set.delete(handler); }
  emit(event: string, payload: any) { for (const handler of this.handlers.get(event) ?? []) handler(payload); }
}

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }))));

function git(root: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

function config(preset: ForgeConfig["review"]["preset"] = "standard"): ForgeConfig {
  const audit = { model: "test/audit", thinking: "high" as const, maxTurns: 20 };
  return {
    schemaVersion: 1, generation: 1, artifacts: { root: ".forge", gitPolicy: "ignore" }, tracker: { mode: "local", publishRequiresConfirmation: true },
    workspace: { mode: "shared-serial", isolationBackend: "none", poolSize: 1 },
    models: { profiles: { simple: audit, medium: audit, complex: audit, audit, verifier: { model: "test/verifier", thinking: "high", maxTurns: 20 } }, routing: { "task.simple": "simple", "task.medium": "medium", "task.complex": "complex", prdCoverageReview: "audit", prdEvidenceReview: "audit", prdArchitectureReview: "audit", blockerVerifier: "verifier", issueAudit: "audit" } },
    review: { preset, prd: { coverageReviewers: 1, evidenceReviewers: 1, architectureReviewers: 1 }, blockerVerification: { profile: "verifier", requireDifferentModel: true } },
    commands: {}, agents: { directory: ".pi/agents", templateVersion: 1 },
  };
}

function context(root: string): ExtensionContext {
  return { cwd: root, modelRegistry: { find(provider: string, id: string) { return provider === "test" && id === "audit" ? { provider, id } : undefined; } } } as unknown as ExtensionContext;
}

describe("IssueAuditOrchestrator", () => {
  it("keeps the Standards Surface independent from later Slice Gate evidence", () => {
    const manifest = { workItemId: "WI", issueId: "I001", issueHash: "issue", repositoryRoot: "/repo" } as RuntimeManifest;
    const dag = { generation: 1, tasks: [{ id: "T001", version: 1, title: "Implement value", sliceId: "S001", dependencies: [], conflicts: [], writes: ["src/value.ts"], produces: ["value"], consumes: [], acceptance: ["AC-001"], verification: [{ command: "npm test", timeoutMs: 60_000 }], contractHash: "contract" }] } as TaskDag;
    const state = {
      tasks: { T001: { receipt: { schemaVersion: 1, workItemId: "WI", issueId: "I001", taskId: "T001", taskVersion: 1, taskContractPath: "tasks/T001/TASK-V001.md", contractHash: "contract", dagGeneration: 1, commit: "commit", changedFiles: ["src/value.ts"], produced: ["value"], verification: [{ command: "npm test", exitCode: 0 }], completedAt: "now" } } },
      sliceGates: { S001: { id: "S001", status: "passed", commands: [{ command: "npm test", timeoutMs: 60_000, proves: "AC-001" }], verification: [{ command: "npm test", exitCode: 0, keyOutput: "one" }] } },
    } as unknown as IssueRuntimeState;
    const before = buildIssueAuditSurface({ manifest, dag, state, axis: "standards", auditGeneration: 1, taskIds: ["T001"] });
    const afterState = structuredClone(state);
    afterState.sliceGates!.S001!.verification = [{ command: "npm test", exitCode: 0, keyOutput: "two" }];
    const after = buildIssueAuditSurface({ manifest, dag, state: afterState, axis: "standards", auditGeneration: 2, taskIds: ["T001"] });
    expect(after.surfaceHash).toBe(before.surfaceHash);
    expect(buildIssueAuditSurface({ manifest, dag, state: afterState, axis: "acceptance_integration", auditGeneration: 2, taskIds: ["T001"] }).surfaceHash)
      .not.toBe(buildIssueAuditSurface({ manifest, dag, state, axis: "acceptance_integration", auditGeneration: 1, taskIds: ["T001"] }).surfaceHash);
    const acceptanceSurface = buildIssueAuditSurface({ manifest, dag, state, axis: "acceptance_integration", auditGeneration: 1, taskIds: ["T001"], acceptanceEvidence: [{ id: "AC-001", statement: "The value is observable", verification: ["npm test"] }] });
    expect((acceptanceSurface.evidence as { issueAcceptance: unknown[] }).issueAcceptance).toEqual([{ id: "AC-001", statement: "The value is observable", verification: ["npm test"] }]);
  });

  it("completes Fast Assurance mechanically without pinging or spawning final Auditors", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-forge-fast-completion-"));
    roots.push(repositoryRoot);
    await writeFile(join(repositoryRoot, "README.md"), "fixture\n");
    await writeFile(join(repositoryRoot, ".gitignore"), "/.forge/\n");
    git(repositoryRoot, "init", "-q");
    git(repositoryRoot, "config", "user.email", "forge@example.com");
    git(repositoryRoot, "config", "user.name", "Forge Test");
    git(repositoryRoot, "add", ".");
    git(repositoryRoot, "commit", "-qm", "baseline");
    const runtimeRoot = join(repositoryRoot, ".forge", "issues", "I001", "runtime");
    const runtime = new RuntimeService(runtimeRoot);
    await runtime.initialize({
      workItemId: "work-item-test",
      issueId: "I001",
      issueHash: "hash",
      workspaceRoot: repositoryRoot,
      workspaceMode: "shared-serial",
      assuranceProfile: "fast",
      modelPolicy: { defaultProfile: "audit", profiles: { audit: { model: "test/audit", thinking: "high", maxTurns: 20 } }, roles: { "task-worker": "audit" } },
    }, { generation: 1, tasks: [] }, [{ id: "S001", gate: [] }]);
    await runtime.store.transact("test_fast_ready_for_completion", (state) => {
      state.sliceGates!.S001!.status = "passed";
      state.issueStatus = "auditing";
    });

    const bus = new FakeBus();
    let rpcCalls = 0;
    bus.on("subagents:rpc:ping", () => { rpcCalls += 1; });
    bus.on("subagents:rpc:spawn", () => { rpcCalls += 1; });
    const started = await new IssueAuditOrchestrator(new PiSubagentsAdapter(bus, 100)).start(runtimeRoot, context(repositoryRoot));

    expect(started).toEqual([]);
    expect(rpcCalls).toBe(0);
    expect((await runtime.status()).issueStatus).toBe("completed");
  });

  it("automatically spawns three independent final Audit Bindings and completes on three passes", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-forge-issue-audit-"));
    roots.push(repositoryRoot);
    await writeFile(join(repositoryRoot, "README.md"), "fixture\n");
    await writeFile(join(repositoryRoot, ".gitignore"), "/.pi/\n/.forge/\n");
    git(repositoryRoot, "init", "-q");
    git(repositoryRoot, "config", "user.email", "forge@example.com");
    git(repositoryRoot, "config", "user.name", "Forge Test");
    git(repositoryRoot, "add", ".");
    git(repositoryRoot, "commit", "-qm", "baseline");
    await mkdir(join(repositoryRoot, ".pi"), { recursive: true });
    await writeFile(join(repositoryRoot, ".pi", "forge.json"), JSON.stringify(config()));
    const runtimeRoot = join(repositoryRoot, ".forge", "issues", "I001", "runtime");
    const runtime = new RuntimeService(runtimeRoot);
    await runtime.initialize({ workItemId: "work-item-test", issueId: "I001", issueHash: "hash", workspaceRoot: repositoryRoot, workspaceMode: "shared-serial", modelPolicy: { defaultProfile: "audit", profiles: { audit: { model: "test/audit", thinking: "high", maxTurns: 20 } }, roles: { "task-worker": "audit" } } }, { generation: 1, tasks: [] }, [{ id: "S001", gate: [] }]);
    await runtime.store.transact("test_ready_for_audit", (state) => { state.issueStatus = "auditing"; state.sliceGates!.S001!.status = "passed"; });

    const bus = new FakeBus();
    const spawns: any[] = [];
    bus.on("subagents:rpc:ping", (request) => bus.emit(`subagents:rpc:ping:reply:${request.requestId}`, { success: true, data: { version: 2 } }));
    bus.on("subagents:rpc:spawn", (request) => { spawns.push(request); bus.emit(`subagents:rpc:spawn:reply:${request.requestId}`, { success: true, data: { id: `agent-${spawns.length}` } }); });
    const orchestrator = new IssueAuditOrchestrator(new PiSubagentsAdapter(bus, 100));
    const started = await orchestrator.start(runtimeRoot, context(repositoryRoot));
    expect(started).toHaveLength(3);
    expect(spawns.every((spawn) => spawn.type === "forge-reviewer" && spawn.options.model.id === "audit")).toBe(true);
    expect(new Set(spawns.map((spawn) => spawn.options.description)).size).toBe(3);
    expect(spawns.every((spawn) => spawn.prompt.includes("Proportionality Policy"))).toBe(true);
    expect(spawns.every((spawn) => spawn.prompt.includes("Passing with no findings is valid"))).toBe(true);
    expect(spawns.every((spawn) => spawn.prompt.includes("Compact Axis Surface:"))).toBe(true);
    expect(spawns.every((spawn) => spawn.prompt.includes("Axis Surface Hash:"))).toBe(true);
    await expect(readFile(join(runtimeRoot, "audits", "issue-audit-plan-1.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    let state = await runtime.status();
    const stale = state.auditJobs!.standards;
    await expect(runtime.submitAudit(stale.binding!.id, "standards", "passed", [], "stale-surface")).rejects.toThrow("stale Issue Audit Surface Hash");
    const surfacePath = join(runtimeRoot, stale.surface!.artifactPath);
    const originalSurface = await readFile(surfacePath, "utf8");
    const tamperedSurface = JSON.parse(originalSurface);
    tamperedSurface.evidence = { tampered: true };
    await writeFile(surfacePath, JSON.stringify(tamperedSurface));
    await expect(runtime.submitAudit(stale.binding!.id, "standards", "passed", [], stale.surface!.surfaceHash)).rejects.toThrow("Surface artifact is missing or does not match");
    await writeFile(surfacePath, originalSurface);
    for (const axis of ["standards", "acceptance_integration", "architecture_minimality"] as IssueAuditAxis[]) {
      const job = state.auditJobs![axis];
      const findings = axis === "standards" ? [{ id: "STD-CONTEXT-1", severity: "note" as const, message: "Recorded standard context", evidence: [], violatedRule: "No violation", verification: "No action" }] : [];
      state = await runtime.submitAudit(job.binding!.id, axis, "passed", findings, job.surface!.surfaceHash);
      if (axis === "standards") {
        const repeated = await runtime.submitAudit(job.binding!.id, axis, "passed", findings, job.surface!.surfaceHash);
        expect(repeated.generation).toBe(state.generation);
        await expect(runtime.submitAudit(job.binding!.id, axis, "blocked", [{ id: "STD-1", severity: "blocker", message: "Different result", evidence: ["README.md:1"], violatedRule: "Repository rule", verification: "Read README", suggestedResolution: "Change only the violating line" }], job.surface!.surfaceHash)).rejects.toThrow("different Audit result");
        const acceptanceJob = state.auditJobs!.acceptance_integration;
        await expect(runtime.submitAudit(acceptanceJob.binding!.id, "acceptance_integration", "passed", [{ id: "STD-CONTEXT-1", severity: "note", message: "Wrong Axis prefix", evidence: [], violatedRule: "No violation", verification: "No action" }], acceptanceJob.surface!.surfaceHash)).rejects.toThrow("wrongly prefixed");
      }
    }
    expect(state.issueStatus).toBe("completed");
  });

  it("records RPC timeouts as bounded infrastructure retries and resumes with fresh Bindings", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-forge-issue-audit-infrastructure-"));
    roots.push(repositoryRoot);
    await mkdir(join(repositoryRoot, ".pi"), { recursive: true });
    await writeFile(join(repositoryRoot, ".pi", "forge.json"), JSON.stringify(config()));
    const runtimeRoot = join(repositoryRoot, ".forge", "issues", "I001", "runtime");
    const runtime = new RuntimeService(runtimeRoot);
    await runtime.initialize({ workItemId: "work-item-test", issueId: "I001", issueHash: "hash", workspaceRoot: repositoryRoot, workspaceMode: "shared-serial", modelPolicy: { defaultProfile: "audit", profiles: { audit: { model: "test/audit", thinking: "high", maxTurns: 20 } }, roles: { "task-worker": "audit" } } }, { generation: 1, tasks: [] }, [{ id: "S001", gate: [] }]);
    await runtime.store.transact("test_ready_for_audit", (state) => { state.issueStatus = "auditing"; state.sliceGates!.S001!.status = "passed"; });

    const bus = new FakeBus();
    const adapter = new PiSubagentsAdapter(bus, 20);
    const orchestrator = new IssueAuditOrchestrator(adapter);
    const timedOut = await orchestrator.start(runtimeRoot, context(repositoryRoot));
    expect(timedOut.every((result) => result.status === "retry_ready")).toBe(true);
    let state = await runtime.status();
    expect(Object.values(state.auditJobs!).every((job) => job.infrastructureAttempts === 1 && job.lastFailure?.kind === "rpc_timeout")).toBe(true);
    expect(state.issueStatus).toBe("auditing");

    let spawnCount = 0;
    bus.on("subagents:rpc:ping", (request) => bus.emit(`subagents:rpc:ping:reply:${request.requestId}`, { success: true, data: { version: 2 } }));
    bus.on("subagents:rpc:spawn", (request) => bus.emit(`subagents:rpc:spawn:reply:${request.requestId}`, { success: true, data: { id: `agent-${++spawnCount}` } }));
    const resumed = await orchestrator.start(runtimeRoot, context(repositoryRoot));
    expect(resumed.every((result) => result.status === "started")).toBe(true);
    state = await runtime.status();
    expect(Object.values(state.auditJobs!).every((job) => job.attempt === 2 && job.infrastructureAttempts === 1 && job.binding?.agentId)).toBe(true);
  });

  it("carries unchanged passed axes when rejected Blockers require only one fresh axis review", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-forge-issue-audit-carry-"));
    roots.push(repositoryRoot);
    await mkdir(join(repositoryRoot, "src"), { recursive: true });
    await writeFile(join(repositoryRoot, "src", "value.ts"), "export const value = 1;\n");
    const runtimeRoot = join(repositoryRoot, ".forge", "issues", "I001", "runtime");
    const runtime = new RuntimeService(runtimeRoot);
    await runtime.initialize({ workItemId: "work-item-test", issueId: "I001", issueHash: "hash", workspaceRoot: repositoryRoot, workspaceMode: "shared-serial", taskConformanceRequired: true, modelPolicy: { defaultProfile: "audit", profiles: { audit: { model: "test/audit", thinking: "high", maxTurns: 20 } }, roles: { "task-worker": "audit" } } }, { generation: 1, tasks: [] }, [{ id: "S001", gate: [] }]);
    await runtime.store.transact("test_ready_for_audit", (state) => { state.issueStatus = "auditing"; state.sliceGates!.S001!.status = "passed"; });
    const route = { model: "test/audit", thinking: "high" as const, maxTurns: 20, configHash: "config" };
    let created = await runtime.createAuditJobs({ standards: route, acceptance_integration: route, architecture_minimality: route });
    expect(created.auditJobs?.standards.surface).not.toHaveProperty("evidence");
    const standardsArtifact = JSON.parse(await readFile(join(runtimeRoot, created.auditJobs!.standards.surface!.artifactPath), "utf8"));
    expect(standardsArtifact).toHaveProperty("evidence");

    async function submit(axis: IssueAuditAxis, verdict: "passed" | "blocked", findings: Parameters<RuntimeService["submitAudit"]>[3]) {
      const before = await runtime.status();
      const job = before.auditJobs![axis];
      const binding = RuntimeService.createAuditBinding({ axis, surfaceHash: job.surface!.surfaceHash, attempt: job.attempt + 1, model: job.model, thinking: job.thinking, maxTurns: job.maxTurns, startedGeneration: before.generation });
      await runtime.claimAuditJob(axis, binding);
      return runtime.submitAudit(binding.id, axis, verdict, findings, job.surface!.surfaceHash);
    }

    await submit("standards", "passed", []);
    await submit("acceptance_integration", "passed", []);
    let state = await submit("architecture_minimality", "blocked", [{ id: "ARCH-1", severity: "blocker", message: "Suspected unnecessary abstraction", evidence: ["src/value.ts#value"], violatedRule: "Use the approved seam", verification: "Read the final diff", suggestedResolution: "Remove only if present" }]);
    state = await runtime.createAuditBlockerVerifierJob({ model: "test/verifier", thinking: "high", maxTurns: 20, configHash: "config" });
    const verifierJob = state.auditBlockerVerifierJob!;
    const verifier = RuntimeService.createAuditBlockerVerifierBinding({ attempt: 1, findingHash: verifierJob.findingHash, model: verifierJob.model, thinking: verifierJob.thinking, maxTurns: verifierJob.maxTurns, startedGeneration: state.generation });
    await runtime.claimAuditBlockerVerifier(verifier);
    state = await runtime.submitAuditBlockerVerification(verifier.id, [{ findingId: "ARCH-1", status: "rejected", evidence: ["The abstraction is absent"], rationale: "The reported path does not contain the claimed abstraction", missingEvidence: [] }]);
    expect(state.auditInvalidatedAxes).toEqual(["architecture_minimality"]);

    state = await runtime.createAuditJobs({ standards: route, acceptance_integration: route, architecture_minimality: route });
    expect(state.auditJobs?.standards.status).toBe("completed");
    expect(state.auditJobs?.acceptance_integration.status).toBe("completed");
    expect(state.auditJobs?.architecture_minimality.status).toBe("pending");
    expect(state.audits?.standards?.carriedFrom?.auditGeneration).toBe(1);
    expect(state.audits?.acceptance_integration?.carriedFrom?.auditGeneration).toBe(1);

    state = await submit("architecture_minimality", "blocked", [{ id: "ARCH-2", severity: "blocker", message: "Second suspected abstraction", evidence: ["src/value.ts#value"], violatedRule: "Use the approved seam", verification: "Read the final diff", suggestedResolution: "Remove only if present" }]);
    state = await runtime.createAuditBlockerVerifierJob({ model: "test/verifier", thinking: "high", maxTurns: 20, configHash: "config" });
    const secondJob = state.auditBlockerVerifierJob!;
    const secondVerifier = RuntimeService.createAuditBlockerVerifierBinding({ attempt: 1, findingHash: secondJob.findingHash, model: secondJob.model, thinking: secondJob.thinking, maxTurns: secondJob.maxTurns, startedGeneration: state.generation });
    await runtime.claimAuditBlockerVerifier(secondVerifier);
    await runtime.submitAuditBlockerVerification(secondVerifier.id, [{ findingId: "ARCH-2", status: "rejected", evidence: ["The second abstraction is absent"], rationale: "The second report is contradicted by the file", missingEvidence: [] }]);
    state = await runtime.createAuditJobs({ standards: route, acceptance_integration: route, architecture_minimality: route });
    expect(state.audits?.standards?.carriedFrom?.auditGeneration).toBe(1);
    expect(state.audits?.acceptance_integration?.carriedFrom?.auditGeneration).toBe(1);
    expect(state.auditJobs?.architecture_minimality.status).toBe("pending");
  });
});
