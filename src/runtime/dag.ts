import type { IssueRuntimeState, TaskContract, TaskDag } from "./types.js";

export interface DagValidationResult {
  order: string[];
}

function pathOverlaps(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function consumeProducer(consume: string): string | undefined {
  const separator = consume.indexOf("::");
  return separator > 0 ? consume.slice(0, separator) : undefined;
}

export function validateDag(dag: TaskDag): DagValidationResult {
  if (!Number.isInteger(dag.generation) || dag.generation < 1) {
    throw new Error("DAG generation must be a positive integer");
  }

  const tasks = new Map<string, TaskContract>();
  for (const task of dag.tasks) {
    if (!/^T\d+$/.test(task.id)) throw new Error(`Invalid task id: ${task.id}`);
    if (!Number.isInteger(task.version) || task.version < 1) throw new Error(`Invalid task version for ${task.id}: ${task.version}`);
    if (tasks.has(task.id)) throw new Error(`Duplicate task id: ${task.id}`);
    tasks.set(task.id, task);
  }

  for (const task of dag.tasks) {
    for (const dependency of task.dependencies) {
      if (!tasks.has(dependency)) throw new Error(`${task.id} depends on unknown task ${dependency}`);
    }
    for (const conflict of task.conflicts) {
      if (!tasks.has(conflict)) throw new Error(`${task.id} conflicts with unknown task ${conflict}`);
      if (conflict === task.id) throw new Error(`${task.id} cannot conflict with itself`);
    }

    const consumedProducers = new Set(task.consumes.map(consumeProducer).filter((value): value is string => Boolean(value)));
    for (const consume of task.consumes) {
      const separator = consume.indexOf("::");
      const producerId = separator > 0 ? consume.slice(0, separator) : "";
      const artifact = separator > 0 ? consume.slice(separator + 2) : "";
      const producer = tasks.get(producerId);
      if (!producer || !artifact || !producer.produces.includes(artifact)) {
        throw new Error(`${task.id} consumes unknown artifact ${consume}`);
      }
    }
    for (const dependency of task.dependencies) {
      if (!consumedProducers.has(dependency)) {
        throw new Error(`${task.id} dependency ${dependency} has no matching Consumes artifact`);
      }
    }
    for (const producer of consumedProducers) {
      if (!task.dependencies.includes(producer)) {
        throw new Error(`${task.id} consumes ${producer} without declaring it as a dependency`);
      }
    }
  }

  const indegree = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const task of dag.tasks) {
    indegree.set(task.id, task.dependencies.length);
    for (const dependency of task.dependencies) {
      children.set(dependency, [...(children.get(dependency) ?? []), task.id]);
    }
  }

  const queue = [...dag.tasks.map((task) => task.id).filter((id) => indegree.get(id) === 0)].sort();
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift();
    if (!id) break;
    order.push(id);
    for (const child of children.get(id) ?? []) {
      const next = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, next);
      if (next === 0) queue.push(child);
    }
    queue.sort();
  }
  if (order.length !== dag.tasks.length) throw new Error("Task DAG contains a cycle");

  for (let leftIndex = 0; leftIndex < dag.tasks.length; leftIndex++) {
    const left = dag.tasks[leftIndex];
    if (!left) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < dag.tasks.length; rightIndex++) {
      const right = dag.tasks[rightIndex];
      if (!right) continue;
      const overlaps = left.writes.some((leftPath) => right.writes.some((rightPath) => pathOverlaps(leftPath, rightPath)));
      if (!overlaps) continue;
      const ordered = dependsTransitively(dag, left.id, right.id) || dependsTransitively(dag, right.id, left.id);
      const declaredConflict = left.conflicts.includes(right.id) || right.conflicts.includes(left.id);
      if (!ordered && !declaredConflict) {
        throw new Error(`${left.id} and ${right.id} have overlapping Writes without dependency or Conflict`);
      }
    }
  }

  return { order };
}

export function dependsTransitively(dag: TaskDag, taskId: string, possibleDependency: string): boolean {
  const byId = new Map(dag.tasks.map((task) => [task.id, task]));
  const pending = [...(byId.get(taskId)?.dependencies ?? [])];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current)) continue;
    if (current === possibleDependency) return true;
    visited.add(current);
    pending.push(...(byId.get(current)?.dependencies ?? []));
  }
  return false;
}

export function calculateFrontier(dag: TaskDag, state: IssueRuntimeState): string[] {
  const { order } = validateDag(dag);
  const active = Object.values(state.tasks).some((task) =>
    ["starting", "running", "awaiting_verification", "verifying"].includes(task.status),
  );
  if (active) return [];

  for (const taskId of order) {
    const task = dag.tasks.find((candidate) => candidate.id === taskId);
    const taskState = state.tasks[taskId];
    if (!task || !taskState || !["ready", "retry_ready", "interrupted"].includes(taskState.status)) continue;
    if (task.dependencies.every((dependency) => state.tasks[dependency]?.status === "completed")) {
      return [taskId];
    }
  }
  return [];
}

export function refreshReadyStates(dag: TaskDag, state: IssueRuntimeState): void {
  for (const task of dag.tasks) {
    const taskState = state.tasks[task.id];
    if (!taskState || taskState.status !== "pending") continue;
    if (task.dependencies.every((dependency) => state.tasks[dependency]?.status === "completed")) {
      taskState.status = "ready";
    }
  }
}
