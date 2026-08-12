export const MINIMAL_IMPLEMENTATION_POLICY = [
  "Reuse existing Symbols, Helpers, types, Modules, and test Seams before introducing anything new.",
  "Change only code required to satisfy the frozen Acceptance and this Task's promised artifact.",
  "Do not add an abstraction unless the frozen PRD, an approved Decision, or a proven repository constraint requires it.",
  "Fallback is default-deny: do not add fallback branches, silent recovery, default substitution, compatibility paths, catch-and-continue behavior, or error swallowing unless the frozen Acceptance, an approved Decision, or this Task explicitly requires that exact behavior and names its verification.",
  "Do not repeat runtime validation for internal data whose invariant is already established by a trusted input Seam or type.",
  "Do not refactor, rename, reformat, or clean up unrelated code while completing the Task.",
  "Do not add dependencies, public Interfaces, configuration, feature flags, or extension points unless this Task explicitly requires them.",
  "Match the nearby repository conventions for naming, control flow, errors, imports, and tests.",
  "Keep composition roots and app entry modules thin: they may wire dependencies and orchestrate flows, but cohesive behavior belongs in its existing owning Module. Create a new file or Module only when no suitable owner exists and the responsibility is independently coherent. Split by responsibility, not file length; avoid both god files and one-function pass-through Modules.",
] as const;

export function minimalImplementationPolicyLines(prefix = "- "): string[] {
  return MINIMAL_IMPLEMENTATION_POLICY.map((rule) => `${prefix}${rule}`);
}
