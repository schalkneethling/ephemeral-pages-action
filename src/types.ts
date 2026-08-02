import type * as github from "@actions/github";

export interface PullRequestPayload {
  number?: number;
  repository?: { id?: number; full_name?: string };
  pull_request?: {
    number?: number;
    head?: { sha?: string; repo?: { full_name?: string } | null };
    base?: { repo?: { full_name?: string } };
  };
}

export interface ValidatedEvent {
  owner: string;
  repo: string;
  repositoryId: number;
  pullRequestNumber: number;
  headSha: string;
}

export interface UploadResponse {
  id: string;
  createdAt: string;
  expiresAt: string;
  url: string;
}

export type Octokit = ReturnType<typeof github.getOctokit>;
