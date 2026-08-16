import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadForgeConfig, resolveForgeProfile } from "../../src/config/resolver.js";
import type { PiSubagentsAdapter } from "../../src/subagents/adapter.js";
import { activeForgeWorkItems } from "../../src/subagents/tool-guard.js";
import { findForgeControlRoot, resolveGitRepository } from "../../src/work-item/repositories.js";

export interface InteractiveExploreRequest {
  repositoryRoot: string;
  prompt: string;
  description: string;
}

export async function startInteractiveExplore(
  sessionCwd: string,
  request: InteractiveExploreRequest,
  adapter: PiSubagentsAdapter,
) {
  if (!request.prompt.trim()) throw new Error("Explore prompt must not be empty");
  if (!request.description.trim()) throw new Error("Explore description must not be empty");
  const controlRoot = await findForgeControlRoot(sessionCwd);
  const active = await activeForgeWorkItems(controlRoot);
  if (active.length > 0) throw new Error(`Interactive Explore is unavailable while Forge Work Items are active: ${active.join(", ")}`);
  const repository = await resolveGitRepository(controlRoot, request.repositoryRoot);
  const config = await loadForgeConfig(controlRoot);
  const profile = resolveForgeProfile(config, "interactiveExplore");
  const protocol = await adapter.ping();
  if (protocol < 2) throw new Error(`Unsupported pi-subagents RPC protocol: ${protocol}`);
  const agentId = await adapter.spawn({
    type: "Explore",
    prompt: request.prompt,
    description: request.description,
    model: profile.model,
    thinkingLevel: profile.thinking,
    maxTurns: profile.maxTurns,
    cwd: repository.repositoryRoot,
  });
  return { agentId, controlRoot, repository, profile };
}

export function registerInteractiveTools(pi: ExtensionAPI, adapter: PiSubagentsAdapter): void {
  pi.registerTool({
    name: "forge_explore_repository",
    label: "Forge Explore Repository",
    description: "Additional multi-repository entry point for launching the existing read-only Explore Agent in one explicitly selected Git Working Tree through pi-subagents RPC. It is available only when no Forge Work Item is active and does not request worktree isolation.",
    promptSnippet: "Explore a selected repository from a multi-repository Control Workspace",
    promptGuidelines: [
      "Use forge_explore_repository only for read-only discovery before a Work Item becomes active. While a Forge Work Item is active, ordinary Agent/Explore/Plan and this interactive Explore entry point are mechanically unavailable; use only the frozen formal Forge surfaces and Binding-bound jobs.",
      "For independent exploration of multiple repositories, call forge_explore_repository once per exact repositoryRoot in one message so the read-only Explore Agents can run concurrently.",
      "Do not request worktree isolation for read-only repository exploration; forge_explore_repository supplies the selected repository cwd through pi-subagents RPC.",
    ],
    parameters: Type.Object({
      repositoryRoot: Type.String({ description: "Target Git Working Tree, absolute or relative to the Forge Control Root" }),
      prompt: Type.String({ description: "Self-contained read-only repository investigation for the Explore Agent" }),
      description: Type.String({ description: "Short 3-5 word description shown in the Agent UI" }),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const result = await startInteractiveExplore(ctx.cwd, params, adapter);
      return {
        content: [{ type: "text" as const, text: `Started read-only Explore Agent ${result.agentId} in ${result.repository.repositoryRoot}.` }],
        details: result,
      };
    },
  });
}
