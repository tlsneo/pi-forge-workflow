#!/usr/bin/env node
import { resolve } from "node:path";
import { demoDag, modelPolicy } from "../examples/fixture.js";
import { RuntimeService } from "../src/runtime/service.js";

const [command, rootInput] = process.argv.slice(2);
if (!command || !rootInput) {
  console.error("Usage: npm run runtime -- <init-demo|status|doctor|frontier> <runtime-root>");
  process.exit(2);
}

const root = resolve(rootInput);
const service = new RuntimeService(root);

switch (command) {
  case "init-demo":
    await service.initialize({
      workItemId: "work-item-demo",
      issueId: "issue-demo",
      issueHash: "issue-hash-demo",
      workspaceRoot: process.cwd(),
      workspaceMode: "shared-serial",
      issueModelProfile: "simple",
      auditModelProfile: "rigorous",
      modelPolicy,
    }, demoDag());
    console.log(`Initialized ${root}`);
    break;
  case "status":
    console.log(JSON.stringify(await service.status(), null, 2));
    break;
  case "doctor":
    console.log(JSON.stringify(await service.doctor(), null, 2));
    break;
  case "frontier":
    console.log(JSON.stringify(await service.frontier()));
    break;
  default:
    console.error(`Unknown command: ${command}`);
    process.exit(2);
}
