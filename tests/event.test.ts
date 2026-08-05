import { describe, expect, it } from "vitest";
import { validatePullRequestEvent } from "../src/event.js";
import type { PullRequestPayload } from "../src/types.js";

function payload(overrides: Partial<PullRequestPayload> = {}): PullRequestPayload {
  return {
    number: 42,
    repository: { id: 123, full_name: "owner/repo" },
    pull_request: {
      number: 42,
      head: { sha: "abcdef123456", repo: { full_name: "owner/repo" } },
      base: { repo: { full_name: "owner/repo" } },
    },
    ...overrides,
  };
}

describe("validatePullRequestEvent", () => {
  it("accepts a same-repository pull_request", () => {
    expect(validatePullRequestEvent("pull_request", "owner/repo", payload())).toEqual({
      owner: "owner",
      repo: "repo",
      repositoryId: 123,
      pullRequestNumber: 42,
      headSha: "abcdef123456",
    });
  });

  it("rejects a fork pull request", () => {
    const fork = payload();
    fork.pull_request!.head!.repo!.full_name = "attacker/repo";
    expect(() => validatePullRequestEvent("pull_request", "owner/repo", fork)).toThrow(/Fork/);
  });

  it.each([
    ["pull_request_target", /unsupported/],
    ["push", /Only pull_request/],
    ["workflow_dispatch", /Only pull_request/],
  ])("rejects the %s event", (eventName, expectedError) => {
    expect(() => validatePullRequestEvent(eventName, "owner/repo", payload())).toThrow(
      expectedError,
    );
  });

  it("rejects a missing pull request", () => {
    expect(() =>
      validatePullRequestEvent("pull_request", "owner/repo", payload({ pull_request: undefined })),
    ).toThrow(/valid pull request/);
  });

  it("rejects a mismatched base or payload repository", () => {
    const mismatched = payload();
    mismatched.pull_request!.base!.repo!.full_name = "other/repo";
    expect(() => validatePullRequestEvent("pull_request", "owner/repo", mismatched)).toThrow(
      /base repository/,
    );
  });
});
