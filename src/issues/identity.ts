import type { WorkItemManifest } from "../work-item/types.js";
import type { IssueArtifact } from "./types.js";

export type LegacyIssueArtifact = Omit<IssueArtifact, "source"> & {
  source: Omit<IssueArtifact["source"], "controlRoot" | "repositoryRoot" | "repositoryRevision"> & {
    controlRoot?: string;
    repositoryRoot?: string;
    repositoryRevision?: string;
  };
};

export function normalizeIssueArtifactIdentity(issue: LegacyIssueArtifact, manifest: WorkItemManifest): IssueArtifact {
  return {
    ...issue,
    source: {
      ...issue.source,
      controlRoot: issue.source.controlRoot ?? manifest.controlRoot,
      repositoryRoot: issue.source.repositoryRoot ?? manifest.repositoryRoot,
      repositoryRevision: issue.source.repositoryRevision ?? manifest.repositoryRevision,
    },
  };
}
