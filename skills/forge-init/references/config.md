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
      "prdCoverageReview": "audit",
      "prdEvidenceReview": "audit",
      "prdArchitectureReview": "audit",
      "blockerVerifier": "verifier",
      "taskPreflight": "audit",
      "taskConformanceAudit": "simple",
      "remediationPlanner": "complex",
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
  "commands": {
    "typecheck": "npm run typecheck",
    "test": "npm test"
  },
  "agents": {
    "directory": ".pi/agents",
    "templateVersion": 5
  },
  "instructions": {
    "file": "AGENTS.md",
    "managedSection": "forge-workflow",
    "templateVersion": 2
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

The current release supports only Local Issue artifacts and `shared-serial + isolationBackend: none + poolSize: 1`. Formal Subagents launch through Nicobailon RPC v1 with `async:true`, `isolation:"none"`, and `context:"fresh"`; generated Agent template version 5 uses strict tool allowlists and `maxSubagentDepth:0`. Legacy `.pi/subagents.json` is neither generated nor authoritative. External tracker publication and isolated workspace pools are not configurable until their execution adapters exist. Existing Configs without `taskConformanceAudit` route it in memory to `task.simple`; Forge does not rewrite the user's Config merely to add this compatibility default.

`review.preset` is frozen into the Issue Runtime when its Task Plan is created. Every new Task Runtime requires one pre-commit Task Conformance Audit per Task. `fast` completes mechanically after audited Task Receipts and all Slice Gates pass; `standard` and `high-assurance` retain final Issue Audits. Existing Runtimes without this field default to `standard`.

`thinking` is a non-empty model capability name, not a Forge-owned enum. Every profile uses an exact available `provider/model`. During scan and validation, Forge accepts exactly the levels reported for that model by Pi's current model registry, including future levels introduced after this Forge release; unsupported levels are rejected rather than inferred or silently changed.

`instructions.file` records Pi's active repository context file. Selection follows Pi's load priority: `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, then `CLAUDE.MD`; Forge creates `AGENTS.md` when none exists. Forge owns only the content between `<!-- pi-forge-workflow:start -->` and `<!-- pi-forge-workflow:end -->`. Content outside those markers remains user-owned.

`repositoryContext` records existing domain and architecture knowledge sources. `forge-init` discovers `CONTEXT.md`, `CONTEXT-MAP.md`, nested Context files, `docs/adr`, `docs/architecture`, and `docs/agents/domain.md`; it does not invent domain content. `forge-prd` reads the applicable sources and compiles their constraints into the frozen PRD, so Issue and Task workers do not re-read the whole repository knowledge base.
