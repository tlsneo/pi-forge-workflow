---
name: forge-tasks
description: Decompose one Local Forge Issue into vertical Slices and behavior-complete Task contracts with decision-free Blueprint steps, freeze DAG Generation 1, and initialize the shared-serial Issue Runtime.
disable-model-invocation: true
---

# Forge Tasks

Investigate the selected Issue implementation closure once. Workers must not investigate it again. Read [the Task Plan contract](references/contracts.md) before submitting.

## 1. Load one Issue and close the implementation flow

Call `forge_tasks_status` with the Work Item root and Issue ID. The Target Repository is inherited from the Work Item and cannot be changed here. Read only `issues/manifest.json`, the selected `issue.json` / `ISSUE.md`, Control Root instructions, and the exact Target Repository paths needed to close that Issue. Every product path is relative to the frozen Target Repository root. Respect Issue dependencies, frozen Acceptance ownership, design Decisions, and ordered Impact Evidence.

Before drafting a Slice or Task, write one implementation flow in repository terms:

```text
entry/input boundary
→ normalization or transformation
→ owning Module
→ downstream consumer or side effect
→ observable Test Seam
```

For every hop, name its exact `path#Symbol`, the value or artifact crossing it, the dependency direction, and whether the hop changes or remains unchanged. Identify the existing owner of each cohesive behavior. Treat app entry points and Composition Roots as wiring/orchestration only. If no suitable owner exists, a new Module is allowed only when its responsibility is independently coherent; file length alone is not evidence. Do not infer a Fallback: absence of explicitly frozen Fallback behavior means no Fallback branch may be planned.

Completion criterion: every affected flow hop, owning `path#Symbol`, direct consumer, side effect, Test Seam, generated artifact, changed/unchanged branch, and authoritative verification command required by the selected Issue is known; no Module ownership, fallback semantics, or dependency direction remains for a Worker to choose.

## 2. Design vertical Slices along observable flow

A Slice proves a coherent end-to-end subset of Issue Acceptance through an integration gate. Slice along observable behavior or a independently provable segment of the frozen data flow, not by technical layer such as “types,” “service,” or “tests.” Create one Slice by default. Split only when an intermediate behavior can be assembled and proven before the remaining behavior.

Each Slice has contiguous ID `S001...`, goal, Acceptance IDs, ordered Task IDs, and at least one authoritative gate command with timeout and a statement of what it proves. Every Issue Acceptance must belong to at least one Slice.

## 3. Write behavior-complete Tasks

Use contiguous IDs `T001...`. Each Task normally has:

- one primary `path#Symbol` Edit Point;
- one to three exact Reads with reasons;
- one to three declared Writes;
- one small result and explicit Produces;
- only real artifact-backed Dependencies and Consumes;
- separate Conflicts for overlapping writers that are not dependency ordered;
- the Slice Acceptance IDs it helps prove;
- ordered `BP-01...` Blueprint Steps, each with one exact instruction and explicit Expected Evidence;
- Expected Patch Shape covering every intended changed surface;
- Forbidden Changes and fail-closed Stop Conditions that remove Worker discretion;
- explicit Out of Scope;
- focused authoritative verification and timeout;
- optional `simple`, `medium`, or `complex` Model Profile.

Order Tasks by real data/artifact flow rather than preferred coding order. `Produces` names the value, contract, generated artifact, or proven behavior created at one hop; `Consumes` names the exact upstream artifact used by a later hop. A dependency is valid only when this flow crosses Task boundaries. Each Blueprint must state where its input comes from, where its output goes, and which downstream branches remain unchanged.

A Worker reading its exact frozen versioned contract, such as `TASK-V001.md`, must not need the PRD, Issue, another Task, chat history, call-chain search, architecture selection, or product decisions. One Task is one behavior-complete, directly executable, normally committable result. Put micro-steps inside its Blueprint instead of creating one Runtime Task per implementation step. Split only when results can be independently implemented, verified, committed, rolled back, and consumed. A Task normally requires one to three exact Reads and up to three inseparable Writes, including focused tests or build registration needed to prove the behavior.

The Implementation Blueprint is not a goal summary. Every Step has a contiguous `BP-xx` ID, one exact instruction, and Expected Evidence. The complete contract names where to edit, the existing symbol to reuse, how values flow into and out of the edit, which condition changes behavior, which branches remain unchanged, the Expected Patch Shape, Forbidden Changes, Stop Conditions, and the focused assertion or command that proves the result. When a Write is a test file, the Blueprint must name the exact import or fixture seam, insertion point, test name, input, expected output or exact error assertion, and which existing test remains unchanged. Do this in the first Proposal; phrases such as “add coverage for normal, edge, and error cases” are not executable. Every Task also carries the fixed Minimal Implementation Policy: reuse existing code, change only what Acceptance requires, add no speculative abstraction or dependency, default-deny every Fallback or silent recovery unless explicitly authorized and verified, trust established internal invariants, avoid unrelated cleanup, match nearby style, and keep app/composition-root Modules thin by placing cohesive behavior in its owning Module. Split by responsibility rather than line count; do not replace a cohesive behavior with orchestration-only commits or one-function pass-through Modules. Sequential Tasks may edit the same file only when real Produces / Consumes make each Task an independently useful behavior result.

## 4. Run independent Task Preflight

Call `forge_tasks_submit` once with the complete Slice and Task set. This first performs mechanical validation, persists an immutable semantic Proposal and surface hash, creates a Binding-bound `forge-reviewer` Preflight Job through pi-subagents, and leaves the Task Plan unfrozen.

The reviewer reads the Proposal, Issue, and only each Task's declared exact Reads. It must reject any Task that still requires repository search, implementation choices, inferred or unauthorized fallback behavior, multiple independently deliverable behaviors, missing context, unstable Blueprint IDs, missing Expected Evidence, ambiguous Expected Patch Shape, non-failing Stop Conditions, cohesive behavior piled into an app/composition-root Module despite a proven owner, or shallow file fragmentation without independent responsibility. It submits exactly one result through `forge_tasks_preflight_submit`. Ordinary Agent, Explore, or Plan cannot substitute for this Binding.

A passed Result automatically freezes the approved Proposal and initializes Runtime. A blocked Result leaves all findings immutable; revise the affected Task contracts and call `forge_tasks_submit` again to create a new Proposal Generation. Reusing the identical blocked Proposal does not bypass Preflight.

## 5. Freeze and initialize

After Preflight passes, Runtime validates the approved Issue and Config hashes, IDs, Acceptance coverage, Context Budget, paths, Artifact Dependencies, DAG cycles, overlapping Writes, model profiles, commands, timeouts, and the current `shared-serial + none` workspace policy.

It writes:

```text
issues/I001/
├── task-preflight/
│   ├── proposals/proposal-1.json
│   ├── results/proposal-1.json
│   ├── receipts/proposal-1.json
│   ├── state.json
│   └── events.jsonl
├── task-manifest.json
├── task-generations/tasks-1.json
├── slices/S001/SLICE.md
├── tasks/T001/TASK-V001.md
└── runtime/
    ├── manifest.json
    ├── dag.json
    ├── state.json
    ├── events.jsonl
    └── receipts/T001-V001.json
```

The same semantic Slice/Task proposal and its Preflight Result are idempotent even when Forge Config Generation or Model Policy changed; execution policy is not Task Plan content. When incomplete Tasks should adopt the current Config, call `forge_tasks_rebind_models`. It creates an immutable Runtime Model Policy Generation while preserving completed Receipts, prior Bindings, Task contracts, and DAG history. A changed semantic plan requires a DAG Amendment. Return the exact Runtime root; it is the only input required by `forge-run`.

Completion criterion: Runtime status, active Model Policy Generation, first dependency-free Task, pending Tasks, and non-placeholder Contract Hashes are returned.

## Guardrails

- Current MVP supports only `shared-serial` with `isolationBackend: none`.
- Dependency means `Consumes Txxx::artifact`; ordering preference alone is not a dependency.
- Do not modify product code in this phase.
- Do not create Tasks that merely say “update callers,” “add support,” or “write tests.” Name exact symbols, behavior, assertions, and artifacts.

Phase boundary: freeze contracts and initialize Runtime only; implementation begins in `forge-run`.
