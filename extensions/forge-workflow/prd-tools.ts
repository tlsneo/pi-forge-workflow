import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadForgeConfig } from "../../src/config/resolver.js";
import { WorkItemService } from "../../src/work-item/service.js";
import { discoverGitRepositories, resolveGitRepository } from "../../src/work-item/repositories.js";
import type { DiscoveryCheckpoint, ForgePrd, PrdBlockerVerificationResult, PrdReview, ReviewAxis, ReviewVerdict } from "../../src/work-item/types.js";
import type { PrdReviewOrchestrator } from "./prd-review-orchestrator.js";

const WorkItemRoot = Type.String({ description: "Existing Forge Work Item root used for resume; omit it from forge_prd_open when creating" });
const DecisionSchema = Type.Object({
  id: Type.String(),
  question: Type.String(),
  dependsOn: Type.Array(Type.String()),
  status: Type.Union([Type.Literal("open"), Type.Literal("answered"), Type.Literal("external")]),
  recommendedAnswer: Type.Optional(Type.String()),
  answer: Type.Optional(Type.String()),
  answerSource: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("repository"), Type.Literal("external")])),
});
const EvidenceSchema = Type.Object({
  id: Type.String(),
  path: Type.String(),
  symbol: Type.String(),
  claim: Type.String(),
  repositoryRevision: Type.String(),
});
const CheckpointSchema = Type.Object({
  decisions: Type.Array(DecisionSchema),
  evidence: Type.Array(EvidenceSchema),
  summary: Type.String(),
  status: Type.Optional(Type.Union([
    Type.Literal("discovery"),
    Type.Literal("drafting"),
    Type.Literal("blocked"),
    Type.Literal("needs_external_input"),
  ])),
});
const PrdSchema = Type.Object({
  title: Type.String(),
  problem: Type.String(),
  solution: Type.String(),
  goals: Type.Array(Type.String()),
  nonGoals: Type.Array(Type.String()),
  actors: Type.Array(Type.String()),
  userStories: Type.Array(Type.Object({
    id: Type.String(),
    actor: Type.String(),
    capability: Type.String(),
    benefit: Type.String(),
  })),
  acceptance: Type.Array(Type.Object({
    id: Type.String(),
    statement: Type.String(),
    verification: Type.Array(Type.String()),
  })),
  behavior: Type.Object({
    happyPath: Type.Array(Type.String()),
    errorPaths: Type.Array(Type.String()),
    edgeCases: Type.Array(Type.String()),
  }),
  decisions: Type.Array(Type.Object({
    id: Type.String(),
    decision: Type.String(),
    rationale: Type.String(),
    evidenceIds: Type.Array(Type.String()),
    alternatives: Type.Optional(Type.Array(Type.String())),
  })),
  impactEvidence: Type.Array(EvidenceSchema),
  testSeams: Type.Array(Type.Object({
    name: Type.String(),
    level: Type.Union([Type.Literal("unit"), Type.Literal("integration"), Type.Literal("system"), Type.Literal("manual")]),
    evidenceIds: Type.Array(Type.String()),
    verification: Type.String(),
  })),
  risks: Type.Array(Type.Object({ risk: Type.String(), mitigation: Type.String() })),
  deliveryBoundaries: Type.Array(Type.Object({
    id: Type.String(),
    title: Type.String(),
    outcome: Type.String(),
    goal: Type.String(),
    scope: Type.Array(Type.String()),
    acceptanceIds: Type.Array(Type.String()),
    behavior: Type.Object({ happyPath: Type.Array(Type.String()), errorPaths: Type.Array(Type.String()), edgeCases: Type.Array(Type.String()) }),
    decisionIds: Type.Array(Type.String()),
    impactEvidenceIds: Type.Array(Type.String()),
    testSeamNames: Type.Array(Type.String()),
    nonGoals: Type.Array(Type.String()),
    verification: Type.Array(Type.String()),
    dependencies: Type.Array(Type.String()),
    independentlyDeliverable: Type.Boolean(),
    rationale: Type.String(),
  })),
  migration: Type.Optional(Type.String()),
  rollback: Type.Optional(Type.String()),
  diagrams: Type.Array(Type.Object({
    kind: Type.Union([Type.Literal("flow"), Type.Literal("sequence"), Type.Literal("state"), Type.Literal("er")]),
    title: Type.String(),
    rationale: Type.String(),
    mermaid: Type.String(),
  })),
  openQuestions: Type.Array(Type.String()),
});

function text(content: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text: content }], details };
}

function normalizeRoot(cwd: string, input: string): string {
  return resolve(cwd, input.replace(/^@/, ""));
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "change";
}

function asObject<T>(value: unknown, label: string): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as T;
}


export function registerPrdTools(pi: ExtensionAPI, orchestrator: PrdReviewOrchestrator): void {
  pi.registerTool({
    name: "forge_prd_repositories",
    label: "Forge PRD Repositories",
    description: "Discover selectable Git Working Trees under the Forge Control Root without classifying repository organization",
    parameters: Type.Object({ maxDepth: Type.Optional(Type.Integer({ minimum: 0, maximum: 12 })) }),
    async execute(_id, params, _signal, _update, ctx) {
      const repositories = await discoverGitRepositories(ctx.cwd, params.maxDepth);
      return text(JSON.stringify({ controlRoot: ctx.cwd, repositories }, null, 2), { controlRoot: ctx.cwd, repositories });
    },
  });

  pi.registerTool({
    name: "forge_prd_open",
    label: "Forge PRD Open",
    description: "Create or resume a persistent Forge PRD Work Item and return its decision frontier",
    promptSnippet: "Open the Forge PRD Work Item before interviewing or drafting",
    parameters: Type.Object({
      workItemRoot: Type.Optional(WorkItemRoot),
      title: Type.Optional(Type.String()),
      repositoryRoot: Type.Optional(Type.String({ description: "Target Git Working Tree, absolute or relative to the Forge Control Root" })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      let root: string;
      if (params.workItemRoot) {
        root = normalizeRoot(ctx.cwd, params.workItemRoot);
        if (root === resolve(ctx.cwd)) throw new Error("The Control Root cannot be used as a Work Item root; omit workItemRoot to create under the configured artifact directory");
      } else {
        if (!params.title?.trim()) throw new Error("title is required when creating a Work Item");
        const config = await loadForgeConfig(ctx.cwd);
        root = join(ctx.cwd, config.artifacts.root, "work-items", `${slugify(params.title)}-${randomUUID().slice(0, 8)}`);
      }

      const service = new WorkItemService(root);
      if (await service.store.exists()) {
        const manifest = await service.store.readManifest();
        if (resolve(ctx.cwd) !== resolve(manifest.controlRoot)) throw new Error(`Resume this Work Item from its frozen Control Root: ${manifest.controlRoot}`);
      }
      if (!(await service.store.exists())) {
        if (!params.title?.trim()) throw new Error("Work Item does not exist; title is required to initialize it");
        let target = params.repositoryRoot?.trim();
        const repositories = await discoverGitRepositories(ctx.cwd);
        if (!target) {
          if (repositories.length === 1) target = repositories[0]!.repositoryRoot;
          else if (repositories.length === 0) throw new Error("No Git Working Tree was discovered under the Control Root; pass repositoryRoot explicitly");
          else return text("Repository selection is required before creating the Work Item.", { controlRoot: ctx.cwd, repositories, needsRepositorySelection: true });
        }
        const repository = await resolveGitRepository(ctx.cwd, target);
        await service.initialize({
          workItemId: root.split("/").at(-1) ?? randomUUID(),
          title: params.title,
          controlRoot: ctx.cwd,
          repositoryRoot: repository.repositoryRoot,
          repositoryRevision: repository.revision,
        });
      } else if (params.repositoryRoot?.trim()) {
        const manifest = await service.store.readManifest();
        const asserted = await resolveGitRepository(manifest.controlRoot, params.repositoryRoot);
        if (asserted.repositoryRoot !== manifest.repositoryRoot) throw new Error("Existing Work Item Target Repository is immutable");
      }
      const opened = await service.open();
      await orchestrator.index(root);
      return text(JSON.stringify({ workItemRoot: root, ...opened }, null, 2), { workItemRoot: root, ...opened });
    },
  });

  pi.registerTool({
    name: "forge_prd_supersede",
    label: "Forge PRD Supersede",
    description: "Create a new discovery Work Item that immutably supersedes one frozen Work Item",
    parameters: Type.Object({
      workItemRoot: WorkItemRoot,
      title: Type.Optional(Type.String()),
      reason: Type.String(),
      authorizedBy: Type.String(),
      authorizationEvidence: Type.String(),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const predecessorRoot = normalizeRoot(ctx.cwd, params.workItemRoot);
      const predecessorManifest = await new WorkItemService(predecessorRoot).store.readManifest();
      if (resolve(ctx.cwd) !== resolve(predecessorManifest.controlRoot)) throw new Error(`Run forge-prd from the frozen Control Root: ${predecessorManifest.controlRoot}`);
      const config = await loadForgeConfig(predecessorManifest.controlRoot);
      const title = params.title?.trim() || predecessorManifest.title;
      const successorId = `${slugify(title)}-${randomUUID().slice(0, 8)}`;
      const successorRoot = join(predecessorManifest.controlRoot, config.artifacts.root, "work-items", successorId);
      const created = await new WorkItemService(predecessorRoot).createSuccessor({
        successorRoot,
        successorWorkItemId: successorId,
        title,
        repositoryRevision: (await resolveGitRepository(predecessorManifest.controlRoot, predecessorManifest.repositoryRoot)).revision,
        reason: params.reason,
        authorizedBy: params.authorizedBy,
        authorizationEvidence: params.authorizationEvidence,
      });
      await orchestrator.index(successorRoot);
      return text(`Created successor Work Item ${successorId}. The predecessor remains frozen; continue discovery in ${successorRoot}.`, {
        predecessorRoot,
        workItemRoot: successorRoot,
        ...created,
      });
    },
  });

  pi.registerTool({
    name: "forge_prd_status",
    label: "Forge PRD Status",
    description: "Read and reconcile a Forge PRD Work Item",
    parameters: Type.Object({ workItemRoot: WorkItemRoot }),
    async execute(_id, params, _signal, _update, ctx) {
      const root = normalizeRoot(ctx.cwd, params.workItemRoot);
      const opened = await new WorkItemService(root).open();
      await orchestrator.index(root);
      return text(JSON.stringify({ workItemRoot: root, ...opened }, null, 2), { workItemRoot: root, ...opened });
    },
  });

  pi.registerTool({
    name: "forge_prd_checkpoint",
    label: "Forge PRD Checkpoint",
    description: "Persist the complete PRD discovery decision tree, repository evidence, and semantic summary",
    parameters: Type.Object({ workItemRoot: WorkItemRoot, checkpoint: CheckpointSchema }),
    async execute(_id, params, _signal, _update, ctx) {
      const root = normalizeRoot(ctx.cwd, params.workItemRoot);
      const checkpoint = asObject<DiscoveryCheckpoint>(params.checkpoint, "checkpoint");
      const state = await new WorkItemService(root).checkpoint(checkpoint);
      return text("Discovery checkpoint saved.", { workItemRoot: root, state });
    },
  });

  pi.registerTool({
    name: "forge_prd_submit",
    label: "Forge PRD Submit",
    description: "Validate and persist a new immutable structured PRD generation and render PRD.md",
    parameters: Type.Object({ workItemRoot: WorkItemRoot, prd: PrdSchema }),
    async execute(_id, params, _signal, _update, ctx) {
      const root = normalizeRoot(ctx.cwd, params.workItemRoot);
      const prd = asObject<ForgePrd>(params.prd, "prd");
      await orchestrator.ensureReady(root, ctx);
      const state = await new WorkItemService(root).submitPrd(prd);
      const generation = state.currentPrd;
      const reviewSpawns = await orchestrator.startRequiredReviews(root, ctx);
      return text(
        `PRD Generation ${generation?.generation} submitted. Generated top-level ${join(root, "PRD.md")} and started ${reviewSpawns.filter((spawn) => spawn.status === "started").length} Reviewers.`,
        { workItemRoot: root, prdPath: join(root, "PRD.md"), state: await new WorkItemService(root).store.readState(), reviewSpawns },
      );
    },
  });

  pi.registerTool({
    name: "forge_prd_amend",
    label: "Forge PRD Amend",
    description: "Create a new immutable PRD generation and deterministically carry only passed reviews whose axis surface did not change",
    parameters: Type.Object({
      workItemRoot: WorkItemRoot,
      reason: Type.String(),
      authorizedBy: Type.String(),
      authorizationEvidence: Type.String(),
      prd: PrdSchema,
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const root = normalizeRoot(ctx.cwd, params.workItemRoot);
      await orchestrator.ensureReady(root, ctx);
      const state = await new WorkItemService(root).amendPrd({
        reason: params.reason,
        authorization: { actor: params.authorizedBy, evidence: params.authorizationEvidence },
        prd: asObject<ForgePrd>(params.prd, "prd"),
      });
      const reviewSpawns = state.status === "reviewing" ? await orchestrator.startRequiredReviews(root, ctx) : [];
      return text(
        `PRD amended to Generation ${state.currentPrd?.generation}. Invalidated reviews: ${state.lastAmendment?.invalidatedReviewAxes.join(", ") || "none"}. Started ${reviewSpawns.filter((spawn) => spawn.status === "started").length} Reviewers.`,
        { workItemRoot: root, state: await new WorkItemService(root).store.readState(), reviewSpawns },
      );
    },
  });

  pi.registerTool({
    name: "forge_prd_review",
    label: "Forge PRD Review",
    description: "Submit one structured independent PRD review for the current axis-specific review surface hash",
    parameters: Type.Object({
      workItemRoot: WorkItemRoot,
      axis: Type.Union([Type.Literal("coverage"), Type.Literal("evidence"), Type.Literal("architecture")]),
      verdict: Type.Union([Type.Literal("passed"), Type.Literal("blocked")]),
      surfaceHash: Type.String(),
      bindingId: Type.Optional(Type.String()),
      reviewerId: Type.Optional(Type.String({ description: "Legacy manual review identity; automated Review Jobs require bindingId" })),
      findings: Type.Array(Type.Object({
        id: Type.String(),
        severity: Type.Union([Type.Literal("blocker"), Type.Literal("warning"), Type.Literal("note")]),
        message: Type.String(),
        evidence: Type.Array(Type.String()),
        violatedRule: Type.String(),
        verification: Type.String(),
        suggestedResolution: Type.Optional(Type.String()),
      })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const root = normalizeRoot(ctx.cwd, params.workItemRoot);
      const service = new WorkItemService(root);
      if (params.bindingId) {
        const state = await service.submitBoundReview({
          bindingId: params.bindingId,
          axis: params.axis as ReviewAxis,
          verdict: params.verdict as ReviewVerdict,
          surfaceHash: params.surfaceHash,
          findings: params.findings,
        });
        return { ...text(`${params.axis} bound review recorded as ${params.verdict}.`, { workItemRoot: root, state }), terminate: true };
      }
      if (!params.reviewerId?.trim()) throw new Error("Automated Review Jobs require bindingId; legacy manual reviews require reviewerId");
      const review: Omit<PrdReview, "submittedAt"> = {
        axis: params.axis as ReviewAxis,
        verdict: params.verdict as ReviewVerdict,
        surfaceHash: params.surfaceHash,
        reviewerId: params.reviewerId,
        findings: params.findings,
      };
      const state = await service.submitReview(review);
      return text(`${params.axis} review recorded as ${params.verdict}.`, { workItemRoot: root, state });
    },
  });

  pi.registerTool({
    name: "forge_prd_verify_blockers",
    label: "Forge PRD Verify Blockers",
    description: "Submit one independent Binding-bound verification result for every current PRD Blocker",
    parameters: Type.Object({
      workItemRoot: WorkItemRoot,
      bindingId: Type.String(),
      results: Type.Array(Type.Object({
        findingId: Type.String(),
        status: Type.Union([Type.Literal("confirmed"), Type.Literal("rejected"), Type.Literal("needs_more_evidence")]),
        evidence: Type.Array(Type.String()),
        rationale: Type.String(),
        missingEvidence: Type.Optional(Type.Array(Type.String())),
      })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const root = normalizeRoot(ctx.cwd, params.workItemRoot);
      const state = await new WorkItemService(root).submitBlockerVerification(
        params.bindingId,
        params.results as PrdBlockerVerificationResult[],
      );
      return { ...text("PRD Blocker verification recorded.", { workItemRoot: root, state }), terminate: true };
    },
  });

  pi.registerTool({
    name: "forge_prd_resume_reviews",
    label: "Forge PRD Resume Reviews",
    description: "Explicitly take over interrupted PRD review coordination, invalidate live-looking orphan bindings, and spawn retry Bindings",
    parameters: Type.Object({ workItemRoot: WorkItemRoot, reason: Type.String() }),
    async execute(_id, params, _signal, _update, ctx) {
      const root = normalizeRoot(ctx.cwd, params.workItemRoot);
      const resumed = await orchestrator.resumeReviews(root, ctx, params.reason);
      const state = await new WorkItemService(root).store.readState();
      return text(`Resumed PRD reviews with ${resumed.reviews.filter((spawn) => spawn.status === "started").length} Reviewers${resumed.blocker ? " and one Blocker Verifier" : ""}.`, {
        workItemRoot: root,
        resumed,
        state,
      });
    },
  });

  pi.registerTool({
    name: "forge_prd_approve",
    label: "Forge PRD Approve",
    description: "Record explicit user approval for the current reviewed PRD hash",
    parameters: Type.Object({
      workItemRoot: WorkItemRoot,
      approvedBy: Type.String(),
      evidence: Type.String({ description: "Exact user approval statement or durable reference" }),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const root = normalizeRoot(ctx.cwd, params.workItemRoot);
      const state = await new WorkItemService(root).approve({ approvedBy: params.approvedBy, evidence: params.evidence });
      return text("PRD approval recorded. Call forge_prd_freeze next.", { workItemRoot: root, state });
    },
  });

  pi.registerTool({
    name: "forge_prd_freeze",
    label: "Forge PRD Freeze",
    description: "Freeze the current PRD only when decisions, reviews, evidence, open questions, and approval pass all gates",
    parameters: Type.Object({ workItemRoot: WorkItemRoot }),
    async execute(_id, params, _signal, _update, ctx) {
      const root = normalizeRoot(ctx.cwd, params.workItemRoot);
      const state = await new WorkItemService(root).freeze();
      return text(`PRD frozen at ${state.frozenReceipt?.contentHash}.`, { workItemRoot: root, state });
    },
  });
}
