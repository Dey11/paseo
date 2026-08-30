import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const repositoryRoot = new URL("../", import.meta.url);
const workflowPath = new URL(".github/workflows/hanabicode-release.yml", repositoryRoot);
const workflowSource = readFileSync(workflowPath, "utf8");
const workflow = parse(workflowSource);
const require = createRequire(import.meta.url);

test("HanabiCode releases run from dedicated tags and stay on the fork branch", () => {
  assert.deepEqual(workflow.on.push.tags, ["hanabicode-v*"]);
  assert.ok(workflow.on.workflow_dispatch);
  assert.equal(workflow.on.workflow_dispatch.inputs.tag.required, true);

  const validation = workflow.jobs.prepare.steps.find(
    (step) => step.name === "Validate tag and package versions",
  ).run;
  assert.match(validation, /\^hanabicode-v/);
  assert.match(validation, /merge-base --is-ancestor[\s\S]*origin\/hanabicode/);
  assert.doesNotMatch(validation, /origin\/main/);
});

test("the release is draft-first and publishes only after every requested artifact", () => {
  assert.deepEqual(workflow.jobs.publish.needs, [
    "prepare",
    "quality",
    "macos",
    "android",
    "daemon-linux",
  ]);
  assert.match(workflow.jobs.prepare.steps.at(-1).run, /--draft/);
  assert.match(workflow.jobs.publish.steps.at(-1).run, /--draft=false/);
  assert.equal(workflow.jobs.quality.needs, "prepare");
  assert.match(
    workflow.jobs.quality.steps.find((step) => step.name === "Run release quality gate").run,
    /npm run release:check/,
  );
});

test("the first release set is macOS, Android, and a native Linux ARM64 daemon", () => {
  assert.equal(workflow.jobs.windows, undefined);
  assert.deepEqual(workflow.jobs.macos.strategy.matrix.include, [
    { runner: "macos-15", arch: "arm64" },
    { runner: "macos-15-intel", arch: "x64" },
  ]);
  assert.match(
    workflow.jobs.macos.steps.find((step) => step.name === "Build ad-hoc signed desktop app").run,
    /-c\.mac\.identity=-[\s\S]*-c\.mac\.notarize=false/,
  );
  assert.match(
    workflow.jobs.android.steps.find((step) => step.name === "Build signed APK").run,
    /:app:assembleRelease/,
  );
  assert.match(
    workflow.jobs.android.steps.find((step) => step.name === "Verify APK signature and certificate")
      .run,
    /apksigner[\s\S]*ANDROID_CERT_SHA256/,
  );

  const daemonBuild = workflow.jobs["daemon-linux"].steps.find(
    (step) => step.name === "Build native daemon bundle",
  );
  assert.deepEqual(workflow.jobs["daemon-linux"].needs, ["prepare", "quality"]);
  assert.equal(workflow.jobs["daemon-linux"]["runs-on"], "ubuntu-22.04-arm");
  assert.match(daemonBuild.run, /npm run build:daemon:native/);
  assert.match(daemonBuild.run, /--source-commit "\$RELEASE_COMMIT"/);
  assert.match(
    workflow.jobs["daemon-linux"].steps.find((step) => step.name === "Test native daemon bundle")
      .run,
    /hanabicode-native-bundle\.test\.mjs/,
  );
  assert.doesNotMatch(workflowSource, /ghcr\.io|docker\/build-push-action|packages: write/);
});

test("the native daemon is self-contained and promotion remains manual", () => {
  const builder = readFileSync(
    new URL("scripts/build-hanabicode-native-bundle.mjs", repositoryRoot),
    "utf8",
  );
  const installer = readFileSync(
    new URL("scripts/install-hanabicode-native.sh", repositoryRoot),
    "utf8",
  );
  assert.match(builder, /process\.platform !== "linux" \|\| process\.arch !== "arm64"/);
  assert.match(builder, /copyFileSync\(process\.execPath, bundledNode\)/);
  assert.match(builder, /--allow-scripts=esbuild,node-pty/);
  assert.match(builder, /createRequire[\s\S]*node-pty/);
  assert.match(builder, /@getpaseo\/server/);
  assert.match(builder, /@getpaseo\/cli/);
  assert.match(installer, /systemctl --user enable hanabicode\.service/);
  assert.match(installer, /The running daemon was not restarted/);
  assert.doesNotMatch(installer, /^\s*systemctl --user (?:start|restart) hanabicode\.service/m);
  assert.doesNotMatch(installer, /docker/);
});

test("every renderer build records the exact release source commit", () => {
  for (const jobName of ["macos", "android"]) {
    assert.equal(
      workflow.jobs[jobName].env.EXPO_PUBLIC_HANABICODE_SOURCE_COMMIT,
      "${{ needs.prepare.outputs.commit }}",
    );
  }
});

test("release assets include notices and checksums", () => {
  const assembly = workflow.jobs.publish.steps.find(
    (step) => step.name === "Validate, assemble, and checksum assets",
  ).run;
  assert.match(assembly, /sha256sum/);
  assert.match(assembly, /cp LICENSE NOTICE/);
  assert.match(workflowSource, /android-actions\/setup-android@[0-9a-f]{40}/);
  assert.doesNotMatch(workflowSource, /android-actions\/setup-android@v/);
});

test("native application and updater identities stay isolated from Paseo", () => {
  const appConfig = readFileSync(new URL("packages/app/app.config.js", repositoryRoot), "utf8");
  assert.match(appConfig, /packageId: "com\.dey\.hanabicode"/);
  assert.match(appConfig, /packageId: "com\.dey\.hanabicode\.debug"/);
  assert.match(appConfig, /slug: "hanabicode"/);
  assert.match(appConfig, /scheme: "hanabicode"/);

  const desktopConfig = parse(
    readFileSync(new URL("packages/desktop/electron-builder.yml", repositoryRoot), "utf8"),
  );
  assert.equal(desktopConfig.appId, "com.dey.hanabicode");
  assert.equal(desktopConfig.productName, "HanabiCode");
  assert.deepEqual(desktopConfig.publish, {
    provider: "github",
    owner: "Dey11",
    repo: "paseo",
  });
  assert.equal(desktopConfig.mac.identity, "-");
  assert.equal(desktopConfig.mac.notarize, false);
});

test("Android release prebuild replaces debug signing with injected release properties", () => {
  const { configureAndroidReleaseSigning } = require(
    fileURLToPath(new URL("packages/app/plugins/with-android-release-signing.js", repositoryRoot)),
  );
  const generatedGradle = `
android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.debug
        }
    }
}
`;
  const configured = configureAndroidReleaseSigning(generatedGradle);
  assert.match(configured, /HANABICODE_UPLOAD_STORE_FILE/);
  assert.match(configured, /release \{[\s\S]*storeFile file\(hanabicodeReleaseStoreFile\)/);
  assert.match(configured, /buildTypes \{[\s\S]*signingConfig signingConfigs\.release/);
  assert.doesNotMatch(
    configured.match(/buildTypes \{[\s\S]*$/)?.[0] ?? "",
    /signingConfig signingConfigs\.debug/,
  );
});

test("legacy and official release publishers stay retired", () => {
  for (const path of [
    ".github/workflows/android-apk-release.yml",
    ".github/workflows/deploy-relay.yml",
    ".github/workflows/deploy-app.yml",
    ".github/workflows/deploy-website.yml",
    ".github/workflows/desktop-release.yml",
    ".github/workflows/desktop-rollout.yml",
    ".github/workflows/docker.yml",
    ".github/workflows/nix-update-hash.yml",
    "packages/app/eas.json",
    "packages/app/.eas/workflows/release-ios-beta.yml",
    "packages/app/.eas/workflows/release-mobile.yml",
    "packages/app/.eas/workflows/resubmit-ios-review.yml",
  ]) {
    assert.equal(existsSync(new URL(path, repositoryRoot)), false, `${path} must remain retired`);
  }

  assert.doesNotMatch(workflowSource, /getpaseo\/paseo|ghcr\.io\/getpaseo/);
  const packageJson = JSON.parse(readFileSync(new URL("package.json", repositoryRoot), "utf8"));
  assert.equal(packageJson.scripts["release:publish"], undefined);
  assert.equal(packageJson.scripts["release:push"], undefined);
});
