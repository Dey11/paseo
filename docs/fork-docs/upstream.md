# Fork upstream policy

Keep official Paseo available as a source of updates without making upstream compatibility the product goal.

## Remotes and branches

Use `origin` for Dey's fork and `upstream` for `getpaseo/paseo`:

```bash
git remote add upstream https://github.com/getpaseo/paseo.git
git fetch upstream
```

Keep `main` as an unmodified mirror when practical. Carry HanabiCode product changes on the long-lived `hanabicode` branch and use short feature branches for coherent work.

Update without rewriting shared history:

```bash
git fetch upstream
git switch main
git merge --ff-only upstream/main
git push origin main

git switch hanabicode
git merge main
git push origin hanabicode
```

Rebase the HanabiCode patch stack only when the branch is private and the history rewrite is intentional. Use `--force-with-lease`, never an unqualified force push.

## Conflict policy

Update frequently while the fork is a small patch stack. Resolve conflicts in favor of the personal workflow when upstream behavior caused the fork, then verify the surrounding upstream changes rather than restoring an old file wholesale.

Keep commits focused and avoid broad formatting. Submit generally useful bug fixes upstream when that removes a permanent private patch, but do not shape personal features around likely upstream acceptance.

## Divergence levels

Treat divergence as a deliberate transition:

1. **Patch stack:** merge upstream regularly and keep personal changes narrow.
2. **Downstream product:** merge selected upstream releases and accept recurring integration work.
3. **Independent product:** stop broad merges and cherry-pick security, provider, platform, and dependency fixes.

Record the transition when regular upstream merges stop. Continue reviewing upstream security advisories and compatibility work even after independent product architecture takes priority.

## Compatibility that remains required

The macOS client, Android client, and VPS daemon update at different times. Preserve the protocol contract between personal versions:

- old clients parse messages from new daemons;
- new clients parse messages from old daemons;
- new capabilities are gated once;
- wire fields remain optional and non-narrowing;
- installed-client upgrade paths are tested.

Abandoning upstream merges does not remove version skew inside the personal deployment.

## CI

Use pull requests targeting `hanabicode` for ordinary fork work. Fork CI includes `hanabicode` in its branch filters; `main` stays available for clean upstream fast-forwards.

Disable or replace workflows that require upstream deployment secrets or write access. Keep verification workflows that build and test without publishing.
