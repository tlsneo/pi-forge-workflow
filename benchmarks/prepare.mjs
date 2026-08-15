import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const benchmarkRoot = dirname(fileURLToPath(import.meta.url));
const caseName = process.argv[2];
const allowed = new Set(["simple", "medium", "hard"]);
if (!caseName || !allowed.has(caseName)) {
  console.error("Usage: node benchmarks/prepare.mjs <simple|medium|hard>");
  process.exit(1);
}

const fixtureRoot = join(benchmarkRoot, caseName, "fixture");
const destination = await mkdtemp(join(tmpdir(), `pi-forge-benchmark-${caseName}-`));
await cp(fixtureRoot, destination, { recursive: true });

function git(...args) {
  return execFileSync("git", args, { cwd: destination, encoding: "utf8" }).trim();
}

execFileSync("npm", ["test"], { cwd: destination, stdio: "inherit" });
git("init", "-q");
git("config", "user.email", "forge-benchmark@example.com");
git("config", "user.name", "Forge Benchmark");
git("add", ".");
git("commit", "-qm", `chore: create ${caseName} benchmark baseline`);

console.log(JSON.stringify({
  case: caseName,
  repositoryRoot: destination,
  baselineCommit: git("rev-parse", "HEAD"),
  requirement: (await readFile(join(benchmarkRoot, caseName, "CASE.md"), "utf8")).trim(),
}, null, 2));
