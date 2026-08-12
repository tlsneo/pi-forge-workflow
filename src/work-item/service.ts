import { randomUUID } from "node:crypto";
import { stableHash } from "../runtime/hash.js";
import { allReviewSurfaceHashes, reviewSurfaceHash } from "./review-surfaces.js";
import { WorkItemStore } from "./store.js";
import type {
  DiscoveryCheckpoint,
  ForgePrd,
  FrozenPrdReceipt,
  PrdAmendment,
  PrdBlockerFinding,
  PrdBlockerVerificationBinding,
  PrdBlockerVerificationJob,
  PrdBlockerVerificationResult,
  PrdApproval,
  PrdGeneration,
  PrdReview,
  PrdReviewBinding,
  PrdReviewJob,
  PrdReviewJobPlan,
  ReviewAxis,
  WorkItemManifest,
  WorkItemState,
} from "./types.js";
import {
  calculateDecisionFrontier,
  requiredReviewAxes,
  validateDecisionTree,
  validateEvidence,
  validatePrd,
  validateReview,
} from "./validation.js";

function reviewJobs(state: WorkItemState): Record<string, PrdReviewJob> {
  return state.reviewJobs ?? (state.reviewJobs = {});
}

function individualReviews(state: WorkItemState): Record<string, PrdReview> {
  return state.individualReviews ?? (state.individualReviews = {});
}

function blockerFindings(state: WorkItemState): PrdBlockerFinding[] {
  const findings: PrdBlockerFinding[] = [];
  for (const axis of requiredReviewAxes()) {
    for (const finding of state.reviews[axis]?.findings ?? []) {
      if (finding.severity !== "blocker") continue;
      if (!finding.id) throw new Error(`${axis} Blocker is missing a Finding ID and cannot be independently verified`);
      findings.push({ axis, finding: { ...finding, id: finding.id } });
    }
  }
  return findings.sort((left, right) => left.finding.id.localeCompare(right.finding.id));
}

function requireReviewJob(state: WorkItemState, jobId: string): PrdReviewJob {
  const job = reviewJobs(state)[jobId];
  if (!job) throw new Error(`Unknown PRD Review Job: ${jobId}`);
  return job;
}

function aggregateAxisReview(state: WorkItemState, axis: ReviewAxis): void {
  const prd = state.currentPrd;
  if (!prd) return;
  const jobs = Object.values(reviewJobs(state))
    .filter((job) => job.prdGeneration === prd.generation && job.axis === axis)
    .sort((left, right) => left.ordinal - right.ordinal);
  if (jobs.length === 0 || jobs.some((job) => !job.result)) return;
  const results = jobs.map((job) => job.result as PrdReview);
  const multiple = results.length > 1;
  const findings = results.flatMap((review, index) => review.findings.map((finding) => ({
    ...finding,
    ...(multiple && finding.id ? { id: `${jobs[index]?.id}:${finding.id}` } : {}),
  })));
  state.reviews[axis] = {
    axis,
    verdict: results.some((review) => review.verdict === "blocked") ? "blocked" : "passed",
    surfaceHash: prd.reviewSurfaceHashes[axis],
    reviewerId: multiple ? `aggregate:${stableHash(results.map((review) => review.reviewerId)).slice(0, 16)}` : results[0]!.reviewerId,
    findings,
    submittedAt: results.map((review) => review.submittedAt).sort().at(-1)!,
  };
}

function refreshReviewStatus(state: WorkItemState): void {
  const prd = state.currentPrd;
  if (!prd) return;
  const currentJobs = Object.values(reviewJobs(state)).filter((job) => job.prdGeneration === prd.generation);
  if (currentJobs.some((job) => job.status === "failed")) {
    state.status = "blocked";
    return;
  }
  const axes = requiredReviewAxes();
  if (axes.every((axis) => state.reviews[axis]?.verdict === "passed")) {
    state.status = "awaiting_approval";
    return;
  }
  if (axes.some((axis) => !state.reviews[axis])) {
    state.status = "reviewing";
    return;
  }
  const blockerJob = state.blockerVerificationJob;
  if (!blockerJob?.results) {
    state.status = blockerJob && ["pending", "starting", "running", "result_submitted"].includes(blockerJob.status) ? "reviewing" : "blocked";
    return;
  }
  if (blockerJob.results.some((result) => result.status === "confirmed")) {
    state.status = "blocked";
  } else if (blockerJob.results.some((result) => result.status === "needs_more_evidence")) {
    state.status = "needs_external_input";
  } else {
    state.status = "awaiting_approval";
  }
}

export class WorkItemService {
  readonly store: WorkItemStore;

  constructor(root: string) {
    this.store = new WorkItemStore(root);
  }

  async initialize(input: Omit<WorkItemManifest, "schemaVersion" | "createdAt">): Promise<WorkItemState> {
    const now = new Date().toISOString();
    const manifest: WorkItemManifest = { ...input, schemaVersion: 1, createdAt: now };
    const state: WorkItemState = {
      schemaVersion: 1,
      workItemId: input.workItemId,
      status: "discovery",
      generation: 1,
      eventSequence: 1,
      activePrdGeneration: 0,
      decisions: [],
      evidence: [],
      reviews: {},
      reviewJobs: {},
      individualReviews: {},
      updatedAt: now,
    };
    await this.store.initialize(manifest, state);
    return state;
  }

  async createSuccessor(input: {
    successorRoot: string;
    successorWorkItemId: string;
    title?: string;
    repositoryRevision: string;
    reason: string;
    authorizedBy: string;
    authorizationEvidence: string;
  }): Promise<{ root: string; state: WorkItemState; manifest: WorkItemManifest }> {
    const current = await this.store.readState();
    const manifest = await this.store.readManifest();
    if (current.status !== "frozen" || !current.currentPrd || !current.frozenReceipt) throw new Error("Only a frozen Work Item can be superseded");
    for (const [label, value] of Object.entries({
      successorWorkItemId: input.successorWorkItemId,
      repositoryRevision: input.repositoryRevision,
      reason: input.reason,
      authorizedBy: input.authorizedBy,
      authorizationEvidence: input.authorizationEvidence,
    })) if (!value.trim()) throw new Error(`Successor ${label} must not be empty`);
    const successor = new WorkItemService(input.successorRoot);
    if (await successor.store.exists()) throw new Error(`Successor Work Item already exists: ${input.successorRoot}`);
    const createdAt = new Date().toISOString();
    const state = await successor.initialize({
      workItemId: input.successorWorkItemId,
      title: input.title?.trim() || manifest.title,
      repositoryRoot: manifest.repositoryRoot,
      repositoryRevision: input.repositoryRevision,
      supersedes: {
        predecessorWorkItemId: manifest.workItemId,
        predecessorRoot: this.store.root,
        predecessorPrdGeneration: current.currentPrd.generation,
        predecessorPrdHash: current.currentPrd.contentHash,
        reason: input.reason,
        authorizedBy: input.authorizedBy,
        authorizationEvidence: input.authorizationEvidence,
        createdAt,
      },
    });
    return { root: input.successorRoot, state, manifest: await successor.store.readManifest() };
  }

  async open(): Promise<{ state: WorkItemState; frontier: string[]; repaired: boolean }> {
    const doctor = await this.store.doctor();
    return {
      state: doctor.state,
      frontier: calculateDecisionFrontier(doctor.state.decisions),
      repaired: doctor.repaired,
    };
  }

  async checkpoint(checkpoint: DiscoveryCheckpoint): Promise<WorkItemState> {
    validateDecisionTree(checkpoint.decisions);
    validateEvidence(checkpoint.evidence);
    const manifest = await this.store.readManifest();
    const staleEvidence = checkpoint.evidence.filter((item) => item.repositoryRevision !== manifest.repositoryRevision);
    if (staleEvidence.length > 0) throw new Error(`Evidence is not bound to ${manifest.repositoryRevision}: ${staleEvidence.map((item) => item.id).join(", ")}`);
    if (typeof checkpoint.summary !== "string" || !checkpoint.summary.trim()) throw new Error("Discovery summary must be a non-empty string");
    return this.store.transact("discovery_checkpointed", (state) => {
      if (state.status === "frozen") throw new Error("Frozen Work Item is immutable");
      state.decisions = checkpoint.decisions;
      state.evidence = checkpoint.evidence;
      state.discoverySummary = checkpoint.summary;
      state.status = checkpoint.status ?? "discovery";
    }, {
      frontier: calculateDecisionFrontier(checkpoint.decisions),
      decisionCount: checkpoint.decisions.length,
      evidenceCount: checkpoint.evidence.length,
    });
  }

  async submitPrd(prd: ForgePrd): Promise<WorkItemState> {
    validatePrd(prd);
    const manifest = await this.store.readManifest();
    const staleEvidence = prd.impactEvidence.filter((item) => item.repositoryRevision !== manifest.repositoryRevision);
    if (staleEvidence.length > 0) throw new Error(`PRD evidence is not bound to ${manifest.repositoryRevision}: ${staleEvidence.map((item) => item.id).join(", ")}`);
    const current = await this.store.readState();
    const checkpointEvidence = new Map(current.evidence.map((item) => [item.id, stableHash(item)]));
    const uncheckpointedEvidence = prd.impactEvidence.filter((item) => checkpointEvidence.get(item.id) !== stableHash(item));
    if (uncheckpointedEvidence.length > 0) {
      throw new Error(`PRD uses evidence not present in the current discovery checkpoint: ${uncheckpointedEvidence.map((item) => item.id).join(", ")}`);
    }
    if (current.status === "frozen") throw new Error("Frozen Work Item is immutable");
    const generationNumber = current.activePrdGeneration + 1;
    const generation: PrdGeneration = {
      schemaVersion: 1,
      workItemId: current.workItemId,
      generation: generationNumber,
      contentHash: stableHash(prd),
      reviewSurfaceHashes: allReviewSurfaceHashes(prd),
      submittedAt: new Date().toISOString(),
      prd,
    };
    await this.store.writePrdGeneration(generation);
    return this.store.transact("prd_submitted", (state) => {
      state.currentPrd = generation;
      state.activePrdGeneration = generation.generation;
      state.reviews = {};
      delete state.blockerVerificationJob;
      delete state.approval;
      state.status = "reviewing";
    }, { prdGeneration: generation.generation, contentHash: generation.contentHash });
  }

  async createReviewJobs(plans: PrdReviewJobPlan[]): Promise<WorkItemState> {
    const current = await this.store.readState();
    const prd = current.currentPrd;
    if (!prd) throw new Error("No PRD has been submitted");
    if (current.status === "frozen") throw new Error("Frozen Work Item is immutable");
    if (plans.length === 0) throw new Error("At least one PRD Review Job is required");
    const ids = new Set<string>();
    const grouped = new Map<ReviewAxis, PrdReviewJobPlan[]>();
    for (const plan of plans) {
      if (ids.has(plan.id) || current.reviewJobs?.[plan.id]) throw new Error(`Duplicate PRD Review Job: ${plan.id}`);
      ids.add(plan.id);
      if (plan.prdGeneration !== prd.generation) throw new Error(`${plan.id} is not bound to PRD Generation ${prd.generation}`);
      if (plan.surfaceHash !== prd.reviewSurfaceHashes[plan.axis]) throw new Error(`${plan.id} has a stale ${plan.axis} surface hash`);
      if (!Number.isInteger(plan.ordinal) || plan.ordinal < 1) throw new Error(`${plan.id} has invalid ordinal`);
      if (!Number.isInteger(plan.requiredCount) || plan.requiredCount < 1) throw new Error(`${plan.id} has invalid requiredCount`);
      if (!Number.isInteger(plan.maxAttempts) || plan.maxAttempts < 1) throw new Error(`${plan.id} has invalid maxAttempts`);
      const axisPlans = grouped.get(plan.axis) ?? [];
      axisPlans.push(plan);
      grouped.set(plan.axis, axisPlans);
    }
    for (const [axis, axisPlans] of grouped) {
      const requiredCount = axisPlans[0]!.requiredCount;
      if (axisPlans.length !== requiredCount || axisPlans.some((plan) => plan.requiredCount !== requiredCount)) {
        throw new Error(`${axis} Review Job count does not match requiredCount ${requiredCount}`);
      }
      const ordinals = axisPlans.map((plan) => plan.ordinal).sort((a, b) => a - b);
      if (ordinals.some((ordinal, index) => ordinal !== index + 1)) throw new Error(`${axis} Review Job ordinals must be contiguous from 1`);
      if (current.reviews[axis]?.verdict === "passed") throw new Error(`${axis} review is already satisfied for PRD Generation ${prd.generation}`);
    }
    await this.store.writeReviewJobPlan(prd.generation, plans);
    return this.store.transact("prd_review_jobs_created", (state) => {
      const jobs = reviewJobs(state);
      for (const plan of plans) {
        jobs[plan.id] = { ...plan, status: "pending", attempt: 0 };
        delete state.reviews[plan.axis];
      }
      state.status = "reviewing";
    }, { prdGeneration: prd.generation, jobIds: plans.map((plan) => plan.id) });
  }

  async recoverInterruptedReviewCoordination(reason: string): Promise<WorkItemState> {
    if (!reason.trim()) throw new Error("Review coordination recovery requires a reason");
    return this.store.transact("prd_review_coordination_recovered", (state) => {
      const generation = state.currentPrd?.generation;
      if (!generation) throw new Error("No PRD has been submitted");
      for (const job of Object.values(reviewJobs(state))) {
        if (job.prdGeneration !== generation) continue;
        if (["starting", "running"].includes(job.status)) {
          if (job.result) job.status = "completed";
          else {
            job.status = "interrupted";
            job.error = reason;
          }
        }
      }
      const blockerJob = state.blockerVerificationJob;
      if (blockerJob?.prdGeneration === generation && ["starting", "running"].includes(blockerJob.status)) {
        if (blockerJob.results) blockerJob.status = "completed";
        else {
          blockerJob.status = "interrupted";
          blockerJob.error = reason;
        }
      }
      refreshReviewStatus(state);
    }, { reason });
  }

  async pendingReviewJobs(): Promise<PrdReviewJob[]> {
    const state = await this.store.readState();
    const generation = state.currentPrd?.generation;
    if (!generation) return [];
    return Object.values(state.reviewJobs ?? {})
      .filter((job) => job.prdGeneration === generation && ["pending", "retry_ready", "interrupted"].includes(job.status))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async claimReviewJob(jobId: string, binding: PrdReviewBinding): Promise<WorkItemState> {
    const current = await this.store.readState();
    const currentJob = requireReviewJob(current, jobId);
    if (!["pending", "retry_ready", "interrupted"].includes(currentJob.status)) throw new Error(`${jobId} cannot be claimed from ${currentJob.status}`);
    if (currentJob.attempt >= currentJob.maxAttempts) throw new Error(`${jobId} exhausted its retry budget`);
    if (
      binding.jobId !== currentJob.id
      || binding.prdGeneration !== currentJob.prdGeneration
      || binding.axis !== currentJob.axis
      || binding.surfaceHash !== currentJob.surfaceHash
      || binding.attempt !== currentJob.attempt + 1
    ) throw new Error(`Binding does not match PRD Review Job ${jobId}`);
    await this.store.writeReviewBinding(binding);
    return this.store.transact("prd_review_job_claimed", (state) => {
      const job = requireReviewJob(state, jobId);
      job.status = "starting";
      job.attempt += 1;
      job.binding = binding;
      delete job.error;
    }, { jobId, bindingId: binding.id, attempt: binding.attempt });
  }

  async bindReviewAgent(jobId: string, bindingId: string, agentId: string): Promise<WorkItemState> {
    return this.store.transact("prd_review_agent_bound", (state) => {
      const job = requireReviewJob(state, jobId);
      if (!job.binding || job.binding.id !== bindingId) throw new Error(`Binding mismatch for ${jobId}`);
      if (job.binding.agentId && job.binding.agentId !== agentId) throw new Error(`${jobId} is already bound to another agent`);
      job.binding.agentId = agentId;
    }, { jobId, bindingId, agentId });
  }

  async markReviewAgentStarted(agentId: string): Promise<WorkItemState> {
    return this.store.transact("prd_review_agent_started", (state) => {
      const job = Object.values(reviewJobs(state)).find((candidate) => candidate.binding?.agentId === agentId);
      if (!job) throw new Error(`Unknown PRD Review Agent binding: ${agentId}`);
      if (!job.result) job.status = "running";
    }, { agentId });
  }

  async markReviewSpawnFailed(jobId: string, error: string): Promise<WorkItemState> {
    return this.store.transact("prd_review_spawn_failed", (state) => {
      const job = requireReviewJob(state, jobId);
      if (job.status !== "starting") throw new Error(`${jobId} is not starting`);
      job.status = job.attempt >= job.maxAttempts ? "failed" : "retry_ready";
      job.error = error;
      refreshReviewStatus(state);
    }, { jobId, error });
  }

  async markReviewAgentTerminal(agentId: string, terminal: "completed" | "failed" | "stopped" | "aborted", error?: string): Promise<WorkItemState> {
    return this.store.transact("prd_review_agent_terminal", (state) => {
      const job = Object.values(reviewJobs(state)).find((candidate) => candidate.binding?.agentId === agentId);
      if (!job) throw new Error(`Unknown PRD Review Agent binding: ${agentId}`);
      if (job.result) {
        job.status = "completed";
      } else if (terminal === "completed") {
        job.status = "interrupted";
        job.error = error ?? "Reviewer stopped without a structured review submission";
      } else {
        job.status = job.attempt >= job.maxAttempts ? "failed" : "retry_ready";
        job.error = error ?? `Reviewer terminated as ${terminal}`;
      }
      refreshReviewStatus(state);
    }, { agentId, terminal, ...(error ? { error } : {}) });
  }

  async submitBoundReview(input: {
    bindingId: string;
    axis: ReviewAxis;
    verdict: PrdReview["verdict"];
    surfaceHash: string;
    findings: PrdReview["findings"];
  }): Promise<WorkItemState> {
    const current = await this.store.readState();
    const job = Object.values(current.reviewJobs ?? {}).find((candidate) => candidate.binding?.id === input.bindingId);
    if (!job?.binding) throw new Error(`Unknown PRD Review Binding: ${input.bindingId}`);
    const prd = current.currentPrd;
    if (!prd || prd.generation !== job.prdGeneration) throw new Error(`${input.bindingId} is not bound to the active PRD Generation`);
    if (job.status === "result_submitted" || job.status === "completed" || job.result) throw new Error(`${input.bindingId} already submitted a review`);
    if (!["starting", "running"].includes(job.status)) throw new Error(`${input.bindingId} cannot submit from ${job.status}`);
    if (input.axis !== job.axis || input.surfaceHash !== job.surfaceHash) throw new Error(`${input.bindingId} does not match the submitted review surface`);
    const review: PrdReview = {
      axis: input.axis,
      verdict: input.verdict,
      surfaceHash: input.surfaceHash,
      reviewerId: input.bindingId,
      findings: input.findings,
      submittedAt: new Date().toISOString(),
      jobId: job.id,
      bindingId: input.bindingId,
    };
    validateReview(review, job.axis, job.surfaceHash);
    await this.store.writeReview(prd.generation, review);
    return this.store.transact("prd_bound_review_submitted", (state) => {
      const mutableJob = requireReviewJob(state, job.id);
      if (mutableJob.binding?.id !== input.bindingId) throw new Error(`Binding changed for ${job.id}`);
      mutableJob.result = review;
      mutableJob.status = "result_submitted";
      individualReviews(state)[job.id] = review;
      aggregateAxisReview(state, job.axis);
      refreshReviewStatus(state);
    }, { jobId: job.id, bindingId: input.bindingId, axis: job.axis, verdict: input.verdict });
  }

  async createBlockerVerificationJob(input: {
    profile: string;
    model: string;
    thinking: PrdBlockerVerificationJob["thinking"];
    maxTurns: number;
    maxAttempts: number;
    configGeneration: number;
    configHash: string;
  }): Promise<WorkItemState> {
    const current = await this.store.readState();
    const prd = current.currentPrd;
    if (!prd) throw new Error("No PRD has been submitted");
    if (!requiredReviewAxes().every((axis) => current.reviews[axis])) throw new Error("Blocker Verification requires all three PRD reviews");
    const findings = blockerFindings(current);
    if (findings.length === 0) throw new Error("There are no PRD Blockers to verify");
    if (current.blockerVerificationJob?.prdGeneration === prd.generation) return current;
    const job: PrdBlockerVerificationJob = {
      id: `prd-${prd.generation}-blocker-verification-1`,
      prdGeneration: prd.generation,
      findingHash: stableHash(findings),
      findings,
      status: "pending",
      attempt: 0,
      maxAttempts: input.maxAttempts,
      profile: input.profile,
      model: input.model,
      thinking: input.thinking,
      maxTurns: input.maxTurns,
      configGeneration: input.configGeneration,
      configHash: input.configHash,
    };
    await this.store.writeBlockerVerificationJob(job);
    return this.store.transact("prd_blocker_verification_created", (state) => {
      state.blockerVerificationJob = job;
      state.status = "reviewing";
    }, { jobId: job.id, findingHash: job.findingHash, findingIds: findings.map((item) => item.finding.id) });
  }

  async claimBlockerVerification(binding: PrdBlockerVerificationBinding): Promise<WorkItemState> {
    const current = await this.store.readState();
    const job = current.blockerVerificationJob;
    if (!job || job.id !== binding.jobId) throw new Error(`Unknown Blocker Verification Job: ${binding.jobId}`);
    if (!["pending", "retry_ready", "interrupted"].includes(job.status)) throw new Error(`${job.id} cannot be claimed from ${job.status}`);
    if (job.attempt >= job.maxAttempts) throw new Error(`${job.id} exhausted its retry budget`);
    if (
      binding.prdGeneration !== job.prdGeneration
      || binding.findingHash !== job.findingHash
      || binding.attempt !== job.attempt + 1
    ) throw new Error(`Binding does not match Blocker Verification Job ${job.id}`);
    await this.store.writeReviewBinding(binding);
    return this.store.transact("prd_blocker_verification_claimed", (state) => {
      const mutable = state.blockerVerificationJob;
      if (!mutable || mutable.id !== binding.jobId) throw new Error(`Unknown Blocker Verification Job: ${binding.jobId}`);
      mutable.status = "starting";
      mutable.attempt += 1;
      mutable.binding = binding;
      delete mutable.error;
    }, { jobId: job.id, bindingId: binding.id, attempt: binding.attempt });
  }

  async bindBlockerVerificationAgent(bindingId: string, agentId: string): Promise<WorkItemState> {
    return this.store.transact("prd_blocker_verifier_bound", (state) => {
      const job = state.blockerVerificationJob;
      if (!job?.binding || job.binding.id !== bindingId) throw new Error(`Blocker Verification Binding mismatch: ${bindingId}`);
      if (job.binding.agentId && job.binding.agentId !== agentId) throw new Error(`${job.id} is already bound to another agent`);
      job.binding.agentId = agentId;
    }, { bindingId, agentId });
  }

  async markBlockerVerifierStarted(agentId: string): Promise<WorkItemState> {
    return this.store.transact("prd_blocker_verifier_started", (state) => {
      const job = state.blockerVerificationJob;
      if (!job?.binding || job.binding.agentId !== agentId) throw new Error(`Unknown Blocker Verifier Agent: ${agentId}`);
      if (!job.results) job.status = "running";
    }, { agentId });
  }

  async markBlockerVerifierSpawnFailed(error: string): Promise<WorkItemState> {
    return this.store.transact("prd_blocker_verifier_spawn_failed", (state) => {
      const job = state.blockerVerificationJob;
      if (!job || job.status !== "starting") throw new Error("Blocker Verifier is not starting");
      job.status = job.attempt >= job.maxAttempts ? "failed" : "retry_ready";
      job.error = error;
      state.status = job.status === "failed" ? "blocked" : "reviewing";
    }, { error });
  }

  async markBlockerVerifierTerminal(agentId: string, terminal: "completed" | "failed" | "stopped" | "aborted", error?: string): Promise<WorkItemState> {
    return this.store.transact("prd_blocker_verifier_terminal", (state) => {
      const job = state.blockerVerificationJob;
      if (!job?.binding || job.binding.agentId !== agentId) throw new Error(`Unknown Blocker Verifier Agent: ${agentId}`);
      if (job.results) {
        job.status = "completed";
      } else if (terminal === "completed") {
        job.status = "interrupted";
        job.error = error ?? "Blocker Verifier stopped without a structured result";
      } else {
        job.status = job.attempt >= job.maxAttempts ? "failed" : "retry_ready";
        job.error = error ?? `Blocker Verifier terminated as ${terminal}`;
      }
      refreshReviewStatus(state);
    }, { agentId, terminal, ...(error ? { error } : {}) });
  }

  async submitBlockerVerification(bindingId: string, results: PrdBlockerVerificationResult[]): Promise<WorkItemState> {
    const current = await this.store.readState();
    const job = current.blockerVerificationJob;
    if (!job?.binding || job.binding.id !== bindingId) throw new Error(`Unknown Blocker Verification Binding: ${bindingId}`);
    if (job.results || ["result_submitted", "completed"].includes(job.status)) throw new Error(`${bindingId} already submitted Blocker Verification`);
    if (!["starting", "running"].includes(job.status)) throw new Error(`${bindingId} cannot submit from ${job.status}`);
    const expectedIds = job.findings.map((item) => item.finding.id).sort();
    const actualIds = results.map((result) => result.findingId).sort();
    if (stableHash(expectedIds) !== stableHash(actualIds)) throw new Error(`Blocker Verification must return exactly: ${expectedIds.join(", ")}`);
    const seen = new Set<string>();
    for (const result of results) {
      if (seen.has(result.findingId)) throw new Error(`Duplicate Blocker Verification result: ${result.findingId}`);
      seen.add(result.findingId);
      if (!["confirmed", "rejected", "needs_more_evidence"].includes(result.status)) throw new Error(`Invalid Blocker Verification status for ${result.findingId}`);
      if (!result.rationale.trim()) throw new Error(`${result.findingId} requires rationale`);
      if (result.evidence.length === 0 && result.status !== "needs_more_evidence") throw new Error(`${result.findingId} requires verification evidence`);
      if (result.status === "needs_more_evidence" && (!result.missingEvidence || result.missingEvidence.length === 0)) {
        throw new Error(`${result.findingId} must name the missing evidence`);
      }
    }
    await this.store.writeBlockerVerificationResult(bindingId, results);
    return this.store.transact("prd_blocker_verification_submitted", (state) => {
      const mutable = state.blockerVerificationJob;
      if (!mutable?.binding || mutable.binding.id !== bindingId) throw new Error(`Blocker Verification Binding changed: ${bindingId}`);
      mutable.results = results;
      mutable.status = "result_submitted";
      refreshReviewStatus(state);
    }, { bindingId, findingHash: job.findingHash, statuses: results.map((result) => ({ findingId: result.findingId, status: result.status })) });
  }

  async amendPrd(input: {
    reason: string;
    authorization: { actor: string; evidence: string };
    prd: ForgePrd;
  }): Promise<WorkItemState> {
    if (typeof input.reason !== "string" || !input.reason.trim()) throw new Error("PRD Amendment requires a reason");
    if (
      !input.authorization
      || typeof input.authorization.actor !== "string"
      || !input.authorization.actor.trim()
      || typeof input.authorization.evidence !== "string"
      || !input.authorization.evidence.trim()
    ) {
      throw new Error("PRD Amendment requires authorization actor and evidence");
    }
    validatePrd(input.prd);
    const manifest = await this.store.readManifest();
    const staleEvidence = input.prd.impactEvidence.filter((item) => item.repositoryRevision !== manifest.repositoryRevision);
    if (staleEvidence.length > 0) throw new Error(`PRD evidence is not bound to ${manifest.repositoryRevision}: ${staleEvidence.map((item) => item.id).join(", ")}`);

    const current = await this.store.readState();
    const previous = current.currentPrd;
    if (!previous) throw new Error("No PRD exists to amend");
    if (current.status === "frozen") throw new Error("Frozen Work Item requires a new Work Item amendment flow");
    const checkpointEvidence = new Map(current.evidence.map((item) => [item.id, stableHash(item)]));
    const uncheckpointedEvidence = input.prd.impactEvidence.filter((item) => checkpointEvidence.get(item.id) !== stableHash(item));
    if (uncheckpointedEvidence.length > 0) {
      throw new Error(`Amended PRD uses evidence not present in the current discovery checkpoint: ${uncheckpointedEvidence.map((item) => item.id).join(", ")}`);
    }

    const nextContentHash = stableHash(input.prd);
    if (nextContentHash === previous.contentHash) throw new Error("PRD Amendment does not change the PRD");
    const nextGeneration: PrdGeneration = {
      schemaVersion: 1,
      workItemId: current.workItemId,
      generation: previous.generation + 1,
      contentHash: nextContentHash,
      reviewSurfaceHashes: allReviewSurfaceHashes(input.prd),
      submittedAt: new Date().toISOString(),
      prd: input.prd,
    };

    const carriedReviews: Partial<Record<ReviewAxis, PrdReview>> = {};
    const carriedReviewAxes: ReviewAxis[] = [];
    const invalidatedReviewAxes: ReviewAxis[] = [];
    const invalidatedReviewerIds: string[] = [];
    const priorIndividualReviews = Object.values(current.individualReviews ?? {}).filter((review) => {
      const job = review.jobId ? current.reviewJobs?.[review.jobId] : undefined;
      return job?.prdGeneration === previous.generation;
    });
    for (const axis of requiredReviewAxes()) {
      const oldSurfaceHash = previous.reviewSurfaceHashes?.[axis] ?? reviewSurfaceHash(previous.prd, axis);
      const newSurfaceHash = nextGeneration.reviewSurfaceHashes[axis];
      const existingReview = current.reviews[axis];
      if (existingReview?.verdict === "passed" && oldSurfaceHash === newSurfaceHash) {
        const carried: PrdReview = {
          ...existingReview,
          surfaceHash: newSurfaceHash,
          carriedFrom: {
            generation: previous.generation,
            originalSurfaceHash: existingReview.surfaceHash,
          },
        };
        carriedReviews[axis] = carried;
        carriedReviewAxes.push(axis);
      } else {
        invalidatedReviewAxes.push(axis);
        const individualReviewerIds = priorIndividualReviews.filter((review) => review.axis === axis).map((review) => review.reviewerId);
        if (individualReviewerIds.length > 0) invalidatedReviewerIds.push(...individualReviewerIds);
        else if (existingReview) invalidatedReviewerIds.push(existingReview.reviewerId);
      }
    }

    const amendment: PrdAmendment = {
      id: `A${String(nextGeneration.generation - 1).padStart(3, "0")}`,
      fromGeneration: previous.generation,
      toGeneration: nextGeneration.generation,
      fromContentHash: previous.contentHash,
      toContentHash: nextGeneration.contentHash,
      reason: input.reason,
      authorization: input.authorization,
      carriedReviewAxes,
      invalidatedReviewAxes,
      invalidatedReviewerIds,
      createdAt: new Date().toISOString(),
    };

    await this.store.writePrdGeneration(nextGeneration);
    await this.store.writeAmendment(amendment);
    for (const axis of carriedReviewAxes) {
      const review = carriedReviews[axis];
      if (review) await this.store.writeReview(nextGeneration.generation, review);
    }

    return this.store.transact("prd_amended", (state) => {
      state.currentPrd = nextGeneration;
      state.activePrdGeneration = nextGeneration.generation;
      state.reviews = carriedReviews;
      state.lastAmendment = amendment;
      delete state.blockerVerificationJob;
      delete state.approval;
      state.status = carriedReviewAxes.length === requiredReviewAxes().length ? "awaiting_approval" : "reviewing";
    }, {
      amendmentId: amendment.id,
      fromGeneration: amendment.fromGeneration,
      toGeneration: amendment.toGeneration,
      carriedReviewAxes,
      invalidatedReviewAxes,
    });
  }

  async submitReview(input: Omit<PrdReview, "submittedAt">): Promise<WorkItemState> {
    const current = await this.store.readState();
    const prd = current.currentPrd;
    if (!prd) throw new Error("No PRD has been submitted");
    if (current.status === "frozen") throw new Error("Frozen Work Item is immutable");
    const automatedJobs = Object.values(current.reviewJobs ?? {}).filter((job) => job.prdGeneration === prd.generation && job.axis === input.axis);
    if (automatedJobs.length > 0) throw new Error(`${input.axis} review requires a valid Review Binding`);
    const review: PrdReview = { ...input, submittedAt: new Date().toISOString() };
    const expectedSurfaceHash = prd.reviewSurfaceHashes?.[review.axis] ?? reviewSurfaceHash(prd.prd, review.axis);
    validateReview(review, review.axis, expectedSurfaceHash);
    const duplicateReviewer = Object.values(current.reviews).find((candidate) => candidate?.reviewerId === review.reviewerId);
    if (duplicateReviewer) throw new Error(`Reviewer ${review.reviewerId} already submitted the ${duplicateReviewer.axis} review`);
    if (current.lastAmendment?.toGeneration === prd.generation && current.lastAmendment.invalidatedReviewerIds.includes(review.reviewerId)) {
      throw new Error(`Reviewer ${review.reviewerId} reviewed the invalidated prior generation and cannot review Generation ${prd.generation}`);
    }
    await this.store.writeReview(prd.generation, review);
    return this.store.transact("prd_review_submitted", (state) => {
      state.reviews[review.axis] = review;
      const allAxes = requiredReviewAxes();
      const allPassed = allAxes.every((axis) => state.reviews[axis]?.verdict === "passed");
      const anyBlocked = allAxes.some((axis) => state.reviews[axis]?.verdict === "blocked");
      state.status = allPassed ? "awaiting_approval" : anyBlocked ? "blocked" : "reviewing";
    }, { axis: review.axis, verdict: review.verdict, surfaceHash: review.surfaceHash });
  }

  async approve(input: { approvedBy: string; evidence: string }): Promise<WorkItemState> {
    const current = await this.store.readState();
    const prd = current.currentPrd;
    if (!prd) throw new Error("No PRD has been submitted");
    if (current.status !== "awaiting_approval") throw new Error(`PRD cannot be approved from ${current.status}`);
    if (prd.prd.openQuestions.length > 0) throw new Error("PRD with open questions cannot be approved");
    const unresolvedDecisions = current.decisions.filter((decision) => decision.status !== "answered");
    if (unresolvedDecisions.length > 0) throw new Error(`Discovery has unresolved decisions: ${unresolvedDecisions.map((decision) => decision.id).join(", ")}`);
    if (typeof input.approvedBy !== "string" || !input.approvedBy.trim() || typeof input.evidence !== "string" || !input.evidence.trim()) {
      throw new Error("Approval requires actor and evidence");
    }
    const approval: PrdApproval = {
      generation: prd.generation,
      contentHash: prd.contentHash,
      approvedBy: input.approvedBy,
      evidence: input.evidence,
      approvedAt: new Date().toISOString(),
    };
    return this.store.transact("prd_approved", (state) => {
      state.approval = approval;
    }, { approvedBy: input.approvedBy, contentHash: approval.contentHash });
  }

  static createReviewBinding(input: Omit<PrdReviewBinding, "id" | "spawnRequestId" | "createdAt">): PrdReviewBinding {
    return {
      ...input,
      id: randomUUID(),
      spawnRequestId: randomUUID(),
      createdAt: new Date().toISOString(),
    };
  }

  static createBlockerVerificationBinding(input: Omit<PrdBlockerVerificationBinding, "id" | "spawnRequestId" | "createdAt">): PrdBlockerVerificationBinding {
    return {
      ...input,
      id: randomUUID(),
      spawnRequestId: randomUUID(),
      createdAt: new Date().toISOString(),
    };
  }

  async freeze(): Promise<WorkItemState> {
    const current = await this.store.readState();
    const prd = current.currentPrd;
    if (!prd) throw new Error("No PRD has been submitted");
    validatePrd(prd.prd);
    if (prd.prd.openQuestions.length > 0) throw new Error("PRD has unresolved open questions");
    const unresolvedDecisions = current.decisions.filter((decision) => decision.status !== "answered");
    if (unresolvedDecisions.length > 0) {
      throw new Error(`Discovery has unresolved decisions: ${unresolvedDecisions.map((decision) => decision.id).join(", ")}`);
    }
    const reviews = {} as Record<ReviewAxis, PrdReview>;
    const verificationResults = new Map((current.blockerVerificationJob?.results ?? []).map((result) => [result.findingId, result]));
    for (const axis of requiredReviewAxes()) {
      const review = current.reviews[axis];
      if (!review) throw new Error(`Missing ${axis} review`);
      const expectedSurfaceHash = prd.reviewSurfaceHashes?.[axis] ?? reviewSurfaceHash(prd.prd, axis);
      validateReview(review, axis, expectedSurfaceHash);
      if (review.verdict === "blocked") {
        const blockers = review.findings.filter((finding) => finding.severity === "blocker");
        const unresolved = blockers.filter((finding) => !finding.id || verificationResults.get(finding.id)?.status !== "rejected");
        if (unresolved.length > 0) throw new Error(`${axis} review has unresolved Blockers: ${unresolved.map((finding) => finding.id ?? finding.message).join(", ")}`);
      }
      reviews[axis] = review;
    }
    const approval = current.approval;
    if (!approval || approval.generation !== prd.generation || approval.contentHash !== prd.contentHash) {
      throw new Error("PRD does not have matching user approval");
    }
    const receipt: FrozenPrdReceipt = {
      workItemId: current.workItemId,
      generation: prd.generation,
      contentHash: prd.contentHash,
      approval,
      reviews,
      ...(current.blockerVerificationJob?.results ? {
        blockerVerification: {
          jobId: current.blockerVerificationJob.id,
          findingHash: current.blockerVerificationJob.findingHash,
          results: current.blockerVerificationJob.results,
        },
      } : {}),
      frozenAt: new Date().toISOString(),
    };
    await this.store.writeFrozenReceipt(receipt);
    return this.store.transact("prd_frozen", (state) => {
      state.frozenReceipt = receipt;
      state.status = "frozen";
    }, { prdGeneration: prd.generation, contentHash: prd.contentHash });
  }
}
