# Pi Forge Workflow

[中文说明](README-CN.md)

A deterministic, evidence-backed engineering workflow for [Pi](https://pi.dev) that turns a feature discussion into a reviewed PRD, exact Local Issues, small executable Tasks, verified Git commits, Assurance-dependent completion, and bounded remediation.

> **Status:** experimental MVP. The implemented execution path is intentionally `shared-serial` and fail-closed. See [Current limitations](#current-limitations) before adopting it.

## Why Forge?

Large changes often fail between planning and implementation:

- requirements drift while Issues and Tasks are being created;
- workers rediscover the repository and silently redesign the change;
- “small Tasks” are vague summaries rather than executable contracts;
- agent completion is mistaken for verified delivery;
- retries, reviews, and remediation overwrite history;
- speculative abstractions, fallback behavior, and unrelated cleanup inflate the diff.

Forge treats the workflow itself as a deterministic state machine. The language model proposes structured content, while the Runtime validates identity, dependencies, hashes, state transitions, verification, Git scope, and immutable history.

## Installation

### Install from Git

After this repository is hosted, install both packages:

```bash
pi install npm:@tintinweb/pi-subagents
pi install https://github.com/tlsneo/pi-forge-workflow
```

A tag or commit may be pinned:

```bash
pi install https://github.com/tlsneo/pi-forge-workflow@v0.7.0
```

### Install from a local checkout

```bash
git clone https://github.com/tlsneo/pi-forge-workflow.git
cd pi-forge-workflow
npm install
pi install /absolute/path/to/pi-forge-workflow
```

For project-local Pi installation, add `-l` to `pi install`.

> This repository currently has `"private": true` and version `0.7.0`, so the documented distribution path is Git or a local checkout, not npm publication.

## Public workflow

```text
/skill:forge-init
        ↓
/skill:forge-prd
        ↓
/skill:forge-issues
        ↓
/skill:forge-tasks
        ↓
/skill:forge-run
```

The planning hierarchy is fixed:

```text
PRD → Delivery Boundary → Issue → Vertical Slice → behavior-complete Task
```

Repeatable `simple`, `medium`, and `hard` local fixtures plus preparation and Runtime timing scripts live in [`benchmarks/`](benchmarks/README.md).

Forge separates its **Control Root** from the **Target Repository**. The Control Root owns `.pi` configuration and `.forge` artifacts and may be a non-Git multi-repository workspace. Each Work Item selects and freezes one Git Working Tree; Issue, Task, Worker, verification, Audit, commit, and rollback inherit that repository. Single-repository projects continue to work with both roots equal.

- **PRD** defines the complete problem, behavior, Acceptance, evidence, architecture decisions, and delivery boundaries.
- **Issue** materializes exactly one frozen delivery boundary.
- **Slice** proves an observable subset of Issue Acceptance through an authoritative gate.
- **Task** is one behavior-complete, independently executable, verifiable, and normally committable result; detailed micro-steps live inside its Blueprint.

### Multi-repository Control Workspaces

A Control Root may be a plain directory containing several independent Git repositories:

```text
workspace/                 # no .git required
├── .pi/
├── .forge/
├── subproject1/.git/
└── subproject2/.git/
```

Start Pi from `workspace`, run `forge-prd`, and select a Target Repository from `forge_prd_repositories` when more than one is found. Forge asks Git for the canonical top-level Working Tree, so the same path-based mechanism supports single repositories, monorepo subdirectories, nested repositories, submodules, and linked worktrees without layout-specific Runtime branches. The selected Repository is frozen on the Work Item and inherited by Issues and Tasks; the current release keeps one Work Item in one Git repository.

For ad hoc read-only investigation across repositories, `forge_explore_repository` is an additional entry point to the existing `Explore` Agent. It accepts a Target Repository path plus a self-contained investigation prompt, then spawns through pi-subagents RPC with `cwd` set to that Repository and without requesting worktree isolation. Multiple calls can inspect independent repositories concurrently. The normal `Agent` → `Explore` capability remains unchanged and is still appropriate when the Pi Session already runs in the Repository being inspected.

## Architecture

```mermaid
flowchart TD
    U[Conversation + repository evidence] --> P[forge-prd]
    P --> PR[Structured PRD generation]
    PR --> RV{Coverage + Evidence + Architecture reviews}
    RV -->|passed| AP[Explicit user approval]
    RV -->|confirmed blocker before freeze| PA[New immutable PRD generation]
    PA --> RV
    AP --> FPRD[Frozen PRD + receipt]

    FPRD --> I[forge-issues]
    I --> DB[Deterministic DB-01 → I001 materialization]
    DB --> T[forge-tasks]
    T --> FLOW[Trace data flow and module ownership]
    FLOW --> DAG[Vertical Slices + behavior-complete Task DAG]
    DAG --> PF{Independent Task Preflight}
    PF -->|blocked| DAG
    PF -->|passed| RUN[forge-run]

    RUN --> W[Binding-bound Task Worker]
    W --> H[Structured Handoff]
    H --> V[Authoritative diff + command verification]
    V --> TC{Single Task Conformance audit}
    TC -->|blocked| W
    TC -->|passed| C[Scoped Git commit + immutable receipt]
    C --> G{Slice Gates}
    G -->|passed| AS{Frozen Assurance Profile}
    G -->|failed| RM[Verifier → Planner → Preflight → DAG amendment]
    AS -->|Fast| MF[Mechanical final receipt]
    MF --> DONE[Issue completed]
    AS -->|Standard / High| A{Three-axis final Issue audit}
    A -->|passed| DONE
    A -->|confirmed blocker| RM
    A -->|ambiguous or contract-changing| HD[Human Decision Gate]
    RM --> W
```

### Authority boundaries

| Role | Responsibility | May edit product code? |
|---|---|---:|
| Coordinator | Advances the deterministic Runtime frontier | No |
| Planner | Produces PRD, Issue, Slice, Task, or remediation proposals | No |
| Reviewer / Auditor | Submits structured findings against a frozen review surface | No |
| Verifier | Independently confirms or rejects Blockers | No |
| Task Worker | Executes one exact versioned Task contract | Yes, within declared Writes only |
| Runtime | Validates state, identity, hashes, DAGs, verification, Git scope, receipts, and recovery | N/A |

`Agent completed` never means `Task completed`. A Task completes only after a valid Binding, structured Handoff, terminal Worker, authoritative verification, scoped Git commit, and immutable Receipt. Once a Receipt exists, the Task and its Binding are irreversibly terminal: late resume, checkpoint, Handoff, or verification activity cannot reopen the Task. Verification also requires `HEAD === Binding baseline` before inspecting the diff.

## Core design principles

### 1. PRD as the top-level source of truth

A reviewed, explicitly approved, frozen PRD is required before Issues can exist. The PRD contains:

- stable Acceptance IDs;
- happy, error, edge, omission, and compatibility behavior;
- repository `path#Symbol` evidence bound to a Git revision;
- architecture and ownership Decisions;
- Test Seams and verification plans;
- independently deliverable `DB-01...` boundaries;
- optional Mermaid diagrams when they clarify real flow, sequence, state, or relationships.

The PRD receives independent **Coverage**, **Evidence**, and **Architecture** reviews. Blockers are independently verified, and amendments create new immutable generations instead of overwriting history.

### 2. Issues cannot redesign the PRD

`forge-issues` deterministically maps:

```text
DB-01 → I001
DB-02 → I002
```

Goal, outcome, scope, Acceptance, behavior, Decisions, evidence, Test Seams, non-goals, verification, and dependencies are copied directly from the frozen Delivery Boundary. `forge_issues_submit` accepts only the Work Item root; there is no LLM-authored Issue proposal to drift, mistype, or retry. PRD validation rejects any boundary whose exact Issue verification closure is incomplete before Review starts.

### 3. Tasks follow real data flow

Before Task generation, `forge-tasks` closes the implementation path:

```text
entry / input boundary
→ normalization or transformation
→ owning Module
→ downstream consumer or side effect
→ observable Test Seam
```

Task ordering must be justified by real `Produces → Consumes` artifacts. Preferred coding order alone is not a dependency. Slices are vertical and observable; they are not horizontal buckets such as “types,” “services,” and “tests.”

### 4. Small workers, detailed contracts

A Worker reads only its versioned contract, for example:

```text
tasks/T003/TASK-V001.md
```

A Task normally has:

- one primary `path#Symbol` edit point;
- one to three exact Reads and up to three inseparable Writes;
- ordered `BP-01...` Steps with exact instructions and Expected Evidence;
- an Expected Patch Shape, Forbidden Changes, and fail-closed Stop Conditions;
- explicit Produces, Consumes, Out of Scope, and Acceptance ownership;
- focused authoritative verification.

A Task may contain many detailed micro-steps while remaining one behavior-complete commit result. Split only when results can be independently implemented, verified, committed, rolled back, and consumed. Workers do not read the parent PRD, reopen architecture, search the full call chain, invoke other Skills, or spawn nested Subagents.

### 5. Minimal Implementation Policy

Every Task contract carries a fixed policy:

- reuse existing Symbols, Helpers, types, Modules, and Test Seams;
- change only what frozen Acceptance requires;
- add no speculative abstraction, dependency, public Interface, configuration, feature flag, or extension point;
- treat Fallback as default-deny: no silent recovery, default substitution, compatibility branch, catch-and-continue behavior, or swallowed error without explicit frozen authorization and verification;
- do not repeat runtime validation after a trusted input Seam or type established the invariant;
- do not perform unrelated refactors, renames, formatting, or cleanup;
- preserve nearby naming, control-flow, error, import, and test conventions;
- keep app entry points and Composition Roots limited to wiring and orchestration;
- split by coherent responsibility, not line count, while avoiding one-function pass-through Modules.

### 6. Immutable execution identity

Bindings and Receipts include the full identity:

```text
Work Item / Issue / Task@Version
+ exact Task contract path
+ contract hash
+ DAG generation
+ model policy generation
+ Git baseline and commit
```

Completed Tasks, Receipts, commits, reviews, audits, and old DAG generations are never rewritten. Remediation appends new `Txxx@V001` Tasks in a new DAG generation.

### 7. Authoritative verification and Git integration

Worker-reported commands are advisory. The coordinator reruns every frozen verification command, validates `git diff --check`, freezes the staged patch hash, and starts exactly one Binding-bound read-only Task Conformance Auditor. The Auditor checks every Blueprint Step, Handoff Evidence, Expected Patch Shape, Forbidden Change, minimality, correctness, and local safety. Only a passed result with an unchanged patch hash may be committed and receipted. A blocked result rolls back declared Writes and retries the same frozen Task with immutable Correction Context; it does not start an Issue Remediation Planner.

Commit subjects are exactly the frozen Task titles. Forge metadata remains in Receipts rather than leaking into product-facing Git history.

### 8. Assurance-dependent completion and bounded remediation

After Slice Gates pass, the frozen Runtime Assurance Profile controls completion:

- **Fast** still requires one pre-commit Conformance Audit per Task, then writes a mechanical final Receipt from audited Task Receipts and Slice Gate evidence and completes without spawning final Issue Auditors;
- **Standard** and **High Assurance** retain the three independent final Issue audits: Standards, Acceptance / Integration, and Architecture / Minimality.

An audited Blocker enters a controlled loop:

```text
Audit Finding
→ independent Blocker Verifier
→ bounded Remediation Planner
→ independent Task Preflight
→ additive DAG generation
→ repair Worker
→ affected Slice Gates
→ fresh three-axis audit
```

Architecture changes, public Interface changes, scope changes, missing evidence, unsafe repository operations, or unresolved product choices stop at an immutable Human Decision Gate. Recording an answer and resuming execution are separate actions.

## Features

- Persistent Work Item and Issue Runtime state.
- Atomic state files plus append-only events.
- Immutable PRD, Issue, Task Plan, DAG, Review, Audit, Binding, and Receipt history.
- Deterministic DAG validation and frontier scheduling.
- Full Acceptance traceability from PRD to Issue, Slice, Task, Gate, and Audit.
- Model profiles and role-based routing through `.pi/forge.json`.
- Binding-bound `pi-subagents` Workers, Reviewers, Verifiers, and Planners.
- Independent Task Preflight before Task contracts are frozen.
- Decision-free Blueprint Steps with stable IDs, Expected Evidence, Expected Patch Shape, Forbidden Changes, and Stop Conditions.
- Exact Task context, declared Write boundaries, and Handoff traceability for every Blueprint Step.
- One Binding-bound pre-commit Task Conformance Audit with bounded same-Task correction.
- Authoritative verification and clean Git baseline enforcement.
- Scoped product-facing commits with immutable execution Receipts.
- Slice Gate evidence with mechanical Fast completion or final three-axis Issue audit.
- Additive remediation and explicit Human Decision gates.
- Idempotent submissions and recovery from interrupted lifecycle events.

## Requirements

- Node.js `>= 22.19.0`.
- [Pi](https://pi.dev) with at least one available reasoning-capable model.
- [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) with Cross-extension RPC protocol v2.
- A target Git repository with at least one commit.
- A clean Git workspace before Task execution.
- A persistent interactive Pi session while background Workers and Reviewers are running.

The current MVP executes only:

```text
workspace.mode: shared-serial
isolationBackend: none
poolSize: 1
```

## Usage

Run Pi from the Forge Control Workspace. In a single-repository project this is the repository itself; in a multi-repository setup it may be a non-Git parent directory containing `.pi`, `.forge`, and several independent repositories.

### 1. Configure the repository

```text
/skill:forge-init
```

`forge-init` scans Git, package scripts, available models, tracker CLIs, repository instructions, architecture/context documents, Agent directories, and `pi-subagents`. It previews all changes before writing.

The normal setup creates or updates:

```text
.pi/forge.json
.pi/subagents.json
.pi/agents/*.md
AGENTS.md or the active Pi context file
.gitignore
```

Accept the recommended configuration or review each section. Explicitly approve the preview before Apply, then run:

```text
/reload
```

### 2. Create and freeze the PRD

```text
/skill:forge-prd

Build configurable request timeouts while preserving omission behavior.
```

Forge synthesizes the conversation, records repository evidence and open decisions, generates `PRD.md`, starts the three review axes, verifies Blockers when necessary, and asks for explicit approval before Freeze.

Keep the returned Work Item root, for example:

```text
.forge/work-items/WI-0001-configurable-request-timeout-a1b2c3d4
```

### 3. Materialize Issues

```text
/skill:forge-issues

Work Item root: .forge/work-items/WI-0001-configurable-request-timeout-a1b2c3d4
```

Every frozen Delivery Boundary becomes exactly one Local Issue artifact.

### 4. Generate Slices and behavior-complete Tasks

```text
/skill:forge-tasks

Work Item root: .forge/work-items/WI-0001-configurable-request-timeout-a1b2c3d4
Issue: I001
```

Forge traces the implementation flow, creates vertical Slices and behavior-complete Tasks with detailed decision-free Blueprint Steps, and starts an independent Preflight. The Runtime is initialized only after Preflight passes.

### 5. Execute and recover

```text
/skill:forge-run

Runtime root: .forge/work-items/WI-0001-configurable-request-timeout-a1b2c3d4/issues/I001/runtime
```

Keep the interactive Pi session open. `forge-run` advances only the next deterministic action: start a Worker, finalize a Handoff, verify and stage a Task, run its single pre-commit Conformance Audit, commit an unchanged passed patch, retry the same Task from Correction Context, run a Slice Gate, complete a Fast Issue mechanically, start final Audits for Standard/High Assurance, or enter remediation/human-decision recovery.

## Generated artifacts

Work Item directories use a monotonically increasing, never-reused display number such as `WI-0001`, so filesystem name order matches creation order. The readable slug and random suffix retain readability and unique identity; the immutable internal `workItemId` does not include the display number.

With the default artifact root, a Work Item resembles:

```text
.forge/work-items/WI-0001-<work-item>/
├── PRD.md
├── prd/
│   ├── prd.json
│   └── generations/prd-1.json
├── reviews/
├── receipts/
└── issues/
    ├── manifest.json
    ├── generations/issues-1.json
    └── I001/
        ├── issue.json
        ├── ISSUE.md
        ├── task-preflight/
        ├── task-generations/tasks-1.json
        ├── task-manifest.json
        ├── slices/S001/SLICE.md
        ├── tasks/T001/TASK-V001.md
        └── runtime/
            ├── manifest.json
            ├── dag.json
            ├── generations/
            ├── state.json
            ├── events.jsonl
            ├── bindings/
            ├── receipts/T001-V001.json
            └── audits/
                └── tasks/T001/
                    ├── conformance-1-surface.json
                    └── conformance-1-result.json
```

The artifact root defaults to `.forge` and is normally Git-ignored. It contains machine-specific Runtime identity, local paths, model routing, and execution evidence; do not publish generated Work Items unless intentionally sanitized.

## Configuration

The fixed configuration path is:

```text
.pi/forge.json
```

`forge-init` generates it from the models and repository facts available on the user's machine. Major sections include:

- artifact root and Git policy;
- Local Issue artifact policy;
- the implemented shared-serial workspace policy;
- model profiles and role routing;
- PRD review assurance and Blocker verification;
- authoritative typecheck, test, lint, and build commands;
- Agent template location;
- repository instructions and architecture context sources.

Do not copy another machine's generated `.pi/forge.json`; run `/skill:forge-init` in each target repository.

## Development

```bash
npm install
npm run typecheck
npm test
```

Optional deterministic demos:

```bash
npm run demo
npm run demo:prd
```

Load the Extension directly during development:

```bash
pi -e ./extensions/forge-workflow/index.ts
```

After changing Extension or Skill files in a running Pi session, use `/reload`.

## Current limitations

- Only the `shared-serial + none + poolSize 1` execution path is implemented.
- Local Issue artifacts are authoritative; external tracker publication is outside the current release.
- Frozen PRDs and Issues are not amended in place. A planning change creates a successor Work Item and leaves the predecessor Runtime immutable.
- Evidence mapping and minimum-sufficient design selection run inside `forge-prd`; there are no separate Map, Design, Options, or Spec artifacts.
- There is no Forge-specific progress UI.
- Automatic lifecycle continuation requires a live Pi session; a one-shot `pi -p` process is unsuitable for long-running background execution.
- Recovery relies on Runtime state and lifecycle events because richer `pi-subagents` status/resume RPC is not yet available.
- The project is pre-release and its artifact schemas may still change.

## Security model

Pi Packages execute code with the user's permissions. Review this package and its dependencies before installation.

Forge reduces workflow ambiguity, but it is not a sandbox. The current MVP intentionally uses the target repository directly in shared-serial mode. It enforces clean Git baselines, declared Writes, scoped rollback, authoritative verification, and fail-closed Human Decision gates; operating-system isolation remains the user's responsibility.
