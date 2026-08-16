import { describe, expect, it } from "vitest";

const {
  configureAndroidReleaseSigning,
  SIGNING_PROPERTY_NAMES,
} = require("../../plugins/with-android-release-signing");

const generatedBuildGradle = `plugins {
    id "com.android.application"
}

android {
    namespace "com.example.app"

    signingConfigs {
        debug {
            storeFile file("debug.keystore")
        }
    }

    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            signingConfig signingConfigs.debug
            def enableProguardInReleaseBuilds = false
            minifyEnabled enableProguardInReleaseBuilds
        }
    }
}
`;

describe("withAndroidReleaseSigning", () => {
  it("wires release builds to Gradle properties without embedding credentials", () => {
    const configured = configureAndroidReleaseSigning(generatedBuildGradle);

    for (const propertyName of Object.values(SIGNING_PROPERTY_NAMES)) {
      expect(configured).toContain(`findProperty("${propertyName}")`);
    }
    expect(configured).toContain("storeFile file(hanabicodeReleaseStoreFile)");
    expect(configured).toContain("storePassword hanabicodeReleaseStorePassword");
    expect(configured).toContain("keyAlias hanabicodeReleaseKeyAlias");
    expect(configured).toContain("keyPassword hanabicodeReleaseKeyPassword");
    expect(configured).toContain("release {\n            signingConfig signingConfigs.release");
    expect(configured).toContain("debug {\n            signingConfig signingConfigs.debug");
    expect(configured).not.toContain("secret-password");
  });

  it("is idempotent", () => {
    const configured = configureAndroidReleaseSigning(generatedBuildGradle);
    expect(configureAndroidReleaseSigning(configured)).toBe(configured);
  });

  it("fails closed when the generated release build shape changes", () => {
    const unsignedRelease = generatedBuildGradle.replace(
      "signingConfig signingConfigs.debug\n            def enableProguardInReleaseBuilds",
      "def enableProguardInReleaseBuilds",
    );
    expect(() => configureAndroidReleaseSigning(unsignedRelease)).toThrow(
      "Could not replace the generated debug signing config",
    );
  });
});
