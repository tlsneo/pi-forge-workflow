import { proportionalityPolicyLines } from "../policy/proportionality.js";
import { REVIEW_CONTRACTS } from "./review-contracts.js";
import type { PrdFinding, ReviewAxis } from "./types.js";

export interface ReviewPromptInput {
  axis: ReviewAxis;
  workItemRoot: string;
  prdPath: string;
  repositoryRoot: string;
  repositoryRevision: string;
  prdGeneration: number;
  surfaceHash: string;
  bindingId: string;
}

function lines(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

export function buildPrdReviewPrompt(input: ReviewPromptInput): string {
  const contract = REVIEW_CONTRACTS[input.axis];
  return [
    `Role: independent Forge PRD ${input.axis} reviewer`,
    `Binding ID: ${input.bindingId}`,
    `Work Item root: ${input.workItemRoot}`,
    `PRD path: ${input.prdPath}`,
    `PRD Generation: ${input.prdGeneration}`,
    `Review surface hash: ${input.surfaceHash}`,
    `Repository root: ${input.repositoryRoot}`,
    `Repository revision: ${input.repositoryRevision}`,
    "",
    `Review question: ${contract.question}`,
    "",
    "Required checks:",
    lines(contract.checks),
    "",
    "Out of scope:",
    lines(contract.outOfScope),
    "",
    "A Blocker requires one of:",
    lines(contract.blockerThreshold),
    "",
    "Proportionality Policy:",
    ...proportionalityPolicyLines("review"),
    "",
    "Read only the frozen axis surface and the evidence needed by this contract. Do not modify files, redesign another axis, or expand scope.",
    "Submit exactly one structured forge_prd_review using this Binding ID and surface hash, then stop.",
  ].join("\n");
}

export interface BlockerPromptInput {
  workItemRoot: string;
  prdPath: string;
  repositoryRoot: string;
  repositoryRevision: string;
  prdGeneration: number;
  bindingId: string;
  findings: PrdFinding[];
}

export function buildBlockerVerificationPrompt(input: BlockerPromptInput): string {
  return [
    "Role: independent Forge PRD Blocker Verifier",
    `Binding ID: ${input.bindingId}`,
    `Work Item root: ${input.workItemRoot}`,
    `PRD path: ${input.prdPath}`,
    `PRD Generation: ${input.prdGeneration}`,
    `Repository root: ${input.repositoryRoot}`,
    `Repository revision: ${input.repositoryRevision}`,
    "",
    "Verify only these Blockers:",
    JSON.stringify(input.findings, null, 2),
    "",
    "Proportionality Policy:",
    ...proportionalityPolicyLines("review"),
    "",
    "For each Finding ID return confirmed, rejected, or needs_more_evidence. Confirm only a reachable, contract-bound failure whose verification changes the next action; reject optional-confidence or preference findings. Do not run a general fourth review, modify the PRD, or add unrelated findings.",
    "Submit exactly one structured forge_prd_verify_blockers result using this Binding ID, then stop.",
  ].join("\n");
}
