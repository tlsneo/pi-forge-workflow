import type { TaskBlueprintEvidence, TaskBlueprintStep, TaskContract } from "./types.js";

const STEP_ID = /^BP-(\d{2,})$/;

function text(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

export function normalizeBlueprintSteps(contract: Pick<TaskContract, "id" | "implementationBlueprint">): TaskBlueprintStep[] {
  return (contract.implementationBlueprint ?? []).map((step, index) => {
    if (typeof step === "string") {
      return {
        id: `BP-${String(index + 1).padStart(2, "0")}`,
        instruction: step,
        expectedEvidence: ["Legacy Blueprint completion evidence"],
      };
    }
    return {
      id: step.id,
      instruction: step.instruction,
      expectedEvidence: [...step.expectedEvidence],
    };
  });
}

export function validateBlueprintSteps(taskId: string, steps: Array<TaskBlueprintStep | string>): TaskBlueprintStep[] {
  if (!Array.isArray(steps) || steps.length < 2) throw new Error(`${taskId} Implementation Blueprint must contain at least 2 ordered steps`);
  const normalized = steps.map((step, index) => {
    if (typeof step === "string") throw new Error(`${taskId} Blueprint step ${index + 1} must declare id, instruction, and expectedEvidence`);
    const id = text(step.id, `${taskId} Blueprint step ${index + 1} id`);
    const match = STEP_ID.exec(id);
    const expectedId = `BP-${String(index + 1).padStart(2, "0")}`;
    if (!match || id !== expectedId) throw new Error(`${taskId} Blueprint step IDs must be contiguous; expected ${expectedId}, received ${id}`);
    const instruction = text(step.instruction, `${taskId} ${id} instruction`);
    if (!Array.isArray(step.expectedEvidence) || step.expectedEvidence.length === 0) throw new Error(`${taskId} ${id} requires expectedEvidence`);
    const expectedEvidence = step.expectedEvidence.map((item, evidenceIndex) => text(item, `${taskId} ${id} expectedEvidence ${evidenceIndex + 1}`));
    if (new Set(expectedEvidence).size !== expectedEvidence.length) throw new Error(`${taskId} ${id} expectedEvidence contains duplicates`);
    return { id, instruction, expectedEvidence };
  });
  return normalized;
}

export function validateBlueprintEvidence(contract: TaskContract, evidence: TaskBlueprintEvidence[] | undefined): TaskBlueprintEvidence[] {
  const steps = normalizeBlueprintSteps(contract);
  if (!Array.isArray(evidence)) throw new Error(`${contract.id} Handoff requires Blueprint Evidence`);
  const byId = new Map<string, TaskBlueprintEvidence>();
  for (const item of evidence) {
    const stepId = text(item.stepId, `${contract.id} Blueprint Evidence stepId`);
    if (byId.has(stepId)) throw new Error(`${contract.id} Handoff contains duplicate Blueprint Evidence for ${stepId}`);
    if (!Array.isArray(item.evidence) || item.evidence.length === 0) throw new Error(`${contract.id} ${stepId} requires completion evidence`);
    byId.set(stepId, {
      stepId,
      evidence: item.evidence.map((value, index) => text(value, `${contract.id} ${stepId} evidence ${index + 1}`)),
    });
  }
  const expectedIds = steps.map((step) => step.id);
  const missing = expectedIds.filter((id) => !byId.has(id));
  const unexpected = [...byId.keys()].filter((id) => !expectedIds.includes(id));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(`${contract.id} Handoff Blueprint Evidence mismatch; missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}`);
  }
  return expectedIds.map((id) => byId.get(id)!);
}
