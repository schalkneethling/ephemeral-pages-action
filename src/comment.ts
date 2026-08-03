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
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner: event.owner,
    repo: event.repo,
    issue_number: event.pullRequestNumber,
    per_page: 100,
  });
  const markedComments = comments.filter(
    (comment) => typeof comment.body === "string" && comment.body.includes(marker),
  );
  const safeAuthors = new Set(["github-actions[bot]"]);
  if (markedComments.some((comment) => comment.user?.login !== "github-actions[bot]")) {
    try {
      const authenticated = await octokit.rest.users.getAuthenticated();
      safeAuthors.add(authenticated.data.login);
    } catch {
      // GITHUB_TOKEN is an installation token and cannot call the authenticated-user endpoint.
      // The bot identity remains safe, while unmatched authors will cause a new comment.
    }
  }
  const existing = markedComments.find(
    (comment) => comment.user?.login && safeAuthors.has(comment.user.login),
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
