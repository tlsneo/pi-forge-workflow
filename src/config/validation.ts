import { isAbsolute, normalize, sep } from "node:path";
import type { AvailableModel, ForgeConfig, ForgeModelProfile } from "./types.js";
import type { ThinkingLevel } from "../runtime/types.js";

const THINKING_LEVELS: ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh"];

function requireRelativeSafePath(path: string, label: string): void {
  if (!path.trim()) throw new Error(`${label} must not be empty`);
  if (isAbsolute(path)) throw new Error(`${label} must be repository-relative`);
  const normalized = normalize(path);
  if (normalized === ".." || normalized.startsWith(`..${sep}`)) throw new Error(`${label} must remain inside the repository`);
}

function validateProfile(name: string, profile: ForgeModelProfile, availableModels?: AvailableModel[]): void {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`Invalid model profile name: ${name}`);
  if (!profile.model.includes("/")) throw new Error(`${name} model must be exact provider/model`);
  if (!THINKING_LEVELS.includes(profile.thinking)) throw new Error(`${name} has invalid thinking level ${profile.thinking}`);
  if (!Number.isInteger(profile.maxTurns) || profile.maxTurns < 1 || profile.maxTurns > 200) {
    throw new Error(`${name} maxTurns must be an integer from 1 to 200`);
  }
  if (availableModels) {
    const model = availableModels.find((candidate) => candidate.id === profile.model);
    if (!model) throw new Error(`${name} model is unavailable: ${profile.model}`);
    if (!model.supportedThinking.includes(profile.thinking)) {
      throw new Error(`${name} model ${profile.model} does not support ${profile.thinking} thinking`);
    }
  }
}

export function validateForgeConfig(config: ForgeConfig, availableModels?: AvailableModel[]): void {
  if (config.schemaVersion !== 1) throw new Error(`Unsupported Forge config schema: ${config.schemaVersion}`);
  if (!Number.isInteger(config.generation) || config.generation < 1) throw new Error("Config generation must be positive");
  requireRelativeSafePath(config.artifacts.root, "Artifact root");
  requireRelativeSafePath(config.agents.directory, "Agent directory");
  if (!Number.isInteger(config.agents.templateVersion) || config.agents.templateVersion < 1) {
    throw new Error("Agent templateVersion must be positive");
  }
  if (config.instructions) {
    if (!["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"].includes(config.instructions.file)) {
      throw new Error(`Unsupported Pi instruction file: ${config.instructions.file}`);
    }
    if (config.instructions.managedSection !== "forge-workflow") {
      throw new Error("Forge only manages the forge-workflow instruction section");
    }
    if (config.instructions.templateVersion !== undefined && (!Number.isInteger(config.instructions.templateVersion) || config.instructions.templateVersion < 1)) {
      throw new Error("Forge instruction templateVersion must be positive");
    }
  }
  if (config.repositoryContext) {
    const groups = {
      entryPoints: config.repositoryContext.entryPoints,
      architectureDocs: config.repositoryContext.architectureDocs,
      adrDirectories: config.repositoryContext.adrDirectories,
      supplementalInstructions: config.repositoryContext.supplementalInstructions,
    };
    for (const [group, paths] of Object.entries(groups)) {
      if (new Set(paths).size !== paths.length) throw new Error(`Repository context ${group} must not contain duplicates`);
      for (const path of paths) requireRelativeSafePath(path, `Repository context ${group}`);
    }
    if (config.repositoryContext.mode !== "discovered" && config.repositoryContext.entryPoints.length === 0) {
      throw new Error(`${config.repositoryContext.mode} repository context requires at least one entry point`);
    }
  }

  if (config.tracker.publishRequiresConfirmation !== true) {
    throw new Error("External tracker publication must require confirmation");
  }
  if (config.tracker.mode === "github" && !config.tracker.repository?.trim()) {
    throw new Error("GitHub tracker requires repository");
  }
  if (config.tracker.mode === "gitlab" && !config.tracker.project?.trim()) {
    throw new Error("GitLab tracker requires project");
  }

  if (config.workspace.mode === "shared-serial") {
    if (config.workspace.isolationBackend !== "none" || config.workspace.poolSize !== 1) {
      throw new Error("shared-serial requires isolationBackend none and poolSize 1");
    }
  } else {
    if (config.workspace.isolationBackend === "none") throw new Error("isolated-pool requires an isolation backend");
    if (!Number.isInteger(config.workspace.poolSize) || config.workspace.poolSize < 2) {
      throw new Error("isolated-pool requires poolSize of at least 2");
    }
  }

  const profileEntries = Object.entries(config.models.profiles);
  if (profileEntries.length === 0) throw new Error("At least one model profile is required");
  for (const [name, profile] of profileEntries) validateProfile(name, profile, availableModels);
  for (const [role, profileName] of Object.entries(config.models.routing)) {
    if (!config.models.profiles[profileName]) throw new Error(`Role ${role} references unknown profile ${profileName}`);
  }

  for (const [axis, count] of Object.entries(config.review.prd)) {
    if (!Number.isInteger(count) || count < 1 || count > 5) throw new Error(`${axis} must be between 1 and 5`);
  }
  const verifierProfile = config.models.profiles[config.review.blockerVerification.profile];
  if (!verifierProfile) throw new Error(`Blocker verifier references unknown profile ${config.review.blockerVerification.profile}`);
  if (config.models.routing.blockerVerifier !== config.review.blockerVerification.profile) {
    throw new Error("blockerVerifier routing must match review.blockerVerification.profile");
  }
  if (config.review.blockerVerification.requireDifferentModel) {
    const reviewRoles = ["prdCoverageReview", "prdEvidenceReview", "prdArchitectureReview"];
    const conflictingRoles = reviewRoles.filter((role) => {
      const profileName = config.models.routing[role];
      return profileName && config.models.profiles[profileName]?.model === verifierProfile.model;
    });
    if (conflictingRoles.length > 0) throw new Error(`Blocker verifier model must differ from PRD Reviewer models: ${conflictingRoles.join(", ")}`);
  }

  if (config.tournament.enabled) {
    if (!Number.isInteger(config.tournament.candidates) || config.tournament.candidates < 3) {
      throw new Error("Enabled tournament requires at least 3 candidates");
    }
    if (!Number.isInteger(config.tournament.judges) || config.tournament.judges < 2) {
      throw new Error("Enabled tournament requires at least 2 judges");
    }
  }
  for (const profileName of [
    config.tournament.candidateProfile,
    config.tournament.judgeProfile,
    config.tournament.synthesizerProfile,
  ]) {
    if (!config.models.profiles[profileName]) throw new Error(`Tournament references unknown profile ${profileName}`);
  }
  if (config.tournament.blindReview !== true) throw new Error("Option Tournament review must remain blind");

  for (const [name, command] of Object.entries(config.commands)) {
    if (typeof command !== "string" || !command.trim()) throw new Error(`${name} command must not be empty`);
  }
}
