import type { IssuesGeneration } from "../issues/types.js";
import type { ThinkingLevel } from "../runtime/types.js";

export type WorkItemStatus =
  | "discovery"
  | "drafting"
  | "reviewing"
  | "awaiting_approval"
  | "frozen"
  | "blocked"
  | "needs_external_input";

export type DecisionStatus = "open" | "answered" | "external";
export type ReviewAxis = "coverage" | "evidence" | "architecture";
export type ReviewVerdict = "passed" | "blocked";
export type DiagramKind = "flow" | "sequence" | "state" | "er";

export interface DecisionNode {
  id: string;
  question: string;
  dependsOn: string[];
  status: DecisionStatus;
  recommendedAnswer?: string;
  answer?: string;
  answerSource?: "user" | "repository" | "external";
}

export interface CodeEvidence {
  id: string;
  path: string;
  symbol: string;
  claim: string;
  repositoryRevision: string;
}

export interface UserStory {
  id: string;
  actor: string;
  capability: string;
  benefit: string;
}

export interface AcceptanceCriterion {
  id: string;
  statement: string;
  verification: string[];
}

export interface DesignDecision {
  id: string;
  decision: string;
  rationale: string;
  evidenceIds: string[];
  alternatives?: string[];
}

export interface TestSeam {
  name: string;
  level: "unit" | "integration" | "system" | "manual";
  evidenceIds: string[];
  verification: string;
}

export interface Risk {
  risk: string;
  mitigation: string;
}

export interface Diagram {
  kind: DiagramKind;
  title: string;
  rationale: string;
  mermaid: string;
}

export interface DeliveryBoundary {
  id: string;
  title: string;
  outcome: string;
  goal: string;
  scope: string[];
  acceptanceIds: string[];
  behavior: {
    happyPath: string[];
    errorPaths: string[];
    edgeCases: string[];
  };
  decisionIds: string[];
  impactEvidenceIds: string[];
  testSeamNames: string[];
  nonGoals: string[];
  verification: string[];
  dependencies: string[];
  independentlyDeliverable: boolean;
  rationale: string;
}

export interface ForgePrd {
  title: string;
  problem: string;
  solution: string;
  goals: string[];
  nonGoals: string[];
  actors: string[];
  userStories: UserStory[];
  acceptance: AcceptanceCriterion[];
  behavior: {
    happyPath: string[];
    errorPaths: string[];
    edgeCases: string[];
  };
  decisions: DesignDecision[];
  impactEvidence: CodeEvidence[];
  testSeams: TestSeam[];
  risks: Risk[];
  deliveryBoundaries: DeliveryBoundary[];
  migration?: string;
  rollback?: string;
  diagrams: Diagram[];
  openQuestions: string[];
}

export interface PrdGeneration {
  schemaVersion: 1;
  workItemId: string;
  generation: number;
  contentHash: string;
  reviewSurfaceHashes: Record<ReviewAxis, string>;
  submittedAt: string;
  prd: ForgePrd;
}

export interface PrdFinding {
  id?: string;
  severity: "blocker" | "warning" | "note";
  message: string;
  evidence: string[];
  violatedRule?: string;
  verification?: string;
  suggestedResolution?: string;
}

export interface PrdReview {
  axis: ReviewAxis;
  verdict: ReviewVerdict;
  surfaceHash: string;
  reviewerId: string;
  findings: PrdFinding[];
  submittedAt: string;
  jobId?: string;
  bindingId?: string;
  carriedFrom?: {
    generation: number;
    originalSurfaceHash: string;
  };
}

export type PrdReviewJobStatus =
  | "pending"
  | "starting"
  | "running"
  | "result_submitted"
  | "completed"
  | "interrupted"
  | "retry_ready"
  | "failed";

export interface PrdReviewJobPlan {
  id: string;
  axis: ReviewAxis;
  ordinal: number;
  requiredCount: number;
  prdGeneration: number;
  surfaceHash: string;
  profile: string;
  model: string;
  thinking: ThinkingLevel;
  maxTurns: number;
  maxAttempts: number;
  configGeneration: number;
  configHash: string;
}

export interface PrdReviewBinding {
  id: string;
  jobId: string;
  workItemId: string;
  prdGeneration: number;
  axis: ReviewAxis;
  surfaceHash: string;
  attempt: number;
  spawnRequestId: string;
  agentId?: string;
  profile: string;
  model: string;
  thinking: ThinkingLevel;
  maxTurns: number;
  startedStateGeneration: number;
  createdAt: string;
}

export interface PrdReviewJob extends PrdReviewJobPlan {
  status: PrdReviewJobStatus;
  attempt: number;
  binding?: PrdReviewBinding;
  result?: PrdReview;
  error?: string;
}

export type BlockerVerificationStatus = "confirmed" | "rejected" | "needs_more_evidence";

export interface PrdBlockerFinding {
  axis: ReviewAxis;
  finding: PrdFinding & { id: string };
}

export interface PrdBlockerVerificationResult {
  findingId: string;
  status: BlockerVerificationStatus;
  evidence: string[];
  rationale: string;
  missingEvidence?: string[];
}

export interface PrdBlockerVerificationBinding {
  id: string;
  jobId: string;
  workItemId: string;
  prdGeneration: number;
  findingHash: string;
  attempt: number;
  spawnRequestId: string;
  agentId?: string;
  profile: string;
  model: string;
  thinking: ThinkingLevel;
  maxTurns: number;
  startedStateGeneration: number;
  createdAt: string;
}

export interface PrdBlockerVerificationJob {
  id: string;
  prdGeneration: number;
  findingHash: string;
  findings: PrdBlockerFinding[];
  status: PrdReviewJobStatus;
  attempt: number;
  maxAttempts: number;
  profile: string;
  model: string;
  thinking: ThinkingLevel;
  maxTurns: number;
  configGeneration: number;
  configHash: string;
  binding?: PrdBlockerVerificationBinding;
  results?: PrdBlockerVerificationResult[];
  error?: string;
}

export interface PrdAmendment {
  id: string;
  fromGeneration: number;
  toGeneration: number;
  fromContentHash: string;
  toContentHash: string;
  reason: string;
  authorization: {
    actor: string;
    evidence: string;
  };
  carriedReviewAxes: ReviewAxis[];
  invalidatedReviewAxes: ReviewAxis[];
  invalidatedReviewerIds: string[];
  createdAt: string;
}

export interface PrdApproval {
  generation: number;
  contentHash: string;
  approvedBy: string;
  evidence: string;
  approvedAt: string;
}

export interface FrozenPrdReceipt {
  workItemId: string;
  generation: number;
  contentHash: string;
  approval: PrdApproval;
  reviews: Record<ReviewAxis, PrdReview>;
  blockerVerification?: {
    jobId: string;
    findingHash: string;
    results: PrdBlockerVerificationResult[];
  };
  frozenAt: string;
}

export interface WorkItemSupersession {
  predecessorWorkItemId: string;
  predecessorRoot: string;
  predecessorPrdGeneration: number;
  predecessorPrdHash: string;
  reason: string;
  authorizedBy: string;
  authorizationEvidence: string;
  createdAt: string;
}

export interface WorkItemManifest {
  schemaVersion: 1;
  workItemId: string;
  title: string;
  repositoryRoot: string;
  repositoryRevision: string;
  supersedes?: WorkItemSupersession;
  createdAt: string;
}

export interface WorkItemState {
  schemaVersion: 1;
  workItemId: string;
  status: WorkItemStatus;
  generation: number;
  eventSequence: number;
  activePrdGeneration: number;
  decisions: DecisionNode[];
  evidence: CodeEvidence[];
  discoverySummary?: string;
  currentPrd?: PrdGeneration;
  reviews: Partial<Record<ReviewAxis, PrdReview>>;
  reviewJobs?: Record<string, PrdReviewJob>;
  individualReviews?: Record<string, PrdReview>;
  blockerVerificationJob?: PrdBlockerVerificationJob;
  issues?: IssuesGeneration;
  approval?: PrdApproval;
  lastAmendment?: PrdAmendment;
  frozenReceipt?: FrozenPrdReceipt;
  updatedAt: string;
}

export interface WorkItemEvent {
  id: string;
  sequence: number;
  type: string;
  timestamp: string;
  workItemId: string;
  details?: Record<string, unknown>;
  snapshot: WorkItemState;
}

export interface DiscoveryCheckpoint {
  decisions: DecisionNode[];
  evidence: CodeEvidence[];
  summary: string;
  status?: Extract<WorkItemStatus, "discovery" | "drafting" | "blocked" | "needs_external_input">;
}
