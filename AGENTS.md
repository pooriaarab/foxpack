# AGENTS.md

<!-- pr-standards:start -->

## Pull requests

One issue. One PR. One concern. Under 500 counted lines.

Open the issue first. No issue, no branch. The issue number ties the branch, the
title, the body and the merged commit to one agreed piece of work.

```text
branch:  fpk-<issue>-<slug>          fpk-142-fix-onboarding-drop-off
title:   [FPK-<issue>] <Subject>   [FPK-142] Fix onboarding drop-off
body:    Closes #142
         ## What / ## Why / ## How I verified
         Assisted-by: <agent>:<model>
         Assisted-by: <agent>:<model>
```

One `Assisted-by: <agent>:<model>` line per contributor. Repeat the line for
each contributor. A comma-separated list on one line fails the check.

Subject line: imperative mood, 10-50 characters, no trailing period, no emoji.
Write "Fix the drop-off", not "Fixed the drop-off".

Hard caps, failed by the `pr-standards` CI check: 500 counted lines, 40 counted
files, exactly one `Closes #`. Lockfiles, build output, snapshots, generated
code and migrations are not counted. There is no label that clears the cap and
no one to ask for one. Split the change.

Settings for this repo are in `.github/pr-standards.json`. The standard is at
https://github.com/pooriaarab/scripts/blob/main/pr-standards.md

## Merge gates

Run the repo `ci:local` script before every `git push` when it exists.
Else run the same lint, typecheck, and unit tests CI runs.
Do not push a red local gate. Do not use CI as the test runner.

For a change a user can see, or that talks to a third party, walk the
Cloudflare Worker Preview before merge. Quote the Preview URL and status
codes. A 2xx on the site home is not that walk.

Wait for one LLM review APPROVED. Red CI blocks merge even when GitHub
does not require checks.

## Agent presence

Before you cut a branch:

```
bin/fleet-presence claim pooriaarab/<repo> <N> --goal "..." --branch <branch>
```

One sticky GitHub comment per agent. Create once, then PATCH. Same-machine
lock is local. Name harness, model, host, start time, and goal. Do not dump
transcripts. Full rule: pooriaarab/private-repo-b1e6 `rules/fleet-claim.md`.

<!-- pr-standards:end -->

## Layout

```text
src/              the library source, built to dist/ by tsc
tests/            tests for the failure modes in docs/failure-modes.md
docs/failure-modes.md  every way the code can fail, written before the code
.github/          CI, release, PR and issue standards
extension/        the extension that shows this repo working in Firefox
src/parse/        one parser per export (ChatGPT, Claude, Gemini Takeout, memory lists)
src/read.ts       readExport: zip or JSON in, the right parser, the size cap
src/extract.ts    extractMemories: the sentence patterns
src/pack.ts       createPack: the store and the review flow
src/node.ts       foxpack/node: the pack file, and the entry Node gets for "foxpack"
src/cli.ts, src/mcp.ts  the foxpack command and the read-only MCP server
docs/format.md    the foxpack/v1 format, the DTI mapping, what is known about each export
scripts/build-ext.mjs  bundles extension/ into dist-ext/
e2e/run.mjs       the Firefox E2E on dist-ext/; writes artifacts/e2e-<date>.json
e2e/standin/      a stand-in extension the E2E installs twice (foxscope and a stranger); never in dist-ext/
e2e/site/         the page where the stand-ins' content scripts run
```

## Commands

```bash
pnpm install
pnpm ci:local   # lint + typecheck + test + build; run before every hand-off
pnpm build:ext  # extension/ -> dist-ext/; fails if the manifest and package.json versions differ
pnpm lint:ext   # web-ext lint on dist-ext/ (part of ci:local)
pnpm e2e        # builds dist/ and dist-ext/, then the Firefox E2E; set FIREFOX if Firefox is not in the usual place
                # on Ichabod: set -a; . ~/Documents/Personal/.secrets/ichabod.env; set +a; FOXKIT_BROWSER=ichabod pnpm e2e
```

## Testing

Prefer E2E tests. Do not write unit tests after the code. To test a part in
isolation, first list its failure modes in `docs/failure-modes.md`, then write
the tests, then the code. Commit in that order.

## Release

`main` is staging and `release` is production. A push to `release` runs
`.github/workflows/release.yml`. It refuses a version that has a tag, runs
`pnpm ci:local`, publishes to npm with the `NPM_TOKEN` secret, then tags
`v<version>` and creates a GitHub release.

After the npm publish, it submits `dist-ext/` to AMO as a listed add-on,
with the listing in `extension/amo-metadata.json`. AMO reviews the version
before it signs it, so the GitHub release links to the listing and has no
`.xpi`. It needs the secrets `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`. Keep the
`version` in `extension/manifest.json` equal to the one in `package.json`.
`pnpm check:amo` checks the listing and the release build in `dist-ext/`;
it runs in `pnpm ci:local`. Keep test-only parts in `e2e/`. If a
release re-run finds the version already listed on AMO, it skips the upload.
