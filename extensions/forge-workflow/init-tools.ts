import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ForgeConfigService } from "../../src/config/service.js";
import { selectPiInstructionFile } from "../../src/config/instructions.js";
import { discoverRepositoryContext } from "../../src/config/repository-context.js";
import type { AvailableModel, ForgeConfig, ForgeModelProfile, RepositoryScan, TrackerMode } from "../../src/config/types.js";
import type { ThinkingLevel } from "../../src/runtime/types.js";
import { PiSubagentsAdapter } from "../../src/subagents/adapter.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ThinkingSchema = Type.Union([
  Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh"),
]);
const ProfileSchema = Type.Object({ model: Type.String(), thinking: ThinkingSchema, maxTurns: Type.Integer() });
const ConfigSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  generation: Type.Integer(),
  artifacts: Type.Object({ root: Type.String(), gitPolicy: Type.Union([Type.Literal("ignore"), Type.Literal("track")]) }),
  tracker: Type.Object({
    mode: Type.Union([Type.Literal("local"), Type.Literal("github"), Type.Literal("gitlab")]),
    repository: Type.Optional(Type.String()),
    project: Type.Optional(Type.String()),
    publishRequiresConfirmation: Type.Literal(true),
  }),
  workspace: Type.Object({
    mode: Type.Union([Type.Literal("shared-serial"), Type.Literal("isolated-pool")]),
    isolationBackend: Type.Union([Type.Literal("none"), Type.Literal("worktree"), Type.Literal("clone"), Type.Literal("custom")]),
    poolSize: Type.Integer(),
  }),
  models: Type.Object({ profiles: Type.Record(Type.String(), ProfileSchema), routing: Type.Record(Type.String(), Type.String()) }),
  review: Type.Object({
    preset: Type.Union([Type.Literal("fast"), Type.Literal("standard"), Type.Literal("high-assurance")]),
    prd: Type.Object({ coverageReviewers: Type.Integer(), evidenceReviewers: Type.Integer(), architectureReviewers: Type.Integer() }),
    blockerVerification: Type.Object({ profile: Type.String(), requireDifferentModel: Type.Boolean() }),
  }),
  tournament: Type.Object({
    enabled: Type.Boolean(),
    candidates: Type.Integer(),
    judges: Type.Integer(),
    candidateProfile: Type.String(),
    judgeProfile: Type.String(),
    synthesizerProfile: Type.String(),
    blindReview: Type.Literal(true),
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
  const levels: ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh"];
  return ctx.modelRegistry.getAvailable().map((model) => ({
    id: `${model.provider}/${model.id}`,
    name: model.name,
    reasoning: model.reasoning,
    supportedThinking: model.reasoning
      ? levels.filter((level) => model.thinkingLevelMap?.[level] !== null)
      : [],
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

function trackerFromRemotes(remotes: Array<{ name: string; url: string }>): TrackerMode {
  if (remotes.some((remote) => remote.url.includes("github.com"))) return "github";
  if (remotes.some((remote) => remote.url.includes("gitlab"))) return "gitlab";
  return "local";
}

function remoteProject(remotes: Array<{ name: string; url: string }>, host: "github" | "gitlab"): string | undefined {
  const remote = remotes.find((candidate) => candidate.url.includes(host));
  if (!remote) return undefined;
  const match = /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(remote.url);
  return match?.[1];
}

async function scanRepository(pi: ExtensionAPI, ctx: ExtensionContext, adapter: PiSubagentsAdapter, inputRoot?: string): Promise<RepositoryScan> {
  const requested = resolve(ctx.cwd, inputRoot ?? ".");
  const gitRootResult = await execText(pi, "git", ["rev-parse", "--show-toplevel"], requested);
  if (gitRootResult.code !== 0) throw new Error("forge-init requires a Git repository");
  const repositoryRoot = gitRootResult.stdout;
  const revisionResult = await execText(pi, "git", ["rev-parse", "HEAD"], repositoryRoot);
  const repositoryRevision = revisionResult.code === 0 ? revisionResult.stdout : "unborn";
  const remoteResult = await execText(pi, "git", ["remote", "-v"], repositoryRoot);
  const remotes = remoteResult.stdout.split("\n").filter(Boolean).map((line) => {
    const [name = "", url = ""] = line.split(/\s+/);
    return { name, url };
  }).filter((remote, index, all) => remote.name && remote.url && all.findIndex((candidate) => candidate.name === remote.name && candidate.url === remote.url) === index);

  let scripts: Record<string, string> = {};
  const packageJsonPath = join(repositoryRoot, "package.json");
  if (await pathExists(packageJsonPath)) {
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as { scripts?: Record<string, string>; workspaces?: unknown };
    scripts = packageJson.scripts ?? {};
  }
  const packageManager = await pathExists(join(repositoryRoot, "pnpm-lock.yaml")) ? "pnpm"
    : await pathExists(join(repositoryRoot, "yarn.lock")) ? "yarn"
      : await pathExists(join(repositoryRoot, "bun.lockb")) || await pathExists(join(repositoryRoot, "bun.lock")) ? "bun"
        : await pathExists(join(repositoryRoot, "package-lock.json")) ? "npm" : "unknown";
  const commandPrefix = packageManager === "unknown" ? "npm run" : `${packageManager} run`;
  const commands: ForgeConfig["commands"] = {};
  for (const name of ["typecheck", "test", "lint", "build"] as const) if (scripts[name]) commands[name] = `${commandPrefix} ${name}`;

  const inferredTracker = trackerFromRemotes(remotes);
  const ghVersion = await execText(pi, "gh", ["--version"], repositoryRoot);
  const ghAuth = ghVersion.code === 0 ? await execText(pi, "gh", ["auth", "status"], repositoryRoot) : { code: 127, stdout: "" };
  const glabVersion = await execText(pi, "glab", ["--version"], repositoryRoot);
  const glabAuth = glabVersion.code === 0 ? await execText(pi, "glab", ["auth", "status"], repositoryRoot) : { code: 127, stdout: "" };
  let protocolVersion: number | undefined;
  try { protocolVersion = await adapter.ping(); } catch { protocolVersion = undefined; }

  const models = availableModels(ctx);
  const simpleModel = chooseModel(models, ["deepseek-v4-flash", "flash"]);
  const mediumModel = chooseModel(models, ["gpt-5.6-luna", "luna"], simpleModel);
  const complexModel = chooseModel(models, ["gpt-5.6-sol", "sol"], mediumModel);
  const verifierModel = chooseModel(models.filter((model) => model.id !== complexModel.id), ["deepseek-v4-pro", "pro"], mediumModel);
  const trackerProject = inferredTracker === "github" ? remoteProject(remotes, "github") : inferredTracker === "gitlab" ? remoteProject(remotes, "gitlab") : undefined;
  const instructionSelection = await selectPiInstructionFile(repositoryRoot);
  const discoveredRepositoryContext = await discoverRepositoryContext(repositoryRoot);
  const recommendedConfig: ForgeConfig = {
    schemaVersion: 1,
    generation: 1,
    artifacts: { root: ".forge", gitPolicy: "ignore" },
    tracker: {
      mode: inferredTracker,
      ...(inferredTracker === "github" && trackerProject ? { repository: trackerProject } : {}),
      ...(inferredTracker === "gitlab" && trackerProject ? { project: trackerProject } : {}),
      publishRequiresConfirmation: true,
    },
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
        prdResearch: "medium", optionCandidate: "complex", optionJudge: "audit", optionSynthesizer: "complex",
        prdCoverageReview: "audit", prdEvidenceReview: "audit", prdArchitectureReview: "audit",
        blockerVerifier: "verifier", taskPreflight: "audit", remediationPlanner: "complex", taskAudit: "audit", issueAudit: "audit",
      },
    },
    review: {
      preset: "standard",
      prd: { coverageReviewers: 1, evidenceReviewers: 1, architectureReviewers: 1 },
      blockerVerification: { profile: "verifier", requireDifferentModel: true },
    },
    tournament: {
      enabled: true, candidates: 3, judges: 2, candidateProfile: "complex", judgeProfile: "audit", synthesizerProfile: "complex", blindReview: true,
    },
    commands,
    agents: { directory: await pathExists(join(repositoryRoot, ".agents", "agents")) ? ".agents/agents" : ".pi/agents", templateVersion: 2 },
    instructions: { file: instructionSelection.selectedFile, managedSection: "forge-workflow", templateVersion: 1 },
    repositoryContext: discoveredRepositoryContext,
  };

  const existingAgentDirectories: string[] = [];
  for (const path of [".pi/agents", ".agents/agents"]) if (await pathExists(join(repositoryRoot, path))) existingAgentDirectories.push(path);
  const existingArtifactDirectories: string[] = [];
  for (const path of [".forge", ".scratch"]) if (await pathExists(join(repositoryRoot, path))) existingArtifactDirectories.push(path);
  return {
    repositoryRoot,
    repositoryRevision,
    remotes,
    inferredTracker,
    packageManager,
    monorepo: await pathExists(join(repositoryRoot, "pnpm-workspace.yaml")) || await pathExists(join(repositoryRoot, "packages")),
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
    description: "Inspect a Git repository, Pi and domain context files, ADRs, architecture docs, models, commands, tracker CLIs, agents, and pi-subagents, then recommend Forge configuration",
    parameters: Type.Object({ repositoryRoot: Type.Optional(Type.String()) }),
    async execute(_id, params, _signal, _update, ctx) {
      const scan = await scanRepository(pi, ctx, adapter, params.repositoryRoot);
      return text(JSON.stringify(scan, null, 2), scan as unknown as Record<string, unknown>);
    },
  });

  pi.registerTool({
    name: "forge_init_preview",
    label: "Forge Init Preview",
    description: "Validate a proposed Forge repository configuration and preview every file change without writing",
    parameters: Type.Object({ repositoryRoot: Type.String(), config: ConfigSchema }),
    async execute(_id, params, _signal, _update, ctx) {
      const scan = await scanRepository(pi, ctx, adapter, params.repositoryRoot);
      const service = new ForgeConfigService(scan.repositoryRoot, packageRoot);
      const preview = await service.preview(params.config as ForgeConfig, scan.availableModels);
      return text(JSON.stringify(preview, null, 2), preview as unknown as Record<string, unknown>);
    },
  });

  pi.registerTool({
    name: "forge_init_apply",
    label: "Forge Init Apply",
    description: "Apply an approved, non-stale Forge init preview, versioned Agent templates, and the managed Pi repository instruction block",
    parameters: Type.Object({
      repositoryRoot: Type.String(),
      config: ConfigSchema,
      expectedPreviewHash: Type.String(),
      overwriteTemplatePaths: Type.Optional(Type.Array(Type.String())),
      overwriteInstructionPaths: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const scan = await scanRepository(pi, ctx, adapter, params.repositoryRoot);
      const service = new ForgeConfigService(scan.repositoryRoot, packageRoot);
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
    description: "Validate the installed Forge config, model references, Agent template hashes, and managed repository instruction block",
    parameters: Type.Object({ repositoryRoot: Type.Optional(Type.String()) }),
    async execute(_id, params, _signal, _update, ctx) {
      const scan = await scanRepository(pi, ctx, adapter, params.repositoryRoot);
      const status = await new ForgeConfigService(scan.repositoryRoot, packageRoot).status(scan.availableModels);
      return text(JSON.stringify({ repositoryRoot: scan.repositoryRoot, ...status }, null, 2), { repositoryRoot: scan.repositoryRoot, ...status });
    },
  });
}
