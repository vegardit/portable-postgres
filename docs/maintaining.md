# Maintainer guide

Use this guide when deciding whether to merge a change, operating the source updater, or publishing a release.
For setup, platform build commands and preparing a pull request, see [Contributing](../CONTRIBUTING.md).

## Reviewing a pull request before merge

Merging into `main` records our approval of the change, including its license and host evidence.
For a documentation-only change, review the text and the documentation checks.
For a change to the native distribution, review the CI results and decide whether the evidence covers what we will ship.

### Check the native build

Open the [Build workflow](../.github/workflows/build.yml) for the pull request.
Check that `Native release readiness` passed for the revision being merged.

- **Target tests.** The jobs test the extracted archives on their target platforms.
  They restore gzip and LZ4 dumps and use the bundled `pg_verifybackup` to check compressed base backups against their manifests.
- **Release validation.** Each job uploads its candidate and review evidence before running release validation.
  A pending license or host review fails the job.
- **Cross-target comparison.** CI requires a manifest for every target and checks for differences in the PostgreSQL version,
  source pins, extension versions and extension files.
  To investigate locally, download the `manifest-<target>` artifacts into separate directories named for each artifact.
  Run `pnpm binaries:compare --require-all-targets <downloads>` on their parent directory.

### Decide whether to accept the evidence

CI checks that the review is complete and matches the archive.
We still need to decide whether the cited sources support the licenses and host requirements in the pull request.

1. **Read the review diff against the base branch.** This shows what you are being asked to accept,
   even after the author updates the evidence and CI passes.
   To investigate a reopened component, use the Build run that reported it.
   Its summary lists up to 20 notice signature changes per component, with additions first as `license text added`
   and removals as `license text gone`.
   Each addition can have up to three example paths.
   Compare the draft's `noticeSignatures` with the previous review for the full list.
2. **Trace the change to the archive.** Read each updated source's release notes and compare its license, copyright and notice files.
   Newly bundled code can reuse an existing notice or have no detected notice.
   A copyright year alone leaves the signature unchanged, but changing a pinned notice changes its hash and reopens the review.
   Check that the affected binaries, SQL or data files have component coverage and that the archive carries the required notices.
3. **Check the target-specific claims.** Compare toolchain contributions and imported host libraries with the build evidence.
   Check measured requirements, including the glibc symbol version on Linux, against the proposed review.
   When a review cites a tested OS or CPU, check what the run actually exercised.
4. **Merge when the evidence supports the change.** If a license, notice or host requirement is unexplained, request an update on the PR.
   The author can use the [evidence update procedure](../CONTRIBUTING.md#updating-license-and-host-evidence-in-your-pr).
   Once the evidence and required checks are satisfactory, merge the reviewed revision.

The native artifact contract explains [which evidence carries forward](native-artifact.md#reusing-review-evidence)
and [which toolchain components each platform must cover](native-artifact.md#linked-toolchain-components).

## Protecting the main branch

In the GitHub ruleset or branch protection for `main`, require pull requests and the `Native release readiness` check from GitHub Actions.
Require branches to be up to date or use the merge queue so the check covers the code being merged.
The check reports on every pull request and runs the full native matrix for merge groups.

## Operating the source updater

The [Update Sources workflow](../.github/workflows/update-sources.yml) runs every Monday.
When a pin changes, it opens or refreshes a pull request from `dependencies/sources`.
It uses a GitHub App so the pull request's checks run automatically.
Set `PR_UPDATER_APP_ID` as a repository variable and `PR_UPDATER_APP_PRIVATE_KEY` as a repository secret.
The workflow requests write access to contents and pull requests for the App token.

For a manual run, select the intended base branch.
The updater refuses a tag, its own update branch, or a base that conflicts with an open pull request from the update branch.
Once a reviewer commits changes to the update branch, the updater skips the refresh.
It also preserves commits pushed while a refresh is in progress.
After a squash merge, delete the merged update branch so the next update can create a fresh one.

### Reviewing an update from the bot

Check the proposed releases against the `upstream` entries in [sources.json](../binaries/sources/sources.json).
PostgreSQL stays within its pinned major version and OpenSSL on the 3.5 LTS patch series.
ICU, zlib, LZ4 and separately released extensions follow their newest stable releases.
The Windows toolchain has its own manually maintained pins.

| Archive                                             | Evidence for the pinned SHA-256                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| PostgreSQL, OpenSSL and LZ4 release archives        | The updater compares the download with the publisher's checksum file.                      |
| Named GitHub release assets, including zlib and ICU | It checks the digest for that exact asset on the selected release.                         |
| Generated GitHub tag archives                       | GitHub publishes no checksum for these archives. The digest comes from the first download. |

Check the [packaging revision](../CONTRIBUTING.md#archive-names-and-revisions) and investigate any reopened components before merging.
See [Updating pinned sources](../CONTRIBUTING.md#updating-pinned-sources) for the local command and how to resolve build failures.

## Releasing

Start the [Release workflow](../.github/workflows/release.yml) manually.
Choose the branch and the `dry-run` setting when you start the run.

- **Dry run (default).** Leave `dry-run` enabled to build all four targets, run their native tests,
  validate their license and host reviews, and compare the targets.
  A pending review fails the run. A successful dry run stops before release asset preparation.
- **Publish.** Select `main` and turn off `dry-run`.
  Only the Release workflow publishes native releases, and only from `main`.

A published release is immutable.
Its tag includes the PostgreSQL version and packaging revision, for example `native-v18.7-r1`.
To publish a correction, use the [next packaging revision](../CONTRIBUTING.md#archive-names-and-revisions).

### Local release checks

Preparing assets that include a Windows ZIP archive requires Python 3 on `PATH` as `python` on Windows
or `python3` on Linux and macOS. Use the version in [.python-version](../.python-version) to match CI.

- **Check a candidate's layout.** Run `pnpm binaries:validate:candidate <target> <installation>`.
- **Rehearse asset preparation.** Run `pnpm binaries:release <downloads> <output> <owner/repository>` with downloaded candidate archives and a new output directory.
  Omitting `--require-all-targets` lets you supply a single target.
  Every supplied ZIP or tarball must still match the current revision, source pins and a supported target.

To exercise the Linux x64 build job and its release validation locally, use [act](https://github.com/nektos/act).

```sh
act workflow_dispatch -W .github/workflows/release.yml --input dry-run=true --matrix output:linux-x64
```

act's artifact server cannot accept this workflow's upload action, so the local run stops short of handing archives to the publish job.
[Release tests](../tests/release.test.ts) cover the asset checks, checksums, descriptor and release notes.

### How publication works

1. **Build and test.** Release calls the same four-target Build workflow used on pull requests.
   Publishing requires all four archives to pass release validation and the cross-target comparison to succeed.
2. **Prepare release assets.** The publish job downloads the archives from its own run.
   It reads their manifests without unpacking the full archives again.
   It checks that all four targets are present, match the checkout's release version and source pins,
   and carry verified reviews. It then compares their contents.
   It writes the per-target manifests, `SHA256SUMS`, a descriptor with each archive's URL and SHA-256, and the release notes.
   It also packs the source bundle.
3. **Attest and publish.** The job checks that the tag is unused and attests the provenance of the archives.
   It uploads the assets to a draft GitHub release, then publishes the draft once all assets are in place.

### What's in the source bundle

`portable-postgres-<version>-sources.tar.gz` contains the files from the release commit and the pinned source archives.
The archives are under `binaries/work/downloads/`, where a build from the bundle finds them and verifies their hashes.
Redistributors can pass on this bundle alongside the native archive.

Creating the bundle requires a clean tracked working tree.
Build tools are installed separately as described in [Building native archives](../CONTRIBUTING.md#building-native-archives).
