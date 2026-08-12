import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const expected = [
  "forge-init",
  "forge-prd",
  "forge-map",
  "forge-options",
  "forge-design",
  "forge-spec",
  "forge-issues",
  "forge-tasks",
  "forge-run",
  "forge-check",
  "forge-audit",
];

describe("Forge Skills package", () => {
  it("contains the current Forge Skill set with unique frontmatter names", async () => {
    const names = await Promise.all(expected.map(async (directory) => {
      const content = await readFile(join(process.cwd(), "skills", directory, "SKILL.md"), "utf8");
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
