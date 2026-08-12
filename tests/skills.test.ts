import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const expected = ["forge-init", "forge-prd", "forge-issues", "forge-tasks", "forge-run"];

describe("Forge Skills package", () => {
  it("exposes only the five executable public workflow Skills", async () => {
    const skillRoot = join(process.cwd(), "skills");
    const directories = (await readdir(skillRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(directories).toEqual(expected.slice().sort());

    const names = await Promise.all(expected.map(async (directory) => {
      const content = await readFile(join(skillRoot, directory, "SKILL.md"), "utf8");
      expect(content.startsWith("---\n")).toBe(true);
      const name = /^name: (.+)$/m.exec(content)?.[1];
      const description = /^description: (.+)$/m.exec(content)?.[1];
      expect(name).toBe(directory);
      expect(description?.length).toBeGreaterThan(20);
      expect(content).toContain("disable-model-invocation: true");
      return name;
    }));
    expect(new Set(names).size).toBe(expected.length);
  });
});
