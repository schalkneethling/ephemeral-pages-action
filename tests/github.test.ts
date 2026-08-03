import { describe, expect, it } from "vitest";
import { GitHubApi, MAX_GITHUB_API_PAGES, resolveGitRef } from "../scripts/lib/github.js";

class StubGitHubApi extends GitHubApi {
  constructor(private readonly responses: unknown[]) {
    super();
  }

  override request<T>(): T {
    return this.responses.shift() as T;
  }
}

describe("GitHub API safety helpers", () => {
  it("accumulates valid list pages", () => {
    const api = new StubGitHubApi([Array.from({ length: 100 }, (_, index) => index), [100]]);
    expect(api.paginated<number>("repos/owner/repo/releases")).toHaveLength(101);
  });

  it("rejects malformed pages and pagination beyond the safety limit", () => {
    expect(() => new StubGitHubApi([undefined]).paginated("endpoint")).toThrow(/return a list/i);

    const fullPage = Array.from({ length: 100 }, (_, index) => index);
    const pages = Array.from({ length: MAX_GITHUB_API_PAGES }, () => fullPage);
    expect(() => new StubGitHubApi(pages).paginated("endpoint")).toThrow(/safety limit/i);
  });

  it("resolves annotated tags to their commit", () => {
    const api = new StubGitHubApi([
      { object: { type: "tag", sha: "tag-object" } },
      { object: { type: "commit", sha: "commit-sha" } },
    ]);
    expect(resolveGitRef(api, "owner/repo", "tags/v1.0.0")).toBe("commit-sha");
  });

  it("returns null when a ref does not exist", () => {
    expect(resolveGitRef(new StubGitHubApi([undefined]), "owner/repo", "tags/v1.0.0")).toBeNull();
  });

  it("rejects annotated-tag chains beyond the safety limit", () => {
    const nestedTags = Array.from({ length: 11 }, (_, index) => ({
      object: { type: "tag", sha: `tag-${index}` },
    }));
    expect(() => resolveGitRef(new StubGitHubApi(nestedTags), "owner/repo", "tags/v1.0.0")).toThrow(
      /10-level safety limit/i,
    );
  });
});
