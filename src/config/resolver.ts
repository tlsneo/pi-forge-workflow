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

export async function loadForgeConfig(repositoryRoot: string): Promise<ForgeConfig> {
  const path = join(repositoryRoot, ".pi", "forge.json");
  let config: ForgeConfig;
  try {
    config = JSON.parse(await readFile(path, "utf8")) as ForgeConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Forge is not configured for ${repositoryRoot}; run /skill:forge-init`);
    }
    throw error;
  }
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
