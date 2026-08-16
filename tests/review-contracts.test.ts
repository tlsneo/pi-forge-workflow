import { describe, expect, it } from "vitest";
import { REVIEW_CONTRACTS } from "../src/work-item/review-contracts.js";
import { buildBlockerVerificationPrompt, buildPrdReviewPrompt } from "../src/work-item/review-prompts.js";
import { allReviewSurfaceHashes } from "../src/work-item/review-surfaces.js";
import type { ForgePrd, PrdReview, ReviewAxis } from "../src/work-item/types.js";
import { validateReview } from "../src/work-item/validation.js";

function prd(): ForgePrd {
  return {
    title: "Timeout",
    problem: "Requests cannot be bounded.",
    solution: "Carry timeout through configuration.",
    goals: ["Bound requests"],
    nonGoals: ["Change retries"],
    actors: ["CLI user"],
    userStories: [{ id: "US-01", actor: "a user", capability: "set timeout", benefit: "requests stop" }],
    acceptance: [{ id: "AC-01", statement: "Timeout reaches the client", verification: ["integration test"] }],
    behavior: { happyPath: ["Parse and apply"], errorPaths: ["Reject invalid"], edgeCases: ["Omission preserves default"] },
    decisions: [{ id: "D-01", decision: "Use AppConfig", rationale: "Existing seam", evidenceIds: ["E-01"] }],
    impactEvidence: [{ id: "E-01", path: "src/config.ts", symbol: "AppConfig", claim: "Client consumes config", repositoryRevision: "abc" }],
    testSeams: [{ name: "CLI integration", level: "integration", evidenceIds: ["E-01"], verification: "Observe timeout" }],
    risks: [{ risk: "Unit mismatch", mitigation: "Use milliseconds" }],
    deliveryBoundaries: [{ id: "DB-01", title: "Deliver timeout", outcome: "Timeout behavior is delivered through the existing seam.", goal: "Timeout behavior is delivered through the existing seam.", scope: ["Timeout behavior is delivered through the existing seam."], acceptanceIds: ["AC-01"], behavior: { happyPath: ["Parse and apply"], errorPaths: ["Reject invalid"], edgeCases: ["Omission preserves default"] }, decisionIds: ["D-01"], impactEvidenceIds: ["E-01"], testSeamNames: ["CLI integration"], nonGoals: ["Change retries"], verification: ["integration test", "Observe timeout"], dependencies: [], independentlyDeliverable: true, rationale: "One delivery outcome." }],
    rollback: "Revert the feature.",
    diagrams: [],
    openQuestions: [],
  };
}

describe("PRD review contracts", () => {
  it("keeps each axis narrow and gives a strict blocker threshold", () => {
    expect(REVIEW_CONTRACTS.coverage.outOfScope).toContain("Architecture optimality or Seam placement");
    expect(REVIEW_CONTRACTS.evidence.outOfScope).toContain("Product desirability");
    expect(REVIEW_CONTRACTS.architecture.outOfScope).toContain("Repository coding style");
    expect(REVIEW_CONTRACTS.architecture.checks.join("\n")).toContain("Fallback is default-deny");
    expect(REVIEW_CONTRACTS.architecture.checks.join("\n")).toContain("Composition roots and app entry Modules remain thin");
    expect(REVIEW_CONTRACTS.architecture.checks.join("\n")).toContain("one-function files");
    for (const axis of Object.keys(REVIEW_CONTRACTS) as ReviewAxis[]) {
      expect(REVIEW_CONTRACTS[axis].checks.length).toBeGreaterThan(4);
      expect(REVIEW_CONTRACTS[axis].blockerThreshold.length).toBeGreaterThan(2);
    }
  });

  it("builds an axis-bound prompt with identity, revision, surface, scope, and submit instruction", () => {
    const prompt = buildPrdReviewPrompt({
      axis: "architecture",
      workItemRoot: "/repo/.forge/work-items/x",
      prdPath: "/repo/.forge/work-items/x/prd/PRD.md",
      repositoryRoot: "/repo",
      repositoryRevision: "abc",
      prdGeneration: 2,
      surfaceHash: "surface-hash",
      bindingId: "binding-1",
    });
    expect(prompt).toContain("independent Forge PRD architecture reviewer");
    expect(prompt).toContain("Binding ID: binding-1");
    expect(prompt).toContain("Review surface hash: surface-hash");
    expect(prompt).toContain("Out of scope:");
    expect(prompt).toContain("Proportionality Policy");
    expect(prompt).toContain("Passing with no findings is valid");
    expect(prompt).toContain("Submit exactly one structured forge_prd_review");
  });

  it("builds a verifier prompt that cannot become a fourth general review", () => {
    const prompt = buildBlockerVerificationPrompt({
      workItemRoot: "/repo/.forge/work-items/x",
      prdPath: "/repo/.forge/work-items/x/prd/PRD.md",
      repositoryRoot: "/repo",
      repositoryRevision: "abc",
      prdGeneration: 1,
      bindingId: "verify-1",
      findings: [{
        id: "F-ARCH-001",
        severity: "blocker",
        message: "Missing seam",
        evidence: ["src/client.ts#createClient"],
        violatedRule: "Design requires an existing seam",
        verification: "Read createClient",
        suggestedResolution: "Name the smallest existing createClient seam",
      }],
    });
    expect(prompt).toContain("Verify only these Blockers");
    expect(prompt).toContain("Do not run a general fourth review");
    expect(prompt).toContain("reachable, contract-bound failure");
    expect(prompt).toContain("F-ARCH-001");
  });

  it("keeps behavior-only changes on the Coverage surface", () => {
    const base = prd();
    const changed = structuredClone(base);
    changed.behavior.errorPaths = ["Reject invalid before client creation", "Show a CLI error"];
    const before = allReviewSurfaceHashes(base);
    const after = allReviewSurfaceHashes(changed);
    expect(after.coverage).not.toBe(before.coverage);
    expect(after.evidence).toBe(before.evidence);
    expect(after.architecture).toBe(before.architecture);
  });

  it("requires structured unique Finding IDs for new reviews", () => {
    const surfaceHash = allReviewSurfaceHashes(prd()).coverage;
    const review: PrdReview = {
      axis: "coverage",
      verdict: "blocked",
      surfaceHash,
      reviewerId: "reviewer-1",
      submittedAt: new Date().toISOString(),
      findings: [
        { id: "F-COV-001", severity: "blocker", message: "Missing error path", evidence: ["PRD#Behavior"], violatedRule: "Error paths must be explicit", verification: "Read PRD Behavior", suggestedResolution: "Add only the missing reachable error path" },
        { id: "F-COV-001", severity: "warning", message: "Duplicate id", evidence: [], violatedRule: "IDs are unique", verification: "Compare findings" },
      ],
    };
    expect(() => validateReview(review, "coverage", surfaceHash)).toThrow("Duplicate coverage finding id");
  });
});
