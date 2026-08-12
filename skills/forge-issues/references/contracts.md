# Forge Local Issue contract

`forge_issues_submit` accepts a complete ordered list. IDs are contiguous from `I001`.

```json
{
  "workItemRoot": "/repo/.forge/work-items/example",
  "issues": [
    {
      "id": "I001",
      "deliveryBoundaryId": "DB-01",
      "title": "Add configurable CLI timeout",
      "goal": "Allow CLI users to bound request duration.",
      "deliveryOutcome": "A valid timeout crosses the CLI, configuration, and client seams and is observable by an integration test.",
      "scope": [
        "Accept the frozen timeout behavior",
        "Preserve omission defaults"
      ],
      "nonGoals": [
        "Change retry policy"
      ],
      "acceptanceIds": [
        "AC-01"
      ],
      "behavior": {
        "happyPath": [
          "Parse timeout",
          "Create configuration",
          "Configure client"
        ],
        "errorPaths": [
          "Reject non-positive values"
        ],
        "edgeCases": [
          "Omitted timeout preserves current defaults"
        ]
      },
      "decisionIds": [
        "D-01"
      ],
      "impactEvidenceIds": [
        "E-01"
      ],
      "testSeamNames": [
        "CLI integration"
      ],
      "verification": [
        "CLI integration test",
        "Assert the configured client timeout"
      ],
      "dependencies": []
    }
  ]
}
```

The Runtime derives source identity, PRD and Receipt hashes, Artifact Hashes, Acceptance Traceability, Local paths, timestamps, and tracker mode. Keep `decisionIds` and `impactEvidenceIds` in the PRD's flow-relevant order so `forge-tasks` receives the selected ownership, dependency direction, input-to-consumer path, Test Seam, default-deny Fallback constraints, and Composition-Root boundary without reopening architecture. `DB-01` maps to `I001`, and every frozen Delivery Boundary must be materialized exactly once. Goal, delivery outcome, scope, Acceptance, behavior, Decisions, Evidence, Test Seams, non-goals, verification, and dependencies must exactly match that boundary. Scope, goal, title, and delivery outcome are Issue-level descriptions but cannot expand the frozen behavior. The Issue is a delivery boundary, not an implementation plan: it carries frozen architecture constraints but must not invent Slices, file splits, new Modules, fallback behavior, or Task sequencing.
