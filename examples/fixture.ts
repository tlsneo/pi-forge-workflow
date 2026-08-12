import { RuntimeService } from "../src/runtime/service.js";
import type { ModelPolicy, TaskContract, TaskDag } from "../src/runtime/types.js";

export const modelPolicy: ModelPolicy = {
  defaultProfile: "simple",
  profiles: {
    simple: { model: "test/simple", thinking: "low", maxTurns: 12 },
    rigorous: { model: "test/complex", thinking: "xhigh", maxTurns: 30 },
  },
  roles: {
    "task-worker": "simple",
    "issue-auditor": "rigorous",
  },
};

function contract(input: Omit<TaskContract, "contractHash">): TaskContract {
  return { ...input, contractHash: RuntimeService.contractHash(input) };
}

export function demoDag(): TaskDag {
  const first = contract({
    id: "T01",
    version: 1,
    title: "Add timeout field",
    sliceId: "S01",
    dependencies: [],
    conflicts: [],
    writes: ["src/config.ts"],
    produces: ["src/config.ts#AppConfig.timeoutMs"],
    consumes: [],
    acceptance: ["AC-01"],
    verification: [{ command: "npm test -- config", timeoutMs: 60_000 }],
  });
  const second = contract({
    id: "T02",
    version: 1,
    title: "Apply timeout in client",
    sliceId: "S01",
    dependencies: ["T01"],
    conflicts: [],
    writes: ["src/client.ts"],
    produces: ["src/client.ts#configuredTimeout"],
    consumes: ["T01::src/config.ts#AppConfig.timeoutMs"],
    acceptance: ["AC-02"],
    verification: [{ command: "npm test -- client", timeoutMs: 60_000 }],
  });
  return { generation: 1, tasks: [first, second] };
}
