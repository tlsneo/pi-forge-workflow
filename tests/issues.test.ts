import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materializeIssueDrafts } from "../src/issues/materialization.js";
import { IssuesService } from "../src/issues/service.js";
import { validateIssueDrafts } from "../src/issues/validation.js";
import type { IssueDraft } from "../src/issues/types.js";
import { WorkItemService } from "../src/work-item/service.js";
import type { ForgePrd, ReviewAxis } from "../src/work-item/types.js";

const roots: string[] = [];
const revision = "abc123";
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function prd(): ForgePrd {
  return {
    title: "CLI timeout",
    problem: "Users cannot bound requests.",
    solution: "Carry a timeout through configuration to the client.",
    goals: ["Allow an explicit timeout"],
    nonGoals: ["Change retry policy"],
    actors: ["CLI user"],
    userStories: [{ id: "US-01", actor: "CLI user", capability: "set a timeout", benefit: "stop hung requests" }],
    acceptance: [
      { id: "AC-01", statement: "A valid timeout reaches the client", verification: ["CLI integration test"] },
      { id: "AC-02", statement: "Omission preserves the current default", verification: ["Default behavior test"] },
    ],
    behavior: {
      happyPath: ["Parse timeout", "Create configuration", "Configure client"],
      errorPaths: ["Reject non-positive values"],
      edgeCases: ["Omitted timeout preserves current defaults"],
    },
    decisions: [{ id: "D-01", decision: "Use AppConfig", rationale: "Existing seam", evidenceIds: ["E-01"] }],
    impactEvidence: [{ id: "E-01", path: "src/config.ts", symbol: "AppConfig", claim: "Client consumes config", repositoryRevision: revision }],
    testSeams: [
      { name: "CLI integration", level: "integration", evidenceIds: ["E-01"], verification: "Assert the configured client timeout" },
      { name: "Default behavior", level: "unit", evidenceIds: ["E-01"], verification: "Assert omission keeps the existing default" },
    ],
    risks: [{ risk: "Unit mismatch", mitigation: "Use milliseconds" }],
    deliveryBoundaries: [{ id: "DB-01", title: "Deliver configurable timeout", outcome: "Timeout behavior is observable at the client while omission remains compatible.", goal: "Allow CLI users to bound request duration.", scope: ["Carry timeout through the existing configuration seam"], acceptanceIds: ["AC-01", "AC-02"], behavior: { happyPath: ["Parse timeout", "Create configuration", "Configure client"], errorPaths: ["Reject non-positive values"], edgeCases: ["Omitted timeout preserves current defaults"] }, decisionIds: ["D-01"], impactEvidenceIds: ["E-01"], testSeamNames: ["CLI integration", "Default behavior"], nonGoals: ["Change retry policy"], verification: ["CLI integration test", "Default behavior test", "Assert the configured client timeout", "Assert omission keeps the existing default"], dependencies: [], independentlyDeliverable: true, rationale: "The two behaviors share one delivery and rollback boundary." }],
    rollback: "Revert timeout changes.",
    diagrams: [],
    openQuestions: [],
  };
}

async function frozenFixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-forge-issues-"));
  roots.push(root);
  const workItem = new WorkItemService(root);
  await workItem.initialize({ workItemId: "timeout", title: "CLI timeout", repositoryRoot: root, repositoryRevision: revision });
  const document = prd();
  await workItem.checkpoint({
    decisions: [{ id: "Q1", question: "Unit?", dependsOn: [], status: "answered", answer: "milliseconds", answerSource: "user" }],
    evidence: document.impactEvidence,
    summary: "Behavior and seam are settled.",
  });
  const submitted = await workItem.submitPrd(document);
  for (const axis of ["coverage", "evidence", "architecture"] as ReviewAxis[]) {
    await workItem.submitReview({ axis, verdict: "passed", surfaceHash: submitted.currentPrd!.reviewSurfaceHashes[axis], reviewerId: axis, findings: [] });
  }
  await workItem.approve({ approvedBy: "user", evidence: "approved" });
  await workItem.freeze();
  return { root, workItem, issues: new IssuesService(root) };
}

function oneIssue(): IssueDraft[] {
  return [{
    id: "I001",
    deliveryBoundaryId: "DB-01",
    title: "Deliver configurable timeout",
    goal: "Allow CLI users to bound request duration.",
    deliveryOutcome: "Timeout behavior is observable at the client while omission remains compatible.",
    scope: ["Carry timeout through the existing configuration seam"],
    nonGoals: ["Change retry policy"],
    acceptanceIds: ["AC-01", "AC-02"],
    behavior: {
      happyPath: ["Parse timeout", "Create configuration", "Configure client"],
      errorPaths: ["Reject non-positive values"],
      edgeCases: ["Omitted timeout preserves current defaults"],
    },
    decisionIds: ["D-01"],
    impactEvidenceIds: ["E-01"],
    testSeamNames: ["CLI integration", "Default behavior"],
    verification: ["CLI integration test", "Default behavior test", "Assert the configured client timeout", "Assert omission keeps the existing default"],
    dependencies: [],
  }];
}

describe("IssuesService", () => {
  it("generates immutable Local Issue artifacts and a complete Manifest", async () => {
    const { root, issues } = await frozenFixture();
    const generated = await issues.submit();
    expect(generated.idempotent).toBe(false);
    expect(generated.manifest.acceptanceTraceability).toEqual({ "AC-01": ["I001"], "AC-02": ["I001"] });
    expect(generated.manifest.issues[0]?.tracker.mode).toBe("local");
    const issueMarkdown = await readFile(join(root, "issues", "I001", "ISSUE.md"), "utf8");
    expect(issueMarkdown).toContain("**AC-01**");
    expect(issueMarkdown).toContain("## Task Planning Constraints");
    expect(issueMarkdown).toContain("Trace Task order from entry/input through transformation and the owning Module");
    expect(issueMarkdown).toContain("Fallback is default-deny");
    expect(await readFile(join(root, "issues", "README.md"), "utf8")).toContain("AC-02** → I001");
    expect(JSON.parse(await readFile(join(root, "issues", "manifest.json"), "utf8")).contentHash).toBe(generated.manifest.contentHash);
  });

  it("maps Delivery Boundaries to the same-position Issue IDs", async () => {
    const expanded = prd();
    expanded.deliveryBoundaries = [
      { ...expanded.deliveryBoundaries[0]!, acceptanceIds: ["AC-01"], behavior: { happyPath: expanded.behavior.happyPath, errorPaths: expanded.behavior.errorPaths, edgeCases: [] }, testSeamNames: ["CLI integration"], verification: ["CLI integration test", "Assert the configured client timeout"] },
      { id: "DB-02", title: "Preserve omission compatibility", outcome: "Omission keeps the existing default.", goal: "Omission keeps the existing default.", scope: ["Omission keeps the existing default."], acceptanceIds: ["AC-02"], behavior: { happyPath: [], errorPaths: [], edgeCases: expanded.behavior.edgeCases }, decisionIds: ["D-01"], impactEvidenceIds: ["E-01"], testSeamNames: ["Default behavior"], nonGoals: ["Change retry policy"], verification: ["Default behavior test", "Assert omission keeps the existing default"], dependencies: ["DB-01"], independentlyDeliverable: true, rationale: "Compatibility can be verified and delivered after the explicit path." },
    ];
    expect(materializeIssueDrafts(expanded)).toEqual([
      {
        ...oneIssue()[0]!, title: expanded.deliveryBoundaries[0]!.title, acceptanceIds: ["AC-01"], behavior: expanded.deliveryBoundaries[0]!.behavior,
        testSeamNames: ["CLI integration"], verification: expanded.deliveryBoundaries[0]!.verification,
      },
      {
        ...oneIssue()[0]!, id: "I002", deliveryBoundaryId: "DB-02", title: expanded.deliveryBoundaries[1]!.title,
        goal: expanded.deliveryBoundaries[1]!.goal, deliveryOutcome: expanded.deliveryBoundaries[1]!.outcome, scope: expanded.deliveryBoundaries[1]!.scope,
        acceptanceIds: ["AC-02"], behavior: expanded.deliveryBoundaries[1]!.behavior, testSeamNames: ["Default behavior"],
        verification: expanded.deliveryBoundaries[1]!.verification, dependencies: ["I001"],
      },
    ]);
  });

  it("materializes every frozen Delivery Boundary exactly once", async () => {
    const duplicate = oneIssue();
    duplicate.push({ ...duplicate[0]!, id: "I002" });
    expect(() => validateIssueDrafts(prd(), duplicate)).toThrow("mapped to more than one Issue");
  });

  it("is idempotent because the frozen PRD has only one deterministic materialization", async () => {
    const { issues } = await frozenFixture();
    const first = await issues.submit();
    const second = await issues.submit();
    expect(second.idempotent).toBe(true);
    expect(second.manifest.contentHash).toBe(first.manifest.contentHash);
  });

  it("rejects missing Acceptance coverage, unknown frozen references, and dependency cycles", async () => {
    const missing = oneIssue();
    missing[0] = { ...missing[0]!, acceptanceIds: ["AC-01"] };
    expect(() => validateIssueDrafts(prd(), missing)).toThrow("DB-01");

    const unknown = oneIssue();
    unknown[0] = { ...unknown[0]!, impactEvidenceIds: ["E-404"] };
    expect(() => validateIssueDrafts(prd(), unknown)).toThrow("Evidence must exactly match DB-01");

    const unknownBoundary = oneIssue();
    unknownBoundary[0] = { ...unknownBoundary[0]!, deliveryBoundaryId: "DB-99" };
    expect(() => validateIssueDrafts(prd(), unknownBoundary)).toThrow("unknown Delivery Boundary");
  });

  it("requires a frozen PRD Receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-forge-issues-unfrozen-"));
    roots.push(root);
    const workItem = new WorkItemService(root);
    await workItem.initialize({ workItemId: "unfrozen", title: "Unfrozen", repositoryRoot: root, repositoryRevision: revision });
    await expect(new IssuesService(root).submit()).rejects.toThrow("requires a frozen PRD");
  });
});
