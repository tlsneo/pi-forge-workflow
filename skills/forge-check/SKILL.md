---
name: forge-check
description: Perform an independent audit of one high-risk Forge Task contract or implementation checkpoint. Use only when the Task contract requires it, the user asks, or policy selects a high-risk checkpoint.
disable-model-invocation: true
---

# Forge Check

This is a conditional Task Audit, not a routine step.

1. Verify that Task Audit is authorized by the frozen contract, user request, or deterministic risk policy.
2. Freeze the Task Audit Surface: contract generation, changed files, dependency receipts, verification evidence, repository rules, and relevant Acceptance IDs.
3. Start an independent read-only Auditor Binding with no product-code or Runtime-write capability.
4. Review repository standards and Task-specific behavior against the frozen surface. Do not redesign the parent Issue.
5. Submit structured findings with severity, evidence, affected contract clause, and a reproducible check.
6. Let Runtime validate and persist the Audit artifact. The Auditor cannot mark the Task complete.
7. Route confirmed Blockers through the Amendment or Remediation protocol; a different Worker performs repairs.

Completion criterion: the authorized Task audit has a valid immutable artifact and no unresolved confirmed Blocker.
