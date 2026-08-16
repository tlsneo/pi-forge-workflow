import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { demoDag, modelPolicy } from "../examples/fixture.js";
import { RuntimeService } from "../src/runtime/service.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createRuntime() {
  const root = await mkdtemp(join(tmpdir(), "pi-task-runtime-"));
  roots.push(root);
  const service = new RuntimeService(root);
  const dag = demoDag();
  await service.initialize({
    workItemId: "work-item-test",
    issueId: "issue-test",
    issueHash: "issue-hash",
    workspaceRoot: root,
    workspaceMode: "shared-serial",
    issueModelProfile: "simple",
    auditModelProfile: "rigorous",
    modelPolicy,
  }, dag);
  return { root, service, dag };
}

async function completeFirstTask(service: RuntimeService, contractHash: string) {
  const binding = RuntimeService.createBinding({
    workItemId: "work-item-test",
    issueId: "issue-test",
    taskId: "T01",
    taskVersion: 1,
    taskContractPath: "tasks/T01/TASK-V001.md",
    attempt: 1,
    workspace: service.store.root,
    contractHash,
    model: "test/simple",
    thinking: "low",
    maxTurns: 12,
    startedGeneration: (await service.status()).generation,
  });
  await service.claimTask("T01", binding);
  await service.bindAgent("T01", binding.id, "agent-1");
  await service.markAgentStarted("agent-1");
  await service.submitHandoff(binding.id, {
    changedFiles: ["src/config.ts"],
    verification: [{ command: "npm test -- config", exitCode: 0 }],
    produced: ["src/config.ts#AppConfig.timeoutMs"],
  });
  await service.markAgentTerminal("agent-1", "completed");
  await service.beginVerification("T01");
  await service.finishVerification("T01", true);
  await service.completeTask("T01", "commit-t01");
}

describe("RuntimeService", () => {
  it("creates immutable artifacts without allowing concurrent overwrite", async () => {
    const { service } = await createRuntime();
    const results = await Promise.allSettled([
      service.store.writeImmutableArtifact("audits/race.json", { value: 1 }),
      service.store.writeImmutableArtifact("audits/race.json", { value: 2 }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect([1, 2]).toContain((await service.store.readImmutableArtifact<{ value: number }>("audits/race.json"))?.value);

    const receiptResults = await Promise.allSettled([
      service.store.writeReceipt("T99", { taskVersion: 1, commit: "one" }),
      service.store.writeReceipt("T99", { taskVersion: 1, commit: "two" }),
    ]);
    expect(receiptResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(receiptResults.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(["one", "two"]).toContain((await service.store.readReceipt<{ commit: string }>("T99"))?.commit);
  });

  it("defaults legacy Runtime manifests to Standard Assurance", async () => {
    const { root, service } = await createRuntime();
    const manifestPath = join(root, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    delete manifest.assuranceProfile;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    expect((await service.store.readManifest()).assuranceProfile).toBe("standard");
  });

  it("persists the state machine and unlocks the next frontier", async () => {
    const { service, dag } = await createRuntime();
    expect(await service.frontier()).toEqual(["T01"]);

    await completeFirstTask(service, dag.tasks[0]!.contractHash);

    const state = await service.status();
    expect(state.tasks.T01?.status).toBe("completed");
    expect(state.tasks.T01?.receipt?.commit).toBe("commit-t01");
    expect(state.tasks.T01?.receipt).toMatchObject({ workItemId: "work-item-test", issueId: "issue-test", taskId: "T01", taskVersion: 1, taskContractPath: "tasks/T01/TASK-V001.md" });
    expect(state.tasks.T02?.status).toBe("ready");
    expect(await service.frontier()).toEqual(["T02"]);

    const events = await service.store.readEvents();
    expect(events.at(-1)?.type).toBe("task_completed");
    expect(events.at(-1)?.snapshot.tasks.T01?.status).toBe("completed");
  });

  it("keeps completed Tasks immutable when lifecycle completion is delivered more than once", async () => {
    const { service, dag } = await createRuntime();
    await completeFirstTask(service, dag.tasks[0]!.contractHash);
    const before = await service.status();
    const duplicate = await service.markAgentTerminal("agent-1", "completed");
    expect(duplicate).toEqual(before);
    expect(duplicate.tasks.T01?.status).toBe("completed");
    expect(duplicate.tasks.T01?.receipt?.commit).toBe("commit-t01");
    await expect(service.completeTask("T01", "different-commit")).rejects.toThrow("already completed");
  });

  it("rejects stale worker actions after a Task Receipt makes the Binding terminal", async () => {
    const { service, dag } = await createRuntime();
    await completeFirstTask(service, dag.tasks[0]!.contractHash);
    const before = await service.status();
    const bindingId = before.tasks.T01!.binding!.id;
    const eventCount = (await service.store.readEvents()).length;

    await expect(service.resumeTask(bindingId)).rejects.toThrow("Receipt");
    await expect(service.checkpoint(bindingId, {
      currentStep: "late checkpoint",
      nextAction: "submit again",
      changedFiles: ["src/config.ts"],
      verificationNotes: [],
    })).rejects.toThrow("Receipt");
    await expect(service.submitHandoff(bindingId, {
      changedFiles: ["src/config.ts"],
      verification: [],
      produced: ["src/config.ts#AppConfig.timeoutMs"],
    })).rejects.toThrow("Receipt");
    await expect(service.beginVerification("T01")).rejects.toThrow("Receipt");
    await expect(service.blockTask("T01", "stale verification")).rejects.toThrow("Receipt");

    expect(await service.status()).toEqual(before);
    expect(await service.store.readEvents()).toHaveLength(eventCount);
  });

  it("makes Handoff submission one-shot and idempotent for identical retries", async () => {
    const { service, dag } = await createRuntime();
    const binding = RuntimeService.createBinding({
      workItemId: "work-item-test",
      issueId: "issue-test",
      taskId: "T01",
      taskVersion: 1,
      taskContractPath: "tasks/T01/TASK-V001.md",
      attempt: 1,
      workspace: service.store.root,
      contractHash: dag.tasks[0]!.contractHash,
      model: "test/simple",
      thinking: "low",
      maxTurns: 12,
      startedGeneration: (await service.status()).generation,
    });
    await service.claimTask("T01", binding);
    await service.bindAgent("T01", binding.id, "agent-1");
    await service.markAgentStarted("agent-1");
    const handoff = {
      changedFiles: ["src/config.ts"],
      verification: [{ command: "npm test -- config", exitCode: 0 }],
      produced: ["src/config.ts#AppConfig.timeoutMs"],
    };
    const accepted = await service.submitHandoff(binding.id, handoff);
    const eventCount = (await service.store.readEvents()).length;

    expect(await service.submitHandoff(binding.id, handoff)).toEqual(accepted);
    expect(await service.store.readEvents()).toHaveLength(eventCount);
    await expect(service.submitHandoff(binding.id, {
      ...handoff,
      verification: [{ command: "npm test -- config", exitCode: 1 }],
    })).rejects.toThrow("different Handoff");
  });

  it("reconciles a historical Receipt-plus-blocked contradiction through an append-only Runtime event", async () => {
    const { service, dag } = await createRuntime();
    await completeFirstTask(service, dag.tasks[0]!.contractHash);
    await service.store.transact("simulate_legacy_stale_handoff_race", (state) => {
      const task = state.tasks.T01!;
      task.status = "blocked";
      task.verificationStatus = "failed";
      task.verificationError = "T01 changed undeclared paths from a later Task";
      task.blocker = task.verificationError;
      state.issueStatus = "blocked";
    });

    const result = await service.reconcileTaskReceipt("T01");

    expect(result.reconciled).toBe(true);
    expect(result.state.tasks.T01).toMatchObject({
      status: "completed",
      verificationStatus: "passed",
      gitStatus: "receipted",
      receipt: { commit: "commit-t01" },
    });
    expect(result.state.tasks.T01?.verificationError).toBeUndefined();
    expect(result.state.tasks.T01?.blocker).toBeUndefined();
    expect((await service.store.readEvents()).at(-1)?.type).toBe("task_reconciled_from_receipt");

    const repeated = await service.reconcileTaskReceipt("T01");
    expect(repeated.reconciled).toBe(false);
  });

  it("normalizes the legacy Spec/Integration Audit axis only at the Runtime read seam", async () => {
    const { root, service } = await createRuntime();
    const state = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
    state.audits = { spec_integration: { axis: "spec_integration", verdict: "passed", bindingId: "legacy-audit", findings: [], submittedAt: new Date().toISOString() } };
    state.auditJobs = { spec_integration: { id: "legacy-job", axis: "spec_integration", status: "completed", attempt: 1, maxAttempts: 2, model: "test/audit", thinking: "high", maxTurns: 20, configHash: "config" } };
    await writeFile(join(root, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
    const normalized = await service.store.readState();
    expect(normalized.audits?.acceptance_integration?.axis).toBe("acceptance_integration");
    expect(normalized.auditJobs?.acceptance_integration?.axis).toBe("acceptance_integration");
    expect((normalized.audits as Record<string, unknown>).spec_integration).toBeUndefined();
  });

  it("normalizes legacy Task version and Work Item identity only at the Runtime read seam", async () => {
    const { root, service } = await createRuntime();
    const dag = JSON.parse(await readFile(join(root, "dag.json"), "utf8"));
    delete dag.tasks[0].version;
    await writeFile(join(root, "dag.json"), `${JSON.stringify(dag, null, 2)}\n`);
    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
    delete manifest.workItemId;
    await writeFile(join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    expect((await service.store.readDag()).tasks[0]?.version).toBe(1);
    expect((await service.store.readManifest()).workItemId).toBe("legacy:issue-test");
  });

  it("rejects a Binding whose Work Item, Issue, Task version, path, or hash does not match the frozen contract", async () => {
    const { service, dag } = await createRuntime();
    const binding = RuntimeService.createBinding({
      workItemId: "wrong-work-item",
      issueId: "issue-test",
      taskId: "T01",
      taskVersion: 1,
      taskContractPath: "tasks/T01/TASK-V001.md",
      attempt: 1,
      workspace: service.store.root,
      contractHash: dag.tasks[0]!.contractHash,
      model: "test/simple",
      thinking: "low",
      maxTurns: 12,
      startedGeneration: (await service.status()).generation,
    });
    await expect(service.claimTask("T01", binding)).rejects.toThrow("Binding identity");
  });

  it("rebinds only future Task attempts while preserving completed Receipts and old Bindings", async () => {
    const { service, dag } = await createRuntime();
    await completeFirstTask(service, dag.tasks[0]!.contractHash);
    const oldReceipt = structuredClone((await service.status()).tasks.T01!.receipt);
    const oldBinding = RuntimeService.createBinding({
      workItemId: "work-item-test",
      issueId: "issue-test",
      taskId: "T02",
      taskVersion: 1,
      taskContractPath: "tasks/T02/TASK-V001.md",
      attempt: 1,
      workspace: service.store.root,
      contractHash: dag.tasks[1]!.contractHash,
      model: "test/simple",
      thinking: "low",
      maxTurns: 12,
      modelPolicyGeneration: 1,
      startedGeneration: (await service.status()).generation,
    });
    await service.claimTask("T02", oldBinding);
    await service.bindAgent("T02", oldBinding.id, "agent-2");
    await service.markAgentStarted("agent-2");
    await service.markAgentTerminal("agent-2", "failed", "interrupted");

    const nextPolicy = structuredClone(modelPolicy);
    nextPolicy.profiles.simple = { ...nextPolicy.profiles.simple!, maxTurns: 30 };
    const rebound = await service.rebindModelPolicy({ configGeneration: 3, configHash: "config-3", policy: nextPolicy, reason: "Increase retry budget" });
    expect(rebound.idempotent).toBe(false);
    expect(rebound.policy.generation).toBe(2);
    const state = await service.status();
    expect(state.tasks.T01?.receipt).toEqual(oldReceipt);
    expect(state.tasks.T02?.binding?.id).toBe(oldBinding.id);
    expect(state.tasks.T02?.binding?.maxTurns).toBe(12);
    expect(state.tasks.T02?.status).toBe("retry_ready");
    expect((await service.activeModelPolicy()).policy.profiles.simple?.maxTurns).toBe(30);
  });

  it("verifies final Audit Blockers before opening an immutable Remediation Plan", async () => {
    const { service } = await createRuntime();
    await service.store.transact("test_audit_blocked", (state) => {
      state.issueStatus = "blocked";
      state.auditGeneration = 1;
      state.audits = {
        standards: { axis: "standards", verdict: "passed", bindingId: "standards-binding", submittedAt: new Date().toISOString(), findings: [] },
        acceptance_integration: { axis: "acceptance_integration", verdict: "passed", bindingId: "acceptance-binding", submittedAt: new Date().toISOString(), findings: [] },
        architecture_minimality: {
          axis: "architecture_minimality",
          verdict: "blocked",
          bindingId: "audit-binding",
          submittedAt: new Date().toISOString(),
          findings: [{ id: "ARCH-1", severity: "blocker", message: "Shared state is mutated", evidence: ["src/config.ts#AppConfig"], violatedRule: "Mutation must remain local", verification: "Read AppConfig", suggestedResolution: "Use a local value" }],
        },
      };
    });
    let state = await service.createAuditBlockerVerifierJob({ model: "test/verifier", thinking: "high", maxTurns: 20, configHash: "config" });
    await expect(readFile(join(service.store.root, "audits", "blocker-verifier-plan-1.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const job = state.auditBlockerVerifierJob!;
    const binding = RuntimeService.createAuditBlockerVerifierBinding({ attempt: 1, findingHash: job.findingHash, model: job.model, thinking: job.thinking, maxTurns: job.maxTurns, startedGeneration: state.generation });
    await service.claimAuditBlockerVerifier(binding);
    state = await service.submitAuditBlockerVerification(binding.id, [{ findingId: "ARCH-1", status: "confirmed", evidence: ["src/config.ts#AppConfig"], rationale: "The committed code writes shared state", missingEvidence: [] }]);
    expect(state.remediationPlan?.status).toBe("awaiting_proposal");
    expect(state.remediationPlan?.confirmedFindingIds).toEqual(["ARCH-1"]);
    expect(state.tasks.T01?.status).toBe("ready");
  });

  it("keeps needs-more-evidence Blockers fail-closed for user input", async () => {
    const { service } = await createRuntime();
    await service.store.transact("test_audit_blocked", (state) => {
      state.issueStatus = "blocked";
      state.auditGeneration = 1;
      state.audits = {
        standards: { axis: "standards", verdict: "blocked", bindingId: "audit-binding", submittedAt: new Date().toISOString(), findings: [{ id: "STD-1", severity: "blocker", message: "Generated artifact may be stale", evidence: ["generated/file.ts"], violatedRule: "Generated files must match source", verification: "Run generator", suggestedResolution: "Regenerate only generated/file.ts from its authoritative source" }] },
        acceptance_integration: { axis: "acceptance_integration", verdict: "passed", bindingId: "acceptance-binding", submittedAt: new Date().toISOString(), findings: [] },
        architecture_minimality: { axis: "architecture_minimality", verdict: "passed", bindingId: "architecture-binding", submittedAt: new Date().toISOString(), findings: [] },
      };
    });
    let state = await service.createAuditBlockerVerifierJob({ model: "test/verifier", thinking: "high", maxTurns: 20, configHash: "config" });
    const job = state.auditBlockerVerifierJob!;
    const binding = RuntimeService.createAuditBlockerVerifierBinding({ attempt: 1, findingHash: job.findingHash, model: job.model, thinking: job.thinking, maxTurns: job.maxTurns, startedGeneration: state.generation });
    await service.claimAuditBlockerVerifier(binding);
    state = await service.submitAuditBlockerVerification(binding.id, [{ findingId: "STD-1", status: "needs_more_evidence", evidence: [], rationale: "Generator command is unavailable", missingEvidence: ["Authoritative generator command"] }]);
    expect(state.issueStatus).toBe("needs_user");
    expect(state.remediationPlan?.status).toBe("needs_user");
    expect(state.humanDecision?.kind).toBe("missing_evidence");
    expect(state.humanDecision?.status).toBe("open");
  });

  it("persists an immutable user decision gate and resumes only after explicit answer", async () => {
    const { service } = await createRuntime();
    await service.store.transact("test_remediation_ambiguous", (state) => {
      state.issueStatus = "blocked";
      state.remediationPlan = { id: "remediation-1", source: "audit", sourceAuditGeneration: 1, findingHash: "finding-hash", confirmedFindingIds: ["F-1"], status: "awaiting_proposal", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), plannerJob: { status: "running", attempt: 1, maxAttempts: 2, model: "test/planner", thinking: "high", maxTurns: 20, configHash: "config", binding: { id: "planner-binding", attempt: 1, spawnRequestId: "spawn", findingHash: "finding-hash", model: "test/planner", thinking: "high", maxTurns: 20, startedGeneration: state.generation, createdAt: new Date().toISOString() } } };
    });
    let state = await service.requestHumanDecision({
      kind: "architecture_change",
      source: "remediation_planner",
      sourceBindingId: "planner-binding",
      question: "Which approved seam should own the repair?",
      reason: "Both options change the existing architecture decision.",
      evidence: ["PRD D-01", "src/config.ts#AppConfig"],
      options: [
        { id: "amend", label: "Amend PRD", description: "Choose a new seam through planning", consequences: ["Current Runtime stays blocked"], resumeAction: "supersede_work_item" },
        { id: "abort", label: "Abort", description: "Stop this Issue", consequences: ["No repair code is written"], resumeAction: "abort_issue" },
      ],
      recommendedOptionId: "amend",
      resumeAction: "supersede_work_item",
    });
    expect(state.issueStatus).toBe("needs_user");
    expect(state.humanDecision?.status).toBe("open");
    await expect(service.resumeHumanDecision(state.humanDecision!.id)).rejects.toThrow("not answered");
    state = await service.answerHumanDecision({ requestId: state.humanDecision!.id, requestHash: state.humanDecision!.requestHash, selectedOptionId: "amend", decision: "Amend the PRD", rationale: "The repair requires a different approved seam", evidence: ["User approved amendment"], answeredBy: "user", authorizationEvidence: "Exact user statement" });
    expect(state.humanDecision?.status).toBe("answered");
    const resumed = await service.resumeHumanDecision(state.humanDecision!.id);
    expect(resumed.action).toBe("supersede_work_item");
    expect(resumed.state.issueStatus).toBe("needs_user");
  });

  it("clears an exhausted Planner projection when an answered Decision resumes planning", async () => {
    const { service } = await createRuntime();
    const createdAt = new Date().toISOString();
    await service.store.transact("test_exhausted_planner", (state) => {
      state.issueStatus = "blocked";
      state.remediationPlan = {
        id: "remediation-1",
        source: "audit",
        sourceAuditGeneration: 1,
        findingHash: "finding-hash",
        confirmedFindingIds: ["F-1"],
        status: "awaiting_proposal",
        createdAt,
        updatedAt: createdAt,
        plannerJob: {
          status: "failed",
          attempt: 3,
          maxAttempts: 2,
          model: "test/planner",
          thinking: "high",
          maxTurns: 20,
          configHash: "config",
          binding: { id: "planner-binding", attempt: 3, spawnRequestId: "spawn", findingHash: "finding-hash", model: "test/planner", thinking: "high", maxTurns: 20, startedGeneration: state.generation, createdAt },
          error: "Planner terminated without a Proposal",
        },
      };
    });
    let state = await service.requestHumanDecision({
      kind: "missing_evidence",
      source: "remediation_planner",
      sourceBindingId: "planner-binding",
      question: "May the normalized evidence seam be used?",
      reason: "The original citation was not consumable by the Task validator.",
      evidence: ["src/request-policy.js:2-8"],
      options: [
        { id: "resume", label: "Resume", description: "Use the normalized seam", consequences: ["Creates a fresh Planner binding"], resumeAction: "resume_planner" },
        { id: "abort", label: "Abort", description: "Stop remediation", consequences: ["Leaves the Issue blocked"], resumeAction: "abort_issue" },
      ],
      recommendedOptionId: "resume",
      resumeAction: "resume_planner",
    });
    state = await service.answerHumanDecision({ requestId: state.humanDecision!.id, requestHash: state.humanDecision!.requestHash, selectedOptionId: "resume", decision: "Resume planning", rationale: "The seam normalization preserves scope", evidence: ["User approved"], answeredBy: "user", authorizationEvidence: "Exact user statement" });
    const resumed = await service.resumeHumanDecision(state.humanDecision!.id);
    expect(resumed.action).toBe("resume_planner");
    expect(resumed.state.remediationPlan?.status).toBe("awaiting_proposal");
    expect(resumed.state.remediationPlan?.plannerJob).toBeUndefined();
    const recreated = await service.createRemediationPlannerJob({ model: "test/planner", thinking: "high", maxTurns: 20, configHash: "config" });
    expect(recreated.remediationPlan?.plannerJob?.status).toBe("pending");
    expect(recreated.remediationPlan?.plannerJob?.attempt).toBe(0);
  });

  it("reconciles an immutable final Issue Receipt written before the completion state transition", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-task-runtime-final-reconcile-"));
    roots.push(root);
    const workspaceRoot = join(root, "repo");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspaceRoot));
    await writeFile(join(workspaceRoot, "README.md"), "fixture\n");
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "-q"], { cwd: workspaceRoot });
    execFileSync("git", ["config", "user.email", "forge@example.com"], { cwd: workspaceRoot });
    execFileSync("git", ["config", "user.name", "Forge Test"], { cwd: workspaceRoot });
    execFileSync("git", ["add", "."], { cwd: workspaceRoot });
    execFileSync("git", ["commit", "-qm", "baseline"], { cwd: workspaceRoot });
    const service = new RuntimeService(join(root, "runtime"));
    await service.initialize({ workItemId: "WI", issueId: "I001", issueHash: "issue", workspaceRoot, workspaceMode: "shared-serial", modelPolicy }, { generation: 1, tasks: [] }, [{ id: "S001", gate: [] }]);
    const audits = {
      standards: { axis: "standards" as const, verdict: "passed" as const, bindingId: "std", findings: [], submittedAt: "now" },
      acceptance_integration: { axis: "acceptance_integration" as const, verdict: "passed" as const, bindingId: "acc", findings: [], submittedAt: "now" },
      architecture_minimality: { axis: "architecture_minimality" as const, verdict: "passed" as const, bindingId: "arch", findings: [], submittedAt: "now" },
    };
    await service.store.transact("test_ready_for_completion", (state) => { state.issueStatus = "auditing"; state.sliceGates!.S001!.status = "passed"; state.audits = audits; });
    const receipt = { schemaVersion: 1, issueId: "I001", audits, completedAt: "first" };
    await service.store.writeAudit("issue-final", receipt);
    await writeFile(join(workspaceRoot, "untracked.txt"), "dirty\n");
    await expect(service.markIssueCompleted({ ...receipt, completedAt: "retry" })).rejects.toThrow("clean Git workspace");
    await rm(join(workspaceRoot, "untracked.txt"));
    const completed = await service.markIssueCompleted({ ...receipt, completedAt: "retry" });
    expect(completed.issueStatus).toBe("completed");
    expect(await service.store.readAudit("issue-final")).toEqual(receipt);
    expect((await service.store.readEvents()).at(-1)?.details).toMatchObject({ reconciled: true });
  });

  it("does not treat an agent completion without handoff as Task completion", async () => {
    const { service, dag } = await createRuntime();
    const binding = RuntimeService.createBinding({
      workItemId: "work-item-test",
      issueId: "issue-test",
      taskId: "T01",
      taskVersion: 1,
      taskContractPath: "tasks/T01/TASK-V001.md",
      attempt: 1,
      workspace: service.store.root,
      contractHash: dag.tasks[0]!.contractHash,
      model: "test/simple",
      thinking: "low",
      maxTurns: 12,
      startedGeneration: (await service.status()).generation,
    });
    await service.claimTask("T01", binding);
    await service.bindAgent("T01", binding.id, "agent-1");
    await service.markAgentStarted("agent-1");
    await service.markAgentTerminal("agent-1", "completed");

    expect((await service.status()).tasks.T01?.status).toBe("interrupted");
    await expect(service.beginVerification("T01")).rejects.toThrow("no valid handoff");
  });

  it("rejects undeclared handoff files", async () => {
    const { service, dag } = await createRuntime();
    const binding = RuntimeService.createBinding({
      workItemId: "work-item-test",
      issueId: "issue-test",
      taskId: "T01",
      taskVersion: 1,
      taskContractPath: "tasks/T01/TASK-V001.md",
      attempt: 1,
      workspace: service.store.root,
      contractHash: dag.tasks[0]!.contractHash,
      model: "test/simple",
      thinking: "low",
      maxTurns: 12,
      startedGeneration: (await service.status()).generation,
    });
    await service.claimTask("T01", binding);
    await expect(service.submitHandoff(binding.id, {
      changedFiles: ["src/other.ts"],
      verification: [],
      produced: [],
    })).rejects.toThrow("undeclared Writes");
  });

  it("repairs a stale state snapshot from the append-only ledger", async () => {
    const { root, service, dag } = await createRuntime();
    await completeFirstTask(service, dag.tasks[0]!.contractHash);
    const completed = await service.status();
    const stale = structuredClone(completed);
    stale.generation -= 1;
    stale.eventSequence -= 1;
    stale.tasks.T01!.status = "verifying";
    await writeFile(join(root, "state.json"), `${JSON.stringify(stale, null, 2)}\n`);

    const result = await service.doctor();
    expect(result.repaired).toBe(true);
    expect(result.state.tasks.T01?.status).toBe("completed");
    const onDisk = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
    expect(onDisk.tasks.T01.status).toBe("completed");
  });
});
