# Forge Task Plan contract

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
      "taskIds": ["T001", "T002"],
      "gate": [
        {
          "command": "npm test",
          "timeoutMs": 120000,
          "proves": "The Slice Acceptance passes through the public behavior seam"
        }
      ]
    }
  ],
  "tasks": [
    {
      "id": "T001",
      "title": "Carry timeout through AppConfig",
      "sliceId": "S001",
      "goal": "Expose timeoutMs at the existing configuration seam.",
      "editPoint": { "path": "src/config.ts", "symbol": "AppConfig" },
      "reads": [
        { "path": "src/config.ts", "symbol": "AppConfig", "reason": "Defines the configuration contract and factory literal" }
      ],
      "writes": ["src/config.ts"],
      "dependencies": [],
      "conflicts": [],
      "produces": ["AppConfig timeout contract"],
      "consumes": [],
      "acceptanceIds": ["AC-01"],
      "implementationBlueprint": [
        "Add timeoutMs to AppConfig using the frozen unit and omission semantics.",
        "Set the value in the existing factory without introducing another configuration object."
      ],
      "outOfScope": ["Changing retry behavior"],
      "verification": [
        { "command": "npm test", "timeoutMs": 120000 }
      ],
      "modelProfile": "simple"
    },
    {
      "id": "T002",
      "title": "Apply and verify timeout",
      "sliceId": "S001",
      "goal": "Consume the frozen configuration artifact at the client test seam.",
      "editPoint": { "path": "src/client.test.ts", "symbol": "timeout behavior" },
      "reads": [
        { "path": "src/client.ts", "symbol": "createClient", "reason": "Consumes AppConfig" },
        { "path": "src/client.test.ts", "symbol": "client tests", "reason": "Existing assertion seam" }
      ],
      "writes": ["src/client.test.ts"],
      "dependencies": ["T001"],
      "conflicts": [],
      "produces": ["AC-01 verification"],
      "consumes": ["T001::AppConfig timeout contract"],
      "acceptanceIds": ["AC-01"],
      "implementationBlueprint": [
        "Add the focused assertion at the existing client seam.",
        "Prove explicit timeout and preserve the frozen omission behavior."
      ],
      "outOfScope": ["Adding a transport abstraction"],
      "verification": [
        { "command": "npm test", "timeoutMs": 120000 }
      ],
      "modelProfile": "simple"
    }
  ]
}
```

Before constructing this payload, trace one ordered implementation flow: entry/input boundary → normalization or transformation → owning Module → downstream consumer/side effect → observable Test Seam. Every hop names an exact `path#Symbol`, value/artifact, and changed or unchanged branch. Tasks follow that real flow. Every dependency must have a matching `Consumes` entry and the producer must declare the exact artifact in `Produces`; preferred coding order is not a dependency. Paths are repository-relative. Verification timeout is between 1 second and 30 minutes.

Prefer many small, useful commits without fragmenting ownership. A Task normally reads one or two exact symbols and writes one primary file. Keep app entry points and Composition Roots limited to wiring and orchestration; place cohesive behavior in its existing owning Module. Create a new file only when no suitable owner exists and the responsibility is independently coherent. Split by responsibility, not line count, and reject one-function pass-through Modules. Fallback is default-deny and may appear in a Blueprint only when frozen behavior explicitly requires the exact branch and its verification. Multiple sequential Tasks may edit the same file. Blueprint steps must be implementation instructions rather than summaries: name the insertion or replacement point, existing symbols to reuse, value flow, exact branch behavior, behavior that remains unchanged, focused assertions, and forbidden adjacent edits. If the Worker would need to search for callers, infer fallback semantics, or choose an implementation, the contract is not self-contained and must be refined or split.
