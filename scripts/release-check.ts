#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { GitHubApi, MAX_GITHUB_API_PAGES } from "./lib/github.ts";
import { readBoundedJson, run } from "./lib/io.ts";
import { assertReleaseSource, parseStableVersion, verifyReleaseEvidence } from "./lib/release.ts";
import type { CheckEvidence, PullRequestEvidence } from "./lib/release.ts";

interface PackageManifest {
  version: string;
  packageManager: string;
}

interface ControlsConfig {
  repository: string;
}

interface CheckRunsResponse {
  total_count: number;
  check_runs: Array<{ name: string; conclusion: string | null }>;
}

interface PullRequestResponse {
  number: number;
  merged_at: string | null;
  head: { sha: string; repo: { full_name: string } | null };
}

const root = fileURLToPath(new URL("..", import.meta.url));

function checks(api: GitHubApi, repository: string, sha: string): CheckEvidence[] {
  const checkRuns: CheckRunsResponse["check_runs"] = [];
  let totalCount: number | null = null;
  for (let page = 1; page <= MAX_GITHUB_API_PAGES; page += 1) {
    const response = api.request<CheckRunsResponse>(
      "GET",
      `repos/${repository}/commits/${sha}/check-runs?per_page=100&page=${page}`,
    );
    if (
      !response ||
      !Number.isInteger(response.total_count) ||
      response.total_count < 0 ||
      !Array.isArray(response.check_runs)
    ) {
      throw new Error("GitHub check-runs response was invalid.");
    }
    totalCount ??= response.total_count;
    checkRuns.push(...response.check_runs);
    if (checkRuns.length >= totalCount) {
      return checkRuns.slice(0, totalCount).map(({ name, conclusion }) => ({ name, conclusion }));
    }
    if (response.check_runs.length === 0) break;
  }
  throw new Error(
    `GitHub check runs exceeded the ${MAX_GITHUB_API_PAGES}-page safety limit or were incomplete.`,
  );
}

function treeSha(api: GitHubApi, repository: string, sha: string): string {
  return api.request<{ tree: { sha: string } }>("GET", `repos/${repository}/git/commits/${sha}`)
    .tree.sha;
}

function collectPullRequestEvidence(
  api: GitHubApi,
  repository: string,
  sourceSha: string,
): PullRequestEvidence[] {
  const pullRequests = api.request<PullRequestResponse[]>(
    "GET",
    `repos/${repository}/commits/${sourceSha}/pulls?per_page=100`,
  );
  const normalizedRepository = repository.toLowerCase();
  return pullRequests
    .filter(
      (pullRequest) =>
        pullRequest.merged_at !== null &&
        pullRequest.head.repo?.full_name.toLowerCase() === normalizedRepository,
    )
    .map((pullRequest) => ({
      number: pullRequest.number,
      merged: true,
      headRepository: pullRequest.head.repo?.full_name ?? repository,
      headTreeSha: treeSha(api, repository, pullRequest.head.sha),
      checks: checks(api, repository, pullRequest.head.sha),
    }));
}

function main(): void {
  const ci = process.argv.includes("--ci");
  const manifest = readBoundedJson<PackageManifest>(`${root}/package.json`);
  const controls = readBoundedJson<ControlsConfig>(`${root}/.github/repository-controls.json`);
  const version = parseStableVersion(manifest.version);

  if (process.versions.node.split(".")[0] !== "24") {
    throw new Error(`Release checks require Node 24; received ${process.version}.`);
  }
  if (manifest.packageManager !== "pnpm@11.10.0") {
    throw new Error("packageManager must remain pinned to pnpm@11.10.0 for releases.");
  }

  run("git", ["fetch", "--quiet", "origin", "main"], { cwd: root });
  const headSha = run("git", ["rev-parse", "HEAD"], { cwd: root });
  const expectedSha = process.env.RELEASE_SHA;
  if (ci && !expectedSha) {
    throw new Error("RELEASE_SHA must be provided for CI release checks.");
  }
  if (expectedSha && expectedSha !== headSha) {
    throw new Error(`Expected release SHA ${expectedSha}, but checkout is ${headSha}.`);
  }
  assertReleaseSource({
    branch: ci
      ? process.env.GITHUB_REF === "refs/heads/main"
        ? "main"
        : ""
      : run("git", ["branch", "--show-current"], { cwd: root }),
    headSha,
    remoteMainSha: run("git", ["rev-parse", "refs/remotes/origin/main"], { cwd: root }),
    clean: run("git", ["status", "--porcelain"], { cwd: root }) === "",
  });

  run("gh", ["auth", "status"], { cwd: root, quiet: true });
  if (!ci) {
    const repository = run(
      "gh",
      ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
      { cwd: root },
    );
    if (repository !== controls.repository) {
      throw new Error(`Expected repository ${controls.repository}, but gh resolved ${repository}.`);
    }
  }

  const api = new GitHubApi();
  if (!ci) {
    const immutable = api.optional<{ enabled: boolean }>(
      `repos/${controls.repository}/immutable-releases`,
    );
    if (!immutable?.enabled) throw new Error("Immutable GitHub Releases must be enabled.");
  }

  const evidence = verifyReleaseEvidence({
    repository: controls.repository,
    sourceTreeSha: treeSha(api, controls.repository, headSha),
    mainChecks: checks(api, controls.repository, headSha),
    pullRequests: collectPullRequestEvidence(api, controls.repository, headSha),
  });

  console.log(
    `Release checks passed for ${version.releaseTag} at ${headSha} (PR #${evidence.pullRequestNumber}).`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Release check failed.");
  process.exitCode = 1;
}
