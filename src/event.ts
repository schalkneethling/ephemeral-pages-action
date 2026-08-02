import type { PullRequestPayload, ValidatedEvent } from "./types.js";

export function validatePullRequestEvent(
  eventName: string,
  repository: string,
  payload: PullRequestPayload,
): ValidatedEvent {
  if (eventName === "pull_request_target") {
    throw new Error("pull_request_target is unsupported for security reasons.");
  }
  if (eventName !== "pull_request") {
    throw new Error("Only pull_request events are supported.");
  }

  const pullRequest = payload.pull_request;
  const pullRequestNumber = payload.number ?? pullRequest?.number;
  if (!pullRequest || !Number.isInteger(pullRequestNumber) || pullRequestNumber! <= 0) {
    throw new Error("The event payload does not contain a valid pull request.");
  }

  const [owner, repo, extra] = repository.split("/");
  if (!owner || !repo || extra) {
    throw new Error("GITHUB_REPOSITORY is invalid.");
  }

  if (pullRequest.head?.repo?.full_name !== repository) {
    throw new Error("Fork pull requests are unsupported; the report was not read or uploaded.");
  }
  if (
    pullRequest.base?.repo?.full_name !== repository ||
    payload.repository?.full_name !== repository
  ) {
    throw new Error("The pull request base repository does not match the current repository.");
  }

  const repositoryId = payload.repository.id;
  if (!Number.isSafeInteger(repositoryId) || repositoryId! <= 0) {
    throw new Error("The event payload does not contain a valid repository ID.");
  }

  return {
    owner,
    repo,
    repositoryId: repositoryId!,
    pullRequestNumber: pullRequestNumber!,
    headSha: pullRequest.head?.sha ?? "unknown",
  };
}
