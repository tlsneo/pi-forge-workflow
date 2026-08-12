import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { allocateWorkItem } from "../src/work-item/naming.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Work Item directory naming", () => {
  it("allocates sortable WI numbers while keeping the immutable ID free of display metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-forge-work-item-naming-"));
    roots.push(root);
    const workItemsRoot = join(root, ".forge", "work-items");

    const first = await allocateWorkItem(workItemsRoot, "Normalize Apple Dolby Vision P5 codec tag", "031f3afc");
    const second = await allocateWorkItem(workItemsRoot, "Fix playback", "a1b2c3d4");

    expect(first.workItemId).toBe("normalize-apple-dolby-vision-p5-codec-ta-031f3afc");
    expect(first.directoryName).toBe("WI-0001-normalize-apple-dolby-vision-p5-codec-ta-031f3afc");
    expect(second.directoryName).toBe("WI-0002-fix-playback-a1b2c3d4");
    expect(JSON.parse(await readFile(join(workItemsRoot, ".work-item-sequence.json"), "utf8"))).toMatchObject({
      schemaVersion: 1,
      lastIssued: 2,
    });
  });

  it("continues after the highest numbered directory when upgrading legacy Work Items", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-forge-work-item-naming-"));
    roots.push(root);
    const workItemsRoot = join(root, ".forge", "work-items");
    await mkdir(join(workItemsRoot, "legacy-item-deadbeef"), { recursive: true });
    await mkdir(join(workItemsRoot, "WI-0007-existing-cafebabe"), { recursive: true });

    const allocation = await allocateWorkItem(workItemsRoot, "Next change", "12345678");

    expect(allocation.directoryName).toBe("WI-0008-next-change-12345678");
  });
});
