import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { IssueAuditOrchestrator } from "../extensions/forge-workflow/issue-audit-orchestrator.js";
import type { ForgeConfig } from "../src/config/types.js";
import { RuntimeService } from "../src/runtime/service.js";
import type { IssueAuditAxis } from "../src/runtime/types.js";
import { PiSubagentsAdapter, type EventBus } from "../src/subagents/adapter.js";

class FakeBus implements EventBus {
  handlers = new Map<string, Set<(payload: any) => void>>();
  on(event: string, handler: (payload: any) => void) { const set = this.handlers.get(event) ?? new Set(); set.add(handler); this.handlers.set(event, set); return () => set.delete(handler); }
  emit(event: string, payload: any) { for (const handler of this.handlers.get(event) ?? []) handler(payload); }
}

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }))));

function config(): ForgeConfig {
  const audit = { model: "test/audit", thinking: "high" as const, maxTurns: 20 };
  return {
    schemaVersion: 1, generation: 1, artifacts: { root: ".forge", gitPolicy: "ignore" }, tracker: { mode: "local", publishRequiresConfirmation: true },
    workspace: { mode: "shared-serial", isolationBackend: "none", poolSize: 1 },
    models: { profiles: { simple: audit, medium: audit, complex: audit, audit, verifier: { model: "test/verifier", thinking: "high", maxTurns: 20 } }, routing: { "task.simple": "simple", "task.medium": "medium", "task.complex": "complex", prdResearch: "medium", optionCandidate: "complex", optionJudge: "audit", optionSynthesizer: "complex", prdCoverageReview: "audit", prdEvidenceReview: "audit", prdArchitectureReview: "audit", blockerVerifier: "verifier", taskAudit: "audit", issueAudit: "audit" } },
    review: { preset: "standard", prd: { coverageReviewers: 1, evidenceReviewers: 1, architectureReviewers: 1 }, blockerVerification: { profile: "verifier", requireDifferentModel: true } },
    tournament: { enabled: true, candidates: 3, judges: 2, candidateProfile: "complex", judgeProfile: "audit", synthesizerProfile: "complex", blindReview: true },
    commands: {}, agents: { directory: ".pi/agents", templateVersion: 1 },
  };
}

function context(root: string): ExtensionContext {
  return { cwd: root, modelRegistry: { find(provider: string, id: string) { return provider === "test" && id === "audit" ? { provider, id } : undefined; } } } as unknown as ExtensionContext;
}

describe("IssueAuditOrchestrator", () => {
  it("automatically spawns three independent final Audit Bindings and completes on three passes", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-forge-issue-audit-"));
    roots.push(repositoryRoot);
    await mkdir(join(repositoryRoot, ".pi"), { recursive: true });
    await writeFile(join(repositoryRoot, ".pi", "forge.json"), JSON.stringify(config()));
    const runtimeRoot = join(repositoryRoot, ".forge", "issues", "I001", "runtime");
    const runtime = new RuntimeService(runtimeRoot);
    await runtime.initialize({ workItemId: "work-item-test", issueId: "I001", issueHash: "hash", workspaceRoot: repositoryRoot, workspaceMode: "shared-serial", modelPolicy: { defaultProfile: "audit", profiles: { audit: { model: "test/audit", thinking: "high", maxTurns: 20 } }, roles: { "task-worker": "audit" } } }, { generation: 1, tasks: [] });
    await runtime.store.transact("test_ready_for_audit", (state) => { state.issueStatus = "auditing"; });

    const bus = new FakeBus();
    const spawns: any[] = [];
    bus.on("subagents:rpc:ping", (request) => bus.emit(`subagents:rpc:ping:reply:${request.requestId}`, { success: true, data: { version: 2 } }));
    bus.on("subagents:rpc:spawn", (request) => { spawns.push(request); bus.emit(`subagents:rpc:spawn:reply:${request.requestId}`, { success: true, data: { id: `agent-${spawns.length}` } }); });
    const orchestrator = new IssueAuditOrchestrator(new PiSubagentsAdapter(bus, 100));
    const started = await orchestrator.start(runtimeRoot, context(repositoryRoot));
    expect(started).toHaveLength(3);
    expect(spawns.every((spawn) => spawn.type === "forge-reviewer" && spawn.options.model.id === "audit")).toBe(true);
    expect(new Set(spawns.map((spawn) => spawn.options.description)).size).toBe(3);

    let state = await runtime.status();
    for (const axis of ["standards", "spec_integration", "architecture_minimality"] as IssueAuditAxis[]) {
      state = await runtime.submitAudit(state.auditJobs![axis].binding!.id, axis, "passed", []);
    }
    expect(state.issueStatus).toBe("completed");
  });
});
