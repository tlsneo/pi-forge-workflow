import { describe, expect, it, vi } from "vitest";
import { PiSubagentsAdapter, type EventBus } from "../src/subagents/adapter.js";

class FakeBus implements EventBus {
  handlers = new Map<string, Set<(payload: any) => void>>();

  on(event: string, handler: (payload: any) => void) {
    const handlers = this.handlers.get(event) ?? new Set();
    handlers.add(handler);
    this.handlers.set(event, handlers);
    return () => handlers.delete(handler);
  }

  emit(event: string, payload: any) {
    for (const handler of this.handlers.get(event) ?? []) handler(payload);
  }
}

describe("PiSubagentsAdapter", () => {
  it("uses scoped RPC replies and pi-subagents internal spawn option names", async () => {
    const bus = new FakeBus();
    const adapter = new PiSubagentsAdapter(bus, 100);
    const observed = vi.fn();

    bus.on("subagents:rpc:spawn", (request) => {
      observed(request);
      bus.emit(`subagents:rpc:spawn:reply:${request.requestId}`, { success: true, data: { id: "agent-1" } });
    });

    const id = await adapter.spawn({
      type: "task-worker",
      prompt: "task",
      description: "workflow:binding:T01",
      model: { provider: "test", id: "simple" },
      thinkingLevel: "low",
      maxTurns: 12,
      cwd: "/tmp/project",
    });

    expect(id).toBe("agent-1");
    expect(observed.mock.calls[0]?.[0].options).toMatchObject({
      thinkingLevel: "low",
      maxTurns: 12,
      isBackground: true,
      cwd: "/tmp/project",
      invocation: {
        modelName: "test/simple",
        thinking: "low",
        maxTurns: 12,
        runInBackground: true,
      },
    });
    expect(observed.mock.calls[0]?.[0].options).not.toHaveProperty("run_in_background");
    expect(observed.mock.calls[0]?.[0].options).not.toHaveProperty("configCwd");
    expect(observed.mock.calls[0]?.[0].options).not.toHaveProperty("isolation");
  });

  it("forwards lifecycle events", () => {
    const bus = new FakeBus();
    const adapter = new PiSubagentsAdapter(bus);
    const listener = vi.fn();
    adapter.onCompleted(listener);
    bus.emit("subagents:completed", { id: "agent-1", type: "task-worker", description: "workflow:b:T01" });
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ id: "agent-1" }));
  });
});
