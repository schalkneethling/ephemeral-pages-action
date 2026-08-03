import * as core from "@actions/core";
import * as github from "@actions/github";
import {
  buildComment,
  commentMarker,
  createOrUpdateComment,
  normalizeReportName,
} from "./comment.js";
import { validatePullRequestEvent } from "./event.js";
import { encodeReport, parseTtl, readReport } from "./report.js";
import type { PullRequestPayload } from "./types.js";
import { createIdempotencyKey, normalizeServiceOrigin, uploadReport } from "./upload.js";

export interface RunDependencies {
  core: Pick<
    typeof core,
    "getInput" | "getIDToken" | "setSecret" | "setOutput" | "warning" | "info"
  >;
  context: typeof github.context;
  getOctokit: typeof github.getOctokit;
  fetch: typeof globalThis.fetch;
  sleep: (milliseconds: number) => Promise<void>;
  random: () => number;
  environment: NodeJS.ProcessEnv;
}

export const defaultDependencies: RunDependencies = {
  core,
  context: github.context,
  getOctokit: github.getOctokit,
  fetch: globalThis.fetch,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  random: Math.random,
  environment: process.env,
};

export async function run(dependencies: RunDependencies = defaultDependencies): Promise<void> {
  const githubToken = dependencies.core.getInput("github-token", { required: true });
  dependencies.core.setSecret(githubToken);

  // This validation deliberately precedes TTL parsing, path resolution, and file access.
  const event = validatePullRequestEvent(
    dependencies.context.eventName,
    `${dependencies.context.repo.owner}/${dependencies.context.repo.repo}`,
    dependencies.context.payload as PullRequestPayload,
  );

  const reportPath = dependencies.core.getInput("report-path", { required: true });
  const ttl = parseTtl(dependencies.core.getInput("ttl-hours") || "12");
  const reportName = normalizeReportName(
    dependencies.core.getInput("report-name") || "Accessibility report",
  );
  const serviceOrigin = normalizeServiceOrigin(
    dependencies.core.getInput("service-url") || "https://ephemeral.schalkneethling.com",
  );
  const workspace = dependencies.environment.GITHUB_WORKSPACE;
  if (!workspace) throw new Error("GITHUB_WORKSPACE is not set.");
  const runId = dependencies.environment.GITHUB_RUN_ID;
  const runAttempt = dependencies.environment.GITHUB_RUN_ATTEMPT;
  if (!runId || !runAttempt) throw new Error("GitHub run identity is unavailable.");

  const report = await readReport(workspace, reportPath);
  const encodedHtml = await encodeReport(report.contents);
  const idempotencyKey = createIdempotencyKey(
    event.repositoryId,
    runId,
    runAttempt,
    report.normalizedPath,
  );
  const upload = await uploadReport(serviceOrigin, encodedHtml, ttl, idempotencyKey, {
    fetch: dependencies.fetch,
    getIdToken: (audience) => dependencies.core.getIDToken(audience),
    setSecret: (secret) => dependencies.core.setSecret(secret),
    sleep: dependencies.sleep,
    warn: (message) => dependencies.core.warning(message),
    random: dependencies.random,
  });

  dependencies.core.setOutput("page-id", upload.id);
  dependencies.core.setOutput("page-url", upload.url);
  dependencies.core.setOutput("expires-at", upload.expiresAt);

  try {
    const octokit = dependencies.getOctokit(githubToken);
    const body = buildComment(
      reportName,
      upload,
      event,
      runId,
      dependencies.environment.GITHUB_SERVER_URL ?? "https://github.com",
    );
    const commentId = await createOrUpdateComment(octokit, event, body, commentMarker(reportName));
    dependencies.core.setOutput("comment-id", String(commentId));
  } catch {
    dependencies.core.info(
      `The report was uploaded successfully and remains available at ${upload.url}`,
    );
    throw new Error(
      "The report was uploaded, but the pull-request comment could not be created or updated.",
    );
  }
}
