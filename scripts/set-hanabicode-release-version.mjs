import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeNextReleaseVersion } from "./release-version-utils.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");

function printUsage(code = 1) {
  process.stderr.write(
    "Usage: node scripts/set-hanabicode-release-version.mjs --mode <mode> [--print]\n",
  );
  process.stderr.write(
    "Modes: patch, minor, major, beta-patch, beta-minor, beta-major, beta-next, promote\n",
  );
  process.exit(code);
}

function parseArguments(argv) {
  const arguments_ = { mode: "", print: false };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--mode") {
      arguments_.mode = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (argument === "--print") {
      arguments_.print = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      printUsage(0);
    }
    printUsage();
  }

  if (!arguments_.mode) {
    printUsage();
  }
  return arguments_;
}

const arguments_ = parseArguments(process.argv.slice(2));
const packageJson = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
const currentVersion = typeof packageJson.version === "string" ? packageJson.version.trim() : "";

if (!currentVersion) {
  throw new Error('Root package.json must contain a valid "version".');
}

const nextVersion = computeNextReleaseVersion(currentVersion, arguments_.mode);
if (arguments_.print) {
  process.stdout.write(`${nextVersion}\n`);
  process.exit(0);
}

execFileSync(
  "npm",
  [
    "version",
    nextVersion,
    "--include-workspace-root",
    "--tag-version-prefix=hanabicode-v",
    "--message",
    "chore(release): cut HanabiCode %s",
  ],
  { cwd: repositoryRoot, stdio: "inherit" },
);
