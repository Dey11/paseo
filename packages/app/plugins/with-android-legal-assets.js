const fs = require("node:fs");
const path = require("node:path");
const { withDangerousMod } = require("expo/config-plugins");

const LEGAL_ASSET_FILES = ["LICENSE", "NOTICE"];

function copyAndroidLegalAssets(projectRoot) {
  const repositoryRoot = path.resolve(projectRoot, "../..");
  const destination = path.join(projectRoot, "android", "app", "src", "main", "assets", "legal");
  fs.mkdirSync(destination, { recursive: true });

  for (const filename of LEGAL_ASSET_FILES) {
    const source = path.join(repositoryRoot, filename);
    if (!fs.existsSync(source)) {
      throw new Error(`Missing required HanabiCode legal asset: ${source}`);
    }
    fs.copyFileSync(source, path.join(destination, `${filename}.txt`));
  }
}

function withAndroidLegalAssets(config) {
  return withDangerousMod(config, [
    "android",
    (modConfig) => {
      copyAndroidLegalAssets(modConfig.modRequest.projectRoot);
      return modConfig;
    },
  ]);
}

module.exports = withAndroidLegalAssets;
module.exports.copyAndroidLegalAssets = copyAndroidLegalAssets;
module.exports.LEGAL_ASSET_FILES = LEGAL_ASSET_FILES;
