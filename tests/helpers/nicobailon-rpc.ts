export interface TestEventBus {
  on(event: string, handler: (payload: any) => void): unknown;
  emit(event: string, payload: unknown): void;
}

export const RPC_V1_REQUEST = "subagents:rpc:v1:request";
export const ASYNC_COMPLETE = "subagent:async-complete";

export function rpcV1Success(bus: TestEventBus, request: any, data: unknown): void {
  bus.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
    version: 1,
    requestId: request.requestId,
    method: request.method,
    success: true,
    data,
  });
}

export function rpcV1Failure(bus: TestEventBus, request: any, code: string, message: string): void {
  bus.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
    version: 1,
    requestId: request.requestId,
    method: request.method,
    success: false,
    error: { code, message },
  });
}

export function workflowSpawnData(id: string): Record<string, unknown> {
  return { details: { mode: "workflow", asyncId: id, asyncDir: `/tmp/${id}` } };
}

export function installRpcV1(bus: TestEventBus, options: {
  onSpawn?: (request: any) => void;
  nextId?: (request: any) => string;
  onInterrupt?: (request: any) => void;
} = {}): void {
  let spawnCount = 0;
  bus.on(RPC_V1_REQUEST, (request) => {
    if (request.method === "ping") {
      rpcV1Success(bus, request, { version: 1, methods: ["ping", "spawn", "status", "interrupt"] });
      return;
    }
    if (request.method === "spawn") {
      spawnCount += 1;
      options.onSpawn?.(request);
      const id = options.nextId?.(request) ?? `agent-${spawnCount}`;
      rpcV1Success(bus, request, workflowSpawnData(id));
      return;
    }
    if (request.method === "interrupt") {
      options.onInterrupt?.(request);
      rpcV1Success(bus, request, { state: "interrupting" });
    }
  });
}

export function spawnAgent(request: any): string | undefined {
  return request?.params?.agent;
}

export function spawnModel(request: any): string | undefined {
  return request?.params?.model;
}

export function spawnTask(request: any): string {
  return typeof request?.params?.task === "string" ? request.params.task : "";
}

export function spawnDescription(request: any): string | undefined {
  return spawnTask(request).match(/^<forge-subagent-binding>\nagent: [^\n]+\ndescription: ([^\n]+)\n<\/forge-subagent-binding>/)?.[1];
}

export function emitWorkflowCompletion(bus: TestEventBus, requestOrId: any, success = true): void {
  const id = typeof requestOrId === "string"
    ? requestOrId
    : requestOrId?.replyId ?? requestOrId?.id ?? requestOrId;
  bus.emit(ASYNC_COMPLETE, {
    id,
    runId: id,
    mode: "workflow",
    state: success ? "complete" : "failed",
    success,
    summary: success ? "done" : "failed",
    results: [{ workflowKey: "main", status: success ? "completed" : "failed", success }],
  });
}
