import type { CodeEvidence, DecisionNode, Diagram, ForgePrd, PrdReview, ReviewAxis } from "./types.js";

const REVIEW_AXES: ReviewAxis[] = ["coverage", "evidence", "architecture"];

function requireText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
}

function requireArray(value: unknown, label: string): asserts value is unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
}

function requireUniqueTexts(values: string[], label: string, allowEmpty = false): void {
  requireArray(values, label);
  if (!allowEmpty && values.length === 0) throw new Error(`${label} must not be empty`);
  const seen = new Set<string>();
  for (const value of values) {
    requireText(value, label);
    if (seen.has(value)) throw new Error(`${label} contains duplicate value: ${value}`);
    seen.add(value);
  }
}

function requireUniqueIds(items: Array<{ id: string }>, label: string): void {
  const ids = new Set<string>();
  for (const item of items) {
    requireText(item.id, `${label} id`);
    if (ids.has(item.id)) throw new Error(`Duplicate ${label} id: ${item.id}`);
    ids.add(item.id);
  }
}

export function validateDecisionTree(decisions: DecisionNode[]): void {
  requireArray(decisions, "decisions");
  requireUniqueIds(decisions, "decision");
  const byId = new Map(decisions.map((decision) => [decision.id, decision]));
  for (const decision of decisions) {
    requireText(decision.question, `${decision.id} question`);
    for (const dependency of decision.dependsOn) {
      if (!byId.has(dependency)) throw new Error(`${decision.id} depends on unknown decision ${dependency}`);
      if (dependency === decision.id) throw new Error(`${decision.id} cannot depend on itself`);
    }
    if (decision.status === "answered") {
      if (!decision.answer?.trim() || !decision.answerSource) throw new Error(`${decision.id} is answered without answer evidence`);
    }
    if (decision.status === "external" && decision.answer) throw new Error(`${decision.id} cannot have an answer while external`);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error("Decision tree contains a cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of byId.keys()) visit(id);
}

export function calculateDecisionFrontier(decisions: DecisionNode[]): string[] {
  validateDecisionTree(decisions);
  const byId = new Map(decisions.map((decision) => [decision.id, decision]));
  return decisions
    .filter((decision) =>
      decision.status === "open"
      && decision.dependsOn.every((dependency) => byId.get(dependency)?.status === "answered"),
    )
    .map((decision) => decision.id)
    .sort();
}

export function validateEvidence(evidence: CodeEvidence[]): void {
  requireArray(evidence, "evidence");
  requireUniqueIds(evidence, "evidence");
  for (const item of evidence) {
    requireText(item.path, `${item.id} path`);
    requireText(item.symbol, `${item.id} symbol`);
    requireText(item.claim, `${item.id} claim`);
    requireText(item.repositoryRevision, `${item.id} repository revision`);
  }
}

function validateDiagram(diagram: Diagram): void {
  requireText(diagram.title, "diagram title");
  requireText(diagram.rationale, `${diagram.title} rationale`);
  requireText(diagram.mermaid, `${diagram.title} Mermaid source`);
  if (diagram.mermaid.includes("```")) throw new Error(`${diagram.title} Mermaid source must not include code fences`);
  const source = diagram.mermaid.trim();
  const valid =
    (diagram.kind === "flow" && /^(flowchart|graph)\b/.test(source))
    || (diagram.kind === "sequence" && /^sequenceDiagram\b/.test(source))
    || (diagram.kind === "state" && /^stateDiagram(?:-v2)?\b/.test(source))
    || (diagram.kind === "er" && /^erDiagram\b/.test(source));
  if (!valid) throw new Error(`${diagram.title} does not match diagram kind ${diagram.kind}`);
}

export function validatePrd(prd: ForgePrd): void {
  if (!prd || typeof prd !== "object" || Array.isArray(prd)) throw new Error("PRD must be an object");
  requireText(prd.title, "PRD title");
  requireText(prd.problem, "PRD problem");
  requireText(prd.solution, "PRD solution");
  for (const [label, value] of [
    ["goals", prd.goals],
    ["nonGoals", prd.nonGoals],
    ["actors", prd.actors],
    ["userStories", prd.userStories],
    ["acceptance", prd.acceptance],
    ["decisions", prd.decisions],
    ["impactEvidence", prd.impactEvidence],
    ["testSeams", prd.testSeams],
    ["risks", prd.risks],
    ["deliveryBoundaries", prd.deliveryBoundaries],
    ["diagrams", prd.diagrams],
    ["openQuestions", prd.openQuestions],
  ] as const) requireArray(value, `PRD ${label}`);
  if (!prd.behavior || typeof prd.behavior !== "object") throw new Error("PRD behavior must be an object");
  requireArray(prd.behavior.happyPath, "PRD happyPath");
  requireArray(prd.behavior.errorPaths, "PRD errorPaths");
  requireArray(prd.behavior.edgeCases, "PRD edgeCases");
  if (prd.goals.length === 0) throw new Error("PRD requires at least one goal");
  if (prd.acceptance.length === 0) throw new Error("PRD requires at least one Acceptance criterion");
  if (prd.impactEvidence.length === 0) throw new Error("PRD requires repository impact evidence");
  if (prd.deliveryBoundaries.length === 0) throw new Error("PRD requires at least one Delivery Boundary");
  requireUniqueIds(prd.userStories, "user story");
  requireUniqueIds(prd.acceptance, "Acceptance");
  requireUniqueIds(prd.decisions, "design decision");
  validateEvidence(prd.impactEvidence);

  const evidenceIds = new Set(prd.impactEvidence.map((item) => item.id));
  for (const acceptance of prd.acceptance) {
    requireText(acceptance.statement, `${acceptance.id} statement`);
    if (acceptance.verification.length === 0) throw new Error(`${acceptance.id} has no verification plan`);
    acceptance.verification.forEach((item) => requireText(item, `${acceptance.id} verification`));
  }
  for (const story of prd.userStories) {
    requireText(story.actor, `${story.id} actor`);
    requireText(story.capability, `${story.id} capability`);
    requireText(story.benefit, `${story.id} benefit`);
  }
  for (const decision of prd.decisions) {
    requireText(decision.decision, `${decision.id} decision`);
    requireText(decision.rationale, `${decision.id} rationale`);
    for (const evidenceId of decision.evidenceIds) {
      if (!evidenceIds.has(evidenceId)) throw new Error(`${decision.id} references unknown evidence ${evidenceId}`);
    }
  }
  for (const seam of prd.testSeams) {
    requireText(seam.name, "test seam name");
    requireText(seam.verification, `${seam.name} verification`);
    for (const evidenceId of seam.evidenceIds) {
      if (!evidenceIds.has(evidenceId)) throw new Error(`${seam.name} references unknown evidence ${evidenceId}`);
    }
  }
  for (const risk of prd.risks) {
    requireText(risk.risk, "risk");
    requireText(risk.mitigation, `${risk.risk} mitigation`);
  }
  requireUniqueIds(prd.deliveryBoundaries, "delivery boundary");
  const acceptanceIds = new Set(prd.acceptance.map((item) => item.id));
  const acceptanceById = new Map(prd.acceptance.map((item) => [item.id, item]));
  const decisionIds = new Set(prd.decisions.map((item) => item.id));
  const testSeamNames = new Set(prd.testSeams.map((item) => item.name));
  const testSeamByName = new Map(prd.testSeams.map((item) => [item.name, item]));
  const nonGoals = new Set(prd.nonGoals);
  const allowedVerification = new Set([...prd.acceptance.flatMap((item) => item.verification), ...prd.testSeams.map((item) => item.verification)]);
  const behavior = { happyPath: new Set(prd.behavior.happyPath), errorPaths: new Set(prd.behavior.errorPaths), edgeCases: new Set(prd.behavior.edgeCases) };
  const boundaryIds = new Set(prd.deliveryBoundaries.map((boundary) => boundary.id));
  const coveredAcceptance = new Set<string>();
  for (const [index, boundary] of prd.deliveryBoundaries.entries()) {
    const expected = `DB-${String(index + 1).padStart(2, "0")}`;
    if (boundary.id !== expected) throw new Error(`Delivery Boundary IDs must be contiguous; expected ${expected}, received ${boundary.id}`);
    requireText(boundary.title, `${boundary.id} title`);
    requireText(boundary.outcome, `${boundary.id} outcome`);
    requireText(boundary.goal, `${boundary.id} goal`);
    requireUniqueTexts(boundary.scope, `${boundary.id} scope`);
    requireText(boundary.rationale, `${boundary.id} rationale`);
    requireUniqueTexts(boundary.acceptanceIds, `${boundary.id} Acceptance`);
    requireUniqueTexts(boundary.decisionIds, `${boundary.id} Decisions`, true);
    requireUniqueTexts(boundary.impactEvidenceIds, `${boundary.id} Evidence`);
    requireUniqueTexts(boundary.testSeamNames, `${boundary.id} Test Seams`);
    requireUniqueTexts(boundary.nonGoals, `${boundary.id} Non-goals`, true);
    requireUniqueTexts(boundary.verification, `${boundary.id} Verification`);
    requireUniqueTexts(boundary.dependencies, `${boundary.id} dependencies`, true);
    for (const kind of ["happyPath", "errorPaths", "edgeCases"] as const) requireUniqueTexts(boundary.behavior[kind], `${boundary.id} ${kind}`, true);
    for (const id of boundary.acceptanceIds) {
      if (!acceptanceIds.has(id)) throw new Error(`${boundary.id} references unknown Acceptance ${id}`);
      coveredAcceptance.add(id);
    }
    for (const id of boundary.decisionIds) if (!decisionIds.has(id)) throw new Error(`${boundary.id} references unknown Decision ${id}`);
    for (const id of boundary.impactEvidenceIds) if (!evidenceIds.has(id)) throw new Error(`${boundary.id} references unknown Evidence ${id}`);
    for (const name of boundary.testSeamNames) if (!testSeamNames.has(name)) throw new Error(`${boundary.id} references unknown Test Seam ${name}`);
    for (const value of boundary.nonGoals) if (!nonGoals.has(value)) throw new Error(`${boundary.id} references unknown Non-goal ${value}`);
    for (const value of boundary.verification) if (!allowedVerification.has(value)) throw new Error(`${boundary.id} verification is not frozen in the PRD: ${value}`);
    const expectedVerification = [...new Set([
      ...boundary.acceptanceIds.flatMap((id) => acceptanceById.get(id)?.verification ?? []),
      ...boundary.testSeamNames.map((name) => testSeamByName.get(name)?.verification).filter((value): value is string => Boolean(value)),
    ])];
    if (JSON.stringify(boundary.verification) !== JSON.stringify(expectedVerification)) {
      throw new Error(`${boundary.id} Verification must exactly contain its owned Acceptance and Test Seam verification: ${expectedVerification.join(" | ")}`);
    }
    for (const kind of ["happyPath", "errorPaths", "edgeCases"] as const) {
      for (const value of boundary.behavior[kind]) if (!behavior[kind].has(value)) throw new Error(`${boundary.id} ${kind} is not frozen in the PRD: ${value}`);
    }
    for (const dependency of boundary.dependencies) if (!boundaryIds.has(dependency) || dependency === boundary.id) throw new Error(`${boundary.id} has invalid Delivery Boundary dependency ${dependency}`);
    if (prd.deliveryBoundaries.length > 1 && !boundary.independentlyDeliverable) throw new Error(`${boundary.id} cannot be a separate boundary when it is not independently deliverable`);
  }
  const visitingBoundaries = new Set<string>();
  const visitedBoundaries = new Set<string>();
  const boundaryById = new Map(prd.deliveryBoundaries.map((boundary) => [boundary.id, boundary]));
  const visitBoundary = (id: string, path: string[]): void => {
    if (visitingBoundaries.has(id)) throw new Error(`Delivery Boundary dependency cycle: ${[...path, id].join(" -> ")}`);
    if (visitedBoundaries.has(id)) return;
    visitingBoundaries.add(id);
    for (const dependency of boundaryById.get(id)?.dependencies ?? []) visitBoundary(dependency, [...path, id]);
    visitingBoundaries.delete(id);
    visitedBoundaries.add(id);
  };
  for (const id of boundaryIds) visitBoundary(id, []);

  const uncoveredAcceptance = [...acceptanceIds].filter((id) => !coveredAcceptance.has(id));
  if (uncoveredAcceptance.length > 0) throw new Error(`PRD Acceptance is not covered by Delivery Boundaries: ${uncoveredAcceptance.join(", ")}`);
  prd.diagrams.forEach(validateDiagram);
}

export function validateReview(review: PrdReview, expectedAxis: ReviewAxis, contentHash: string): void {
  if (review.axis !== expectedAxis) throw new Error(`Expected ${expectedAxis} review, received ${review.axis}`);
  if (review.surfaceHash !== contentHash) throw new Error(`${review.axis} review surface hash is stale`);
  requireText(review.reviewerId, `${review.axis} reviewer id`);
  const findingIds = new Set<string>();
  for (const finding of review.findings) {
    requireText(finding.message, `${review.axis} finding message`);
    requireArray(finding.evidence, `${review.axis} finding evidence`);
    if (finding.id !== undefined) {
      requireText(finding.id, `${review.axis} finding id`);
      if (findingIds.has(finding.id)) throw new Error(`Duplicate ${review.axis} finding id: ${finding.id}`);
      findingIds.add(finding.id);
      requireText(finding.violatedRule, `${finding.id} violated rule`);
      requireText(finding.verification, `${finding.id} verification`);
    }
    if (finding.severity === "blocker" && finding.evidence.length === 0) {
      throw new Error(`${review.axis} blocker has no evidence`);
    }
    if (finding.severity === "blocker" && !finding.suggestedResolution?.trim()) {
      throw new Error(`${review.axis} blocker requires the smallest sufficient suggestedResolution`);
    }
  }
  const hasBlocker = review.findings.some((finding) => finding.severity === "blocker");
  if (review.verdict === "passed" && hasBlocker) throw new Error(`${review.axis} review cannot pass with a Blocker`);
  if (review.verdict === "blocked" && !hasBlocker) throw new Error(`${review.axis} review cannot block without a Blocker finding`);
}

export function requiredReviewAxes(): ReviewAxis[] {
  return [...REVIEW_AXES];
}
