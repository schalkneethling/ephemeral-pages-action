#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GitHubApi, resolveGitRef } from "./lib/github.ts";
import { readBoundedJson } from "./lib/io.ts";
import { parseStableVersion, planMajorRollback } from "./lib/release.ts";

interface ControlsConfig {
  repository: string;
}

interface ReleaseResponse {
  draft: boolean;
  immutable: boolean;
  html_url: string;
}

const root = fileURLToPath(new URL("..", import.meta.url));

function main(): void {
  const targetTag = process.env.ROLLBACK_TAG;
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_REF !== "refs/heads/main") {
    throw new Error("Floating-tag rollback is allowed only from main in GitHub Actions.");
  }
  if (process.env.RELEASE_GUARD !== "approved-release-environment-v1") {
    throw new Error("The approved release-environment guard is missing.");
  }
  if (!targetTag?.startsWith("v")) throw new Error("ROLLBACK_TAG must be a full vX.Y.Z tag.");
  const version = parseStableVersion(targetTag.slice(1));
  if (targetTag !== version.releaseTag) throw new Error("ROLLBACK_TAG must be a full vX.Y.Z tag.");

  const config = readBoundedJson<ControlsConfig>(`${root}/.github/repository-controls.json`);
  if (process.env.GITHUB_REPOSITORY !== config.repository) {
    throw new Error(`Rollback workflow repository must be ${config.repository}.`);
  }
  const api = new GitHubApi();
  const release = api.optional<ReleaseResponse>(
    `repos/${config.repository}/releases/tags/${version.releaseTag}`,
  );
  const targetSha = resolveGitRef(api, config.repository, `tags/${version.releaseTag}`);
  const currentMajorSha = resolveGitRef(api, config.repository, `tags/${version.majorTag}`);
  const plan = planMajorRollback({
    targetVersion: version.version,
    targetSha,
    published: Boolean(release && !release.draft),
    immutable: Boolean(release?.immutable),
    currentMajorSha,
  });

  if (plan.updateMajorTag) {
    if (currentMajorSha === null) {
      api.request("POST", `repos/${config.repository}/git/refs`, {
        ref: `refs/tags/${plan.majorTag}`,
        sha: targetSha,
      });
    } else {
      api.request("PATCH", `repos/${config.repository}/git/refs/tags/${plan.majorTag}`, {
        sha: targetSha,
        force: true,
      });
    }
  }
  if (resolveGitRef(api, config.repository, `tags/${plan.majorTag}`) !== targetSha) {
    throw new Error("Floating major tag did not resolve to the requested rollback target.");
  }

  const message = `Rolled ${plan.majorTag} back to ${version.releaseTag} at ${targetSha}.`;
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Floating tag rollback\n\n${message}\n\nRelease: ${release?.html_url}\n`,
      "utf8",
    );
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Floating-tag rollback failed.");
  process.exitCode = 1;
}
