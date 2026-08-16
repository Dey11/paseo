import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

const repoRoot = new URL("../", import.meta.url);
const releaseWorkflowPath = new URL(".github/workflows/hanabicode-release.yml", repoRoot);
const releaseWorkflowSource = readFileSync(releaseWorkflowPath, "utf8");
const releaseWorkflow = parse(releaseWorkflowSource);

test("HanabiCode release is a manual, draft-first, all-platform workflow", () => {
  assert.deepEqual(Object.keys(releaseWorkflow.on), ["workflow_dispatch"]);
  assert.deepEqual(releaseWorkflow.jobs.publish.needs, [
    "prepare",
    "quality",
    "macos",
    "windows",
    "android",
  ]);
  assert.equal(releaseWorkflow.jobs.quality.needs, "prepare");
  assert.match(
    releaseWorkflow.jobs.quality.steps.find((step) => step.name === "Run release quality gate").run,
    /npm run release:check/,
  );
  assert.match(releaseWorkflow.jobs.prepare.steps.at(-1).run, /--draft/);
  assert.match(releaseWorkflow.jobs.publish.steps.at(-1).run, /--draft=false/);
  assert.match(
    releaseWorkflow.jobs.prepare.steps.find(
      (step) => step.name === "Validate tag and package versions",
    ).run,
    /merge-base --is-ancestor[\s\S]*origin\/main/,
  );

  assert.deepEqual(releaseWorkflow.jobs.macos.strategy.matrix.include, [
    { runner: "macos-15", arch: "arm64" },
    { runner: "macos-15-intel", arch: "x64" },
  ]);
  assert.match(
    releaseWorkflow.jobs.windows.steps.find((step) => step.name === "Build unsigned desktop app")
      .run,
    /--x64[\s\S]*--arm64/,
  );
  assert.match(
    releaseWorkflow.jobs.android.steps.find((step) => step.name === "Build signed APK").run,
    /:app:assembleRelease/,
  );
  assert.match(
    releaseWorkflow.jobs.android.steps.find(
      (step) => step.name === "Verify APK signature and certificate",
    ).run,
    /apksigner[\s\S]*ANDROID_CERT_SHA256/,
  );
  assert.match(
    releaseWorkflow.jobs.publish.steps.find(
      (step) => step.name === "Validate, assemble, and checksum assets",
    ).run,
    /sha256sum/,
  );
  assert.match(
    releaseWorkflow.jobs.publish.steps.find(
      (step) => step.name === "Validate, assemble, and checksum assets",
    ).run,
    /cp LICENSE NOTICE/,
  );
  assert.match(releaseWorkflowSource, /android-actions\/setup-android@[0-9a-f]{40}/);
  assert.doesNotMatch(releaseWorkflowSource, /android-actions\/setup-android@v/);
});

test("every renderer build records the exact release source commit", () => {
  for (const jobName of ["macos", "windows", "android"]) {
    assert.equal(
      releaseWorkflow.jobs[jobName].env.EXPO_PUBLIC_HANABICODE_SOURCE_COMMIT,
      "${{ needs.prepare.outputs.commit }}",
    );
  }
});

test("legacy release publishers stay retired", () => {
  for (const path of [
    ".github/workflows/android-apk-release.yml",
    ".github/workflows/deploy-relay.yml",
    ".github/workflows/deploy-app.yml",
    ".github/workflows/deploy-website.yml",
    ".github/workflows/desktop-release.yml",
    ".github/workflows/desktop-rollout.yml",
    ".github/workflows/nix-update-hash.yml",
    "packages/app/eas.json",
    "packages/app/.eas/workflows/release-ios-beta.yml",
    "packages/app/.eas/workflows/release-mobile.yml",
    "packages/app/.eas/workflows/resubmit-ios-review.yml",
  ]) {
    assert.equal(existsSync(new URL(path, repoRoot)), false, `${path} must remain retired`);
  }
});

test("release targets the current fork instead of official publication endpoints", () => {
  assert.match(releaseWorkflowSource, /GITHUB_REPOSITORY|github\.repository/);
  assert.doesNotMatch(releaseWorkflowSource, /getpaseo\/paseo|ghcr\.io\/getpaseo/);

  const dockerWorkflow = readFileSync(new URL(".github/workflows/docker.yml", repoRoot), "utf8");
  assert.match(dockerWorkflow, /github\.event\.repository\.name/);
  assert.doesNotMatch(dockerWorkflow, /ghcr\.io\/getpaseo/);

  const appPackage = JSON.parse(
    readFileSync(new URL("packages/app/package.json", repoRoot), "utf8"),
  );
  assert.equal(appPackage.scripts["deploy:web"], undefined);
});
