/**
 * The Electron switches an isolated (E2E / pairing) profile needs.
 *
 * The E2E boot guard hands the runtime a fresh `HOME` in a throwaway directory, so the macOS login
 * keychain the process would read its OSCrypt key from does not exist. Chromium then falls into its
 * "default keychain" authorization flow and waits on a reply that never arrives, which blocks
 * whichever thread made the call — for the foreground serve process that is the main thread, before
 * it advertises readiness (#25453).
 *
 * The sidecar has carried these since it was isolated; the foreground serve process is launched by
 * the CLI and needs the same, or the profile is only isolated for one of its two Electron processes.
 */
export function usesIsolatedProfile(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ORCA_E2E_USER_DATA_DIR || env.ORCA_E2E_HOME_DIR)
}

const ISOLATED_PROFILE_SWITCHES = ['--password-store=basic', '--use-mock-keychain']

export function electronIsolatedProfileSwitches(env: NodeJS.ProcessEnv = process.env): string[] {
  return usesIsolatedProfile(env) ? [...ISOLATED_PROFILE_SWITCHES] : []
}

/**
 * Why stricter than the sidecar: the sidecar always runs on a fresh profile, but the foreground
 * serve process opens the selected profile's sealed secrets, and only ORCA_E2E_USER_DATA_DIR moves
 * it off the user's real profile. A HOME override alone would leave those secrets unreadable.
 */
export function foregroundServeIsolatedProfileSwitches(
  env: NodeJS.ProcessEnv = process.env
): string[] {
  return env.ORCA_E2E_USER_DATA_DIR ? [...ISOLATED_PROFILE_SWITCHES] : []
}
