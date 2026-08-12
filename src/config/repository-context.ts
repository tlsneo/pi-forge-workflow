import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { RepositoryContextConfig } from "./types.js";

const SKIP_DIRECTORIES = new Set([".git", ".forge", ".pi", ".scratch", "node_modules", "dist", "build", "coverage", ".next"]);

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function repositoryPath(repositoryRoot: string, absolutePath: string): string {
  return relative(repositoryRoot, absolutePath).split(sep).join("/");
}

export async function discoverRepositoryContext(repositoryRoot: string, maxDepth = 4): Promise<RepositoryContextConfig> {
  const contextFiles: string[] = [];
  const adrDirectories: string[] = [];
  const architectureDocs: string[] = [];

  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const path = repositoryPath(repositoryRoot, absolute);
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        if (path === "docs/adr" || path.endsWith("/docs/adr")) adrDirectories.push(path);
        if (path === "docs/architecture" || path.endsWith("/docs/architecture")) architectureDocs.push(path);
        await walk(absolute, depth + 1);
      } else if (entry.isFile() && entry.name === "CONTEXT.md") {
        contextFiles.push(path);
      }
    }
  }

  await walk(repositoryRoot, 0);
  const contextMap = "CONTEXT-MAP.md";
  const hasContextMap = await exists(join(repositoryRoot, contextMap));
  const supplementalInstructions = await exists(join(repositoryRoot, "docs", "agents", "domain.md"))
    ? ["docs/agents/domain.md"]
    : [];
  const sortedContexts = [...new Set(contextFiles)].sort();
  const entryPoints = hasContextMap ? [contextMap] : sortedContexts;
  const mode: RepositoryContextConfig["mode"] = hasContextMap
    ? "context-map"
    : sortedContexts.length === 1
      ? "single-context"
      : "discovered";
  return {
    mode,
    entryPoints,
    architectureDocs: [...new Set(architectureDocs)].sort(),
    adrDirectories: [...new Set(adrDirectories)].sort(),
    supplementalInstructions,
  };
}
