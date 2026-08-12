import { stableHash } from "../runtime/hash.js";
import type { ForgePrd, ReviewAxis } from "./types.js";

export function reviewSurface(prd: ForgePrd, axis: ReviewAxis): unknown {
  switch (axis) {
    case "coverage":
      return {
        title: prd.title,
        problem: prd.problem,
        solution: prd.solution,
        goals: prd.goals,
        nonGoals: prd.nonGoals,
        actors: prd.actors,
        userStories: prd.userStories,
        acceptance: prd.acceptance.map(({ id, statement }) => ({ id, statement })),
        behavior: prd.behavior,
        deliveryBoundaries: prd.deliveryBoundaries.map(({ id, title, outcome, goal, scope, acceptanceIds, behavior, dependencies, independentlyDeliverable, rationale }) => ({ id, title, outcome, goal, scope, acceptanceIds, behavior, dependencies, independentlyDeliverable, rationale })),
        openQuestions: prd.openQuestions,
      };
    case "evidence":
      return {
        acceptanceVerification: prd.acceptance.map(({ id, verification }) => ({ id, verification })),
        impactEvidence: prd.impactEvidence,
        testSeams: prd.testSeams,
        deliveryBoundaries: prd.deliveryBoundaries.map(({ id, acceptanceIds, decisionIds, impactEvidenceIds, testSeamNames, verification }) => ({ id, acceptanceIds, decisionIds, impactEvidenceIds, testSeamNames, verification })),
      };
    case "architecture":
      return {
        solution: prd.solution,
        decisions: prd.decisions,
        risks: prd.risks,
        migration: prd.migration ?? null,
        rollback: prd.rollback ?? null,
        diagrams: prd.diagrams,
        deliveryBoundaries: prd.deliveryBoundaries,
        evidence: prd.impactEvidence.map(({ id, path, symbol, claim }) => ({ id, path, symbol, claim })),
      };
  }
}

export function reviewSurfaceHash(prd: ForgePrd, axis: ReviewAxis): string {
  return stableHash(reviewSurface(prd, axis));
}

export function allReviewSurfaceHashes(prd: ForgePrd): Record<ReviewAxis, string> {
  return {
    coverage: reviewSurfaceHash(prd, "coverage"),
    evidence: reviewSurfaceHash(prd, "evidence"),
    architecture: reviewSurfaceHash(prd, "architecture"),
  };
}
