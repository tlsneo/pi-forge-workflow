export interface IssueBehaviorSlice {
  happyPath: string[];
  errorPaths: string[];
  edgeCases: string[];
}

export interface IssueDraft {
  id: string;
  deliveryBoundaryId: string;
  title: string;
  goal: string;
  deliveryOutcome: string;
  scope: string[];
  nonGoals: string[];
  acceptanceIds: string[];
  behavior: IssueBehaviorSlice;
  decisionIds: string[];
  impactEvidenceIds: string[];
  testSeamNames: string[];
  verification: string[];
  dependencies: string[];
}

export interface IssueArtifact extends IssueDraft {
  schemaVersion: 1;
  source: {
    workItemId: string;
    prdGeneration: number;
    prdHash: string;
  };
  artifactHash: string;
}

export interface IssueManifestEntry {
  id: string;
  title: string;
  artifactPath: string;
  markdownPath: string;
  artifactHash: string;
  dependencies: string[];
  acceptanceIds: string[];
  tracker: {
    mode: "local";
  };
}

export interface IssuesGeneration {
  schemaVersion: 1;
  generation: number;
  source: {
    workItemId: string;
    prdGeneration: number;
    prdHash: string;
    frozenReceiptHash: string;
  };
  contentHash: string;
  issues: IssueArtifact[];
  acceptanceTraceability: Record<string, string[]>;
  createdAt: string;
}

export interface IssuesManifest {
  schemaVersion: 1;
  generation: number;
  source: IssuesGeneration["source"];
  contentHash: string;
  issues: IssueManifestEntry[];
  acceptanceTraceability: Record<string, string[]>;
  createdAt: string;
}
