---
name: forge-map
description: Map a requested code change from user entry through interfaces, call paths, data flow, consumers, constraints, and tests. Use before designing a change or freezing a Spec when repository impact is not already proven.
disable-model-invocation: true
---

# Forge Map

This internal contract is not connected to a Forge-controlled Research Job yet. Do not launch generic `Agent`, `Explore`, or `Plan` agents from this Skill; use it only for manual inspection until the deterministic orchestrator exists.

Build evidence before design.

1. Read repository instructions and any current architecture map.
2. Locate the user-visible entry point and current behavior.
3. Trace the relevant public interface, call chain, data flow, adapters, and direct and indirect consumers.
4. Locate schemas, configuration, permissions, caches, migrations, generated artifacts, tests, fixtures, and deployment constraints that can affect correctness.
5. Record every relevant `path#Symbol` with its role and current-code evidence.
6. Separate proven facts, risks, and unresolved unknowns.
7. Update the low-resolution Architecture Map only where the durable module index changed.
8. Write the change-specific Impact Map to the Work Item artifact path supplied by Forge Runtime.

The Impact Map must contain: user entry, call chain, data flow, consumers, contracts, invariants, test seams, expected change closure, risks, and unknowns.

Completion criterion: every behaviorally relevant edge is backed by current repository evidence, and no unresolved unknown can change the requested behavior or design boundary.

Phase boundary: produce evidence, not a solution, Spec, Issue, or Task plan.
