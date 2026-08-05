import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  codeQlDefaultSetupPayload,
  desiredRepositoryControls,
  enablementRequestMethod,
  findRulesetByName,
  mainRulesetPayload,
  normalizeCodeQlDefaultSetup,
  normalizeDependabotSecurityUpdates,
  normalizeMainRuleset,
  normalizeRepositorySettings,
  normalizeReleaseEnvironment,
  planRepositoryControlChanges,
  repositorySettingsPayload,
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
  it("declares repository, security, branch, Actions, and release controls", () => {
    expect(desired.immutableReleases).toBe(true);
    expect(desired.repositorySettings).toEqual({
      wiki: false,
      projects: false,
      squashMerge: false,
      mergeCommit: true,
      rebaseMerge: true,
      autoMerge: true,
      deleteBranchOnMerge: true,
      updateBranch: true,
    });
    expect(desired.workflowPermissions).toEqual({
      defaultWorkflowPermissions: "read",
      canApprovePullRequestReviews: false,
    });
    expect(desired.security).toEqual({
      dependabotAlerts: true,
      dependabotSecurityUpdates: true,
      dependabotSecurityUpdatesPaused: false,
      codeQlDefaultSetup: {
        state: "configured",
        languages: ["actions", "javascript-typescript"],
        querySuite: "default",
        threatModel: "remote",
        runnerType: "standard",
        runnerLabel: null,
      },
    });
    expect(desired.mainRuleset.enforcement).toBe("active");
    expect(desired.mainRuleset.targetDefaultBranch).toBe(true);
    expect(desired.mainRuleset.requiredChecks).toEqual(["quality"]);
    expect(desired.mainRuleset.allowedMergeMethods).toEqual(["merge", "rebase"]);
    expect(desired.releaseEnvironment.reviewers).toEqual([{ type: "User", id: 42 }]);
    expect(desired.releaseEnvironment.branches).toEqual(["main"]);
    expect(desired.releaseEnvironment.customBranchesOnly).toBe(true);
    expect(desired.releaseEnvironment.guardValue).toBe("approved-release-environment-v1");
  });

  it("reports no drift when all controls match", () => {
    expect(planRepositoryControlChanges(matchingState(), desired)).toEqual([]);
  });

  it("ignores object property insertion order when checking drift", () => {
    const current = matchingState();
    current.workflowPermissions = {
      canApprovePullRequestReviews: false,
      defaultWorkflowPermissions: "read",
    };

    expect(planRepositoryControlChanges(current, desired)).toEqual([]);
  });

  it("plans only controls that have drifted", () => {
    const current = matchingState();
    current.immutableReleases = false;
    current.repositorySettings.wiki = true;
    current.workflowPermissions.defaultWorkflowPermissions = "write";
    current.security.dependabotAlerts = false;
    current.security.dependabotSecurityUpdates = false;
    current.security.codeQlDefaultSetup.state = "not-configured";

    expect(planRepositoryControlChanges(current, desired)).toEqual([
      { control: "immutable-releases", operation: "enable" },
      { control: "repository-settings", operation: "update" },
      { control: "workflow-permissions", operation: "update" },
      { control: "dependabot-alerts", operation: "enable" },
      { control: "dependabot-security-updates", operation: "enable" },
      { control: "codeql-default-setup", operation: "update" },
    ]);
  });

  it("requires manual remediation when Dependabot security updates are paused", () => {
    const current = matchingState();
    Object.assign(
      current.security,
      normalizeDependabotSecurityUpdates({ enabled: true, paused: true }),
    );

    expect(current.security.dependabotSecurityUpdates).toBe(false);
    expect(planRepositoryControlChanges(current, desired)).toEqual([
      { control: "dependabot-security-updates", operation: "manual" },
    ]);
  });

  it("plans Dependabot disable operations", () => {
    const target = matchingState();
    target.security.dependabotAlerts = false;
    target.security.dependabotSecurityUpdates = false;

    const changes = planRepositoryControlChanges(matchingState(), target);
    expect(changes).toEqual([
      { control: "dependabot-alerts", operation: "disable" },
      { control: "dependabot-security-updates", operation: "disable" },
    ]);
  });

  it("maps enablement operations to their GitHub API methods", () => {
    expect(enablementRequestMethod("enable")).toBe("PUT");
    expect(enablementRequestMethod("disable")).toBe("DELETE");
    expect(() => enablementRequestMethod("manual")).toThrow(/cannot apply manual/i);
  });

  it("disables paused Dependabot security updates when they are not desired", () => {
    const current = matchingState();
    const target = matchingState();
    Object.assign(
      current.security,
      normalizeDependabotSecurityUpdates({ enabled: true, paused: true }),
    );
    target.security.dependabotSecurityUpdates = false;

    expect(planRepositoryControlChanges(current, target)).toEqual([
      { control: "dependabot-security-updates", operation: "disable" },
    ]);
  });

  it("finds a named ruleset beyond the first API page", () => {
    const rulesets = Array.from({ length: 101 }, (_, index) => ({
      id: index,
      name: index === 100 ? desired.mainRuleset.name : `ruleset-${index}`,
    }));
    expect(findRulesetByName(rulesets, desired.mainRuleset.name)).toEqual({
      id: 100,
      name: desired.mainRuleset.name,
    });
  });

  it("round-trips repository settings through the GitHub API shape", () => {
    expect(
      normalizeRepositorySettings(repositorySettingsPayload(desired.repositorySettings)),
    ).toEqual(desired.repositorySettings);
  });

  it("normalizes GitHub's JavaScript and TypeScript CodeQL language aliases", () => {
    expect(
      normalizeCodeQlDefaultSetup({
        ...codeQlDefaultSetupPayload(desired.security.codeQlDefaultSetup),
        languages: ["actions", "javascript", "javascript-typescript", "typescript"],
      }),
    ).toEqual(desired.security.codeQlDefaultSetup);
  });

  it("preserves additional CodeQL languages when checking drift", () => {
    const current = matchingState();
    current.security.codeQlDefaultSetup.languages.push("python");
    expect(planRepositoryControlChanges(current, desired)).toContainEqual({
      control: "codeql-default-setup",
      operation: "update",
    });
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

  it("keeps version updates configured for npm and GitHub Actions", () => {
    const configuration = readFileSync(
      new URL("../.github/dependabot.yml", import.meta.url),
      "utf8",
    );
    expect(configuration).toContain('package-ecosystem: "npm"');
    expect(configuration).toContain('package-ecosystem: "github-actions"');
  });

  it("declares the repository controls that still require manual verification", () => {
    const configuration = JSON.parse(
      readFileSync(new URL("../.github/repository-controls.json", import.meta.url), "utf8"),
    ) as { manualControls: Record<string, boolean> };
    expect(configuration.manualControls).toEqual({
      disableEnvironmentAdminBypass: true,
      dependabotMalwareAlerts: true,
    });
  });
});
