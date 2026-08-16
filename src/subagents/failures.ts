export type SubagentFailureClassification = "infrastructure" | "semantic";
export type SubagentInfrastructureFailureKind =
  | "rpc_timeout"
  | "service_unavailable"
  | "transport"
  | "lifecycle_lost";

export interface SubagentFailureRecord {
  classification: SubagentFailureClassification;
  kind?: SubagentInfrastructureFailureKind;
  message: string;
  source: "spawn" | "lifecycle";
  recordedAt: string;
}

export interface SubagentRetryLedger {
  attempt: number;
  maxAttempts: number;
  infrastructureAttempts?: number;
  maxInfrastructureAttempts?: number;
  lastFailure?: SubagentFailureRecord;
}

const SERVICE_UNAVAILABLE = /(?:^|\b)(?:502|503|504)(?:\b|$)|service unavailable|temporarily unavailable|overloaded|capacity/i;
const TRANSPORT = /econnreset|econnrefused|enotfound|epipe|socket hang up|network error|fetch failed|connection (?:closed|lost|reset)/i;
const LIFECYCLE_LOST = /agent (?:lifecycle|process) (?:lost|missing)|agent not found|unknown agent|lifecycle event (?:lost|missing)|spawn outcome unknown|lifecycle missing during recovery before/i;
const RPC_TIMEOUT = /pi-subagents rpc timeout|rpc timed out|rpc timeout/i;

export class SubagentInfrastructureError extends Error {
  readonly kind: SubagentInfrastructureFailureKind;

  constructor(kind: SubagentInfrastructureFailureKind, message: string) {
    super(message);
    this.name = "SubagentInfrastructureError";
    this.kind = kind;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function classifySubagentFailure(
  error: unknown,
  source: SubagentFailureRecord["source"],
): SubagentFailureRecord {
  const message = messageOf(error);
  const explicitKind = error instanceof SubagentInfrastructureError ? error.kind : undefined;
  const kind = explicitKind
    ?? (RPC_TIMEOUT.test(message) ? "rpc_timeout"
      : SERVICE_UNAVAILABLE.test(message) ? "service_unavailable"
        : TRANSPORT.test(message) ? "transport"
          : LIFECYCLE_LOST.test(message) ? "lifecycle_lost"
            : undefined);
  return {
    classification: kind ? "infrastructure" : "semantic",
    ...(kind ? { kind } : {}),
    message,
    source,
    recordedAt: new Date().toISOString(),
  };
}

export function isAmbiguousSpawnOutcome(failure: SubagentFailureRecord): boolean {
  return failure.source === "spawn" && (
    (failure.kind === "rpc_timeout" && /subagents:rpc:spawn/i.test(failure.message))
    || /spawn outcome unknown|lifecycle missing during recovery before/i.test(failure.message)
  );
}

export function subagentFailureEvent(failure: SubagentFailureRecord, semanticEvent: string): string {
  if (failure.classification !== "infrastructure") return semanticEvent;
  return isAmbiguousSpawnOutcome(failure) ? "infrastructure_spawn_outcome_unknown" : "infrastructure_retry_scheduled";
}

export function recordSubagentFailure(
  ledger: SubagentRetryLedger,
  failure: SubagentFailureRecord,
): { retry: boolean; exhausted: boolean; semanticAttempts: number; infrastructureAttempts: number; ambiguousSpawnOutcome: boolean } {
  ledger.lastFailure = failure;
  const previousInfrastructureAttempts = ledger.infrastructureAttempts ?? 0;
  if (failure.classification === "infrastructure") ledger.infrastructureAttempts = previousInfrastructureAttempts + 1;
  const infrastructureAttempts = ledger.infrastructureAttempts ?? 0;
  const semanticAttempts = Math.max(0, ledger.attempt - infrastructureAttempts);
  const ambiguousSpawnOutcome = isAmbiguousSpawnOutcome(failure);
  const retry = failure.classification === "infrastructure"
    ? !ambiguousSpawnOutcome && infrastructureAttempts <= (ledger.maxInfrastructureAttempts ?? 2)
    : semanticAttempts < ledger.maxAttempts;
  return { retry, exhausted: !retry, semanticAttempts, infrastructureAttempts, ambiguousSpawnOutcome };
}

export function infrastructureErrorFromMessage(message: string): Error {
  const failure = classifySubagentFailure(message, "spawn");
  return failure.classification === "infrastructure"
    ? new SubagentInfrastructureError(failure.kind!, message)
    : new Error(message);
}
