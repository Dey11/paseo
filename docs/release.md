# Release

HanabiCode ships one GitHub Release per version tag from
[Dey11/hanabicode](https://github.com/Dey11/hanabicode). The release playbook
in [docs/fork-docs/distribution.md](fork-docs/distribution.md) owns the full
workflow — read it before any release. This page records the fork-specific
release rules only.

All workspaces share one version and release together.

## Never publish to upstream infrastructure

This fork is not an official Paseo release source. Never:

- publish `@getpaseo/*` npm packages — the internal namespace is a
  compatibility artifact, not a publish target
- push container images to the official `ghcr.io/getpaseo/paseo` namespace
- use Expo/EAS builds, update channels, or store submission
- deploy to Cloudflare Workers or the hosted Hub
- publish releases, tags, or assets to `getpaseo/paseo` or the upstream relay

Every artifact goes to `Dey11/hanabicode` only.

## Two steps

A release has two steps. The agent does the first, the user authorizes the
second.

**Preparation** (local, reversible — agent does this):

- format, lint, typecheck all green
- run `npm run release:check` before the version commit and tag; the release workflow repeats this check on the tagged source
- classify the diff from the previous stable tag as patch or minor, then show
  the target version and rationale to the user
- draft the changelog entry, show it to the user, wait for review
- run the pre-release sanity check from distribution.md and surface findings

**Go-ahead** (user says "go ahead"):

- commit the approved release inputs locally
- run the version command and push the prepared branch and tag
- dispatch the HanabiCode Release workflow with that tag
- create the release heartbeat immediately and babysit it to completion

Rules that apply to both steps:

- Last-minute changes always need approval. Every time.
- No code changes are bundled into the changelog commit or the version commit.
- A sanity-check finding is information, not a directive. The agent surfaces
  it; the user decides.
- Invoking a release skill is intent to start the flow, not blanket
  authorization to publish.
- If the user asks for a release preview, show the prospective changelog and
  answer questions, but do not commit, tag, publish, or run release commands
  until they explicitly authorize the release.

## Version decision

Every fresh release starts by classifying the full diff from the previous
stable tag. The highest-impact change determines the version: minor for
substantial new workflows, providers, platforms, or integrations; patch for
fixes, polish, and small enhancements. Follow-up corrections to a minor release
are patches. Agents never select a major version autonomously; a major release
requires an explicit user instruction.

Version bumps are never used to retry a failed build. Fix the failure in a new
commit and cut a new version — never move or reuse a tag.

## Cutting a release

The commands in distribution.md are the source of truth. The version command
updates every workspace, creates the release commit, and tags it:

```bash
npm run release:check
npm run version:all:patch   # or: npm run version:all:minor
git push origin main
git push origin "$(git tag --points-at HEAD)"
gh workflow run hanabicode-release.yml \
  --repo Dey11/hanabicode \
  -f tag="$(git tag --points-at HEAD)"
```

The workflow creates a draft release first and publishes it only after every
platform job passes. Confirm every artifact against the completion checklist in
distribution.md before reporting the release as shipped.

## Release completion and heartbeat

A release is **shipped** only after every applicable build, asset, manifest,
and signature check in distribution.md passes. Immediately after the tag push,
create a heartbeat that resumes the release in the current conversation. The
heartbeat owns the release until the checklist passes or a failure needs new
user authority. Delete the heartbeat only after every item passes, then report
the release as shipped.

## Changelog

The agent running the release writes the changelog entry — beta or stable —
from the previous stable tag to the release source. The heading must be exactly
`## X.Y.Z - YYYY-MM-DD` with no `v` prefix and no extra text, because Release
Notes Sync matches the pushed tag to the heading when it mirrors the entry into
the GitHub Release body.

Each bullet is a compact factual record of user-visible behavior that changed:
`Added <capability>`, `Removed <behavior>`, `Changed <behavior>`, or
`Fixed <failure> when <condition>`. Keep the scope exact; do not broaden a
specific failure into a general reliability claim. One bullet per change, one
sentence per bullet, no trailing periods.
