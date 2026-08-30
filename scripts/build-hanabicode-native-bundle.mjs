import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const releasePackages = [
  "@getpaseo/highlight",
  "@getpaseo/relay",
  "@getpaseo/protocol",
  "@getpaseo/client",
  "@getpaseo/plugin",
  "@getpaseo/server",
  "@getpaseo/cli",
];

function usage(exitCode = 1) {
  process.stderr.write(
    "Usage: node scripts/build-hanabicode-native-bundle.mjs --output-dir <path> [--version <version>] [--source-commit <sha>]\n",
  );
  process.exit(exitCode);
}

function parseArguments(argv) {
  const values = { outputDirectory: "", sourceCommit: "", version: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--output-dir") {
      values.outputDirectory = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (argument === "--source-commit") {
      values.sourceCommit = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (argument === "--version") {
      values.version = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (argument === "--help" || argument === "-h") usage(0);
    usage();
  }
  if (!values.outputDirectory) usage();
  return values;
}

function run(command, arguments_, options = {}) {
  execFileSync(command, arguments_, {
    cwd: repositoryRoot,
    env: { ...process.env, ONNXRUNTIME_NODE_INSTALL: "skip" },
    stdio: "inherit",
    ...options,
  });
}

function output(command, arguments_) {
  return execFileSync(command, arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
}

function resolveNodeLicense() {
  const nodeRoot = path.dirname(path.dirname(process.execPath));
  const candidates = [path.join(nodeRoot, "LICENSE"), path.join(nodeRoot, "LICENSE.md")];
  const license = candidates.find((candidate) => existsSync(candidate));
  if (!license) {
    throw new Error(`The Node distribution at ${nodeRoot} does not contain a license file.`);
  }
  return license;
}

function validateReleaseVersion(version) {
  if (!/^\d+\.\d+\.\d+(?:-beta\.[1-9]\d*)?$/.test(version)) {
    throw new Error(`Unsupported HanabiCode release version: ${version}`);
  }
}

const arguments_ = parseArguments(process.argv.slice(2));
if (process.platform !== "linux" || process.arch !== "arm64") {
  throw new Error(
    `Native HanabiCode bundles currently require Linux ARM64; received ${process.platform}/${process.arch}.`,
  );
}

const rootPackage = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
const version = arguments_.version || rootPackage.version;
validateReleaseVersion(version);
if (version !== rootPackage.version) {
  throw new Error(`Requested ${version}, but package.json contains ${rootPackage.version}.`);
}

const temporaryRoot = mkdtempSync(path.join(tmpdir(), "hanabicode-native-bundle-"));
try {
  const packsDirectory = path.join(temporaryRoot, "packs");
  const stageParent = path.join(temporaryRoot, "stage");
  const bundleName = `HanabiCode-${version}-linux-arm64`;
  const bundleRoot = path.join(stageParent, bundleName);
  const applicationPrefix = path.join(bundleRoot, "app");
  const runtimeBin = path.join(bundleRoot, "runtime", "bin");
  mkdirSync(packsDirectory, { recursive: true });
  mkdirSync(runtimeBin, { recursive: true });

  for (const packageName of releasePackages) {
    run("npm", ["pack", `--workspace=${packageName}`, "--pack-destination", packsDirectory]);
  }

  const tarballs = readdirSync(packsDirectory)
    .filter((filename) => filename.endsWith(".tgz"))
    .map((filename) => path.join(packsDirectory, filename));
  if (tarballs.length !== releasePackages.length) {
    throw new Error(
      `Expected ${releasePackages.length} package tarballs, found ${tarballs.length}.`,
    );
  }

  const npmMajor = Number.parseInt(output("npm", ["--version"]).split(".")[0] ?? "", 10);
  if (!Number.isInteger(npmMajor)) throw new Error("Could not determine the npm major version.");
  const npmScriptPermission = npmMajor >= 11 ? ["--allow-scripts=esbuild,node-pty"] : [];
  run("npm", [
    "install",
    "--global",
    "--prefix",
    applicationPrefix,
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    ...npmScriptPermission,
    ...tarballs,
  ]);

  const bundledNode = path.join(runtimeBin, "node");
  copyFileSync(process.execPath, bundledNode);
  chmodSync(bundledNode, 0o755);
  copyFileSync(resolveNodeLicense(), path.join(bundleRoot, "NODE-LICENSE"));
  copyFileSync(path.join(repositoryRoot, "LICENSE"), path.join(bundleRoot, "LICENSE"));
  copyFileSync(path.join(repositoryRoot, "NOTICE"), path.join(bundleRoot, "NOTICE"));
  copyFileSync(
    path.join(repositoryRoot, "scripts", "install-hanabicode-native.sh"),
    path.join(bundleRoot, "install.sh"),
  );
  chmodSync(path.join(bundleRoot, "install.sh"), 0o755);

  const binDirectory = path.join(bundleRoot, "bin");
  mkdirSync(binDirectory, { recursive: true });
  const wrapperPath = path.join(binDirectory, "hanabicode");
  writeFileSync(
    wrapperPath,
    `#!/bin/sh\nset -eu\nSCRIPT_PATH=$(readlink -f -- "$0")\nBUNDLE_ROOT=$(CDPATH= cd -- "$(dirname -- "$SCRIPT_PATH")/.." && pwd)\nexport PATH="$BUNDLE_ROOT/runtime/bin:$PATH"\nexec "$BUNDLE_ROOT/runtime/bin/node" "$BUNDLE_ROOT/app/lib/node_modules/@getpaseo/cli/bin/hanabicode" "$@"\n`,
  );
  chmodSync(wrapperPath, 0o755);

  const metadata = {
    product: "HanabiCode",
    version,
    platform: "linux",
    architecture: "arm64",
    nodeVersion: process.version,
    sourceCommit: arguments_.sourceCommit || null,
  };
  writeFileSync(path.join(bundleRoot, "release.json"), `${JSON.stringify(metadata, null, 2)}\n`);

  const serverRoot = path.join(applicationPrefix, "lib", "node_modules", "@getpaseo", "server");
  const serverEntry = path.join(serverRoot, "dist", "scripts", "supervisor-entrypoint.js");
  if (!existsSync(serverEntry))
    throw new Error(`Missing packaged daemon entrypoint: ${serverEntry}`);

  run(wrapperPath, ["--version"], { cwd: bundleRoot });
  run(bundledNode, ["--check", serverEntry], { cwd: bundleRoot });
  run(
    bundledNode,
    [
      "-e",
      'const {createRequire}=require("node:module"); const path=require("node:path"); const root=process.argv[1]; createRequire(path.join(root,"package.json"))("node-pty");',
      serverRoot,
    ],
    { cwd: bundleRoot },
  );

  const outputDirectory = path.resolve(arguments_.outputDirectory);
  mkdirSync(outputDirectory, { recursive: true });
  const archivePath = path.join(outputDirectory, `${bundleName}.tar.gz`);
  rmSync(archivePath, { force: true });
  run("tar", ["-C", stageParent, "-czf", archivePath, bundleName]);
  run("tar", ["-tzf", archivePath], { stdio: "ignore" });
  process.stdout.write(`${archivePath}\n`);
} finally {
  rmSync(temporaryRoot, { force: true, recursive: true });
}
