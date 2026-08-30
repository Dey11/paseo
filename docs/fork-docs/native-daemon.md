# Native VPS daemon

GitHub Releases publish `HanabiCode-X.Y.Z-linux-arm64.tar.gz` for the VPS. The archive targets Ubuntu 22.04 ARM64 and includes the exact Node runtime used to build it. The VPS does not need Node, npm, or Docker to install or run the release.

The bundle contains the CLI, daemon, browser web UI, production dependencies, Node license, project license, source metadata, and a rootless installer. Provider CLIs are not bundled. HanabiCode finds Codex, Claude Code, OpenCode, and other providers from the service `PATH` and uses the accounts already authenticated on the VPS.

## Install

Download the archive and `SHA256SUMS` from the same GitHub Release, then verify it:

```bash
sha256sum --check SHA256SUMS --ignore-missing
tar -xzf HanabiCode-0.1.0-linux-arm64.tar.gz
cd HanabiCode-0.1.0-linux-arm64
./install.sh \
  --listen 100.101.102.103:6769 \
  --working-directory /home/dev/projects
```

Replace the sample address with `tailscale ip -4` from the VPS. The installer:

- copies the release to `~/.local/share/hanabicode/releases/<version>`;
- atomically selects it through `~/.local/share/hanabicode/current`;
- links `~/.local/bin/hanabicode`;
- writes and enables `~/.config/systemd/user/hanabicode.service`;
- keeps daemon state under `~/.hanabicode`;
- does not start or restart the service.

Set the password before the first start, then promote the installed release manually:

```bash
~/.local/bin/hanabicode daemon set-password --home ~/.hanabicode
systemctl --user start hanabicode.service
```

Check the service and logs:

```bash
systemctl --user status hanabicode.service
journalctl --user -u hanabicode.service -f
~/.local/bin/hanabicode daemon status --home ~/.hanabicode
```

Add `100.101.102.103:6769` as a direct host in the macOS and Android clients with SSL off. Tailscale encrypts that path. Use the daemon password as a separate access control.

## Upgrade

Run the new archive's installer with the same `--listen` and `--working-directory` values. It changes the `current` symlink but leaves the running process alone. Review the selected version, then restart during the chosen maintenance window:

```bash
readlink ~/.local/share/hanabicode/current
~/.local/bin/hanabicode --version
systemctl --user restart hanabicode.service
```

The restart is the promotion boundary. Existing agents may be interrupted, so inspect or finish active work first.

The user service must be allowed to run after logout. Check it with `loginctl show-user "$USER" -p Linger`. This VPS already has lingering enabled; a new host may require its administrator to run `loginctl enable-linger <user>` once.

## Roll back

List installed releases and select the previous directory before restarting:

```bash
ls -1 ~/.local/share/hanabicode/releases
ln -s "releases/0.1.0" ~/.local/share/hanabicode/.rollback-new
mv -Tf ~/.local/share/hanabicode/.rollback-new ~/.local/share/hanabicode/current
systemctl --user restart hanabicode.service
```

Replace `0.1.0` with the known-good version. The state directory is not rolled back. A release that changes persisted data needs its own compatibility review before promotion.

## Build from source

The normal release is built on GitHub's Ubuntu 22.04 ARM64 runner. A source checkout on the VPS is needed only for development or for reproducing the artifact:

```bash
npm ci
npm run build:daemon:native -- --output-dir ./release-daemon
```

Do not publish the internal `@getpaseo/*` workspaces to npm. The native builder packs them locally into the release archive.
