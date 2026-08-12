---
name: forge-run
description: Execute or recover one finalized shared-serial Forge Issue Runtime through pi-subagents Workers, authoritative verification, scoped Git commits, Slice Gates, and three final Issue Audits.
disable-model-invocation: true
---

# Forge Run

The Runtime is authoritative. The coordinator may call workflow tools but never edits product code or Runtime JSON.

## 1. Open the Runtime

Call `forge_run_status` with the exact Runtime root returned by `forge-tasks`. Runtime inherits the Work Item Control Root and Target Repository. Forge configuration, Agent templates, and artifacts remain at the Control Root; product reads, Workers, verification, Audit, Git commits, and rollback operate only in the Target Repository. Require `workspaceRoot` to equal the canonical Target Git Working Tree, a committed clean baseline, `shared-serial` mode, valid Task contracts, and either a ready Frontier or a mechanically recoverable Handoff.

Completion criterion: Issue status, Task states, Bindings, Receipts, Slice Gates, Audit Jobs, and current Frontier are known.

## 2. Continue the deterministic frontier

Call `forge_run_continue`. It performs exactly the next Runtime-allowed action:

- finalize a terminal Agent's valid Handoff;
- run authoritative Task verification;
- compare the real Git diff with declared Writes and Handoff paths;
- create a scoped Task commit whose subject is exactly the frozen Task title, without `forge(...)`, Issue IDs, Task IDs, or workflow metadata, then write the immutable Receipt;
- roll back declared Task paths and schedule a bounded Retry after ordinary verification failure;
- block immediately on undeclared Writes or unsafe Git state;
- run a ready Slice Gate;
- start the next dependency-free Task Worker;
- or start the three final Issue Auditors.

A Worker must call `task_resume`, follow only the exact versioned contract path frozen in its Binding, such as `TASK-V001.md`, obey its fixed Minimal Implementation Policy, checkpoint semantic progress, call `task_handoff` once, and stop. Fallback is default-deny. Cohesive behavior belongs in its owning Module rather than an app/composition-root file, but file count is not a goal and one-function pass-through Modules are forbidden. Worker-reported command results are advisory; the coordinator reruns every frozen verification command authoritatively.

Wait for the lifecycle event after a Worker or Auditor starts, then call `forge_run_continue` again. Do not manually edit state, commit Worker changes, or invent a new dependency.

## 3. Task completion

A Task completes only after:

```text
valid Binding
+ structured Handoff
+ terminal Agent
+ authoritative Git diff within Writes
+ all frozen verification commands pass
+ scoped Git commit
+ immutable Task Receipt
```

Ordinary verification failure restores only the Task's declared paths to its Binding baseline and allows at most one fresh retry in the current MVP. Undeclared writes, rollback ambiguity, or commit failure are fail-closed Blockers. A failed Slice Gate uses the same bounded Remediation Planner and Preflight path as a confirmed final Audit repair; it does not create a second repair framework.

## 4. Slice Gates

When every Task in a Slice has a Receipt, Runtime runs the frozen Slice Gate commands. Every Gate stores command, exit code, bounded output, and completion time. A failed Gate blocks the Issue. All Gates passing moves the Issue to `auditing`.

## 5. Final Issue Audit

Runtime automatically starts three independent read-only `forge-reviewer` Bindings:

- Standards;
- Acceptance / Integration;
- Architecture / Minimality.

Each Auditor calls `forge_run_audit_submit` exactly once. It may report a Blocker only with evidence, a violated hard rule, and reproducible verification. Three passed axes create `runtime/audits/issue-final.json` and move the Issue to `completed`.

A final Audit Blocker enters the independent Verification and Remediation flow below. It remains fail-closed whenever evidence, repository contracts, or required user decisions are unresolved; never bypass a blocked Audit.

## 6. Finish

Repeat `forge_run_status` and `forge_run_continue` until:

```text
issueStatus: completed
all Tasks: completed
all Slice Gates: passed
all three Audits: passed
```

If a final Auditor reports a Blocker, `forge_run_audit_submit` records the immutable Finding, marks the Issue `blocked`, emits `forge:issue-audit-blocked`, and automatically starts an independent different-model Blocker Verifier. The Verifier must cover every current Finding exactly once as `confirmed`, `rejected`, or `needs_more_evidence` through `forge_run_audit_blockers_verify`.

Confirmed Findings automatically start a Binding-bound `forge-designer` Remediation Planner. Autonomous remediation must stop and create a structured Human Decision Request when repository evidence cannot determine the answer, the repair conflicts with repository instructions, frozen PRD/Issue requirements, accepted Decisions, Audit Findings, Task/DAG contracts, Git/workspace rules, changes architecture/public Interface/scope, requires an unsafe repository operation, or presents materially different product choices. Before planning it must read the frozen PRD, selected Issue artifact/`ISSUE.md`, current DAG, completed Receipts, and confirmed Findings. PRD Acceptance, approved Decisions, Issue Scope/non-goals/behavior, and existing architecture seam are authoritative immutable constraints. The Planner submits only detailed Micro Tasks and affected Slice IDs through `forge_run_remediation_propose`. Those Tasks receive an independent Binding-bound Preflight through `forge_run_remediation_preflight_submit`. A pass appends an immutable DAG Generation, preserves every completed Task, Receipt, Commit, old Audit and old DAG, resets only affected Slice Gates, clears the current audit cycle, and resumes Worker scheduling. After repair Tasks complete, affected Gates and all three final Audits rerun. Rejected Findings trigger a fresh Audit cycle without a repair. Human gates are immutable artifacts with a question, reason, evidence, 2-4 explicit options, consequences, optional recommendation, and one bounded resume action. The user answer must include identity, rationale, evidence, and durable authorization evidence. Recording an answer does not resume execution: `forge_run_human_decision_resume` is a separate explicit action that may only rerun the Verifier, resume the Planner, require a successor Work Item through `forge_prd_supersede`, or abort the Issue. `needs_more_evidence`, repository-rule conflicts, PRD/Issue/Audit/Task/DAG contract conflicts, Acceptance/Decision/architecture/interface/scope changes, unsafe repository operations, or unavailable repository evidence remain fail-closed until that process completes. Coordinator, Auditor, Verifier, Planner, and Reviewer must not directly edit product code or Runtime JSON.

Completion criterion: every Task has a Commit-backed Receipt, every Slice has Gate evidence, the final Audit Receipt exists, and Git is clean.

## Guardrails

- Never run on an uncommitted baseline.
- Git history is a product-facing interface: never expose Forge Issue IDs, Task IDs, Binding IDs, or Runtime metadata in commit subjects.
- Never use `git reset --hard`, broad `git clean`, or an unscoped rollback.
- Coordinator never modifies product files.
- `Agent completed` never implies `Task completed` or `Audit passed`.
- Do not continue a blocked Issue by changing Runtime files or committing outside Forge.
