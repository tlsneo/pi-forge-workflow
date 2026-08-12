---
name: forge-options
description: Run an identity-hidden multi-agent option tournament over one frozen design brief. Use from forge-design or when several semantic architecture options need independent generation, validation, judging, and synthesis.
disable-model-invocation: true
---

# Forge Options

This internal contract is not executable until the Forge Tournament Orchestrator creates model-routed Jobs and Bindings. Do not substitute generic pi-subagents.

Treat the frozen Brief as immutable tournament input.

1. Freeze the Brief hash, hard constraints, evidence pointers, output schema, and evaluation rubric.
2. Generate at least three materially different candidates in parallel. Each Candidate reads the same Brief and cannot read another Candidate.
3. Use distinct Strategy Prompts: existing-seam reuse, minimum new surface, module depth and testability, plus a contrarian simplification when useful.
4. Run a deterministic Validator over schema, acceptance coverage, forbidden scope, dependency direction, and evidence references. Archive every rejection reason.
5. Hide Candidate identity and model metadata from independent Judges. Judges did not generate candidates.
6. Compare surviving candidates on requirement fit, architecture fit, minimality, locality, testability, risk, and implementation cost.
7. Have a separate Synthesizer recommend one candidate or an explicitly sourced combination that introduces no unevaluated contradiction.
8. Persist candidates, validation results, Judge reports, disagreements, model profiles, cost evidence, and recommendation.

Completion criterion: every candidate is either mechanically rejected with a reason or independently compared, and the recommendation can be traced to evaluated candidate material.

Phase boundary: provide ranked options and unresolved tradeoffs; do not freeze product or architecture changes that require user approval.
