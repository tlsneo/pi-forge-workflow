import { constants } from "node:fs";
import { access, mkdir, readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { atomicWriteJson, RuntimeStore } from "../runtime/store.js";

const DIRECTORY_PREFIX = /^WI-(\d+)-/;
const SEQUENCE_FILE = ".work-item-sequence.json";

interface WorkItemSequence {
  schemaVersion: 1;
  lastIssued: number;
  updatedAt: string;
}

export interface WorkItemAllocation {
  sequence: number;
  workItemId: string;
  directoryName: string;
  root: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function slugifyWorkItemTitle(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "change";
}

async function readLastIssued(workItemsRoot: string): Promise<number> {
  const sequencePath = join(workItemsRoot, SEQUENCE_FILE);
  if (!(await exists(sequencePath))) return 0;
  const sequence = JSON.parse(await readFile(sequencePath, "utf8")) as Partial<WorkItemSequence>;
  if (sequence.schemaVersion !== 1 || !Number.isSafeInteger(sequence.lastIssued) || (sequence.lastIssued ?? 0) < 0) {
    throw new Error(`Invalid Work Item sequence: ${sequencePath}`);
  }
  return sequence.lastIssued as number;
}

async function highestDirectorySequence(workItemsRoot: string): Promise<number> {
  const entries = await readdir(workItemsRoot, { withFileTypes: true });
  let highest = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = DIRECTORY_PREFIX.exec(entry.name);
    if (!match) continue;
    const sequence = Number(match[1]);
    if (Number.isSafeInteger(sequence)) highest = Math.max(highest, sequence);
  }
  return highest;
}

export async function allocateWorkItem(
  workItemsRoot: string,
  title: string,
  uniqueSuffix = randomUUID().slice(0, 8),
): Promise<WorkItemAllocation> {
  await mkdir(workItemsRoot, { recursive: true });
  return new RuntimeStore(workItemsRoot).withLock(async () => {
    const sequence = Math.max(
      await readLastIssued(workItemsRoot),
      await highestDirectorySequence(workItemsRoot),
    ) + 1;
    await atomicWriteJson(join(workItemsRoot, SEQUENCE_FILE), {
      schemaVersion: 1,
      lastIssued: sequence,
      updatedAt: new Date().toISOString(),
    } satisfies WorkItemSequence);

    const workItemId = `${slugifyWorkItemTitle(title)}-${uniqueSuffix}`;
    const directoryName = `WI-${String(sequence).padStart(4, "0")}-${workItemId}`;
    return {
      sequence,
      workItemId,
      directoryName,
      root: join(workItemsRoot, directoryName),
    };
  });
}
