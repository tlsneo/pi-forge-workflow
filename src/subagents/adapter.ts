import { randomUUID } from "node:crypto";
import type { ThinkingLevel } from "../runtime/types.js";
import { infrastructureErrorFromMessage, SubagentInfrastructureError } from "./failures.js";

export const NICOBIALON_RPC_PROTOCOL_VERSION = 1;
export const NICOBIALON_RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
export const NICOBIALON_RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
export const NICOBIALON_ASYNC_COMPLETE_EVENT = "subagent:async-complete";

export interface EventBus {
  on(event: string, handler: (payload: any) => void): (() => void) | void;
  emit(event: string, payload: unknown): void;
}

export interface SpawnRequest {
  type: string;
  prompt: string;
  description: string;
  model: unknown;
  thinkingLevel: ThinkingLevel;
  maxTurns: number;
  cwd: string;
}

export interface SubagentLifecycleEvent {
  id: string;
  type: string;
  description: string;
  status?: string;
  result?: string;
  error?: string;
  durationMs?: number;
  tokens?: { input: number; output: number; total: number };
}

interface RpcErrorPayload {
  code?: string;
  message?: string;
}

interface RpcReply<T> {
  version?: number;
  requestId?: string;
  method?: string;
  success: boolean;
  data?: T;
  error?: RpcErrorPayload;
}

interface SpawnReplyData {
  details?: {
    mode?: string;
    asyncId?: string;
    asyncDir?: string;
    runId?: string;
    toolCallId?: string;
  };
}

interface SpawnMetadata {
  requestId: string;
  expectedToolCallId: string;
  request: SpawnRequest;
  runId?: string;
  earlyCompletion?: Record<string, unknown>;
}

function exactModelLabel(model: unknown): string | undefined {
  if (typeof model === "string") return model;
  if (!model || typeof model !== "object") return undefined;
  const candidate = model as { provider?: unknown; id?: unknown; name?: unknown };
  if (typeof candidate.provider === "string" && typeof candidate.id === "string") return `${candidate.provider}/${candidate.id}`;
  if (typeof candidate.id === "string") return candidate.id;
  if (typeof candidate.name === "string") return candidate.name;
  return undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function completionId(payload: Record<string, unknown>): string | undefined {
  return nonEmptyString(payload.runId) ?? nonEmptyString(payload.id);
}

function completionToolCallId(payload: Record<string, unknown>): string | undefined {
  return nonEmptyString(payload.toolCallId);
}

function completionStatus(payload: Record<string, unknown>): "completed" | "failed" | "stopped" | "aborted" {
  const firstResult = Array.isArray(payload.results) ? record(payload.results[0]) : undefined;
  const state = nonEmptyString(payload.state)?.toLowerCase();
  const childStatus = nonEmptyString(firstResult?.status)?.toLowerCase();
  if (payload.stopped === true || state === "stopped" || childStatus === "stopped") return "stopped";
  if (payload.interrupted === true || state === "aborted" || childStatus === "aborted") return "aborted";
  if (payload.success === true && (state === undefined || state === "complete" || state === "completed")) return "completed";
  return "failed";
}

function completionText(payload: Record<string, unknown>): string | undefined {
  const firstResult = Array.isArray(payload.results) ? record(payload.results[0]) : undefined;
  return nonEmptyString(payload.summary)
    ?? nonEmptyString(firstResult?.summary)
    ?? nonEmptyString(firstResult?.output)
    ?? nonEmptyString(firstResult?.error);
}

function completionTokens(payload: Record<string, unknown>): SubagentLifecycleEvent["tokens"] {
  const source = record(payload.tokens) ?? record(payload.totalTokens);
  if (!source) return undefined;
  const value = (key: string) => typeof source[key] === "number" && Number.isFinite(source[key]) && source[key] >= 0
    ? Math.floor(source[key])
    : 0;
  const input = value("input");
  const output = value("output");
  const total = Math.max(value("total"), input + output);
  return { input, output, total };
}

function modelWithThinking(model: string, thinking: string): string {
  const normalizedThinking = thinking.trim();
  if (!normalizedThinking) throw new Error("Forge requires an explicit thinking level for pi-subagents spawn");
  const slashIndex = model.lastIndexOf("/");
  const colonIndex = model.lastIndexOf(":");
  const baseModel = colonIndex > slashIndex ? model.slice(0, colonIndex) : model;
  return `${baseModel}:${normalizedThinking}`;
}

function promptWithBindingMetadata(request: SpawnRequest): string {
  return [
    "<forge-subagent-binding>",
    `agent: ${request.type}`,
    `description: ${request.description}`,
    "</forge-subagent-binding>",
    "",
    request.prompt,
  ].join("\n");
}

export class PiSubagentsAdapter {
  private readonly events: EventBus;
  private readonly timeoutMs: number;
  private readonly pendingByToolCallId = new Map<string, SpawnMetadata>();
  private readonly runs = new Map<string, SpawnMetadata>();
  private readonly completedRuns = new Set<string>();
  private readonly startedHandlers = new Set<(event: SubagentLifecycleEvent) => void>();
  private readonly completedHandlers = new Set<(event: SubagentLifecycleEvent) => void>();
  private readonly failedHandlers = new Set<(event: SubagentLifecycleEvent) => void>();

  constructor(events: EventBus, timeoutMs = 5_000) {
    this.events = events;
    this.timeoutMs = timeoutMs;
    this.events.on(NICOBIALON_ASYNC_COMPLETE_EVENT, (payload) => this.handleCompletion(payload));
  }

  async ping(): Promise<number> {
    const reply = await this.rpc<{ version?: number }>("ping", {});
    const version = reply.version;
    if (version !== NICOBIALON_RPC_PROTOCOL_VERSION) {
      throw new Error(`Unsupported pi-subagents RPC protocol: ${String(version)}`);
    }
    return version;
  }

  async spawn(request: SpawnRequest): Promise<string> {
    const model = exactModelLabel(request.model);
    if (!model) throw new Error("Forge requires an exact provider/model for pi-subagents spawn");

    const requestId = randomUUID();
    const expectedToolCallId = `rpc-spawn-${requestId}`;
    const metadata: SpawnMetadata = { requestId, expectedToolCallId, request };
    this.pendingByToolCallId.set(expectedToolCallId, metadata);

    try {
      const reply = await this.rpcWithRequestId<SpawnReplyData>(requestId, "spawn", {
        agent: request.type,
        task: promptWithBindingMetadata(request),
        async: true,
        isolation: "none",
        context: "fresh",
        cwd: request.cwd,
        model: modelWithThinking(model, request.thinkingLevel),
        turnBudget: { maxTurns: request.maxTurns, graceTurns: 0 },
        timeoutMs: 3_600_000,
      });
      const details = reply.details;
      const runId = nonEmptyString(details?.asyncId) ?? nonEmptyString(details?.runId);
      if (details?.mode !== "workflow" || !runId) {
        throw new SubagentInfrastructureError("lifecycle_lost", "pi-subagents spawn outcome unknown: invalid async Workflow receipt");
      }

      metadata.runId = runId;
      this.runs.set(runId, metadata);
      if (metadata.earlyCompletion) queueMicrotask(() => this.deliverCompletion(metadata, metadata.earlyCompletion!));
      return runId;
    } finally {
      this.pendingByToolCallId.delete(expectedToolCallId);
    }
  }

  async stop(agentId: string): Promise<void> {
    try {
      await this.rpc("interrupt", { id: agentId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/\b(?:not_found|invalid_state)\b/i.test(message)) return;
      throw error;
    }
  }

  onStarted(handler: (event: SubagentLifecycleEvent) => void): () => void {
    this.startedHandlers.add(handler);
    return () => this.startedHandlers.delete(handler);
  }

  onCompleted(handler: (event: SubagentLifecycleEvent) => void): () => void {
    this.completedHandlers.add(handler);
    return () => this.completedHandlers.delete(handler);
  }

  onFailed(handler: (event: SubagentLifecycleEvent) => void): () => void {
    this.failedHandlers.add(handler);
    return () => this.failedHandlers.delete(handler);
  }

  onCompacted(handler: (event: SubagentLifecycleEvent & { compactionCount: number }) => void): () => void {
    const unsubscribe = this.events.on("subagent:compacted", handler);
    return typeof unsubscribe === "function" ? unsubscribe : () => undefined;
  }

  private handleCompletion(raw: unknown): void {
    const payload = record(raw);
    if (!payload) return;
    const toolCallId = completionToolCallId(payload);
    if (toolCallId) {
      const pending = this.pendingByToolCallId.get(toolCallId);
      if (pending && !pending.runId) {
        pending.earlyCompletion ??= payload;
        return;
      }
    }
    const runId = completionId(payload);
    if (!runId || this.completedRuns.has(runId)) return;
    const metadata = this.runs.get(runId);
    if (metadata) this.deliverCompletion(metadata, payload);
  }

  private deliverCompletion(metadata: SpawnMetadata, payload: Record<string, unknown>): void {
    const runId = metadata.runId ?? completionId(payload);
    if (!runId || this.completedRuns.has(runId)) return;
    const payloadRunId = completionId(payload);
    if (payloadRunId && payloadRunId !== runId) return;

    this.completedRuns.add(runId);
    if (this.completedRuns.size > 1_024) {
      const oldest = this.completedRuns.values().next().value;
      if (oldest) this.completedRuns.delete(oldest);
    }
    this.runs.delete(runId);
    const status = completionStatus(payload);
    const result = completionText(payload);
    const tokens = completionTokens(payload);
    const event: SubagentLifecycleEvent = {
      id: runId,
      type: metadata.request.type,
      description: metadata.request.description,
      status,
      ...(result ? { result } : {}),
      ...(status === "completed" ? {} : { error: result ?? `Subagent Workflow ${status}` }),
      ...(typeof payload.durationMs === "number" ? { durationMs: payload.durationMs } : {}),
      ...(tokens ? { tokens } : {}),
    };
    this.dispatch(status === "completed" ? this.completedHandlers : this.failedHandlers, event);
  }

  private dispatch(handlers: Set<(event: SubagentLifecycleEvent) => void>, event: SubagentLifecycleEvent): void {
    for (const handler of handlers) {
      try {
        handler(event);
      } catch (error) {
        console.error("[pi-forge-workflow] Subagent lifecycle handler failed", error);
      }
    }
  }

  private rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
    return this.rpcWithRequestId(randomUUID(), method, params);
  }

  private async rpcWithRequestId<T>(requestId: string, method: string, params: Record<string, unknown>): Promise<T> {
    const replyChannel = `${NICOBIALON_RPC_REPLY_PREFIX}${requestId}`;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (typeof unsubscribe === "function") unsubscribe();
        reject(new SubagentInfrastructureError("rpc_timeout", `pi-subagents RPC timeout: ${NICOBIALON_RPC_REQUEST_EVENT} (${method})`));
      }, this.timeoutMs);
      const unsubscribe = this.events.on(replyChannel, (rawReply: unknown) => {
        clearTimeout(timeout);
        if (typeof unsubscribe === "function") unsubscribe();
        const reply = record(rawReply) as RpcReply<T> | undefined;
        if (!reply || reply.version !== NICOBIALON_RPC_PROTOCOL_VERSION || reply.requestId !== requestId || (reply.method !== undefined && reply.method !== method)) {
          reject(method === "spawn"
            ? new SubagentInfrastructureError("lifecycle_lost", "pi-subagents spawn outcome unknown: invalid RPC v1 reply envelope")
            : new Error(`Invalid pi-subagents RPC v1 reply for ${method}`));
          return;
        }
        if (!reply.success) {
          const code = reply.error?.code ?? "execution_failed";
          const message = reply.error?.message ?? `pi-subagents RPC failed: ${method}`;
          reject(infrastructureErrorFromMessage(`${code}: ${message}`));
          return;
        }
        resolve(reply.data as T);
      });
      this.events.emit(NICOBIALON_RPC_REQUEST_EVENT, {
        version: NICOBIALON_RPC_PROTOCOL_VERSION,
        requestId,
        method,
        params,
        source: { extension: "pi-forge-workflow" },
      });
    });
  }
}
