# Ephemeral Pages Action

Publish a self-contained HTML report from a same-repository pull request to [Ephemeral Pages](https://ephemeral.schalkneethling.com), then create or update one stable pull-request comment with its temporary URL.

The Action compresses the report with Brotli, authenticates through GitHub Actions OIDC when permitted, and falls back to the anonymous service quota when OIDC is unavailable. It needs no personal access token, Ephemeral Pages API key, or repository secret.

> [!WARNING]
> Reports are public and temporary. Never upload secrets, credentials, private source code, or sensitive test data.

## Usage

Run the workflow only for `pull_request` events from the same repository:

```yaml
name: Accessibility report

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write
  id-token: write

jobs:
  report:
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7

      - name: Run accessibility tests
        run: npm run test:a11y

      - name: Publish accessibility report
        id: publish-report
        uses: schalkneethling/ephemeral-pages-action@v1
        with:
          report-path: playwright-report/index.html
          ttl-hours: "24"
          report-name: Accessibility report
          github-token: ${{ github.token }}
```

`pull-requests: write` allows comment creation and updates. `id-token: write` enables the preferred repository-scoped API quota; without it, the Action warns and uses the anonymous quota.

> [!CAUTION]
> Do not change the event to `pull_request_target`. This Action intentionally rejects `pull_request_target`, fork pull requests, and non-PR events before reading the report. Using an elevated upstream token to process fork-controlled HTML is unsafe.

## Inputs

| Input          | Required | Default                                 | Description                                                                      |
| -------------- | -------- | --------------------------------------- | -------------------------------------------------------------------------------- |
| `report-path`  | Yes      | —                                       | Path to a self-contained HTML report, resolved inside `GITHUB_WORKSPACE`.        |
| `ttl-hours`    | No       | `12`                                    | One of `1`, `3`, `5`, `7`, `12`, `24`, `72`, `120`, or `168`.                    |
| `report-name`  | No       | `Accessibility report`                  | Heading used in the PR comment. Each normalized name has its own stable comment. |
| `service-url`  | No       | `https://ephemeral.schalkneethling.com` | Ephemeral Pages service origin.                                                  |
| `github-token` | Yes      | —                                       | The automatic `${{ github.token }}` used for PR comments.                        |

## Outputs

| Output       | Description                                  |
| ------------ | -------------------------------------------- |
| `page-id`    | Ephemeral Pages page identifier.             |
| `page-url`   | Absolute temporary report URL.               |
| `expires-at` | ISO-8601 expiration timestamp.               |
| `comment-id` | GitHub ID of the created or updated comment. |

Upload outputs are set before commenting. If the upload succeeds but GitHub commenting fails, the Action fails while retaining the upload outputs and printing only the public report URL.

## Security and limits

- Only same-repository `pull_request` events are supported. The head repository, base repository, and workflow repository must all match.
- The resolved and real report path must stay inside the workspace and refer to a regular file. Symlink escapes are rejected.
- Raw HTML is limited to 20 MiB. Brotli-compressed bytes are limited to 2 MiB.
- The OIDC audience is the normalized service origin. Tokens and report contents are never included in Action errors.
- Uploads use a stable idempotency key derived from repository ID, run ID, run attempt, and normalized report path. Retries in one attempt reuse the key; a new run attempt receives a new key.
- Network errors, `429`, and transient `5xx` responses are retried across up to three attempts. `Retry-After` is honored; otherwise the Action uses bounded exponential backoff with jitter.
- The returned page URL must have the configured service origin.
- Existing comments are updated only when they have the exact report marker and were authored by `github-actions[bot]` or the authenticated token owner.

Ephemeral Pages applies separate anonymous and verified-GitHub quotas. See the [production API documentation](https://github.com/schalkneethling/ephemeral-pages/blob/main/docs/api.md) for the current quotas and response contract.

## Development

Node 24 and pnpm 11.10 are required.

```sh
pnpm install --frozen-lockfile
pnpm quality
```

`pnpm build` creates the checked-in `dist/index.js` bundle. `pnpm bundle:check` rebuilds and fails when the committed bundle differs. CI runs linting, formatting, type checking, unit tests, coverage, Node 24 bundle execution, and bundle verification.

Release steps are documented in [docs/releasing.md](docs/releasing.md). No release is performed automatically by CI.

## License

[MIT](LICENSE)
