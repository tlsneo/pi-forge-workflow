import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { demoDag, modelPolicy } from "./fixture.js";
import { RuntimeService } from "../src/runtime/service.js";

const runtimeRoot = resolve(".prototype-runtime");
await rm(runtimeRoot, { recursive: true, force: true });

const service = new RuntimeService(runtimeRoot);
const dag = demoDag();
await service.initialize({
  workItemId: "work-item-timeout",
  issueId: "issue-timeout",
  issueHash: "issue-hash-demo",
  workspaceRoot: process.cwd(),
  workspaceMode: "shared-serial",
  issueModelProfile: "simple",
  auditModelProfile: "rigorous",
  modelPolicy,
}, dag);

console.log("Initial frontier:", await service.frontier());
const t01 = dag.tasks[0];
if (!t01) throw new Error("Missing T01");
const binding = RuntimeService.createBinding({
  workItemId: "work-item-timeout",
  issueId: "issue-timeout",
  taskId: t01.id,
  taskVersion: t01.version,
  taskContractPath: `tasks/${t01.id}/TASK-V${String(t01.version).padStart(3, "0")}.md`,
  attempt: 1,
  workspace: process.cwd(),
  contractHash: t01.contractHash,
  model: modelPolicy.profiles.simple!.model,
  thinking: modelPolicy.profiles.simple!.thinking,
  maxTurns: modelPolicy.profiles.simple!.maxTurns,
  startedGeneration: (await service.status()).generation,
});
await service.claimTask("T01", binding);
await service.bindAgent("T01", binding.id, "agent-demo");
await service.markAgentStarted("agent-demo");
await service.checkpoint(binding.id, {
  currentStep: "field added",
  nextAction: "submit handoff",
  changedFiles: ["src/config.ts"],
  verificationNotes: ["typecheck passed"],
});
await service.submitHandoff(binding.id, {
  changedFiles: ["src/config.ts"],
  verification: [{ command: "npm test -- config", exitCode: 0 }],
  produced: ["src/config.ts#AppConfig.timeoutMs"],
});
await service.markAgentTerminal("agent-demo", "completed");
await service.beginVerification("T01");
await service.finishVerification("T01", true);
await service.completeTask("T01", "demo-commit-t01");

console.log("Next frontier:", await service.frontier());
console.log(JSON.stringify(await service.status(), null, 2));
