import { describe, expect, it } from "vitest";
import { proportionalityPolicyLines } from "../src/policy/proportionality.js";

describe("Proportionality Policy", () => {
  it("keeps planning, implementation, and review proportional without weakening required work", () => {
    const planning = proportionalityPolicyLines("planning").join("\n");
    const implementation = proportionalityPolicyLines("implementation").join("\n");
    const review = proportionalityPolicyLines("review").join("\n");

    expect(planning).toContain("live uncertainty");
    expect(planning).toContain("smallest sufficient design");
    expect(implementation).toContain("reachable supported-use failure");
    expect(implementation).toContain("stop when the promised artifact");
    expect(review).toContain("bounds proposed work, not discovery");
    expect(review).toContain("Passing with no findings is valid");
    for (const policy of [planning, implementation, review]) {
      expect(policy).toContain("Explicitly required security, migration, compatibility, verification, review, and mechanical integrity work remains required");
    }
  });
});
