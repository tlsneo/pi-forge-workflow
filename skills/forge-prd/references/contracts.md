# Forge PRD tool contracts

Read this before calling `forge_prd_checkpoint`, `forge_prd_submit`, `forge_prd_review`, or `forge_prd_supersede`.

## Frozen Work Item supersession

A frozen PRD is never amended in place. When later evidence requires a change to Acceptance, Scope, public Interface, compatibility, security, or selected architecture, call `forge_prd_supersede` with the frozen `workItemRoot`, reason, actor, and authorization evidence. Runtime creates a new discovery Work Item whose Manifest records the predecessor Work Item ID/root and frozen PRD Generation/hash. The predecessor PRD, Issues, Tasks, Runtime, commits, Receipts, and Audits remain immutable.

## Discovery checkpoint

```json
{
  "decisions": [
    {
      "id": "Q1",
      "question": "Which timeout unit is public?",
      "dependsOn": [],
      "status": "answered",
      "recommendedAnswer": "Milliseconds",
      "answer": "Milliseconds",
      "answerSource": "user"
    }
  ],
  "evidence": [
    {
      "id": "E1",
      "path": "src/config.ts",
      "symbol": "AppConfig",
      "claim": "The HTTP client factory consumes AppConfig.",
      "repositoryRevision": "<exact manifest revision>"
    }
  ],
  "summary": "Timeout behavior and its configuration seam are settled.",
  "status": "drafting"
}
```

Decision status is `open`, `answered`, or `external`. An answered decision requires `answer` and `answerSource` (`user`, `repository`, or `external`). An external decision has no answer and uses Work Item status `needs_external_input`.

Every PRD evidence object must exactly match an object saved by the latest checkpoint.

## PRD

```json
{
  "title": "CLI timeout",
  "problem": "Users cannot bound request duration.",
  "solution": "Accept a timeout option and carry it to the HTTP client.",
  "goals": ["Allow an explicit timeout"],
  "nonGoals": ["Change retry behavior"],
  "actors": ["CLI user"],
  "userStories": [
    {
      "id": "US-01",
      "actor": "a CLI user",
      "capability": "set a request timeout",
      "benefit": "hung requests stop predictably"
    }
  ],
  "acceptance": [
    {
      "id": "AC-01",
      "statement": "A valid timeout reaches the HTTP client.",
      "verification": ["CLI integration test observes the exact timeout"]
    }
  ],
  "behavior": {
    "happyPath": ["Parse", "configure", "apply"],
    "errorPaths": ["Reject non-positive values"],
    "edgeCases": ["Omission preserves the current default"]
  },
  "decisions": [
    {
      "id": "D-01",
      "decision": "Carry timeout through AppConfig.",
      "rationale": "It is the existing configuration seam.",
      "evidenceIds": ["E1"],
      "alternatives": ["Pass a second argument through every caller"]
    }
  ],
  "impactEvidence": ["<exact evidence objects from checkpoint>"],
  "testSeams": [
    {
      "name": "CLI integration",
      "level": "integration",
      "evidenceIds": ["E1"],
      "verification": "Assert the configured client timeout."
    }
  ],
  "risks": [
    {
      "risk": "Unit mismatch",
      "mitigation": "Use timeoutMs across the data path."
    }
  ],
  "deliveryBoundaries": [
    {
      "id": "DB-01",
      "title": "Deliver CLI timeout behavior",
      "outcome": "Explicit and omitted timeout behavior is independently deliverable and verifiable.",
      "goal": "Deliver configurable timeout behavior through the existing configuration seam.",
      "scope": ["Parse, carry, apply, and verify the timeout while preserving omission behavior"],
      "acceptanceIds": ["AC-01"],
      "behavior": {
        "happyPath": ["Parse", "configure", "apply"],
        "errorPaths": ["Reject non-positive values"],
        "edgeCases": ["Omission preserves the current default"]
      },
      "decisionIds": ["D-01"],
      "impactEvidenceIds": ["E1"],
      "testSeamNames": ["CLI integration"],
      "nonGoals": ["Change retry behavior"],
      "verification": ["CLI integration test observes the exact timeout", "Assert the configured client timeout."],
      "dependencies": [],
      "independentlyDeliverable": true,
      "rationale": "The behavior shares one delivery and rollback boundary."
    }
  ],
  "migration": "Optional migration text",
  "rollback": "Revert the option and mapping commits.",
  "diagrams": [
    {
      "kind": "flow",
      "title": "Timeout data flow",
      "rationale": "The value crosses multiple modules.",
      "mermaid": "flowchart LR\n  CLI --> Config\n  Config --> Client"
    }
  ],
  "openQuestions": []
}
```

Diagram kinds and required first Mermaid statements:

```text
flow     → flowchart or graph
sequence → sequenceDiagram
state    → stateDiagram or stateDiagram-v2
er       → erDiagram
```

The Mermaid value contains source only, without Markdown fences. An empty diagrams array is valid.

Delivery Boundary IDs are contiguous `DB-01...`. Every Acceptance belongs to at least one boundary. Use one boundary by default. Multiple boundaries are valid only when every boundary is independently implementable, verifiable, deliverable, and closeable. A boundary requires non-empty Evidence and Test Seams. Its `verification` is the exact ordered, de-duplicated concatenation of every owned Acceptance verification array followed by every named Test Seam verification string. `forge-issues` accepts no Issue proposal; it materializes the frozen boundaries directly as `DB-01 → I001`, `DB-02 → I002`.

## Amendment

A confirmed Blocker or explicit user correction creates a new immutable generation:

```json
{
  "reason": "Resolve the Architecture blocker by naming the concrete timeout application seam.",
  "authorizedBy": "user",
  "authorizationEvidence": "Exact user statement or durable reference",
  "prd": "<complete amended PRD object>"
}
```

Runtime computes axis-specific surface hashes. Passed reviews carry forward only when their axis surface is byte-for-byte equivalent after canonical hashing. Blocked reviews and changed surfaces are invalidated. The tool result lists both sets.

## Review

Each automated axis uses a different immutable Binding ID and its exact value from `currentPrd.reviewSurfaceHashes`, not the whole PRD content hash. `forge_prd_submit` and `forge_prd_amend` create and start these Jobs automatically.

```json
{
  "bindingId": "<exact Review Binding ID>",
  "axis": "coverage",
  "verdict": "passed",
  "surfaceHash": "<current axis-specific review surface hash>",
  "findings": [
    {
      "id": "F-COV-001",
      "severity": "warning",
      "message": "One compatibility edge case should be made explicit.",
      "evidence": ["PRD#Behavior"],
      "violatedRule": "Compatibility behavior must be explicit.",
      "verification": "Read the omission and upgrade behavior in PRD#Behavior.",
      "suggestedResolution": "Add the missing edge case without changing scope."
    }
  ]
}
```

Axes are `coverage`, `evidence`, and `architecture`. Verdict is `passed` or `blocked`. A Blocker finding requires an ID, evidence, violated rule, and reproducible verification; it prevents a passed verdict.

## Blocker verification

After all axes submit, Runtime automatically creates a different-Binding Verifier Job when Blockers exist. The Verifier calls `forge_prd_verify_blockers` exactly once:

```json
{
  "bindingId": "<exact Verifier Binding ID>",
  "results": [
    {
      "findingId": "F-ARCH-001",
      "status": "confirmed",
      "evidence": ["src/client.ts#createClient"],
      "rationale": "The cited function exposes no application seam."
    }
  ]
}
```

Statuses are `confirmed`, `rejected`, and `needs_more_evidence`. The last status also requires `missingEvidence`. After a coordinator restart, `forge_prd_resume_reviews` explicitly invalidates orphan live-looking Bindings and starts fresh attempts.
