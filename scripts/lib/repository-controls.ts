import { isDeepStrictEqual } from "node:util";

export type Reviewer = { type: "User" | "Team"; id: number };

export interface GitHubRuleset {
  id: number;
  name: string;
  enforcement: string;
  conditions?: { ref_name?: { include?: string[]; exclude?: string[] } };
  rules: Array<{ type: string; parameters?: Record<string, unknown> }>;
}

export interface GitHubEnvironment {
  name: string;
  protection_rules: Array<{
    type: string;
    wait_timer?: number;
    prevent_self_review?: boolean;
    reviewers?: Array<{ type: "User" | "Team"; reviewer: { id: number } }>;
  }>;
  deployment_branch_policy?: {
    protected_branches: boolean;
    custom_branch_policies: boolean;
  } | null;
}

export interface MainRulesetControl {
  name: string;
  enforcement: "active" | "disabled" | "evaluate";
  targetDefaultBranch: boolean;
  requiredChecks: string[];
  strictStatusChecks: boolean;
  allowBranchCreationWithoutChecks: boolean;
  requirePullRequest: boolean;
  allowedMergeMethods: Array<"merge" | "squash" | "rebase">;
  dismissStaleReviews: boolean;
  requireCodeOwnerReview: boolean;
  requireLastPushApproval: boolean;
  requiredApprovals: number;
  requireConversationResolution: boolean;
  blockForcePushes: boolean;
  blockDeletion: boolean;
}

export interface ReleaseEnvironmentControl {
  name: string;
  waitTimer: number;
  preventSelfReview: boolean;
  reviewers: Reviewer[];
  branches: string[];
  customBranchesOnly: boolean;
  guardValue: string;
}

export interface RepositorySettingsControl {
  wiki: boolean;
  projects: boolean;
  squashMerge: boolean;
  mergeCommit: boolean;
  rebaseMerge: boolean;
  autoMerge: boolean;
  deleteBranchOnMerge: boolean;
  updateBranch: boolean;
}

export interface GitHubRepositorySettings {
  has_wiki: boolean;
  has_projects: boolean;
  allow_squash_merge: boolean;
  allow_merge_commit: boolean;
  allow_rebase_merge: boolean;
  allow_auto_merge: boolean;
  delete_branch_on_merge: boolean;
  allow_update_branch: boolean;
}

export interface CodeQlDefaultSetupControl {
  state: "configured" | "not-configured";
  languages: string[];
  querySuite: "default" | "extended";
  threatModel: "remote" | "remote_and_local";
  runnerType: "standard" | "labeled";
  runnerLabel: string | null;
}

export interface GitHubCodeQlDefaultSetup {
  state: "configured" | "not-configured";
  languages: string[];
  query_suite: "default" | "extended";
  threat_model: "remote" | "remote_and_local";
  runner_type: "standard" | "labeled";
  runner_label: string | null;
}

export interface SecurityControl {
  dependabotAlerts: boolean;
  dependabotSecurityUpdates: boolean;
  codeQlDefaultSetup: CodeQlDefaultSetupControl;
}

export interface RepositoryControlState {
  immutableReleases: boolean;
  repositorySettings: RepositorySettingsControl;
  workflowPermissions: {
    defaultWorkflowPermissions: "read" | "write";
    canApprovePullRequestReviews: boolean;
  };
  security: SecurityControl;
  mainRuleset: MainRulesetControl | null;
  releaseEnvironment: ReleaseEnvironmentControl | null;
}

export type DesiredRepositoryControls = Omit<
  RepositoryControlState,
  "mainRuleset" | "releaseEnvironment"
> & {
  mainRuleset: MainRulesetControl;
  releaseEnvironment: ReleaseEnvironmentControl;
};

export type RepositoryControlChange = {
  control:
    | "immutable-releases"
    | "repository-settings"
    | "workflow-permissions"
    | "dependabot-alerts"
    | "dependabot-security-updates"
    | "codeql-default-setup"
    | "main-ruleset"
    | "release-environment";
  operation: "enable" | "update" | "create";
};

export function desiredRepositoryControls(options: {
  reviewerId: number;
}): DesiredRepositoryControls {
  return {
    immutableReleases: true,
    repositorySettings: {
      wiki: false,
      projects: false,
      squashMerge: false,
      mergeCommit: true,
      rebaseMerge: true,
      autoMerge: true,
      deleteBranchOnMerge: true,
      updateBranch: true,
    },
    workflowPermissions: {
      defaultWorkflowPermissions: "read",
      canApprovePullRequestReviews: false,
    },
    security: {
      dependabotAlerts: true,
      dependabotSecurityUpdates: true,
      codeQlDefaultSetup: {
        state: "configured",
        languages: ["actions", "javascript-typescript"],
        querySuite: "default",
        threatModel: "remote",
        runnerType: "standard",
        runnerLabel: null,
      },
    },
    mainRuleset: {
      name: "protect-main",
      enforcement: "active",
      targetDefaultBranch: true,
      requiredChecks: ["quality"],
      strictStatusChecks: true,
      allowBranchCreationWithoutChecks: false,
      requirePullRequest: true,
      allowedMergeMethods: ["merge", "rebase"],
      dismissStaleReviews: false,
      requireCodeOwnerReview: false,
      requireLastPushApproval: false,
      requiredApprovals: 0,
      requireConversationResolution: true,
      blockForcePushes: true,
      blockDeletion: true,
    },
    releaseEnvironment: {
      name: "release",
      waitTimer: 0,
      preventSelfReview: false,
      reviewers: [{ type: "User", id: options.reviewerId }],
      branches: ["main"],
      customBranchesOnly: true,
      guardValue: "approved-release-environment-v1",
    },
  };
}

function equal(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

export function planRepositoryControlChanges(
  current: RepositoryControlState,
  desired: RepositoryControlState,
): RepositoryControlChange[] {
  const changes: RepositoryControlChange[] = [];

  if (current.immutableReleases !== desired.immutableReleases) {
    changes.push({ control: "immutable-releases", operation: "enable" });
  }
  if (!equal(current.repositorySettings, desired.repositorySettings)) {
    changes.push({ control: "repository-settings", operation: "update" });
  }
  if (!equal(current.workflowPermissions, desired.workflowPermissions)) {
    changes.push({ control: "workflow-permissions", operation: "update" });
  }
  if (current.security.dependabotAlerts !== desired.security.dependabotAlerts) {
    changes.push({ control: "dependabot-alerts", operation: "enable" });
  }
  if (current.security.dependabotSecurityUpdates !== desired.security.dependabotSecurityUpdates) {
    changes.push({ control: "dependabot-security-updates", operation: "enable" });
  }
  if (!equal(current.security.codeQlDefaultSetup, desired.security.codeQlDefaultSetup)) {
    changes.push({ control: "codeql-default-setup", operation: "update" });
  }
  if (!equal(current.mainRuleset, desired.mainRuleset)) {
    changes.push({
      control: "main-ruleset",
      operation: current.mainRuleset ? "update" : "create",
    });
  }
  if (!equal(current.releaseEnvironment, desired.releaseEnvironment)) {
    changes.push({
      control: "release-environment",
      operation: current.releaseEnvironment ? "update" : "create",
    });
  }

  return changes;
}

export function normalizeRepositorySettings(
  repository: GitHubRepositorySettings,
): RepositorySettingsControl {
  return {
    wiki: repository.has_wiki,
    projects: repository.has_projects,
    squashMerge: repository.allow_squash_merge,
    mergeCommit: repository.allow_merge_commit,
    rebaseMerge: repository.allow_rebase_merge,
    autoMerge: repository.allow_auto_merge,
    deleteBranchOnMerge: repository.delete_branch_on_merge,
    updateBranch: repository.allow_update_branch,
  };
}

export function repositorySettingsPayload(
  control: RepositorySettingsControl,
): GitHubRepositorySettings {
  return {
    has_wiki: control.wiki,
    has_projects: control.projects,
    allow_squash_merge: control.squashMerge,
    allow_merge_commit: control.mergeCommit,
    allow_rebase_merge: control.rebaseMerge,
    allow_auto_merge: control.autoMerge,
    delete_branch_on_merge: control.deleteBranchOnMerge,
    allow_update_branch: control.updateBranch,
  };
}

export function normalizeCodeQlDefaultSetup(
  setup: GitHubCodeQlDefaultSetup,
): CodeQlDefaultSetupControl {
  const languages = new Set<string>();
  for (const language of setup.languages) {
    if (
      language === "javascript" ||
      language === "typescript" ||
      language === "javascript-typescript"
    ) {
      languages.add("javascript-typescript");
    } else {
      languages.add(language);
    }
  }
  return {
    state: setup.state,
    languages: [...languages].sort(),
    querySuite: setup.query_suite,
    threatModel: setup.threat_model,
    runnerType: setup.runner_type,
    runnerLabel: setup.runner_label,
  };
}

export function codeQlDefaultSetupPayload(control: CodeQlDefaultSetupControl): {
  state: CodeQlDefaultSetupControl["state"];
  languages: CodeQlDefaultSetupControl["languages"];
  query_suite: CodeQlDefaultSetupControl["querySuite"];
  threat_model: CodeQlDefaultSetupControl["threatModel"];
  runner_type: CodeQlDefaultSetupControl["runnerType"];
  runner_label: string | null;
} {
  return {
    state: control.state,
    languages: control.languages,
    query_suite: control.querySuite,
    threat_model: control.threatModel,
    runner_type: control.runnerType,
    runner_label: control.runnerLabel,
  };
}

export function normalizeMainRuleset(ruleset: GitHubRuleset | null): MainRulesetControl | null {
  if (!ruleset) return null;
  const pullRequest = ruleset.rules.find((rule) => rule.type === "pull_request");
  const statusChecks = ruleset.rules.find((rule) => rule.type === "required_status_checks");
  const pullParameters = pullRequest?.parameters ?? {};
  const checkParameters = statusChecks?.parameters ?? {};
  const checks = (checkParameters.required_status_checks ?? []) as Array<{ context: string }>;
  const allowedMergeMethods = (pullParameters.allowed_merge_methods ?? []) as Array<
    "merge" | "squash" | "rebase"
  >;
  return {
    name: ruleset.name,
    enforcement:
      ruleset.enforcement === "active" ||
      ruleset.enforcement === "disabled" ||
      ruleset.enforcement === "evaluate"
        ? ruleset.enforcement
        : "disabled",
    targetDefaultBranch:
      ruleset.conditions?.ref_name?.include?.length === 1 &&
      ruleset.conditions.ref_name.include[0] === "~DEFAULT_BRANCH" &&
      (ruleset.conditions.ref_name.exclude?.length ?? 0) === 0,
    requiredChecks: checks.map((check) => check.context).sort(),
    strictStatusChecks: Boolean(checkParameters.strict_required_status_checks_policy),
    allowBranchCreationWithoutChecks: Boolean(checkParameters.do_not_enforce_on_create),
    requirePullRequest: Boolean(pullRequest),
    allowedMergeMethods: allowedMergeMethods.sort(),
    dismissStaleReviews: Boolean(pullParameters.dismiss_stale_reviews_on_push),
    requireCodeOwnerReview: Boolean(pullParameters.require_code_owner_review),
    requireLastPushApproval: Boolean(pullParameters.require_last_push_approval),
    requiredApprovals: Number(pullParameters.required_approving_review_count ?? 0),
    requireConversationResolution: Boolean(pullParameters.required_review_thread_resolution),
    blockForcePushes: ruleset.rules.some((rule) => rule.type === "non_fast_forward"),
    blockDeletion: ruleset.rules.some((rule) => rule.type === "deletion"),
  };
}

export function mainRulesetPayload(
  control: MainRulesetControl,
  enforcement = control.enforcement,
): Omit<GitHubRuleset, "id"> & { target: "branch"; bypass_actors: never[] } {
  return {
    name: control.name,
    target: "branch",
    enforcement,
    bypass_actors: [],
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      {
        type: "pull_request",
        parameters: {
          allowed_merge_methods: control.allowedMergeMethods,
          dismiss_stale_reviews_on_push: control.dismissStaleReviews,
          require_code_owner_review: control.requireCodeOwnerReview,
          require_last_push_approval: control.requireLastPushApproval,
          required_approving_review_count: control.requiredApprovals,
          required_review_thread_resolution: control.requireConversationResolution,
        },
      },
      {
        type: "required_status_checks",
        parameters: {
          do_not_enforce_on_create: control.allowBranchCreationWithoutChecks,
          required_status_checks: control.requiredChecks.map((context) => ({ context })),
          strict_required_status_checks_policy: control.strictStatusChecks,
        },
      },
    ],
  };
}

export function normalizeReleaseEnvironment(
  environment: GitHubEnvironment | null,
  policies: Array<{ name: string }>,
  variables: Array<{ name: string; value: string }>,
): ReleaseEnvironmentControl | null {
  if (!environment) return null;
  const reviewRule = environment.protection_rules.find(
    (rule) => rule.type === "required_reviewers",
  );
  const waitRule = environment.protection_rules.find((rule) => rule.type === "wait_timer");
  return {
    name: environment.name,
    waitTimer: Number(waitRule?.wait_timer ?? 0),
    preventSelfReview: Boolean(reviewRule?.prevent_self_review),
    reviewers: (reviewRule?.reviewers ?? [])
      .map(({ type, reviewer }) => ({ type, id: reviewer.id }))
      .sort((left, right) => left.id - right.id),
    branches: policies.map((policy) => policy.name).sort(),
    customBranchesOnly: Boolean(
      environment.deployment_branch_policy?.custom_branch_policies &&
      !environment.deployment_branch_policy.protected_branches,
    ),
    guardValue: variables.find((variable) => variable.name === "RELEASE_GUARD")?.value ?? "",
  };
}
