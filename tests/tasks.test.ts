import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { ForgeConfig } from "../src/config/types.js";
import { TaskPreflightOrchestrator } from "../extensions/forge-workflow/task-preflight-orchestrator.js";
import { IssuesService } from "../src/issues/service.js";
import { RuntimeService } from "../src/runtime/service.js";
import { stableHash } from "../src/runtime/hash.js";
import { PiSubagentsAdapter, type EventBus } from "../src/subagents/adapter.js";
import { TaskPreflightService } from "../src/tasks/preflight-service.js";
import { buildTaskPreflightPrompt } from "../src/tasks/preflight-prompt.js";
import type { IssueDraft } from "../src/issues/types.js";
import { TasksService } from "../src/tasks/service.js";
import type { MicroTaskDraft, SliceDraft } from "../src/tasks/types.js";
import { WorkItemService } from "../src/work-item/service.js";
import type { ForgePrd, ReviewAxis } from "../src/work-item/types.js";

const roots: string[] = [];
const revision = "abc123";

class FakeBus implements EventBus {
  handlers = new Map<string, Set<(payload: any) => void>>();
  on(event: string, handler: (payload: any) => void) { const set = this.handlers.get(event) ?? new Set(); set.add(handler); this.handlers.set(event, set); return () => set.delete(handler); }
  emit(event: string, payload: any) { for (const handler of this.handlers.get(event) ?? []) handler(payload); }
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function config(): ForgeConfig {
  const medium = { model: "test/medium", thinking: "high" as const, maxTurns: 20 };
  return {
    schemaVersion: 1,
    generation: 1,
    artifacts: { root: ".forge", gitPolicy: "ignore" },
    tracker: { mode: "local", publishRequiresConfirmation: true },
    workspace: { mode: "shared-serial", isolationBackend: "none", poolSize: 1 },
    models: {
      profiles: { simple: { model: "test/simple", thinking: "low", maxTurns: 12 }, medium, complex: medium, audit: { model: "test/audit", thinking: "high", maxTurns: 20 }, verifier: { model: "test/verifier", thinking: "high", maxTurns: 20 } },
      routing: { "task.simple": "simple", "task.medium": "medium", "task.complex": "complex", prdCoverageReview: "audit", prdEvidenceReview: "audit", prdArchitectureReview: "audit", blockerVerifier: "verifier", taskPreflight: "audit", remediationPlanner: "complex", issueAudit: "audit" },
    },
    review: { preset: "standard", prd: { coverageReviewers: 1, evidenceReviewers: 1, architectureReviewers: 1 }, blockerVerification: { profile: "verifier", requireDifferentModel: true } },
    commands: { test: "npm test", typecheck: "npm run typecheck" },
    agents: { directory: ".pi/agents", templateVersion: 1 },
  };
}

function context(root: string): ExtensionContext {
  return { cwd: root, modelRegistry: { find(provider: string, id: string) { return provider === "test" && id === "audit" ? { provider, id } : undefined; } } } as unknown as ExtensionContext;
}

function prd(): ForgePrd {
  return {
    title: "Config label",
    problem: "Config cannot be identified.",
    solution: "Add a label.",
    goals: ["Expose label"],
    nonGoals: ["Change retries"],
    actors: ["consumer"],
    userStories: [{ id: "US-01", actor: "consumer", capability: "read label", benefit: "identify config" }],
    acceptance: [{ id: "AC-01", statement: "createConfig returns label default", verification: ["createConfig unit test"] }],
    behavior: { happyPath: ["Create config", "Read label"], errorPaths: ["No new runtime error"], edgeCases: ["Retries remains unchanged"] },
    decisions: [{ id: "D-01", decision: "Extend AppConfig", rationale: "Existing seam", evidenceIds: ["E-01"] }],
    impactEvidence: [{ id: "E-01", path: "src/config.ts", symbol: "AppConfig", claim: "Configuration seam", repositoryRevision: revision }],
    testSeams: [{ name: "createConfig unit", level: "unit", evidenceIds: ["E-01"], verification: "Assert retries and label" }],
    risks: [{ risk: "Direct literals", mitigation: "Compiler" }],
    deliveryBoundaries: [{ id: "DB-01", title: "Deliver config label", outcome: "createConfig returns label default.", goal: "Expose a label.", scope: ["Extend AppConfig"], acceptanceIds: ["AC-01"], behavior: { happyPath: ["Create config", "Read label"], errorPaths: ["No new runtime error"], edgeCases: ["Retries remains unchanged"] }, decisionIds: ["D-01"], impactEvidenceIds: ["E-01"], testSeamNames: ["createConfig unit"], nonGoals: ["Change retries"], verification: ["createConfig unit test", "Assert retries and label"], dependencies: [], independentlyDeliverable: true, rationale: "One small delivery outcome." }],
    rollback: "Revert field and test.",
    diagrams: [],
    openQuestions: [],
  };
}

async function fixture() {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-forge-tasks-"));
  roots.push(repositoryRoot);
  await mkdir(join(repositoryRoot, ".pi"), { recursive: true });
  await writeFile(join(repositoryRoot, ".pi", "forge.json"), JSON.stringify(config()));
  const workItemRoot = join(repositoryRoot, ".forge", "work-items", "label");
  const workItem = new WorkItemService(workItemRoot);
  await workItem.initialize({ workItemId: "label", title: "Config label", repositoryRoot, repositoryRevision: revision });
  const document = prd();
  await workItem.checkpoint({ decisions: [{ id: "Q1", question: "Value?", dependsOn: [], status: "answered", answer: "default", answerSource: "user" }], evidence: document.impactEvidence, summary: "Settled." });
  const submitted = await workItem.submitPrd(document);
  for (const axis of ["coverage", "evidence", "architecture"] as ReviewAxis[]) await workItem.submitReview({ axis, verdict: "passed", surfaceHash: submitted.currentPrd!.reviewSurfaceHashes[axis], reviewerId: axis, findings: [] });
  await workItem.approve({ approvedBy: "user", evidence: "approved" });
  await workItem.freeze();
  const issue: IssueDraft = {
    id: "I001", deliveryBoundaryId: "DB-01", title: "Add config label", goal: "Expose a label.", deliveryOutcome: "createConfig returns label default.",
    scope: ["Extend AppConfig"], nonGoals: ["Change retries"], acceptanceIds: ["AC-01"],
    behavior: prd().behavior, decisionIds: ["D-01"], impactEvidenceIds: ["E-01"], testSeamNames: ["createConfig unit"],
    verification: ["createConfig unit test", "Assert retries and label"], dependencies: [],
  };
  await new IssuesService(workItemRoot).submit([issue]);
  return { repositoryRoot, workItemRoot, tasks: new TasksService(workItemRoot) };
}

function plan(): { slices: SliceDraft[]; tasks: MicroTaskDraft[] } {
  return {
    slices: [{ id: "S001", title: "Config label behavior", goal: "Deliver the observable label behavior.", acceptanceIds: ["AC-01"], taskIds: ["T001"], gate: [{ command: "npm test", timeoutMs: 120_000, proves: "The Issue acceptance passes through the public config seam" }] }],
    tasks: [{
      id: "T001", title: "Add label to AppConfig", sliceId: "S001", goal: "Expose label default from createConfig.",
      editPoint: { path: "src/config.ts", symbol: "AppConfig" },
      reads: [{ path: "src/config.ts", symbol: "AppConfig", reason: "Defines the interface and createConfig literal" }],
      writes: ["src/config.ts"], dependencies: [], conflicts: [], produces: ["AppConfig.label behavior"], consumes: [], acceptanceIds: ["AC-01"],
      implementationBlueprint: ["Add a readonly label string field to AppConfig without changing retries.", "Set label to default in createConfig and add the focused unit assertion at the existing test seam."],
      outOfScope: ["Changing retries", "Adding CLI configuration"], verification: [{ command: "npm test", timeoutMs: 120_000 }], modelProfile: "simple",
    }],
  };
}

describe("TasksService", () => {
  it("builds Preflight around data flow, ownership, default-deny Fallback, and shallow-module avoidance", async () => {
    const { workItemRoot } = await fixture();
    const input = plan();
    const proposal = {
      schemaVersion: 1 as const,
      generation: 1,
      issueId: "I001",
      kind: "initial" as const,
      proposalHash: "proposal",
      surfaceHash: "surface",
      source: { workItemId: "label", prdHash: "prd", issuesHash: "issues", issueHash: "issue", repositoryRoot: workItemRoot, repositoryRevision: revision },
      slices: input.slices,
      tasks: input.tasks,
      createdAt: new Date().toISOString(),
    };
    const prompt = buildTaskPreflightPrompt({ workItemRoot, proposal, bindingId: "binding-1" });
    expect(prompt).toContain("value flow");
    expect(prompt).toContain("Fallback is default-deny");
    expect(prompt).toContain("app/composition-root file");
    expect(prompt).toContain("pass-through file fragmentation");
  });

  it("freezes self-contained Task packages and initializes a shared-serial Runtime", async () => {
    const { workItemRoot, tasks } = await fixture();
    const input = plan();
    const result = await tasks.submit("I001", input.slices, input.tasks);
    expect(result.idempotent).toBe(false);
    expect(result.runtime.issueId).toBe("I001");
    expect(result.runtime.tasks.T001?.status).toBe("ready");
    expect(result.manifest.runtimeRoot).toBe(join(workItemRoot, "issues", "I001", "runtime"));
    const taskRoot = join(workItemRoot, "issues", "I001", "tasks", "T001");
    const taskMarkdown = await readFile(join(taskRoot, "TASK-V001.md"), "utf8");
    expect(taskMarkdown).toContain("T001@V001");
    expect(taskMarkdown).toContain("src/config.ts#AppConfig");
    expect(taskMarkdown).toContain("Implementation Blueprint");
    expect(taskMarkdown).toContain("## Minimal Implementation Policy");
    expect(taskMarkdown).toContain("Fallback is default-deny");
    expect(taskMarkdown).toContain("Keep composition roots and app entry modules thin");
    expect(JSON.parse(await readFile(join(result.manifest.runtimeRoot, "dag.json"), "utf8")).tasks[0].contractHash).not.toBe("pending");
  });

  it("normalizes legacy Issue repository identity only when Tasks read the Artifact", async () => {
    const { workItemRoot, tasks } = await fixture();
    const issuePath = join(workItemRoot, "issues", "I001", "issue.json");
    const issue = JSON.parse(await readFile(issuePath, "utf8"));
    delete issue.source.controlRoot;
    delete issue.source.repositoryRoot;
    delete issue.source.repositoryRevision;
    const { artifactHash: _hash, ...base } = issue;
    issue.artifactHash = stableHash(base);
    await writeFile(issuePath, JSON.stringify(issue, null, 2));
    const manifestPath = join(workItemRoot, "issues", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.issues[0].artifactHash = issue.artifactHash;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    const prepared = await tasks.prepare("I001", plan().slices, plan().tasks);
    expect(prepared.issue.source.controlRoot).toBe((await new WorkItemService(workItemRoot).store.readManifest()).controlRoot);
  });

  it("requires a Binding-bound Task Preflight pass before the public orchestration freezes a Plan", async () => {
    const { repositoryRoot, workItemRoot, tasks } = await fixture();
    const bus = new FakeBus();
    const spawns: any[] = [];
    bus.on("subagents:rpc:ping", (request) => bus.emit(`subagents:rpc:ping:reply:${request.requestId}`, { success: true, data: { version: 2 } }));
    bus.on("subagents:rpc:spawn", (request) => { spawns.push(request); bus.emit(`subagents:rpc:spawn:reply:${request.requestId}`, { success: true, data: { id: `agent-${spawns.length}` } }); });
    const orchestrator = new TaskPreflightOrchestrator(new PiSubagentsAdapter(bus, 100));
    const input = plan();
    const started = await orchestrator.propose({ workItemRoot, issueId: "I001", slices: input.slices, tasks: input.tasks, ctx: context(repositoryRoot) });
    expect(started.status).toBe("started");
    expect(spawns[0].type).toBe("forge-reviewer");
    expect(spawns[0].options.description).toContain("forge-task-preflight:");
    expect((await tasks.status("I001")).manifest).toBeUndefined();

    const preflight = await new TaskPreflightService(workItemRoot, "I001").status();
    const result = await orchestrator.submitResult({
      workItemRoot,
      issueId: "I001",
      bindingId: preflight!.job.binding!.id,
      proposalHash: preflight!.proposalHash,
      verdict: "passed",
      findings: [],
    });
    expect(result.status).toBe("frozen");
    const frozenStatus = await tasks.status("I001");
    expect(frozenStatus.runtime?.tasks.T001?.status).toBe("ready");
    expect(frozenStatus.manifest?.preflight?.bindingId).toBe(preflight!.job.binding!.id);
    expect((await new TaskPreflightService(workItemRoot, "I001").status())?.frozenTaskPlanHash).toBe(result.taskPlanHash);
    const repeated = await orchestrator.submitResult({ workItemRoot, issueId: "I001", bindingId: preflight!.job.binding!.id, proposalHash: preflight!.proposalHash, verdict: "passed", findings: [] });
    expect(repeated.idempotent).toBe(true);
  });

  it("keeps blocked Preflight evidence immutable and requires a changed Proposal Generation", async () => {
    const { repositoryRoot, workItemRoot, tasks } = await fixture();
    const bus = new FakeBus();
    let spawnCount = 0;
    bus.on("subagents:rpc:ping", (request) => bus.emit(`subagents:rpc:ping:reply:${request.requestId}`, { success: true, data: { version: 2 } }));
    bus.on("subagents:rpc:spawn", (request) => bus.emit(`subagents:rpc:spawn:reply:${request.requestId}`, { success: true, data: { id: `agent-${++spawnCount}` } }));
    const orchestrator = new TaskPreflightOrchestrator(new PiSubagentsAdapter(bus, 100));
    const input = plan();
    await orchestrator.propose({ workItemRoot, issueId: "I001", slices: input.slices, tasks: input.tasks, ctx: context(repositoryRoot) });
    const first = await new TaskPreflightService(workItemRoot, "I001").status();
    await orchestrator.submitResult({
      workItemRoot,
      issueId: "I001",
      bindingId: first!.job.binding!.id,
      proposalHash: first!.proposalHash,
      verdict: "blocked",
      findings: [{ id: "PF-1", severity: "blocker", taskId: "T001", message: "Blueprint leaves the edit location to search", evidence: ["T001 implementationBlueprint"], violatedRule: "Worker must not investigate", verification: "Name the exact insertion point", suggestedResolution: "Split the assertion into a later Task and name the AppConfig member insertion point" }],
    });
    expect((await tasks.status("I001")).manifest).toBeUndefined();
    const same = await orchestrator.propose({ workItemRoot, issueId: "I001", slices: input.slices, tasks: input.tasks, ctx: context(repositoryRoot) });
    expect(same.status).toBe("blocked");

    const revised = plan();
    revised.tasks[0] = { ...revised.tasks[0]!, implementationBlueprint: [...revised.tasks[0]!.implementationBlueprint, "Insert label immediately after retries in AppConfig and preserve the existing factory field order."] };
    const next = await orchestrator.propose({ workItemRoot, issueId: "I001", slices: revised.slices, tasks: revised.tasks, ctx: context(repositoryRoot) });
    expect(next.status).toBe("started");
    expect(next.proposalGeneration).toBe(2);
  });

  it("allows a new Remediation Preflight generation after the previous pass was applied", async () => {
    const { workItemRoot } = await fixture();
    const service = new TaskPreflightService(workItemRoot, "I001", "remediation");
    const route = { profile: "audit", model: "test/audit", thinking: "high" as const, maxTurns: 20, configGeneration: 1, configHash: "config" };
    const base = plan();
    const proposal = (generation: number, proposalHash: string) => ({
      schemaVersion: 1 as const, generation, issueId: "I001", kind: "remediation" as const, runtimeRoot: join(workItemRoot, "issues", "I001", "runtime"), sourceFindingHash: `finding-${generation}`,
      proposalHash, surfaceHash: `surface-${generation}`,
      source: { workItemId: "label", prdHash: "prd", issuesHash: "issues", issueHash: "issue", repositoryRoot: workItemRoot, repositoryRevision: revision },
      slices: base.slices, tasks: base.tasks, createdAt: new Date().toISOString(),
    });
    await service.proposeRaw(proposal(1, "proposal-1"), route);
    let state = await service.status();
    let binding = TaskPreflightService.createBinding({ proposalGeneration: 1, proposalHash: "proposal-1", surfaceHash: "surface-1", attempt: 1, profile: "audit", model: "test/audit", thinking: "high", maxTurns: 20, startedStateGeneration: state!.generation });
    await service.claim(binding);
    await service.submitResult({ bindingId: binding.id, proposalHash: "proposal-1", verdict: "passed", findings: [] });
    await service.markApplied(2);
    const next = await service.proposeRaw(proposal(2, "proposal-2"), route);
    expect(next.state.activeProposalGeneration).toBe(2);
    expect(next.state.status).toBe("pending");
  });

  it("is idempotent and rejects an in-place Task Plan rewrite", async () => {
    const { tasks } = await fixture();
    const input = plan();
    const first = await tasks.submit("I001", input.slices, input.tasks);
    const second = await tasks.submit("I001", input.slices, input.tasks);
    expect(second.idempotent).toBe(true);
    expect(second.manifest.contentHash).toBe(first.manifest.contentHash);
    const changed = plan();
    changed.tasks[0] = { ...changed.tasks[0]!, goal: "Different goal" };
    await expect(tasks.submit("I001", changed.slices, changed.tasks)).rejects.toThrow("DAG Amendment");
  });

  it("treats Forge Config changes as execution policy updates, not Task Plan rewrites", async () => {
    const { repositoryRoot, tasks } = await fixture();
    const input = plan();
    const first = await tasks.submit("I001", input.slices, input.tasks);
    const nextConfig = config();
    nextConfig.generation = 2;
    nextConfig.models.profiles.simple = { ...nextConfig.models.profiles.simple!, maxTurns: 30 };
    await writeFile(join(repositoryRoot, ".pi", "forge.json"), JSON.stringify(nextConfig));

    const second = await tasks.submit("I001", input.slices, input.tasks);
    expect(second.idempotent).toBe(true);
    expect(second.manifest.contentHash).toBe(first.manifest.contentHash);
    const rebound = await tasks.rebindModels("I001", "Adopt Config Generation 2 max-turn policy");
    expect(rebound.configGeneration).toBe(2);
    expect(rebound.modelPolicyGeneration).toBe(2);
    expect((await new RuntimeService(first.manifest.runtimeRoot).activeModelPolicy()).policy.profiles.simple?.maxTurns).toBe(30);
  });

  it("validates artifact-backed dependencies and unlock ordering", async () => {
    const { tasks } = await fixture();
    const input = plan();
    input.slices[0] = { ...input.slices[0]!, taskIds: ["T001", "T002"] };
    input.tasks[0] = { ...input.tasks[0]!, produces: ["AppConfig label contract"] };
    input.tasks.push({
      id: "T002", title: "Verify label behavior", sliceId: "S001", goal: "Prove the new field at the frozen test seam.",
      editPoint: { path: "src/config.test.ts", symbol: "createConfig label test" },
      reads: [{ path: "src/config.ts", symbol: "createConfig", reason: "Consumes the implemented return behavior" }, { path: "src/config.test.ts", symbol: "createConfig tests", reason: "Existing test location" }],
      writes: ["src/config.test.ts"], dependencies: ["T001"], conflicts: [], produces: ["AC-01 verification"], consumes: ["T001::AppConfig label contract"], acceptanceIds: ["AC-01"],
      implementationBlueprint: ["Add a focused assertion for label default in the existing createConfig test.", "Keep the retries assertion to prove the edge behavior is unchanged."],
      outOfScope: ["Adding a second test framework"], verification: [{ command: "npm test", timeoutMs: 120_000 }], modelProfile: "simple",
    });
    const result = await tasks.submit("I001", input.slices, input.tasks);
    expect(result.runtime.tasks.T001?.status).toBe("ready");
    expect(result.runtime.tasks.T002?.status).toBe("pending");
  });

  it("rejects non-self-contained Tasks and unproven dependencies", async () => {
    const { tasks } = await fixture();
    const tooBroad = plan();
    tooBroad.tasks[0] = { ...tooBroad.tasks[0]!, reads: [...tooBroad.tasks[0]!.reads, { path: "a.ts", symbol: "a", reason: "a" }, { path: "b.ts", symbol: "b", reason: "b" }, { path: "c.ts", symbol: "c", reason: "c" }] };
    await expect(tasks.submit("I001", tooBroad.slices, tooBroad.tasks)).rejects.toThrow("between 1 and 3");

    const missingArtifact = plan();
    missingArtifact.tasks[0] = { ...missingArtifact.tasks[0]!, dependencies: ["T002"] };
    await expect(tasks.submit("I001", missingArtifact.slices, missingArtifact.tasks)).rejects.toThrow();
  });
});
