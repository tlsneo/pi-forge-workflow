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

Do not draft or copy Issue fields. Call `forge_issues_submit` with only the Work Item root. Runtime derives the complete ordered Issue set directly from the frozen PRD:

```text
DB-01 → I001
DB-02 → I002
```

For every Issue it copies the frozen boundary title, goal, outcome, scope, Acceptance, behavior, Decisions, Evidence, Test Seams, non-goals, verification, and converts boundary dependencies to the matching Issue IDs. PRD validation has already required every boundary to own non-empty Evidence, Test Seams, and the exact ordered verification closure of its Acceptance and Test Seams. If that contract is invalid, PRD submission fails before Review rather than producing an Issue-layer decision.

The Issue phase contains no LLM-authored proposal and cannot redesign, widen, reorder, summarize, or repair the frozen Delivery Plan. It writes no implementation steps, file edits, Slices, or Tasks.

Completion criterion: the deterministic call returns one Issue per frozen Delivery Boundary and complete Acceptance traceability.

## 3. Generate Local artifacts

The same `forge_issues_submit` call validates the derived IDs, references, dependencies, DAG shape, and traceability; derives all hashes and source bindings; and writes:

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

Calling materialization again is idempotent because one frozen PRD has exactly one Issue representation. If the frozen Delivery Plan must change, create a successor Work Item through `forge-prd`; do not amend the predecessor Issues in place.

Completion criterion: `forge_issues_status` returns a Manifest whose traceability covers every PRD Acceptance and whose Artifact Hashes match the generated files.

## Guardrails

- Local Issue artifacts are authoritative in the current release; external tracker publication is outside this workflow.
- Do not duplicate the complete PRD inside every Issue.
- Do not invent new Acceptance, behavior, Evidence, Decisions, Test Seams, non-goals, verification text, data-flow direction, Module ownership, Fallback semantics, or file boundaries.
- Do not proceed to Tasks from the PRD directly; `forge-tasks` consumes `issues/manifest.json` and one Issue Artifact.

Phase boundary: define delivery units only; do not decide implementation sequencing below the Issue dependency level.
