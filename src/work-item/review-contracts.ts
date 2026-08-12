import type { BlockerVerificationStatus, ReviewAxis } from "./types.js";

export interface ReviewContract {
  axis: ReviewAxis;
  question: string;
  checks: string[];
  outOfScope: string[];
  blockerThreshold: string[];
}

export const REVIEW_CONTRACTS: Record<ReviewAxis, ReviewContract> = {
  coverage: {
    axis: "coverage",
    question: "Does the PRD completely and objectively define the behavior to build?",
    checks: [
      "Problem and Solution describe the same user problem",
      "Actors and User Stories cover affected roles",
      "Every user-visible behavior has a stable Acceptance ID",
      "Acceptance statements and verification plans are objective",
      "Happy, error, edge, omission, compatibility, and non-goal behavior are explicit",
      "No behavior-changing phrase depends on interpretation",
      "The PRD does not silently expand beyond its goals",
    ],
    outOfScope: [
      "Repository path or Symbol existence",
      "Architecture optimality or Seam placement",
      "Code style, implementation detail, or Task decomposition",
    ],
    blockerThreshold: [
      "Missing or contradictory required behavior",
      "Acceptance cannot be objectively verified",
      "Ambiguity permits materially different implementations",
    ],
  },
  evidence: {
    axis: "evidence",
    question: "Are the PRD's claims about the current repository true at the bound revision?",
    checks: [
      "Every cited path and Symbol exists at the bound revision",
      "Each claim accurately describes current responsibility",
      "Entry, call chain, data flow, consumers, Adapters, schemas, configuration, and fixtures are represented",
      "Test Seams exist and can observe the claimed behavior",
      "Future design is not described as current-code fact",
      "Evidence IDs, revision bindings, and PRD references are consistent",
    ],
    outOfScope: [
      "Product desirability",
      "User Story completeness",
      "Architecture preference unless the claimed current Seam is absent",
    ],
    blockerThreshold: [
      "A material code claim is false or stale",
      "A behaviorally relevant consumer or dependency is missing",
      "Evidence cannot support implementation or verification",
    ],
  },
  architecture: {
    axis: "architecture",
    question: "Is the selected design the minimum sufficient design for the current repository and frozen behavior?",
    checks: [
      "The change belongs to the selected Module and existing Seam",
      "Dependency direction and ownership remain coherent",
      "Existing Interfaces and Helpers are reused",
      "New Interfaces correspond to real variation or an approved public contract",
      "Fallback is default-deny: every fallback, silent recovery, default substitution, compatibility path, catch-and-continue branch, or swallowed error is explicitly required and verifiable",
      "The design avoids speculative extension, duplication, pass-through Modules, and unnecessary dependencies",
      "Composition roots and app entry Modules remain thin; cohesive behavior belongs to an owning Module without fragmenting trivial behavior into one-function files",
      "Data flow, public Interface, migration, rollback, locality, and testability are complete",
      "No known simpler design satisfies the same Acceptance and constraints",
    ],
    outOfScope: [
      "Rewriting product scope",
      "Repository coding style",
      "General evidence review except a missing claimed Seam that makes the design impossible",
    ],
    blockerThreshold: [
      "Acceptance cannot be implemented by the selected design",
      "The design depends on a nonexistent or forbidden Seam",
      "A proven architecture invariant is violated",
      "Public Interface, migration, compatibility, or security policy remains undecided",
      "The design introduces an unauthorized Fallback or silent recovery path",
      "Cohesive behavior is accumulated in an app/composition-root Module despite a proven owner, or fragmented into pass-through Modules without depth",
      "A clearly simpler sufficient alternative exists",
    ],
  },
};

export const BLOCKER_VERIFICATION_STATUSES = ["confirmed", "rejected", "needs_more_evidence"] as const;

export interface BlockerVerificationResult {
  findingId: string;
  status: BlockerVerificationStatus;
  evidence: string[];
  rationale: string;
  missingEvidence?: string[];
}
