export const TASK_STATUSES = [
  "pending",
  "ready",
  "starting",
  "running",
  "awaiting_verification",
  "verifying",
  "completed",
  "interrupted",
  "retry_ready",
  "blocked",
  "failed",
  "cancelled",
  "needs_user",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type AgentStatus = "none" | "queued" | "running" | "completed" | "failed" | "stopped" | "aborted" | "unknown";
export type HandoffStatus = "none" | "valid" | "invalid";
export type VerificationStatus = "not_run" | "running" | "passed" | "failed";
export type GitStatus = "not_started" | "committed" | "receipted" | "merged";
export type IssueStatus = "planned" | "executing" | "integrating" | "auditing" | "completed" | "blocked" | "needs_user" | "failed";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface TaskContract {
  id: string;
  version: number;
  title: string;
  sliceId: string;
  goal?: string;
  editPoint?: { path: string; symbol: string };
  reads?: Array<{ path: string; symbol: string; reason: string }>;
  implementationBlueprint?: string[];
  outOfScope?: string[];
  dependencies: string[];
  conflicts: string[];
  writes: string[];
  produces: string[];
  consumes: string[];
  acceptance: string[];
  verification: Array<{ command: string; timeoutMs: number }>;
  modelProfile?: string;
  contractHash: string;
}

export interface TaskDag {
  generation: number;
  tasks: TaskContract[];
}

export interface ModelProfile {
  model: string;
  thinking: ThinkingLevel;
  maxTurns: number;
}

export interface ModelPolicy {
  defaultProfile: string;
  profiles: Record<string, ModelProfile>;
  roles: Record<string, string>;
}

export interface RuntimeModelPolicyGeneration {
  schemaVersion: 1;
  generation: number;
  configGeneration: number;
  configHash: string;
  policyHash: string;
  policy: ModelPolicy;
  reason: string;
  createdAt: string;
}

export interface RuntimeModelPolicyPointer {
  schemaVersion: 1;
  generation: number;
  policyHash: string;
  generationPath: string;
  updatedAt: string;
}

export interface RuntimeManifest {
  schemaVersion: 1;
  workItemId: string;
  issueId: string;
  issueHash: string;
  dagHash: string;
  workspaceRoot: string;
  workspaceMode: "shared-serial" | "isolated-pool";
  issueModelProfile?: string;
  auditModelProfile?: string;
  modelPolicy: ModelPolicy;
  modelPolicySource?: { configGeneration: number; configHash: string };
  createdAt: string;
}

export interface TaskBinding {
  id: string;
  workItemId: string;
  issueId: string;
  taskId: string;
  taskVersion: number;
  taskContractPath: string;
  attempt: number;
  spawnRequestId: string;
  agentId?: string;
  workspace: string;
  baselineCommit?: string;
  contractHash: string;
  model: string;
  thinking: ThinkingLevel;
  maxTurns: number;
  modelPolicyGeneration?: number;
  startedGeneration: number;
}

export interface TaskCheckpoint {
  generation: number;
  currentStep: string;
  nextAction: string;
  changedFiles: string[];
  verificationNotes: string[];
  updatedAt: string;
}

export interface TaskHandoff {
  changedFiles: string[];
  verification: Array<{ command: string; exitCode: number; keyOutput?: string }>;
  produced: string[];
  submittedAt: string;
}

export interface TaskReceipt {
  schemaVersion: 1;
  workItemId: string;
  issueId: string;
  taskId: string;
  taskVersion: number;
  taskContractPath: string;
  contractHash: string;
  baselineCommit?: string;
  dagGeneration: number;
  commit: string;
  changedFiles: string[];
  produced: string[];
  verification: Array<{ command: string; exitCode: number; keyOutput?: string }>;
  completedAt: string;
}

export interface TaskState {
  id: string;
  status: TaskStatus;
  attempt: number;
  attemptsByModelPolicy?: Record<string, number>;
  binding?: TaskBinding;
  agentStatus: AgentStatus;
  handoffStatus: HandoffStatus;
  handoff?: TaskHandoff;
  verificationStatus: VerificationStatus;
  authoritativeVerification?: Array<{ command: string; exitCode: number; keyOutput?: string }>;
  verificationError?: string;
  gitStatus: GitStatus;
  checkpoint?: TaskCheckpoint;
  receipt?: TaskReceipt;
  blocker?: string;
}

export interface SliceGateState {
  id: string;
  status: "pending" | "running" | "passed" | "failed";
  commands: Array<{ command: string; timeoutMs: number; proves: string }>;
  verification?: Array<{ command: string; exitCode: number; keyOutput?: string }>;
  error?: string;
  completedAt?: string;
}

export type IssueAuditAxis = "standards" | "spec_integration" | "architecture_minimality";
export type IssueAuditVerdict = "passed" | "blocked";
export type IssueAuditJobStatus = "pending" | "starting" | "running" | "result_submitted" | "completed" | "interrupted" | "retry_ready" | "failed";

export interface IssueAuditFinding {
  id: string;
  severity: "blocker" | "warning" | "note";
  message: string;
  evidence: string[];
  violatedRule: string;
  verification: string;
  suggestedResolution?: string;
}

export interface IssueAuditReview {
  axis: IssueAuditAxis;
  verdict: IssueAuditVerdict;
  bindingId: string;
  findings: IssueAuditFinding[];
  submittedAt: string;
}

export interface IssueAuditBinding {
  id: string;
  axis: IssueAuditAxis;
  attempt: number;
  spawnRequestId: string;
  agentId?: string;
  model: string;
  thinking: ThinkingLevel;
  maxTurns: number;
  startedGeneration: number;
  createdAt: string;
}

export type AuditBlockerVerificationStatus = "confirmed" | "rejected" | "needs_more_evidence";
export type AuditBlockerVerifierJobStatus = "pending" | "starting" | "running" | "result_submitted" | "completed" | "interrupted" | "retry_ready" | "failed";

export interface AuditBlockerFindingReference {
  findingId: string;
  axis: IssueAuditAxis;
  auditBindingId: string;
  finding: IssueAuditFinding;
}

export interface AuditBlockerVerificationResult {
  findingId: string;
  status: AuditBlockerVerificationStatus;
  evidence: string[];
  rationale: string;
  missingEvidence: string[];
}

export interface AuditBlockerVerifierBinding {
  id: string;
  attempt: number;
  spawnRequestId: string;
  agentId?: string;
  findingHash: string;
  model: string;
  thinking: ThinkingLevel;
  maxTurns: number;
  startedGeneration: number;
  createdAt: string;
}

export interface AuditBlockerVerifierReview {
  bindingId: string;
  findingHash: string;
  results: AuditBlockerVerificationResult[];
  submittedAt: string;
}

export interface AuditBlockerVerifierJob {
  id: string;
  status: AuditBlockerVerifierJobStatus;
  attempt: number;
  maxAttempts: number;
  findingHash: string;
  findings: AuditBlockerFindingReference[];
  model: string;
  thinking: ThinkingLevel;
  maxTurns: number;
  configHash: string;
  binding?: AuditBlockerVerifierBinding;
  result?: AuditBlockerVerifierReview;
  error?: string;
}

export interface RemediationPlannerBinding {
  id: string;
  attempt: number;
  spawnRequestId: string;
  agentId?: string;
  findingHash: string;
  model: string;
  thinking: ThinkingLevel;
  maxTurns: number;
  startedGeneration: number;
  createdAt: string;
}

export interface RemediationPlannerJob {
  status: "pending" | "starting" | "running" | "proposal_submitted" | "completed" | "interrupted" | "retry_ready" | "failed";
  attempt: number;
  maxAttempts: number;
  model: string;
  thinking: ThinkingLevel;
  maxTurns: number;
  configHash: string;
  binding?: RemediationPlannerBinding;
  error?: string;
}

export type HumanDecisionKind =
  | "missing_evidence"
  | "ambiguous_remediation"
  | "frozen_contract_violation"
  | "architecture_change"
  | "public_interface_change"
  | "scope_change"
  | "repository_rule_conflict"
  | "unsafe_repository_operation";

export type HumanDecisionResumeAction = "rerun_verifier" | "resume_planner" | "require_prd_amendment" | "abort_issue";

export interface HumanDecisionOption {
  id: string;
  label: string;
  description: string;
  consequences: string[];
  resumeAction: HumanDecisionResumeAction;
}

export interface HumanDecisionAnswer {
  selectedOptionId?: string;
  decision: string;
  rationale: string;
  evidence: string[];
  answeredBy: string;
  authorizationEvidence: string;
  answeredAt: string;
}

export interface HumanDecisionRequest {
  schemaVersion: 1;
  id: string;
  kind: HumanDecisionKind;
  status: "open" | "answered" | "cancelled";
  source: "blocker_verifier" | "remediation_planner" | "remediation_preflight" | "coordinator";
  sourceBindingId?: string;
  findingHash: string;
  runtimeGeneration: number;
  question: string;
  reason: string;
  evidence: string[];
  options: HumanDecisionOption[];
  recommendedOptionId?: string;
  resumeAction: HumanDecisionResumeAction;
  answer?: HumanDecisionAnswer;
  requestHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface RemediationPlan {
  id: string;
  source: "audit" | "slice_gate";
  sourceAuditGeneration?: number;
  sourceSliceId?: string;
  findingHash: string;
  confirmedFindingIds: string[];
  status: "awaiting_verification" | "awaiting_proposal" | "preflight" | "ready" | "applied" | "needs_user";
  taskIds?: string[];
  dagGeneration?: number;
  plannerJob?: RemediationPlannerJob;
  createdAt: string;
  updatedAt: string;
}

export interface IssueAuditJob {
  id: string;
  axis: IssueAuditAxis;
  status: IssueAuditJobStatus;
  attempt: number;
  maxAttempts: number;
  model: string;
  thinking: ThinkingLevel;
  maxTurns: number;
  configHash: string;
  binding?: IssueAuditBinding;
  result?: IssueAuditReview;
  error?: string;
}

export interface IssueRuntimeState {
  schemaVersion: 1;
  issueId: string;
  issueStatus: IssueStatus;
  generation: number;
  eventSequence: number;
  dagGeneration: number;
  modelPolicyGeneration?: number;
  coordinatorLease?: { owner: string; acquiredAt: string };
  tasks: Record<string, TaskState>;
  sliceGates?: Record<string, SliceGateState>;
  auditGeneration?: number;
  auditJobs?: Record<IssueAuditAxis, IssueAuditJob>;
  audits?: Partial<Record<IssueAuditAxis, IssueAuditReview>>;
  auditBlockerVerifierJob?: AuditBlockerVerifierJob;
  remediationPlan?: RemediationPlan;
  humanDecision?: HumanDecisionRequest;
  updatedAt: string;
}

export interface RuntimeEvent {
  id: string;
  sequence: number;
  type: string;
  timestamp: string;
  issueId: string;
  taskId?: string;
  details?: Record<string, unknown>;
  snapshot: IssueRuntimeState;
}

export interface DagAmendment {
  id: string;
  reason: string;
  createdAt: string;
  approvedBy: "runtime-policy" | "user";
  sourceFindingHash?: string;
  sourcePreflightResultHash?: string;
  tasks: TaskContract[];
  rerunSliceIds: string[];
}
