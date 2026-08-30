/** Public HanabiCode identity and standalone runtime defaults.
 *
 * Internal package names and PASEO_* environment variables remain stable wire
 * and configuration APIs inherited from Paseo. Product-facing defaults live
 * here so the fork can coexist with an upstream installation.
 */
export const PRODUCT_NAME = "HanabiCode";
export const PRODUCT_REPOSITORY_URL = "https://github.com/Dey11/paseo";
export const DEFAULT_HANABICODE_HOME = "~/.hanabicode";
export const DEFAULT_HANABICODE_PORT = 6769;
export const DEFAULT_HANABICODE_LISTEN = `127.0.0.1:${DEFAULT_HANABICODE_PORT}`;
export const DEFAULT_HANABICODE_RELAY_ENDPOINT = "relay.paseo.sh:443";
export const DEFAULT_HANABICODE_RELAY_USE_TLS = true;
export const DEFAULT_HANABICODE_APP_BASE_URL = "hanabicode://pair";
