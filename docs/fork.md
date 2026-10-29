# This fork

`lingqiqi5211/moepie` builds on [yetone/magpie](https://github.com/yetone/magpie)
and removes what this fork does not use. Upstream moves fast, so the two
branches have different jobs:

| Branch | Who writes it | What it holds |
| --- | --- | --- |
| `main` | this fork | the shipped source: selected upstream patches grouped by topic, minus what the fork drops |
| `up` | `.github/workflows/sync-upstream.yml` only | upstream `main`, mirrored every six hours; never authored, never committed to |

Never commit to `up` and never mirror it by hand: the workflow force-moves it,
and a local commit there is lost without a trace.

Set the Actions secret `UPSTREAM_SYNC_TOKEN` before the first sync. Prefer a
fine-grained PAT limited to this repository with Contents and Workflows write
(or a classic PAT with `repo` and `workflow`). The built-in `GITHUB_TOKEN`
cannot mirror upstream workflow files even with `contents: write`. The secret
is used only by the main-branch sync job for ref API calls; it never checks
out or executes upstream code. Rotate the secret when its token expires.

## Picking upstream work into main

`main` takes selected upstream patches, never a merge. Related fixes are
applied without committing and collected into one commit per topic; unrelated
topics stay separate. A merge would carry every upstream commit at once,
including the ones this fork removed or rewrote.

```shell
git fetch origin up
git log --cherry-pick --right-only --no-merges main...origin/up --oneline
                                  # candidates, not a count of missing changes
git cherry-pick --no-commit <sha>   # apply each reviewed patch in dependency order
                                  # validate the topic, then commit with source SHAs
```

Record every selected upstream commit's full SHA in the topic's commit body.
This preserves provenance even when several upstream commits become one fork
commit. Keep the upstream `area: behavior` subject style.

The Sync upstream workflow lists up to 40 upstream candidates in its run
summary. GitHub compares commit ancestry, while `--cherry-pick` only filters
patch equivalents. Neither recognizes all grouped or adapted changes: check
recorded source SHAs and the actual code before picking a candidate again.

Rules for picking:

- Pick by what the fork needs, not by what upstream shipped. Skipping a commit
  is the normal case.
- A conflict is usually the subtraction talking. Keep the removal, take the
  rest of the commit, and say so in the commit message (`upstream a1b2c3d,
  minus the partner list`).
- When an upstream commit only touches code the fork dropped, do not pick it.
- When upstream fixes a bug inside dropped code the fork still uses, port the
  fix by hand and cite the upstream sha.
- Do not rewrite upstream history on `main` (no rebase or amend of picked
  commits): `git log --grep` and the release notes both key off those shas.

A pick that needs several local commits behind it belongs in one commit with
the conflict resolution described, so the next pick stays a one-line decision.

## Application name and compatibility

The application and its build outputs are **moepie**: `make build`, `make cli`
and `make install` produce `moepie`, the Mac bundle is `moepie.app`, and release
assets use `moepie-` (desktop) or `moepie-cli-` (terminal). The updater selects
those same names and unpacks `moepie.app`. The Mac bundle identifier is
`io.github.lingqiqi5211.moepie`; the `magpie://` import scheme stays compatible.

This is not a data or protocol migration. The Go module/imports, data folders,
`MAGPIE_` variables, ports, internal identifiers and CLI compatibility commands
keep their upstream names. Linux's GTK program name also stays `magpie`, since
WebKit uses it for its data folder. Windows still writes `magpie.com` as the
console companion: existing `magpie` commands wait for it, and it records the
actual `moepie-windows-*.exe` target rather than assuming an executable name.
Process and built-in MCP detection accept both `moepie` and older binary names;
carried MCP libraries keep their compatible `magpie` command marker. Existing
shortcuts are not forcibly migrated or recreated after user deletion.
Copyright and third-party notices remain in the builds.

## Versions

The fork keeps upstream's numbering: `0.1.N`, no `v` in `VERSION`, `v` on the
tag. N is per fork, not per upstream: an inherited upstream `v0.1.1743` says
nothing about the fork's own releases, so those tags only reserve numbers that
future fork releases must not reuse.

Releases are cut from `main` only, and only after Test passed on that exact
commit.

## Building and releasing

`.github/workflows/test.yml` runs on main pushes and pull requests (Go checks
on three systems, the site worker tests and CLI builds). Linux and macOS run
ordinary checks and race checks on separate runners; both must pass. Gateway
tests run in isolated processes, one per core, in each check. Browser tests
run separately with Playwright. The release reads the whole Test workflow's
result for the exact commit.

`.github/workflows/release.yml` runs only through **Actions → Release → Run workflow**.
A push to `main` runs Test and Docker, but does not start a release build or
publish a version. Select `main` as the workflow branch, set `ref` to the main
commit to build (default `main`), and optionally set `version` to `0.1.N`:

1. **prepare** checks the commit is on `main`, that Test passed for it as a
   push, and allocates the next `0.1.N`. A manual run can supply a version. It also reuses the version of
   a draft release left by a failed attempt instead of skipping the number.
   A commit that already has a published release is skipped, not rebuilt.
2. **mac**, **cli**, **linux**, **windows-check** build the 15 application files
   and prove the Windows and Linux apps start and answer on the gateway.
3. **publish** verifies the file set, creates `dist/SHA256SUMS`, generates bilingual
   notes, uploads them, and publishes a draft release atomically: the updater
   never sees a half-uploaded release. It explicitly reserves the Git tag and
   resolves lightweight or annotated tags to the build commit, including a
   creation conflict; it checks again immediately before making the draft
   public. `--target` is retry metadata, not proof of the tag's commit.

Runs are artifacts-only unless `publish` is ticked. To make a public release,
tick it explicitly; the exact commit must already have a successful main-push
Test run. A published release contains exactly the 16 files the updater looks
for; anything else fails the run instead of shipping.

Signing is optional. Without `MAC_CERTIFICATE_P12` the mac build is ad-hoc
signed and not notarised; without `DEEPSEEK_API_KEY` the notes stay English
and use the commit list. Set the repository variable `RELEASE_NOTES_MODEL` to
change the default `deepseek-chat` model. See the workflow for signing secrets.

## UI preview retention

`ui-previews` stores screenshots and recordings, with one root commit and only
the latest preview for each open PR. Publishing replaces that PR's older
preview and removes closed PRs. The **UI preview cleanup** workflow also runs
on PR closure (including merge), daily at 03:23 UTC, or manually from Actions.
It reads all pages of open PRs before pruning; a failed read stops cleanup.
Publication and cleanup share a writer queue and use a Git lease when replacing
the branch. No expired previews means no new commit; an absent branch is left
absent. Preview links for closed PRs stop working after cleanup.

Actions artifacts expire separately: PR input after 3 days, recordings after
7 days. GitHub controls garbage collection of old unreachable Git objects.

## Update feed

The fork's own updates come from the fork: `internal/update/github.go` reads
this repository's releases, `internal/update/notes.go` reads the notes
attached to them. Release metadata and `SHA256SUMS` are fetched only from the
original URL, never through a source mirror. History scans up to 15 pages of
100 releases before sorting by version or choosing Stable; explicit 50/100
release history is not clipped to the default 40-note display limit.
`MAGPIE_UPDATE_FEED` overrides update metadata;
`MAGPIE_NOTES_FEED` separately overrides release notes for tests and local runs.

## Checks before a pick lands

```shell
gofmt -l . && go vet -tags nogui ./... && go test -tags nogui ./...
node --test internal/gui/tests/*.test.cjs
node --check internal/gui/assets/app.js
actionlint
```

`go vet` is skipped for GUI packages on a machine without GTK/WebKitGTK; CI
still runs the full set.
