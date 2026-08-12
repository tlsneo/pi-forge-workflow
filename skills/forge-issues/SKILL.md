---
name: forge-issues
description: Convert one frozen Forge PRD into one or more independently deliverable Local Issue artifacts with complete Acceptance traceability and one deterministic Issues Manifest.
disable-model-invocation: true
---

# Forge Issues

Every frozen PRD passes through this phase, including small changes. Read [the Issue contract](references/contracts.md) before submitting.

## 1. Require the top-level PRD

Call `forge_issues_status` with the Work Item root. If it returns `needsPrd: true`, stop Issue generation and enter `/skill:forge-prd` for that Work Item. Synthesize the current conversation first, investigate repository facts, use the Grilling decision frontier only for unresolved user decisions including Delivery Boundaries, complete Review, obtain explicit user approval, and Freeze. Then resume `forge-issues` with the same Work Item root.

When ready, require `state.status: frozen`, a matching Frozen PRD Receipt, and no unresolved source ambiguity. Read top-level `PRD.md`, `prd/prd.json`, and the Receipt; do not search the repository again or redesign the PRD. Preserve the selected data-flow order, owning-Module Decisions, dependency direction, default-deny Fallback policy, and app/Composition-Root boundaries already frozen in the PRD. Issue generation does not create these implementation constraints; it carries their Decision and Evidence IDs into the delivery unit that owns them.

Completion criterion: the exact Work Item ID, PRD Generation, PRD Hash, Acceptance IDs, behavior, design and ownership Decisions, ordered impact Evidence, test seams, and applicable minimality constraints are known.

## 2. Materialize frozen delivery boundaries

Do not choose new delivery boundaries here. The frozen PRD Delivery Plan is authoritative. Materialize `DB-01 → I001`, `DB-02 → I002`, and so on, preserving exact goal, delivery outcome, scope, Acceptance, behavior, Decisions, Evidence, Test Seams, non-goals, verification, and boundary dependencies. If a boundary is missing or cannot become an independently deliverable Issue, stop and return to a PRD Amendment with Grilling rather than inventing Issue-layer product decisions. Do not create horizontal Issues such as “add schema,” “update service,” or “write tests” unless that item is already a frozen independently observable Delivery Boundary.

Every Issue must have the exact `deliveryBoundaryId` and:

- one outcome-oriented goal and delivery outcome;
- a focused scope and only frozen PRD non-goals;
- at least one Acceptance ID;
- the exact frozen behavior lines it owns;
- the Decisions, flow-ordered Evidence, Test Seams, and verification obligations needed for that outcome, including applicable ownership, dependency-direction, Fallback, and Composition-Root constraints;
- only real delivery dependencies on other Issues.

Use contiguous stable IDs: `I001`, `I002`, and so on. Dependencies must form a DAG. Do not write implementation steps, file edits, Slices, or Micro Tasks here.

Completion criterion: each Issue is independently deliverable and every PRD Acceptance maps to at least one Issue.

## 3. Generate Local artifacts

Call `forge_issues_submit` once with the complete ordered Issue set. Runtime validates IDs, references, frozen text, dependencies, DAG shape, and full Acceptance traceability; derives all hashes and source bindings; and writes:

```text
issues/
├── manifest.json
├── README.md
├── generations/issues-1.json
└── I001/
    ├── issue.json
    └── ISSUE.md
```

`issue.json` is the Issue fact source. `ISSUE.md` and `issues/README.md` are deterministic human views. `manifest.json` is the only entry point for `forge-tasks`.

Submitting the same proposal is idempotent. A different proposal for the same frozen PRD fails closed. If the frozen Delivery Plan must change, create a successor Work Item through `forge-prd`; do not amend the predecessor Issues in place.

Completion criterion: `forge_issues_status` returns a Manifest whose traceability covers every PRD Acceptance and whose Artifact Hashes match the generated files.

## Guardrails

- Local Issue artifacts are authoritative in the current release; external tracker publication is outside this workflow.
- Do not duplicate the complete PRD inside every Issue.
- Do not invent new Acceptance, behavior, Evidence, Decisions, Test Seams, non-goals, verification text, data-flow direction, Module ownership, Fallback semantics, or file boundaries.
- Do not proceed to Tasks from the PRD directly; `forge-tasks` consumes `issues/manifest.json` and one Issue Artifact.

Phase boundary: define delivery units only; do not decide implementation sequencing below the Issue dependency level.
