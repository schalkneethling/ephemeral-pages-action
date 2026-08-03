# Repository controls

Repository settings are managed as committed desired state. Use the read-only check to review
drift and the interactive apply command to make supported changes:

```sh
pnpm repo:controls:check
pnpm repo:controls:apply
pnpm repo:controls:check
```

For unattended administration, explicit confirmation is still required:

```sh
pnpm repo:controls:apply -- --yes
```

## Automated controls

The script reads every supported setting before planning changes, applies only drifted controls,
and reads the settings back before succeeding. It manages:

- disabled wiki and projects;
- merge commits and rebasing enabled, with squash merging disabled;
- pull-request branch updates, auto-merge, and merged-branch deletion enabled;
- immutable GitHub Releases;
- a read-only default GitHub Actions token that cannot approve pull requests;
- Dependabot alerts, which also enable the dependency graph;
- Dependabot security updates;
- CodeQL default setup for GitHub Actions and JavaScript/TypeScript;
- the `protect-main` ruleset, including required pull requests, the `quality` status check,
  conversation resolution, and protection from deletion and force pushes;
- the reviewer-protected `release` environment and its guard variable.

CodeQL configuration is asynchronous. The apply command performs bounded polling and fails unless
GitHub reports the committed desired state before the verification deadline. Dependabot version
updates remain declarative in `.github/dependabot.yml`; tests require both npm and GitHub Actions
update entries.

## Manual controls

GitHub does not currently expose two settings through supported repository APIs:

1. In **Settings → Environments → release**, disable administrator bypass.
2. In **Settings → Advanced Security**, enable **Dependabot malware alerts**.

The command prints a reminder for both controls. Browser automation may help with initial setup,
but it is not used as an authoritative drift check because it depends on GitHub's page structure
and does not provide a stable, documented state API.

## API references

- [Repositories REST API](https://docs.github.com/en/rest/repos/repos)
- [Repository rulesets REST API](https://docs.github.com/en/rest/repos/rules)
- [Code scanning default setup REST API](https://docs.github.com/en/rest/code-scanning/code-scanning)
- [Configuring Dependabot malware alerts](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/configure-malware-alerts)
