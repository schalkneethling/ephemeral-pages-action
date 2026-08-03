import { describe, expect, it, vi } from "vitest";
import { buildComment, commentMarker, createOrUpdateComment } from "../src/comment.js";
import type { Octokit, UploadResponse, ValidatedEvent } from "../src/types.js";

const event: ValidatedEvent = {
  owner: "owner",
  repo: "repo",
  repositoryId: 1,
  pullRequestNumber: 42,
  headSha: "abcdef123456",
};
const upload: UploadResponse = {
  id: "page",
  createdAt: "2026-08-02T10:00:00.000Z",
  expiresAt: "2026-08-02T22:00:00.000Z",
  url: "https://ephemeral.example/p/page",
};

function octokit(comments: Array<Record<string, unknown>> = []) {
  const createComment = vi.fn().mockResolvedValue({ data: { id: 100 } });
  const updateComment = vi.fn().mockResolvedValue({ data: { id: 99 } });
  const listComments = vi.fn();
  const paginate = vi.fn().mockResolvedValue(comments);
  const client = {
    rest: {
      users: { getAuthenticated: vi.fn().mockResolvedValue({ data: { login: "token-owner" } }) },
      issues: { createComment, updateComment, listComments },
    },
    paginate,
  } as unknown as Octokit;
  return { client, createComment, updateComment, listComments, paginate };
}

describe("pull-request comments", () => {
  it("creates the first marked comment", async () => {
    const mock = octokit();
    const marker = commentMarker("Accessibility report");
    const body = buildComment("Accessibility report", upload, event, "123", "https://github.com");
    await expect(createOrUpdateComment(mock.client, event, body, marker)).resolves.toBe(100);
    expect(mock.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 42, body }),
    );
    expect(mock.paginate).toHaveBeenCalledWith(
      mock.listComments,
      expect.objectContaining({ per_page: 100 }),
    );
    expect(mock.client.rest.users.getAuthenticated).not.toHaveBeenCalled();
  });

  it.each(["github-actions[bot]", "token-owner"])(
    "updates a marked comment by safe author %s",
    async (login) => {
      const marker = commentMarker("Accessibility report");
      const mock = octokit([{ id: 99, body: `${marker}\nold`, user: { login } }]);
      await expect(createOrUpdateComment(mock.client, event, "new", marker)).resolves.toBe(99);
      expect(mock.updateComment).toHaveBeenCalledWith(
        expect.objectContaining({ comment_id: 99, body: "new" }),
      );
      expect(mock.createComment).not.toHaveBeenCalled();
    },
  );

  it("does not edit a marked comment by an unsafe author", async () => {
    const marker = commentMarker("Accessibility report");
    const mock = octokit([{ id: 98, body: marker, user: { login: "attacker" } }]);
    await createOrUpdateComment(mock.client, event, "new", marker);
    expect(mock.updateComment).not.toHaveBeenCalled();
    expect(mock.createComment).toHaveBeenCalledOnce();
  });

  it("creates a new comment when an installation token cannot resolve a non-bot author", async () => {
    const marker = commentMarker("Accessibility report");
    const mock = octokit([{ id: 98, body: marker, user: { login: "someone" } }]);
    vi.mocked(mock.client.rest.users.getAuthenticated).mockRejectedValue(
      new Error("integration token"),
    );
    await createOrUpdateComment(mock.client, event, "new", marker);
    expect(mock.updateComment).not.toHaveBeenCalled();
    expect(mock.createComment).toHaveBeenCalledOnce();
  });

  it("uses separate stable markers for different normalized report names", () => {
    expect(commentMarker("  Accessibility   report ")).toBe(commentMarker("accessibility report"));
    expect(commentMarker("Performance report")).not.toBe(commentMarker("Accessibility report"));
  });
});
