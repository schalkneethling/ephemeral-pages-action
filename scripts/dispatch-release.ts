#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { GitHubApi } from "./lib/github.ts";
import { readBoundedJson, run, runInteractive } from "./lib/io.ts";
import {
  RELEASE_PREFLIGHT_CONTEXT_PREFIX,
  RELEASE_PREFLIGHT_DESCRIPTION,
  normalizeGitHubUser,
  normalizeReleasePreflightEvidence,
  parseStableVersion,
  verifyReleasePreflight,
} from "./lib/release.ts";

interface PackageManifest {
  version: string;
}

interface ControlsConfig {
  repository: string;
  releaseReviewer: string;
}

interface WorkflowRun {
  databaseId: number;
  headSha: string;
  url: string;
  createdAt: string;
}

const root = fileURLToPath(new URL("..", import.meta.url));

async function confirmRelease(tag: string, sha: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (
      (await prompt.question(`Dispatch ${tag} from ${sha.slice(0, 12)} for approval? [y/N] `))
        .trim()
        .toLowerCase() === "y"
    );
  } finally {
    prompt.close();
  }
}

async function findRun(sha: string, startedAt: number): Promise<WorkflowRun> {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const output = run(
      "gh",
      [
        "run",
        "list",
        "--workflow",
        "release.yml",
        "--event",
        "workflow_dispatch",
        "--branch",
        "main",
        "--limit",
        "10",
        "--json",
        "databaseId,headSha,url,createdAt",
      ],
      { cwd: root },
    );
    const runs = JSON.parse(output) as WorkflowRun[];
    const match = runs.find(
      (candidate) =>
        candidate.headSha === sha && Date.parse(candidate.createdAt) >= startedAt - 5000,
    );
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("The dispatched release workflow run could not be located.");
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const yes = process.argv.includes("--yes");
  const manifest = readBoundedJson<PackageManifest>(`${root}/package.json`);
  const controls = readBoundedJson<ControlsConfig>(`${root}/.github/repository-controls.json`);
  const version = parseStableVersion(manifest.version);

  runInteractive("pnpm", ["release:check"], root);
  const sha = run("git", ["rev-parse", "HEAD"], { cwd: root });
  const api = new GitHubApi();
  const actor = normalizeGitHubUser(api.request<unknown>("GET", "user"));
  if (actor.toLowerCase() !== controls.releaseReviewer.toLowerCase()) {
    throw new Error("The release workflow must be dispatched by the release reviewer.");
  }
  if (!dryRun && !yes && !(await confirmRelease(version.releaseTag, sha))) {
    throw new Error("Release dispatch cancelled.");
  }

  const preflightContext = `${RELEASE_PREFLIGHT_CONTEXT_PREFIX}${randomBytes(32).toString("hex")}`;
  api.request("POST", `repos/${controls.repository}/statuses/${sha}`, {
    state: "success",
    context: preflightContext,
    description: RELEASE_PREFLIGHT_DESCRIPTION,
  });
  const preflight = normalizeReleasePreflightEvidence(
    api.request<unknown>("GET", `repos/${controls.repository}/commits/${sha}/status?per_page=100`),
  );
  verifyReleasePreflight(preflight, preflightContext, sha, controls.releaseReviewer, actor);

  const startedAt = Date.now();
  run(
    "gh",
    [
      "workflow",
      "run",
      "release.yml",
      "--ref",
      "main",
      "-f",
      `expected-sha=${sha}`,
      "-f",
      `preflight-context=${preflightContext}`,
      "-f",
      `dry-run=${String(dryRun)}`,
    ],
    { cwd: root },
  );
  const workflow = await findRun(sha, startedAt);
  console.log(`Release workflow: ${workflow.url}`);
  runInteractive("gh", ["run", "watch", String(workflow.databaseId), "--exit-status"], root);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Release dispatch failed.");
  process.exitCode = 1;
});
