# Contributing to Loupe

Thanks for your interest in contributing to Loupe.

## Local setup

Requirements: Node 18+ and `git`.

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

You can also check dark mode and the Excalidraw demo:

```sh
SCHEME=dark node test/acceptance.mjs examples/bramble/bramble.html
node test/acceptance.mjs demo/excalidraw/excalidraw.html
```

If Playwright is installed in another directory, point `PLAYWRIGHT_DIR=/path/to/node_modules` at it.

## CI workflow

A ready-to-enable GitHub Actions CI workflow lives at [`scripts/ci-workflow.yml`](scripts/ci-workflow.yml) (parked outside `.github/workflows/` until enabled). It runs `npm ci`, `npx playwright install --with-deps chromium`, and `npm test` across Node 18, 20, and 22.

## Pull requests

- Keep changes focused and small; open an issue first for larger design changes.
- Add or update tests for bug fixes and new behavior.
- If you change `viewer/template.html` or `src/render.mjs`, regenerate the checked-in demos (`npm run example` and `node bin/loupe.mjs render demo/excalidraw/excalidraw.tree.json`) and verify `npm test` passes.
- Do not include private repo paths, credentials, or real API outputs in commits.
