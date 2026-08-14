import { constants } from "node:fs";
import { access, appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { stableHash } from "./hash.js";
import type { IssueRuntimeState, ModelPolicy, RuntimeEvent, RuntimeManifest, RuntimeModelPolicyGeneration, RuntimeModelPolicyPointer, TaskDag } from "./types.js";

const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 30_000;

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function atomicWriteText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "a", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class RuntimeStore {
  readonly root: string;
  readonly manifestPath: string;
  readonly dagPath: string;
  readonly statePath: string;
  readonly eventsPath: string;
  readonly modelPolicyPointerPath: string;
  readonly lockPath: string;

  constructor(root: string) {
    this.root = root;
    this.manifestPath = join(root, "manifest.json");
    this.dagPath = join(root, "dag.json");
    this.statePath = join(root, "state.json");
    this.eventsPath = join(root, "events.jsonl");
    this.modelPolicyPointerPath = join(root, "model-policy.json");
    this.lockPath = join(root, ".runtime.lock");
  }

  async initialize(manifest: RuntimeManifest, dag: TaskDag, state: IssueRuntimeState): Promise<void> {
    await mkdir(this.root, { recursive: true });
    if (await pathExists(this.statePath)) throw new Error(`Runtime already exists: ${this.root}`);
    for (const directory of ["generations", "amendments", "bindings", "checkpoints", "receipts", "audits", "human-decisions", "model-policies", "locks"]) {
      await mkdir(join(this.root, directory), { recursive: true });
    }
    await atomicWriteJson(this.manifestPath, manifest);
    await atomicWriteJson(this.dagPath, dag);
    await atomicWriteJson(join(this.root, "generations", `dag-${dag.generation}.json`), dag);
    const policyHash = stableHash(manifest.modelPolicy);
    const policyGeneration: RuntimeModelPolicyGeneration = {
      schemaVersion: 1,
      generation: 1,
      configGeneration: manifest.modelPolicySource?.configGeneration ?? 0,
      configHash: manifest.modelPolicySource?.configHash ?? stableHash(manifest.modelPolicy),
      policyHash,
      policy: manifest.modelPolicy,
      reason: "Runtime initialized",
      createdAt: manifest.createdAt,
    };
    const policyPointer: RuntimeModelPolicyPointer = {
      schemaVersion: 1,
      generation: 1,
      policyHash,
      generationPath: "model-policies/policy-1.json",
      updatedAt: manifest.createdAt,
    };
    await atomicWriteJson(join(this.root, policyPointer.generationPath), policyGeneration);
    await atomicWriteJson(this.modelPolicyPointerPath, policyPointer);

    const initialEvent: RuntimeEvent = {
      id: randomUUID(),
      sequence: state.eventSequence,
      type: "runtime_initialized",
      timestamp: new Date().toISOString(),
      issueId: state.issueId,
      snapshot: state,
    };
    await appendJsonLine(this.eventsPath, initialEvent);
    await atomicWriteJson(this.statePath, state);
  }

  async readManifest(): Promise<RuntimeManifest> {
    const raw = JSON.parse(await readFile(this.manifestPath, "utf8")) as Omit<RuntimeManifest, "workItemId" | "controlRoot" | "repositoryRoot" | "assuranceProfile" | "taskConformanceRequired"> & Partial<Pick<RuntimeManifest, "workItemId" | "controlRoot" | "repositoryRoot" | "assuranceProfile" | "taskConformanceRequired">>;
    const workItemManifestPath = join(this.root, "..", "..", "..", "runtime", "manifest.json");
    let workItem: { workItemId?: string; controlRoot?: string; repositoryRoot?: string } | undefined;
    if (await pathExists(workItemManifestPath)) {
      workItem = JSON.parse(await readFile(workItemManifestPath, "utf8")) as typeof workItem;
    }
    return {
      ...raw,
      workItemId: raw.workItemId ?? workItem?.workItemId ?? `legacy:${raw.issueId}`,
      controlRoot: raw.controlRoot ?? workItem?.controlRoot ?? workItem?.repositoryRoot ?? raw.workspaceRoot,
      repositoryRoot: raw.repositoryRoot ?? workItem?.repositoryRoot ?? raw.workspaceRoot,
      assuranceProfile: raw.assuranceProfile ?? "standard",
      taskConformanceRequired: raw.taskConformanceRequired ?? false,
    };
  }

  async readDag(): Promise<TaskDag> {
    const raw = JSON.parse(await readFile(this.dagPath, "utf8")) as Omit<TaskDag, "tasks"> & { tasks: Array<TaskDag["tasks"][number] & { version?: number }> };
    return { ...raw, tasks: raw.tasks.map((task) => ({ ...task, version: task.version ?? 1 })) };
  }

  async readState(): Promise<IssueRuntimeState> {
    const state = JSON.parse(await readFile(this.statePath, "utf8")) as IssueRuntimeState & {
      audits?: Record<string, any>;
      auditJobs?: Record<string, any>;
    };
    if (state.audits?.spec_integration && !state.audits.acceptance_integration) {
      state.audits.acceptance_integration = { ...state.audits.spec_integration, axis: "acceptance_integration" };
      delete state.audits.spec_integration;
    }
    if (state.auditJobs?.spec_integration && !state.auditJobs.acceptance_integration) {
      state.auditJobs.acceptance_integration = { ...state.auditJobs.spec_integration, axis: "acceptance_integration" };
      delete state.auditJobs.spec_integration;
    }
    for (const finding of state.auditBlockerVerifierJob?.findings ?? []) {
      if ((finding.axis as string) === "spec_integration") finding.axis = "acceptance_integration";
      if ((finding.finding as { axis?: string }).axis === "spec_integration") (finding.finding as { axis?: string }).axis = "acceptance_integration";
    }
    const decision = state.humanDecision;
    if ((decision?.resumeAction as string | undefined) === "require_prd_amendment") decision!.resumeAction = "supersede_work_item";
    for (const option of decision?.options ?? []) if ((option.resumeAction as string) === "require_prd_amendment") option.resumeAction = "supersede_work_item";
    return state;
  }

  async readActiveModelPolicy(): Promise<RuntimeModelPolicyGeneration> {
    if (await pathExists(this.modelPolicyPointerPath)) {
      const pointer = JSON.parse(await readFile(this.modelPolicyPointerPath, "utf8")) as RuntimeModelPolicyPointer;
      const generation = JSON.parse(await readFile(join(this.root, pointer.generationPath), "utf8")) as RuntimeModelPolicyGeneration;
      if (generation.generation !== pointer.generation || generation.policyHash !== pointer.policyHash || stableHash(generation.policy) !== generation.policyHash) {
        throw new Error("Runtime Model Policy pointer or generation is stale");
      }
      return generation;
    }
    const manifest = await this.readManifest();
    return {
      schemaVersion: 1,
      generation: 1,
      configGeneration: manifest.modelPolicySource?.configGeneration ?? 0,
      configHash: manifest.modelPolicySource?.configHash ?? stableHash(manifest.modelPolicy),
      policyHash: stableHash(manifest.modelPolicy),
      policy: manifest.modelPolicy,
      reason: "Legacy Runtime manifest fallback",
      createdAt: manifest.createdAt,
    };
  }

  async rebindModelPolicy(input: { configGeneration: number; configHash: string; policy: ModelPolicy; reason: string }): Promise<{ state: IssueRuntimeState; policy: RuntimeModelPolicyGeneration; idempotent: boolean }> {
    return this.withLock(async () => {
      const current = await this.readState();
      const activeTasks = Object.values(current.tasks).filter((task) => ["starting", "running", "awaiting_verification", "verifying", "awaiting_review", "reviewing", "awaiting_commit"].includes(task.status));
      if (activeTasks.length > 0) throw new Error(`Cannot rebind Model Policy while Tasks are active: ${activeTasks.map((task) => task.id).join(", ")}`);
      const active = await this.readActiveModelPolicy();
      const policyHash = stableHash(input.policy);
      if (active.configGeneration === input.configGeneration && active.configHash === input.configHash && active.policyHash === policyHash) {
        return { state: current, policy: active, idempotent: true };
      }
      if (!(await pathExists(this.modelPolicyPointerPath))) {
        const baselinePath = `model-policies/policy-${active.generation}.json`;
        await atomicWriteJson(join(this.root, baselinePath), active);
        await atomicWriteJson(this.modelPolicyPointerPath, {
          schemaVersion: 1,
          generation: active.generation,
          policyHash: active.policyHash,
          generationPath: baselinePath,
          updatedAt: active.createdAt,
        } satisfies RuntimeModelPolicyPointer);
      }
      const nextPolicy: RuntimeModelPolicyGeneration = {
        schemaVersion: 1,
        generation: active.generation + 1,
        configGeneration: input.configGeneration,
        configHash: input.configHash,
        policyHash,
        policy: structuredClone(input.policy),
        reason: input.reason,
        createdAt: new Date().toISOString(),
      };
      const generationPath = `model-policies/policy-${nextPolicy.generation}.json`;
      await atomicWriteJson(join(this.root, generationPath), nextPolicy);
      await atomicWriteJson(this.modelPolicyPointerPath, {
        schemaVersion: 1,
        generation: nextPolicy.generation,
        policyHash,
        generationPath,
        updatedAt: nextPolicy.createdAt,
      } satisfies RuntimeModelPolicyPointer);

      const next = structuredClone(current);
      next.modelPolicyGeneration = nextPolicy.generation;
      next.generation = current.generation + 1;
      next.eventSequence = current.eventSequence + 1;
      next.updatedAt = nextPolicy.createdAt;
      const event: RuntimeEvent = {
        id: randomUUID(),
        sequence: next.eventSequence,
        type: "model_policy_rebound",
        timestamp: next.updatedAt,
        issueId: next.issueId,
        details: {
          previousGeneration: active.generation,
          modelPolicyGeneration: nextPolicy.generation,
          configGeneration: input.configGeneration,
          configHash: input.configHash,
          reason: input.reason,
        },
        snapshot: next,
      };
      await appendJsonLine(this.eventsPath, event);
      await atomicWriteJson(this.statePath, next);
      return { state: next, policy: nextPolicy, idempotent: false };
    });
  }

  async readEvents(): Promise<RuntimeEvent[]> {
    if (!(await pathExists(this.eventsPath))) return [];
    const text = await readFile(this.eventsPath, "utf8");
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as RuntimeEvent);
  }

  async doctor(): Promise<{ repaired: boolean; state: IssueRuntimeState }> {
    return this.withLock(async () => {
      const state = await this.readState();
      const events = await this.readEvents();
      const last = events.at(-1);
      if (!last) throw new Error("Runtime ledger is empty");
      if (last.snapshot.generation > state.generation || last.sequence > state.eventSequence) {
        const activePolicy = await this.readActiveModelPolicy();
        if ((last.snapshot.modelPolicyGeneration ?? 1) !== activePolicy.generation) throw new Error("Runtime Model Policy pointer and ledger diverged ambiguously");
        await atomicWriteJson(this.statePath, last.snapshot);
        return { repaired: true, state: last.snapshot };
      }
      if (last.snapshot.generation !== state.generation || last.sequence !== state.eventSequence) {
        throw new Error("Runtime state and ledger diverged ambiguously");
      }
      const activePolicy = await this.readActiveModelPolicy();
      if ((state.modelPolicyGeneration ?? 1) !== activePolicy.generation) throw new Error("Runtime Model Policy pointer and state diverged ambiguously");
      return { repaired: false, state };
    });
  }

  async transact(
    type: string,
    mutate: (state: IssueRuntimeState) => void,
    options: { taskId?: string; details?: Record<string, unknown> } = {},
  ): Promise<IssueRuntimeState> {
    return this.withLock(async () => {
      const current = await this.readState();
      const next = structuredClone(current);
      mutate(next);
      next.generation = current.generation + 1;
      next.eventSequence = current.eventSequence + 1;
      next.updatedAt = new Date().toISOString();

      const event: RuntimeEvent = {
        id: randomUUID(),
        sequence: next.eventSequence,
        type,
        timestamp: next.updatedAt,
        issueId: next.issueId,
        snapshot: next,
        ...(options.taskId ? { taskId: options.taskId } : {}),
        ...(options.details ? { details: options.details } : {}),
      };
      await appendJsonLine(this.eventsPath, event);
      await atomicWriteJson(this.statePath, next);
      return next;
    });
  }

  async writeDagGeneration(dag: TaskDag, amendment: unknown): Promise<void> {
    await atomicWriteJson(this.dagPath, dag);
    await atomicWriteJson(join(this.root, "generations", `dag-${dag.generation}.json`), dag);
    await atomicWriteJson(join(this.root, "amendments", `A${String(dag.generation - 1).padStart(3, "0")}.json`), amendment);
  }

  async writeBinding(bindingId: string, binding: unknown): Promise<void> {
    await atomicWriteJson(join(this.root, "bindings", `${bindingId}.json`), binding);
  }

  async writeCheckpoint(taskId: string, checkpoint: unknown): Promise<void> {
    await atomicWriteJson(join(this.root, "checkpoints", `${taskId}.json`), checkpoint);
  }

  async readReceipt<T>(taskId: string, taskVersion = 1): Promise<T | undefined> {
    const path = join(this.root, "receipts", `${taskId}-V${String(taskVersion).padStart(3, "0")}.json`);
    return (await pathExists(path)) ? JSON.parse(await readFile(path, "utf8")) as T : undefined;
  }

  async writeReceipt(taskId: string, receipt: { taskVersion?: number }): Promise<void> {
    const taskVersion = receipt.taskVersion ?? 1;
    const path = join(this.root, "receipts", `${taskId}-V${String(taskVersion).padStart(3, "0")}.json`);
    if (await pathExists(path)) throw new Error(`Task Receipt already exists: ${taskId}@V${String(taskVersion).padStart(3, "0")}`);
    await atomicWriteJson(path, receipt);
  }

  async writeAudit(auditId: string, receipt: unknown): Promise<void> {
    const path = join(this.root, "audits", `${auditId}.json`);
    if (await pathExists(path)) throw new Error(`Audit receipt already exists: ${auditId}`);
    await atomicWriteJson(path, receipt);
  }

  async writeTaskConformanceArtifact(relativePath: string, artifact: unknown): Promise<void> {
    const path = join(this.root, relativePath);
    if (await pathExists(path)) {
      const existing = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (stableHash(existing) === stableHash(artifact)) return;
      throw new Error(`Task Conformance artifact already exists with different content: ${relativePath}`);
    }
    await atomicWriteJson(path, artifact);
  }

  async readTaskConformanceArtifact<T>(relativePath: string): Promise<T | undefined> {
    const path = join(this.root, relativePath);
    return await pathExists(path) ? JSON.parse(await readFile(path, "utf8")) as T : undefined;
  }

  async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    while (true) {
      try {
        const handle = await open(this.lockPath, "wx", 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
        await handle.close();
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;
        try {
          const lockStat = await stat(this.lockPath);
          if (Date.now() - lockStat.mtimeMs > STALE_LOCK_MS) {
            await rm(this.lockPath, { force: true });
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() - startedAt > LOCK_TIMEOUT_MS) throw new Error(`Runtime lock timeout: ${this.root}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }

    try {
      return await operation();
    } finally {
      await rm(this.lockPath, { force: true });
    }
  }
}

export { atomicWriteJson, atomicWriteText, appendJsonLine };
