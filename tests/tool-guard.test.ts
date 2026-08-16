import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { activeForgeWorkItems, findForgeControlRoot, registerFormalAgentToolGuard } from "../src/subagents/tool-guard.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture(status: string, issueStatus?: string) {
  const root = await mkdtemp(join(tmpdir(), "pi-forge-tool-guard-"));
  roots.push(root);
  await mkdir(join(root, ".pi"), { recursive: true });
  await writeFile(join(root, ".pi", "forge.json"), JSON.stringify({ artifacts: { root: ".forge" } }));
  const workItemRoot = join(root, ".forge", "work-items", "WI-0001-test");
  await mkdir(join(workItemRoot, "runtime"), { recursive: true });
  await writeFile(join(workItemRoot, "runtime", "state.json"), JSON.stringify({ workItemId: "WI-0001-test", status }));
  if (issueStatus) {
    await mkdir(join(workItemRoot, "issues", "I001", "runtime"), { recursive: true });
    await writeFile(join(workItemRoot, "issues", "I001", "runtime", "state.json"), JSON.stringify({ issueStatus }));
  }
  return { root, workItemRoot };
}

describe("formal Forge Agent tool guard", () => {
  it("discovers the Control Root from a nested Target Repository path", async () => {
    const { root } = await fixture("discovery");
    const nested = join(root, "repositories", "target", "src");
    await mkdir(nested, { recursive: true });
    expect(await findForgeControlRoot(nested)).toBe(root);
    expect(await activeForgeWorkItems(nested)).toEqual([{ workItemRoot: join(root, ".forge", "work-items", "WI-0001-test"), workItemId: "WI-0001-test", status: "discovery" }]);
  });

  it("keeps a frozen Work Item active until every materialized Issue reaches a terminal status", async () => {
    const active = await fixture("frozen", "blocked");
    expect(await activeForgeWorkItems(active.root)).toHaveLength(1);
    const terminal = await fixture("frozen", "completed");
    expect(await activeForgeWorkItems(terminal.root)).toEqual([]);
  });

  it("blocks only the ordinary Agent tool while a Forge Work Item is active", async () => {
    const { root } = await fixture("reviewing");
    let handler: ((event: any, ctx: any) => Promise<any>) | undefined;
    const pi = { on(event: string, next: typeof handler) { if (event === "tool_call") handler = next; } } as unknown as ExtensionAPI;
    registerFormalAgentToolGuard(pi);
    expect(await handler!({ toolName: "read", input: {} }, { cwd: root })).toBeUndefined();
    const blocked = await handler!({ toolName: "Agent", input: { subagent_type: "Explore" } }, { cwd: root });
    expect(blocked).toMatchObject({ block: true });
    expect(blocked.reason).toContain("ordinary Agent, Explore, and Plan cannot substitute");
  });
});
