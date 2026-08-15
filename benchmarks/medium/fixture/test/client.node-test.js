import assert from "node:assert/strict";
import test from "node:test";

import { createClient } from "../src/client.js";
import { createConfig } from "../src/config.js";

test("request descriptions use the configured retry count", () => {
  assert.deepEqual(createClient(createConfig()).describeRequest("/users"), {
    path: "/users",
    retries: 2,
  });
});
