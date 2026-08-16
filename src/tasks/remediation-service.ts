import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { loadForgeConfig, resolveForgeProfile } from "../config/resolver.js";
import { stableHash } from "../runtime/hash.js";
import { validateRemediationDrafts } from "../runtime/remediation-validation.js";
import { RuntimeService } from "../runtime/service.js";
import type { AuditBlockerVerifierJob, AuditBlockerVerifierReview, DagAmendment, IssueAuditFinding } from "../runtime/types.js";
import { atomicWriteText } from "../runtime/store.js";
import { renderTask } from "./renderer.js";
import { TaskPreflightService } from "./preflight-service.js";
import type { TaskPreflightProposal, TaskPreflightRoute } from "./preflight-types.js";
import { normalizeIssueArtifactIdentity, type LegacyIssueArtifact } from "../issues/identity.js";
import { WorkItemService } from "../work-item/service.js";
import type { PrdGeneration } from "../work-item/types.js";
import type { MicroTaskDraft } from "./types.js";

export class RemediationService {
  readonly runtime: RuntimeService;
  readonly runtimeRoot: string;
  readonly issueRoot: string;
  readonly workItemRoot: string;

  constructor(runtimeRoot: string) {
    this.runtimeRoot = runtimeRoot;
    this.runtime = new RuntimeService(runtimeRoot);
    this.issueRoot = dirname(runtimeRoot);
    this.workItemRoot = dirname(dirname(this.issueRoot));
  }

  private preflightService(issueId: string): TaskPreflightService {
    return new TaskPreflightService(this.workItemRoot, issueId, "remediation");
  }

  private async blockerVerification(job: AuditBlockerVerifierJob | undefined): Promise<AuditBlockerVerifierReview> {
    if (!job?.result) throw new Error("Audit Remediation requires a completed Blocker Verification");
    if ("results" in job.result) {
      const legacyHash = stableHash({ bindingId: job.result.bindingId, findingHash: job.result.findingHash, results: job.result.results });
      if (job.result.resultHash && job.result.resultHash !== legacyHash) throw new Error("Legacy Audit Blocker Verification result hash is invalid");
      return { ...job.result, resultHash: legacyHash, artifactPath: job.result.artifactPath ?? "" };
    }
    const review = await this.runtime.store.readImmutableArtifact<AuditBlockerVerifierReview>(job.result.artifactPath);
    const reviewHash = review ? stableHash({ bindingId: review.bindingId, findingHash: review.findingHash, results: review.results }) : undefined;
    if (!review || review.bindingId !== job.result.bindingId || review.findingHash !== job.result.findingHash || review.findingHash !== job.findingHash || reviewHash !== job.result.resultHash || (review.resultHash && review.resultHash !== reviewHash)) {
      throw new Error("Audit Blocker Verification artifact does not match its Runtime reference");
    }
    return { ...review, resultHash: reviewHash, artifactPath: review.artifactPath ?? job.result.artifactPath };
  }

  async propose(drafts: MicroTaskDraft[], rerunSliceIds: string[]): Promise<{ proposal: TaskPreflightProposal; state: Awaited<ReturnType<TaskPreflightService["status"]>>; route: TaskPreflightRoute; idempotent: boolean }> {
    const state = await this.runtime.status();
    const plan = state.remediationPlan;
    const verifier = state.auditBlockerVerifierJob;
    if (!plan || plan.status !== "awaiting_proposal") throw new Error("Runtime is not awaiting a Remediation Proposal");
    const dag = await this.runtime.store.readDag();
    const verifierReview = plan.source === "audit" ? await this.blockerVerification(verifier) : undefined;
    const confirmedFindings: IssueAuditFinding[] = plan.source === "slice_gate"
      ? [{
          id: plan.confirmedFindingIds[0]!,
          severity: "blocker",
          message: state.sliceGates?.[plan.sourceSliceId!]?.error ?? "Slice Gate failed",
          evidence: state.sliceGates?.[plan.sourceSliceId!]?.verification?.flatMap((result) => [result.command, result.keyOutput ?? ""]).filter(Boolean) ?? [],
          violatedRule: `Slice ${plan.sourceSliceId} Gate must pass`,
          verification: state.sliceGates?.[plan.sourceSliceId!]?.commands.map((command) => command.command).join("; ") ?? "Rerun Slice Gate",
          suggestedResolution: `Repair only the repository seams owned by Slice ${plan.sourceSliceId} and rerun its frozen Gate`,
        }]
      : (() => {
          const confirmedResults = new Map(verifierReview!.results.filter((result) => result.status === "confirmed").map((result) => [result.findingId, result]));
          return verifier!.findings.filter((reference) => confirmedResults.has(reference.findingId)).map((reference) => ({
            ...reference.finding,
            evidence: [...new Set([...reference.finding.evidence, ...confirmedResults.get(reference.findingId)!.evidence])],
          }));
        })();
    const manifest = await this.runtime.store.readManifest();
    const config = await loadForgeConfig(manifest.controlRoot);
    const workItemManifest = await new WorkItemService(this.workItemRoot).store.readManifest();
    const issue = normalizeIssueArtifactIdentity(JSON.parse(await readFile(join(this.issueRoot, "issue.json"), "utf8")) as LegacyIssueArtifact, workItemManifest);
    const prdGeneration = JSON.parse(await readFile(join(this.workItemRoot, "prd", "generations", `prd-${issue.source.prdGeneration}.json`), "utf8")) as PrdGeneration;
    if (issue.artifactHash !== manifest.issueHash || issue.source.prdHash !== prdGeneration.contentHash) throw new Error("Remediation source Issue or PRD is stale");
    const issueAcceptance = new Set(issue.acceptanceIds);
    for (const draft of drafts) {
      const outsideAcceptance = draft.acceptanceIds.filter((id) => !issueAcceptance.has(id));
      if (outsideAcceptance.length > 0) throw new Error(`${draft.id} expands frozen Issue Acceptance: ${outsideAcceptance.join(", ")}`);
    }
    const contracts = validateRemediationDrafts({
      currentDag: dag,
      drafts,
      confirmedFindings,
      knownSliceIds: new Set(Object.keys(state.sliceGates ?? {})),
      modelProfiles: new Set(Object.keys(config.models.profiles)),
      requireEvidenceReadMatch: plan.source === "audit",
    });
    const uniqueSlices = [...new Set(rerunSliceIds)].sort();
    if (uniqueSlices.length === 0) throw new Error("Remediation must rerun at least one affected Slice Gate");
    for (const sliceId of uniqueSlices) if (!state.sliceGates?.[sliceId]) throw new Error(`Unknown affected Slice Gate: ${sliceId}`);
    for (const contract of contracts) if (!uniqueSlices.includes(contract.sliceId)) throw new Error(`${contract.id} Slice ${contract.sliceId} must be included in rerunSliceIds`);
    const routeBase = resolveForgeProfile(config, "taskPreflight");
    const route: TaskPreflightRoute = { profile: routeBase.profile, model: routeBase.model, thinking: routeBase.thinking, maxTurns: routeBase.maxTurns, configGeneration: routeBase.configGeneration, configHash: routeBase.configHash };
    const proposalHash = stableHash({ kind: "remediation", source: plan.source, sourceFindingHash: plan.findingHash, sourcePrdHash: prdGeneration.contentHash, sourceIssueHash: issue.artifactHash, dagGeneration: dag.generation, drafts, rerunSliceIds: uniqueSlices });
    const preflight = this.preflightService(state.issueId);
    const existing = await preflight.status();
    if (existing?.proposalHash === proposalHash) return { proposal: await preflight.readProposal(), state: existing, route, idempotent: true };
    const appliedPass = existing?.status === "passed" && existing.appliedDagGeneration !== undefined;
    if (existing && !appliedPass && ["pending", "starting", "running", "retry_ready", "interrupted", "passed"].includes(existing.status)) {
      throw new Error(`Task Preflight Proposal ${existing.activeProposalGeneration} is ${existing.status}; it cannot be replaced`);
    }
    const generation = (existing?.activeProposalGeneration ?? 0) + 1;
    const now = new Date().toISOString();
    const surfaceHash = stableHash({ policyVersion: 1, kind: "remediation", sourceFindingHash: plan.findingHash, sourcePrdHash: prdGeneration.contentHash, sourceIssueHash: issue.artifactHash, acceptanceIds: issue.acceptanceIds, decisionIds: issue.decisionIds, tasks: drafts, rerunSliceIds: uniqueSlices });
    const proposal: TaskPreflightProposal = {
      schemaVersion: 1,
      generation,
      issueId: state.issueId,
      kind: "remediation",
      runtimeRoot: this.runtimeRoot,
      sourceFindingHash: plan.findingHash,
      sourcePrdGeneration: issue.source.prdGeneration,
      sourcePrdHash: prdGeneration.contentHash,
      sourceIssueHash: issue.artifactHash,
      acceptanceIds: structuredClone(issue.acceptanceIds),
      decisionIds: structuredClone(issue.decisionIds),
      rerunSliceIds: uniqueSlices,
      proposalHash,
      surfaceHash,
      source: {
        workItemId: workItemManifest.workItemId,
        controlRoot: manifest.controlRoot,
        prdHash: prdGeneration.contentHash,
        issuesHash: stableHash({ issueId: issue.id, issueHash: issue.artifactHash }),
        issueHash: manifest.issueHash,
        repositoryRoot: manifest.workspaceRoot,
        repositoryRevision: (await import("node:child_process")).execFileSync("git", ["rev-parse", "HEAD"], { cwd: manifest.workspaceRoot, encoding: "utf8" }).trim(),
      },
      slices: uniqueSlices.map((sliceId) => ({ id: sliceId, title: `Remediate ${sliceId}`, goal: `Repair confirmed final Audit Blockers affecting ${sliceId}.`, acceptanceIds: [...new Set(contracts.filter((task) => task.sliceId === sliceId).flatMap((task) => task.acceptance))], taskIds: contracts.filter((task) => task.sliceId === sliceId).map((task) => task.id), gate: state.sliceGates![sliceId]!.commands })),
      tasks: structuredClone(drafts),
      createdAt: now,
    };
    const proposed = await preflight.proposeRaw(proposal, route);
    await this.runtime.store.transact("remediation_preflight_started", (next) => {
      if (!next.remediationPlan || next.remediationPlan.findingHash !== plan.findingHash) throw new Error("Remediation Plan changed while proposing Tasks");
      next.remediationPlan.status = "preflight";
      next.remediationPlan.updatedAt = now;
    }, { details: { proposalGeneration: proposal.generation, proposalHash } });
    return { proposal, state: proposed.state, route, idempotent: false };
  }

  async applyPassed(): Promise<Awaited<ReturnType<RuntimeService["status"]>>> {
    const state = await this.runtime.status();
    const plan = state.remediationPlan;
    if (!plan || plan.status !== "preflight") throw new Error("Remediation Plan is not in Preflight");
    const preflight = this.preflightService(state.issueId);
    const preflightState = await preflight.status();
    const proposal = await preflight.readProposal();
    await preflight.validatePassedEvidence();
    if (!preflightState || preflightState.status !== "passed" || preflightState.job.result?.verdict !== "passed" || proposal.kind !== "remediation") throw new Error("Remediation Task Preflight has not passed");
    if (proposal.sourceFindingHash !== plan.findingHash || proposal.runtimeRoot !== this.runtimeRoot) throw new Error("Remediation Proposal is stale");
    const workItemManifest = await new WorkItemService(this.workItemRoot).store.readManifest();
    const issue = normalizeIssueArtifactIdentity(JSON.parse(await readFile(join(this.issueRoot, "issue.json"), "utf8")) as LegacyIssueArtifact, workItemManifest);
    const prdGeneration = JSON.parse(await readFile(join(this.workItemRoot, "prd", "generations", `prd-${issue.source.prdGeneration}.json`), "utf8")) as PrdGeneration;
    if (proposal.sourceIssueHash !== issue.artifactHash || proposal.sourcePrdHash !== prdGeneration.contentHash || issue.source.prdHash !== prdGeneration.contentHash) throw new Error("Remediation Proposal no longer matches frozen Issue and PRD");
    if (stableHash(proposal.acceptanceIds ?? []) !== stableHash(issue.acceptanceIds) || stableHash(proposal.decisionIds ?? []) !== stableHash(issue.decisionIds)) throw new Error("Remediation Proposal changed frozen Acceptance or Decisions");
    const dag = await this.runtime.store.readDag();
    const verifier = state.auditBlockerVerifierJob;
    const verifierReview = plan.source === "audit" ? await this.blockerVerification(verifier) : undefined;
    const confirmedFindings: IssueAuditFinding[] = plan.source === "slice_gate"
      ? [{
          id: plan.confirmedFindingIds[0]!,
          severity: "blocker",
          message: state.sliceGates?.[plan.sourceSliceId!]?.error ?? "Slice Gate failed",
          evidence: state.sliceGates?.[plan.sourceSliceId!]?.verification?.flatMap((result) => [result.command, result.keyOutput ?? ""]).filter(Boolean) ?? [],
          violatedRule: `Slice ${plan.sourceSliceId} Gate must pass`,
          verification: state.sliceGates?.[plan.sourceSliceId!]?.commands.map((command) => command.command).join("; ") ?? "Rerun Slice Gate",
          suggestedResolution: `Repair only the repository seams owned by Slice ${plan.sourceSliceId} and rerun its frozen Gate`,
        }]
      : (() => {
          const confirmedResults = new Map(verifierReview!.results.filter((result) => result.status === "confirmed").map((result) => [result.findingId, result]));
          return verifier!.findings.filter((finding) => confirmedResults.has(finding.findingId)).map((finding) => ({
            ...finding.finding,
            evidence: [...new Set([...finding.finding.evidence, ...confirmedResults.get(finding.findingId)!.evidence])],
          }));
        })();
    const manifest = await this.runtime.store.readManifest();
    const config = await loadForgeConfig(manifest.controlRoot);
    const tasks = validateRemediationDrafts({ currentDag: dag, drafts: proposal.tasks, confirmedFindings, knownSliceIds: new Set(Object.keys(state.sliceGates ?? {})), modelProfiles: new Set(Object.keys(config.models.profiles)), requireEvidenceReadMatch: plan.source === "audit" });
    await this.runtime.store.transact("remediation_ready", (next) => {
      if (!next.remediationPlan || next.remediationPlan.findingHash !== plan.findingHash) throw new Error("Remediation Plan changed before apply");
      next.remediationPlan.status = "ready";
      next.remediationPlan.updatedAt = new Date().toISOString();
    }, { details: { proposalHash: proposal.proposalHash, resultHash: preflightState.job.result.resultHash } });
    const amendment: DagAmendment = {
      id: `A${String(dag.generation).padStart(3, "0")}`,
      reason: `Repair confirmed final Audit Findings: ${plan.confirmedFindingIds.join(", ")}`,
      createdAt: new Date().toISOString(),
      approvedBy: "runtime-policy",
      sourceFindingHash: plan.findingHash,
      sourcePreflightResultHash: preflightState.job.result.resultHash,
      tasks,
      rerunSliceIds: proposal.rerunSliceIds ?? [],
    };
    for (const task of tasks) {
      const taskVersion = task.version;
      const version = `V${String(taskVersion).padStart(3, "0")}`;
      const relativeContractPath = `tasks/${task.id}/TASK-${version}.md`;
      await atomicWriteText(join(this.issueRoot, relativeContractPath), renderTask(task, issue));
    }
    const next = await this.runtime.applyRemediation(amendment);
    await preflight.markApplied(next.dagGeneration);
    return next;
  }
}
