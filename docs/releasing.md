# Release checklist

Do not release from an unreviewed commit. For the first stable release:

1. Merge an implementation pull request after CI and the production smoke-test workflow pass.
2. Open or rerun a same-repository pull request and confirm that the report renders under the Ephemeral Pages sandbox and Content Security Policy.
3. Rerun the workflow and confirm that it updates the existing marked comment.
4. Confirm that `page-id`, `page-url`, `expires-at`, and `comment-id` are populated.
5. After the one-hour smoke-test TTL, confirm that the page and metadata return `404` following scheduled cleanup.
6. Run `pnpm quality` from a clean checkout and confirm that the committed bundle is current.
7. Create the `v1.0.0` release tag from the reviewed merge commit.
8. Create or move the floating `v1` tag to the same commit.
9. Optionally publish the Action to GitHub Marketplace.

Never move a release tag to an unreviewed commit. Marketplace publication is optional and is separate from the repository release.
