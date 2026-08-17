import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { selectPiInstructionFile } from "../src/config/instructions.js";
import { supportedThinkingLevelsForModel } from "../src/config/model-capabilities.js";
import { discoverRepositoryContext } from "../src/config/repository-context.js";
import { ForgeConfigService } from "../src/config/service.js";
import type { AvailableModel, ForgeConfig } from "../src/config/types.js";
import { validateForgeConfig, validateForgeConfigUpdate } from "../src/config/validation.js";

const roots: string[] = [];
const packageRoot = process.cwd();
const models: AvailableModel[] = [
  { id: "test/simple", name: "Simple", reasoning: true, supportedThinking: ["minimal", "low", "medium"] },
  { id: "test/complex", name: "Complex", reasoning: true, supportedThinking: ["low", "medium", "high", "xhigh"] },
  { id: "test/verifier", name: "Verifier", reasoning: true, supportedThinking: ["low", "medium", "high"] },
];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function modelWithThinkingMap(thinkingLevelMap: NonNullable<Model<"openai-completions">["thinkingLevelMap"]>): Model<"openai-completions"> {
  return {
    id: "model",
    name: "Model",
    api: "openai-completions",
    provider: "test",
    baseUrl: "https://example.test/v1",
    reasoning: true,
    thinkingLevelMap,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  };
}

function config(overrides: Partial<ForgeConfig> = {}): ForgeConfig {
  return {
    schemaVersion: 1,
    generation: 1,
    artifacts: { root: ".forge", gitPolicy: "ignore" },
    tracker: { mode: "local", publishRequiresConfirmation: true },
    workspace: { mode: "shared-serial", isolationBackend: "none", poolSize: 1 },
    models: {
      profiles: {
        simple: { model: "test/simple", thinking: "low", maxTurns: 30 },
        medium: { model: "test/complex", thinking: "high", maxTurns: 50 },
        complex: { model: "test/complex", thinking: "xhigh", maxTurns: 100 },
        audit: { model: "test/complex", thinking: "xhigh", maxTurns: 60 },
        verifier: { model: "test/verifier", thinking: "high", maxTurns: 40 },
      },
      routing: {
        "task.simple": "simple",
        "task.medium": "medium",
        "task.complex": "complex",
        interactiveExplore: "simple",
        interactivePlan: "complex",
        prdCoverageReview: "audit",
        prdEvidenceReview: "audit",
        prdArchitectureReview: "audit",
        blockerVerifier: "verifier",
        taskPreflight: "audit",
        remediationPlanner: "complex",
        issueAudit: "audit",
      },
    },
    review: {
      preset: "standard",
      prd: { coverageReviewers: 1, evidenceReviewers: 1, architectureReviewers: 1 },
      blockerVerification: { profile: "verifier", requireDifferentModel: true },
    },
    commands: { typecheck: "npm run typecheck", test: "npm test" },
    agents: { directory: ".pi/agents", templateVersion: 2 },
    instructions: { file: "AGENTS.md", managedSection: "forge-workflow", templateVersion: 2 },
    repositoryContext: { mode: "discovered", entryPoints: [], architectureDocs: [], adrDirectories: [], supplementalInstructions: [] },
    ...overrides,
  };
}

async function createService() {
  const root = await mkdtemp(join(tmpdir(), "pi-forge-init-"));
  roots.push(root);
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(join(root, ".gitignore"), "node_modules/\n");
  return { root, service: new ForgeConfigService(root, packageRoot) };
}

describe("ForgeConfigService", () => {
  it("previews and atomically applies config, templates, generations, receipts, and gitignore", async () => {
    const { root, service } = await createService();
    const preview = await service.preview(config(), models);
    expect(preview.config.generation).toBe(1);
    expect(preview.changes.some((change) => change.path.endsWith(".pi/forge.json") && change.action === "create")).toBe(true);

    const result = await service.apply({ config: config(), expectedPreviewHash: preview.previewHash, availableModels: models });
    expect(result.receipt.generation).toBe(1);
    expect(await readFile(join(root, ".pi", "forge.json"), "utf8")).toContain('"root": ".forge"');
    await expect(readFile(join(root, ".pi", "agents", "forge-researcher.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const worker = await readFile(join(root, ".pi", "agents", "task-worker.md"), "utf8");
    const reviewer = await readFile(join(root, ".pi", "agents", "forge-reviewer.md"), "utf8");
    const designer = await readFile(join(root, ".pi", "agents", "forge-designer.md"), "utf8");
    expect(worker).toContain("name: task-worker");
    expect(worker).toContain("task_resume, task_checkpoint, task_handoff");
    expect(reviewer).toContain("name: forge-reviewer");
    expect(reviewer).toContain("forge_run_human_decision_request");
    expect(designer).toContain("Forge Remediation Planner");
    expect(designer).toContain("name: forge-designer");
    expect([worker, reviewer, designer].every((template) => template.includes("defaultContext: fresh") && template.includes("maxSubagentDepth: 0") && template.includes('acceptance: {"level":"none"'))).toBe(true);
    expect(await readFile(join(root, ".gitignore"), "utf8")).toContain("/.forge/");
    const instructions = await readFile(join(root, "AGENTS.md"), "utf8");
    expect(instructions).toContain("<!-- pi-forge-workflow:start -->");
    expect(instructions).toContain("### Proportionality Policy");
    expect(instructions).toContain("live uncertainty");
    const explore = await readFile(join(root, ".pi", "agents", "Explore.md"), "utf8");
    const plan = await readFile(join(root, ".pi", "agents", "Plan.md"), "utf8");
    expect(explore).toContain("name: Explore");
    expect(explore).toContain("model: test/simple");
    expect(explore).toContain('turnBudget: {"maxTurns":30,"graceTurns":0}');
    expect(explore).toContain("tools: read, grep, find, ls");
    expect(explore).not.toContain("tools: read, bash");
    expect(plan).toContain("name: Plan");
    expect(plan).toContain("model: test/complex");
    expect(plan).toContain('turnBudget: {"maxTurns":100,"graceTurns":0}');
    await expect(readFile(join(root, ".pi", "subagents.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const status = await service.status(models);
    expect(status.templateStatus.every((template) => template.matches)).toBe(true);
    expect(status.instructionStatus?.matches).toBe(true);
    expect(status.subagentsStatus?.strict).toBe(false);
  });

  it("initializes a non-Git Control Workspace and skips Git ignore mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-forge-control-"));
    roots.push(root);
    const service = new ForgeConfigService(root, packageRoot);
    const preview = await service.preview(config(), models);
    expect(preview.warnings).toContain("Control Root is not a Git Working Tree; Git ignore update is skipped.");
    expect(preview.changes.some((change) => change.path.endsWith(".gitignore"))).toBe(false);
    await service.apply({ config: config(), expectedPreviewHash: preview.previewHash, availableModels: models });
    expect(await readFile(join(root, ".pi", "forge.json"), "utf8")).toContain('"root": ".forge"');
    await expect(readFile(join(root, ".gitignore"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves legacy pi-subagents settings untouched because Nicobailon does not use them", async () => {
    const { root, service } = await createService();
    await mkdir(join(root, ".pi"), { recursive: true });
    const legacy = { maxConcurrent: 8, widgetMode: "all", fallbackSubagent: "general-purpose" };
    await writeFile(join(root, ".pi", "subagents.json"), JSON.stringify(legacy), { flag: "w" });
    const preview = await service.preview(config(), models);
    expect(preview.changes.some((change) => change.path.endsWith("subagents.json"))).toBe(false);
    await service.apply({ config: config(), expectedPreviewHash: preview.previewHash, availableModels: models });
    expect(JSON.parse(await readFile(join(root, ".pi", "subagents.json"), "utf8"))).toEqual(legacy);
  });

  it("normalizes retired Tournament and Task Audit config only at the read seam", async () => {
    const { root } = await createService();
    await mkdir(join(root, ".pi"), { recursive: true });
    const legacy = {
      ...config(),
      tournament: { enabled: true, candidates: 3, judges: 2, candidateProfile: "complex", judgeProfile: "audit", synthesizerProfile: "complex", blindReview: true },
      models: {
        ...config().models,
        routing: Object.fromEntries(Object.entries(config().models.routing).filter(([role]) => role !== "taskPreflight").concat([
          ["prdResearch", "medium"],
          ["optionCandidate", "complex"],
          ["optionJudge", "audit"],
          ["optionSynthesizer", "complex"],
          ["taskAudit", "audit"],
        ])),
      },
    };
    await writeFile(join(root, ".pi", "forge.json"), JSON.stringify(legacy));
    const { loadForgeConfig } = await import("../src/config/resolver.js");
    const normalized = await loadForgeConfig(root);
    expect(normalized.models.routing.taskPreflight).toBe("audit");
    expect(normalized.models.routing.taskConformanceAudit).toBe("audit");
    expect(normalized.models.routing).not.toHaveProperty("taskAudit");
    expect(normalized.models.routing).not.toHaveProperty("optionCandidate");
    expect(normalized).not.toHaveProperty("tournament");
  });

  it("defaults Task Conformance to the existing simple Task route for legacy Configs", async () => {
    const { root } = await createService();
    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(join(root, ".pi", "forge.json"), JSON.stringify(config()));
    const { loadForgeConfig } = await import("../src/config/resolver.js");
    expect((await loadForgeConfig(root)).models.routing.taskConformanceAudit).toBe("simple");
  });

  it("supports a custom artifact root", async () => {
    const { root, service } = await createService();
    const custom = config({ artifacts: { root: ".scratch/forge", gitPolicy: "ignore" } });
    const preview = await service.preview(custom, models);
    await service.apply({ config: custom, expectedPreviewHash: preview.previewHash, availableModels: models });
    expect(await readFile(join(root, ".gitignore"), "utf8")).toContain("/.scratch/forge/");
  });

  it("preserves existing Pi instructions and uses CLAUDE.md when configured as the active context file", async () => {
    const { root, service } = await createService();
    await writeFile(join(root, "CLAUDE.md"), "# Existing instructions\n\nKeep this line.\n");
    const claudeConfig = config({ instructions: { file: "CLAUDE.md", managedSection: "forge-workflow" } });
    const preview = await service.preview(claudeConfig, models);
    expect(preview.changes.some((change) => change.path.endsWith("CLAUDE.md") && change.action === "update")).toBe(true);
    await service.apply({ config: claudeConfig, expectedPreviewHash: preview.previewHash, availableModels: models });
    const content = await readFile(join(root, "CLAUDE.md"), "utf8");
    expect(content).toContain("Keep this line.");
    expect(content).toContain("## Forge workflow");
  });

  it("upgrades generated Explore and Plan profiles without treating the previous generated values as local edits", async () => {
    const { service } = await createService();
    const current = config({
      models: {
        ...config().models,
        profiles: {
          ...config().models.profiles,
          simple: { ...config().models.profiles.simple!, maxTurns: 12 },
          complex: { ...config().models.profiles.complex!, maxTurns: 30 },
        },
      },
    });
    const first = await service.preview(current, models);
    await service.apply({ config: current, expectedPreviewHash: first.previewHash, availableModels: models });

    const upgrade = await service.preview(config(), models);
    expect(upgrade.changes.some((change) => change.path.endsWith("Explore.md") && change.action === "update")).toBe(true);
    expect(upgrade.changes.some((change) => change.path.endsWith("Plan.md") && change.action === "update")).toBe(true);
    expect(upgrade.changes.some((change) => ["Explore.md", "Plan.md"].some((file) => change.path.endsWith(file)) && change.action === "conflict")).toBe(false);
  });

  it("upgrades the generated instruction template without treating the previous version as a local edit", async () => {
    const { root, service } = await createService();
    const { repositoryContext: _repositoryContext, ...legacyBase } = config();
    const legacy: ForgeConfig = {
      ...legacyBase,
      instructions: { file: "AGENTS.md", managedSection: "forge-workflow" },
    };
    const first = await service.preview(legacy, models);
    await service.apply({ config: legacy, expectedPreviewHash: first.previewHash, availableModels: models });

    const upgrade = await service.preview(config(), models);
    expect(upgrade.changes.some((change) => change.path.endsWith("AGENTS.md") && change.action === "update")).toBe(true);
    expect(upgrade.changes.some((change) => change.path.endsWith("AGENTS.md") && change.action === "conflict")).toBe(false);
    await service.apply({ config: config(), expectedPreviewHash: upgrade.previewHash, availableModels: models });
    const upgradedInstructions = await readFile(join(root, "AGENTS.md"), "utf8");
    expect(upgradedInstructions).toContain("Repository Context sources");
    expect(upgradedInstructions).toContain("### Proportionality Policy");
  });

  it("fails closed on locally modified managed Forge instructions without path approval", async () => {
    const { root, service } = await createService();
    const first = await service.preview(config(), models);
    await service.apply({ config: config(), expectedPreviewHash: first.previewHash, availableModels: models });
    const path = join(root, "AGENTS.md");
    const customized = (await readFile(path, "utf8")).replace("Treat frozen PRD", "CUSTOM: Treat frozen PRD");
    await writeFile(path, customized);

    const second = await service.preview(config(), models);
    expect(second.changes.some((change) => change.path.endsWith("AGENTS.md") && change.action === "conflict")).toBe(true);
    await expect(service.apply({ config: config(), expectedPreviewHash: second.previewHash, availableModels: models })).rejects.toThrow("conflicts require approval");
    await service.apply({
      config: config(),
      expectedPreviewHash: second.previewHash,
      overwriteInstructionPaths: ["AGENTS.md"],
      availableModels: models,
    });
    expect(await readFile(path, "utf8")).not.toContain("CUSTOM:");
  });

  it("upgrades the retired generated Researcher and Tournament templates without treating them as local edits", async () => {
    const { root, service } = await createService();
    await mkdir(join(root, ".pi", "agents"), { recursive: true });
    await writeFile(join(root, ".pi", "agents", "forge-researcher.md"), "You are a Forge repository researcher.\n");
    await writeFile(join(root, ".pi", "agents", "forge-designer.md"), "You are a Forge design tournament agent.\n");
    const preview = await service.preview(config(), models);
    expect(preview.changes.some((change) => change.path.endsWith("forge-researcher.md") && change.action === "update")).toBe(true);
    expect(preview.changes.some((change) => change.path.endsWith("forge-designer.md") && change.action === "update")).toBe(true);
    expect(preview.changes.some((change) => change.path.endsWith("forge-designer.md") && change.action === "conflict")).toBe(false);
    await service.apply({ config: config(), expectedPreviewHash: preview.previewHash, availableModels: models });
    await expect(readFile(join(root, ".pi", "agents", "forge-researcher.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(root, ".pi", "agents", "forge-designer.md"), "utf8")).toContain("Forge Remediation Planner");
  });

  it("fails closed on locally modified Agent templates without explicit path approval", async () => {
    const { root, service } = await createService();
    const first = await service.preview(config(), models);
    await service.apply({ config: config(), expectedPreviewHash: first.previewHash, availableModels: models });
    await writeFile(join(root, ".pi", "agents", "task-worker.md"), "local customization\n");

    const second = await service.preview(config(), models);
    expect(second.changes.some((change) => change.path.endsWith("task-worker.md") && change.action === "conflict")).toBe(true);
    await expect(service.apply({ config: config(), expectedPreviewHash: second.previewHash, availableModels: models })).rejects.toThrow("conflicts require approval");
    await service.apply({
      config: config(),
      expectedPreviewHash: second.previewHash,
      overwriteTemplatePaths: [".pi/agents/task-worker.md"],
      availableModels: models,
    });
    expect(await readFile(join(root, ".pi", "agents", "task-worker.md"), "utf8")).toContain("Forge Task executor");
  });
});

describe("Pi repository instruction selection", () => {
  it("creates AGENTS.md by default and follows Pi priority without asking in normal cases", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-forge-instructions-"));
    roots.push(root);
    expect(await selectPiInstructionFile(root)).toEqual({
      selectedFile: "AGENTS.md",
      existingFiles: [],
      shadowedFiles: [],
      requiresConfirmation: false,
    });

    await writeFile(join(root, "CLAUDE.md"), "# Claude\n");
    expect((await selectPiInstructionFile(root)).selectedFile).toBe("CLAUDE.md");
    await writeFile(join(root, "AGENTS.md"), "# Agents\n");
    const agents = await selectPiInstructionFile(root);
    expect(agents.selectedFile).toBe("AGENTS.md");
    expect(agents.shadowedFiles).toEqual(["CLAUDE.md"]);
  });

  it("requires explicit confirmation when AGENTS.override.md is active", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-forge-instructions-"));
    roots.push(root);
    await writeFile(join(root, "AGENTS.md"), "# Agents\n");
    await writeFile(join(root, "AGENTS.override.md"), "# Override\n");
    const selection = await selectPiInstructionFile(root);
    expect(selection.selectedFile).toBe("AGENTS.override.md");
    expect(selection.requiresConfirmation).toBe(true);
    expect(selection.shadowedFiles).toEqual(["AGENTS.md"]);
  });
});

describe("Repository Context discovery", () => {
  it("discovers Context entry points, ADRs, architecture docs, and Matt domain guidance", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-forge-context-"));
    roots.push(root);
    await mkdir(join(root, "docs", "agents"), { recursive: true });
    await mkdir(join(root, "docs", "adr"), { recursive: true });
    await mkdir(join(root, "docs", "architecture"), { recursive: true });
    await mkdir(join(root, "packages", "payments", "docs", "adr"), { recursive: true });
    await writeFile(join(root, "CONTEXT-MAP.md"), "# Context map\n");
    await writeFile(join(root, "CONTEXT.md"), "# Root context\n");
    await writeFile(join(root, "packages", "payments", "CONTEXT.md"), "# Payments\n");
    await writeFile(join(root, "docs", "agents", "domain.md"), "# Domain rules\n");

    expect(await discoverRepositoryContext(root)).toEqual({
      mode: "context-map",
      entryPoints: ["CONTEXT-MAP.md"],
      architectureDocs: ["docs/architecture"],
      adrDirectories: ["docs/adr", "packages/payments/docs/adr"],
      supplementalInstructions: ["docs/agents/domain.md"],
    });
  });

  it("uses a single discovered CONTEXT.md directly", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-forge-context-"));
    roots.push(root);
    await writeFile(join(root, "CONTEXT.md"), "# Context\n");
    expect(await discoverRepositoryContext(root)).toMatchObject({ mode: "single-context", entryPoints: ["CONTEXT.md"] });
  });
});

describe("Pi model thinking capabilities", () => {
  it("uses Pi's model-specific support calculation across unsupported holes", () => {
    expect(supportedThinkingLevelsForModel(modelWithThinkingMap({
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: null,
      max: "max",
    }))).toEqual(["high", "max"]);
    expect(supportedThinkingLevelsForModel(modelWithThinkingMap({
      high: "high",
      xhigh: "xhigh",
      max: null,
    }))).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
  });

  it("accepts future registry-reported levels without a Forge release", () => {
    const futureModel = modelWithThinkingMap({ high: "high" });
    (futureModel.thinkingLevelMap as Record<string, string | null>).ultra = "ultra";

    expect(supportedThinkingLevelsForModel(futureModel)).toContain("ultra");
  });
});

describe("validateForgeConfig", () => {
  it("accepts any non-empty level only when the current Pi model registry reports it as supported", () => {
    const futureModels: AvailableModel[] = [
      ...models,
      { id: "test/future", name: "Future", reasoning: true, supportedThinking: ["high", "ultra"] },
    ];
    const futureConfig = config({
      models: {
        ...config().models,
        profiles: {
          ...config().models.profiles,
          simple: { model: "test/future", thinking: "ultra", maxTurns: 30 },
        },
      },
    });

    expect(() => validateForgeConfig(futureConfig, futureModels)).not.toThrow();
    expect(() => validateForgeConfig({
      ...futureConfig,
      models: {
        ...futureConfig.models,
        profiles: {
          ...futureConfig.models.profiles,
          simple: { ...futureConfig.models.profiles.simple!, thinking: "xhigh" },
        },
      },
    }, futureModels)).toThrow("does not support xhigh thinking");
  });

  it("allows an unrelated supported profile update while warning about unchanged registry drift", () => {
    const current = config();
    const driftedModels: AvailableModel[] = models.map((model) => model.id === "test/simple"
      ? { ...model, supportedThinking: ["minimal", "medium"] }
      : model);
    const update = config({
      models: {
        ...current.models,
        profiles: {
          ...current.models.profiles,
          verifier: { ...current.models.profiles.verifier!, thinking: "medium" },
        },
      },
    });

    expect(validateForgeConfigUpdate(update, current, driftedModels)).toEqual([
      "Unchanged model profile simple has registry drift: simple model test/simple does not support low thinking",
    ]);
    expect(() => validateForgeConfigUpdate({
      ...update,
      models: {
        ...update.models,
        profiles: {
          ...update.models.profiles,
          verifier: { ...update.models.profiles.verifier!, thinking: "xhigh" },
        },
      },
    }, current, driftedModels)).toThrow("does not support xhigh thinking");
  });

  it("rejects unsafe paths, unavailable models, and unsafe workspace combinations", () => {
    expect(() => validateForgeConfig(config({ artifacts: { root: "../outside", gitPolicy: "ignore" } }), models)).toThrow("inside the repository");
    expect(() => validateForgeConfig(config({
      models: {
        ...config().models,
        profiles: { ...config().models.profiles, simple: { model: "missing/model", thinking: "low", maxTurns: 30 } },
      },
    }), models)).toThrow("unavailable");
    expect(() => validateForgeConfig(config({ workspace: { mode: "isolated-pool", isolationBackend: "none", poolSize: 2 } as never }), models)).toThrow("requires shared-serial");
    expect(() => validateForgeConfig(config({ tracker: { mode: "github", repository: "owner/repo", publishRequiresConfirmation: true } as never }), models)).toThrow("Local Issue artifacts");
    expect(() => validateForgeConfig(config({
      repositoryContext: { mode: "single-context", entryPoints: ["../CONTEXT.md"], architectureDocs: [], adrDirectories: [], supplementalInstructions: [] },
    }), models)).toThrow("inside the repository");
  });
});
