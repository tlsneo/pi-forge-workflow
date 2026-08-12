import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { WorkItemService } from "../src/work-item/service.js";
import type { ForgePrd, ReviewAxis } from "../src/work-item/types.js";

const root = resolve(".prototype-prd");
await rm(root, { recursive: true, force: true });
const revision = "demo-revision";
const service = new WorkItemService(root);
await service.initialize({
  workItemId: "demo-cli-timeout",
  title: "CLI timeout",
  repositoryRoot: process.cwd(),
  repositoryRevision: revision,
});

const evidence = [{
  id: "E1",
  path: "src/config.ts",
  symbol: "AppConfig",
  claim: "The HTTP client factory consumes AppConfig.",
  repositoryRevision: revision,
}];
await service.checkpoint({
  decisions: [{
    id: "Q1",
    question: "Which timeout unit is public?",
    dependsOn: [],
    status: "answered",
    recommendedAnswer: "Milliseconds",
    answer: "Milliseconds",
    answerSource: "user",
  }],
  evidence,
  summary: "Timeout behavior and configuration ownership are settled.",
  status: "drafting",
});

const prd: ForgePrd = {
  title: "CLI timeout",
  problem: "CLI users cannot bound request duration.",
  solution: "Accept a timeout and carry it through configuration to the HTTP client.",
  goals: ["Apply an explicit timeout"],
  nonGoals: ["Change retry behavior"],
  actors: ["CLI user"],
  userStories: [{ id: "US-01", actor: "a CLI user", capability: "set a timeout", benefit: "hung requests stop predictably" }],
  acceptance: [{ id: "AC-01", statement: "The configured timeout reaches the HTTP client", verification: ["CLI integration test"] }],
  behavior: { happyPath: ["Parse", "configure", "apply"], errorPaths: ["Reject invalid values"], edgeCases: ["Omission preserves defaults"] },
  decisions: [{ id: "D-01", decision: "Carry timeout through AppConfig", rationale: "It is the existing seam", evidenceIds: ["E1"] }],
  impactEvidence: evidence,
  testSeams: [{ name: "CLI integration", level: "integration", evidenceIds: ["E1"], verification: "Assert the exact client timeout" }],
  risks: [{ risk: "Unit mismatch", mitigation: "Use timeoutMs throughout" }],
  deliveryBoundaries: [{ id: "DB-01", title: "Deliver CLI timeout", outcome: "The configured timeout behavior is independently delivered.", goal: "The configured timeout behavior is independently delivered.", scope: ["The configured timeout behavior is independently delivered."], acceptanceIds: ["AC-01"], behavior: { happyPath: ["Parse", "configure", "apply"], errorPaths: ["Reject invalid values"], edgeCases: ["Omission preserves defaults"] }, decisionIds: ["D-01"], impactEvidenceIds: ["E1"], testSeamNames: ["CLI integration"], nonGoals: ["Change retry behavior"], verification: ["CLI integration test", "Assert the exact client timeout"], dependencies: [], independentlyDeliverable: true, rationale: "One coherent delivery boundary." }],
  rollback: "Revert the option and mapping.",
  diagrams: [{ kind: "flow", title: "Timeout flow", rationale: "The value crosses modules.", mermaid: "flowchart LR\n  CLI --> Config\n  Config --> Client" }],
  openQuestions: [],
};
const submitted = await service.submitPrd(prd);
const generation = submitted.currentPrd!;
for (const axis of ["coverage", "evidence", "architecture"] as ReviewAxis[]) {
  await service.submitReview({ axis, verdict: "passed", surfaceHash: generation.reviewSurfaceHashes[axis], reviewerId: `${axis}-demo`, findings: [] });
}
await service.approve({ approvedBy: "demo-user", evidence: "Approved in the demo" });
await service.freeze();
console.log(JSON.stringify(await service.open(), null, 2));
console.log(`Generated ${resolve(root, "PRD.md")}`);
