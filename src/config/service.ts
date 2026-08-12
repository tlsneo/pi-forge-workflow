import { constants } from "node:fs";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stableHash } from "../runtime/hash.js";
import { atomicWriteJson, atomicWriteText } from "../runtime/store.js";
import type { AvailableModel, ConfigFileChange, ForgeConfig, ForgeInitPreview, ForgeInitReceipt } from "./types.js";
import { desiredAgentTemplates } from "./agent-templates.js";
import { planManagedInstructions, renderForgeInstructionBlock } from "./instructions.js";
import { validateForgeConfig } from "./validation.js";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readOptional(path: string): Promise<string | undefined> {
  return (await exists(path)) ? readFile(path, "utf8") : undefined;
}

function strictSubagentsSettings(current: string | undefined): string {
  let parsed: Record<string, unknown> = {};
  if (current) {
    try {
      const value = JSON.parse(current) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("must be a JSON object");
      parsed = value as Record<string, unknown>;
    } catch (error) {
      throw new Error(`Cannot configure strict pi-subagents settings: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return `${JSON.stringify({ ...parsed, fallbackSubagent: "none", disableDefaultAgents: false }, null, 2)}\n`;
}

function changeFor(path: string, current: string | undefined, next: string, conflict = false, reason?: string): ConfigFileChange {
  const currentHash = current === undefined ? undefined : stableHash(current);
  const nextHash = stableHash(next);
  return {
    path,
    action: conflict ? "conflict" : current === undefined ? "create" : currentHash === nextHash ? "unchanged" : "update",
    reason: reason ?? (conflict
      ? "Existing Agent template differs; explicit overwrite approval is required"
      : current === undefined
        ? "File does not exist"
        : currentHash === nextHash
          ? "Already matches the proposed configuration"
          : "Content will be updated"),
    ...(currentHash ? { currentHash } : {}),
    nextHash,
  };
}

export class ForgeConfigService {
  readonly controlRoot: string;
  readonly packageRoot: string;
  readonly configPath: string;

  constructor(controlRoot: string, packageRoot: string) {
    this.controlRoot = controlRoot;
    this.packageRoot = packageRoot;
    this.configPath = join(controlRoot, ".pi", "forge.json");
  }

  async readConfig(): Promise<ForgeConfig | undefined> {
    const content = await readOptional(this.configPath);
    return content ? JSON.parse(content) as ForgeConfig : undefined;
  }

  async preview(input: ForgeConfig, availableModels?: AvailableModel[]): Promise<ForgeInitPreview> {
    const currentConfig = await this.readConfig();
    const config: ForgeConfig = {
      ...structuredClone(input),
      schemaVersion: 1,
      generation: (currentConfig?.generation ?? 0) + 1,
    };
    validateForgeConfig(config, availableModels);

    const desiredConfig = `${JSON.stringify(config, null, 2)}\n`;
    const changes: ConfigFileChange[] = [];
    changes.push(changeFor(this.configPath, await readOptional(this.configPath), desiredConfig));

    const currentTemplates = currentConfig
      ? new Map((await desiredAgentTemplates(this.packageRoot, currentConfig)).map((template) => [template.file, template.content]))
      : new Map<string, string>();
    const retiredResearcherPath = join(this.controlRoot, config.agents.directory, "forge-researcher.md");
    const retiredResearcher = await readOptional(retiredResearcherPath);
    if (retiredResearcher?.includes("You are a Forge repository researcher.")) {
      changes.push(changeFor(retiredResearcherPath, retiredResearcher, "", false, "Remove the retired generated Forge Researcher template"));
    }
    for (const template of await desiredAgentTemplates(this.packageRoot, config)) {
      const targetPath = join(this.controlRoot, config.agents.directory, template.file);
      const current = await readOptional(targetPath);
      const expectedCurrent = currentTemplates.get(template.file);
      const differs = current !== undefined && stableHash(current) !== stableHash(template.content);
      const retiredGeneratedDesigner = template.file === "forge-designer.md" && current?.includes("You are a Forge design tournament agent.");
      const locallyModified = differs && !retiredGeneratedDesigner && (expectedCurrent === undefined || stableHash(current) !== stableHash(expectedCurrent));
      changes.push(changeFor(targetPath, current, template.content, locallyModified, retiredGeneratedDesigner ? "Replace the retired generated Tournament template with the Remediation Planner template" : undefined));
    }

    const instructionPlans = await planManagedInstructions(this.controlRoot, currentConfig, config);
    for (const plan of instructionPlans) changes.push(changeFor(plan.path, plan.current, plan.next, plan.conflict, plan.reason));

    const subagentsPath = join(this.controlRoot, ".pi", "subagents.json");
    const currentSubagents = await readOptional(subagentsPath);
    changes.push(changeFor(
      subagentsPath,
      currentSubagents,
      strictSubagentsSettings(currentSubagents),
      false,
      "Keep default agents available, fail closed on unknown types, and use project Explore and Plan overrides",
    ));

    const controlGitMarker = join(this.controlRoot, ".git");
    if (config.artifacts.gitPolicy === "ignore" && await exists(controlGitMarker)) {
      const gitignorePath = join(this.controlRoot, ".gitignore");
      const current = await readOptional(gitignorePath) ?? "";
      const ignoreLine = `/${config.artifacts.root.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")}/`;
      const lines = current.split("\n").filter(Boolean);
      const desired = lines.includes(ignoreLine)
        ? current
        : `${current}${current && !current.endsWith("\n") ? "\n" : ""}${ignoreLine}\n`;
      changes.push(changeFor(gitignorePath, current || undefined, desired));
    }

    const warnings: string[] = [];
    if (config.instructions?.file === "AGENTS.override.md") warnings.push("AGENTS.override.md shadows AGENTS.md and CLAUDE.md in this directory; writing the Forge block there requires explicit user confirmation.");
    if (config.repositoryContext) {
      const contextPaths = [...new Set([
        ...config.repositoryContext.entryPoints,
        ...config.repositoryContext.architectureDocs,
        ...config.repositoryContext.adrDirectories,
        ...config.repositoryContext.supplementalInstructions,
      ])];
      const missing = (await Promise.all(contextPaths.map(async (path) => ({ path, exists: await exists(join(this.controlRoot, path)) })))).filter((entry) => !entry.exists);
      if (missing.length > 0) warnings.push(`Repository Context paths do not exist: ${missing.map((entry) => entry.path).join(", ")}`);
      if (contextPaths.length === 0) warnings.push("No Repository Context sources were discovered; forge-prd will fall back to repository instructions and targeted code evidence.");
    }
    if (config.artifacts.gitPolicy === "ignore" && !(await exists(controlGitMarker))) warnings.push("Control Root is not a Git Working Tree; Git ignore update is skipped.");
    if (changes.some((change) => change.action === "conflict")) warnings.push("One or more managed Forge files have local modifications and require path-specific overwrite approval.");

    const previewHash = stableHash({
      controlRoot: this.controlRoot,
      currentConfigHash: currentConfig ? stableHash(currentConfig) : null,
      config,
      changes: changes.map(({ path, action, currentHash, nextHash }) => ({ path, action, currentHash: currentHash ?? null, nextHash })),
    });
    return { controlRoot: this.controlRoot, configPath: this.configPath, previewHash, config, changes, warnings };
  }

  async apply(input: {
    config: ForgeConfig;
    expectedPreviewHash: string;
    overwriteTemplatePaths?: string[];
    overwriteInstructionPaths?: string[];
    availableModels?: AvailableModel[];
  }): Promise<{ preview: ForgeInitPreview; receipt: ForgeInitReceipt }> {
    const preview = await this.preview(input.config, input.availableModels);
    if (preview.previewHash !== input.expectedPreviewHash) throw new Error("Forge init preview is stale; run forge_init_preview again");
    const allowed = new Set([
      ...(input.overwriteTemplatePaths ?? []),
      ...(input.overwriteInstructionPaths ?? []),
    ].map((path) => join(this.controlRoot, path)));
    const unresolved = preview.changes.filter((change) => change.action === "conflict" && !allowed.has(change.path));
    if (unresolved.length > 0) throw new Error(`Forge init conflicts require approval: ${unresolved.map((change) => change.path).join(", ")}`);

    const currentConfig = await this.readConfig();
    await mkdir(dirname(this.configPath), { recursive: true });
    const changedFiles: string[] = [];
    const desiredConfig = `${JSON.stringify(preview.config, null, 2)}\n`;
    await atomicWriteText(this.configPath, desiredConfig);
    changedFiles.push(this.configPath);
    await atomicWriteJson(join(this.controlRoot, ".pi", "forge-generations", `forge-${preview.config.generation}.json`), preview.config);

    for (const template of await desiredAgentTemplates(this.packageRoot, preview.config)) {
      const targetPath = join(this.controlRoot, preview.config.agents.directory, template.file);
      const current = await readOptional(targetPath);
      if (current === undefined || stableHash(current) !== stableHash(template.content)) {
        await atomicWriteText(targetPath, template.content);
        changedFiles.push(targetPath);
      }
    }
    const retiredResearcherPath = join(this.controlRoot, preview.config.agents.directory, "forge-researcher.md");
    const retiredResearcher = await readOptional(retiredResearcherPath);
    if (retiredResearcher?.includes("You are a Forge repository researcher.")) {
      await rm(retiredResearcherPath);
      changedFiles.push(retiredResearcherPath);
    }

    const instructionPlans = await planManagedInstructions(this.controlRoot, currentConfig, preview.config);
    for (const plan of instructionPlans) {
      if (plan.current === undefined || stableHash(plan.current) !== stableHash(plan.next)) {
        await atomicWriteText(plan.path, plan.next);
        changedFiles.push(plan.path);
      }
    }

    const subagentsPath = join(this.controlRoot, ".pi", "subagents.json");
    const currentSubagents = await readOptional(subagentsPath);
    const desiredSubagents = strictSubagentsSettings(currentSubagents);
    if (currentSubagents === undefined || stableHash(currentSubagents) !== stableHash(desiredSubagents)) {
      await atomicWriteText(subagentsPath, desiredSubagents);
      changedFiles.push(subagentsPath);
    }

    if (preview.config.artifacts.gitPolicy === "ignore" && await exists(join(this.controlRoot, ".git"))) {
      const gitignorePath = join(this.controlRoot, ".gitignore");
      const current = await readOptional(gitignorePath) ?? "";
      const ignoreLine = `/${preview.config.artifacts.root.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")}/`;
      if (!current.split("\n").includes(ignoreLine)) {
        const next = `${current}${current && !current.endsWith("\n") ? "\n" : ""}${ignoreLine}\n`;
        await atomicWriteText(gitignorePath, next);
        changedFiles.push(gitignorePath);
      }
    }

    const receipt: ForgeInitReceipt = {
      schemaVersion: 1,
      generation: preview.config.generation,
      configHash: stableHash(preview.config),
      previewHash: preview.previewHash,
      changedFiles,
      appliedAt: new Date().toISOString(),
    };
    await atomicWriteJson(join(this.controlRoot, ".pi", "forge-receipts", `init-${receipt.generation}.json`), receipt);
    return { preview, receipt };
  }

  async status(availableModels?: AvailableModel[]): Promise<{
    configured: boolean;
    config?: ForgeConfig;
    configHash?: string;
    templateStatus: Array<{ path: string; installed: boolean; matches: boolean }>;
    instructionStatus?: { path: string; installed: boolean; matches: boolean };
    repositoryContextStatus?: { configuredPaths: string[]; missingPaths: string[] };
    subagentsStatus?: { path: string; strict: boolean };
  }> {
    const config = await this.readConfig();
    if (!config) return { configured: false, templateStatus: [] };
    validateForgeConfig(config, availableModels);
    const templateStatus = await Promise.all((await desiredAgentTemplates(this.packageRoot, config)).map(async (template) => {
      const targetPath = join(this.controlRoot, config.agents.directory, template.file);
      const current = await readOptional(targetPath);
      return { path: targetPath, installed: current !== undefined, matches: current !== undefined && stableHash(current) === stableHash(template.content) };
    }));
    const instructions = config.instructions;
    const instructionStatus = instructions ? await (async () => {
      const path = join(this.controlRoot, instructions.file);
      const current = await readOptional(path);
      return { path, installed: current !== undefined, matches: current?.includes(renderForgeInstructionBlock(config)) ?? false };
    })() : undefined;
    const subagentsPath = join(this.controlRoot, ".pi", "subagents.json");
    const subagentsContent = await readOptional(subagentsPath);
    const subagentsStatus = await (async () => {
      if (!subagentsContent) return { path: subagentsPath, strict: false };
      try {
        const settings = JSON.parse(subagentsContent) as Record<string, unknown>;
        return { path: subagentsPath, strict: settings.fallbackSubagent === "none" && settings.disableDefaultAgents === false };
      } catch {
        return { path: subagentsPath, strict: false };
      }
    })();
    const context = config.repositoryContext;
    const repositoryContextStatus = context ? await (async () => {
      const configuredPaths = [...new Set([
        ...context.entryPoints,
        ...context.architectureDocs,
        ...context.adrDirectories,
        ...context.supplementalInstructions,
      ])].sort();
      const existence = await Promise.all(configuredPaths.map(async (path) => ({ path, exists: await exists(join(this.controlRoot, path)) })));
      return { configuredPaths, missingPaths: existence.filter((entry) => !entry.exists).map((entry) => entry.path) };
    })() : undefined;
    return {
      configured: true,
      config,
      configHash: stableHash(config),
      templateStatus,
      ...(instructionStatus ? { instructionStatus } : {}),
      ...(repositoryContextStatus ? { repositoryContextStatus } : {}),
      subagentsStatus,
    };
  }
}
