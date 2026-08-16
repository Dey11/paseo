import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const { copyAndroidLegalAssets } = require("../../plugins/with-android-legal-assets");

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createProjectRoot(): { repositoryRoot: string; projectRoot: string } {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hanabicode-legal-assets-"));
  temporaryRoots.push(repositoryRoot);
  const projectRoot = path.join(repositoryRoot, "packages", "app");
  fs.mkdirSync(projectRoot, { recursive: true });
  return { repositoryRoot, projectRoot };
}

describe("withAndroidLegalAssets", () => {
  it("copies the exact license and notice into Android application assets", () => {
    const { repositoryRoot, projectRoot } = createProjectRoot();
    fs.writeFileSync(path.join(repositoryRoot, "LICENSE"), "license text\n");
    fs.writeFileSync(path.join(repositoryRoot, "NOTICE"), "notice text\n");

    copyAndroidLegalAssets(projectRoot);

    const legalAssets = path.join(projectRoot, "android", "app", "src", "main", "assets", "legal");
    expect(fs.readFileSync(path.join(legalAssets, "LICENSE.txt"), "utf8")).toBe("license text\n");
    expect(fs.readFileSync(path.join(legalAssets, "NOTICE.txt"), "utf8")).toBe("notice text\n");
  });

  it("fails the build when a required legal file is missing", () => {
    const { repositoryRoot, projectRoot } = createProjectRoot();
    fs.writeFileSync(path.join(repositoryRoot, "LICENSE"), "license text\n");

    expect(() => copyAndroidLegalAssets(projectRoot)).toThrow(
      "Missing required HanabiCode legal asset",
    );
  });
});
