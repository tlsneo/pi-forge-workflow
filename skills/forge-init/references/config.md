# Forge configuration contract

The fixed project config path is `.pi/forge.json`. `artifacts.root` controls where mutable Work Item and Issue Runtime artifacts live.

```json
{
  "schemaVersion": 1,
  "generation": 1,
  "artifacts": {
    "root": ".forge",
    "gitPolicy": "ignore"
  },
  "tracker": {
    "mode": "local",
    "publishRequiresConfirmation": true
  },
  "workspace": {
    "mode": "shared-serial",
    "isolationBackend": "none",
    "poolSize": 1
  },
  "models": {
    "profiles": {
      "simple": { "model": "provider/model", "thinking": "low", "maxTurns": 30 },
      "medium": { "model": "provider/model", "thinking": "high", "maxTurns": 50 },
      "complex": { "model": "provider/model", "thinking": "xhigh", "maxTurns": 100 },
      "audit": { "model": "provider/model", "thinking": "xhigh", "maxTurns": 60 },
      "verifier": { "model": "provider/other-model", "thinking": "high", "maxTurns": 40 }
    },
    "routing": {
      "task.simple": "simple",
      "task.medium": "medium",
      "task.complex": "complex",
      "interactiveExplore": "simple",
      "interactivePlan": "complex",
      "prdResearch": "medium",
      "optionCandidate": "complex",
      "optionJudge": "audit",
      "optionSynthesizer": "complex",
      "prdCoverageReview": "audit",
      "prdEvidenceReview": "audit",
      "prdArchitectureReview": "audit",
      "blockerVerifier": "verifier",
      "taskPreflight": "audit",
      "remediationPlanner": "complex",
      "taskAudit": "audit",
      "issueAudit": "audit"
    }
  },
  "review": {
    "preset": "standard",
    "prd": {
      "coverageReviewers": 1,
      "evidenceReviewers": 1,
      "architectureReviewers": 1
    },
    "blockerVerification": {
      "profile": "verifier",
      "requireDifferentModel": true
    }
  },
  "tournament": {
    "enabled": true,
    "candidates": 3,
    "judges": 2,
    "candidateProfile": "complex",
    "judgeProfile": "audit",
    "synthesizerProfile": "complex",
    "blindReview": true
  },
  "commands": {
    "typecheck": "npm run typecheck",
    "test": "npm test"
  },
  "agents": {
    "directory": ".pi/agents",
    "templateVersion": 2
  },
  "instructions": {
    "file": "AGENTS.md",
    "managedSection": "forge-workflow",
    "templateVersion": 1
  },
  "repositoryContext": {
    "mode": "single-context",
    "entryPoints": ["CONTEXT.md"],
    "architectureDocs": ["docs/architecture"],
    "adrDirectories": ["docs/adr"],
    "supplementalInstructions": ["docs/agents/domain.md"]
  }
}
```

Tracker variants:

```json
{ "mode": "github", "repository": "owner/repo", "publishRequiresConfirmation": true }
```

```json
{ "mode": "gitlab", "project": "group/project", "publishRequiresConfirmation": true }
```

Valid Thinking values are `minimal`, `low`, `medium`, `high`, and `xhigh`. Every profile uses an exact available `provider/model`. `shared-serial` requires backend `none` and pool size `1`; `isolated-pool` requires a non-`none` backend and pool size of at least `2`.

`instructions.file` records Pi's active repository context file. Selection follows Pi's load priority: `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, then `CLAUDE.MD`; Forge creates `AGENTS.md` when none exists. Forge owns only the content between `<!-- pi-forge-workflow:start -->` and `<!-- pi-forge-workflow:end -->`. Content outside those markers remains user-owned.

`repositoryContext` records existing domain and architecture knowledge sources. `forge-init` discovers `CONTEXT.md`, `CONTEXT-MAP.md`, nested Context files, `docs/adr`, `docs/architecture`, and `docs/agents/domain.md`; it does not invent domain content. `forge-prd` reads the applicable sources and compiles their constraints into the frozen PRD, so Issue and Task workers do not re-read the whole repository knowledge base.
