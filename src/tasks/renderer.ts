import type { IssueArtifact } from "../issues/types.js";
import { normalizeBlueprintSteps } from "../runtime/blueprint.js";
import type { TaskContract } from "../runtime/types.js";
import type { SliceDraft } from "./types.js";
import { minimalImplementationPolicyLines } from "../policy/minimal-implementation.js";

function bullets(items: string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- None";
}

export function renderTask(contract: TaskContract, issue: IssueArtifact): string {
  const version = contract.version;
  return `# ${contract.id}@V${String(version).padStart(3, "0")}: ${contract.title}

## Goal

${contract.goal}

## Issue Context

- Issue: **${issue.id} — ${issue.title}**
- Slice: **${contract.sliceId}**
- Acceptance: ${contract.acceptance.join(", ")}
- Task Version: **V${String(version).padStart(3, "0")}**
- Contract Hash: \`${contract.contractHash}\`
- Target Repository: \`${issue.source.repositoryRoot}\`
- Repository Revision: \`${issue.source.repositoryRevision}\`

## Exact Context

### Primary Edit Point

- \`${contract.editPoint?.path}#${contract.editPoint?.symbol}\`

### Reads

${(contract.reads ?? []).map((read) => `- \`${read.path}#${read.symbol}\` — ${read.reason}`).join("\n")}

### Writes

${bullets(contract.writes.map((path) => `\`${path}\``))}

## Implementation Blueprint

${normalizeBlueprintSteps(contract).map((step) => `### ${step.id}\n\n${step.instruction}\n\nExpected Evidence:\n${bullets(step.expectedEvidence)}`).join("\n\n")}

## Expected Patch Shape

${bullets(contract.expectedPatchShape ?? [])}

## Forbidden Changes

${bullets(contract.forbiddenChanges ?? [])}

## Stop Conditions

${bullets(contract.stopConditions ?? [])}

If any Stop Condition is true, checkpoint the mismatch and stop without improvising.

## Minimal Implementation Policy

${minimalImplementationPolicyLines().join("\n")}

## Dependencies and Artifacts

- Dependencies: ${contract.dependencies.join(", ") || "none"}
- Conflicts: ${contract.conflicts.join(", ") || "none"}
- Consumes: ${contract.consumes.join(", ") || "none"}
- Produces: ${contract.produces.join(", ")}

## Out of Scope

${bullets(contract.outOfScope ?? [])}

## Authoritative Verification

${contract.verification.map((item) => `- \`${item.command}\` — timeout ${item.timeoutMs}ms`).join("\n")}

## Worker Protocol

1. Call \`task_resume\` with the Runtime root and Binding ID before reading anything else.
2. Read only this contract, its exact Reads, and any frozen Correction Context returned by \`task_resume\`.
3. Execute every Blueprint Step in order. The Task contract owns all implementation decisions.
4. If a Stop Condition or contract mismatch occurs, checkpoint it and stop without an implementation Handoff.
5. Map every completed Blueprint Step to concrete Evidence in \`task_handoff\`.
6. Submit one \`task_handoff\`, then stop. Agent completion alone does not complete this Task.
`;
}

export function renderSlice(slice: SliceDraft): string {
  return `# ${slice.id}: ${slice.title}

${slice.goal}

## Acceptance

${bullets(slice.acceptanceIds)}

## Tasks

${bullets(slice.taskIds)}

## Slice Gate

${slice.gate.map((gate) => `- \`${gate.command}\` — ${gate.proves} — timeout ${gate.timeoutMs}ms`).join("\n")}
`;
}
