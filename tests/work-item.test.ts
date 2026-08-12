import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkItemService } from "../src/work-item/service.js";
import type { ForgePrd, PrdReviewJobPlan, ReviewAxis } from "../src/work-item/types.js";
import { calculateDecisionFrontier, validatePrd } from "../src/work-item/validation.js";

const roots: string[] = [];
const revision = "abc123";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function prd(overrides: Partial<ForgePrd> = {}): ForgePrd {
  return {
    title: "CLI timeout",
    problem: "Users cannot bound request duration from the CLI.",
    solution: "Accept a timeout option and carry it to the HTTP client.",
    goals: ["Allow an explicit request timeout"],
    nonGoals: ["Change retry policy"],
    actors: ["CLI user"],
    userStories: [{ id: "US-01", actor: "a CLI user", capability: "set a request timeout", benefit: "hung requests stop predictably" }],
    acceptance: [{ id: "AC-01", statement: "A valid timeout reaches the HTTP client", verification: ["CLI integration test"] }],
    behavior: {
      happyPath: ["Parse timeout", "Create configuration", "Configure client"],
      errorPaths: ["Reject non-positive values"],
      edgeCases: ["Omitted timeout preserves current defaults"],
    },
    decisions: [{ id: "D-01", decision: "Carry timeout through AppConfig", rationale: "It is the existing configuration seam", evidenceIds: ["E-01"] }],
    impactEvidence: [{
      id: "E-01",
      path: "src/config.ts",
      symbol: "AppConfig",
      claim: "AppConfig is consumed by the HTTP client factory",
      repositoryRevision: revision,
    }],
    testSeams: [{ name: "CLI integration", level: "integration", evidenceIds: ["E-01"], verification: "Assert the configured client timeout" }],
    risks: [{ risk: "Unit mismatch", mitigation: "Use timeoutMs across the data path" }],
    deliveryBoundaries: [{ id: "DB-01", title: "Deliver timeout behavior", outcome: "CLI timeout behavior is complete and verifiable.", goal: "CLI timeout behavior is complete and verifiable.", scope: ["CLI timeout behavior is complete and verifiable."], acceptanceIds: ["AC-01"], behavior: { happyPath: ["Parse timeout", "Create configuration", "Configure client"], errorPaths: ["Reject non-positive values"], edgeCases: ["Omitted timeout preserves current defaults"] }, decisionIds: ["D-01"], impactEvidenceIds: ["E-01"], testSeamNames: ["CLI integration"], nonGoals: ["Change retry policy"], verification: ["CLI integration test", "Assert the configured client timeout"], dependencies: [], independentlyDeliverable: true, rationale: "All timeout behavior forms one independently deliverable outcome." }],
    rollback: "Remove the option and mapping commit.",
    diagrams: [{
      kind: "flow",
      title: "Timeout data flow",
      rationale: "The value crosses three modules.",
      mermaid: "flowchart LR\n  CLI --> Config\n  Config --> Client",
    }],
    openQuestions: [],
    ...overrides,
  };
}

async function createService() {
  const root = await mkdtemp(join(tmpdir(), "pi-forge-prd-"));
  roots.push(root);
  const service = new WorkItemService(root);
  await service.initialize({
    workItemId: "timeout-work-item",
    title: "CLI timeout",
    repositoryRoot: root,
    repositoryRevision: revision,
  });
  return { root, service };
}

async function checkpointResolved(service: WorkItemService) {
  await service.checkpoint({
    decisions: [{
      id: "Q1",
      question: "What unit should timeout use?",
      dependsOn: [],
      status: "answered",
      recommendedAnswer: "Milliseconds",
      answer: "Milliseconds",
      answerSource: "user",
    }],
    evidence: prd().impactEvidence,
    summary: "Timeout behavior and configuration seam are settled.",
  });
}

function reviewPlans(serviceState: Awaited<ReturnType<WorkItemService["submitPrd"]>>, counts: Partial<Record<ReviewAxis, number>> = {}): PrdReviewJobPlan[] {
  const generation = serviceState.currentPrd!;
  return (["coverage", "evidence", "architecture"] as ReviewAxis[]).flatMap((axis) => {
    const requiredCount = counts[axis] ?? 1;
    return Array.from({ length: requiredCount }, (_, index) => ({
      id: `prd-${generation.generation}-${axis}-${index + 1}`,
      axis,
      ordinal: index + 1,
      requiredCount,
      prdGeneration: generation.generation,
      surfaceHash: generation.reviewSurfaceHashes[axis],
      profile: "audit",
      model: "test/audit",
      thinking: "high" as const,
      maxTurns: 20,
      maxAttempts: 2,
      configGeneration: 1,
      configHash: "config-hash",
    }));
  });
}

async function passReviews(service: WorkItemService) {
  const state = await service.store.readState();
  const generation = state.currentPrd!;
  const axes: ReviewAxis[] = ["coverage", "evidence", "architecture"];
  for (const axis of axes) {
    await service.submitReview({
      axis,
      verdict: "passed",
      surfaceHash: generation.reviewSurfaceHashes[axis],
      reviewerId: `${axis}-reviewer`,
      findings: [],
    });
  }
}

describe("WorkItemService", () => {
  it("freezes an immutable reviewed and approved PRD generation", async () => {
    const { root, service } = await createService();
    await checkpointResolved(service);
    await service.submitPrd(prd());
    await passReviews(service);
    await service.approve({ approvedBy: "user", evidence: "User said: approved" });
    const frozen = await service.freeze();

    expect(frozen.status).toBe("frozen");
    expect(frozen.frozenReceipt?.contentHash).toBe(frozen.currentPrd?.contentHash);
    const markdown = await readFile(join(root, "prd", "PRD.md"), "utf8");
    const topLevelMarkdown = await readFile(join(root, "PRD.md"), "utf8");
    expect(topLevelMarkdown).toBe(markdown);
    expect(markdown).toContain("## Delivery plan");
    expect(markdown).toContain("DB-01");
    expect(markdown).toContain("**Goal:** CLI timeout behavior is complete and verifiable.");
    expect(markdown).toContain("```mermaid\nflowchart LR");
    expect(markdown).toContain("**AC-01**");
    await expect(service.checkpoint({ decisions: [], evidence: [], summary: "change" })).rejects.toThrow("immutable");
  });

  it("creates a successor Work Item instead of amending a frozen PRD in place", async () => {
    const { root, service } = await createService();
    await checkpointResolved(service);
    await service.submitPrd(prd());
    await passReviews(service);
    await service.approve({ approvedBy: "user", evidence: "Approved predecessor" });
    const predecessor = await service.freeze();
    const successorRoot = `${root}-successor`;
    roots.push(successorRoot);

    const created = await service.createSuccessor({
      successorRoot,
      successorWorkItemId: "timeout-successor",
      title: "CLI timeout successor",
      repositoryRevision: "def456",
      reason: "Execution proved that the public timeout contract must change.",
      authorizedBy: "user",
      authorizationEvidence: "User authorized a successor Work Item.",
    });

    expect(created.state.status).toBe("discovery");
    expect(created.manifest.supersedes).toMatchObject({
      predecessorWorkItemId: "timeout-work-item",
      predecessorRoot: root,
      predecessorPrdGeneration: predecessor.currentPrd!.generation,
      predecessorPrdHash: predecessor.currentPrd!.contentHash,
    });
    expect((await service.store.readState()).status).toBe("frozen");
  });

  it("rejects Delivery Boundary dependency cycles before PRD review", () => {
    const document = prd();
    document.deliveryBoundaries = [
      { ...document.deliveryBoundaries[0]!, id: "DB-01", dependencies: ["DB-02"] },
      { ...document.deliveryBoundaries[0]!, id: "DB-02", dependencies: ["DB-01"] },
    ];
    expect(() => validatePrd(document)).toThrow("Delivery Boundary dependency cycle");
  });

  it("fails closed before reviews, approval, or resolved questions", async () => {
    const { service } = await createService();
    await service.checkpoint({
      decisions: [{ id: "Q1", question: "Choose behavior", dependsOn: [], status: "open" }],
      evidence: prd().impactEvidence,
      summary: "Behavior remains open.",
    });
    await service.submitPrd(prd({ openQuestions: ["Choose behavior"] }));
    await expect(service.freeze()).rejects.toThrow("open questions");
    await expect(service.approve({ approvedBy: "user", evidence: "yes" })).rejects.toThrow("reviewing");
  });

  it("creates a new generation and invalidates old reviews and approval", async () => {
    const { service } = await createService();
    await checkpointResolved(service);
    await service.submitPrd(prd());
    await passReviews(service);
    await service.approve({ approvedBy: "user", evidence: "approved v1" });

    const second = await service.submitPrd(prd({ solution: "Carry timeout through request settings." }));
    expect(second.activePrdGeneration).toBe(2);
    expect(second.reviews).toEqual({});
    expect(second.approval).toBeUndefined();
  });

  it("amends the PRD and reruns only invalidated review surfaces", async () => {
    const { service } = await createService();
    await checkpointResolved(service);
    const first = await service.submitPrd(prd());
    const firstSurfaces = first.currentPrd!.reviewSurfaceHashes;
    await service.submitReview({ axis: "coverage", verdict: "passed", surfaceHash: firstSurfaces.coverage, reviewerId: "coverage-v1", findings: [] });
    await service.submitReview({ axis: "evidence", verdict: "passed", surfaceHash: firstSurfaces.evidence, reviewerId: "evidence-v1", findings: [] });
    await service.submitReview({
      axis: "architecture",
      verdict: "blocked",
      surfaceHash: firstSurfaces.architecture,
      reviewerId: "architecture-v1",
      findings: [{ severity: "blocker", message: "The application seam is unspecified", evidence: ["src/client.ts#createClient"] }],
    });

    const amendedPrd = prd({
      decisions: [
        ...prd().decisions,
        {
          id: "D-02",
          decision: "Apply timeout at the request descriptor returned by createClient.get.",
          rationale: "The fixture has no lower transport seam; this is its observable client configuration result.",
          evidenceIds: ["E-01"],
        },
      ],
      diagrams: [{
        kind: "flow",
        title: "Timeout application seam",
        rationale: "Shows where the configured value becomes observable.",
        mermaid: "flowchart LR\n  CLI --> Config\n  Config --> Client\n  Client --> RequestDescriptor",
      }],
    });
    const amended = await service.amendPrd({
      reason: "Resolve the confirmed Architecture blocker by naming the concrete application seam.",
      authorization: { actor: "user", evidence: "User requested the PRD Amendment Loop" },
      prd: amendedPrd,
    });

    expect(amended.activePrdGeneration).toBe(2);
    expect(amended.lastAmendment?.carriedReviewAxes).toEqual(["coverage", "evidence"]);
    expect(amended.lastAmendment?.invalidatedReviewAxes).toEqual(["architecture"]);
    expect(amended.reviews.coverage?.carriedFrom?.generation).toBe(1);
    expect(amended.reviews.evidence?.carriedFrom?.generation).toBe(1);
    expect(amended.reviews.architecture).toBeUndefined();
    expect(amended.status).toBe("reviewing");
    await expect(service.submitReview({
      axis: "architecture",
      verdict: "passed",
      surfaceHash: amended.currentPrd!.reviewSurfaceHashes.architecture,
      reviewerId: "architecture-v1",
      findings: [],
    })).rejects.toThrow("invalidated prior generation");

    await service.submitReview({
      axis: "architecture",
      verdict: "passed",
      surfaceHash: amended.currentPrd!.reviewSurfaceHashes.architecture,
      reviewerId: "architecture-v2",
      findings: [],
    });
    expect((await service.store.readState()).status).toBe("awaiting_approval");
    await service.approve({ approvedBy: "user", evidence: "Approved Generation 2" });
    expect((await service.freeze()).status).toBe("frozen");
  });

  it("runs binding-bound Review Jobs and aggregates multiple reviewers per axis", async () => {
    const { service } = await createService();
    await checkpointResolved(service);
    const submitted = await service.submitPrd(prd());
    const plans = reviewPlans(submitted, { coverage: 2 });
    await service.createReviewJobs(plans);

    for (const plan of plans) {
      const state = await service.store.readState();
      const binding = WorkItemService.createReviewBinding({
        jobId: plan.id,
        workItemId: state.workItemId,
        prdGeneration: plan.prdGeneration,
        axis: plan.axis,
        surfaceHash: plan.surfaceHash,
        attempt: 1,
        profile: plan.profile,
        model: plan.model,
        thinking: plan.thinking,
        maxTurns: plan.maxTurns,
        startedStateGeneration: state.generation,
      });
      await service.claimReviewJob(plan.id, binding);
      await service.bindReviewAgent(plan.id, binding.id, `agent-${plan.id}`);
      await service.markReviewAgentStarted(`agent-${plan.id}`);
      const result = await service.submitBoundReview({
        bindingId: binding.id,
        axis: plan.axis,
        verdict: "passed",
        surfaceHash: plan.surfaceHash,
        findings: [],
      });
      if (plan.axis === "coverage" && plan.ordinal === 1) expect(result.reviews.coverage).toBeUndefined();
      await service.markReviewAgentTerminal(`agent-${plan.id}`, "completed");
    }

    const reviewed = await service.store.readState();
    expect(reviewed.status).toBe("awaiting_approval");
    expect(reviewed.reviews.coverage?.reviewerId).toMatch(/^aggregate:/);
    expect(Object.values(reviewed.reviewJobs ?? {}).every((job) => job.status === "completed")).toBe(true);
    expect(Object.keys(reviewed.individualReviews ?? {})).toHaveLength(4);
  });

  it("interrupts a completed Reviewer that did not submit a structured result", async () => {
    const { service } = await createService();
    await checkpointResolved(service);
    const submitted = await service.submitPrd(prd());
    const [plan] = reviewPlans(submitted);
    await service.createReviewJobs([plan!]);
    const state = await service.store.readState();
    const binding = WorkItemService.createReviewBinding({
      jobId: plan!.id,
      workItemId: state.workItemId,
      prdGeneration: plan!.prdGeneration,
      axis: plan!.axis,
      surfaceHash: plan!.surfaceHash,
      attempt: 1,
      profile: plan!.profile,
      model: plan!.model,
      thinking: plan!.thinking,
      maxTurns: plan!.maxTurns,
      startedStateGeneration: state.generation,
    });
    await service.claimReviewJob(plan!.id, binding);
    await service.bindReviewAgent(plan!.id, binding.id, "agent-no-result");
    await service.markReviewAgentStarted("agent-no-result");
    const interrupted = await service.markReviewAgentTerminal("agent-no-result", "completed");
    expect(interrupted.reviewJobs?.[plan!.id]?.status).toBe("interrupted");
    expect((await service.pendingReviewJobs()).map((job) => job.id)).toEqual([plan!.id]);
  });

  it("rejects manual reviews after automated Review Jobs are frozen", async () => {
    const { service } = await createService();
    await checkpointResolved(service);
    const submitted = await service.submitPrd(prd());
    await service.createReviewJobs(reviewPlans(submitted));
    await expect(service.submitReview({
      axis: "coverage",
      verdict: "passed",
      surfaceHash: submitted.currentPrd!.reviewSurfaceHashes.coverage,
      reviewerId: "manual-bypass",
      findings: [],
    })).rejects.toThrow("requires a valid Review Binding");
  });

  it("allows freeze only when an independent Verifier rejects every reported Blocker", async () => {
    const { service } = await createService();
    await checkpointResolved(service);
    const submitted = await service.submitPrd(prd());
    const surfaces = submitted.currentPrd!.reviewSurfaceHashes;
    await service.submitReview({ axis: "coverage", verdict: "passed", surfaceHash: surfaces.coverage, reviewerId: "coverage", findings: [] });
    await service.submitReview({ axis: "evidence", verdict: "passed", surfaceHash: surfaces.evidence, reviewerId: "evidence", findings: [] });
    await service.submitReview({
      axis: "architecture",
      verdict: "blocked",
      surfaceHash: surfaces.architecture,
      reviewerId: "architecture",
      findings: [{
        id: "F-ARCH-001",
        severity: "blocker",
        message: "The reported seam may be missing",
        evidence: ["src/config.ts#AppConfig"],
        violatedRule: "Design must use an existing seam",
        verification: "Read AppConfig",
      }],
    });
    expect((await service.store.readState()).status).toBe("blocked");
    const created = await service.createBlockerVerificationJob({
      profile: "verifier",
      model: "test/verifier",
      thinking: "high",
      maxTurns: 20,
      maxAttempts: 2,
      configGeneration: 1,
      configHash: "config-hash",
    });
    const job = created.blockerVerificationJob!;
    const binding = WorkItemService.createBlockerVerificationBinding({
      jobId: job.id,
      workItemId: created.workItemId,
      prdGeneration: job.prdGeneration,
      findingHash: job.findingHash,
      attempt: 1,
      profile: job.profile,
      model: job.model,
      thinking: job.thinking,
      maxTurns: job.maxTurns,
      startedStateGeneration: created.generation,
    });
    await service.claimBlockerVerification(binding);
    await service.bindBlockerVerificationAgent(binding.id, "verifier-agent");
    await service.markBlockerVerifierStarted("verifier-agent");
    const verified = await service.submitBlockerVerification(binding.id, [{
      findingId: "F-ARCH-001",
      status: "rejected",
      evidence: ["src/config.ts#AppConfig"],
      rationale: "AppConfig is present and is the selected seam.",
    }]);
    expect(verified.status).toBe("awaiting_approval");
    await service.markBlockerVerifierTerminal("verifier-agent", "completed");
    await service.approve({ approvedBy: "user", evidence: "Approved after independent verification" });
    const frozen = await service.freeze();
    expect(frozen.status).toBe("frozen");
    expect(frozen.frozenReceipt?.blockerVerification?.results[0]?.status).toBe("rejected");
  });

  it("keeps the PRD blocked when the independent Verifier confirms a Blocker", async () => {
    const { service } = await createService();
    await checkpointResolved(service);
    const submitted = await service.submitPrd(prd());
    const surfaces = submitted.currentPrd!.reviewSurfaceHashes;
    await service.submitReview({ axis: "coverage", verdict: "passed", surfaceHash: surfaces.coverage, reviewerId: "coverage", findings: [] });
    await service.submitReview({ axis: "evidence", verdict: "passed", surfaceHash: surfaces.evidence, reviewerId: "evidence", findings: [] });
    await service.submitReview({
      axis: "architecture", verdict: "blocked", surfaceHash: surfaces.architecture, reviewerId: "architecture",
      findings: [{ id: "F-ARCH-001", severity: "blocker", message: "Missing seam", evidence: ["src/client.ts#createClient"], violatedRule: "Use an existing seam", verification: "Read createClient" }],
    });
    const created = await service.createBlockerVerificationJob({ profile: "verifier", model: "test/verifier", thinking: "high", maxTurns: 20, maxAttempts: 1, configGeneration: 1, configHash: "hash" });
    const job = created.blockerVerificationJob!;
    const binding = WorkItemService.createBlockerVerificationBinding({ jobId: job.id, workItemId: created.workItemId, prdGeneration: job.prdGeneration, findingHash: job.findingHash, attempt: 1, profile: job.profile, model: job.model, thinking: job.thinking, maxTurns: job.maxTurns, startedStateGeneration: created.generation });
    await service.claimBlockerVerification(binding);
    const state = await service.submitBlockerVerification(binding.id, [{ findingId: "F-ARCH-001", status: "confirmed", evidence: ["src/client.ts#createClient"], rationale: "The function exposes no application seam." }]);
    expect(state.status).toBe("blocked");
    await expect(service.approve({ approvedBy: "user", evidence: "approve anyway" })).rejects.toThrow("blocked");
  });

  it("requires independent reviewers", async () => {
    const { service } = await createService();
    await checkpointResolved(service);
    const submitted = await service.submitPrd(prd());
    const surfaces = submitted.currentPrd!.reviewSurfaceHashes;
    await service.submitReview({ axis: "coverage", verdict: "passed", surfaceHash: surfaces.coverage, reviewerId: "same", findings: [] });
    await expect(service.submitReview({
      axis: "evidence",
      verdict: "passed",
      surfaceHash: surfaces.evidence,
      reviewerId: "same",
      findings: [],
    })).rejects.toThrow("already submitted");
  });

  it("repairs a stale snapshot from the Work Item ledger", async () => {
    const { service } = await createService();
    await checkpointResolved(service);
    const result = await service.open();
    expect(result.repaired).toBe(false);
    expect(result.frontier).toEqual([]);
  });
});

describe("PRD validation", () => {
  it("calculates only currently answerable decision nodes", () => {
    expect(calculateDecisionFrontier([
      { id: "Q1", question: "First", dependsOn: [], status: "open" },
      { id: "Q2", question: "Second", dependsOn: ["Q1"], status: "open" },
    ])).toEqual(["Q1"]);
  });

  it("accepts no diagrams and rejects mismatched Mermaid kinds", () => {
    expect(() => validatePrd(prd({ diagrams: [] }))).not.toThrow();
    expect(() => validatePrd(prd({
      diagrams: [{ kind: "state", title: "Wrong", rationale: "Test", mermaid: "flowchart LR\nA --> B" }],
    }))).toThrow("does not match diagram kind");
  });
});
