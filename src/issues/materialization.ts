import type { ForgePrd } from "../work-item/types.js";
import type { IssueDraft } from "./types.js";

function issueId(index: number): string {
  return `I${String(index + 1).padStart(3, "0")}`;
}

export function materializeIssueDrafts(prd: ForgePrd): IssueDraft[] {
  const boundaryIndexes = new Map(prd.deliveryBoundaries.map((boundary, index) => [boundary.id, index]));
  return prd.deliveryBoundaries.map((boundary, index) => ({
    id: issueId(index),
    deliveryBoundaryId: boundary.id,
    title: boundary.title,
    goal: boundary.goal,
    deliveryOutcome: boundary.outcome,
    scope: structuredClone(boundary.scope),
    nonGoals: structuredClone(boundary.nonGoals),
    acceptanceIds: structuredClone(boundary.acceptanceIds),
    behavior: structuredClone(boundary.behavior),
    decisionIds: structuredClone(boundary.decisionIds),
    impactEvidenceIds: structuredClone(boundary.impactEvidenceIds),
    testSeamNames: structuredClone(boundary.testSeamNames),
    verification: structuredClone(boundary.verification),
    dependencies: boundary.dependencies.map((dependency) => {
      const dependencyIndex = boundaryIndexes.get(dependency);
      if (dependencyIndex === undefined) throw new Error(`${boundary.id} references unknown Delivery Boundary ${dependency}`);
      return issueId(dependencyIndex);
    }),
  }));
}
