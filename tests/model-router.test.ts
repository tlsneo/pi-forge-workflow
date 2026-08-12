import { describe, expect, it } from "vitest";
import { modelPolicy } from "../examples/fixture.js";
import { resolveModelProfile } from "../src/model/router.js";

describe("resolveModelProfile", () => {
  it("uses task then issue then role then default precedence", () => {
    expect(resolveModelProfile(modelPolicy, {
      role: "task-worker",
      taskProfile: "rigorous",
      issueProfile: "simple",
    })).toMatchObject({ profile: "rigorous", source: "task", model: "test/complex" });

    expect(resolveModelProfile(modelPolicy, {
      role: "task-worker",
      issueProfile: "rigorous",
    })).toMatchObject({ profile: "rigorous", source: "issue" });

    expect(resolveModelProfile(modelPolicy, { role: "issue-auditor" })).toMatchObject({
      profile: "rigorous",
      source: "role",
    });
  });

  it("fails closed for an unknown profile", () => {
    expect(() => resolveModelProfile(modelPolicy, { role: "task-worker", taskProfile: "missing" })).toThrow(
      "Unknown model profile",
    );
  });
});
