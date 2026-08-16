import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { demoDag, modelPolicy } from "../examples/fixture.js";
import { RuntimeService } from "../src/runtime/service.js";
import { classifySubagentFailure, recordSubagentFailure } from "../src/subagents/failures.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function runtime() {
  const root = await mkdtemp(join(tmpdir(), "pi-forge-infrastructure-retry-"));
  roots.push(root);
  const service = new RuntimeService(root);
  await service.initialize({
    workItemId: "work-item-test",
    issueId: "issue-test",
    issueHash: "issue-hash",
    workspaceRoot: root,
    workspaceMode: "shared-serial",
    modelPolicy,
  }, demoDag());
  return service;
}

describe("Subagent infrastructure failure policy", () => {
  it("classifies only recognizable transport, service, RPC, and lifecycle failures as infrastructure", () => {
    expect(classifySubagentFailure("503 Service Unavailable", "spawn")).toMatchObject({ classification: "infrastructure", kind: "service_unavailable" });
    expect(classifySubagentFailure("pi-subagents RPC timeout: subagents:rpc:spawn", "spawn")).toMatchObject({ classification: "infrastructure", kind: "rpc_timeout" });
    expect(classifySubagentFailure("ECONNRESET while reading response", "lifecycle")).toMatchObject({ classification: "infrastructure", kind: "transport" });
    expect(classifySubagentFailure("Reviewer completed without a structured result", "lifecycle")).toMatchObject({ classification: "semantic" });
  });

  it("uses separate bounded infrastructure and semantic retry budgets", () => {
    const ledger = { attempt: 1, maxAttempts: 2 };
    expect(recordSubagentFailure(ledger, classifySubagentFailure("503 Service Unavailable", "spawn"))).toMatchObject({ retry: true, infrastructureAttempts: 1, semanticAttempts: 0 });
    ledger.attempt = 2;
    expect(recordSubagentFailure(ledger, classifySubagentFailure("503 Service Unavailable", "spawn"))).toMatchObject({ retry: true, infrastructureAttempts: 2, semanticAttempts: 0 });
    ledger.attempt = 3;
    expect(recordSubagentFailure(ledger, classifySubagentFailure("503 Service Unavailable", "spawn"))).toMatchObject({ retry: false, exhausted: true, infrastructureAttempts: 3, semanticAttempts: 0 });
  });

  it("fails closed when a spawn RPC timeout leaves the remote outcome unknowable", async () => {
    const service = await runtime();
    const contract = (await service.store.readDag()).tasks[0]!;
    const state = await service.status();
    const binding = RuntimeService.createBinding({
      workItemId: "work-item-test",
      issueId: "issue-test",
      taskId: contract.id,
      taskVersion: contract.version,
      taskContractPath: `tasks/${contract.id}/TASK-V001.md`,
      attempt: 1,
      workspace: service.store.root,
      contractHash: contract.contractHash,
      model: "test/simple",
      thinking: "low",
      maxTurns: 12,
      startedGeneration: state.generation,
    });
    await service.claimTask(contract.id, binding);
    const failed = await service.markSpawnFailed(contract.id, "pi-subagents RPC timeout: subagents:rpc:spawn");
    expect(failed.tasks[contract.id]?.status).toBe("infrastructure_failed");
    expect(failed.tasks[contract.id]?.attempt).toBe(1);
    expect((await service.store.readEvents()).at(-1)?.type).toBe("infrastructure_spawn_outcome_unknown");
  });

  it("records infrastructure_retry events without consuming Worker semantic attempts", async () => {
    const service = await runtime();
    const contract = (await service.store.readDag()).tasks[0]!;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const state = await service.status();
      const binding = RuntimeService.createBinding({
        workItemId: "work-item-test",
        issueId: "issue-test",
        taskId: contract.id,
        taskVersion: contract.version,
        taskContractPath: `tasks/${contract.id}/TASK-V001.md`,
        attempt,
        workspace: service.store.root,
        contractHash: contract.contractHash,
        model: "test/simple",
        thinking: "low",
        maxTurns: 12,
        startedGeneration: state.generation,
      });
      await service.claimTask(contract.id, binding);
      const failed = await service.markSpawnFailed(contract.id, "503 Service Unavailable");
      if (attempt < 3) {
        expect(failed.tasks[contract.id]?.status).toBe("retry_ready");
        await service.retryTask(contract.id, "Retry infrastructure failure");
      }
    }
    const state = await service.status();
    expect(state.tasks[contract.id]).toMatchObject({
      status: "infrastructure_failed",
      infrastructureAttempts: 3,
      attempt: 3,
      lastFailure: { classification: "infrastructure", kind: "service_unavailable" },
    });
    expect(state.issueStatus).toBe("infrastructure_failed");
    const retryEvents = (await service.store.readEvents()).filter((event) => event.type === "infrastructure_retry_scheduled");
    expect(retryEvents).toHaveLength(3);
  });
});
