import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const archiveArgument = process.argv[2];
if (!archiveArgument) {
  throw new Error("Usage: node scripts/hanabicode-native-bundle.test.mjs <archive.tar.gz>");
}

const archivePath = path.resolve(archiveArgument);
assert.ok(existsSync(archivePath), `Archive does not exist: ${archivePath}`);

function run(command, arguments_, options = {}) {
  return execFileSync(command, arguments_, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

const testRoot = mkdtempSync(path.join(tmpdir(), "hanabicode-native-acceptance-"));
try {
  const extractRoot = path.join(testRoot, "extract");
  const testHome = path.join(testRoot, "home");
  const workingDirectory = path.join(testHome, "projects");
  const mockBin = path.join(testRoot, "mock-bin");
  const systemctlLog = path.join(testRoot, "systemctl.log");
  mkdirSync(extractRoot, { recursive: true });
  mkdirSync(workingDirectory, { recursive: true });
  mkdirSync(mockBin, { recursive: true });
  run("tar", ["-xzf", archivePath, "-C", extractRoot]);

  const entries = readdirSync(extractRoot, { withFileTypes: true }).filter((entry) =>
    entry.isDirectory(),
  );
  assert.equal(entries.length, 1, "Archive must contain exactly one top-level directory.");
  const bundleRoot = path.join(extractRoot, entries[0].name);
  const cli = path.join(bundleRoot, "bin", "hanabicode");
  const bundledNode = path.join(bundleRoot, "runtime", "bin", "node");
  assert.match(run(cli, ["--version"]), /^\d+\.\d+\.\d+/);

  const serverPackage = path.join(
    bundleRoot,
    "app",
    "lib",
    "node_modules",
    "@getpaseo",
    "server",
    "package.json",
  );
  run(bundledNode, [
    "-e",
    'const {createRequire}=require("node:module"); createRequire(process.argv[1])("node-pty");',
    serverPackage,
  ]);

  const mockSystemctl = path.join(mockBin, "systemctl");
  writeFileSync(
    mockSystemctl,
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$SYSTEMCTL_LOG"\ncase "$*" in *"is-active"*) exit 3 ;; esac\n',
  );
  chmodSync(mockSystemctl, 0o755);

  const environment = {
    ...process.env,
    HOME: testHome,
    PATH: `${mockBin}:/usr/bin:/bin`,
    SYSTEMCTL_LOG: systemctlLog,
  };
  const installerOutput = run(
    path.join(bundleRoot, "install.sh"),
    ["--listen", "100.64.0.1:6769", "--working-directory", workingDirectory],
    { env: environment },
  );
  assert.match(installerOutput, /Set the daemon password before the first start/);
  assert.match(installerOutput, /systemctl --user start hanabicode\.service/);

  const installRoot = path.join(testHome, ".local", "share", "hanabicode");
  const currentLink = path.join(installRoot, "current");
  assert.equal(lstatSync(currentLink).isSymbolicLink(), true);
  assert.match(readlinkSync(currentLink), /^releases\//);
  const installedCli = path.join(testHome, ".local", "bin", "hanabicode");
  assert.match(run(installedCli, ["--version"], { env: environment }), /^\d+\.\d+\.\d+/);

  const servicePath = path.join(testHome, ".config", "systemd", "user", "hanabicode.service");
  const service = readFileSync(servicePath, "utf8");
  assert.match(service, /--listen 100\.64\.0\.1:6769/);
  assert.match(service, /--home .+\/\.hanabicode/);
  assert.match(service, /--no-relay --web-ui/);
  assert.match(service, /WorkingDirectory=.+\/projects/);
  run("systemd-analyze", ["--user", "verify", servicePath], { env: environment });

  const systemctlCalls = readFileSync(systemctlLog, "utf8");
  assert.match(systemctlCalls, /--user daemon-reload/);
  assert.match(systemctlCalls, /--user enable hanabicode\.service/);
  assert.match(systemctlCalls, /--user is-active --quiet hanabicode\.service/);
  assert.doesNotMatch(systemctlCalls, /--user (?:start|restart)/);

  process.stdout.write(`Native bundle acceptance passed: ${archivePath}\n`);
} finally {
  rmSync(testRoot, { force: true, recursive: true });
}
