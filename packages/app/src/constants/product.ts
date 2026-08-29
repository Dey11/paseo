export const PRODUCT_NAME = "HanabiCode";
export const DEFAULT_DAEMON_PORT = 6769;
export const DEFAULT_DAEMON_ENDPOINT = `localhost:${DEFAULT_DAEMON_PORT}`;
export const SOURCE_REPOSITORY_URL = "https://github.com/Dey11/paseo";
export const UPSTREAM_REPOSITORY_URL = "https://github.com/getpaseo/paseo";
export const LICENSE_URL = `${SOURCE_REPOSITORY_URL}/blob/hanabicode/LICENSE`;
export const RELEASES_URL = `${SOURCE_REPOSITORY_URL}/releases`;
export const ISSUES_URL = `${SOURCE_REPOSITORY_URL}/issues/new`;

const configuredCommit = process.env.EXPO_PUBLIC_HANABICODE_SOURCE_COMMIT?.trim();
export const SOURCE_COMMIT = configuredCommit || null;
export const EXACT_SOURCE_URL = SOURCE_COMMIT
  ? `${SOURCE_REPOSITORY_URL}/tree/${encodeURIComponent(SOURCE_COMMIT)}`
  : SOURCE_REPOSITORY_URL;
