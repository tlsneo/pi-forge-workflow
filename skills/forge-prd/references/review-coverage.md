# Coverage review contract

## Question

Does the PRD completely and objectively define the behavior to build?

## Review

- Problem and Solution describe the same user problem.
- Actors and focused User Stories cover every affected user role.
- Every user-visible behavior has a stable Acceptance ID.
- Acceptance statements are objective and their verification plans can prove them.
- Happy path, error paths, edge cases, omission/default behavior, compatibility, and non-goals are explicit.
- No behavior-changing phrase depends on interpretation such as “appropriate,” “supported,” “handle,” or “as needed.”
- The PRD does not silently expand beyond its goals.

## Out of scope

- Whether a repository path or Symbol exists.
- Whether the selected Module or Seam is architecturally optimal.
- Code style, implementation detail, or Task decomposition.

## Blocker threshold

Report a Blocker only when behavior is missing, contradictory, untestable, or ambiguous enough to produce materially different implementations. Warnings and preferences do not block.
