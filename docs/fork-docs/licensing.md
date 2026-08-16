# HanabiCode licensing

HanabiCode is a modified fork of Paseo licensed under the GNU Affero General Public License v3 or later. GitHub-built installers, hosted use, and sharing with friends can comply. Compliance depends on shipping source and notices with the shared fork; friendship and noncommercial use do not create an exemption.

Treat this as practical project guidance. The repository's [LICENSE](../../LICENSE) is the controlling text; consult a lawyer when a commercial or private-distribution model needs a legal opinion.

## When obligations apply

| Use                                       | Fork obligation                                                                                       |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| You modify and run the fork only yourself | You do not have to publish a private modification merely because you made it                          |
| A friend downloads an APK, DMG, or EXE    | Give that recipient access to the complete corresponding source under the AGPL                        |
| A friend uses your modified VPS daemon    | Prominently offer that network user the corresponding source of the running modified version          |
| You publish a GitHub Release              | Put a clear source link beside the installers and keep that source available                          |
| You charge for a build or support         | The AGPL permits charging, but recipients retain the AGPL rights to source, modification, and sharing |

Sharing a binary with one friend is still conveying a copy. Running a modified daemon for a friend is remote network interaction even when no daemon binary is sent to them.

## Release requirements

Every shared release must:

1. Keep the upstream copyright and license notices.
2. State that this is a modified downstream fork and identify the release date or version.
3. License the covered fork as a whole under AGPLv3.
4. Provide the complete corresponding source for the exact installers, not only a patch against upstream.
5. Put clear source directions next to the downloadable installers.
6. Keep third-party license notices for bundled dependencies.
7. Avoid claiming that the release is produced, supported, or endorsed by upstream.

For this fork, the easiest implementation is a public source repository and one source tag per binary release. Each GitHub Release should link to:

- the exact source tag or commit;
- the source archive for that tag;
- `LICENSE`;
- build instructions and the workflow that produced the assets.

GitHub's automatically generated source archives are useful only when the tag points to the complete buildable source. Keep the lockfile, Expo config plugins, native generation scripts, release workflows, patches, and installation instructions in that source tag.

Do not publish passwords, provider tokens, signing private keys, Apple certificates, Firebase secrets, or VPS configuration secrets. A recipient can sign their own modified build with their own identity. Keep enough non-secret configuration and instructions for them to build and install it.

## Network source offer

AGPL section 13 requires a modified program that supports remote network interaction to offer its corresponding source prominently to network users. Before friends use the fork, add a fork-specific item to the app's About or Legal screen with:

- “Source code” linked to the fork repository or the exact release source;
- “License” linked to the included AGPL text;
- a clear “Modified fork of Paseo” notice;
- the client version and connected daemon version, so a user can identify the source that applies.

The shared About screen shows the modified-fork notice, exact build source when a release commit is embedded, license, client version, and connected daemon versions. Keep that source offer prominent when the screen changes.

If a browser-accessible daemon UI is shared independently of the installed app, put the same source offer in that interface. A link buried only in GitHub release notes does not reach a network user who never downloaded an installer.

## Editing the license

You may modify, redistribute, host, and charge for HanabiCode. You may add copyright notices for your own changes in `NOTICE` or source headers. Do not edit the GNU license text in `LICENSE`, remove upstream notices, or add terms that deny recipients their AGPL rights.

Renaming the executable or repository does not make the combined fork proprietary. Code that you write as a genuinely separate program can use another license, but a process boundary is not automatically a copyright boundary. Get legal advice before relying on a split architecture to change the licensing result.

Existing permissions cannot be withdrawn from copies already released. Upstream or HanabiCode can sell AGPL builds and services. A copyright owner can offer code they solely own under another license, but cannot unilaterally relicense other contributors' AGPL-only work.

## Relay

The separate `getpaseo/paseo-relay` repository is Apache-2.0. A HanabiCode fork of that service must keep the Apache license and notices, mark modified files, and avoid upstream branding. Its license does not change the AGPL obligations for the HanabiCode client and daemon.

The `packages/relay` workspace in this monorepo remains part of the AGPL-covered combined source. Do not confuse it with the separate Apache relay service.

## Branding

The AGPL grants copyright permissions; it does not grant trademark rights. Use a distinct fork name, application IDs, icons, updater repository, and publisher identity before sharing installers. It is fine to describe the product as a fork of Paseo and retain required attribution. Do not make the installer appear to be an official Paseo release.

## Provider accounts and subscriptions

Codex, Claude Code, GitHub, Expo, Apple, Google, Tailscale, and the hosted relay have terms separate from the AGPL. The source license does not transfer upstream service accounts or relax provider subscription limits.

The fork can continue to launch Codex and Claude Code on the VPS using the provider CLIs and accounts already authenticated there. That authentication does not require embedding provider credentials in an installer or publishing them as source.

## Pre-release compliance check

Before giving a build to anyone else, confirm:

- the source tag matches the built commit;
- the release page links source and license beside the installers;
- the repository contains everything needed to reproduce the build except ordinary toolchains and secrets;
- the app exposes the fork source/license notice to installed and remote users;
- upstream copyright and third-party notices remain intact;
- the fork is visibly distinct from an official release;
- no credential or signing key is present in the repository or source archive.

See the [GNU licensing FAQ](https://www.gnu.org/licenses/gpl-faq.en.html) for the Free Software Foundation's general explanation of private changes, binary distribution, and source availability.
