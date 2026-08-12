import type { ThinkingLevel } from "../runtime/types.js";

export type WorkspaceMode = "shared-serial";
export type TrackerMode = "local";
export type AuditPreset = "fast" | "standard" | "high-assurance";
export type ForgeInstructionFile = "AGENTS.override.md" | "AGENTS.md" | "AGENTS.MD" | "CLAUDE.md" | "CLAUDE.MD";

export interface RepositoryContextConfig {
  mode: "discovered" | "single-context" | "context-map";
  entryPoints: string[];
  architectureDocs: string[];
  adrDirectories: string[];
  supplementalInstructions: string[];
}

export interface ForgeModelProfile {
  model: string;
  thinking: ThinkingLevel;
  maxTurns: number;
}

export interface ForgeConfig {
  schemaVersion: 1;
  generation: number;
  artifacts: {
    root: string;
    gitPolicy: "ignore" | "track";
  };
  tracker: {
    mode: TrackerMode;
    publishRequiresConfirmation: true;
  };
  workspace: {
    mode: WorkspaceMode;
    isolationBackend: "none";
    poolSize: 1;
  };
  models: {
    profiles: Record<string, ForgeModelProfile>;
    routing: Record<string, string>;
  };
  review: {
    preset: AuditPreset;
    prd: {
      coverageReviewers: number;
      evidenceReviewers: number;
      architectureReviewers: number;
    };
    blockerVerification: {
      profile: string;
      requireDifferentModel: boolean;
    };
  };
  commands: {
    typecheck?: string;
    test?: string;
    lint?: string;
    build?: string;
  };
  agents: {
    directory: string;
    templateVersion: number;
  };
  instructions?: {
    file: ForgeInstructionFile;
    managedSection: "forge-workflow";
    templateVersion?: number;
  };
  repositoryContext?: RepositoryContextConfig;
}

export interface AvailableModel {
  id: string;
  name: string;
  reasoning: boolean;
  supportedThinking: ThinkingLevel[];
}

export interface RepositoryScan {
  repositoryRoot: string;
  repositoryRevision: string;
  remotes: Array<{ name: string; url: string }>;
  inferredTracker: TrackerMode;
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | "unknown";
  monorepo: boolean;
  instructionFile: ForgeInstructionFile;
  existingInstructionFiles: ForgeInstructionFile[];
  shadowedInstructionFiles: ForgeInstructionFile[];
  instructionFileRequiresConfirmation: boolean;
  discoveredRepositoryContext: RepositoryContextConfig;
  existingAgentDirectories: string[];
  existingArtifactDirectories: string[];
  scripts: Record<string, string>;
  trackerCli: {
    gh: { installed: boolean; authenticated: boolean };
    glab: { installed: boolean; authenticated: boolean };
  };
  subagents: {
    reachable: boolean;
    protocolVersion?: number;
  };
  availableModels: AvailableModel[];
  recommendedConfig: ForgeConfig;
}

export interface ConfigFileChange {
  path: string;
  action: "create" | "update" | "unchanged" | "conflict";
  reason: string;
  currentHash?: string;
  nextHash: string;
}

export interface ForgeInitPreview {
  repositoryRoot: string;
  configPath: string;
  previewHash: string;
  config: ForgeConfig;
  changes: ConfigFileChange[];
  warnings: string[];
}

export interface ForgeInitReceipt {
  schemaVersion: 1;
  generation: number;
  configHash: string;
  previewHash: string;
  changedFiles: string[];
  appliedAt: string;
}
