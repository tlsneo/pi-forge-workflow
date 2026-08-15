import type { ForgePrd } from "../work-item/types.js";
import type { IssueDraft } from "./types.js";

function requireText(value: string, label: string): void {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
}

function requireUniqueTexts(values: string[], label: string, allowEmpty = false): void {
  if (!Array.isArray(values) || (!allowEmpty && values.length === 0)) throw new Error(`${label} must${allowEmpty ? "" : " not"} be empty`);
  const seen = new Set<string>();
  for (const value of values) {
    requireText(value, label);
    if (seen.has(value)) throw new Error(`${label} contains duplicate value: ${value}`);
    seen.add(value);
  }
}

function validateDependencyDag(issues: IssueDraft[]): void {
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string, stack: string[]): void => {
    if (visiting.has(id)) throw new Error(`Issue dependency cycle: ${[...stack, id].join(" -> ")}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) visit(dependency, [...stack, id]);
    visiting.delete(id);
    visited.add(id);
  };
  for (const issue of issues) visit(issue.id, []);
}

export function validateIssueDrafts(prd: ForgePrd, issues: IssueDraft[]): Record<string, string[]> {
  if (!Array.isArray(issues) || issues.length === 0) throw new Error("At least one Issue is required");
  const issueIds = new Set<string>();
  const boundaryIds = new Set(prd.deliveryBoundaries.map((boundary) => boundary.id));
  const usedBoundaries = new Set<string>();
  const acceptanceIds = new Set(prd.acceptance.map((item) => item.id));
  const decisionIds = new Set(prd.decisions.map((item) => item.id));
  const evidenceIds = new Set(prd.impactEvidence.map((item) => item.id));
  const testSeamNames = new Set(prd.testSeams.map((item) => item.name));
  const nonGoals = new Set(prd.nonGoals);
  const allowedVerification = new Set([
    ...prd.acceptance.flatMap((item) => item.verification),
    ...prd.testSeams.map((item) => item.verification),
  ]);
  const allowedBehavior = {
    happyPath: new Set(prd.behavior.happyPath),
    errorPaths: new Set(prd.behavior.errorPaths),
    edgeCases: new Set(prd.behavior.edgeCases),
  };

  for (const [index, issue] of issues.entries()) {
    const expectedId = `I${String(index + 1).padStart(3, "0")}`;
    if (issue.id !== expectedId) throw new Error(`Issue IDs must be contiguous and ordered; expected ${expectedId}, received ${issue.id}`);
    if (issueIds.has(issue.id)) throw new Error(`Duplicate Issue ID: ${issue.id}`);
    issueIds.add(issue.id);
    requireText(issue.deliveryBoundaryId, `${issue.id} deliveryBoundaryId`);
    if (!boundaryIds.has(issue.deliveryBoundaryId)) throw new Error(`${issue.id} references unknown Delivery Boundary ${issue.deliveryBoundaryId}`);
    if (usedBoundaries.has(issue.deliveryBoundaryId)) throw new Error(`Delivery Boundary ${issue.deliveryBoundaryId} is mapped to more than one Issue`);
    const expectedBoundaryId = `DB-${String(index + 1).padStart(2, "0")}`;
    if (issue.deliveryBoundaryId !== expectedBoundaryId) throw new Error(`${issue.id} must map to ${expectedBoundaryId}, received ${issue.deliveryBoundaryId}`);
    usedBoundaries.add(issue.deliveryBoundaryId);
    const boundary = prd.deliveryBoundaries.find((candidate) => candidate.id === issue.deliveryBoundaryId)!;
    requireText(issue.title, `${issue.id} title`);
    requireText(issue.goal, `${issue.id} goal`);
    if (issue.title !== boundary.title) throw new Error(`${issue.id} title must exactly match ${boundary.id}`);
    requireText(issue.deliveryOutcome, `${issue.id} deliveryOutcome`);
    requireUniqueTexts(issue.scope, `${issue.id} scope`);
    if (issue.goal !== boundary.goal) throw new Error(`${issue.id} goal must exactly match ${boundary.id}`);
    if (issue.deliveryOutcome !== boundary.outcome) throw new Error(`${issue.id} delivery outcome must exactly match ${boundary.id}`);
    if (JSON.stringify(issue.scope) !== JSON.stringify(boundary.scope)) throw new Error(`${issue.id} scope must exactly match ${boundary.id}`);
    requireUniqueTexts(issue.nonGoals, `${issue.id} nonGoals`, true);
    requireUniqueTexts(issue.acceptanceIds, `${issue.id} acceptanceIds`);
    requireUniqueTexts(issue.decisionIds, `${issue.id} decisionIds`, true);
    requireUniqueTexts(issue.impactEvidenceIds, `${issue.id} impactEvidenceIds`);
    requireUniqueTexts(issue.testSeamNames, `${issue.id} testSeamNames`);
    requireUniqueTexts(issue.verification, `${issue.id} verification`);
    requireUniqueTexts(issue.dependencies, `${issue.id} dependencies`, true);
    if (JSON.stringify(issue.acceptanceIds) !== JSON.stringify(boundary.acceptanceIds)) throw new Error(`${issue.id} Acceptance must exactly match ${boundary.id}`);
    if (JSON.stringify(issue.decisionIds) !== JSON.stringify(boundary.decisionIds)) throw new Error(`${issue.id} Decisions must exactly match ${boundary.id}`);
    if (JSON.stringify(issue.impactEvidenceIds) !== JSON.stringify(boundary.impactEvidenceIds)) throw new Error(`${issue.id} Evidence must exactly match ${boundary.id}`);
    if (JSON.stringify(issue.testSeamNames) !== JSON.stringify(boundary.testSeamNames)) throw new Error(`${issue.id} Test Seams must exactly match ${boundary.id}`);
    if (JSON.stringify(issue.nonGoals) !== JSON.stringify(boundary.nonGoals)) throw new Error(`${issue.id} Non-goals must exactly match ${boundary.id}`);
    if (JSON.stringify(issue.verification) !== JSON.stringify(boundary.verification)) throw new Error(`${issue.id} Verification must exactly match ${boundary.id}`);
    for (const kind of ["happyPath", "errorPaths", "edgeCases"] as const) if (JSON.stringify(issue.behavior[kind]) !== JSON.stringify(boundary.behavior[kind])) throw new Error(`${issue.id} ${kind} must exactly match ${boundary.id}`);
    const expectedDependencies = boundary.dependencies.map((id) => `I${String(prd.deliveryBoundaries.findIndex((candidate) => candidate.id === id) + 1).padStart(3, "0")}`);
    if (JSON.stringify(issue.dependencies) !== JSON.stringify(expectedDependencies)) throw new Error(`${issue.id} dependencies must derive from ${boundary.id}`);
    for (const value of issue.nonGoals) if (!nonGoals.has(value)) throw new Error(`${issue.id} references unknown PRD non-goal: ${value}`);
    for (const id of issue.acceptanceIds) if (!acceptanceIds.has(id)) throw new Error(`${issue.id} references unknown Acceptance: ${id}`);
    for (const id of issue.decisionIds) if (!decisionIds.has(id)) throw new Error(`${issue.id} references unknown Decision: ${id}`);
    for (const id of issue.impactEvidenceIds) if (!evidenceIds.has(id)) throw new Error(`${issue.id} references unknown Evidence: ${id}`);
    for (const name of issue.testSeamNames) if (!testSeamNames.has(name)) throw new Error(`${issue.id} references unknown Test Seam: ${name}`);
    for (const item of issue.verification) if (!allowedVerification.has(item)) throw new Error(`${issue.id} verification is not frozen in the PRD: ${item}`);
    for (const kind of ["happyPath", "errorPaths", "edgeCases"] as const) {
      requireUniqueTexts(issue.behavior[kind], `${issue.id} ${kind}`, true);
      for (const item of issue.behavior[kind]) if (!allowedBehavior[kind].has(item)) throw new Error(`${issue.id} ${kind} is not frozen in the PRD: ${item}`);
    }
  }

  const missingBoundaries = [...boundaryIds].filter((id) => !usedBoundaries.has(id));
  if (missingBoundaries.length > 0) throw new Error(`PRD Delivery Boundaries are not materialized as Issues: ${missingBoundaries.join(", ")}`);

  for (const issue of issues) {
    if (issue.dependencies.includes(issue.id)) throw new Error(`${issue.id} cannot depend on itself`);
    for (const dependency of issue.dependencies) if (!issueIds.has(dependency)) throw new Error(`${issue.id} depends on unknown Issue ${dependency}`);
  }
  validateDependencyDag(issues);

  const traceability: Record<string, string[]> = Object.fromEntries(prd.acceptance.map((acceptance) => [acceptance.id, []]));
  for (const issue of issues) for (const acceptanceId of issue.acceptanceIds) traceability[acceptanceId]!.push(issue.id);
  const uncovered = Object.entries(traceability).filter(([, mapped]) => mapped.length === 0).map(([id]) => id);
  if (uncovered.length > 0) throw new Error(`PRD Acceptance is not covered by any Issue: ${uncovered.join(", ")}`);
  return traceability;
}
