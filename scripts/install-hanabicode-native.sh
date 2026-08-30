#!/bin/sh
set -eu

print_usage() {
  cat <<'EOF'
Usage: ./install.sh [options]

Options:
  --install-root PATH       Release root (default: ~/.local/share/hanabicode)
  --home PATH               Daemon state directory (default: ~/.hanabicode)
  --listen HOST:PORT        Install/update the systemd user service for this address
  --working-directory PATH  Service working directory (default: ~/projects)
  --no-service              Install binaries without changing the user service
  -h, --help                Show this help

The installer switches the `current` symlink but never starts or restarts the daemon.
EOF
}

BUNDLE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INSTALL_ROOT=${HANABICODE_INSTALL_ROOT:-"$HOME/.local/share/hanabicode"}
HANABICODE_HOME=${HANABICODE_HOME:-"$HOME/.hanabicode"}
LISTEN_ADDRESS=""
WORKING_DIRECTORY=${HANABICODE_WORKING_DIRECTORY:-"$HOME/projects"}
INSTALL_SERVICE=true

while [ "$#" -gt 0 ]; do
  case "$1" in
    --install-root)
      [ "$#" -ge 2 ] || { print_usage >&2; exit 1; }
      INSTALL_ROOT=$2
      shift 2
      ;;
    --home)
      [ "$#" -ge 2 ] || { print_usage >&2; exit 1; }
      HANABICODE_HOME=$2
      shift 2
      ;;
    --listen)
      [ "$#" -ge 2 ] || { print_usage >&2; exit 1; }
      LISTEN_ADDRESS=$2
      shift 2
      ;;
    --working-directory)
      [ "$#" -ge 2 ] || { print_usage >&2; exit 1; }
      WORKING_DIRECTORY=$2
      shift 2
      ;;
    --no-service)
      INSTALL_SERVICE=false
      shift
      ;;
    -h|--help)
      print_usage
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      print_usage >&2
      exit 1
      ;;
  esac
done

if [ "$INSTALL_SERVICE" = true ] && [ -z "$LISTEN_ADDRESS" ]; then
  echo "--listen is required unless --no-service is used." >&2
  exit 1
fi

RUNTIME_NODE="$BUNDLE_ROOT/runtime/bin/node"
[ -x "$RUNTIME_NODE" ] || { echo "Bundled Node runtime is missing." >&2; exit 1; }
[ "$(uname -s)" = "Linux" ] || { echo "This bundle requires Linux." >&2; exit 1; }
case "$(uname -m)" in
  aarch64|arm64) ;;
  *) echo "This bundle requires Linux ARM64." >&2; exit 1 ;;
esac

if [ "$INSTALL_SERVICE" = true ]; then
  INSTALL_ROOT="$INSTALL_ROOT" \
  HANABICODE_HOME="$HANABICODE_HOME" \
  LISTEN_ADDRESS="$LISTEN_ADDRESS" \
  WORKING_DIRECTORY="$WORKING_DIRECTORY" \
  "$RUNTIME_NODE" <<'NODE'
const values = {
  HOME: process.env.HOME,
  INSTALL_ROOT: process.env.INSTALL_ROOT,
  HANABICODE_HOME: process.env.HANABICODE_HOME,
  LISTEN_ADDRESS: process.env.LISTEN_ADDRESS,
  WORKING_DIRECTORY: process.env.WORKING_DIRECTORY,
};
for (const [name, value] of Object.entries(values)) {
  if (!value || /[\s"'\\%$]/.test(value)) {
    throw new Error(`${name} contains characters unsupported by the systemd user service.`);
  }
}
NODE
fi

VERSION=$(
  "$RUNTIME_NODE" -e \
    'const value=require(process.argv[1]); if (!value.version) process.exit(1); process.stdout.write(value.version)' \
    "$BUNDLE_ROOT/release.json"
)
[ -n "$VERSION" ] || { echo "release.json does not contain a version." >&2; exit 1; }

RELEASES_DIRECTORY="$INSTALL_ROOT/releases"
RELEASE_DIRECTORY="$RELEASES_DIRECTORY/$VERSION"
mkdir -p "$RELEASES_DIRECTORY" "$HOME/.local/bin" "$HANABICODE_HOME"
chmod 700 "$HANABICODE_HOME"

if [ ! -d "$RELEASE_DIRECTORY" ]; then
  TEMPORARY_RELEASE=$(mktemp -d "$RELEASES_DIRECTORY/.${VERSION}.XXXXXX")
  cleanup() {
    rm -rf "$TEMPORARY_RELEASE"
  }
  trap cleanup EXIT HUP INT TERM
  cp -a "$BUNDLE_ROOT/." "$TEMPORARY_RELEASE/"
  mv "$TEMPORARY_RELEASE" "$RELEASE_DIRECTORY"
  trap - EXIT HUP INT TERM
fi

NEXT_LINK="$INSTALL_ROOT/.current.$$.new"
rm -f "$NEXT_LINK"
ln -s "releases/$VERSION" "$NEXT_LINK"
mv -Tf "$NEXT_LINK" "$INSTALL_ROOT/current"
ln -sfn "$INSTALL_ROOT/current/bin/hanabicode" "$HOME/.local/bin/hanabicode"

if [ "$INSTALL_SERVICE" = true ]; then
  SERVICE_DIRECTORY="$HOME/.config/systemd/user"
  SERVICE_PATH="$SERVICE_DIRECTORY/hanabicode.service"
  mkdir -p "$SERVICE_DIRECTORY"
  INSTALL_ROOT="$INSTALL_ROOT" \
  HANABICODE_HOME="$HANABICODE_HOME" \
  LISTEN_ADDRESS="$LISTEN_ADDRESS" \
  WORKING_DIRECTORY="$WORKING_DIRECTORY" \
  SERVICE_PATH="$SERVICE_PATH" \
  "$RUNTIME_NODE" <<'NODE'
const fs = require("node:fs");
const home = process.env.HOME;
const installRoot = process.env.INSTALL_ROOT;
const daemonHome = process.env.HANABICODE_HOME;
const listenAddress = process.env.LISTEN_ADDRESS;
const workingDirectory = process.env.WORKING_DIRECTORY;
const pathValue = [
  `${home}/.local/bin`,
  `${home}/.bun/bin`,
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
].join(":");
const unit = `[Unit]
Description=HanabiCode coding agent daemon
Documentation=https://github.com/Dey11/paseo/tree/hanabicode
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=HOME=${home}
Environment=PATH=${pathValue}
WorkingDirectory=${workingDirectory}
ExecStart=${installRoot}/current/bin/hanabicode daemon start --foreground --listen ${listenAddress} --home ${daemonHome} --no-relay --web-ui
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
RestrictSUIDSGID=true
LockPersonality=true
LimitNOFILE=65536
UMask=0077

[Install]
WantedBy=default.target
`;
fs.writeFileSync(process.env.SERVICE_PATH, unit, { mode: 0o600 });
NODE
  systemctl --user daemon-reload
  systemctl --user enable hanabicode.service >/dev/null
fi

printf 'Installed HanabiCode %s at %s\n' "$VERSION" "$RELEASE_DIRECTORY"
printf 'Selected release: %s/current\n' "$INSTALL_ROOT"
if [ "$INSTALL_SERVICE" = true ]; then
  if systemctl --user is-active --quiet hanabicode.service; then
    echo "The running daemon was not restarted. Promote this release when ready:"
    echo "  systemctl --user restart hanabicode.service"
  else
    echo "Set the daemon password before the first start:"
    echo "  $HOME/.local/bin/hanabicode daemon set-password --home $HANABICODE_HOME"
    echo "Then start the service:"
    echo "  systemctl --user start hanabicode.service"
  fi
fi
