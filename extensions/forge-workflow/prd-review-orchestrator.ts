import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadForgeConfig, resolveForgeProfile, type ResolvedForgeProfile } from "../../src/config/resolver.js";
import { buildBlockerVerificationPrompt, buildPrdReviewPrompt } from "../../src/work-item/review-prompts.js";
import { WorkItemService } from "../../src/work-item/service.js";
import type { PrdReviewJob, PrdReviewJobPlan, ReviewAxis } from "../../src/work-item/types.js";
import { PiSubagentsAdapter, type SubagentLifecycleEvent } from "../../src/subagents/adapter.js";

interface ReviewLocation {
  kind: "review" | "blocker_verification";
  workItemRoot: string;
  jobId: string;
  bindingId: string;
}

interface SpawnResult {
  jobId: string;
  bindingId?: string;
  agentId?: string;
  status: "started" | "failed";
  error?: string;
}

const AXES: ReviewAxis[] = ["coverage", "evidence", "architecture"];
const ROLE_BY_AXIS: Record<ReviewAxis, string> = {
  coverage: "prdCoverageReview",
  evidence: "prdEvidenceReview",
  architecture: "prdArchitectureReview",
};

function countForAxis(config: Awaited<ReturnType<typeof loadForgeConfig>>, axis: ReviewAxis): number {
  if (axis === "coverage") return config.review.prd.coverageReviewers;
  if (axis === "evidence") return config.review.prd.evidenceReviewers;
  return config.review.prd.architectureReviewers;
}

function bindingDescription(bindingId: string, jobId: string): string {
  return `forge-prd-review:${bindingId}:${jobId}`;
}

function blockerBindingDescription(bindingId: string, jobId: string): string {
  return `forge-prd-blocker:${bindingId}:${jobId}`;
}

function parseBindingDescription(description: string): { kind: ReviewLocation["kind"]; bindingId: string; jobId: string } | undefined {
  const review = /^forge-prd-review:([^:]+):(.+)$/.exec(description);
  if (review?.[1] && review[2]) return { kind: "review", bindingId: review[1], jobId: review[2] };
  const blocker = /^forge-prd-blocker:([^:]+):(.+)$/.exec(description);
  return blocker?.[1] && blocker[2] ? { kind: "blocker_verification", bindingId: blocker[1], jobId: blocker[2] } : undefined;
}

async function resolveExactModel(ctx: ExtensionContext, input: string): Promise<unknown> {
  const slash = input.indexOf("/");
  if (slash < 1) throw new Error(`Model must be exact provider/model: ${input}`);
  const model = ctx.modelRegistry.find(input.slice(0, slash), input.slice(slash + 1));
  if (!model) throw new Error(`Configured model is unavailable: ${input}; rerun /skill:forge-init`);
  return model;
}

export class PrdReviewOrchestrator {
  private readonly adapter: PiSubagentsAdapter;
  private readonly bindingLocations = new Map<string, ReviewLocation>();
  private readonly agentLocations = new Map<string, ReviewLocation>();
  private readonly modelByJob = new Map<string, unknown>();
  private readonly verifierByWorkItem = new Map<string, { model: unknown; route: ResolvedForgeProfile }>();
  private readonly blockerStarting = new Set<string>();

  constructor(adapter: PiSubagentsAdapter) {
    this.adapter = adapter;
    adapter.onStarted((event) => this.handleStarted(event));
    adapter.onCompleted((event) => this.handleTerminal(event, "completed"));
    adapter.onFailed((event) => {
      const terminal = event.status === "stopped" || event.status === "aborted" ? event.status : "failed";
      this.handleTerminal(event, terminal);
    });
  }

  async ensureReady(workItemRoot: string, ctx: ExtensionContext): Promise<void> {
    const manifest = await new WorkItemService(workItemRoot).store.readManifest();
    const config = await loadForgeConfig(manifest.repositoryRoot);
    const reviewModels = new Set<string>();
    for (const axis of AXES) {
      const route = resolveForgeProfile(config, ROLE_BY_AXIS[axis]);
      reviewModels.add(route.model);
      await resolveExactModel(ctx, route.model);
    }
    const verifier = resolveForgeProfile(config, "blockerVerifier");
    await resolveExactModel(ctx, verifier.model);
    if (config.review.blockerVerification.requireDifferentModel && reviewModels.has(verifier.model)) {
      throw new Error(`Blocker Verifier model ${verifier.model} must differ from PRD Reviewer models; rerun /skill:forge-init`);
    }
    const protocol = await this.adapter.ping();
    if (protocol < 2) throw new Error(`Unsupported pi-subagents RPC protocol: ${protocol}`);
  }

  async startRequiredReviews(workItemRoot: string, ctx: ExtensionContext): Promise<SpawnResult[]> {
    const service = new WorkItemService(workItemRoot);
    const manifest = await service.store.readManifest();
    const config = await loadForgeConfig(manifest.repositoryRoot);
    const protocol = await this.adapter.ping();
    if (protocol < 2) throw new Error(`Unsupported pi-subagents RPC protocol: ${protocol}`);
    const verifierRoute = resolveForgeProfile(config, "blockerVerifier");
    const verifierModel = await resolveExactModel(ctx, verifierRoute.model);
    this.verifierByWorkItem.set(workItemRoot, { model: verifierModel, route: verifierRoute });

    let state = await service.store.readState();
    const prd = state.currentPrd;
    if (!prd) throw new Error("No PRD has been submitted");
    const currentJobs = Object.values(state.reviewJobs ?? {}).filter((job) => job.prdGeneration === prd.generation);
    if (currentJobs.length === 0) {
      const plans: PrdReviewJobPlan[] = [];
      for (const axis of AXES) {
        if (state.reviews[axis]?.verdict === "passed") continue;
        const route = resolveForgeProfile(config, ROLE_BY_AXIS[axis]);
        await resolveExactModel(ctx, route.model);
        const requiredCount = countForAxis(config, axis);
        for (let ordinal = 1; ordinal <= requiredCount; ordinal += 1) {
          plans.push({
            id: `prd-${prd.generation}-${axis}-${ordinal}`,
            axis,
            ordinal,
            requiredCount,
            prdGeneration: prd.generation,
            surfaceHash: prd.reviewSurfaceHashes[axis],
            profile: route.profile,
            model: route.model,
            thinking: route.thinking,
            maxTurns: route.maxTurns,
            maxAttempts: 2,
            configGeneration: route.configGeneration,
            configHash: route.configHash,
          });
        }
      }
      if (plans.length > 0) state = await service.createReviewJobs(plans);
    }

    await this.index(workItemRoot);
    const jobs = Object.values(state.reviewJobs ?? {})
      .filter((job) => job.prdGeneration === prd.generation && ["pending", "retry_ready", "interrupted"].includes(job.status))
      .sort((left, right) => left.id.localeCompare(right.id));
    return Promise.all(jobs.map(async (job) => {
      const model = await resolveExactModel(ctx, job.model);
      this.modelByJob.set(`${workItemRoot}:${job.id}`, model);
      return this.spawnJob(workItemRoot, job.id, model);
    }));
  }

  async resumeReviews(workItemRoot: string, ctx: ExtensionContext, reason: string): Promise<{ reviews: SpawnResult[]; blocker?: SpawnResult }> {
    await new WorkItemService(workItemRoot).recoverInterruptedReviewCoordination(reason);
    const reviews = await this.startRequiredReviews(workItemRoot, ctx);
    const blocker = await this.startCachedBlockerVerification(workItemRoot);
    return { reviews, ...(blocker ? { blocker } : {}) };
  }

  async startBlockerVerification(workItemRoot: string, ctx: ExtensionContext): Promise<SpawnResult | undefined> {
    const service = new WorkItemService(workItemRoot);
    const manifest = await service.store.readManifest();
    const config = await loadForgeConfig(manifest.repositoryRoot);
    const route = resolveForgeProfile(config, "blockerVerifier");
    const model = await resolveExactModel(ctx, route.model);
    this.verifierByWorkItem.set(workItemRoot, { model, route });
    return this.startCachedBlockerVerification(workItemRoot);
  }

  async index(workItemRoot: string): Promise<void> {
    const state = await new WorkItemService(workItemRoot).store.readState();
    for (const job of Object.values(state.reviewJobs ?? {})) {
      if (!job.binding) continue;
      const location: ReviewLocation = { kind: "review", workItemRoot, jobId: job.id, bindingId: job.binding.id };
      this.bindingLocations.set(job.binding.id, location);
      if (job.binding.agentId) this.agentLocations.set(job.binding.agentId, location);
    }
    const blockerJob = state.blockerVerificationJob;
    if (blockerJob?.binding) {
      const location: ReviewLocation = { kind: "blocker_verification", workItemRoot, jobId: blockerJob.id, bindingId: blockerJob.binding.id };
      this.bindingLocations.set(blockerJob.binding.id, location);
      if (blockerJob.binding.agentId) this.agentLocations.set(blockerJob.binding.agentId, location);
    }
  }

  private async spawnJob(workItemRoot: string, jobId: string, model: unknown): Promise<SpawnResult> {
    const service = new WorkItemService(workItemRoot);
    const state = await service.store.readState();
    const job = state.reviewJobs?.[jobId];
    const prd = state.currentPrd;
    if (!job || !prd) throw new Error(`Missing active PRD Review Job ${jobId}`);
    if (!["pending", "retry_ready", "interrupted"].includes(job.status)) {
      return { jobId, status: "failed", error: `${jobId} is ${job.status}` };
    }
    const manifest = await service.store.readManifest();
    const binding = WorkItemService.createReviewBinding({
      jobId: job.id,
      workItemId: state.workItemId,
      prdGeneration: job.prdGeneration,
      axis: job.axis,
      surfaceHash: job.surfaceHash,
      attempt: job.attempt + 1,
      profile: job.profile,
      model: job.model,
      thinking: job.thinking,
      maxTurns: job.maxTurns,
      startedStateGeneration: state.generation,
    });
    await service.claimReviewJob(job.id, binding);
    const location: ReviewLocation = { kind: "review", workItemRoot, jobId: job.id, bindingId: binding.id };
    this.bindingLocations.set(binding.id, location);
    const prompt = buildPrdReviewPrompt({
      axis: job.axis,
      workItemRoot,
      prdPath: workItemRoot + "/PRD.md",
      repositoryRoot: manifest.repositoryRoot,
      repositoryRevision: manifest.repositoryRevision,
      prdGeneration: job.prdGeneration,
      surfaceHash: job.surfaceHash,
      bindingId: binding.id,
    });

    try {
      const agentId = await this.adapter.spawn({
        type: "forge-reviewer",
        prompt,
        description: bindingDescription(binding.id, job.id),
        model,
        thinkingLevel: job.thinking,
        maxTurns: job.maxTurns,
        cwd: manifest.repositoryRoot,
      });
      await service.bindReviewAgent(job.id, binding.id, agentId);
      this.agentLocations.set(agentId, location);
      return { jobId, bindingId: binding.id, agentId, status: "started" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await service.markReviewSpawnFailed(job.id, message);
      return { jobId, bindingId: binding.id, status: "failed", error: message };
    }
  }

  private async startCachedBlockerVerification(workItemRoot: string): Promise<SpawnResult | undefined> {
    if (this.blockerStarting.has(workItemRoot)) return undefined;
    const cached = this.verifierByWorkItem.get(workItemRoot);
    if (!cached) return undefined;
    this.blockerStarting.add(workItemRoot);
    try {
      const service = new WorkItemService(workItemRoot);
      let state = await service.store.readState();
      const prd = state.currentPrd;
      if (!prd || !AXES.every((axis) => state.reviews[axis])) return undefined;
      const blockers = AXES.flatMap((axis) => (state.reviews[axis]?.findings ?? []).filter((finding) => finding.severity === "blocker"));
      if (blockers.length === 0) return undefined;
      if (!state.blockerVerificationJob) {
        state = await service.createBlockerVerificationJob({
          profile: cached.route.profile,
          model: cached.route.model,
          thinking: cached.route.thinking,
          maxTurns: cached.route.maxTurns,
          maxAttempts: 2,
          configGeneration: cached.route.configGeneration,
          configHash: cached.route.configHash,
        });
      }
      const job = state.blockerVerificationJob;
      if (!job || !["pending", "retry_ready", "interrupted"].includes(job.status)) return undefined;
      this.modelByJob.set(`${workItemRoot}:${job.id}`, cached.model);
      return this.spawnBlockerJob(workItemRoot, cached.model);
    } finally {
      this.blockerStarting.delete(workItemRoot);
    }
  }

  private async spawnBlockerJob(workItemRoot: string, model: unknown): Promise<SpawnResult> {
    const service = new WorkItemService(workItemRoot);
    const state = await service.store.readState();
    const job = state.blockerVerificationJob;
    const prd = state.currentPrd;
    if (!job || !prd) throw new Error("Missing active PRD Blocker Verification Job");
    const manifest = await service.store.readManifest();
    const binding = WorkItemService.createBlockerVerificationBinding({
      jobId: job.id,
      workItemId: state.workItemId,
      prdGeneration: job.prdGeneration,
      findingHash: job.findingHash,
      attempt: job.attempt + 1,
      profile: job.profile,
      model: job.model,
      thinking: job.thinking,
      maxTurns: job.maxTurns,
      startedStateGeneration: state.generation,
    });
    await service.claimBlockerVerification(binding);
    const location: ReviewLocation = { kind: "blocker_verification", workItemRoot, jobId: job.id, bindingId: binding.id };
    this.bindingLocations.set(binding.id, location);
    const prompt = buildBlockerVerificationPrompt({
      workItemRoot,
      prdPath: workItemRoot + "/PRD.md",
      repositoryRoot: manifest.repositoryRoot,
      repositoryRevision: manifest.repositoryRevision,
      prdGeneration: job.prdGeneration,
      bindingId: binding.id,
      findings: job.findings.map((item) => item.finding),
    });
    try {
      const agentId = await this.adapter.spawn({
        type: "forge-reviewer",
        prompt,
        description: blockerBindingDescription(binding.id, job.id),
        model,
        thinkingLevel: job.thinking,
        maxTurns: job.maxTurns,
        cwd: manifest.repositoryRoot,
      });
      await service.bindBlockerVerificationAgent(binding.id, agentId);
      this.agentLocations.set(agentId, location);
      return { jobId: job.id, bindingId: binding.id, agentId, status: "started" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await service.markBlockerVerifierSpawnFailed(message);
      return { jobId: job.id, bindingId: binding.id, status: "failed", error: message };
    }
  }

  private async locate(event: SubagentLifecycleEvent): Promise<ReviewLocation | undefined> {
    const existing = this.agentLocations.get(event.id);
    if (existing) return existing;
    const parsed = parseBindingDescription(event.description);
    if (!parsed) return undefined;
    const location = this.bindingLocations.get(parsed.bindingId);
    if (!location || location.jobId !== parsed.jobId || location.kind !== parsed.kind) return undefined;
    const service = new WorkItemService(location.workItemRoot);
    if (location.kind === "review") await service.bindReviewAgent(location.jobId, location.bindingId, event.id);
    else await service.bindBlockerVerificationAgent(location.bindingId, event.id);
    this.agentLocations.set(event.id, location);
    return location;
  }

  private handleStarted(event: SubagentLifecycleEvent): void {
    void (async () => {
      const location = await this.locate(event);
      if (!location) return;
      const service = new WorkItemService(location.workItemRoot);
      if (location.kind === "review") await service.markReviewAgentStarted(event.id);
      else await service.markBlockerVerifierStarted(event.id);
    })().catch((error: unknown) => console.error("[pi-forge-workflow] PRD Reviewer started event failed", error));
  }

  private handleTerminal(event: SubagentLifecycleEvent, terminal: "completed" | "failed" | "stopped" | "aborted"): void {
    void (async () => {
      const location = await this.locate(event);
      if (!location) return;
      const service = new WorkItemService(location.workItemRoot);
      if (location.kind === "review") {
        const state = await service.markReviewAgentTerminal(event.id, terminal, event.error);
        const job = state.reviewJobs?.[location.jobId];
        if (!job) return;
        if (job.result) {
          await this.startCachedBlockerVerification(location.workItemRoot);
          return;
        }
        if (!["retry_ready", "interrupted"].includes(job.status) || job.attempt >= job.maxAttempts) return;
        const model = this.modelByJob.get(`${location.workItemRoot}:${job.id}`);
        if (model) await this.spawnJob(location.workItemRoot, job.id, model);
      } else {
        const state = await service.markBlockerVerifierTerminal(event.id, terminal, event.error);
        const job = state.blockerVerificationJob;
        if (!job || !["retry_ready", "interrupted"].includes(job.status) || job.attempt >= job.maxAttempts) return;
        const model = this.modelByJob.get(`${location.workItemRoot}:${job.id}`);
        if (model) await this.spawnBlockerJob(location.workItemRoot, model);
      }
    })().catch((error: unknown) => console.error("[pi-forge-workflow] PRD Reviewer terminal event failed", error));
  }
}
