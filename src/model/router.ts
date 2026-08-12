import type { ModelPolicy, ModelProfile } from "../runtime/types.js";

export interface ModelRouteRequest {
  role: string;
  taskProfile?: string;
  issueProfile?: string;
}

export interface ResolvedModelProfile extends ModelProfile {
  profile: string;
  source: "task" | "issue" | "role" | "default";
}

export function resolveModelProfile(policy: ModelPolicy, request: ModelRouteRequest): ResolvedModelProfile {
  const candidates: Array<{ profile: string | undefined; source: ResolvedModelProfile["source"] }> = [
    { profile: request.taskProfile, source: "task" },
    { profile: request.issueProfile, source: "issue" },
    { profile: policy.roles[request.role], source: "role" },
    { profile: policy.defaultProfile, source: "default" },
  ];

  for (const candidate of candidates) {
    if (!candidate.profile) continue;
    const profile = policy.profiles[candidate.profile];
    if (!profile) {
      throw new Error(`Unknown model profile: ${candidate.profile}`);
    }
    if (!profile.model.includes("/")) {
      throw new Error(`Model profile ${candidate.profile} must use exact provider/model id`);
    }
    if (!Number.isInteger(profile.maxTurns) || profile.maxTurns < 1) {
      throw new Error(`Model profile ${candidate.profile} has invalid maxTurns`);
    }
    return { ...profile, profile: candidate.profile, source: candidate.source };
  }

  throw new Error("No model profile could be resolved");
}
