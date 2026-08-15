# Forge Task Plan contract

A Task is one behavior-complete result. Put detailed implementation micro-steps inside its ordered Blueprint instead of creating one Runtime Task for each step.

```json
{
  "workItemRoot": "/repo/.forge/work-items/example",
  "issueId": "I001",
  "slices": [
    {
      "id": "S001",
      "title": "Timeout behavior",
      "goal": "Prove explicit and omitted timeout behavior through the client seam.",
      "acceptanceIds": ["AC-01"],
      "taskIds": ["T001"],
      "gate": [
        {
          "command": "npm test -- timeout",
          "timeoutMs": 120000,
          "proves": "Explicit and omitted timeout behavior pass through the public client seam"
        }
      ]
    }
  ],
  "tasks": [
    {
      "id": "T001",
      "title": "Carry timeout through the client configuration seam",
      "sliceId": "S001",
      "goal": "Expose, consume, and verify timeoutMs without changing omission behavior.",
      "editPoint": { "path": "src/config.ts", "symbol": "AppConfig" },
      "reads": [
        { "path": "src/config.ts", "symbol": "AppConfig", "reason": "Defines the configuration contract and factory literal" },
        { "path": "src/client.ts", "symbol": "createClient", "reason": "Consumes the existing AppConfig value" },
        { "path": "src/client.test.ts", "symbol": "timeout behavior", "reason": "Existing focused assertion seam" }
      ],
      "writes": ["src/config.ts", "src/client.ts", "src/client.test.ts"],
      "dependencies": [],
      "conflicts": [],
      "produces": ["AC-01 timeout behavior"],
      "consumes": [],
      "acceptanceIds": ["AC-01"],
      "implementationBlueprint": [
        {
          "id": "BP-01",
          "instruction": "Add readonly timeoutMs using the frozen unit immediately after retries in AppConfig.",
          "expectedEvidence": ["src/config.ts#AppConfig field diff"]
        },
        {
          "id": "BP-02",
          "instruction": "Populate timeoutMs in the existing createConfig object literal without introducing another configuration object.",
          "expectedEvidence": ["src/config.ts#createConfig literal diff"]
        },
        {
          "id": "BP-03",
          "instruction": "Read timeoutMs from AppConfig at the existing createClient request construction seam and leave the omitted branch unchanged.",
          "expectedEvidence": ["src/client.ts#createClient request diff", "Omitted branch remains present"]
        },
        {
          "id": "BP-04",
          "instruction": "Extend the existing timeout test with one explicit-value assertion and one omission assertion; do not create a second suite.",
          "expectedEvidence": ["src/client.test.ts#timeout behavior assertions"]
        },
        {
          "id": "BP-05",
          "instruction": "Run the frozen focused verification command and preserve its bounded output for Handoff.",
          "expectedEvidence": ["npm test -- timeout exits 0"]
        }
      ],
      "expectedPatchShape": [
        "One AppConfig field and factory literal update in src/config.ts",
        "One existing request-construction update in src/client.ts",
        "Focused explicit and omitted assertions in the existing timeout test"
      ],
      "forbiddenChanges": [
        "No retry behavior change",
        "No fallback or default timeout substitution",
        "No transport abstraction, feature flag, or second configuration object",
        "No unrelated rename, formatting, or cleanup"
      ],
      "stopConditions": [
        "Stop if AppConfig, createConfig, createClient, or the existing timeout test seam is absent",
        "Stop if implementing the behavior requires another public Interface or Write path",
        "Stop if omission behavior differs from the frozen Issue contract"
      ],
      "outOfScope": ["Changing retry behavior", "Adding transport configuration"],
      "verification": [
        { "command": "npm test -- timeout", "timeoutMs": 120000 }
      ],
      "modelProfile": "simple"
    }
  ]
}
```

Before constructing this payload, trace one ordered implementation flow: entry/input boundary → normalization or transformation → owning Module → downstream consumer/side effect → observable Test Seam. Every hop names an exact `path#Symbol`, value/artifact, and changed or unchanged branch. Tasks follow that real flow. Every dependency must have a matching `Consumes` entry and the producer must declare the exact artifact in `Produces`; preferred coding order is not a dependency. Paths are repository-relative. Verification timeout is between 1 second and 30 minutes.

One Task may contain many detailed Blueprint Steps and up to three inseparable Writes when they jointly produce one behavior-complete result and one useful product-facing commit. A Blueprint that writes tests names the exact import or fixture seam, insertion point, test name, literal or constructed input, expected output or exact error assertion, and the existing assertion that must remain unchanged; category-only instructions are rejected. Split only when the results can be independently implemented, verified, committed, rolled back, and consumed. A Blueprint Step ID is contiguous (`BP-01...`) and immutable. `expectedEvidence` states what the Worker must cite in `task_handoff`. `expectedPatchShape` accounts for every intended changed surface. `forbiddenChanges` removes adjacent scope. `stopConditions` require the Worker to checkpoint and stop instead of improvising when repository evidence no longer matches the frozen contract.

Keep app entry points and Composition Roots limited to wiring and orchestration; place cohesive behavior in its existing owning Module. Create a new Module only when no suitable owner exists and the responsibility is independently coherent. Fallback is default-deny and may appear only when frozen behavior explicitly requires the exact branch and its verification. If the Worker would need to search for callers, infer fallback semantics, choose an implementation, add an unlisted Write, or decide between alternatives, the contract is not self-contained and must be refined before Freeze.
