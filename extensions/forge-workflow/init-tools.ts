import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ForgeConfigService } from "../../src/config/service.js";
import { selectPiInstructionFile } from "../../src/config/instructions.js";
import { supportedThinkingLevelsForModel } from "../../src/config/model-capabilities.js";
import { discoverRepositoryContext } from "../../src/config/repository-context.js";
import type { AvailableModel, ForgeConfig, ForgeModelProfile, RepositoryScan, TrackerMode } from "../../src/config/types.js";
import type { ThinkingLevel } from "../../src/runtime/types.js";
import { PiSubagentsAdapter } from "../../src/subagents/adapter.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ProfileSchema = Type.Object({
  model: Type.String(),
  thinking: Type.String({ minLength: 1, description: "Thinking level reported by the selected model in Pi's current model registry" }),
  maxTurns: Type.Integer(),
});
const ConfigSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  generation: Type.Integer(),
  artifacts: Type.Object({ root: Type.String(), gitPolicy: Type.Union([Type.Literal("ignore"), Type.Literal("track")]) }),
  tracker: Type.Object({
    mode: Type.Literal("local"),
    publishRequiresConfirmation: Type.Literal(true),
  }),
  workspace: Type.Object({
    mode: Type.Literal("shared-serial"),
    isolationBackend: Type.Literal("none"),
    poolSize: Type.Literal(1),
  }),
  models: Type.Object({ profiles: Type.Record(Type.String(), ProfileSchema), routing: Type.Record(Type.String(), Type.String()) }),
  review: Type.Object({
    preset: Type.Union([Type.Literal("fast"), Type.Literal("standard"), Type.Literal("high-assurance")]),
    prd: Type.Object({ coverageReviewers: Type.Integer(), evidenceReviewers: Type.Integer(), architectureReviewers: Type.Integer() }),
    blockerVerification: Type.Object({ profile: Type.String(), requireDifferentModel: Type.Boolean() }),
  }),
  commands: Type.Object({
    typecheck: Type.Optional(Type.String()), test: Type.Optional(Type.String()), lint: Type.Optional(Type.String()), build: Type.Optional(Type.String()),
  }),
  agents: Type.Object({ directory: Type.String(), templateVersion: Type.Integer() }),
  instructions: Type.Optional(Type.Object({
    file: Type.Union([
      Type.Literal("AGENTS.override.md"), Type.Literal("AGENTS.md"), Type.Literal("AGENTS.MD"), Type.Literal("CLAUDE.md"), Type.Literal("CLAUDE.MD"),
    ]),
    managedSection: Type.Literal("forge-workflow"),
    templateVersion: Type.Optional(Type.Integer()),
  })),
  repositoryContext: Type.Optional(Type.Object({
    mode: Type.Union([Type.Literal("discovered"), Type.Literal("single-context"), Type.Literal("context-map")]),
    entryPoints: Type.Array(Type.String()),
    architectureDocs: Type.Array(Type.String()),
    adrDirectories: Type.Array(Type.String()),
    supplementalInstructions: Type.Array(Type.String()),
  })),
});

function text(content: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text: content }], details };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function execText(pi: ExtensionAPI, command: string, args: string[], cwd: string): Promise<{ code: number; stdout: string }> {
  try {
    const result = await pi.exec(command, args, { cwd });
    return { code: result.code, stdout: result.stdout.trim() };
  } catch {
    return { code: 127, stdout: "" };
  }
}

function availableModels(ctx: ExtensionContext): AvailableModel[] {
  return ctx.modelRegistry.getAvailable().map((model) => ({
    id: `${model.provider}/${model.id}`,
    name: model.name,
    reasoning: model.reasoning,
    supportedThinking: supportedThinkingLevelsForModel(model),
  })).sort((left, right) => left.id.localeCompare(right.id));
}

function chooseModel(models: AvailableModel[], preferred: string[], fallback?: AvailableModel): AvailableModel {
  for (const fragment of preferred) {
    const found = models.find((model) => model.id.includes(fragment) && model.supportedThinking.length > 0);
    if (found) return found;
  }
  const found = fallback ?? models.find((model) => model.supportedThinking.length > 0);
  if (!found) throw new Error("Forge requires at least one available reasoning model");
  return found;
}

function profile(model: AvailableModel, thinking: ThinkingLevel, maxTurns: number): ForgeModelProfile {
  const supported = model.supportedThinking.includes(thinking) ? thinking : model.supportedThinking.at(0) ?? "low";
  return { model: model.id, thinking: supported, maxTurns };
}

async function scanRepository(pi: ExtensionAPI, ctx: ExtensionContext, adapter: PiSubagentsAdapter, inputRoot?: string): Promise<RepositoryScan> {
  const controlRoot = resolve(ctx.cwd, inputRoot ?? ".");
  if (!(await pathExists(controlRoot))) throw new Error(`Control Root does not exist: ${controlRoot}`);
  const gitRootResult = await execText(pi, "git", ["rev-parse", "--show-toplevel"], controlRoot);
  const controlRootIsGit = gitRootResult.code === 0 && resolve(gitRootResult.stdout) === controlRoot;
  const repositoryRoot = controlRootIsGit ? gitRootResult.stdout : undefined;
  const revisionResult = repositoryRoot ? await execText(pi, "git", ["rev-parse", "HEAD"], repositoryRoot) : { code: 127, stdout: "" };
  const repositoryRevision = revisionResult.code === 0 ? revisionResult.stdout : undefined;
  const remoteResult = repositoryRoot ? await execText(pi, "git", ["remote", "-v"], repositoryRoot) : { code: 127, stdout: "" };
  const remotes = remoteResult.stdout.split("\n").filter(Boolean).map((line) => {
    const [name = "", url = ""] = line.split(/\s+/);
    return { name, url };
  }).filter((remote, index, all) => remote.name && remote.url && all.findIndex((candidate) => candidate.name === remote.name && candidate.url === remote.url) === index);

  let scripts: Record<string, string> = {};
  const packageJsonPath = join(controlRoot, "package.json");
  if (await pathExists(packageJsonPath)) {
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as { scripts?: Record<string, string>; workspaces?: unknown };
    scripts = packageJson.scripts ?? {};
  }
  const packageManager = await pathExists(join(controlRoot, "pnpm-lock.yaml")) ? "pnpm"
    : await pathExists(join(controlRoot, "yarn.lock")) ? "yarn"
      : await pathExists(join(controlRoot, "bun.lockb")) || await pathExists(join(controlRoot, "bun.lock")) ? "bun"
        : await pathExists(join(controlRoot, "package-lock.json")) ? "npm" : "unknown";
  const commandPrefix = packageManager === "unknown" ? "npm run" : `${packageManager} run`;
  const commands: ForgeConfig["commands"] = {};
  for (const name of ["typecheck", "test", "lint", "build"] as const) if (scripts[name]) commands[name] = `${commandPrefix} ${name}`;

  const inferredTracker: TrackerMode = "local";
  const ghVersion = await execText(pi, "gh", ["--version"], controlRoot);
  const ghAuth = ghVersion.code === 0 ? await execText(pi, "gh", ["auth", "status"], controlRoot) : { code: 127, stdout: "" };
  const glabVersion = await execText(pi, "glab", ["--version"], controlRoot);
  const glabAuth = glabVersion.code === 0 ? await execText(pi, "glab", ["auth", "status"], controlRoot) : { code: 127, stdout: "" };
  let protocolVersion: number | undefined;
  try { protocolVersion = await adapter.ping(); } catch { protocolVersion = undefined; }

  const models = availableModels(ctx);
  const simpleModel = chooseModel(models, ["deepseek-v4-flash", "flash"]);
  const mediumModel = chooseModel(models, ["gpt-5.6-luna", "luna"], simpleModel);
  const complexModel = chooseModel(models, ["gpt-5.6-sol", "sol"], mediumModel);
  const verifierModel = chooseModel(models.filter((model) => model.id !== complexModel.id), ["deepseek-v4-pro", "pro"], mediumModel);
  const instructionSelection = await selectPiInstructionFile(controlRoot);
  const discoveredRepositoryContext = await discoverRepositoryContext(controlRoot);
  const recommendedConfig: ForgeConfig = {
    schemaVersion: 1,
    generation: 1,
    artifacts: { root: ".forge", gitPolicy: "ignore" },
    tracker: { mode: "local", publishRequiresConfirmation: true },
    workspace: { mode: "shared-serial", isolationBackend: "none", poolSize: 1 },
    models: {
      profiles: {
        simple: profile(simpleModel, "low", 30),
        medium: profile(mediumModel, "high", 50),
        complex: profile(complexModel, "xhigh", 100),
        audit: profile(complexModel, "xhigh", 60),
        verifier: profile(verifierModel, "high", 40),
      },
      routing: {
        "task.simple": "simple", "task.medium": "medium", "task.complex": "complex",
        interactiveExplore: "simple", interactivePlan: "complex",
        prdCoverageReview: "audit", prdEvidenceReview: "audit", prdArchitectureReview: "audit",
        blockerVerifier: "verifier", taskPreflight: "audit", taskConformanceAudit: "simple", remediationPlanner: "complex", issueAudit: "audit",
      },
    },
    review: {
      preset: "standard",
      prd: { coverageReviewers: 1, evidenceReviewers: 1, architectureReviewers: 1 },
      blockerVerification: { profile: "verifier", requireDifferentModel: true },
    },
    commands,
    agents: { directory: await pathExists(join(controlRoot, ".agents", "agents")) ? ".agents/agents" : ".pi/agents", templateVersion: 4 },
    instructions: { file: instructionSelection.selectedFile, managedSection: "forge-workflow", templateVersion: 2 },
    repositoryContext: discoveredRepositoryContext,
  };

  const existingAgentDirectories: string[] = [];
  for (const path of [".pi/agents", ".agents/agents"]) if (await pathExists(join(controlRoot, path))) existingAgentDirectories.push(path);
  const existingArtifactDirectories: string[] = [];
  for (const path of [".forge", ".scratch"]) if (await pathExists(join(controlRoot, path))) existingArtifactDirectories.push(path);
  return {
    controlRoot,
    ...(repositoryRoot ? { repositoryRoot } : {}),
    ...(repositoryRevision ? { repositoryRevision } : {}),
    controlRootIsGit,
    remotes,
    inferredTracker,
    packageManager,
    monorepo: await pathExists(join(controlRoot, "pnpm-workspace.yaml")) || await pathExists(join(controlRoot, "packages")),
    instructionFile: instructionSelection.selectedFile,
    existingInstructionFiles: instructionSelection.existingFiles,
    shadowedInstructionFiles: instructionSelection.shadowedFiles,
    instructionFileRequiresConfirmation: instructionSelection.requiresConfirmation,
    discoveredRepositoryContext,
    existingAgentDirectories,
    existingArtifactDirectories,
    scripts,
    trackerCli: {
      gh: { installed: ghVersion.code === 0, authenticated: ghAuth.code === 0 },
      glab: { installed: glabVersion.code === 0, authenticated: glabAuth.code === 0 },
    },
    subagents: { reachable: protocolVersion !== undefined, ...(protocolVersion !== undefined ? { protocolVersion } : {}) },
    availableModels: models,
    recommendedConfig,
  };
}

export function registerInitTools(pi: ExtensionAPI, adapter: PiSubagentsAdapter): void {
  pi.registerTool({
    name: "forge_init_scan",
    label: "Forge Init Scan",
    description: "Inspect a Forge Control Workspace, optional Git metadata, Pi context, models, commands, agents, and pi-subagents, then recommend Forge configuration",
    parameters: Type.Object({ repositoryRoot: Type.Optional(Type.String({ description: "Control Workspace directory; legacy parameter name" })) }),
    async execute(_id, params, _signal, _update, ctx) {
      const scan = await scanRepository(pi, ctx, adapter, params.repositoryRoot);
      return text(JSON.stringify(scan, null, 2), scan as unknown as Record<string, unknown>);
    },
  });

  pi.registerTool({
    name: "forge_init_preview",
    label: "Forge Init Preview",
    description: "Validate a proposed Forge Control Workspace configuration and preview every file change without writing",
    parameters: Type.Object({ repositoryRoot: Type.String({ description: "Control Workspace directory; legacy parameter name" }), config: ConfigSchema }),
    async execute(_id, params, _signal, _update, ctx) {
      const scan = await scanRepository(pi, ctx, adapter, params.repositoryRoot);
      const service = new ForgeConfigService(scan.controlRoot, packageRoot);
      const preview = await service.preview(params.config as ForgeConfig, scan.availableModels);
      return text(JSON.stringify(preview, null, 2), preview as unknown as Record<string, unknown>);
    },
  });

  pi.registerTool({
    name: "forge_init_apply",
    label: "Forge Init Apply",
    description: "Apply an approved, non-stale Forge init preview, versioned Agent templates, and the managed Pi repository instruction block",
    parameters: Type.Object({
      repositoryRoot: Type.String({ description: "Control Workspace directory; legacy parameter name" }),
      config: ConfigSchema,
      expectedPreviewHash: Type.String(),
      overwriteTemplatePaths: Type.Optional(Type.Array(Type.String())),
      overwriteInstructionPaths: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const scan = await scanRepository(pi, ctx, adapter, params.repositoryRoot);
      const service = new ForgeConfigService(scan.controlRoot, packageRoot);
      const result = await service.apply({
        config: params.config as ForgeConfig,
        expectedPreviewHash: params.expectedPreviewHash,
        ...(params.overwriteTemplatePaths ? { overwriteTemplatePaths: params.overwriteTemplatePaths } : {}),
        ...(params.overwriteInstructionPaths ? { overwriteInstructionPaths: params.overwriteInstructionPaths } : {}),
        availableModels: scan.availableModels,
      });
      return text(`Forge initialized at ${service.configPath}.`, result as unknown as Record<string, unknown>);
    },
  });

  pi.registerTool({
    name: "forge_init_status",
    label: "Forge Init Status",
    description: "Validate the installed Forge Control Workspace config, model references, Agent template hashes, and managed instruction block",
    parameters: Type.Object({ repositoryRoot: Type.Optional(Type.String({ description: "Control Workspace directory; legacy parameter name" })) }),
    async execute(_id, params, _signal, _update, ctx) {
      const scan = await scanRepository(pi, ctx, adapter, params.repositoryRoot);
      const status = await new ForgeConfigService(scan.controlRoot, packageRoot).status(scan.availableModels);
      return text(JSON.stringify({ controlRoot: scan.controlRoot, ...status }, null, 2), { controlRoot: scan.controlRoot, ...status });
    },
  });
}
