import { ORCA_APP_BUNDLE_ID } from './app-identity'

// Why a JSON twin: packaging scripts are CommonJS and read the JSON; a test keeps both equal.
export const LOCAL_BUILD_COMPATIBILITY_CONTRACT = {
  formatVersion: 1,
  appId: ORCA_APP_BUNDLE_ID,
  stateSchemaVersion: 1,
  readableStateSchemaVersions: [1],
  daemonProtocolVersion: 44,
  attachableDaemonProtocolVersions: [
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26,
    27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44
  ]
} as const
