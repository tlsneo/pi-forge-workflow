---
name: forge-design
description: Choose where a requested change belongs in the current architecture using an Impact Map and a Forge option tournament. Use after investigation and before writing a Spec.
disable-model-invocation: true
---

# Forge Design

This internal contract is not connected to the Forge Design Runtime yet. Do not launch generic subagents or simulate an Option Tournament from this Skill.

Select the minimum sufficient architecture.

1. Require a current Impact Map bound to the repository state. Invoke `forge-map` when evidence is missing or stale.
2. Freeze a design Brief containing requested behavior, acceptance intent, constraints, non-goals, impact evidence, and allowed decision surface.
3. Invoke `forge-options` with that Brief.
4. Reject recommendations that add concepts, interfaces, dependencies, compatibility paths, or edit scope without a requirement or architecture constraint.
5. Prefer the smallest design that fits existing ownership, seams, dependency direction, locality, and testability.
6. Ask the user to decide only when surviving disagreement changes user behavior, public interfaces, scope, compatibility policy, or long-lived architecture.
7. Record the selected design: architecture location, data flow, interface changes, expected modification closure, test seams, migration and rollback constraints, rejected alternatives, and remaining risks.
8. Create an ADR only when a rejected alternative is likely to recur and its rejection is not obvious from the code.

Completion criterion: one selected design is supported by repository evidence and tournament comparison, with every material tradeoff resolved or explicitly assigned to the user.

Phase boundary: freeze architecture decisions, not implementation tasks.
