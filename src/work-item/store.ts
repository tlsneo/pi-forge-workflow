import { constants } from "node:fs";
import { access, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { appendJsonLine, atomicWriteJson, atomicWriteText, RuntimeStore } from "../runtime/store.js";
import { renderIssue, renderIssuesIndex } from "../issues/renderer.js";
import type { IssuesGeneration, IssuesManifest } from "../issues/types.js";
import type {
  FrozenPrdReceipt,
  PrdAmendment,
  PrdBlockerVerificationBinding,
  PrdBlockerVerificationJob,
  PrdBlockerVerificationResult,
  PrdGeneration,
  PrdReview,
  PrdReviewBinding,
  PrdReviewJobPlan,
  WorkItemEvent,
  WorkItemManifest,
  WorkItemState,
} from "./types.js";
import { renderPrd } from "./renderer.js";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export class WorkItemStore {
  readonly root: string;
  readonly runtimeRoot: string;
  readonly manifestPath: string;
  readonly statePath: string;
  readonly eventsPath: string;
  readonly prdRoot: string;
  readonly issuesRoot: string;
  private readonly lockStore: RuntimeStore;

  constructor(root: string) {
    this.root = root;
    this.runtimeRoot = join(root, "runtime");
    this.manifestPath = join(this.runtimeRoot, "manifest.json");
    this.statePath = join(this.runtimeRoot, "state.json");
    this.eventsPath = join(this.runtimeRoot, "events.jsonl");
    this.prdRoot = join(root, "prd");
    this.issuesRoot = join(root, "issues");
    this.lockStore = new RuntimeStore(this.runtimeRoot);
  }

  async exists(): Promise<boolean> {
    return exists(this.statePath);
  }

  async initialize(manifest: WorkItemManifest, state: WorkItemState): Promise<void> {
    await mkdir(this.runtimeRoot, { recursive: true });
    if (await this.exists()) throw new Error(`Work Item already exists: ${this.root}`);
    for (const directory of [
      join(this.root, "discovery", "research"),
      join(this.prdRoot, "generations"),
      join(this.root, "reviews"),
      join(this.root, "jobs", "bindings"),
      join(this.root, "jobs", "generations"),
      join(this.root, "jobs", "results"),
      join(this.root, "amendments"),
      join(this.root, "receipts"),
      join(this.issuesRoot, "generations"),
    ]) {
      await mkdir(directory, { recursive: true });
    }
    await atomicWriteJson(this.manifestPath, manifest);
    const event: WorkItemEvent = {
      id: randomUUID(),
      sequence: state.eventSequence,
      type: "work_item_initialized",
      timestamp: state.updatedAt,
      workItemId: state.workItemId,
      snapshot: state,
    };
    await appendJsonLine(this.eventsPath, event);
    await atomicWriteJson(this.statePath, state);
  }

  async readManifest(): Promise<WorkItemManifest> {
    return JSON.parse(await readFile(this.manifestPath, "utf8")) as WorkItemManifest;
  }

  async readState(): Promise<WorkItemState> {
    return JSON.parse(await readFile(this.statePath, "utf8")) as WorkItemState;
  }

  async readEvents(): Promise<WorkItemEvent[]> {
    if (!(await exists(this.eventsPath))) return [];
    return (await readFile(this.eventsPath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as WorkItemEvent);
  }

  async doctor(): Promise<{ repaired: boolean; state: WorkItemState }> {
    return this.lockStore.withLock(async () => {
      const state = await this.readState();
      const last = (await this.readEvents()).at(-1);
      if (!last) throw new Error("Work Item event ledger is empty");
      if (last.sequence > state.eventSequence || last.snapshot.generation > state.generation) {
        await atomicWriteJson(this.statePath, last.snapshot);
        return { repaired: true, state: last.snapshot };
      }
      if (last.sequence !== state.eventSequence || last.snapshot.generation !== state.generation) {
        throw new Error("Work Item state and ledger diverged ambiguously");
      }
      return { repaired: false, state };
    });
  }

  async transact(
    type: string,
    mutate: (state: WorkItemState) => void,
    details?: Record<string, unknown>,
  ): Promise<WorkItemState> {
    return this.lockStore.withLock(async () => {
      const current = await this.readState();
      const next = structuredClone(current);
      mutate(next);
      next.generation = current.generation + 1;
      next.eventSequence = current.eventSequence + 1;
      next.updatedAt = new Date().toISOString();
      const event: WorkItemEvent = {
        id: randomUUID(),
        sequence: next.eventSequence,
        type,
        timestamp: next.updatedAt,
        workItemId: next.workItemId,
        snapshot: next,
        ...(details ? { details } : {}),
      };
      await appendJsonLine(this.eventsPath, event);
      await atomicWriteJson(this.statePath, next);
      return next;
    });
  }

  async writePrdGeneration(generation: PrdGeneration): Promise<void> {
    const generationPath = join(this.prdRoot, "generations", `prd-${generation.generation}.json`);
    if (await exists(generationPath)) throw new Error(`PRD Generation ${generation.generation} already exists`);
    await atomicWriteJson(generationPath, generation);
    await atomicWriteJson(join(this.prdRoot, "prd.json"), generation);
    await atomicWriteJson(join(this.root, "discovery", "evidence.json"), generation.prd.impactEvidence);
    const rendered = renderPrd(generation);
    await atomicWriteText(join(this.prdRoot, "PRD.md"), rendered);
    await atomicWriteText(join(this.root, "PRD.md"), rendered);
  }

  async readPrdGeneration(generation: number): Promise<PrdGeneration> {
    return JSON.parse(
      await readFile(join(this.prdRoot, "generations", `prd-${generation}.json`), "utf8"),
    ) as PrdGeneration;
  }

  async writeAmendment(amendment: PrdAmendment): Promise<void> {
    const path = join(this.root, "amendments", `${amendment.id}.json`);
    if (await exists(path)) throw new Error(`PRD Amendment already exists: ${amendment.id}`);
    await atomicWriteJson(path, amendment);
  }

  async writeReview(generation: number, review: PrdReview): Promise<void> {
    const suffix = review.jobId ? `-${review.jobId}` : "";
    const path = join(this.root, "reviews", `prd-${generation}-${review.axis}${suffix}.json`);
    if (await exists(path)) throw new Error(`${review.axis} review already exists for PRD Generation ${generation}${review.jobId ? ` Job ${review.jobId}` : ""}`);
    await atomicWriteJson(path, review);
    if (review.bindingId) await atomicWriteJson(join(this.root, "jobs", "results", `${review.bindingId}.json`), review);
  }

  async writeReviewJobPlan(generation: number, plans: PrdReviewJobPlan[]): Promise<void> {
    const path = join(this.root, "jobs", "generations", `prd-${generation}.json`);
    if (await exists(path)) throw new Error(`Review Job plan already exists for PRD Generation ${generation}`);
    await atomicWriteJson(path, { schemaVersion: 1, prdGeneration: generation, jobs: plans });
  }

  async writeReviewBinding(binding: PrdReviewBinding | PrdBlockerVerificationBinding): Promise<void> {
    const path = join(this.root, "jobs", "bindings", `${binding.id}.json`);
    if (await exists(path)) throw new Error(`Review Binding already exists: ${binding.id}`);
    await atomicWriteJson(path, binding);
  }

  async writeBlockerVerificationJob(job: PrdBlockerVerificationJob): Promise<void> {
    const path = join(this.root, "jobs", "generations", `prd-${job.prdGeneration}-blocker-verification.json`);
    if (await exists(path)) throw new Error(`Blocker Verification Job already exists for PRD Generation ${job.prdGeneration}`);
    await atomicWriteJson(path, job);
  }

  async writeBlockerVerificationResult(bindingId: string, results: PrdBlockerVerificationResult[]): Promise<void> {
    const path = join(this.root, "jobs", "results", `${bindingId}.json`);
    if (await exists(path)) throw new Error(`Blocker Verification result already exists for Binding ${bindingId}`);
    await atomicWriteJson(path, { schemaVersion: 1, bindingId, results });
  }

  async writeIssuesGeneration(generation: IssuesGeneration, manifest: IssuesManifest): Promise<void> {
    const generationPath = join(this.issuesRoot, "generations", `issues-${generation.generation}.json`);
    if (await exists(generationPath)) throw new Error(`Issues Generation ${generation.generation} already exists`);
    await atomicWriteJson(generationPath, generation);
    const prd = (await this.readPrdGeneration(generation.source.prdGeneration)).prd;
    for (const issue of generation.issues) {
      await atomicWriteJson(join(this.issuesRoot, issue.id, "issue.json"), issue);
      await atomicWriteText(join(this.issuesRoot, issue.id, "ISSUE.md"), renderIssue(issue, prd));
    }
    await atomicWriteJson(join(this.issuesRoot, "manifest.json"), manifest);
    await atomicWriteText(join(this.issuesRoot, "README.md"), renderIssuesIndex(manifest));
  }

  async readIssuesManifest(): Promise<IssuesManifest | undefined> {
    const path = join(this.issuesRoot, "manifest.json");
    return (await exists(path)) ? JSON.parse(await readFile(path, "utf8")) as IssuesManifest : undefined;
  }

  async writeFrozenReceipt(receipt: FrozenPrdReceipt): Promise<void> {
    const path = join(this.root, "receipts", `prd-${receipt.generation}.json`);
    if (await exists(path)) throw new Error(`Frozen PRD Receipt already exists for Generation ${receipt.generation}`);
    await atomicWriteJson(path, receipt);
  }
}
