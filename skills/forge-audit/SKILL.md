---
name: forge-audit
description: Run the final Forge Issue audit after all Tasks and Slice gates complete, using independent Standards, Spec/Integration, and Architecture/Minimality reviewers plus Blocker verification.
disable-model-invocation: true
---

# Forge Audit

Audit the completed Issue once across three independent axes.

1. Require completed Task Receipts, passed Slice Gates, frozen Spec and Issue hashes, selected design, repository baseline, and final diff.
2. Freeze separate Audit Surfaces for Standards, Spec/Integration, and Architecture/Minimality.
3. Launch three independent read-only Auditor Bindings. No Auditor edits code or Runtime state.
4. Collect structured findings with severity, evidence, affected Acceptance or rule, and reproducible verification.
5. Launch a new independent Blocker Verifier to confirm or reject all reported Blockers in one pass.
6. For confirmed Blockers, create scoped Remediation proposals. Runtime validates a new DAG Generation; a separate Repair Worker implements each approved Task.
7. Re-run affected Slice Gates and only the invalidated Audit checkpoints after remediation.
8. Pass the Issue only when all three audit jobs pass and no confirmed Blocker remains.

Architecture/Minimality must challenge unnecessary concepts, interfaces, dependencies, fallbacks, compatibility layers, duplicated implementations, and edits outside the approved closure.

Completion criterion: immutable artifacts exist for all three audits and Blocker verification, all required replay checks pass, and Runtime—not an Auditor—marks the Issue complete.
