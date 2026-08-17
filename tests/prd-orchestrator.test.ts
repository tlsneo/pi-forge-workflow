import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrdReviewOrchestrator } from "../extensions/forge-workflow/prd-review-orchestrator.js";
import type { ForgeConfig } from "../src/config/types.js";
import { PiSubagentsAdapter, type EventBus } from "../src/subagents/adapter.js";
import { WorkItemService } from "../src/work-item/service.js";
import type { ForgePrd } from "../src/work-item/types.js";
import { emitWorkflowCompletion, installRpcV1, spawnAgent, spawnDescription, spawnModel, spawnTask } from "./helpers/nicobailon-rpc.js";

class FakeBus implements EventBus {
  handlers = new Map<string, Set<(payload: any) => void>>();
  on(event: string, handler: (payload: any) => void) {
    const handlers = this.handlers.get(event) ?? new Set();
    handlers.add(handler);
    this.handlers.set(event, handlers);
    return () => handlers.delete(handler);
  }
  emit(event: string, payload: any) {
    for (const handler of this.handlers.get(event) ?? []) handler(payload);
  }
}

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
        break;
      } catch (error) {
        if (attempt === 5) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }
});

function config(): ForgeConfig {
  const profile = { model: "test/audit", thinking: "high" as const, maxTurns: 20 };
  return {
    schemaVersion: 1,
    generation: 1,
    artifacts: { root: ".forge", gitPolicy: "ignore" },
    tracker: { mode: "local", publishRequiresConfirmation: true },
    workspace: { mode: "shared-serial", isolationBackend: "none", poolSize: 1 },
    models: {
      profiles: { simple: profile, medium: profile, complex: profile, audit: profile, verifier: { model: "test/verifier", thinking: "high", maxTurns: 20 } },
      routing: {
        "task.simple": "simple", "task.medium": "medium", "task.complex": "complex",
        prdCoverageReview: "audit", prdEvidenceReview: "audit", prdArchitectureReview: "audit",
        blockerVerifier: "verifier", taskPreflight: "audit", remediationPlanner: "complex", issueAudit: "audit",
      },
    },
    review: {
      preset: "standard",
      prd: { coverageReviewers: 1, evidenceReviewers: 1, architectureReviewers: 1 },
      blockerVerification: { profile: "verifier", requireDifferentModel: true },
    },
    commands: {},
    agents: { directory: ".pi/agents", templateVersion: 1 },
  };
}

function prd(revision: string): ForgePrd {
  return {
    title: "Timeout",
    problem: "Requests cannot be bounded.",
    solution: "Carry timeout through config.",
    goals: ["Bound requests"],
    nonGoals: ["Change retries"],
    actors: ["CLI user"],
    userStories: [{ id: "US-01", actor: "CLI user", capability: "set timeout", benefit: "stop requests" }],
    acceptance: [{ id: "AC-01", statement: "Timeout reaches client", verification: ["integration test"] }],
    behavior: { happyPath: ["Apply timeout"], errorPaths: ["Reject invalid"], edgeCases: ["Omission preserves default"] },
    decisions: [{ id: "D-01", decision: "Use config", rationale: "Existing seam", evidenceIds: ["E-01"] }],
    impactEvidence: [{ id: "E-01", path: "src/config.ts", symbol: "Config", claim: "Client consumes it", repositoryRevision: revision }],
    testSeams: [{ name: "integration", level: "integration", evidenceIds: ["E-01"], verification: "Observe timeout" }],
    risks: [{ risk: "Units", mitigation: "Milliseconds" }],
    deliveryBoundaries: [{ id: "DB-01", title: "Deliver timeout behavior", outcome: "The timeout reaches the client through the frozen seam.", goal: "The timeout reaches the client through the frozen seam.", scope: ["The timeout reaches the client through the frozen seam."], acceptanceIds: ["AC-01"], behavior: { happyPath: ["Apply timeout"], errorPaths: ["Reject invalid"], edgeCases: ["Omission preserves default"] }, decisionIds: ["D-01"], impactEvidenceIds: ["E-01"], testSeamNames: ["integration"], nonGoals: ["Change retries"], verification: ["integration test", "Observe timeout"], dependencies: [], independentlyDeliverable: true, rationale: "One coherent delivery outcome." }],
    rollback: "Revert.",
    diagrams: [],
    openQuestions: [],
  };
}

async function fixture() {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-forge-review-orchestrator-"));
  roots.push(repositoryRoot);
  await mkdir(join(repositoryRoot, ".pi"), { recursive: true });
  await writeFile(join(repositoryRoot, ".pi", "forge.json"), JSON.stringify(config()));
  const workItemRoot = join(repositoryRoot, ".forge", "work-items", "timeout");
  const service = new WorkItemService(workItemRoot);
  await service.initialize({ workItemId: "timeout", title: "Timeout", repositoryRoot, repositoryRevision: "abc" });
  const document = prd("abc");
  await service.checkpoint({
    decisions: [{ id: "Q1", question: "Unit?", dependsOn: [], status: "answered", answer: "ms", answerSource: "user" }],
    evidence: document.impactEvidence,
    summary: "Settled.",
  });
  await service.submitPrd(document);
  return { repositoryRoot, workItemRoot, service };
}

function context(repositoryRoot: string): ExtensionContext {
  return {
    cwd: repositoryRoot,
    modelRegistry: {
      find(provider: string, id: string) {
        return provider === "test" && ["audit", "verifier"].includes(id) ? { provider, id } : undefined;
      },
    },
  } as unknown as ExtensionContext;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for asynchronous lifecycle handling");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("PrdReviewOrchestrator", () => {
  it("creates and spawns all three axis-bound Review Jobs from Forge config", async () => {
    const { repositoryRoot, workItemRoot, service } = await fixture();
    const bus = new FakeBus();
    const spawnRequests: any[] = [];
    installRpcV1(bus, { onSpawn: (request) => spawnRequests.push(request), nextId: () => `agent-${spawnRequests.length}` });
    const orchestrator = new PrdReviewOrchestrator(new PiSubagentsAdapter(bus, 100));

    const spawns = await orchestrator.startRequiredReviews(workItemRoot, context(repositoryRoot));
    expect(spawns).toHaveLength(3);
    expect(spawns.every((spawn) => spawn.status === "started")).toBe(true);
    expect(spawnRequests.map(spawnAgent)).toEqual(["forge-reviewer", "forge-reviewer", "forge-reviewer"]);
    expect(spawnRequests.map(spawnDescription).sort()).toEqual(expect.arrayContaining([
      expect.stringContaining("prd-1-coverage-1"),
      expect.stringContaining("prd-1-evidence-1"),
      expect.stringContaining("prd-1-architecture-1"),
    ]));
    expect(spawnRequests.every((request) => spawnModel(request) === "test/audit")).toBe(true);
    expect(spawnRequests.every((request) => spawnTask(request).includes("Binding ID:"))).toBe(true);

    const state = await service.store.readState();
    expect(Object.keys(state.reviewJobs ?? {})).toHaveLength(3);
    expect(Object.values(state.reviewJobs ?? {}).every((job) => job.status === "starting" && job.binding?.agentId)).toBe(true);
  });

  it("automatically retries a Reviewer that completes without submitting", async () => {
    const { repositoryRoot, workItemRoot, service } = await fixture();
    const bus = new FakeBus();
    const descriptions: string[] = [];
    installRpcV1(bus, {
      onSpawn: (request) => descriptions.push(spawnDescription(request) ?? ""),
      nextId: () => `agent-${descriptions.length}`,
    });
    const orchestrator = new PrdReviewOrchestrator(new PiSubagentsAdapter(bus, 100));
    await orchestrator.startRequiredReviews(workItemRoot, context(repositoryRoot));

    emitWorkflowCompletion(bus, "agent-1");
    await waitFor(async () => Object.values((await service.store.readState()).reviewJobs ?? {}).some((job) => job.binding?.agentId === "agent-4"));
    expect(descriptions).toHaveLength(4);
    const retried = Object.values((await service.store.readState()).reviewJobs ?? {}).find((job) => job.binding?.agentId === "agent-4");
    expect(retried?.attempt).toBe(2);
    expect(retried?.binding?.agentId).toBe("agent-4");
  }, 15_000);

  it("automatically starts a different-model Blocker Verifier after all axis reviews finish", async () => {
    const { repositoryRoot, workItemRoot, service } = await fixture();
    const bus = new FakeBus();
    const spawned: Array<{ id: string; description: string; model: any }> = [];
    installRpcV1(bus, {
      onSpawn: (request) => {
        const id = `agent-${spawned.length + 1}`;
        spawned.push({ id, description: spawnDescription(request) ?? "", model: spawnModel(request) });
      },
      nextId: () => spawned.at(-1)!.id,
    });
    const orchestrator = new PrdReviewOrchestrator(new PiSubagentsAdapter(bus, 100));
    await orchestrator.startRequiredReviews(workItemRoot, context(repositoryRoot));

    const state = await service.store.readState();
    for (const job of Object.values(state.reviewJobs ?? {})) {
      const blocked = job.axis === "architecture";
      await service.submitBoundReview({
        bindingId: job.binding!.id,
        axis: job.axis,
        verdict: blocked ? "blocked" : "passed",
        surfaceHash: job.surfaceHash,
        findings: blocked ? [{
          id: "F-ARCH-001",
          severity: "blocker",
          message: "The proposed seam is absent",
          evidence: ["src/config.ts#Config"],
          violatedRule: "Design must use an existing seam",
          verification: "Read Config",
          suggestedResolution: "Use only the smallest existing Config seam",
        }] : [],
      });
    }
    for (const agent of spawned.slice(0, 3)) {
      emitWorkflowCompletion(bus, agent.id);
    }

    await waitFor(async () => {
      const current = await service.store.readState();
      return current.blockerVerificationJob?.binding?.agentId === "agent-4"
        && Object.values(current.reviewJobs ?? {}).every((job) => job.status === "completed");
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const verifiedState = await service.store.readState();
    expect(verifiedState.blockerVerificationJob?.status).toBe("starting");
    expect(spawned).toHaveLength(4);
    expect(spawned[3]?.description).toContain("forge-prd-blocker:");
    expect(spawned[3]?.model).toBe("test/verifier");
  }, 30_000);

  it("stops known live Review Bindings before explicit coordinator takeover", async () => {
    const { repositoryRoot, workItemRoot, service } = await fixture();
    const bus = new FakeBus();
    let spawned = 0;
    installRpcV1(bus, { nextId: () => `agent-${++spawned}` });
    const orchestrator = new PrdReviewOrchestrator(new PiSubagentsAdapter(bus, 100));
    await orchestrator.startRequiredReviews(workItemRoot, context(repositoryRoot));
    const resumed = await orchestrator.resumeReviews(workItemRoot, context(repositoryRoot), "Previous coordinator process exited");
    expect(resumed.reviews).toHaveLength(3);
    expect(spawned).toBe(6);
    const state = await service.store.readState();
    expect(Object.values(state.reviewJobs ?? {}).every((job) => job.attempt === 2 && job.status === "starting" && job.binding?.agentId?.startsWith("agent-"))).toBe(true);
  }, 15_000);

  it("fails closed when Forge config is absent", async () => {
    const { repositoryRoot, workItemRoot } = await fixture();
    await rm(join(repositoryRoot, ".pi", "forge.json"));
    const bus = new FakeBus();
    const orchestrator = new PrdReviewOrchestrator(new PiSubagentsAdapter(bus, 20));
    await expect(orchestrator.ensureReady(workItemRoot, context(repositoryRoot))).rejects.toThrow("run /skill:forge-init");
  });
});
