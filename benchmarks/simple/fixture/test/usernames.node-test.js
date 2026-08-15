import assert from "node:assert/strict";
import test from "node:test";

import { formatDisplayName } from "../src/usernames.js";

test("formatDisplayName removes surrounding whitespace", () => {
  assert.equal(formatDisplayName("  Ada Lovelace  "), "Ada Lovelace");
});
