import { randomUUID } from "node:crypto";
import type { ThinkingLevel } from "../runtime/types.js";

export interface EventBus {
  on(event: string, handler: (payload: any) => void): () => void;
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

function exactModelLabel(model: unknown): string | undefined {
  if (typeof model === "string") return model;
  if (!model || typeof model !== "object") return undefined;
  const candidate = model as { provider?: unknown; id?: unknown; name?: unknown };
  if (typeof candidate.provider === "string" && typeof candidate.id === "string") return `${candidate.provider}/${candidate.id}`;
  if (typeof candidate.id === "string") return candidate.id;
  if (typeof candidate.name === "string") return candidate.name;
  return undefined;
}

export class PiSubagentsAdapter {
  private readonly events: EventBus;
  private readonly timeoutMs: number;

  constructor(events: EventBus, timeoutMs = 5_000) {
    this.events = events;
    this.timeoutMs = timeoutMs;
  }

  async ping(): Promise<number> {
    const reply = await this.rpc<{ version: number }>("subagents:rpc:ping", {});
    return reply.version;
  }

  async spawn(request: SpawnRequest): Promise<string> {
    const modelName = exactModelLabel(request.model);
    const reply = await this.rpc<{ id: string }>("subagents:rpc:spawn", {
      type: request.type,
      prompt: request.prompt,
      options: {
        description: request.description,
        model: request.model,
        thinkingLevel: request.thinkingLevel,
        maxTurns: request.maxTurns,
        isBackground: true,
        cwd: request.cwd,
        invocation: {
          ...(modelName ? { modelName } : {}),
          thinking: request.thinkingLevel,
          maxTurns: request.maxTurns,
          runInBackground: true,
        },
      },
    });
    return reply.id;
  }

  async stop(agentId: string): Promise<void> {
    await this.rpc<void>("subagents:rpc:stop", { agentId });
  }

  onStarted(handler: (event: SubagentLifecycleEvent) => void): () => void {
    return this.events.on("subagents:started", handler);
  }

  onCompleted(handler: (event: SubagentLifecycleEvent) => void): () => void {
    return this.events.on("subagents:completed", handler);
  }

  onFailed(handler: (event: SubagentLifecycleEvent) => void): () => void {
    return this.events.on("subagents:failed", handler);
  }

  onCompacted(handler: (event: SubagentLifecycleEvent & { compactionCount: number }) => void): () => void {
    return this.events.on("subagents:compacted", handler);
  }

  private async rpc<T>(channel: string, payload: Record<string, unknown>): Promise<T> {
    const requestId = randomUUID();
    const replyChannel = `${channel}:reply:${requestId}`;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error(`pi-subagents RPC timeout: ${channel}`));
      }, this.timeoutMs);
      const unsubscribe = this.events.on(replyChannel, (reply: { success: boolean; data?: T; error?: string }) => {
        clearTimeout(timeout);
        unsubscribe();
        if (!reply.success) {
          reject(new Error(reply.error ?? `pi-subagents RPC failed: ${channel}`));
          return;
        }
        resolve(reply.data as T);
      });
      this.events.emit(channel, { requestId, ...payload });
    });
  }
}
