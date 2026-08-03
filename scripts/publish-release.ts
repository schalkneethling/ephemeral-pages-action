#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GitHubApi, resolveGitRef } from "./lib/github.ts";
import { readBoundedJson } from "./lib/io.ts";
import {
  compareStableVersions,
  parseStableVersion,
  planReleasePublication,
  publicationOperations,
} from "./lib/release.ts";
import type { ExistingRelease } from "./lib/release.ts";

interface PackageManifest {
  version: string;
}

interface ControlsConfig {
  repository: string;
}

interface ReleaseResponse {
  id: number;
  tag_name: string;
  target_commitish: string;
  draft: boolean;
  immutable: boolean;
  html_url: string;
}

const root = fileURLToPath(new URL("..", import.meta.url));

function resolveCommitish(api: GitHubApi, repository: string, commitish: string): string {
  return api.request<{ sha: string }>("GET", `repos/${repository}/commits/${commitish}`).sha;
}

function releaseState(
  api: GitHubApi,
  repository: string,
  release: ReleaseResponse | undefined,
  releaseTagSha: string | null,
): ExistingRelease | null {
  if (!release) return null;
  return {
    id: release.id,
    tag: release.tag_name,
    targetSha:
      !release.draft && releaseTagSha
        ? releaseTagSha
        : resolveCommitish(api, repository, release.target_commitish),
    draft: release.draft,
  };
}

function writeSummary(lines: string[]): void {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, `${lines.join("\n")}\n`, "utf8");
}

function main(): void {
  const dryRun = process.argv.includes("--dry-run");
  const expectedSha = process.env.RELEASE_SHA;
  if (process.env.GITHUB_ACTIONS !== "true") {
    throw new Error("Release publication is allowed only inside GitHub Actions.");
  }
  if (process.env.GITHUB_REF !== "refs/heads/main") {
    throw new Error("Release publication is allowed only from refs/heads/main.");
  }
  if (!dryRun && process.env.RELEASE_GUARD !== "approved-release-environment-v1") {
    throw new Error("The approved release-environment guard is missing.");
  }
  if (!expectedSha || process.env.GITHUB_SHA !== expectedSha) {
    throw new Error("The release workflow SHA does not match the verified release SHA.");
  }

  const manifest = readBoundedJson<PackageManifest>(`${root}/package.json`);
  const controls = readBoundedJson<ControlsConfig>(`${root}/.github/repository-controls.json`);
  const version = parseStableVersion(manifest.version);
  const repository = controls.repository;
  if (process.env.GITHUB_REPOSITORY !== repository) {
    throw new Error(`Release workflow repository must be ${repository}.`);
  }

  const api = new GitHubApi();
  const immutable = api.optional<{ enabled: boolean }>(`repos/${repository}/immutable-releases`);
  if (!immutable?.enabled) throw new Error("Immutable GitHub Releases must be enabled.");

  const releases = api.paginated<ReleaseResponse>(`repos/${repository}/releases`);
  const existingResponse = releases.find((release) => release.tag_name === version.releaseTag);
  const releaseTagSha = resolveGitRef(api, repository, `tags/${version.releaseTag}`);
  const majorTagSha = resolveGitRef(api, repository, `tags/${version.majorTag}`);
  const majorVersions = releases
    .filter((release) => !release.draft)
    .map((release) => release.tag_name.match(/^v(.+)$/)?.[1])
    .filter((candidate): candidate is string => {
      if (!candidate) return false;
      try {
        return parseStableVersion(candidate).major === version.major;
      } catch {
        return false;
      }
    })
    .sort(compareStableVersions);
  const latestMajorRelease = majorVersions.at(-1) ?? null;
  const plan = planReleasePublication({
    version: version.version,
    sourceSha: expectedSha,
    release: releaseState(api, repository, existingResponse, releaseTagSha),
    releaseTagSha,
    majorTagSha,
    latestMajorRelease,
  });
  const operations = publicationOperations(plan, dryRun);

  writeSummary([
    `## ${dryRun ? "Release dry run" : "Release"} ${version.releaseTag}`,
    "",
    `- Commit: \`${expectedSha}\``,
    `- Create release: ${plan.createRelease}`,
    `- Publish release: ${plan.publishRelease}`,
    `- Update ${version.majorTag}: ${plan.updateMajorTag}`,
  ]);
  if (dryRun) {
    console.log(`Dry run passed for ${version.releaseTag} at ${expectedSha}.`);
    return;
  }

  if (resolveGitRef(api, repository, "heads/main") !== expectedSha) {
    throw new Error("main changed after verification; refusing to mutate release state.");
  }

  let release = existingResponse;
  if (operations.includes("create-release")) {
    release = api.request<ReleaseResponse>("POST", `repos/${repository}/releases`, {
      tag_name: version.releaseTag,
      target_commitish: expectedSha,
      name: version.releaseTag,
      draft: true,
      prerelease: false,
      generate_release_notes: true,
    });
  }
  if (!release) throw new Error("GitHub did not return the release being published.");

  if (operations.includes("publish-release")) {
    const currentMain = resolveGitRef(api, repository, "heads/main");
    if (currentMain !== expectedSha) {
      throw new Error("main changed after verification; refusing to publish the release.");
    }
    release = api.request<ReleaseResponse>("PATCH", `repos/${repository}/releases/${release.id}`, {
      draft: false,
      make_latest: "true",
    });
  }
  if (release.draft || !release.immutable) {
    throw new Error("The GitHub Release was not published as immutable.");
  }

  if (operations.includes("update-major-tag")) {
    if (majorTagSha === null) {
      api.request("POST", `repos/${repository}/git/refs`, {
        ref: `refs/tags/${version.majorTag}`,
        sha: expectedSha,
      });
    } else {
      api.request("PATCH", `repos/${repository}/git/refs/tags/${version.majorTag}`, {
        sha: expectedSha,
        force: true,
      });
    }
  }

  const verifiedReleaseTag = resolveGitRef(api, repository, `tags/${version.releaseTag}`);
  const verifiedMajorTag = resolveGitRef(api, repository, `tags/${version.majorTag}`);
  if (verifiedReleaseTag !== expectedSha || verifiedMajorTag !== expectedSha) {
    throw new Error("Published release refs do not resolve to the verified release SHA.");
  }

  writeSummary([
    "",
    `Release: ${release.html_url}`,
    `Verified ${version.majorTag} at \`${expectedSha}\`.`,
  ]);
  console.log(
    `Published ${version.releaseTag} and verified ${version.majorTag} at ${expectedSha}.`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Release publication failed.");
  process.exitCode = 1;
}
