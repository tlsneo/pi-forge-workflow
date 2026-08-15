import assert from "node:assert/strict";
import test from "node:test";

import { runJob } from "../src/job-runner.js";
import { JobStore } from "../src/job-store.js";

test("runJob persists a completed result", async () => {
  const store = new JobStore();
  const result = await runJob(store, { id: "J001", payload: 2 }, async (value) => value * 3);

  assert.equal(result, 6);
  assert.deepEqual(store.find("J001"), {
    id: "J001",
    payload: 2,
    status: "completed",
    result: 6,
  });
});

test("runJob persists a failed result and rethrows", async () => {
  const store = new JobStore();
  await assert.rejects(
    runJob(store, { id: "J002", payload: 2 }, async () => {
      throw new Error("boom");
    }),
    new Error("boom"),
  );

  assert.deepEqual(store.find("J002"), {
    id: "J002",
    payload: 2,
    status: "failed",
    error: "boom",
  });
});
