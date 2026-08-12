import { describe, expect, it } from "vitest";
import { demoDag } from "../examples/fixture.js";
import { validateDag } from "../src/runtime/dag.js";
import { RuntimeService } from "../src/runtime/service.js";
import type { TaskDag } from "../src/runtime/types.js";

describe("validateDag", () => {
  it("topologically sorts valid artifact dependencies", () => {
    expect(validateDag(demoDag()).order).toEqual(["T01", "T02"]);
  });

  it("rejects dependencies without matching Consumes", () => {
    const dag = structuredClone(demoDag());
    dag.tasks[1]!.consumes = [];
    expect(() => validateDag(dag)).toThrow("no matching Consumes");
  });

  it("rejects independent overlapping writes without a Conflict", () => {
    const left = demoDag().tasks[0]!;
    const rightInput = {
      id: "T03",
      version: 1,
      title: "Other edit",
      sliceId: "S01",
      dependencies: [],
      conflicts: [],
      writes: ["src/config.ts"],
      produces: ["src/config.ts#other"],
      consumes: [],
      acceptance: ["AC-03"],
      verification: [{ command: "npm test", timeoutMs: 60_000 }],
    };
    const right = { ...rightInput, contractHash: RuntimeService.contractHash(rightInput) };
    const dag: TaskDag = { generation: 1, tasks: [left, right] };
    expect(() => validateDag(dag)).toThrow("overlapping Writes");
  });

  it("rejects cycles", () => {
    const dag = structuredClone(demoDag());
    dag.tasks[0]!.dependencies = ["T02"];
    dag.tasks[0]!.consumes = ["T02::src/client.ts#configuredTimeout"];
    expect(() => validateDag(dag)).toThrow("cycle");
  });
});
