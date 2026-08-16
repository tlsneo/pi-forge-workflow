export const NORMAL_TASK_CONTEXT_FILES = 3;
export const MAX_INSEPARABLE_TASK_CONTEXT_FILES = 5;

export function validateTaskContextBudget(taskId: string, reads: unknown[], writes: unknown[]): void {
  if (reads.length < 1 || reads.length > MAX_INSEPARABLE_TASK_CONTEXT_FILES) {
    throw new Error(`${taskId} must read between 1 and ${MAX_INSEPARABLE_TASK_CONTEXT_FILES} exact files`);
  }
  if (writes.length < 1 || writes.length > MAX_INSEPARABLE_TASK_CONTEXT_FILES) {
    throw new Error(`${taskId} must write between 1 and ${MAX_INSEPARABLE_TASK_CONTEXT_FILES} paths`);
  }
}
