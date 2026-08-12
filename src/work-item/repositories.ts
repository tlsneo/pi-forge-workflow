import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_DEPTH = 5;
const SKIPPED_DIRECTORIES = new Set([".git", ".pi", ".forge", ".agents", "node_modules", "dist", "build", "coverage"]);

export interface GitRepositoryInfo {
  id?: string;
  path: string;
  repositoryRoot: string;
  revision: string;
  branch?: string;
  remote?: string;
  dirty: boolean;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
    return result.stdout.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Git repository check failed for ${cwd}: ${message}`);
  }
}

function displayPath(controlRoot: string, repositoryRoot: string): string {
  const path = relative(controlRoot, repositoryRoot);
  return path === "" ? "." : path.split(sep).join("/");
}

export async function resolveGitRepository(controlRootInput: string, repositoryPath: string): Promise<GitRepositoryInfo> {
  const controlRoot = await realpath(resolve(controlRootInput));
  const requested = await realpath(isAbsolute(repositoryPath) ? repositoryPath : resolve(controlRoot, repositoryPath));
  if (!(await stat(requested)).isDirectory()) throw new Error(`Target Repository path is not a directory: ${repositoryPath}`);
  const topLevel = await git(requested, ["rev-parse", "--show-toplevel"]);
  const repositoryRoot = await realpath(topLevel);
  if ((await git(repositoryRoot, ["rev-parse", "--is-bare-repository"])) === "true") {
    throw new Error(`Target Repository has no working tree: ${repositoryRoot}`);
  }
  const revision = await git(repositoryRoot, ["rev-parse", "HEAD"]);
  if (!revision) throw new Error(`Target Repository requires at least one commit: ${repositoryRoot}`);
  const branch = await git(repositoryRoot, ["branch", "--show-current"]).catch(() => "");
  const remote = await git(repositoryRoot, ["remote", "get-url", "origin"]).catch(() => "");
  const dirty = Boolean(await git(repositoryRoot, ["status", "--porcelain"]));
  return {
    path: displayPath(controlRoot, repositoryRoot),
    repositoryRoot,
    revision,
    ...(branch ? { branch } : {}),
    ...(remote ? { remote } : {}),
    dirty,
  };
}

export async function discoverGitRepositories(controlRootInput: string, maxDepth = DEFAULT_MAX_DEPTH): Promise<GitRepositoryInfo[]> {
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 12) throw new Error("Repository scan maxDepth must be between 0 and 12");
  const controlRoot = await realpath(resolve(controlRootInput));
  if (!(await stat(controlRoot)).isDirectory()) throw new Error(`Control Root is not a directory: ${controlRoot}`);
  const candidates = new Set<string>();

  const walk = async (directory: string, depth: number): Promise<void> => {
    if (await exists(resolve(directory, ".git"))) candidates.add(directory);
    if (depth >= maxDepth) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIPPED_DIRECTORIES.has(entry.name)) continue;
      await walk(resolve(directory, entry.name), depth + 1);
    }
  };
  await walk(controlRoot, 0);

  const repositories = new Map<string, GitRepositoryInfo>();
  for (const candidate of candidates) {
    try {
      const repository = await resolveGitRepository(controlRoot, candidate);
      repositories.set(repository.repositoryRoot, repository);
    } catch {
      // Invalid, bare, or unborn Git candidates are not selectable Working Trees.
    }
  }
  return [...repositories.values()]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((repository, index) => ({ ...repository, id: `R${String(index + 1).padStart(3, "0")}` }));
}

export async function findForgeControlRoot(start: string): Promise<string> {
  let current = await realpath(resolve(start));
  while (true) {
    if (await exists(resolve(current, ".pi", "forge.json"))) return current;
    const parent = resolve(current, "..");
    if (parent === current) throw new Error(`Forge is not configured for ${start}; run /skill:forge-init from the Control Workspace`);
    current = parent;
  }
}
