# Architecture review contract

## Question

Is the selected design the minimum sufficient design for the current repository and frozen behavior?

## Review

- The change belongs to the selected Module and existing Seam.
- Dependency direction and ownership remain coherent.
- Existing Interfaces and Helpers are reused where they already express the need.
- New Interfaces correspond to real variation or an explicitly approved public contract.
- Fallback is default-deny: compatibility paths, default substitution, silent recovery, catch-and-continue behavior, and swallowed errors are allowed only when frozen behavior explicitly requires them and names verification.
- The design avoids future-only extension points, duplicate concepts, pass-through Modules, and unnecessary dependencies.
- The implementation-relevant data flow is complete and ordered from entry/input boundary through transformation and the owning Module to downstream consumers, side effects, and observable Test Seams.
- App entry points and Composition Roots remain limited to dependency wiring and orchestration; cohesive behavior belongs to its owning Module without fragmenting it into one-function pass-through files.
- Public Interface changes, migration, rollback, locality, and testability are complete.
- No known simpler design satisfies the same Acceptance and constraints.

## Out of scope

- Rewriting product scope or adding desired features.
- Repository coding style.
- Whether every current-code claim is true except where a missing claimed Seam makes the design impossible.

## Blocker threshold

Report a Blocker only when the design cannot implement Acceptance, depends on a nonexistent or forbidden Seam, violates a proven architecture invariant, leaves public Interface or migration policy undecided, contains an unauthorized Fallback, leaves implementation-relevant data flow or ownership ambiguous, accumulates cohesive behavior in an app/Composition Root despite a proven owner, fragments behavior into shallow pass-through Modules, or has a clearly simpler sufficient alternative. Personal preference is not a Blocker.
