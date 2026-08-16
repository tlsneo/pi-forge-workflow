const REPOSITORY_PATH = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
const REPOSITORY_REFERENCE = /([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)(?:#([A-Za-z_$][A-Za-z0-9_$.-]*)|:\d+(?:-\d+)?)/g;

function safeRepositoryPath(path: string): boolean {
  return REPOSITORY_PATH.test(path) && !path.split("/").includes("..");
}

export function repositoryEvidenceSeams(evidence: string[]): string[] {
  const seams = new Set<string>();
  for (const item of evidence) {
    const trimmed = item.trim();
    if (safeRepositoryPath(trimmed)) seams.add(trimmed);
    for (const match of trimmed.matchAll(REPOSITORY_REFERENCE)) {
      const path = match[1];
      if (!path || !safeRepositoryPath(path)) continue;
      seams.add(path);
      if (match[2]) seams.add(`${path}#${match[2]}`);
    }
  }
  return [...seams].sort();
}

export function hasRepositoryEvidenceSeam(evidence: string[]): boolean {
  return repositoryEvidenceSeams(evidence).length > 0;
}
