import { createHash } from "node:crypto";
import type { Octokit, UploadResponse, ValidatedEvent } from "./types.js";

export function normalizeReportName(value: string): string {
  const normalized = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!normalized) throw new Error("report-name must not be empty.");
  return normalized;
}

export function commentMarker(reportName: string): string {
  const digest = createHash("sha256")
    .update(normalizeReportName(reportName).toLocaleLowerCase("en-US"))
    .digest("hex");
  return `<!-- ephemeral-pages-action:${digest} -->`;
}

export function buildComment(
  reportName: string,
  upload: UploadResponse,
  event: ValidatedEvent,
  runId: string,
  serverUrl: string,
): string {
  const expiration = new Date(upload.expiresAt).toISOString().replace("T", " ").slice(0, 16);
  const commit = event.headSha.slice(0, 7);
  const runUrl = `${serverUrl}/${event.owner}/${event.repo}/actions/runs/${encodeURIComponent(runId)}`;
  return `${commentMarker(reportName)}

### ${normalizeReportName(reportName)}

[Open the temporary HTML report](${upload.url})

Expires: ${expiration} UTC<br>
Commit: \`${commit}\`<br>
Workflow run: [View run](${runUrl})

_This report is temporary and will be deleted automatically._`;
}

export async function createOrUpdateComment(
  octokit: Octokit,
  event: ValidatedEvent,
  body: string,
  marker: string,
): Promise<number> {
  const authenticated = await octokit.rest.users.getAuthenticated();
  const safeAuthors = new Set(["github-actions[bot]", authenticated.data.login]);
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner: event.owner,
    repo: event.repo,
    issue_number: event.pullRequestNumber,
    per_page: 100,
  });
  const existing = comments.find(
    (comment) =>
      typeof comment.body === "string" &&
      comment.body.includes(marker) &&
      comment.user?.login &&
      safeAuthors.has(comment.user.login),
  );

  if (existing) {
    const response = await octokit.rest.issues.updateComment({
      owner: event.owner,
      repo: event.repo,
      comment_id: existing.id,
      body,
    });
    return response.data.id;
  }
  const response = await octokit.rest.issues.createComment({
    owner: event.owner,
    repo: event.repo,
    issue_number: event.pullRequestNumber,
    body,
  });
  return response.data.id;
}
