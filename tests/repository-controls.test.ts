import { describe, expect, it } from "vitest";
import {
  desiredRepositoryControls,
  mainRulesetPayload,
  normalizeMainRuleset,
  normalizeReleaseEnvironment,
  planRepositoryControlChanges,
} from "../scripts/lib/repository-controls.js";
import type {
  GitHubEnvironment,
  RepositoryControlState,
} from "../scripts/lib/repository-controls.js";

const desired = desiredRepositoryControls({ reviewerId: 42 });

function matchingState(): RepositoryControlState {
  return structuredClone(desired);
}

describe("repository control acceptance criteria", () => {
  it("declares immutable releases, read-only Actions, main protection, and release approval", () => {
    expect(desired.immutableReleases).toBe(true);
    expect(desired.workflowPermissions).toEqual({
      defaultWorkflowPermissions: "read",
      canApprovePullRequestReviews: false,
    });
    expect(desired.mainRuleset.enforcement).toBe("active");
    expect(desired.mainRuleset.targetDefaultBranch).toBe(true);
    expect(desired.mainRuleset.requiredChecks).toEqual(["quality"]);
    expect(desired.releaseEnvironment.reviewers).toEqual([{ type: "User", id: 42 }]);
    expect(desired.releaseEnvironment.branches).toEqual(["main"]);
    expect(desired.releaseEnvironment.customBranchesOnly).toBe(true);
    expect(desired.releaseEnvironment.guardValue).toBe("approved-release-environment-v1");
  });

  it("reports no drift when all controls match", () => {
    expect(planRepositoryControlChanges(matchingState(), desired)).toEqual([]);
  });

  it("plans only controls that have drifted", () => {
    const current = matchingState();
    current.immutableReleases = false;
    current.workflowPermissions.defaultWorkflowPermissions = "write";

    expect(planRepositoryControlChanges(current, desired).map((change) => change.control)).toEqual([
      "immutable-releases",
      "workflow-permissions",
    ]);
  });

  it("creates missing controls without duplicating existing controls", () => {
    const current = matchingState();
    current.mainRuleset = null;
    current.releaseEnvironment = null;

    expect(planRepositoryControlChanges(current, desired)).toMatchObject([
      { control: "main-ruleset", operation: "create" },
      { control: "release-environment", operation: "create" },
    ]);
  });

  it("updates named controls in place", () => {
    const current = matchingState();
    if (current.mainRuleset) current.mainRuleset.requiredChecks = [];
    if (current.releaseEnvironment) current.releaseEnvironment.preventSelfReview = true;

    expect(planRepositoryControlChanges(current, desired)).toMatchObject([
      { control: "main-ruleset", operation: "update" },
      { control: "release-environment", operation: "update" },
    ]);
  });

  it("round-trips the desired main ruleset through the GitHub API shape", () => {
    const payload = mainRulesetPayload(desired.mainRuleset);
    expect(normalizeMainRuleset({ ...payload, id: 1 })).toEqual(desired.mainRuleset);
  });

  it("normalizes the desired protected release environment", () => {
    const environment: GitHubEnvironment = {
      name: "release",
      protection_rules: [
        {
          type: "required_reviewers",
          prevent_self_review: false,
          reviewers: [{ type: "User", reviewer: { id: 42 } }],
        },
      ],
      deployment_branch_policy: {
        protected_branches: false,
        custom_branch_policies: true,
      },
    };
    expect(
      normalizeReleaseEnvironment(
        environment,
        [{ name: "main" }],
        [{ name: "RELEASE_GUARD", value: "approved-release-environment-v1" }],
      ),
    ).toEqual(desired.releaseEnvironment);
  });
});
