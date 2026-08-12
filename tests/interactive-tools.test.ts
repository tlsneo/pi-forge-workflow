import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ForgeConfig } from "../src/config/types.js";
import { startInteractiveExplore } from "../extensions/forge-workflow/interactive-tools.js";
import type { PiSubagentsAdapter } from "../src/subagents/adapter.js";

const roots: string[] = [];

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

async function initRepository(path: string) {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "README.md"), "repository\n");
  git(path, "init", "-q");
  git(path, "config", "user.email", "forge@example.com");
  git(path, "config", "user.name", "Forge Test");
  git(path, "add", ".");
  git(path, "commit", "-qm", "baseline");
}

function config(): ForgeConfig {
  return {
    schemaVersion: 1,
    generation: 1,
    artifacts: { root: ".forge", gitPolicy: "ignore" },
    tracker: { mode: "local", publishRequiresConfirmation: true },
    workspace: { mode: "shared-serial", isolationBackend: "none", poolSize: 1 },
    models: {
      profiles: {
        simple: { model: "test/simple", thinking: "low", maxTurns: 12 },
        audit: { model: "test/audit", thinking: "high", maxTurns: 40 },
        verifier: { model: "test/verifier", thinking: "high", maxTurns: 30 },
      },
      routing: {
        interactiveExplore: "simple",
        prdCoverageReview: "audit",
        prdEvidenceReview: "audit",
        prdArchitectureReview: "audit",
        blockerVerifier: "verifier",
      },
    },
    review: {
      preset: "standard",
      prd: { coverageReviewers: 1, evidenceReviewers: 1, architectureReviewers: 1 },
      blockerVerification: { profile: "verifier", requireDifferentModel: true },
    },
    commands: {},
    agents: { directory: ".pi/agents", templateVersion: 2 },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("interactive repository Explore", () => {
  it("spawns read-only Explore in the selected Repo without worktree isolation", async () => {
    const controlRoot = await mkdtemp(join(tmpdir(), "pi-forge-interactive-control-"));
    roots.push(controlRoot);
    await mkdir(join(controlRoot, ".pi"), { recursive: true });
    await writeFile(join(controlRoot, ".pi", "forge.json"), JSON.stringify(config()));
    const repoA = join(controlRoot, "repo-a");
    const repoB = join(controlRoot, "repo-b");
    await initRepository(repoA);
    await initRepository(repoB);
    const spawn = vi.fn().mockResolvedValue("agent-1");
    const adapter = { ping: vi.fn().mockResolvedValue(2), spawn } as unknown as PiSubagentsAdapter;

    const result = await startInteractiveExplore(controlRoot, {
      repositoryRoot: "repo-b",
      prompt: "Inspect the player entry path without editing files.",
      description: "Analyze player path",
    }, adapter);

    const canonicalRepoB = await realpath(repoB);
    expect(result.repository.repositoryRoot).toBe(canonicalRepoB);
    expect(spawn).toHaveBeenCalledWith({
      type: "Explore",
      prompt: "Inspect the player entry path without editing files.",
      description: "Analyze player path",
      model: "test/simple",
      thinkingLevel: "low",
      maxTurns: 12,
      cwd: canonicalRepoB,
    });
    expect(spawn.mock.calls[0]?.[0]).not.toHaveProperty("isolation");
  });

  it("finds the Control Root when Pi starts inside one selected Repo", async () => {
    const controlRoot = await mkdtemp(join(tmpdir(), "pi-forge-interactive-nested-"));
    roots.push(controlRoot);
    await mkdir(join(controlRoot, ".pi"), { recursive: true });
    await writeFile(join(controlRoot, ".pi", "forge.json"), JSON.stringify(config()));
    const repositoryRoot = join(controlRoot, "products", "app");
    await initRepository(repositoryRoot);
    const adapter = {
      ping: vi.fn().mockResolvedValue(2),
      spawn: vi.fn().mockResolvedValue("agent-2"),
    } as unknown as PiSubagentsAdapter;

    const result = await startInteractiveExplore(repositoryRoot, {
      repositoryRoot,
      prompt: "Inspect one bounded symbol.",
      description: "Inspect bounded symbol",
    }, adapter);

    expect(result.controlRoot).toBe(await realpath(controlRoot));
    expect(result.repository.repositoryRoot).toBe(await realpath(repositoryRoot));
  });
});
