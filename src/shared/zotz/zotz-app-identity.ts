export const ZOTZ_PRODUCT_NAME = 'Zotz'
// Must match appId in config/electron-builder.config.cjs (Windows AppUserModelId, macOS bundle id).
export const ZOTZ_APP_ID = 'dev.hugorodriguez.zotz'
// Electron names the packaged userData folder after package.json `name`; keep them equal.
export const ZOTZ_USER_DATA_DIR_NAME = 'zotz'
export const ZOTZ_CLI_COMMAND = 'zotz'
// Must match `protocols` in config/electron-builder.config.cjs; orca:// stays Orca's so pairing links keep working.
export const ZOTZ_PROTOCOL_SCHEME = 'zotz'
// The in-app updater reads releases only from the fork (docs/zotz/UPDATES-SPEC.md).
export const ZOTZ_RELEASE_REPO = 'HugoRodriguezDEV/zotz'
export const ZOTZ_RELEASES_URL = `https://github.com/${ZOTZ_RELEASE_REPO}/releases`
export const ZOTZ_NEW_ISSUE_URL = `https://github.com/${ZOTZ_RELEASE_REPO}/issues/new`
