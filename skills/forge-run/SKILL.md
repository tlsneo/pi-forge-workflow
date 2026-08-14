---
name: forge-run
description: Execute or recover one finalized shared-serial Forge Issue Runtime through decision-free Workers, authoritative verification, one pre-commit Task Conformance Audit, scoped Git commits, Slice Gates, and Assurance-dependent completion.
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
- freeze the staged patch and start exactly one Binding-bound read-only Task Conformance Auditor before commit;
- commit only a patch whose Conformance Result passed and whose patch hash is unchanged, using exactly the frozen Task title without workflow metadata, then write the immutable Receipt;
- roll back declared Task paths and schedule a bounded Retry after ordinary verification failure or a blocked Task Conformance Result;
- block immediately on undeclared Writes or unsafe Git state;
- run a ready Slice Gate;
- start the next dependency-free Task Worker;
- complete a Fast Issue mechanically after all Slice Gates pass;
- or start final Issue Auditors for Standard and High Assurance.

A Worker must call `task_resume`, follow only the exact versioned contract path frozen in its Binding, such as `TASK-V001.md`, and any frozen Correction Context returned by Runtime. It executes every `BP-xx` Step in order, obeys Expected Patch Shape, Forbidden Changes, Stop Conditions, and the fixed Minimal Implementation Policy, checkpoints semantic progress, maps every Step to concrete Handoff Evidence, calls `task_handoff` once, and stops. Fallback is default-deny. Cohesive behavior belongs in its owning Module rather than an app/composition-root file, but file count is not a goal and one-function pass-through Modules are forbidden. Worker-reported command results are advisory; the coordinator reruns every frozen verification command authoritatively.

Wait for the lifecycle event after a Worker or Auditor starts, then call `forge_run_continue` again. Do not manually edit state, commit Worker changes, or invent a new dependency.

## 3. Task completion

A Task completes only after:

```text
valid Binding
+ structured Handoff with Evidence for every BP-xx Step
+ terminal Worker
+ authoritative Git diff within Writes
+ all frozen verification commands and git diff --check pass
+ one Binding-bound Task Conformance Result passed
+ audited patch hash unchanged
+ scoped Git commit
+ immutable Task Receipt
```

The Task Conformance Auditor reads only `TASK-V001.md`, the immutable Conformance Surface, staged diff, exact Reads, and changed Writes. It checks correctness, Blueprint traceability, Expected Patch Shape, Forbidden Changes, Minimality, local safety, and concrete concurrency risk. It never redesigns the Issue. A passed Result allows commit. A blocked Result restores only the Task's declared paths to its Binding baseline and schedules one Correction Attempt of the same frozen Task with the immutable Finding as Correction Context; it does not start an Issue Remediation Planner. Ordinary verification failure uses the same bounded Task retry. Undeclared writes, missing Blueprint Evidence, patch-hash drift, rollback ambiguity, or commit failure are fail-closed Blockers. A failed Slice Gate uses the same bounded Remediation Planner and Preflight path as a confirmed final Audit repair; it does not create a second repair framework.

## 4. Slice Gates

When every Task in a Slice has a Receipt, Runtime runs the frozen Slice Gate commands. Every Gate stores command, exit code, bounded output, and completion time. A failed Gate blocks the Issue.

When all Gates pass:

- `fast` still requires the single pre-commit Conformance Audit for every Task, then writes a mechanical `runtime/audits/issue-final.json` from audited Task Receipts and Slice Gate evidence and moves directly to `completed` without starting a final Issue Auditor, Blocker Verifier, Remediation Planner, or Re-audit;
- `standard` and `high-assurance` move to `auditing` and retain the current three-axis final Audit path.

The Assurance Profile is frozen into the Issue Runtime manifest when the Task Plan is created. Legacy Runtimes default to `standard`.

## 5. Final Issue Audit

For Standard and High Assurance, Runtime automatically starts three independent read-only `forge-reviewer` Bindings:

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
Fast: mechanical final Receipt exists
Standard / High Assurance: all three Audits passed
```

If a final Auditor reports a Blocker, `forge_run_audit_submit` records the immutable Finding, marks the Issue `blocked`, emits `forge:issue-audit-blocked`, and automatically starts an independent different-model Blocker Verifier. The Verifier must cover every current Finding exactly once as `confirmed`, `rejected`, or `needs_more_evidence` through `forge_run_audit_blockers_verify`.

Confirmed Findings automatically start a Binding-bound `forge-designer` Remediation Planner. Autonomous remediation must stop and create a structured Human Decision Request when repository evidence cannot determine the answer, the repair conflicts with repository instructions, frozen PRD/Issue requirements, accepted Decisions, Audit Findings, Task/DAG contracts, Git/workspace rules, changes architecture/public Interface/scope, requires an unsafe repository operation, or presents materially different product choices. Before planning it must read the frozen PRD, selected Issue artifact/`ISSUE.md`, current DAG, completed Receipts, and confirmed Findings. PRD Acceptance, approved Decisions, Issue Scope/non-goals/behavior, and existing architecture seam are authoritative immutable constraints. The Planner submits only detailed Micro Tasks and affected Slice IDs through `forge_run_remediation_propose`. Those Tasks receive an independent Binding-bound Preflight through `forge_run_remediation_preflight_submit`. A pass appends an immutable DAG Generation, preserves every completed Task, Receipt, Commit, old Audit and old DAG, resets only affected Slice Gates, clears the current audit cycle, and resumes Worker scheduling. After repair Tasks complete, affected Gates and all three final Audits rerun. Rejected Findings trigger a fresh Audit cycle without a repair. Human gates are immutable artifacts with a question, reason, evidence, 2-4 explicit options, consequences, optional recommendation, and one bounded resume action. The user answer must include identity, rationale, evidence, and durable authorization evidence. Recording an answer does not resume execution: `forge_run_human_decision_resume` is a separate explicit action that may only rerun the Verifier, resume the Planner, require a successor Work Item through `forge_prd_supersede`, or abort the Issue. `needs_more_evidence`, repository-rule conflicts, PRD/Issue/Audit/Task/DAG contract conflicts, Acceptance/Decision/architecture/interface/scope changes, unsafe repository operations, or unavailable repository evidence remain fail-closed until that process completes. Coordinator, Auditor, Verifier, Planner, and Reviewer must not directly edit product code or Runtime JSON.

Completion criterion: every Task has a Commit-backed Receipt, every Slice has Gate evidence, the Assurance-appropriate final Receipt exists, and Git is clean.

## Guardrails

- Never run on an uncommitted baseline.
- Git history is a product-facing interface: never expose Forge Issue IDs, Task IDs, Binding IDs, or Runtime metadata in commit subjects.
- Never use `git reset --hard`, broad `git clean`, or an unscoped rollback.
- Coordinator never modifies product files.
- `Agent completed` never implies `Task completed` or `Audit passed`.
- Do not continue a blocked Issue by changing Runtime files or committing outside Forge.
