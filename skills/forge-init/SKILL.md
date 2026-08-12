---
name: forge-init
description: Configure one repository for pi-forge-workflow by selecting artifact paths, tracker publication, workspace policy, model tiers, audit assurance, commands, and Agent templates.
disable-model-invocation: true
---

# Forge Init

Configure Forge once per repository. This is a prompt-driven setup over deterministic scan, preview, and apply tools. Read [the config contract](references/config.md) before building the final configuration.

## 1. Scan

Call `forge_init_scan` for the current Forge Control Workspace. The Control Root owns `.pi` and `.forge` and may be a normal directory rather than a Git repository. Summarize what exists and what is missing: optional Control Root Git metadata, tracker CLI/auth, Package Manager, scripts, monorepo signals, instructions, Agent directories, prior artifact directories, available models, and pi-subagents protocol.

Facts are not questions. Do not ask for information the scan already settled.

Completion criterion: repository identity and every configurable branch have current evidence.

## 2. Configure one section at a time

Lead every section with the recommended answer. Give one short explanation only when the choice changes behavior. Ask one section, wait for its answer, then continue. Skip a section when the scan or existing config already settles it.

Sections, in order:

1. **Artifact Root** — recommend `.forge`, but allow any safe repository-relative path.
2. **Issue Artifacts** — use Local artifacts. External tracker publication is not part of the current release.
3. **Workspace** — use the implemented `shared-serial + none + poolSize 1` policy.
4. **Model Profiles** — present the registry-backed simple, medium, complex, audit, and verifier recommendations. Ask whether to accept them as a set before offering per-profile edits.
5. **Audit Assurance** — recommend Standard: one independent reviewer per PRD axis and a different-model Blocker Verifier when available.
6. **Commands** — present detected typecheck, test, lint, and build commands for confirmation.
7. **Agent Templates** — present the recommended project Agent directory and any existing-file conflicts. Install the Task Worker, Remediation Planner, and Reviewer templates plus project overrides that bind `Explore` to the `interactiveExplore`/simple profile and `Plan` to the `interactivePlan`/complex profile. Merge `.pi/subagents.json` with fail-closed unknown-type dispatch (`fallbackSubagent: none`) while keeping default agents enabled; project `Explore` and `Plan` overrides supply their Forge-selected models.
8. **Repository Context** — present discovered `CONTEXT.md`, `CONTEXT-MAP.md`, nested Context files, ADR directories, architecture docs, and `docs/agents/domain.md`. Reuse existing sources; do not invent domain content. Ask only when multiple unindexed Context files make ownership ambiguous.
9. **Repository Instructions** — use Pi's active context file deterministically: `AGENTS.override.md` → `AGENTS.md` → `AGENTS.MD` → `CLAUDE.md` → `CLAUDE.MD`; create `AGENTS.md` when none exists. Do not ask in the normal case. Require explicit confirmation before writing `AGENTS.override.md`, and report any lower-priority files shadowed by the selected file.

If the user says “all recommended”, retain every recommendation and stop asking except for unresolved conflicts, `AGENTS.override.md` confirmation, or missing required capabilities.

Completion criterion: one complete Forge config exists in memory and every deviation from the scan recommendation is explicit.

## 3. Preview

Call `forge_init_preview`. Show:

- files to create or update;
- unchanged files;
- template conflicts;
- strict pi-subagents settings and preserved unrelated values;
- the selected Repository Context sources and any missing paths;
- the managed Forge block in Pi's selected repository instruction file;
- `.gitignore` change when the Control Root itself is a Git Working Tree, or the explicit warning that no Git ignore update is needed;
- warnings;
- exact model routing;
- preview hash.

Never treat Preview as approval. Ask the user to approve the displayed changes. A locally modified Agent template or managed Forge instruction block requires path-specific overwrite approval. Preserve all repository instruction content outside the `pi-forge-workflow` markers.

Completion criterion: the user explicitly approves the current preview hash and any template overwrites.

## 4. Apply

Call `forge_init_apply` with the approved Preview Hash. Runtime validates paths, models, Thinking, workspace combinations, audit minima, and stale previews; writes `.pi/forge.json` atomically; saves a Config Generation and Receipt; installs versioned templates; updates only the managed Forge instruction block; and updates `.gitignore` when configured.

Then call `forge_init_status` and report the config path, generation, hash, template status, strict pi-subagents status, repository instruction status, tracker mode, workspace mode, and selected model profiles.

Completion criterion: status is configured, all required templates and the managed repository instruction block match, and the applied Receipt references the approved Preview Hash.

## Guardrails

Forge safety invariants are not configurable: distinct review Bindings, independent Blocker verification, confirmation-gated external publication, immutable generations, and `Agent completed ≠ Job completed`.
