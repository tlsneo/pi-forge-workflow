import { describe, expect, it, vi } from "vitest";
import {
  NICOBIALON_ASYNC_COMPLETE_EVENT,
  NICOBIALON_RPC_REQUEST_EVENT,
  PiSubagentsAdapter,
  type EventBus,
} from "../src/subagents/adapter.js";

class FakeBus implements EventBus {
  handlers = new Map<string, Set<(payload: any) => void>>();

  on(event: string, handler: (payload: any) => void) {
    const handlers = this.handlers.get(event) ?? new Set();
    handlers.add(handler);
    this.handlers.set(event, handlers);
    return () => handlers.delete(handler);
  }

  emit(event: string, payload: any) {
    for (const handler of [...(this.handlers.get(event) ?? [])]) handler(payload);
  }
}

function reply(bus: FakeBus, request: any, data: unknown) {
  bus.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
    version: 1,
    requestId: request.requestId,
    method: request.method,
    success: true,
    data,
  });
}

const spawnRequest = {
  type: "task-worker",
  prompt: "task",
  description: "workflow:binding:T01",
  model: { provider: "test", id: "simple" },
  thinkingLevel: "low" as const,
  maxTurns: 12,
  cwd: "/tmp/project",
};

describe("PiSubagentsAdapter", () => {
  it("uses Nicobailon RPC v1 ping", async () => {
    const bus = new FakeBus();
    const adapter = new PiSubagentsAdapter(bus, 100);

    bus.on(NICOBIALON_RPC_REQUEST_EVENT, (request) => {
      expect(request).toMatchObject({ version: 1, method: "ping", params: {}, source: { extension: "pi-forge-workflow" } });
      reply(bus, request, { version: 1, methods: ["ping", "spawn"] });
    });

    await expect(adapter.ping()).resolves.toBe(1);
  });

  it("spawns one explicit non-isolated fresh async Workflow", async () => {
    const bus = new FakeBus();
    const adapter = new PiSubagentsAdapter(bus, 100);
    const observed = vi.fn();

    bus.on(NICOBIALON_RPC_REQUEST_EVENT, (request) => {
      if (request.method !== "spawn") return;
      observed(request);
      reply(bus, request, { details: { mode: "workflow", asyncId: "run-1", asyncDir: "/tmp/run-1" } });
    });

    await expect(adapter.spawn(spawnRequest)).resolves.toBe("run-1");
    expect(observed).toHaveBeenCalledTimes(1);
    const request = observed.mock.calls[0]?.[0];
    expect(request).toMatchObject({ version: 1, method: "spawn" });
    expect(request.params).toMatchObject({
      agent: "task-worker",
      async: true,
      isolation: "none",
      context: "fresh",
      cwd: "/tmp/project",
      model: "test/simple",
      thinking: "low",
      turnBudget: { maxTurns: 12, graceTurns: 0 },
      timeoutMs: 3_600_000,
    });
    expect(request.params.task).toContain("description: workflow:binding:T01");
    expect(request.params).not.toHaveProperty("workflowScript");
    expect(request.params).not.toHaveProperty("worktree");
  });

  it("correlates completion-before-reply and emits one terminal Forge lifecycle event", async () => {
    const bus = new FakeBus();
    const adapter = new PiSubagentsAdapter(bus, 100);
    const completed = vi.fn();
    adapter.onCompleted(completed);

    bus.on(NICOBIALON_RPC_REQUEST_EVENT, (request) => {
      if (request.method !== "spawn") return;
      bus.emit(NICOBIALON_ASYNC_COMPLETE_EVENT, {
        id: "run-early",
        runId: "run-early",
        toolCallId: `rpc-spawn-${request.requestId}`,
        mode: "workflow",
        state: "complete",
        success: true,
        summary: "done",
        durationMs: 25,
        results: [{ workflowKey: "main", success: true, status: "completed" }],
      });
      reply(bus, request, { details: { mode: "workflow", asyncId: "run-early", asyncDir: "/tmp/run-early" } });
    });

    await expect(adapter.spawn(spawnRequest)).resolves.toBe("run-early");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(completed).toHaveBeenCalledTimes(1);
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({
      id: "run-early",
      description: "workflow:binding:T01",
      status: "completed",
      result: "done",
    }));

    bus.emit(NICOBIALON_ASYNC_COMPLETE_EVENT, { runId: "run-early", success: true, state: "complete" });
    expect(completed).toHaveBeenCalledTimes(1);
  });

  it("maps failed Workflow completion to the failed lifecycle channel", async () => {
    const bus = new FakeBus();
    const adapter = new PiSubagentsAdapter(bus, 100);
    const failed = vi.fn();
    adapter.onFailed(failed);

    bus.on(NICOBIALON_RPC_REQUEST_EVENT, (request) => {
      if (request.method !== "spawn") return;
      reply(bus, request, { details: { mode: "workflow", asyncId: "run-failed", asyncDir: "/tmp/run-failed" } });
    });

    await adapter.spawn(spawnRequest);
    bus.emit(NICOBIALON_ASYNC_COMPLETE_EVENT, {
      runId: "run-failed",
      state: "failed",
      success: false,
      summary: "boom",
      results: [{ status: "failed", success: false }],
    });

    expect(failed).toHaveBeenCalledWith(expect.objectContaining({
      id: "run-failed",
      status: "failed",
      error: "boom",
    }));
  });
});
