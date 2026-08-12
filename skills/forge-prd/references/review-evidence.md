# Evidence review contract

## Question

Are the PRD's claims about the current repository true at the bound revision?

## Review

- Every cited path and Symbol exists at the manifest revision.
- Each claim accurately describes the Symbol's current responsibility.
- The entry path, call chain, data flow, direct and indirect consumers, Adapters, configuration, schemas, fixtures, and generated artifacts relevant to correctness are represented.
- Test Seams exist and can observe the claimed behavior at the stated level.
- Future design is described as proposed behavior, not current-code fact.
- Evidence IDs, revision bindings, and PRD references are internally consistent.

## Out of scope

- Whether the requested product behavior is desirable.
- Whether User Stories are exhaustive.
- Whether another architecture would be cleaner, unless the PRD's claimed existing Seam is factually absent.

## Blocker threshold

Report a Blocker only when a material code claim is false, stale, missing, or insufficient to support implementation and verification. A weak test fixture may be a Warning when the PRD explicitly requires strengthening it.
