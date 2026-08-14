import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { TasksService } from "../../src/tasks/service.js";
import { TaskPreflightService } from "../../src/tasks/preflight-service.js";
import type { TaskPreflightFinding } from "../../src/tasks/preflight-types.js";
import type { MicroTaskDraft, SliceDraft } from "../../src/tasks/types.js";
import type { TaskPreflightOrchestrator } from "./task-preflight-orchestrator.js";

const WorkItemRoot = Type.String({ description: "Forge Work Item root containing issues/manifest.json" });
const CommandSchema = Type.Object({ command: Type.String(), timeoutMs: Type.Integer() });
const SliceSchema = Type.Object({
  id: Type.String(),
  title: Type.String(),
  goal: Type.String(),
  acceptanceIds: Type.Array(Type.String()),
  taskIds: Type.Array(Type.String()),
  gate: Type.Array(Type.Object({ command: Type.String(), timeoutMs: Type.Integer(), proves: Type.String() })),
});
const FindingSchema = Type.Object({
  id: Type.String(),
  severity: Type.Union([Type.Literal("blocker"), Type.Literal("warning"), Type.Literal("note")]),
  taskId: Type.String(),
  message: Type.String(),
  evidence: Type.Array(Type.String()),
  violatedRule: Type.String(),
  verification: Type.String(),
  suggestedResolution: Type.String(),
});
const TaskSchema = Type.Object({
  id: Type.String(),
  title: Type.String(),
  sliceId: Type.String(),
  goal: Type.String(),
  editPoint: Type.Object({ path: Type.String(), symbol: Type.String() }),
  reads: Type.Array(Type.Object({ path: Type.String(), symbol: Type.String(), reason: Type.String() })),
  writes: Type.Array(Type.String()),
  dependencies: Type.Array(Type.String()),
  conflicts: Type.Array(Type.String()),
  produces: Type.Array(Type.String()),
  consumes: Type.Array(Type.String()),
  acceptanceIds: Type.Array(Type.String()),
  implementationBlueprint: Type.Array(Type.Object({
    id: Type.String(),
    instruction: Type.String(),
    expectedEvidence: Type.Array(Type.String()),
  })),
  expectedPatchShape: Type.Array(Type.String()),
  forbiddenChanges: Type.Array(Type.String()),
  stopConditions: Type.Array(Type.String()),
  outOfScope: Type.Array(Type.String()),
  verification: Type.Array(CommandSchema),
  modelProfile: Type.Optional(Type.String()),
});

function normalizeRoot(cwd: string, input: string): string {
  return resolve(cwd, input.replace(/^@/, ""));
}

function text(content: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text: content }], details };
}

export function registerTaskTools(pi: ExtensionAPI, preflightOrchestrator: TaskPreflightOrchestrator): void {
  pi.registerTool({
    name: "forge_tasks_status",
    label: "Forge Tasks Status",
    description: "Read one Issue Task Plan and its initialized deterministic Runtime",
    parameters: Type.Object({ workItemRoot: WorkItemRoot, issueId: Type.String() }),
    async execute(_id, params, _signal, _update, ctx) {
      const root = normalizeRoot(ctx.cwd, params.workItemRoot);
      const status = await new TasksService(root).status(params.issueId);
      const preflight = await new TaskPreflightService(root, params.issueId).status();
      return text(JSON.stringify({ workItemRoot: root, issueId: params.issueId, ...status, ...(preflight ? { preflight } : {}) }, null, 2), { workItemRoot: root, issueId: params.issueId, ...status, ...(preflight ? { preflight } : {}) });
    },
  });

  pi.registerTool({
    name: "forge_tasks_rebind_models",
    label: "Forge Tasks Rebind Models",
    description: "Create an immutable Runtime Model Policy generation for incomplete Tasks while preserving completed Receipts and prior Bindings",
    parameters: Type.Object({ workItemRoot: WorkItemRoot, issueId: Type.String(), reason: Type.String() }),
    async execute(_id, params, _signal, _update, ctx) {
      const root = normalizeRoot(ctx.cwd, params.workItemRoot);
      const result = await new TasksService(root).rebindModels(params.issueId, params.reason);
      return text(
        result.idempotent
          ? `Runtime Model Policy Generation ${result.modelPolicyGeneration} already matches Forge Config Generation ${result.configGeneration}.`
          : `Rebound incomplete ${params.issueId} Tasks to Runtime Model Policy Generation ${result.modelPolicyGeneration} from Forge Config Generation ${result.configGeneration}; completed Receipts and prior Bindings were preserved.`,
        { workItemRoot: root, issueId: params.issueId, ...result },
      );
    },
  });

  pi.registerTool({
    name: "forge_tasks_preflight_submit",
    label: "Forge Tasks Preflight Submit",
    description: "Submit one Binding-bound independent Task Preflight verdict for the active semantic Task Proposal",
    parameters: Type.Object({
      workItemRoot: WorkItemRoot,
      issueId: Type.String(),
      bindingId: Type.String(),
      proposalHash: Type.String(),
      verdict: Type.Union([Type.Literal("passed"), Type.Literal("blocked")]),
      findings: Type.Array(FindingSchema),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const root = normalizeRoot(ctx.cwd, params.workItemRoot);
      const result = await preflightOrchestrator.submitResult({
        workItemRoot: root,
        issueId: params.issueId,
        bindingId: params.bindingId,
        proposalHash: params.proposalHash,
        verdict: params.verdict,
        findings: params.findings as TaskPreflightFinding[],
      });
      return text(
        result.status === "frozen"
          ? `Task Preflight passed and froze Task Plan ${result.taskPlanHash}.`
          : `Task Preflight blocked the Proposal; revise the reported Tasks and submit a new semantic Proposal.`,
        { workItemRoot: root, issueId: params.issueId, ...result },
      );
    },
  });

  pi.registerTool({
    name: "forge_tasks_submit",
    label: "Forge Tasks Submit",
    description: "Validate vertical Slices and behavior-complete decision-free Tasks, freeze Task packages and a DAG, and initialize the Issue Runtime",
    parameters: Type.Object({
      workItemRoot: WorkItemRoot,
      issueId: Type.String(),
      slices: Type.Array(SliceSchema),
      tasks: Type.Array(TaskSchema),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const root = normalizeRoot(ctx.cwd, params.workItemRoot);
      const result = await preflightOrchestrator.propose({
        workItemRoot: root,
        issueId: params.issueId,
        slices: params.slices as SliceDraft[],
        tasks: params.tasks as MicroTaskDraft[],
        ctx,
      });
      const message = result.status === "started"
        ? `Started Binding-bound Task Preflight for Proposal Generation ${result.proposalGeneration}; the Task Plan is not frozen yet.`
        : result.status === "frozen"
          ? `Task Preflight is passed and Task Plan ${result.taskPlanHash} is frozen.`
          : `Task Preflight Proposal Generation ${result.proposalGeneration} is ${result.status}; the Task Plan remains unfrozen.`;
      return text(message, { workItemRoot: root, issueId: params.issueId, ...result });
    },
  });
}
