export interface StableVersion {
  version: string;
  releaseTag: string;
  majorTag: string;
  major: number;
  minor: number;
  patch: number;
}

export interface ReleaseSource {
  branch: string;
  headSha: string;
  remoteMainSha: string;
  clean: boolean;
}

export interface ExistingRelease {
  tag: string;
  targetSha: string;
  draft: boolean;
  id?: number;
}

export interface PublicationState {
  version: string;
  sourceSha: string;
  release: ExistingRelease | null;
  releaseTagSha: string | null;
  majorTagSha: string | null;
  latestMajorRelease: string | null;
}

export interface PublicationPlan {
  createRelease: boolean;
  publishRelease: boolean;
  updateMajorTag: boolean;
  resumed: boolean;
}

export type PublicationOperation = "create-release" | "publish-release" | "update-major-tag";

export interface CheckEvidence {
  name: string;
  conclusion: string | null;
}

export interface PullRequestEvidence {
  number: number;
  merged: boolean;
  headRepository: string;
  headTreeSha: string;
  checks: CheckEvidence[];
}

export interface ReleaseEvidence {
  repository: string;
  sourceTreeSha: string;
  mainChecks: CheckEvidence[];
  pullRequests: PullRequestEvidence[];
}

export interface MajorRollbackState {
  targetVersion: string;
  targetSha: string | null;
  published: boolean;
  immutable: boolean;
  currentMajorSha: string | null;
}

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseStableVersion(version: string): StableVersion {
  const match = STABLE_VERSION.exec(version);
  if (!match) {
    throw new Error(
      `Package version must be a stable semantic version such as 1.2.3; received ${JSON.stringify(version)}.`,
    );
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return {
    version,
    releaseTag: `v${version}`,
    majorTag: `v${major}`,
    major,
    minor,
    patch,
  };
}

export function compareStableVersions(left: string, right: string): number {
  const leftVersion = parseStableVersion(left);
  const rightVersion = parseStableVersion(right);
  for (const part of ["major", "minor", "patch"] as const) {
    const difference = leftVersion[part] - rightVersion[part];
    if (difference !== 0) return difference;
  }
  return 0;
}

export function assertReleaseSource(source: ReleaseSource): void {
  if (!source.clean) throw new Error("The release worktree must be clean.");
  if (source.branch !== "main")
    throw new Error("Releases must be dispatched from the main branch.");
  if (source.headSha !== source.remoteMainSha) {
    throw new Error("The local release commit must exactly match origin/main.");
  }
}

export function planReleasePublication(state: PublicationState): PublicationPlan {
  const version = parseStableVersion(state.version);

  if (state.latestMajorRelease) {
    const latest = parseStableVersion(state.latestMajorRelease);
    if (latest.major !== version.major) {
      throw new Error(
        `Latest major release ${latest.version} does not belong to ${version.majorTag}.`,
      );
    }
    if (compareStableVersions(version.version, latest.version) < 0) {
      throw new Error(
        `Release ${version.releaseTag} is older than the latest ${version.majorTag} release v${latest.version}.`,
      );
    }
  }

  if (state.releaseTagSha && state.releaseTagSha !== state.sourceSha) {
    throw new Error(
      `Immutable version tag ${version.releaseTag} already points to a different commit.`,
    );
  }

  if (state.release) {
    if (state.release.tag !== version.releaseTag) {
      throw new Error(
        `Existing release tag ${state.release.tag} does not match ${version.releaseTag}.`,
      );
    }
    if (state.release.targetSha !== state.sourceSha) {
      throw new Error(`Existing release ${version.releaseTag} points to a different commit.`);
    }
  }

  const createRelease = state.release === null;
  const publishRelease = createRelease || Boolean(state.release?.draft);
  return {
    createRelease,
    publishRelease,
    updateMajorTag: state.majorTagSha !== state.sourceSha,
    resumed: !createRelease,
  };
}

export function publicationOperations(
  plan: PublicationPlan,
  dryRun: boolean,
): PublicationOperation[] {
  if (dryRun) return [];
  const operations: PublicationOperation[] = [];
  if (plan.createRelease) operations.push("create-release");
  if (plan.publishRelease) operations.push("publish-release");
  if (plan.updateMajorTag) operations.push("update-major-tag");
  return operations;
}

function passed(checks: CheckEvidence[], name: string): boolean {
  return checks.some((check) => check.name === name && check.conclusion === "success");
}

export function verifyReleaseEvidence(evidence: ReleaseEvidence): { pullRequestNumber: number } {
  if (!passed(evidence.mainChecks, "quality")) {
    throw new Error("The exact main commit does not have a successful quality check.");
  }

  const merged = evidence.pullRequests.filter((pullRequest) => pullRequest.merged);
  const sameRepository = merged.filter(
    (pullRequest) => pullRequest.headRepository === evidence.repository,
  );
  if (sameRepository.length === 0) {
    throw new Error("The release must originate from a merged same-repository pull request.");
  }

  const exactTree = sameRepository.filter(
    (pullRequest) => pullRequest.headTreeSha === evidence.sourceTreeSha,
  );
  if (exactTree.length === 0) {
    throw new Error("No same-repository pull request tested the exact release tree.");
  }

  const smokeTested = exactTree.find((pullRequest) => passed(pullRequest.checks, "publish"));
  if (!smokeTested) {
    throw new Error("The exact release tree does not have a successful production smoke check.");
  }

  return { pullRequestNumber: smokeTested.number };
}

export function planMajorRollback(state: MajorRollbackState): {
  majorTag: string;
  updateMajorTag: boolean;
} {
  const version = parseStableVersion(state.targetVersion);
  if (!state.targetSha || !state.published || !state.immutable) {
    throw new Error("A rollback target must be an immutable published release.");
  }
  return {
    majorTag: version.majorTag,
    updateMajorTag: state.currentMajorSha !== state.targetSha,
  };
}
