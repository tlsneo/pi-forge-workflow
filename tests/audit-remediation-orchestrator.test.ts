import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { AuditRemediationOrchestrator } from "../extensions/forge-workflow/audit-remediation-orchestrator.js";
import type { ForgeConfig } from "../src/config/types.js";
import { RuntimeService } from "../src/runtime/service.js";
import { stableHash } from "../src/runtime/hash.js";
import { PiSubagentsAdapter, type EventBus } from "../src/subagents/adapter.js";

class FakeBus implements EventBus {
  handlers = new Map<string, Set<(payload: any) => void>>();
  on(event: string, handler: (payload: any) => void) { const set = this.handlers.get(event) ?? new Set(); set.add(handler); this.handlers.set(event, set); return () => set.delete(handler); }
  emit(event: string, payload: any) { for (const handler of this.handlers.get(event) ?? []) handler(payload); }
}

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function config(): ForgeConfig {
  const audit = { model: "test/audit", thinking: "high" as const, maxTurns: 20 };
  return {
    schemaVersion: 1, generation: 1, artifacts: { root: ".forge", gitPolicy: "ignore" }, tracker: { mode: "local", publishRequiresConfirmation: true },
    workspace: { mode: "shared-serial", isolationBackend: "none", poolSize: 1 },
    models: { profiles: { simple: audit, medium: audit, complex: audit, audit, verifier: { model: "test/verifier", thinking: "high", maxTurns: 20 } }, routing: { "task.simple": "simple", "task.medium": "medium", "task.complex": "complex", taskPreflight: "audit", remediationPlanner: "complex", blockerVerifier: "verifier", taskAudit: "audit", issueAudit: "audit" } },
    review: { preset: "standard", prd: { coverageReviewers: 1, evidenceReviewers: 1, architectureReviewers: 1 }, blockerVerification: { profile: "verifier", requireDifferentModel: true } },
    tournament: { enabled: true, candidates: 3, judges: 2, candidateProfile: "complex", judgeProfile: "audit", synthesizerProfile: "complex", blindReview: true },
    commands: {}, agents: { directory: ".pi/agents", templateVersion: 1 },
  };
}

function context(root: string): ExtensionContext {
  return { cwd: root, modelRegistry: { find(provider: string, id: string) { return provider === "test" && ["audit", "verifier"].includes(id) ? { provider, id } : undefined; } } } as unknown as ExtensionContext;
}

describe("AuditRemediationOrchestrator", () => {
  it("marks a Remediation Planner spawn failure retryable", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-forge-remediation-spawn-"));
    roots.push(repositoryRoot);
    const runtimeRoot = join(repositoryRoot, ".forge", "work-items", "x", "issues", "I001", "runtime");
    await mkdir(join(repositoryRoot, ".pi"), { recursive: true });
    await writeFile(join(repositoryRoot, ".pi", "forge.json"), JSON.stringify(config()));
    const runtime = new RuntimeService(runtimeRoot);
    await runtime.initialize({ workItemId: "x", issueId: "I001", issueHash: "issue", workspaceRoot: repositoryRoot, workspaceMode: "shared-serial", modelPolicy: { defaultProfile: "simple", profiles: { simple: { model: "test/audit", thinking: "high", maxTurns: 20 } }, roles: { "task-worker": "simple" } } }, { generation: 1, tasks: [] });
    await runtime.store.transact("test_planner_ready", (state) => {
      state.issueStatus = "blocked";
      state.remediationPlan = { id: "remediation-1", source: "audit", sourceAuditGeneration: 1, findingHash: "finding", confirmedFindingIds: ["F-1"], status: "awaiting_proposal", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      state.auditBlockerVerifierJob = { id: "verifier", status: "completed", attempt: 1, maxAttempts: 2, findingHash: "finding", findings: [{ findingId: "F-1", axis: "standards", auditBindingId: "audit", finding: { id: "F-1", severity: "blocker", message: "broken", evidence: ["src/x.ts#x"], violatedRule: "rule", verification: "read" } }], model: "test/verifier", thinking: "high", maxTurns: 20, configHash: "config", result: { bindingId: "verify-binding", findingHash: "finding", results: [{ findingId: "F-1", status: "confirmed", evidence: ["src/x.ts#x"], rationale: "confirmed", missingEvidence: [] }], submittedAt: new Date().toISOString() } };
    });
    const bus = new FakeBus();
    bus.on("subagents:rpc:ping", (request) => bus.emit(`subagents:rpc:ping:reply:${request.requestId}`, { success: true, data: { version: 2 } }));
    bus.on("subagents:rpc:spawn", (request) => bus.emit(`subagents:rpc:spawn:reply:${request.requestId}`, { success: false, error: "spawn unavailable" }));
    const orchestrator = new AuditRemediationOrchestrator(new PiSubagentsAdapter(bus, 100));
    const result = await orchestrator.startPlanner(runtimeRoot, context(repositoryRoot));
    expect(result.status).toBe("failed");
    expect((await runtime.status()).remediationPlan?.plannerJob?.status).toBe("retry_ready");
  });

  it("starts an independent Verifier and a bound Planner for confirmed final Audit Blockers", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-forge-remediation-"));
    roots.push(repositoryRoot);
    await mkdir(join(repositoryRoot, ".pi"), { recursive: true });
    await writeFile(join(repositoryRoot, ".pi", "forge.json"), JSON.stringify(config()));
    const workItemRoot = join(repositoryRoot, ".forge", "work-items", "x");
    const issueRoot = join(workItemRoot, "issues", "I001");
    await mkdir(join(workItemRoot, "prd", "generations"), { recursive: true });
    await mkdir(issueRoot, { recursive: true });
    await writeFile(join(workItemRoot, "manifest.json"), JSON.stringify({ workItemId: "x" }));
    const prdBase = { schemaVersion: 1, workItemId: "x", generation: 1, reviewSurfaceHashes: {}, submittedAt: new Date().toISOString(), prd: { title: "Repair", problem: "Bug", solution: "Fix", goals: [], nonGoals: [], actors: [], userStories: [], acceptance: [{ id: "AC-01", statement: "Behavior works", verification: ["test"] }], behavior: { happyPath: [], errorPaths: [], edgeCases: [] }, decisions: [{ id: "D-01", decision: "Use existing seam", rationale: "Local", evidenceIds: [] }], impactEvidence: [], testSeams: [], risks: [], deliveryBoundaries: [{ id: "DB-01", title: "Repair", outcome: "Behavior works", goal: "Behavior works", scope: ["Behavior works"], acceptanceIds: ["AC-01"], behavior: { happyPath: [], errorPaths: [], edgeCases: [] }, decisionIds: ["D-01"], impactEvidenceIds: [], testSeamNames: [], nonGoals: [], verification: ["test"], dependencies: [], independentlyDeliverable: true, rationale: "One outcome" }], rollback: "Revert", diagrams: [], openQuestions: [] } };
    const prd = { ...prdBase, contentHash: stableHash(prdBase) };
    await writeFile(join(workItemRoot, "prd", "generations", "prd-1.json"), JSON.stringify(prd));
    await writeFile(join(workItemRoot, "prd", "PRD.md"), "# Repair\n");
    const issueBase = { schemaVersion: 1, source: { workItemId: "x", prdGeneration: 1, prdHash: prd.contentHash }, id: "I001", deliveryBoundaryId: "DB-01", title: "Repair", goal: "Fix bug", deliveryOutcome: "Works", scope: ["Existing seam"], nonGoals: ["New interface"], acceptanceIds: ["AC-01"], behavior: { happyPath: [], errorPaths: [], edgeCases: [] }, decisionIds: ["D-01"], impactEvidenceIds: [], testSeamNames: [], verification: ["test"], dependencies: [] };
    const issue = { ...issueBase, artifactHash: stableHash(issueBase) };
    await writeFile(join(issueRoot, "issue.json"), JSON.stringify(issue));
    await writeFile(join(issueRoot, "ISSUE.md"), "# I001 Repair\n");
    const runtimeRoot = join(issueRoot, "runtime");
    const runtime = new RuntimeService(runtimeRoot);
    await runtime.initialize({ workItemId: "x", issueId: "I001", issueHash: issue.artifactHash, workspaceRoot: repositoryRoot, workspaceMode: "shared-serial", modelPolicy: { defaultProfile: "simple", profiles: { simple: { model: "test/audit", thinking: "high", maxTurns: 20 } }, roles: { "task-worker": "simple" } } }, { generation: 1, tasks: [] });
    await runtime.store.transact("test_blocked", (state) => {
      state.issueStatus = "blocked";
      state.auditGeneration = 1;
      state.audits = { architecture_minimality: { axis: "architecture_minimality", verdict: "blocked", bindingId: "audit-binding", submittedAt: new Date().toISOString(), findings: [{ id: "ARCH-1", severity: "blocker", message: "Shared state mutation", evidence: ["src/config.ts#AppConfig"], violatedRule: "Mutation must be local", verification: "Read AppConfig", suggestedResolution: "Use a local value" }] } };
    });

    const bus = new FakeBus();
    const spawns: any[] = [];
    bus.on("subagents:rpc:ping", (request) => bus.emit(`subagents:rpc:ping:reply:${request.requestId}`, { success: true, data: { version: 2 } }));
    bus.on("subagents:rpc:spawn", (request) => { spawns.push(request); bus.emit(`subagents:rpc:spawn:reply:${request.requestId}`, { success: true, data: { id: `agent-${spawns.length}` } }); });
    const orchestrator = new AuditRemediationOrchestrator(new PiSubagentsAdapter(bus, 100));
    const verifier = await orchestrator.startVerifier(runtimeRoot, context(repositoryRoot));
    expect(verifier.status).toBe("started");
    expect(spawns[0].type).toBe("forge-reviewer");
    expect(spawns[0].options.model.id).toBe("verifier");

    const verifierState = await runtime.status();
    const result = await orchestrator.submitVerification(runtimeRoot, verifierState.auditBlockerVerifierJob!.binding!.id, [{ findingId: "ARCH-1", status: "confirmed", evidence: ["src/config.ts#AppConfig"], rationale: "The final code mutates shared state", missingEvidence: [] }], context(repositoryRoot));
    expect(result.remediationRequired).toBe(true);
    expect(result.planner?.status).toBe("started");
    expect(spawns[1].type).toBe("forge-designer");
    expect(spawns[1].prompt).toContain("Frozen PRD:");
    expect(spawns[1].prompt).toContain("Frozen Issue:");
    expect((await runtime.status()).remediationPlan?.plannerJob?.binding?.agentId).toBe("agent-2");
  });
});
