---
name: forge-spec
description: Write and freeze an implementation-independent Spec from an approved Forge design and current Impact Map. Use after architecture selection and before creating Issues.
disable-model-invocation: true
---

# Forge Spec

The Spec defines behavior and boundaries, not file-by-file implementation.

1. Require the current Impact Map, selected design, repository revision, and resolved user decisions.
2. Specify motivation, user-visible behavior, acceptance criteria, error paths, scope, non-goals, compatibility, migration, rollback, observability, architecture decision, and test seams.
3. Give every Acceptance a stable ID and objective evidence requirement.
4. Link code facts to Impact Map evidence instead of copying implementation details.
5. Run independent coverage, evidence, and architecture reviews.
6. Resolve every Blocker. Re-run only the affected review surface after amendments.
7. Validate the final schema and Acceptance coverage mechanically.
8. Freeze the Spec, record its content hash and repository binding, and preserve prior generations.

Completion criterion: all three reviews pass, every Acceptance is objective and covered, no correctness-changing unknown remains, and the frozen Spec Hash is persisted.

Phase boundary: a frozen Spec must proceed through `forge-issues`; it never goes directly to Task decomposition.
