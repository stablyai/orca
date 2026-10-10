/**
 * Reverse-DNS identity of the packaged app: the macOS bundle id (and so its
 * preferences domain, TCC identity, and notification settings id) and the
 * Windows AppUserModelID. Runtime readers derive from this constant so a
 * rebranded build changes it in one place; electron-builder's `appId` and the
 * local-build compatibility contract JSON are pinned to it by tests.
 */
export const ORCA_APP_BUNDLE_ID = 'com.stablyai.orca'
/** Orca's own dev and local-build variants append these to the base id. */
export const DEV_APP_BUNDLE_ID_SUFFIX = '.dev'
export const LOCAL_APP_BUNDLE_ID_SUFFIX = '.local'
export const ORCA_DEV_APP_BUNDLE_ID = `${ORCA_APP_BUNDLE_ID}${DEV_APP_BUNDLE_ID_SUFFIX}`
export const ORCA_LOCAL_APP_BUNDLE_ID = `${ORCA_APP_BUNDLE_ID}${LOCAL_APP_BUNDLE_ID_SUFFIX}`
/** The detached terminal helper shares its app's id plus this suffix. */
export const ORCA_HELPER_BUNDLE_ID_SUFFIX = '.helper'
export const COMPUTER_USE_BUNDLE_ID_SUFFIX = '.computer-use'
export const ORCA_COMPUTER_USE_BUNDLE_ID = `${ORCA_APP_BUNDLE_ID}${COMPUTER_USE_BUNDLE_ID_SUFFIX}`

let appBundleIdOverride: string | null = null

/**
 * The running app's bundle id, which runtime readers (TCC, defaults domain, notification
 * settings) must use instead of ORCA_APP_BUNDLE_ID: a rebranded build sets its own at startup,
 * and a constant would point it at Orca's preferences and permissions.
 */
export function getAppBundleId(): string {
  return appBundleIdOverride ?? ORCA_APP_BUNDLE_ID
}

/** For a rebranded build, in the main process before anything reads the id; null restores Orca's. */
export function setAppBundleId(bundleId: string | null): void {
  appBundleIdOverride = bundleId
}

export function getComputerUseBundleId(): string {
  return `${getAppBundleId()}${COMPUTER_USE_BUNDLE_ID_SUFFIX}`
}

export type AppIdentity = {
  name: string
  isDev: boolean
  devLabel: string | null
  devBranch: string | null
  devWorktreeName: string | null
  devRepoRoot: string | null
  dockBadgeLabel: string | null
}
