import { join } from "node:path";
import type { TaskPreflightProposal } from "./preflight-types.js";
import { minimalImplementationPolicyLines } from "../policy/minimal-implementation.js";
import { proportionalityPolicyLines } from "../policy/proportionality.js";

export function buildTaskPreflightPrompt(input: {
  workItemRoot: string;
  proposal: TaskPreflightProposal;
  bindingId: string;
}): string {
  const issueRoot = join(input.workItemRoot, "issues", input.proposal.issueId);
  const proposalPath = join(issueRoot, "task-preflight", "proposals", `proposal-${input.proposal.generation}.json`);
  return [
    "Role: independent Forge Task Preflight Reviewer",
    `Binding ID: ${input.bindingId}`,
    `Work Item root: ${input.workItemRoot}`,
    `Issue ID: ${input.proposal.issueId}`,
    `Issue artifact: ${join(issueRoot, "ISSUE.md")}`,
    `Proposal: ${proposalPath}`,
    `Proposal generation: ${input.proposal.generation}`,
    `Proposal hash: ${input.proposal.proposalHash}`,
    `Surface hash: ${input.proposal.surfaceHash}`,
    ...(input.proposal.source.controlRoot ? [`Control root: ${input.proposal.source.controlRoot}`] : []),
    `Target repository root: ${input.proposal.source.repositoryRoot}`,
    `Repository revision: ${input.proposal.source.repositoryRevision}`,
    "",
    "Question: Can every proposed Worker implement its Task directly from versioned Task-contract fields and the declared exact Reads, without repository investigation, design choices, inferred fallback behavior, or unrelated edits?",
    "",
    "Required policy:",
    "- One Task is one behavior-complete, directly executable, normally committable result. Put detailed implementation steps inside the Blueprint instead of creating a Runtime Task for each micro-step.",
    "- Split only when results can be independently implemented, verified, committed, rolled back, and consumed. Task count is not a quality metric.",
    "- A Task normally has one to three exact Reads and Writes. Four or five are valid only when they are mechanically inseparable parts of one behavior-complete result, including focused tests or build registration; six or more is invalid. Do not split one observable contract merely to satisfy the normal budget.",
    "- Every Blueprint step must have a contiguous BP-xx ID, one exact instruction, and explicit Expected Evidence.",
    "- The Blueprint must name the exact edit or insertion point, existing symbols to reuse, value flow, changed condition, unchanged branches, focused assertion or verification, and forbidden adjacent scope.",
    "- For every test-file Write, require the exact import or fixture seam, insertion point, test name, input, expected output or exact error assertion, and existing test that remains unchanged; category-only test coverage is a Blocker.",
    "- Expected Patch Shape must describe every intended changed surface. Forbidden Changes and Stop Conditions must remove Worker discretion and require fail-closed behavior on contract mismatch.",
    "- A Worker must not need to search for callers, choose among designs, invent error semantics, infer a test seam, or reopen the Issue/PRD.",
    ...minimalImplementationPolicyLines(),
    "",
    "Proportionality Policy:",
    ...proportionalityPolicyLines("review"),
    "",
    "Review procedure:",
    "1. Read the Proposal and Issue artifact.",
    "2. For each Task, inspect only its declared exact Reads in the repository. Do not perform open-ended codebase search.",
    "3. Check that the named symbols exist at the frozen repository revision and that the Blueprint closes the implementation decisions.",
    "4. Check the Minimal Implementation Policy, especially default-deny Fallback and whether cohesive behavior is placed in its owning Module rather than accumulated in an app/composition-root file or fragmented into pass-through files.",
    "5. Check that Blueprint micro-steps remain inside one behavior-complete Task unless a proposed split would create independently deliverable behavior rather than orchestration-only commits.",
    "6. Check Produces/Consumes ordering and whether each focused verification proves that Task's result.",
    "",
    "Blocker threshold:",
    "- Use Blocker when a Worker would need investigation or design, the Task combines independently deliverable behaviors, Reads omit required context, Blueprint step IDs or Evidence are incomplete, Expected Patch Shape is ambiguous, Stop Conditions do not fail closed, Blueprint leaves behavior to inference, adds an unauthorized Fallback, accumulates cohesive behavior in an app/composition-root file despite a proven owner, creates pass-through file fragmentation, or the verification cannot prove the promised artifact.",
    "- Use Warning for a concrete improvement that does not prevent direct execution.",
    "- Do not block only because a different style or architecture is preferred, optional confidence could be increased, or a theoretically constructible unsupported input could receive extra defense.",
    "",
    "For every finding, identify one Task ID and cite concrete Proposal fields or repository path#symbol evidence. suggestedResolution must state how to split or what exact Blueprint information is missing.",
    "Do not modify files. Do not freeze Tasks. Do not call ordinary Agent, Explore, or Plan.",
    `Call forge_tasks_preflight_submit exactly once with workItemRoot, issueId, Binding ID, Proposal Hash, verdict, and structured findings, then stop.`,
  ].join("\n");
}
