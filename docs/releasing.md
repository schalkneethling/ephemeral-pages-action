# Trusted release process

Releases are published by GitHub Actions, never by pushing tags from a workstation. The local
commands validate and dispatch; the protected `release` environment controls the only job with
`contents: write`.

## One-time repository setup

The desired controls are committed in `.github/repository-controls.json` and implemented by
`scripts/repository-controls.ts`. See [Repository controls](repository-controls.md) for the full
automated and manual control inventory.

From a clean, synchronized `main` branch, inspect and apply the controls:

```sh
pnpm repo:controls:check
pnpm repo:controls:apply
pnpm repo:controls:check
```

The apply command shows its plan and requests confirmation. For unattended administration, pass
`--yes` explicitly:

```sh
pnpm repo:controls:apply -- --yes
```

It also normalizes repository merge settings, enables the dependency graph and Dependabot,
configures CodeQL default setup, enables immutable Releases, keeps the default Actions token
read-only, creates or updates the `protect-main` ruleset, and configures the `release` environment
with:

- Schalk Neethling as the required reviewer;
- self-review allowed while the project has one release maintainer;
- deployments restricted to `main`;
- an environment-scoped `RELEASE_GUARD` variable required by publishing and rollback.

The script is idempotent and verifies the controls after applying them. It identifies named
controls and updates them instead of creating duplicates.

GitHub does not currently expose the environment's administrator-bypass setting or the personal
repository's Dependabot malware-alert toggle through supported repository APIs. Complete both
manual controls described in [Repository controls](repository-controls.md). The environment guard
ensures that deleting and implicitly recreating the environment without its configuration cannot
publish a release.

## Prepare a release

Every release starts with a same-repository release-preparation pull request. This gives the exact
prospective release tree a production smoke test without weakening fork protections.

For releases after `v1.0.0`, update the package version on the preparation branch without creating
a local tag:

```sh
pnpm version 1.0.1 --no-git-tag-version
```

Commit `package.json` and `pnpm-lock.yaml`, open the pull request, and require:

- the `quality` job to pass;
- the production `publish` smoke job to pass from the same repository;
- all review conversations to be resolved.

Merge the pull request. Do not release from an unreviewed commit or directly pushed commit.

## Validate and release

Return to a clean, synchronized `main` branch:

```sh
pnpm release:check
pnpm release
```

`release:check` runs all quality gates, confirms the committed bundle is current, checks repository
control drift, and verifies that the exact release tree passed post-merge CI and the same-repository
production smoke test.

`release` repeats the checks, displays the package version and exact commit, requests confirmation,
dispatches `.github/workflows/release.yml`, and watches the run. GitHub repeats every authoritative
check before the protected publish job waits for approval.

The local check also verifies the repository's immutable-release setting with the maintainer's
authenticated `gh` session. GitHub's workflow token cannot read that administration-only endpoint,
so the workflow relies on the successful local preflight and then requires the published Release
response itself to be immutable. Always dispatch through `pnpm release`; do not invoke the workflow
directly from the Actions tab.

To exercise the complete read-only path first:

```sh
pnpm release -- --dry-run
```

After reviewing the workflow summary, approve the `release` environment deployment. The workflow:

1. Reconfirms that `main` still points to the verified commit.
2. Creates a draft `vX.Y.Z` Release with generated notes.
3. Publishes it under GitHub's immutable Release protection.
4. Creates or moves the floating `vX` tag.
5. Verifies that both tags resolve to the exact release commit.

The workflow uses a concurrency group and cannot be cancelled by a newer release run.

## Retry and recovery

Release publication is resumable:

- an exact existing draft is published;
- an exact immutable published Release is accepted;
- a missing or stale floating major tag is repaired;
- a full version tag or Release pointing elsewhere causes a hard failure;
- an ordinary release never moves the floating tag to an older version.

Rerun the failed workflow or dispatch `pnpm release` again after correcting the transient problem.
Never move, delete, or reuse a full version tag.

## Roll back the floating tag

For an urgent regression, run **Roll back floating release tag** from the Actions tab and enter an
existing full version tag such as `v1.0.0`. The workflow requires the same `release` environment
approval, verifies that the target is a published immutable Release, and moves only the floating
major tag.

Follow the rollback with a fixed patch release. The defective immutable Release remains part of the
audit history.

## Release consumers

Use a full version for an immutable dependency:

```yaml
- uses: schalkneethling/ephemeral-pages-action@v1.0.0
```

Use the floating major tag to receive compatible fixes automatically:

```yaml
- uses: schalkneethling/ephemeral-pages-action@v1
```

Marketplace publication remains optional and separate from repository release automation.
