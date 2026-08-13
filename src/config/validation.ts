import { isAbsolute, normalize, sep } from "node:path";
import type { AvailableModel, ForgeConfig, ForgeModelProfile } from "./types.js";

function requireRelativeSafePath(path: string, label: string): void {
  if (!path.trim()) throw new Error(`${label} must not be empty`);
  if (isAbsolute(path)) throw new Error(`${label} must be repository-relative`);
  const normalized = normalize(path);
  if (normalized === ".." || normalized.startsWith(`..${sep}`)) throw new Error(`${label} must remain inside the repository`);
}

function validateProfile(name: string, profile: ForgeModelProfile, availableModels?: AvailableModel[]): void {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`Invalid model profile name: ${name}`);
  if (!profile.model.includes("/")) throw new Error(`${name} model must be exact provider/model`);
  if (typeof profile.thinking !== "string" || !profile.thinking.trim()) throw new Error(`${name} thinking level must not be empty`);
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

export function validateForgeConfigUpdate(config: ForgeConfig, currentConfig: ForgeConfig | undefined, availableModels: AvailableModel[]): string[] {
  validateForgeConfig(config);
  const warnings: string[] = [];
  for (const [name, profile] of Object.entries(config.models.profiles)) {
    const current = currentConfig?.models.profiles[name];
    const capabilityChanged = !current || current.model !== profile.model || current.thinking !== profile.thinking;
    if (capabilityChanged) {
      validateProfile(name, profile, availableModels);
      continue;
    }
    try {
      validateProfile(name, profile, availableModels);
    } catch (error) {
      warnings.push(`Unchanged model profile ${name} has registry drift: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return warnings;
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
  if (config.tracker.mode !== "local") throw new Error("The current Forge release supports only Local Issue artifacts");
  if (config.workspace.mode !== "shared-serial" || config.workspace.isolationBackend !== "none" || config.workspace.poolSize !== 1) {
    throw new Error("The current Forge release requires shared-serial with isolationBackend none and poolSize 1");
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

  for (const [name, command] of Object.entries(config.commands)) {
    if (typeof command !== "string" || !command.trim()) throw new Error(`${name} command must not be empty`);
  }
}
