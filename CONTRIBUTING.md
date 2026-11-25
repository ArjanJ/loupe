# Contributing to Loupe

Thanks for your interest in contributing to Loupe.

## Local setup

Requirements: `git`, and Node 20+ to run the full test suite (Playwright needs 20+). Loupe itself runs on Node 18+.

```sh
git clone https://github.com/ArjanJ/loupe.git
cd loupe
npm ci
npx playwright install chromium
```

## Running tests

```sh
npm test
```

`npm test` runs:
1. `test/pipeline.mjs` — end-to-end CLI tests against local stub models (no network, no Playwright).
2. `test/picker.mjs` — interactive terminal model-picker tests.
3. `test/escaping.mjs` — XSS and offline/CSP tests in Playwright Chromium.
4. `test/acceptance.mjs examples/bramble/bramble.html` — viewer layout, interaction, theme, and performance checks.
5. `test/site.mjs` — builds `_site/` and verifies the landing page across desktop, tablet, and mobile viewports.

You can also check dark mode and the Immich demo:

```sh
SCHEME=dark node test/acceptance.mjs examples/bramble/bramble.html
node test/acceptance.mjs demo/immich/immich.html
```

If Playwright is installed in another directory, point `PLAYWRIGHT_DIR=/path/to/node_modules` at it.

## CI workflow

GitHub Actions CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs on every push and pull request. It runs `npm ci`, `npx playwright install --with-deps chromium`, and `npm test` across Node 20, 22 and 24, plus the browser-free tests (`test/pipeline.mjs`, `test/picker.mjs`) on Node 18.

## Releasing

Versioning and publishing are automated with [Changesets](https://changesets.dev) in [`.github/workflows/publish.yml`](.github/workflows/publish.yml). Publishing uses npm trusted publishing (OIDC). There is no npm token in the repo. Don't edit `version` in `package.json` by hand.

1. **In a PR that should ship**, run `npx changeset`, pick `patch`, `minor` or `major`, and write a one-line summary for users. Commit the generated `.changeset/*.md` file with the PR. PRs that shouldn't release (tests, CI, docs) don't need one.
2. **After it merges**, the workflow opens or updates a PR titled **Version Packages**. That PR bumps `package.json` and `package-lock.json`, adds the summaries to `CHANGELOG.md`, and deletes the changeset files. Further merges with changesets keep updating the same PR.
3. **To release, review and merge Version Packages.** The workflow then runs the full test suite on Node 24, publishes to npm with provenance, pushes the `vX.Y.Z` tag, and creates the GitHub Release. You don't create releases or tags yourself.

CI doesn't run on the Version Packages PR automatically, because GitHub doesn't start workflows for PRs that Actions opens. Its changes are only version, lockfile and changelog edits, and the publish job runs the full test suite again before anything is published.

To validate the package without publishing, run the **Publish** workflow manually (Actions → Publish → Run workflow). It runs the tests and `npm publish --dry-run`, and never publishes.

### One-time GitHub setup

In the repo's **Settings → Actions → General → Workflow permissions**, enable **Allow GitHub Actions to create and approve pull requests**. Without it, the workflow can't open the Version Packages PR.

### One-time npm setup

On npmjs.com, open the `@arjanj/loupe` package settings → **Trusted Publisher** → **GitHub Actions**, and enter:

- Organization or user: `ArjanJ`
- Repository: `loupe`
- Workflow filename: `publish.yml`
- Environment name: leave blank
- Allowed actions: enable direct `npm publish`. Configs created after 2026-09-03 default to `npm stage publish` only, and this workflow doesn't use staged publishing.

A new trusted publisher must complete its first successful publish within 2 days, or the configuration expires and you need to create it again.

Once an OIDC publish has succeeded, you can optionally lock down token publishing under **Settings → Publishing access → Require two-factor authentication and disallow tokens**. Wait until the workflow is verified so a fallback remains during rollout.

## Pull requests

- Keep changes focused and small; open an issue first for larger design changes.
- Add or update tests for bug fixes and new behavior.
- If you change `viewer/template.html` or `src/render.mjs`, regenerate the checked-in demos (`npm run example` and `node bin/loupe.mjs render demo/immich/immich.tree.json`) and verify `npm test` passes.
- Do not include private repo paths, credentials, or real API outputs in commits.
