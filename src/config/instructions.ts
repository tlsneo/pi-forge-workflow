import { constants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { proportionalityPolicyLines } from "../policy/proportionality.js";
import type { ForgeConfig, ForgeInstructionFile } from "./types.js";

export const FORGE_INSTRUCTIONS_START = "<!-- pi-forge-workflow:start -->";
export const FORGE_INSTRUCTIONS_END = "<!-- pi-forge-workflow:end -->";
export const PI_CONTEXT_FILE_PRIORITY: ForgeInstructionFile[] = [
  "AGENTS.override.md",
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
];

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export interface InstructionSelection {
  selectedFile: ForgeInstructionFile;
  existingFiles: ForgeInstructionFile[];
  shadowedFiles: ForgeInstructionFile[];
  requiresConfirmation: boolean;
}

export async function selectPiInstructionFile(repositoryRoot: string): Promise<InstructionSelection> {
  const existingFiles: ForgeInstructionFile[] = [];
  const seenPaths = new Set<string>();
  for (const file of PI_CONTEXT_FILE_PRIORITY) {
    const path = join(repositoryRoot, file);
    if (!(await exists(path))) continue;
    const canonical = await realpath(path);
    if (seenPaths.has(canonical)) continue;
    seenPaths.add(canonical);
    existingFiles.push(file);
  }
  const selectedFile = existingFiles[0] ?? "AGENTS.md";
  return {
    selectedFile,
    existingFiles,
    shadowedFiles: existingFiles.slice(1),
    requiresConfirmation: selectedFile === "AGENTS.override.md",
  };
}

export function renderForgeInstructionBlock(config: ForgeConfig): string {
  const contextRule = config.instructions?.templateVersion
    ? "- During `forge-prd` discovery, load applicable Repository Context sources declared in `.pi/forge.json` and carry their constraints into the frozen PRD.\n"
    : "";
  const proportionalityPolicy = (config.instructions?.templateVersion ?? 0) >= 2
    ? `\n### Proportionality Policy\n\n${proportionalityPolicyLines("planning").join("\n")}\n`
    : "";
  return `${FORGE_INSTRUCTIONS_START}
## Forge workflow

For Forge-managed changes, use \`/skill:forge-prd\` → \`/skill:forge-issues\` → \`/skill:forge-tasks\` → \`/skill:forge-run\`. Machine-readable configuration and authoritative commands live in \`.pi/forge.json\`; generated planning and Runtime artifacts live under \`${config.artifacts.root}/\`.

${contextRule}- Treat frozen PRD, Issue, Slice, and Task contracts as authoritative.
- Change Runtime state only through Forge tools; preserve immutable Generations, Bindings, Reviews, Receipts, and Audit artifacts.
- Workers follow their exact frozen versioned Task contract such as \`TASK-V001.md\`; the coordinator schedules and verifies without editing product code.
- Treat Agent termination as a lifecycle event, not Task or Review completion.
- Start \`forge-run\` from a clean committed Git baseline; it creates scoped commits only after authoritative verification.
${proportionalityPolicy}${FORGE_INSTRUCTIONS_END}`;
}

export interface ManagedInstructionPlan {
  path: string;
  current?: string;
  next: string;
  conflict: boolean;
  reason: string;
}

function markerRange(content: string): { start: number; end: number; block: string } | undefined {
  const startCount = content.split(FORGE_INSTRUCTIONS_START).length - 1;
  const endCount = content.split(FORGE_INSTRUCTIONS_END).length - 1;
  if (startCount === 0 && endCount === 0) return undefined;
  if (startCount !== 1 || endCount !== 1) {
    throw new Error("Repository instruction file has duplicate or incomplete pi-forge-workflow markers");
  }
  const start = content.indexOf(FORGE_INSTRUCTIONS_START);
  const markerEnd = content.indexOf(FORGE_INSTRUCTIONS_END, start);
  if (markerEnd < start) throw new Error("Repository instruction file has reversed pi-forge-workflow markers");
  const end = markerEnd + FORGE_INSTRUCTIONS_END.length;
  return { start, end, block: content.slice(start, end) };
}

function appendBlock(content: string, block: string): string {
  if (!content) return `${block}\n`;
  return `${content.trimEnd()}\n\n${block}\n`;
}

function replaceBlock(content: string, range: { start: number; end: number }, block: string): string {
  return `${content.slice(0, range.start)}${block}${content.slice(range.end)}`;
}

function removeBlock(content: string, range: { start: number; end: number }): string {
  const before = content.slice(0, range.start).trimEnd();
  const after = content.slice(range.end).trimStart();
  if (!before) return after ? `${after}\n` : "";
  if (!after) return `${before}\n`;
  return `${before}\n\n${after}`;
}

async function readOptional(path: string): Promise<string | undefined> {
  return (await exists(path)) ? readFile(path, "utf8") : undefined;
}

export async function planManagedInstructions(
  repositoryRoot: string,
  currentConfig: ForgeConfig | undefined,
  nextConfig: ForgeConfig,
): Promise<ManagedInstructionPlan[]> {
  if (!nextConfig.instructions) return [];
  const targetPath = join(repositoryRoot, nextConfig.instructions.file);
  const nextBlock = renderForgeInstructionBlock(nextConfig);
  const plans: ManagedInstructionPlan[] = [];

  if (currentConfig?.instructions && currentConfig.instructions.file !== nextConfig.instructions.file) {
    const oldPath = join(repositoryRoot, currentConfig.instructions.file);
    const oldContent = await readOptional(oldPath);
    if (oldContent !== undefined) {
      const range = markerRange(oldContent);
      if (range) {
        const expected = renderForgeInstructionBlock(currentConfig);
        plans.push({
          path: oldPath,
          current: oldContent,
          next: removeBlock(oldContent, range),
          conflict: range.block !== expected,
          reason: range.block === expected
            ? "Move the managed Forge workflow block to Pi's active context file"
            : "The previous managed Forge workflow block has local modifications",
        });
      }
    }
  }

  const current = await readOptional(targetPath);
  if (current === undefined) {
    plans.push({ path: targetPath, next: `${nextBlock}\n`, conflict: false, reason: "Create Pi's project context file with the managed Forge workflow block" });
    return plans;
  }
  const range = markerRange(current);
  if (!range) {
    plans.push({ path: targetPath, current, next: appendBlock(current, nextBlock), conflict: false, reason: "Append the managed Forge workflow block while preserving existing instructions" });
    return plans;
  }
  const expectedCurrent = currentConfig?.instructions?.file === nextConfig.instructions.file
    ? renderForgeInstructionBlock(currentConfig)
    : undefined;
  const conflict = range.block !== nextBlock && range.block !== expectedCurrent;
  plans.push({
    path: targetPath,
    current,
    next: replaceBlock(current, range, nextBlock),
    conflict,
    reason: conflict
      ? "The managed Forge workflow block has local modifications"
      : range.block === nextBlock
        ? "Managed Forge workflow block already matches the proposed configuration"
        : "Update the managed Forge workflow block for the proposed configuration",
  });
  return plans;
}
