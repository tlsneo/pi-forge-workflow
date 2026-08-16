export type ProportionalityAudience = "planning" | "implementation" | "review";

const POLICY_BY_AUDIENCE: Record<ProportionalityAudience, readonly string[]> = {
  planning: [
    "Propose only guards, fallbacks, compatibility paths, abstractions, dependencies, artifacts, versions, checks, and delivery work traceable to frozen requirements, documented repository rules, or a failure reachable through supported use.",
    "Require each proposed check, review, or artifact to settle a live uncertainty or verify a frozen obligation, with a failure that changes the next action; theoretical constructibility and optional confidence are not scope.",
    "Choose the smallest sufficient design at the existing owning Module and Seam, and stop planning when the requested outcome, rollback, and authoritative verification are complete.",
  ],
  implementation: [
    "Implement only guards, fallbacks, compatibility paths, abstractions, dependencies, checks, and files traceable to frozen Acceptance, approved Decisions, repository rules, or a reachable supported-use failure.",
    "Use the smallest sufficient patch at the existing owning Module and Seam; optional confidence, future flexibility, and theoretically constructible inputs stay outside the Task.",
    "Run the frozen verification and stop when the promised artifact and required evidence are complete; do not add extra checks against settled evidence or unchanged code.",
  ],
  review: [
    "Report every real defect, including rare-looking failures reachable through supported use; this policy bounds proposed work, not discovery.",
    "A Blocker must identify an exact frozen-contract or documented hard-rule violation, a reachable failure, verification that settles a live uncertainty and changes the next action, and the smallest sufficient resolution.",
    "Optional confidence, future flexibility, personal preference, and duplicate review of settled evidence are not Blockers. Passing with no findings is valid.",
  ],
};

const REQUIRED_WORK = "Explicitly required security, migration, compatibility, verification, review, and mechanical integrity work remains required and is not over-defense.";

export function proportionalityPolicyLines(audience: ProportionalityAudience, prefix = "- "): string[] {
  return [...POLICY_BY_AUDIENCE[audience], REQUIRED_WORK].map((rule) => `${prefix}${rule}`);
}
