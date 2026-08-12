import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { demoDag, modelPolicy } from "../examples/fixture.js";
import { RuntimeService } from "../src/runtime/service.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

it("adds remediation as a new immutable DAG generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-task-amendment-"));
  roots.push(root);
  const service = new RuntimeService(root);
  await service.initialize({
    workItemId: "work-item-test",
    issueId: "issue-test",
    issueHash: "issue-hash",
    workspaceRoot: root,
    workspaceMode: "shared-serial",
    issueModelProfile: "simple",
    auditModelProfile: "rigorous",
    modelPolicy,
  }, demoDag(), [{ id: "S01", gate: [{ command: "npm test -- integration", timeoutMs: 60_000, proves: "AC-01" }] }]);

  const input = {
    id: "T03",
    version: 1,
    title: "Repair timeout integration",
    sliceId: "S01",
    dependencies: ["T02"],
    conflicts: [],
    writes: ["src/integration.test.ts"],
    produces: ["src/integration.test.ts#timeoutRegression"],
    consumes: ["T02::src/client.ts#configuredTimeout"],
    acceptance: ["AC-01", "AC-02"],
    verification: [{ command: "npm test -- integration", timeoutMs: 60_000 }],
  };
  const task = { ...input, contractHash: RuntimeService.contractHash(input) };
  await service.store.transact("test_remediation_ready", (state) => {
    state.tasks.T01!.status = "completed";
    state.tasks.T02!.status = "completed";
    state.sliceGates!.S01!.status = "passed";
    state.auditGeneration = 1;
    state.auditJobs = {
      standards: { id: "old-standards", axis: "standards", status: "result_submitted", attempt: 1, maxAttempts: 2, model: "test/audit", thinking: "high", maxTurns: 20, configHash: "config" },
      spec_integration: { id: "old-spec", axis: "spec_integration", status: "result_submitted", attempt: 1, maxAttempts: 2, model: "test/audit", thinking: "high", maxTurns: 20, configHash: "config" },
      architecture_minimality: { id: "old-arch", axis: "architecture_minimality", status: "result_submitted", attempt: 1, maxAttempts: 2, model: "test/audit", thinking: "high", maxTurns: 20, configHash: "config" },
    };
    state.remediationPlan = {
      id: "remediation-1",
      source: "audit",
      sourceAuditGeneration: 1,
      findingHash: "finding-hash",
      confirmedFindingIds: ["F-1"],
      status: "ready",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  });
  const next = await service.applyRemediation({
    id: "A001",
    reason: "Confirmed Slice Gate blocker",
    createdAt: new Date().toISOString(),
    approvedBy: "runtime-policy",
    tasks: [task],
    rerunSliceIds: ["S01"],
  });

  expect(next.dagGeneration).toBe(2);
  expect(next.tasks.T03?.status).toBe("ready");
  expect(next.tasks.T01?.status).toBe("completed");
  expect(next.tasks.T02?.status).toBe("completed");
  expect(next.sliceGates?.S01?.status).toBe("pending");
  expect(next.auditJobs).toBeUndefined();
  expect(next.remediationPlan?.status).toBe("applied");
  expect((await service.store.readDag()).generation).toBe(2);
  expect((await service.store.readEvents()).at(-1)?.type).toBe("dag_amended");
});
