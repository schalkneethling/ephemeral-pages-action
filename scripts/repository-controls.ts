#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { isDeepStrictEqual } from "node:util";
import { GitHubApi } from "./lib/github.ts";
import { readBoundedJson, run } from "./lib/io.ts";
import {
  codeQlDefaultSetupPayload,
  desiredRepositoryControls,
  mainRulesetPayload,
  normalizeCodeQlDefaultSetup,
  normalizeDependabotSecurityUpdates,
  normalizeMainRuleset,
  normalizeRepositorySettings,
  normalizeReleaseEnvironment,
  planRepositoryControlChanges,
  repositorySettingsPayload,
} from "./lib/repository-controls.ts";
import type {
  GitHubCodeQlDefaultSetup,
  GitHubDependabotSecurityUpdates,
  GitHubEnvironment,
  GitHubRepositorySettings,
  GitHubRuleset,
  RepositoryControlChange,
  RepositoryControlState,
} from "./lib/repository-controls.ts";

interface ControlsConfig {
  schemaVersion: 1;
  repository: string;
  releaseReviewer: string;
  manualControls: {
    disableEnvironmentAdminBypass: true;
    dependabotMalwareAlerts: true;
  };
}

interface BranchPoliciesResponse {
  branch_policies: Array<{ id: number; name: string }>;
}

interface EnvironmentVariablesResponse {
  variables: Array<{ name: string; value: string }>;
}

const CODEQL_VERIFICATION_ATTEMPTS = 12;
const CODEQL_VERIFICATION_DELAY_MS = 5_000;

const root = fileURLToPath(new URL("..", import.meta.url));
const configPath = fileURLToPath(new URL("../.github/repository-controls.json", import.meta.url));

async function confirmApply(): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await prompt.question("Apply these repository-control changes? [y/N] ")).trim() === "y";
  } finally {
    prompt.close();
  }
}

function printChanges(changes: RepositoryControlChange[]): void {
  if (changes.length === 0) {
    console.log("Repository controls match the committed desired state.");
    return;
  }
  console.log("Repository-control drift:");
  for (const change of changes) console.log(`- ${change.operation} ${change.control}`);
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const yes = process.argv.includes("--yes");
  const config = readBoundedJson<ControlsConfig>(configPath);
  if (config.schemaVersion !== 1)
    throw new Error("Unsupported repository-controls schema version.");
  if (
    config.manualControls.disableEnvironmentAdminBypass !== true ||
    config.manualControls.dependabotMalwareAlerts !== true
  ) {
    throw new Error("Required manual repository controls are not declared.");
  }

  run("gh", ["auth", "status"], { cwd: root, quiet: true });
  const repository = run(
    "gh",
    ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
    {
      cwd: root,
    },
  );
  if (repository !== config.repository) {
    throw new Error(`Expected repository ${config.repository}, but gh resolved ${repository}.`);
  }

  const api = new GitHubApi();
  const reviewer = api.request<{ id: number; login: string }>(
    "GET",
    `users/${config.releaseReviewer}`,
  );
  if (reviewer.login !== config.releaseReviewer)
    throw new Error("Release reviewer could not be resolved.");
  const desired = desiredRepositoryControls({ reviewerId: reviewer.id });

  const readState = (): {
    state: RepositoryControlState;
    rulesetId: number | null;
    branchPolicies: Array<{ id: number; name: string }>;
  } => {
    const repositorySettings = api.request<GitHubRepositorySettings>("GET", `repos/${repository}`);
    const immutable = api.optional<{ enabled: boolean }>(`repos/${repository}/immutable-releases`);
    const workflow = api.request<{
      default_workflow_permissions: "read" | "write";
      can_approve_pull_request_reviews: boolean;
    }>("GET", `repos/${repository}/actions/permissions/workflow`);
    const dependabotAlerts =
      api.optional<void>(`repos/${repository}/vulnerability-alerts`) !== null;
    const dependabotSecurityUpdates = api.optional<GitHubDependabotSecurityUpdates>(
      `repos/${repository}/automated-security-fixes`,
    );
    const codeQlDefaultSetup = api.request<GitHubCodeQlDefaultSetup>(
      "GET",
      `repos/${repository}/code-scanning/default-setup`,
    );
    const rulesets = api.request<Array<{ id: number; name: string }>>(
      "GET",
      `repos/${repository}/rulesets`,
    );
    const summary = rulesets.find((candidate) => candidate.name === desired.mainRuleset?.name);
    const ruleset = summary
      ? api.request<GitHubRuleset>("GET", `repos/${repository}/rulesets/${summary.id}`)
      : null;
    const environment = api.optional<GitHubEnvironment>(
      `repos/${repository}/environments/${desired.releaseEnvironment?.name}`,
    );
    const policies = environment
      ? api.request<BranchPoliciesResponse>(
          "GET",
          `repos/${repository}/environments/${environment.name}/deployment-branch-policies?per_page=100`,
        ).branch_policies
      : [];
    const variables = environment
      ? api.request<EnvironmentVariablesResponse>(
          "GET",
          `repos/${repository}/environments/${environment.name}/variables?per_page=100`,
        ).variables
      : [];
    const normalizedEnvironment = normalizeReleaseEnvironment(environment, policies, variables);

    return {
      state: {
        immutableReleases: Boolean(immutable?.enabled),
        repositorySettings: normalizeRepositorySettings(repositorySettings),
        workflowPermissions: {
          defaultWorkflowPermissions: workflow.default_workflow_permissions,
          canApprovePullRequestReviews: workflow.can_approve_pull_request_reviews,
        },
        security: {
          dependabotAlerts,
          ...normalizeDependabotSecurityUpdates(dependabotSecurityUpdates),
          codeQlDefaultSetup: normalizeCodeQlDefaultSetup(codeQlDefaultSetup),
        },
        mainRuleset: normalizeMainRuleset(ruleset),
        releaseEnvironment: normalizedEnvironment,
      },
      rulesetId: ruleset?.id ?? null,
      branchPolicies: policies,
    };
  };

  const current = readState();
  const changes = planRepositoryControlChanges(current.state, desired);
  printChanges(changes);
  console.log(
    "Manual control: verify that administrators cannot bypass the release environment protection rules.",
  );
  console.log(
    `Manual control: verify Dependabot malware alerts at https://github.com/${repository}/settings/security_analysis.`,
  );

  if (!apply) {
    if (changes.length > 0) process.exitCode = 1;
    return;
  }
  if (changes.length === 0) return;
  if (changes.some((change) => change.operation === "manual")) {
    throw new Error(
      "Dependabot security updates are paused and must be resumed in repository settings.",
    );
  }
  if (!yes && !(await confirmApply()))
    throw new Error("Repository-control changes were not applied.");

  for (const change of changes) {
    if (change.control === "immutable-releases") {
      api.request("PUT", `repos/${repository}/immutable-releases`);
    } else if (change.control === "repository-settings") {
      api.request(
        "PATCH",
        `repos/${repository}`,
        repositorySettingsPayload(desired.repositorySettings),
      );
    } else if (change.control === "workflow-permissions") {
      api.request("PUT", `repos/${repository}/actions/permissions/workflow`, {
        default_workflow_permissions: desired.workflowPermissions.defaultWorkflowPermissions,
        can_approve_pull_request_reviews: desired.workflowPermissions.canApprovePullRequestReviews,
      });
    } else if (change.control === "dependabot-alerts") {
      api.request("PUT", `repos/${repository}/vulnerability-alerts`);
    } else if (change.control === "dependabot-security-updates") {
      api.request("PUT", `repos/${repository}/automated-security-fixes`);
    } else if (change.control === "codeql-default-setup") {
      api.request(
        "PATCH",
        `repos/${repository}/code-scanning/default-setup`,
        codeQlDefaultSetupPayload(desired.security.codeQlDefaultSetup),
      );
    } else if (change.control === "main-ruleset" && desired.mainRuleset) {
      let rulesetId = current.rulesetId;
      if (rulesetId === null) {
        const created = api.request<{ id: number }>("POST", `repos/${repository}/rulesets`, {
          ...mainRulesetPayload(desired.mainRuleset, "disabled"),
        });
        rulesetId = created.id;
      }
      api.request(
        "PUT",
        `repos/${repository}/rulesets/${rulesetId}`,
        mainRulesetPayload(desired.mainRuleset),
      );
    } else if (change.control === "release-environment" && desired.releaseEnvironment) {
      const environment = desired.releaseEnvironment;
      api.request("PUT", `repos/${repository}/environments/${environment.name}`, {
        wait_timer: environment.waitTimer,
        prevent_self_review: environment.preventSelfReview,
        reviewers: environment.reviewers,
        deployment_branch_policy: {
          protected_branches: false,
          custom_branch_policies: environment.customBranchesOnly,
        },
      });
      const existingPolicies =
        api.optional<BranchPoliciesResponse>(
          `repos/${repository}/environments/${environment.name}/deployment-branch-policies?per_page=100`,
        )?.branch_policies ?? [];
      for (const branch of environment.branches) {
        if (!existingPolicies.some((policy) => policy.name === branch)) {
          api.request(
            "POST",
            `repos/${repository}/environments/${environment.name}/deployment-branch-policies`,
            { name: branch },
          );
        }
      }
      for (const policy of existingPolicies) {
        if (!environment.branches.includes(policy.name)) {
          api.request(
            "DELETE",
            `repos/${repository}/environments/${environment.name}/deployment-branch-policies/${policy.id}`,
          );
        }
      }
      const variables = api.request<EnvironmentVariablesResponse>(
        "GET",
        `repos/${repository}/environments/${environment.name}/variables?per_page=100`,
      ).variables;
      const guard = variables.find((variable) => variable.name === "RELEASE_GUARD");
      if (!guard) {
        api.request("POST", `repos/${repository}/environments/${environment.name}/variables`, {
          name: "RELEASE_GUARD",
          value: environment.guardValue,
        });
      } else if (guard.value !== environment.guardValue) {
        api.request(
          "PATCH",
          `repos/${repository}/environments/${environment.name}/variables/RELEASE_GUARD`,
          { name: "RELEASE_GUARD", value: environment.guardValue },
        );
      }
    }
  }

  if (changes.some((change) => change.control === "codeql-default-setup")) {
    for (let attempt = 1; attempt <= CODEQL_VERIFICATION_ATTEMPTS; attempt += 1) {
      const configured = normalizeCodeQlDefaultSetup(
        api.request<GitHubCodeQlDefaultSetup>(
          "GET",
          `repos/${repository}/code-scanning/default-setup`,
        ),
      );
      if (isDeepStrictEqual(configured, desired.security.codeQlDefaultSetup)) break;
      if (attempt === CODEQL_VERIFICATION_ATTEMPTS) {
        throw new Error("CodeQL default setup did not reach the desired state in time.");
      }
      await new Promise((resolve) => setTimeout(resolve, CODEQL_VERIFICATION_DELAY_MS));
    }
  }

  const remaining = planRepositoryControlChanges(readState().state, desired);
  if (remaining.length > 0) throw new Error("Repository controls still differ after apply.");
  console.log("Repository controls were applied and verified.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Repository-control operation failed.");
  process.exitCode = 1;
});
