import type { ForgePrd } from "../work-item/types.js";
import type { IssueArtifact, IssuesManifest } from "./types.js";
import { minimalImplementationPolicyLines } from "../policy/minimal-implementation.js";

function bullets(items: string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- None";
}

export function renderIssue(issue: IssueArtifact, prd: ForgePrd): string {
  const acceptance = issue.acceptanceIds.map((id) => prd.acceptance.find((item) => item.id === id)!).filter(Boolean);
  const evidence = issue.impactEvidenceIds.map((id) => prd.impactEvidence.find((item) => item.id === id)!).filter(Boolean);
  const decisions = issue.decisionIds.map((id) => prd.decisions.find((item) => item.id === id)!).filter(Boolean);
  return `# ${issue.id}: ${issue.title}

## Delivery Boundary

- **${issue.deliveryBoundaryId}**

## Goal

${issue.goal}

## Delivery Outcome

${issue.deliveryOutcome}

## Scope

${bullets(issue.scope)}

## Non-goals

${bullets(issue.nonGoals)}

## Acceptance

${acceptance.map((item) => `- **${item.id}** — ${item.statement}\n  - Verification: ${item.verification.join("; ")}`).join("\n")}

## Behavior Slice

### Happy Path

${bullets(issue.behavior.happyPath)}

### Error Paths

${bullets(issue.behavior.errorPaths)}

### Edge Cases

${bullets(issue.behavior.edgeCases)}

## Design Decisions

${decisions.length > 0 ? decisions.map((item) => `- **${item.id}** — ${item.decision}`).join("\n") : "- None"}

## Impact Evidence

${evidence.map((item) => `- **${item.id}** — \`${item.path}#${item.symbol}\`: ${item.claim}`).join("\n")}

## Test Seams

${bullets(issue.testSeamNames)}

## Task Planning Constraints

Use the Design Decisions and Impact Evidence above as frozen architecture input. Trace Task order from entry/input through transformation and the owning Module to downstream consumers, side effects, and observable Test Seams. Do not reopen Module ownership, dependency direction, Fallback semantics, or public Interface decisions.

${minimalImplementationPolicyLines().join("\n")}

## Authoritative Verification

${bullets(issue.verification)}

## Dependencies

${bullets(issue.dependencies)}

---

Target Repository: \`${issue.source.repositoryRoot}\` at \`${issue.source.repositoryRevision}\`

Source: PRD Generation ${issue.source.prdGeneration} — \`${issue.source.prdHash}\`
`;
}

export function renderIssuesIndex(manifest: IssuesManifest): string {
  return `# Issues Manifest

Source PRD: Generation ${manifest.source.prdGeneration} — \`${manifest.source.prdHash}\`

## Issues

${manifest.issues.map((issue) => `- **${issue.id}** — [${issue.title}](${issue.id}/ISSUE.md)\n  - Acceptance: ${issue.acceptanceIds.join(", ")}\n  - Dependencies: ${issue.dependencies.join(", ") || "none"}`).join("\n")}

## Acceptance Traceability

${Object.entries(manifest.acceptanceTraceability).map(([acceptanceId, issueIds]) => `- **${acceptanceId}** → ${issueIds.join(", ")}`).join("\n")}
`;
}
