# Forge Local Issue contract

`forge_issues_submit` accepts only the frozen Work Item root:

```json
{
  "workItemRoot": "/repo/.forge/work-items/example"
}
```

Runtime reads the active frozen PRD Generation and deterministically maps every Delivery Boundary by position:

```text
DB-01 → I001
DB-02 → I002
```

Each generated Issue copies these fields exactly from its boundary:

```text
title
DB id
goal
outcome → deliveryOutcome
scope
nonGoals
acceptanceIds
behavior
decisionIds
impactEvidenceIds
testSeamNames
verification
DB dependencies → matching Issue IDs
```

The Runtime derives source identity, PRD and Receipt hashes, Artifact hashes, Acceptance traceability, Local paths, timestamps, and tracker mode. No Issue proposal is authored by the coordinator or an LLM.

Before PRD Review starts, PRD validation requires every Delivery Boundary to contain:

- contiguous `DB-01...` identity;
- non-empty scope, Acceptance, Evidence, and Test Seams;
- unique frozen references;
- the exact ordered verification closure of its owned Acceptance and Test Seams;
- valid boundary dependencies with no cycle.

Consequently a reviewed and frozen PRD is mechanically materializable as Issues. A repeated call is idempotent. Changing Issue content requires changing the frozen Delivery Plan through a successor Work Item; Issue artifacts are never edited or replaced in place.
