---
name: forge-prd
description: Turn the current feature discussion into an evidence-backed, reviewed, user-approved PRD with conditional Mermaid diagrams and a frozen content hash.
disable-model-invocation: true
---

# Forge PRD

Convert the conversation into one frozen planning artifact. Preserve answered decisions; interview only the open frontier. Before submitting structured data, read [the tool contracts](references/contracts.md).

## 1. Select the Target Repository and open the Work Item

The current Pi directory is the Forge **Control Root**: it owns `.pi/forge.json`, Agent templates, and `.forge` artifacts, and it does not need to be a Git repository. Each Work Item freezes exactly one Target Git Working Tree. Single-repository projects are the degenerate case where Control Root and Target Repository are equal.

Call `forge_prd_repositories` when the Control Root contains more than one candidate repository, then ask the user to select one path. Forge does not classify the layout as monorepo, nested repository, submodule, or worktree; Git resolves the selected directory to its canonical top-level Working Tree. To create, call `forge_prd_open` without `workItemRoot`, pass a short stable title, and pass `repositoryRoot` when selection is required. With exactly one discovered repository Forge may select it automatically. To resume, pass the exact returned Work Item root; the frozen Target Repository cannot change.

Read `.pi/forge.json` from the Control Root. From `repositoryContext`, load applicable Control Workspace constraints, then investigate product code only in the frozen Target Repository. All Evidence paths, Task Reads/Writes, Handoffs, and Receipts are relative to that Repository root. One Work Item cannot span multiple Git repositories in the current release.

If `repositoryContext` is absent, fall back to Control Root instructions and discover relevant Context, ADR, glossary, and architecture material before drafting.

Completion criterion: Control Root, Target Repository root and revision, Runtime identity, current state, next action, and applicable constraints are known.

## 2. Map repository evidence and build the decision tree

Map the change inside this phase; there is no separate public Map or Spec artifact. Trace the current implementation from user-visible entry through public Interface, call path, value transformation, owning Module, downstream consumers or side effects, and observable Test Seam. Inspect only behaviorally relevant Adapters, schemas, configuration, permissions, caches, migrations, generated artifacts, fixtures, and deployment constraints. Record each proven fact as revision-bound `path#Symbol` Evidence; separate facts, risks, and unresolved unknowns. Do not create a second Impact Map fact source—the checkpoint Evidence and final PRD are authoritative.

Extract from the conversation and evidence:

- settled user decisions;
- repository facts that need evidence;
- user decisions still open;
- facts held by an external stakeholder.

Use the `grilling` protocol for open user decisions: dependencies form a decision tree, the frontier contains every question whose prerequisites are settled, each round asks the whole frontier, and every question includes a recommended answer. Until Forge-controlled Research Jobs are implemented, find repository facts with the parent session's read-only tools. Do not call generic `Agent`, `Explore`, or `Plan`; they bypass Forge model routing, Bindings, and evidence receipts. Use an external questionnaire only for facts unavailable to both repository and user.

After each round, call `forge_prd_checkpoint` with the complete decision tree, evidence set, and concise discovery summary.

Completion criterion: every decision is answered or explicitly external; external items put the Work Item into `needs_external_input` rather than being guessed.

## 3. Select the minimum sufficient design

Use the mapped data flow to choose the existing Seam and owning Module. Keep app entry points and Composition Roots limited to dependency wiring and orchestration; place cohesive behavior in its existing owner. Split by stable responsibility, not file length, and do not create pass-through Modules merely to make files smaller. Fallback is default-deny: compatibility paths, default substitution, silent recovery, catch-and-continue behavior, and swallowed errors require explicit frozen behavior plus verification.

Compare viable locations directly against repository evidence. Prefer the design that satisfies Acceptance while introducing the fewest new concepts, Interfaces, dependencies, branches, and modified paths. Record the selected location and materially plausible rejected alternatives in PRD Decisions. If surviving alternatives change user behavior, Scope, public Interface, compatibility, migration, security, or long-lived Module ownership, put that choice in the user Decision Frontier. Do not create a separate Design artifact or simulate a multi-agent tournament.

Completion criterion: one evidence-backed minimum sufficient design is selected, every material alternative is rejected with a reason or assigned to the user, and no architecture choice remains implicit.

## 4. Draft one PRD

Call `forge_prd_submit` with structured data. The Runtime generates `prd/PRD.md`; do not hand-edit the generated file.

The PRD covers problem, solution, goals, non-goals, actors, focused user stories, stable Acceptance IDs, happy/error/edge behavior, design decisions, `path#Symbol` impact evidence, test seams, risks, migration, rollback, open questions, and a Delivery Plan. Each Delivery Boundary freezes its delivery goal and scope as well as outcome and traceability, so the Issue phase cannot widen them. Use one `DB-01` boundary by default. Split into `DB-02...` only when each outcome can be independently implemented, verified, delivered, rolled back, and closed. Delivery-boundary choices belong in the PRD Decision Frontier and use the same Grilling protocol when user judgment is required.

Add Mermaid only when it compresses real complexity:

- cross-module flow → `flowchart`;
- order-sensitive interaction → `sequenceDiagram`;
- real lifecycle → `stateDiagram-v2`;
- changed entity relationships → `erDiagram`.

A local change may have no diagram.

The generated top-level human entry is `<work-item-root>/PRD.md`; `prd/prd.json` and `prd/generations/` remain the structured current pointer and immutable history. Completion criterion: the structured PRD validates, every Acceptance is owned by a Delivery Boundary, and the generated Markdown path and content hash are returned.

## 5. Review

`forge_prd_submit` automatically creates Binding-bound Review Jobs and starts the configured read-only Reviewers through pi-subagents. Do not manually launch the fixed gates. Each Reviewer follows only its contract: [Coverage](references/review-coverage.md), [Evidence](references/review-evidence.md), or [Architecture](references/review-architecture.md).

Review axes:

- Coverage: behavior, errors, scope, and Acceptance completeness;
- Evidence: repository claims, consumers, and test seams;
- Architecture: selected seam, minimality, compatibility, and rollback.

Each Reviewer submits exactly once through `forge_prd_review` using its Binding ID. Runtime rejects stale Generation, Axis, Surface Hash, duplicate, or manual-bypass submissions. `Agent completed` without a structured submission becomes `interrupted`; normal in-session recovery creates a fresh Binding. After an explicit coordinator restart, use `forge_prd_resume_reviews` with a takeover reason.

When all axes finish, reported Blockers automatically start a different-Binding Blocker Verifier following the [Blocker verification contract](references/blocker-verification.md). Confirmed Blockers block Amendment; rejected Blockers retain the immutable original Review but allow the gate to proceed; missing evidence enters `needs_external_input`.

When a Blocker is confirmed or the user explicitly authorizes correction before Freeze, update the structured PRD and call `forge_prd_amend`. Runtime creates a new immutable Generation, computes all three review surfaces, carries forward only passed reviews whose surface hash is unchanged, and automatically starts fresh Review Jobs only for invalidated axes. Never overwrite a prior PRD, Review, Binding, or Verification artifact.

Completion criterion: every Review Job has a structured result, every Blocker has an independent verification result, and the current Generation is `awaiting_approval`.

## 6. Approve and freeze

Show the generated PRD to the user and wait for explicit approval. Then call `forge_prd_approve` with the approval evidence, followed by `forge_prd_freeze`.

Completion criterion: Runtime status is `frozen` and a Receipt records PRD generation, hash, three reviews, and user approval.

A frozen PRD is immutable. If later execution proves that Acceptance, Scope, public Interface, compatibility, security, or the selected architecture must change, call `forge_prd_supersede` to create a successor Work Item. Preserve the predecessor and its Issue Runtime unchanged; restart discovery and review in the successor.

Phase boundary: the frozen PRD may proceed to `forge-issues`; do not create Issues, Tasks, or product-code changes here.
