#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { WorkItemService } from "../src/work-item/service.js";
import type { DiscoveryCheckpoint, ForgePrd, PrdReview } from "../src/work-item/types.js";

const [command, rootInput, ...args] = process.argv.slice(2);
if (!command || !rootInput) {
  console.error("Usage: npm run prd-runtime -- <init|status|checkpoint|submit|amend|review|approve|freeze> <work-item-root> [...args]");
  process.exit(2);
}

const root = resolve(rootInput);
const service = new WorkItemService(root);

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(resolve(path), "utf8")) as T;
}

switch (command) {
  case "init": {
    const [workItemId, title, repositoryRoot, repositoryRevision] = args;
    if (!workItemId || !title || !repositoryRoot || !repositoryRevision) {
      throw new Error("init requires: <work-item-id> <title> <repository-root> <repository-revision>");
    }
    console.log(JSON.stringify(await service.initialize({
      workItemId,
      title,
      repositoryRoot: resolve(repositoryRoot),
      repositoryRevision,
    }), null, 2));
    break;
  }
  case "status":
    console.log(JSON.stringify(await service.open(), null, 2));
    break;
  case "checkpoint": {
    const [path] = args;
    if (!path) throw new Error("checkpoint requires a JSON file");
    console.log(JSON.stringify(await service.checkpoint(await readJson<DiscoveryCheckpoint>(path)), null, 2));
    break;
  }
  case "submit": {
    const [path] = args;
    if (!path) throw new Error("submit requires a PRD JSON file");
    console.log(JSON.stringify(await service.submitPrd(await readJson<ForgePrd>(path)), null, 2));
    break;
  }
  case "amend": {
    const [path] = args;
    if (!path) throw new Error("amend requires an amendment JSON file");
    const amendment = await readJson<Parameters<WorkItemService["amendPrd"]>[0]>(path);
    console.log(JSON.stringify(await service.amendPrd(amendment), null, 2));
    break;
  }
  case "review": {
    const [path] = args;
    if (!path) throw new Error("review requires a review JSON file");
    const review = await readJson<Omit<PrdReview, "submittedAt">>(path);
    console.log(JSON.stringify(await service.submitReview(review), null, 2));
    break;
  }
  case "approve": {
    const [approvedBy, ...evidenceParts] = args;
    if (!approvedBy || evidenceParts.length === 0) throw new Error("approve requires <actor> <approval-evidence>");
    console.log(JSON.stringify(await service.approve({ approvedBy, evidence: evidenceParts.join(" ") }), null, 2));
    break;
  }
  case "freeze":
    console.log(JSON.stringify(await service.freeze(), null, 2));
    break;
  default:
    throw new Error(`Unknown command: ${command}`);
}
