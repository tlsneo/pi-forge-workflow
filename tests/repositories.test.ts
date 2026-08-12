import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverGitRepositories, resolveGitRepository } from "../src/work-item/repositories.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

async function initRepository(root: string, file = "src/value.ts"): Promise<string> {
  await mkdir(join(root, file, ".."), { recursive: true });
  await writeFile(join(root, file), "export const value = 1;\n");
  git(root, "init", "-q");
  git(root, "config", "user.email", "forge@example.com");
  git(root, "config", "user.name", "Forge Test");
  git(root, "add", ".");
  git(root, "commit", "-qm", "baseline");
  return git(root, "rev-parse", "HEAD");
}

describe("Forge Target Repository resolution", () => {
  it("discovers multiple Git Working Trees under a non-Git Control Workspace", async () => {
    const controlRoot = await mkdtemp(join(tmpdir(), "pi-forge-workspace-"));
    roots.push(controlRoot);
    await initRepository(join(controlRoot, "subproject1"));
    await initRepository(join(controlRoot, "third_party_debug", "seanime-tenji"));

    const repositories = await discoverGitRepositories(controlRoot);
    expect(repositories.map((repository) => repository.path)).toEqual(["subproject1", "third_party_debug/seanime-tenji"]);
    expect(repositories.map((repository) => repository.id)).toEqual(["R001", "R002"]);
  });

  it("selects an inner independent Repository even when the outer Repository ignores it", async () => {
    const controlRoot = await mkdtemp(join(tmpdir(), "pi-forge-nested-"));
    roots.push(controlRoot);
    await mkdir(join(controlRoot, "third_party_debug"), { recursive: true });
    await writeFile(join(controlRoot, ".gitignore"), "/third_party_debug/\n");
    await writeFile(join(controlRoot, "README.md"), "outer\n");
    git(controlRoot, "init", "-q");
    git(controlRoot, "config", "user.email", "forge@example.com");
    git(controlRoot, "config", "user.name", "Forge Test");
    git(controlRoot, "add", ".");
    git(controlRoot, "commit", "-qm", "outer baseline");
    const nested = join(controlRoot, "third_party_debug", "seanime-tenji");
    const nestedRevision = await initRepository(nested);

    const selected = await resolveGitRepository(controlRoot, "third_party_debug/seanime-tenji/src");
    expect(selected.repositoryRoot).toBe(await resolveGitRepository(controlRoot, nested).then((repository) => repository.repositoryRoot));
    expect(selected.revision).toBe(nestedRevision);
    expect(selected.path).toBe("third_party_debug/seanime-tenji");
  });

  it("resolves a linked Git Worktree through the same Target Repository interface", async () => {
    const controlRoot = await mkdtemp(join(tmpdir(), "pi-forge-worktree-control-"));
    roots.push(controlRoot);
    const source = join(controlRoot, "source");
    await initRepository(source);
    const worktree = join(controlRoot, "feature-worktree");
    git(source, "worktree", "add", "-qb", "feature", worktree);
    const selected = await resolveGitRepository(controlRoot, worktree);
    expect(selected.path).toBe("feature-worktree");
    expect(selected.repositoryRoot).toContain("feature-worktree");
  });

  it("resolves a Git submodule through the same Target Repository interface", async () => {
    const controlRoot = await mkdtemp(join(tmpdir(), "pi-forge-submodule-control-"));
    roots.push(controlRoot);
    const source = join(controlRoot, "source-repository");
    await initRepository(source);
    const parent = join(controlRoot, "parent");
    await mkdir(parent, { recursive: true });
    await writeFile(join(parent, "README.md"), "parent\n");
    git(parent, "init", "-q");
    git(parent, "config", "user.email", "forge@example.com");
    git(parent, "config", "user.name", "Forge Test");
    git(parent, "add", ".");
    git(parent, "commit", "-qm", "parent baseline");
    git(parent, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "modules/app");
    git(parent, "commit", "-qm", "add submodule");
    const selected = await resolveGitRepository(controlRoot, "parent/modules/app");
    expect(selected.path).toBe("parent/modules/app");
  });

  it("normalizes a Monorepo package directory to its one Git Root", async () => {
    const controlRoot = await mkdtemp(join(tmpdir(), "pi-forge-monorepo-"));
    roots.push(controlRoot);
    await initRepository(controlRoot, "packages/app/src/value.ts");
    const selected = await resolveGitRepository(controlRoot, "packages/app");
    expect(selected.path).toBe(".");
  });
});
