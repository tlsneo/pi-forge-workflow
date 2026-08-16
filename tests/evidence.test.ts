import { describe, expect, it } from "vitest";
import { hasRepositoryEvidenceSeam, repositoryEvidenceSeams } from "../src/runtime/evidence.js";

describe("repository evidence seams", () => {
  it("normalizes exact paths, line citations, and path#symbol references without rewriting evidence", () => {
    expect(repositoryEvidenceSeams([
      "src/request-policy.js:2-8 validates the configured timeout",
      "Inspect src/client.js#createClient for the public composition seam",
      "test/client.node-test.js",
      "Dockerfile:12 defines the image build",
      ".gitignore:3 excludes generated state",
      "Makefile#build",
      "PRD AC-001 requires timeout validation",
    ])).toEqual([
      ".gitignore",
      "Dockerfile",
      "Makefile",
      "Makefile#build",
      "src/client.js",
      "src/client.js#createClient",
      "src/request-policy.js",
      "test/client.node-test.js",
    ]);
  });

  it("does not treat prose without a repository reference as a repair seam", () => {
    expect(hasRepositoryEvidenceSeam(["The behavior appears incorrect", "Run npm test"])).toBe(false);
  });
});
