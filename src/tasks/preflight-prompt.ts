import { join } from "node:path";
import type { TaskPreflightProposal } from "./preflight-types.js";
import { minimalImplementationPolicyLines } from "../policy/minimal-implementation.js";

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
    `Repository root: ${input.proposal.source.repositoryRoot}`,
    `Repository revision: ${input.proposal.source.repositoryRevision}`,
    "",
    "Question: Can every proposed Worker implement its Task directly from versioned Task-contract fields and the declared exact Reads, without repository investigation, design choices, inferred fallback behavior, or unrelated edits?",
    "",
    "Required policy:",
    "- Bias toward more, smaller, useful commits. One Task is one directly executable edit package.",
    "- A Task normally has one or two exact Reads and one primary Write.",
    "- A second Write is allowed for an inseparable focused test or build registration.",
    "- Three Writes require proof that a smaller intermediate Task could not build or verify.",
    "- Sequential Tasks may edit the same file when each creates a verified useful commit.",
    "- The Blueprint must name the exact edit or insertion point, existing symbols to reuse, value flow, changed condition, unchanged branches, focused assertion or verification, and forbidden adjacent scope.",
    "- Split when implementation, diagnostics, fallback preservation, independent test matrices, migration, or consumer updates can be separately implemented and verified.",
    "- A Worker must not need to search for callers, choose among designs, invent error semantics, infer a test seam, or reopen the Issue/PRD.",
    ...minimalImplementationPolicyLines(),
    "",
    "Review procedure:",
    "1. Read the Proposal and Issue artifact.",
    "2. For each Task, inspect only its declared exact Reads in the repository. Do not perform open-ended codebase search.",
    "3. Check that the named symbols exist at the frozen repository revision and that the Blueprint closes the implementation decisions.",
    "4. Check the Minimal Implementation Policy, especially default-deny Fallback and whether cohesive behavior is placed in its owning Module rather than accumulated in an app/composition-root file or fragmented into pass-through files.",
    "5. Check whether the Task can be split into smaller independently verifiable commits. Prefer splitting unless the intermediate state would fail to build or verify.",
    "6. Check Produces/Consumes ordering and whether each focused verification proves that Task's result.",
    "",
    "Blocker threshold:",
    "- Use Blocker when a Worker would need investigation or design, the Task combines independently committable edits, Reads omit required context, Blueprint leaves behavior to inference, adds an unauthorized Fallback, accumulates cohesive behavior in an app/composition-root file despite a proven owner, creates pass-through file fragmentation, or the verification cannot prove the promised artifact.",
    "- Use Warning for a concrete improvement that does not prevent direct execution.",
    "- Do not block only because a different style or architecture is preferred.",
    "",
    "For every finding, identify one Task ID and cite concrete Proposal fields or repository path#symbol evidence. suggestedResolution must state how to split or what exact Blueprint information is missing.",
    "Do not modify files. Do not freeze Tasks. Do not call ordinary Agent, Explore, or Plan.",
    `Call forge_tasks_preflight_submit exactly once with workItemRoot, issueId, Binding ID, Proposal Hash, verdict, and structured findings, then stop.`,
  ].join("\n");
}
