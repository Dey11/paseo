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
    "daemon-image",
  ]);
  assert.match(workflow.jobs.prepare.steps.at(-1).run, /--draft/);
  assert.match(workflow.jobs.publish.steps.at(-1).run, /--draft=false/);
  assert.equal(workflow.jobs.quality.needs, "prepare");
  assert.match(
    workflow.jobs.quality.steps.find((step) => step.name === "Run release quality gate").run,
    /npm run release:check/,
  );
});

test("the first release set is macOS, Android, and a multi-architecture daemon image", () => {
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

  const imageBuild = workflow.jobs["daemon-image"].steps.find(
    (step) => step.name === "Build and publish image",
  );
  assert.deepEqual(workflow.jobs["daemon-image"].needs, ["prepare", "quality", "macos", "android"]);
  assert.equal(imageBuild.with.platforms, "linux/amd64,linux/arm64");
  assert.equal(imageBuild.with.push, true);
  assert.match(workflowSource, /ghcr\.io\/\$\{owner\}\/hanabicode/);
});

test("the daemon image packs and installs the tagged fork source", () => {
  const dockerfile = readFileSync(new URL("docker/base/Dockerfile", repositoryRoot), "utf8");
  assert.match(dockerfile, /COPY \. \./);
  assert.match(dockerfile, /mkdir -p \/tmp\/hanabicode-packs/);
  assert.match(dockerfile, /--pack-destination \/tmp\/hanabicode-packs/);
  assert.match(dockerfile, /COPY --from=source-pack \/tmp\/hanabicode-packs/);
  assert.match(dockerfile, /npm install -g \/tmp\/hanabicode-packs\/\*\.tgz/);
  assert.doesNotMatch(dockerfile, /\/tmp\/paseo-packs/);
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
    ".github/workflows/nix-update-hash.yml",
    "packages/app/eas.json",
    "packages/app/.eas/workflows/release-ios-beta.yml",
    "packages/app/.eas/workflows/release-mobile.yml",
    "packages/app/.eas/workflows/resubmit-ios-review.yml",
  ]) {
    assert.equal(existsSync(new URL(path, repositoryRoot)), false, `${path} must remain retired`);
  }

  assert.doesNotMatch(workflowSource, /getpaseo\/paseo|ghcr\.io\/getpaseo/);
  const dockerWorkflow = readFileSync(
    new URL(".github/workflows/docker.yml", repositoryRoot),
    "utf8",
  );
  assert.match(dockerWorkflow, /push: false/);
  assert.doesNotMatch(dockerWorkflow, /packages: write|push: true/);

  const packageJson = JSON.parse(readFileSync(new URL("package.json", repositoryRoot), "utf8"));
  assert.equal(packageJson.scripts["release:publish"], undefined);
  assert.equal(packageJson.scripts["release:push"], undefined);
});
