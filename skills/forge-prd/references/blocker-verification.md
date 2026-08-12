# PRD Blocker verification contract

## Question

Does each submitted Blocker independently hold on the frozen PRD and repository surface?

## Rules

- Verify only the supplied Blocker IDs; do not perform a fourth general review.
- Reproduce the finding using its stated verification and evidence.
- Keep the original axis and scope.
- Do not modify the PRD, propose unrelated improvements, or expand product scope.
- A design preference without an implementation or acceptance failure is rejected.

## Result

For each Finding ID return exactly one status:

- `confirmed` — evidence reproduces the blocking condition;
- `rejected` — evidence does not support a Blocker;
- `needs_more_evidence` — the frozen surface cannot decide it.

A confirmed result cites the exact evidence and violated rule. A rejected result explains why the condition is non-blocking. `needs_more_evidence` lists the smallest missing fact.
