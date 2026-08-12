import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadForgeConfig } from "../config/resolver.js";
import type { IssueArtifact } from "../issues/types.js";
import { stableHash } from "../runtime/hash.js";
import { RuntimeService } from "../runtime/service.js";
import { atomicWriteJson, atomicWriteText } from "../runtime/store.js";
import type { ModelPolicy, TaskContract, TaskDag } from "../runtime/types.js";
import { WorkItemService } from "../work-item/service.js";
import { renderSlice, renderTask } from "./renderer.js";
import type { MicroTaskDraft, PreparedTaskPlan, SliceDraft, TaskPlanGeneration, TaskPlanManifest, TaskPreflightReference } from "./types.js";
import { validateTaskPlan } from "./validation.js";

async function exists(path: string): Promise<boolean> {
  try { await access(path, constants.F_OK); return true; } catch { return false; }
}

export class TasksService {
  readonly workItemRoot: string;

  constructor(workItemRoot: string) {
    this.workItemRoot = workItemRoot;
  }

  private issueRoot(issueId: string): string {
    return join(this.workItemRoot, "issues", issueId);
  }

  private modelPolicy(config: Awaited<ReturnType<typeof loadForgeConfig>>): ModelPolicy {
    const defaultProfile = config.models.routing["task.medium"] ?? "medium";
    if (!config.models.profiles[defaultProfile]) throw new Error(`Missing default Task model profile: ${defaultProfile}`);
    return {
      defaultProfile,
      profiles: config.models.profiles,
      roles: { "task-worker": defaultProfile },
    };
  }

  async status(issueId: string): Promise<{
    manifest?: TaskPlanManifest;
    runtime?: Awaited<ReturnType<RuntimeService["status"]>>;
    activeModelPolicy?: Awaited<ReturnType<RuntimeService["activeModelPolicy"]>>;
  }> {
    const issueRoot = this.issueRoot(issueId);
    const manifestPath = join(issueRoot, "task-manifest.json");
    const runtimeRoot = join(issueRoot, "runtime");
    const manifest = await exists(manifestPath) ? JSON.parse(await readFile(manifestPath, "utf8")) as TaskPlanManifest : undefined;
    const runtimeService = new RuntimeService(runtimeRoot);
    const runtime = await exists(join(runtimeRoot, "state.json")) ? await runtimeService.status() : undefined;
    const activeModelPolicy = runtime ? await runtimeService.activeModelPolicy() : undefined;
    return { ...(manifest ? { manifest } : {}), ...(runtime ? { runtime } : {}), ...(activeModelPolicy ? { activeModelPolicy } : {}) };
  }

  async prepare(issueId: string, slices: SliceDraft[], drafts: MicroTaskDraft[]): Promise<PreparedTaskPlan> {
    if (!/^I\d{3,}$/.test(issueId)) throw new Error(`Invalid Issue ID: ${issueId}`);
    const workItem = new WorkItemService(this.workItemRoot);
    const state = await workItem.store.readState();
    if (!state.issues || !state.frozenReceipt || !state.currentPrd) throw new Error("forge-tasks requires generated Issues from a frozen PRD");
    const issuesManifest = await workItem.store.readIssuesManifest();
    if (!issuesManifest || issuesManifest.contentHash !== state.issues.contentHash) throw new Error("Issues Manifest is missing or stale");
    const entry = issuesManifest.issues.find((candidate) => candidate.id === issueId);
    if (!entry) throw new Error(`Issue ${issueId} is not present in issues/manifest.json`);
    const issuePath = join(this.workItemRoot, entry.artifactPath);
    const issue = JSON.parse(await readFile(issuePath, "utf8")) as IssueArtifact;
    const { artifactHash: _artifactHash, ...artifactBase } = issue;
    if (stableHash(artifactBase) !== issue.artifactHash || entry.artifactHash !== issue.artifactHash) throw new Error(`Issue ${issueId} Artifact Hash is stale`);

    const repositoryManifest = await workItem.store.readManifest();
    const config = await loadForgeConfig(repositoryManifest.repositoryRoot);
    const draftDag = validateTaskPlan(issue, config, slices, drafts);
    const contracts: TaskContract[] = draftDag.tasks.map((task) => {
      const { contractHash: _pending, ...base } = task;
      return { ...base, contractHash: RuntimeService.contractHash(base) };
    });
    const dag: TaskDag = { generation: 1, tasks: contracts };
    const semanticSource = {
      workItemId: state.workItemId,
      prdHash: state.currentPrd.contentHash,
      issuesHash: issuesManifest.contentHash,
      issueId,
      issueHash: issue.artifactHash,
    };
    const source = {
      ...semanticSource,
      configGeneration: config.generation,
      configHash: stableHash(config),
    };
    const proposalHash = stableHash({ source: semanticSource, slices, tasks: contracts });
    return {
      issue,
      repositoryRoot: repositoryManifest.repositoryRoot,
      repositoryRevision: repositoryManifest.repositoryRevision,
      config,
      source,
      semanticSource,
      proposalHash,
      slices: structuredClone(slices),
      drafts: structuredClone(drafts),
      contracts,
      dag,
    };
  }

  async submit(issueId: string, slices: SliceDraft[], drafts: MicroTaskDraft[], preflight?: TaskPreflightReference): Promise<{
    manifest: TaskPlanManifest;
    runtime: Awaited<ReturnType<RuntimeService["status"]>>;
    idempotent: boolean;
  }> {
    const prepared = await this.prepare(issueId, slices, drafts);
    const { issue, repositoryRoot, config, source, semanticSource, proposalHash, contracts, dag } = prepared;
    const contentHash = proposalHash;
    const issueRoot = this.issueRoot(issueId);
    const runtimeRoot = join(issueRoot, "runtime");
    const taskManifestPath = join(issueRoot, "task-manifest.json");
    const existing = await exists(taskManifestPath) ? JSON.parse(await readFile(taskManifestPath, "utf8")) as TaskPlanManifest : undefined;
    if (existing) {
      const existingGenerationPath = join(issueRoot, "task-generations", `tasks-${existing.generation}.json`);
      const existingGeneration = JSON.parse(await readFile(existingGenerationPath, "utf8")) as TaskPlanGeneration;
      const existingProposalHash = existing.proposalHash ?? existingGeneration.proposalHash ?? stableHash({
        source: {
          workItemId: existingGeneration.source.workItemId,
          prdHash: existingGeneration.source.prdHash,
          issuesHash: existingGeneration.source.issuesHash,
          issueId: existingGeneration.source.issueId,
          issueHash: existingGeneration.source.issueHash,
        },
        slices: existingGeneration.slices,
        tasks: existingGeneration.tasks,
      });
      if (existingProposalHash !== proposalHash) {
        throw new Error(`Task Plan already exists for ${issueId}; a different semantic proposal requires a DAG Amendment`);
      }
    }

    const createdAt = existing?.createdAt ?? new Date().toISOString();
    const generation: TaskPlanGeneration = {
      schemaVersion: 1,
      generation: 1,
      source,
      contentHash,
      proposalHash,
      ...(preflight ? { preflight: structuredClone(preflight) } : {}),
      slices: structuredClone(slices),
      tasks: contracts,
      createdAt,
    };
    const manifest: TaskPlanManifest = existing ?? {
      schemaVersion: 1,
      generation: 1,
      issueId,
      contentHash,
      proposalHash,
      ...(preflight ? { preflight: structuredClone(preflight) } : {}),
      runtimeRoot,
      slices: structuredClone(slices),
      taskIds: contracts.map((task) => task.id),
      createdAt,
    };

    if (!existing) {
      await atomicWriteJson(join(issueRoot, "task-generations", "tasks-1.json"), generation);
      for (const slice of slices) await atomicWriteText(join(issueRoot, "slices", slice.id, "SLICE.md"), renderSlice(slice));
      for (const contract of contracts) {
        const taskVersion = contract.version;
        const version = `V${String(taskVersion).padStart(3, "0")}`;
        const relativeContractPath = `tasks/${contract.id}/TASK-${version}.md`;
        await atomicWriteText(join(issueRoot, relativeContractPath), renderTask(contract, issue));
      }
      await atomicWriteJson(taskManifestPath, manifest);
    }

    const runtimeService = new RuntimeService(runtimeRoot);
    const runtimeExists = await exists(join(runtimeRoot, "state.json"));
    if (!runtimeExists) {
      await runtimeService.initialize({
        workItemId: semanticSource.workItemId,
        issueId,
        issueHash: issue.artifactHash,
        workspaceRoot: repositoryRoot,
        workspaceMode: config.workspace.mode,
        modelPolicy: this.modelPolicy(config),
        modelPolicySource: { configGeneration: config.generation, configHash: stableHash(config) },
      }, dag, slices);
    }
    return { manifest, runtime: await runtimeService.status(), idempotent: Boolean(existing && runtimeExists) };
  }

  async rebindModels(issueId: string, reason: string): Promise<{
    configGeneration: number;
    modelPolicyGeneration: number;
    idempotent: boolean;
    runtime: Awaited<ReturnType<RuntimeService["status"]>>;
  }> {
    const issueRoot = this.issueRoot(issueId);
    if (!(await exists(join(issueRoot, "task-manifest.json")))) throw new Error(`Task Plan does not exist for ${issueId}`);
    const workItem = new WorkItemService(this.workItemRoot);
    const repositoryManifest = await workItem.store.readManifest();
    const config = await loadForgeConfig(repositoryManifest.repositoryRoot);
    const runtimeService = new RuntimeService(join(issueRoot, "runtime"));
    const result = await runtimeService.rebindModelPolicy({
      configGeneration: config.generation,
      configHash: stableHash(config),
      policy: this.modelPolicy(config),
      reason,
    });
    return {
      configGeneration: config.generation,
      modelPolicyGeneration: result.policy.generation,
      idempotent: result.idempotent,
      runtime: result.state,
    };
  }
}
