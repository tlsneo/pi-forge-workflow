import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { IssuesService } from "../../src/issues/service.js";

const WorkItemRoot = Type.String({ description: "Forge Work Item root containing a frozen PRD Receipt" });

function normalizeRoot(cwd: string, input: string): string {
  return resolve(cwd, input.replace(/^@/, ""));
}

function text(content: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text: content }], details };
}

export function registerIssueTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "forge_issues_status",
    label: "Forge Issues Status",
    description: "Read Local Issue artifacts derived from the Work Item's required top-level frozen PRD; if no PRD exists, return the PRD creation gate",
    parameters: Type.Object({ workItemRoot: WorkItemRoot }),
    async execute(_id, params, _signal, _update, ctx) {
      const root = normalizeRoot(ctx.cwd, params.workItemRoot);
      const status = await new IssuesService(root).status();
      const needsPrd = !status.state.currentPrd || status.state.status !== "frozen";
      const nextAction = needsPrd ? { skill: "forge-prd", reason: "Issues require a reviewed, user-approved, frozen top-level PRD with Delivery Boundaries" } : { skill: "forge-issues", reason: "Frozen PRD is ready for deterministic Issue materialization" };
      return text(JSON.stringify({ workItemRoot: root, needsPrd, nextAction, ...status }, null, 2), { workItemRoot: root, needsPrd, nextAction, ...status });
    },
  });

  pi.registerTool({
    name: "forge_issues_submit",
    label: "Forge Issues Submit",
    description: "Deterministically materialize every frozen PRD Delivery Boundary as one immutable Local Issue and generate the Issues Manifest",
    parameters: Type.Object({ workItemRoot: WorkItemRoot }),
    async execute(_id, params, _signal, _update, ctx) {
      const root = normalizeRoot(ctx.cwd, params.workItemRoot);
      const result = await new IssuesService(root).submit();
      return text(
        result.idempotent
          ? `Issues Generation ${result.manifest.generation} is already materialized from the frozen PRD.`
          : `Generated ${result.manifest.issues.length} Local Issue artifact${result.manifest.issues.length === 1 ? "" : "s"} and issues/manifest.json.`,
        { workItemRoot: root, ...result },
      );
    },
  });
}
