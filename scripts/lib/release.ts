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
  pullRequests: PullRequestEvidence[];
}

export interface CheckRunsPage {
  totalCount: number;
  checkRuns: CheckEvidence[];
}

export interface ReleasePreflightStatus {
  context: string;
  state: string;
  description: string | null;
  creator: string | null;
  createdAt: string;
}

export interface ReleasePreflightEvidence {
  sha: string;
  statuses: ReleasePreflightStatus[];
}

export interface MajorRollbackState {
  targetVersion: string;
  targetSha: string | null;
  published: boolean;
  immutable: boolean;
  currentMajorSha: string | null;
}

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const PUBLISH_CHECK_NAME = "publish";
export const RELEASE_PREFLIGHT_CONTEXT_PREFIX = "ephemeral-pages-action/preflight/";
export const RELEASE_PREFLIGHT_DESCRIPTION = "pnpm release:check passed";
const RELEASE_PREFLIGHT_MAX_AGE_MS = 15 * 60 * 1000;

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

export function verifyReleasePreflight(
  evidence: ReleasePreflightEvidence,
  expectedContext: string,
  expectedSha: string,
  expectedReviewer: string,
  dispatcher: string,
  now = Date.now(),
): void {
  const contextPattern = new RegExp(`^${RELEASE_PREFLIGHT_CONTEXT_PREFIX}[a-f0-9]{64}$`);
  if (!contextPattern.test(expectedContext)) {
    throw new Error("The release preflight attestation context is invalid.");
  }
  if (evidence.sha !== expectedSha) {
    throw new Error("The release preflight attestation does not match the release SHA.");
  }
  if (dispatcher.toLowerCase() !== expectedReviewer.toLowerCase()) {
    throw new Error("The release workflow must be dispatched by the release reviewer.");
  }
  const status = evidence.statuses.find((candidate) => candidate.context === expectedContext);
  const createdAt = status ? Date.parse(status.createdAt) : Number.NaN;
  if (
    !status ||
    status.state !== "success" ||
    status.description !== RELEASE_PREFLIGHT_DESCRIPTION ||
    (status.creator !== null && status.creator.toLowerCase() !== expectedReviewer.toLowerCase()) ||
    !Number.isFinite(createdAt) ||
    createdAt > now + 60_000 ||
    now - createdAt > RELEASE_PREFLIGHT_MAX_AGE_MS
  ) {
    throw new Error(
      "A recent successful pnpm release:check attestation from the release reviewer is required.",
    );
  }
}

function invalidPreflightEvidence(field: string): never {
  throw new Error(`GitHub returned invalid release preflight evidence at ${field}.`);
}

export function normalizeReleasePreflightEvidence(value: unknown): ReleasePreflightEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalidPreflightEvidence("response");
  }
  const response = value as Record<string, unknown>;
  if (typeof response.sha !== "string" || !/^[a-f0-9]{40}$/.test(response.sha)) {
    invalidPreflightEvidence("sha");
  }
  if (!Array.isArray(response.statuses)) {
    invalidPreflightEvidence("statuses");
  }
  if (
    !Number.isSafeInteger(response.total_count) ||
    (response.total_count as number) < 0 ||
    (response.total_count as number) > 100
  ) {
    invalidPreflightEvidence("total_count");
  }
  if (response.total_count !== response.statuses.length) {
    invalidPreflightEvidence("statuses count");
  }
  const statuses = response.statuses.map((value, index): ReleasePreflightStatus => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      invalidPreflightEvidence(`statuses[${index}]`);
    }
    const status = value as Record<string, unknown>;
    if (typeof status.context !== "string" || !status.context || status.context.length > 100) {
      invalidPreflightEvidence(`statuses[${index}].context`);
    }
    if (
      typeof status.state !== "string" ||
      !["error", "failure", "pending", "success"].includes(status.state)
    ) {
      invalidPreflightEvidence(`statuses[${index}].state`);
    }
    if (
      status.description !== null &&
      (typeof status.description !== "string" || status.description.length > 140)
    ) {
      invalidPreflightEvidence(`statuses[${index}].description`);
    }
    const creator = status.creator;
    let creatorLogin: string | null = null;
    if (creator !== undefined && creator !== null) {
      if (
        typeof creator !== "object" ||
        Array.isArray(creator) ||
        typeof (creator as Record<string, unknown>).login !== "string" ||
        !(creator as Record<string, unknown>).login
      ) {
        invalidPreflightEvidence(`statuses[${index}].creator`);
      }
      creatorLogin = String((creator as Record<string, unknown>).login);
    }
    if (typeof status.created_at !== "string" || !Number.isFinite(Date.parse(status.created_at))) {
      invalidPreflightEvidence(`statuses[${index}].created_at`);
    }
    return {
      context: status.context,
      state: status.state,
      description: status.description,
      creator: creatorLogin,
      createdAt: status.created_at,
    };
  });
  return { sha: response.sha, statuses };
}

export function normalizeGitHubUser(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("GitHub returned an invalid authenticated user response.");
  }
  const login = (value as Record<string, unknown>).login;
  if (typeof login !== "string" || !login) {
    throw new Error("GitHub returned an invalid authenticated user response.");
  }
  return login;
}

export function normalizeCheckRunsPage(value: unknown): CheckRunsPage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("GitHub returned an invalid check-runs response.");
  }
  const response = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(response.total_count) ||
    (response.total_count as number) < 0 ||
    !Array.isArray(response.check_runs) ||
    response.check_runs.length > 100 ||
    response.check_runs.length > (response.total_count as number)
  ) {
    throw new Error("GitHub returned an invalid check-runs response.");
  }
  const checkRuns = response.check_runs.map((value): CheckEvidence => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("GitHub returned an invalid check-runs response.");
    }
    const checkRun = value as Record<string, unknown>;
    if (
      typeof checkRun.name !== "string" ||
      !checkRun.name ||
      (checkRun.conclusion !== null && typeof checkRun.conclusion !== "string")
    ) {
      throw new Error("GitHub returned an invalid check-runs response.");
    }
    return { name: checkRun.name, conclusion: checkRun.conclusion };
  });
  return { totalCount: response.total_count as number, checkRuns };
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

function sameRepository(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export function verifyReleaseEvidence(evidence: ReleaseEvidence): { pullRequestNumber: number } {
  const merged = evidence.pullRequests.filter((pullRequest) => pullRequest.merged);
  const sameRepositoryPullRequests = merged.filter((pullRequest) =>
    sameRepository(pullRequest.headRepository, evidence.repository),
  );
  if (sameRepositoryPullRequests.length === 0) {
    throw new Error("The release must originate from a merged same-repository pull request.");
  }

  const exactTree = sameRepositoryPullRequests.filter(
    (pullRequest) => pullRequest.headTreeSha === evidence.sourceTreeSha,
  );
  if (exactTree.length === 0) {
    throw new Error("No same-repository pull request tested the exact release tree.");
  }

  const smokeTested = exactTree.find((pullRequest) =>
    passed(pullRequest.checks, PUBLISH_CHECK_NAME),
  );
  if (!smokeTested) {
    const smokeChecks = exactTree.flatMap((pullRequest) =>
      pullRequest.checks.filter((check) => check.name === PUBLISH_CHECK_NAME),
    );
    if (smokeChecks.some((check) => check.conclusion === null)) {
      throw new Error("The production smoke check for the exact release tree is still pending.");
    }
    if (smokeChecks.length > 0) {
      throw new Error("The production smoke check for the exact release tree did not succeed.");
    }
    throw new Error("The exact release tree does not have a production smoke check.");
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
