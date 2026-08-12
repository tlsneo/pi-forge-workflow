import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { stableHash } from "../runtime/hash.js";
import type { ModelProfile } from "../runtime/types.js";
import type { ForgeConfig } from "./types.js";
import { validateForgeConfig } from "./validation.js";

export interface ResolvedForgeProfile extends ModelProfile {
  profile: string;
  role: string;
  configGeneration: number;
  configHash: string;
}

export async function loadForgeConfig(controlRoot: string): Promise<ForgeConfig> {
  const path = join(controlRoot, ".pi", "forge.json");
  let raw: ForgeConfig & { tournament?: unknown };
  try {
    raw = JSON.parse(await readFile(path, "utf8")) as ForgeConfig & { tournament?: unknown };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Forge is not configured for ${controlRoot}; run /skill:forge-init`);
    }
    throw error;
  }
  const routing = { ...raw.models.routing };
  if (!routing.taskPreflight && routing.taskAudit) routing.taskPreflight = routing.taskAudit;
  for (const deadRoute of ["prdResearch", "optionCandidate", "optionJudge", "optionSynthesizer", "taskAudit"]) delete routing[deadRoute];
  const { tournament: _legacyTournament, ...base } = raw;
  const config: ForgeConfig = { ...base, models: { ...base.models, routing } };
  validateForgeConfig(config);
  return config;
}

export function resolveForgeProfile(config: ForgeConfig, role: string): ResolvedForgeProfile {
  const profileName = config.models.routing[role];
  if (!profileName) throw new Error(`Forge role ${role} has no configured model route`);
  const profile = config.models.profiles[profileName];
  if (!profile) throw new Error(`Forge role ${role} references missing profile ${profileName}`);
  return {
    ...profile,
    profile: profileName,
    role,
    configGeneration: config.generation,
    configHash: stableHash(config),
  };
}
