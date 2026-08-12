import type { IssueArtifact } from "../issues/types.js";
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

## Exact Context

### Primary Edit Point

- \`${contract.editPoint?.path}#${contract.editPoint?.symbol}\`

### Reads

${(contract.reads ?? []).map((read) => `- \`${read.path}#${read.symbol}\` — ${read.reason}`).join("\n")}

### Writes

${bullets(contract.writes.map((path) => `\`${path}\``))}

## Implementation Blueprint

${(contract.implementationBlueprint ?? []).map((step, index) => `${index + 1}. ${step}`).join("\n")}

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
2. Read only this contract and its exact Reads unless the Blueprint explicitly requires another generated artifact.
3. Do not redesign the Issue, Slice, Interface, error semantics, or test location.
4. Submit one \`task_handoff\`, then stop. Agent completion alone does not complete this Task.
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
