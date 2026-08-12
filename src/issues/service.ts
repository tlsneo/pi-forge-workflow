import { stableHash } from "../runtime/hash.js";
import { WorkItemService } from "../work-item/service.js";
import type { WorkItemState } from "../work-item/types.js";
import type { IssueArtifact, IssueDraft, IssuesGeneration, IssuesManifest } from "./types.js";
import { validateIssueDrafts } from "./validation.js";

export class IssuesService {
  readonly workItem: WorkItemService;

  constructor(workItemRoot: string) {
    this.workItem = new WorkItemService(workItemRoot);
  }

  async status(): Promise<{ state: WorkItemState; manifest?: IssuesManifest }> {
    const opened = await this.workItem.open();
    const manifest = await this.workItem.store.readIssuesManifest();
    return { state: opened.state, ...(manifest ? { manifest } : {}) };
  }

  async submit(drafts: IssueDraft[]): Promise<{ state: WorkItemState; manifest: IssuesManifest; idempotent: boolean }> {
    const current = await this.workItem.store.readState();
    const frozen = current.frozenReceipt;
    const prdGeneration = current.currentPrd;
    if (current.status !== "frozen" || !frozen || !prdGeneration) {
      throw new Error("forge-issues requires a frozen PRD with a matching Receipt");
    }
    if (frozen.generation !== prdGeneration.generation || frozen.contentHash !== prdGeneration.contentHash) {
      throw new Error("Frozen PRD Receipt does not match the active PRD Generation");
    }
    const traceability = validateIssueDrafts(prdGeneration.prd, drafts);
    const workItemManifest = await this.workItem.store.readManifest();
    const source = {
      workItemId: current.workItemId,
      controlRoot: workItemManifest.controlRoot,
      repositoryRoot: workItemManifest.repositoryRoot,
      repositoryRevision: workItemManifest.repositoryRevision,
      prdGeneration: prdGeneration.generation,
      prdHash: prdGeneration.contentHash,
    };
    const issues: IssueArtifact[] = drafts.map((draft) => {
      const artifactBase = { schemaVersion: 1 as const, source, ...structuredClone(draft) };
      return { ...artifactBase, artifactHash: stableHash(artifactBase) };
    });
    const contentHash = stableHash({ source, issues });
    if (current.issues) {
      if (current.issues.contentHash !== contentHash) {
        throw new Error("Issues already exist for this frozen PRD; a different proposal requires a successor Work Item");
      }
      const manifest = await this.workItem.store.readIssuesManifest();
      if (!manifest) throw new Error("Issues state exists but manifest.json is missing");
      return { state: current, manifest, idempotent: true };
    }

    const createdAt = new Date().toISOString();
    const generation: IssuesGeneration = {
      schemaVersion: 1,
      generation: 1,
      source: {
        ...source,
        frozenReceiptHash: stableHash(frozen),
      },
      contentHash,
      issues,
      acceptanceTraceability: traceability,
      createdAt,
    };
    const manifest: IssuesManifest = {
      schemaVersion: 1,
      generation: generation.generation,
      source: generation.source,
      contentHash,
      issues: issues.map((issue) => ({
        id: issue.id,
        title: issue.title,
        artifactPath: `issues/${issue.id}/issue.json`,
        markdownPath: `issues/${issue.id}/ISSUE.md`,
        artifactHash: issue.artifactHash,
        dependencies: issue.dependencies,
        acceptanceIds: issue.acceptanceIds,
        tracker: { mode: "local" },
      })),
      acceptanceTraceability: traceability,
      createdAt,
    };
    await this.workItem.store.writeIssuesGeneration(generation, manifest);
    const state = await this.workItem.store.transact("issues_generated", (next) => {
      if (next.currentPrd?.contentHash !== generation.source.prdHash || next.frozenReceipt?.contentHash !== generation.source.prdHash) {
        throw new Error("Frozen PRD changed while Issues were being generated");
      }
      next.issues = generation;
    }, {
      issuesGeneration: generation.generation,
      contentHash,
      issueIds: issues.map((issue) => issue.id),
      acceptanceTraceability: traceability,
    });
    return { state, manifest, idempotent: false };
  }
}
