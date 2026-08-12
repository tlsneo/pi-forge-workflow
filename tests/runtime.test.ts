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
      state.audits = { standards: { axis: "standards", verdict: "blocked", bindingId: "audit-binding", submittedAt: new Date().toISOString(), findings: [{ id: "STD-1", severity: "blocker", message: "Generated artifact may be stale", evidence: ["generated/file.ts"], violatedRule: "Generated files must match source", verification: "Run generator" }] } };
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
